/**
 * Translating the harness's wire format into the internal protocol.
 *
 * The two are deliberately different, and this file is the only place that
 * knows both. The published API streams snake_case events, nests a turn's
 * final status under `state`, and names its statuses `done`, `cancelled` and
 * `error`. The internal protocol is camelCase with a flat status, because
 * that is what every module above the transport was written against.
 *
 * An anti-corruption layer earns its keep here for one specific reason: the
 * exact wire shapes were an assumption for the first eleven PRs of this
 * project, and when the API reference was finally checked, four of those
 * assumptions were wrong. Concentrating the translation in one file means the
 * next discrepancy is a one-file fix instead of a hunt through everything
 * that touches an event.
 */

import type {
  ReceivedEvent,
  ToolCall,
  TurnEvent,
  TurnInput,
  TurnStatus,
} from './protocol.ts';

/** Wire statuses, per the API reference. */
const STATUS_MAP: Readonly<Record<string, TurnStatus>> = {
  done: 'completed',
  cancelled: 'cancelled',
  error: 'failed',
  running: 'running',
  // Accepted defensively: some surfaces describe a waiting turn this way even
  // though the streamed turn.done uses `done` plus required_actions.
  paused: 'paused',
};

export function mapWireStatus(wire: string): TurnStatus {
  const mapped = STATUS_MAP[wire];
  if (!mapped) {
    throw new Error(
      `harness reported turn status "${wire}", which this client does not ` +
        'recognise. Refusing to guess whether that means finished or failed.',
    );
  }
  return mapped;
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Recursively camelise object keys.
 *
 * Values are never touched — a predicate like `user_id = 4471` inside a tool
 * call's arguments must come through byte-for-byte.
 */
function deepCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCamel);
  if (typeof value !== 'object' || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[snakeToCamel(key)] = deepCamel(entry);
  }
  return out;
}

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalise one tool call.
 *
 * Two shapes exist in the wild: arguments directly on the call, and the
 * OpenAI-style `function: { arguments }` nesting. Both are accepted and
 * lifted to the internal flat shape, because a tool call whose arguments end
 * up in the wrong place resolves as `incomplete_arguments` and blocks an
 * approval that should have rendered.
 */
function normaliseToolCall(raw: Bag): ToolCall {
  const fn = isBag(raw['function']) ? raw['function'] : undefined;
  const toolInfo = isBag(raw['toolInfo']) ? raw['toolInfo'] : {};

  const name =
    typeof toolInfo['name'] === 'string'
      ? toolInfo['name']
      : typeof fn?.['name'] === 'string'
        ? (fn['name'] as string)
        : '';

  const serverName =
    typeof toolInfo['serverName'] === 'string' ? (toolInfo['serverName'] as string) : undefined;

  const args =
    typeof raw['arguments'] === 'string'
      ? raw['arguments']
      : typeof fn?.['arguments'] === 'string'
        ? (fn['arguments'] as string)
        : '';

  return {
    id: typeof raw['id'] === 'string' ? raw['id'] : '',
    toolInfo: { name, ...(serverName !== undefined ? { serverName } : {}) },
    arguments: args,
  };
}

/**
 * Stateful per-stream translator.
 *
 * Stateful because the wire's `turn.done` does not repeat the turn id — it
 * arrived once, on `turn.created` — while the internal event carries it so
 * that consumers never need to have seen the beginning of the stream.
 */
export class WireTranslator {
  #turnId = '';

  /**
   * Translate one parsed wire event.
   *
   * Returns undefined for event types the internal protocol has no use for —
   * `thread.created`, `sandbox.created`, `mcp.initialize` and the like. They
   * are dropped here, at the boundary, rather than taught to every consumer.
   */
  translate(wireEvent: unknown, sequence: number | undefined): ReceivedEvent | undefined {
    if (!isBag(wireEvent) || typeof wireEvent['type'] !== 'string') {
      throw new Error('harness sent an event with no type');
    }

    const event = deepCamel(wireEvent) as Bag;
    const type = event['type'] as string;
    const id = typeof event['id'] === 'string' ? event['id'] : '';

    const wrap = (translated: TurnEvent): ReceivedEvent =>
      sequence === undefined ? { event: translated } : { event: translated, sequence };

    switch (type) {
      case 'turn.created': {
        const turnId = typeof event['turnId'] === 'string' ? (event['turnId'] as string) : '';
        this.#turnId = turnId;
        return wrap({ type: 'turn.created', id, turnId });
      }

      case 'turn.done': {
        // Status lives under `state` on the wire; flat internally.
        const state = isBag(event['state']) ? event['state'] : {};
        const wireStatus = typeof state['status'] === 'string' ? (state['status'] as string) : '';
        const turnId =
          typeof event['turnId'] === 'string' && event['turnId'] !== ''
            ? (event['turnId'] as string)
            : this.#turnId;

        return wrap({ type: 'turn.done', id, turnId, status: mapWireStatus(wireStatus) });
      }

      case 'model.message': {
        const rawCalls = Array.isArray(event['toolCalls']) ? (event['toolCalls'] as unknown[]) : [];
        return wrap({
          type: 'model.message',
          id,
          threadId: str(event, 'threadId'),
          content: str(event, 'content'),
          toolCalls: rawCalls.filter(isBag).map(normaliseToolCall),
        });
      }

      case 'model.message.delta': {
        const rawDeltas = Array.isArray(event['toolCallDeltas'])
          ? (event['toolCallDeltas'] as unknown[])
          : undefined;

        return wrap({
          type: 'model.message.delta',
          id,
          ...(typeof event['contentDelta'] === 'string'
            ? { contentDelta: event['contentDelta'] as string }
            : {}),
          ...(rawDeltas
            ? {
                toolCallDeltas: rawDeltas.filter(isBag).map((delta) => ({
                  index: typeof delta['index'] === 'number' ? (delta['index'] as number) : 0,
                  ...(typeof delta['id'] === 'string' ? { id: delta['id'] as string } : {}),
                  ...(typeof delta['name'] === 'string' ? { name: delta['name'] as string } : {}),
                  ...(typeof delta['serverName'] === 'string'
                    ? { serverName: delta['serverName'] as string }
                    : {}),
                  ...(deltaArguments(delta) !== undefined
                    ? { argumentsDelta: deltaArguments(delta) as string }
                    : {}),
                })),
              }
            : {}),
        });
      }

      case 'tool.response':
        return wrap({
          type: 'tool.response',
          id,
          threadId: str(event, 'threadId'),
          toolCallId: str(event, 'toolCallId'),
          ok: event['ok'] !== false,
        });

      case 'tool.approval_required':
      case 'tool.response_required': {
        const refs = Array.isArray(event['toolCalls']) ? (event['toolCalls'] as unknown[]) : [];
        return wrap({
          type,
          id,
          threadId: str(event, 'threadId'),
          toolCalls: refs.filter(isBag).map((ref) => ({
            id: str(ref, 'id'),
            sourceEventId: str(ref, 'sourceEventId'),
          })),
        });
      }

      default:
        // Not part of the internal protocol. Dropped here so consumers never
        // learn about wire-only event types.
        return undefined;
    }
  }
}

function str(bag: Bag, key: string): string {
  const value = bag[key];
  return typeof value === 'string' ? value : '';
}

function deltaArguments(delta: Bag): string | undefined {
  if (typeof delta['argumentsDelta'] === 'string') return delta['argumentsDelta'] as string;
  const fn = delta['function'];
  if (isBag(fn) && typeof fn['arguments'] === 'string') return fn['arguments'] as string;
  return undefined;
}

// --- Outbound ----------------------------------------------------------------

/**
 * Serialise turn input for the wire.
 *
 * The reading direction gets an anti-corruption layer; the writing direction
 * needs one just as much. An approval sent with camelCase keys is not an
 * error the harness reports — the fields are simply absent, the approval
 * matches nothing, and the destructive call it was meant to gate stays
 * pending forever. A run that hangs after the human said yes.
 */
export function toWireInput(input: readonly TurnInput[]): readonly Record<string, unknown>[] {
  return input.map((item) => {
    switch (item.type) {
      case 'user.message':
        return { type: item.type, content: item.content };
      case 'user.tool_approval':
        return {
          type: item.type,
          thread_id: item.threadId,
          tool_call_id: item.toolCallId,
          approval:
            item.approval.status === 'allow'
              ? { status: 'allow' }
              : { status: 'deny', reason: item.approval.reason },
        };
      case 'user.tool_response':
        return {
          type: item.type,
          thread_id: item.threadId,
          tool_call_id: item.toolCallId,
          content: item.content,
        };
    }
  });
}
