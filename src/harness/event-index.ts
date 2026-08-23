/**
 * Assembling a turn from its stream.
 *
 * Events arrive as skeletons plus increments, so nothing can be read until the
 * fragments belonging to it have been merged. The index does that merging and
 * holds the assembled state.
 *
 * It exists because the pause events do not repeat the tool call they are
 * asking about — they point at it by id, in an earlier event. Showing a person
 * what they are approving therefore requires having kept the whole stream, and
 * having assembled it correctly. Get this wrong and the approval dialog says
 * "allow this tool call?" with nothing in it, which is precisely the
 * rubber-stamp the product exists to prevent.
 */

import {
  isDelta,
  isPause,
  type ModelMessageDeltaEvent,
  type ModelMessageEvent,
  type ReceivedEvent,
  type ToolApprovalRequiredEvent,
  type ToolCall,
  type ToolCallRef,
  type ToolResponseRequiredEvent,
  type TurnEvent,
} from './protocol.ts';

/** A tool call whose arguments have finished streaming and parsed cleanly. */
export interface ResolvedToolCall {
  readonly complete: true;
  readonly id: string;
  readonly name: string;
  readonly serverName?: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * A tool call that cannot be read yet or at all.
 *
 * Distinguished from a resolved one by type rather than by returning
 * `undefined`, because "the arguments have not finished streaming" and "the
 * arguments are malformed" call for different handling, and neither may be
 * quietly treated as an empty argument list.
 */
export interface UnresolvedToolCall {
  readonly complete: false;
  readonly id: string;
  readonly name?: string;
  readonly reason: 'unknown_event' | 'unknown_call' | 'incomplete_arguments';
  readonly raw?: string;
}

export type ToolCallResolution = ResolvedToolCall | UnresolvedToolCall;

interface MutableToolCall {
  id: string;
  name: string;
  serverName?: string;
  arguments: string;
}

export class EventIndex {
  readonly #events = new Map<string, TurnEvent>();
  readonly #toolCalls = new Map<string, MutableToolCall[]>();
  readonly #pauses: (ToolApprovalRequiredEvent | ToolResponseRequiredEvent)[] = [];
  #lastSequence: number | undefined;

  /**
   * Take one event from the stream.
   *
   * Deltas are merged into their base. A delta whose base is missing is not
   * dropped — it means the index is working from an incomplete history, and
   * carrying on would produce a message that silently omits whatever the
   * missing fragment carried. On resume, replay the turn's full event list
   * instead of subscribing mid-stream.
   */
  ingest(received: ReceivedEvent): void {
    if (received.sequence !== undefined) {
      this.#lastSequence = received.sequence;
    }

    const event = received.event;

    if (isDelta(event)) {
      this.#applyDelta(event);
      return;
    }

    this.#events.set(event.id, event);

    if (event.type === 'model.message') {
      this.#toolCalls.set(
        event.id,
        event.toolCalls.map((call) => ({
          id: call.id,
          name: call.toolInfo.name,
          ...(call.toolInfo.serverName !== undefined ? { serverName: call.toolInfo.serverName } : {}),
          arguments: call.arguments,
        })),
      );
    }

    if (isPause(event)) {
      this.#pauses.push(event);
    }
  }

  #applyDelta(delta: ModelMessageDeltaEvent): void {
    const base = this.#events.get(delta.id);

    if (!base) {
      throw new Error(
        `received a delta for unknown event ${delta.id}. The index is working ` +
          'from an incomplete history; replay the turn\'s events rather than ' +
          'subscribing mid-stream.',
      );
    }

    if (base.type !== 'model.message') {
      throw new Error(`event ${delta.id} is a ${base.type}, which cannot take deltas`);
    }

    if (delta.contentDelta !== undefined) {
      this.#events.set(delta.id, { ...base, content: base.content + delta.contentDelta });
    }

    if (delta.toolCallDeltas) {
      const calls = this.#toolCalls.get(delta.id) ?? [];
      for (const fragment of delta.toolCallDeltas) {
        // Tool calls stream interleaved and out of order, addressed by index,
        // so a later index can arrive before an earlier one exists.
        const existing = calls[fragment.index] ?? { id: '', name: '', arguments: '' };
        const serverName = fragment.serverName ?? existing.serverName;

        calls[fragment.index] = {
          id: fragment.id ?? existing.id,
          name: fragment.name ?? existing.name,
          ...(serverName !== undefined ? { serverName } : {}),
          arguments: existing.arguments + (fragment.argumentsDelta ?? ''),
        };
      }
      this.#toolCalls.set(delta.id, calls);
    }
  }

  get(id: string): TurnEvent | undefined {
    return this.#events.get(id);
  }

  get lastSequence(): number | undefined {
    return this.#lastSequence;
  }

  get size(): number {
    return this.#events.size;
  }

  /** Assembled assistant messages, in the order their bases arrived. */
  messages(): readonly ModelMessageEvent[] {
    const assembled: ModelMessageEvent[] = [];

    for (const event of this.#events.values()) {
      if (event.type !== 'model.message') continue;
      const calls = this.#toolCalls.get(event.id) ?? [];
      assembled.push({
        ...event,
        toolCalls: calls.map(
          (call): ToolCall => ({
            id: call.id,
            toolInfo: {
              name: call.name,
              ...(call.serverName !== undefined ? { serverName: call.serverName } : {}),
            },
            arguments: call.arguments,
          }),
        ),
      });
    }

    return assembled;
  }

  /**
   * Look up what a pause is actually asking about.
   *
   * This is the function that turns "approve tool call `abc`?" into "approve
   * deleting 1,247 rows from `public.sessions`?". If it cannot resolve, the
   * caller must refuse to render an approval rather than showing a bare id —
   * an approval nobody can evaluate is worse than no approval, because it
   * produces a signature implying review that did not happen.
   */
  resolveToolCall(ref: ToolCallRef): ToolCallResolution {
    const source = this.#events.get(ref.sourceEventId);
    if (!source) {
      return { complete: false, id: ref.id, reason: 'unknown_event' };
    }

    const call = this.#toolCalls.get(ref.sourceEventId)?.find((c) => c.id === ref.id);
    if (!call) {
      return { complete: false, id: ref.id, reason: 'unknown_call' };
    }

    const parsed = parseArguments(call.arguments);
    if (!parsed.ok) {
      return {
        complete: false,
        id: ref.id,
        name: call.name,
        reason: 'incomplete_arguments',
        raw: call.arguments,
      };
    }

    return {
      complete: true,
      id: ref.id,
      name: call.name,
      ...(call.serverName !== undefined ? { serverName: call.serverName } : {}),
      arguments: parsed.value,
    };
  }

  /** Pauses seen so far, oldest first. */
  pauses(): readonly (ToolApprovalRequiredEvent | ToolResponseRequiredEvent)[] {
    return [...this.#pauses];
  }

  approvalRequests(): readonly ToolApprovalRequiredEvent[] {
    return this.#pauses.filter(
      (p): p is ToolApprovalRequiredEvent => p.type === 'tool.approval_required',
    );
  }

  questionRequests(): readonly ToolResponseRequiredEvent[] {
    return this.#pauses.filter(
      (p): p is ToolResponseRequiredEvent => p.type === 'tool.response_required',
    );
  }

  /** Discard recorded pauses once they have been answered. */
  clearPauses(): void {
    this.#pauses.length = 0;
  }
}

type ParseResult =
  | { ok: true; value: Readonly<Record<string, unknown>> }
  | { ok: false };

/**
 * Arguments arrive as a JSON fragment that is invalid until the last piece
 * lands, so a parse failure is expected mid-stream rather than exceptional.
 */
function parseArguments(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: {} };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}
