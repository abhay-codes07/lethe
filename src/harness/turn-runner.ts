/**
 * Driving a turn, including the parts where it stops.
 *
 * A run does not proceed from prompt to answer. It proceeds until it needs a
 * person, hands control back, and continues when the person has decided. This
 * module owns that cycle.
 *
 * The rule it enforces throughout: **nothing is presented for approval that
 * could not be rendered.** If the tool call behind a gate cannot be resolved
 * into a name and arguments, the run stops as blocked rather than showing a
 * bare identifier. An approval a person cannot evaluate is worse than no
 * approval, because it produces a signature implying a review that did not
 * happen — and downstream that signature is what a certificate cites.
 */

import { EventIndex, type ToolCallResolution } from './event-index.ts';
import {
  type ApprovalDecision,
  type ReceivedEvent,
  type ThreadId,
  type TurnInput,
  type TurnStatus,
} from './protocol.ts';
import type { Transport } from './transport.ts';

/** One gated tool call, resolved as far as the stream allows. */
export interface ApprovalRequest {
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly call: ToolCallResolution;
}

export interface QuestionRequest {
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly question: string;
  readonly options: readonly string[];
}

export type RunOutcome =
  /** Ran to completion with no outstanding pause. */
  | { readonly kind: 'completed'; readonly turnId: string }
  /** Stopped before one or more destructive tools. */
  | { readonly kind: 'awaiting_approval'; readonly turnId: string; readonly requests: readonly ApprovalRequest[] }
  /** Stopped to ask something. */
  | { readonly kind: 'awaiting_answer'; readonly turnId: string; readonly questions: readonly QuestionRequest[] }
  /**
   * Stopped at a gate that cannot be shown to a person. Not an error to
   * retry — the run must not continue, because continuing means approving
   * blind.
   */
  | { readonly kind: 'blocked'; readonly turnId: string; readonly unresolved: readonly ApprovalRequest[] }
  | { readonly kind: 'failed'; readonly turnId: string; readonly status: TurnStatus };

export class TurnRunner {
  #index = new EventIndex();
  #turnId: string | undefined;

  readonly #transport: Transport;
  readonly #sessionId: string;

  constructor(transport: Transport, sessionId: string) {
    this.#transport = transport;
    this.#sessionId = sessionId;
  }

  /** Assembled state for the session so far. Survives pauses and reconnects. */
  get index(): EventIndex {
    return this.#index;
  }

  get turnId(): string | undefined {
    return this.#turnId;
  }

  async start(prompt: string): Promise<RunOutcome> {
    return this.#drive(this.#transport.createTurn(this.#sessionId, [{ type: 'user.message', content: prompt }]));
  }

  /**
   * Answer the outstanding approvals and continue.
   *
   * Every pending request must be decided. A partially answered gate would
   * resume the turn with some destructive calls still unaddressed, and the
   * harness would be within its rights to run them.
   */
  async respondToApprovals(decisions: ReadonlyMap<string, ApprovalDecision>): Promise<RunOutcome> {
    const pending = this.#approvalRequests();

    if (pending.length === 0) {
      throw new Error('no approval is outstanding; nothing to respond to');
    }

    const undecided = pending.filter((r) => !decisions.has(r.toolCallId));
    if (undecided.length > 0) {
      throw new Error(
        `${undecided.length} of ${pending.length} pending approval(s) were not ` +
          'decided. Resuming would leave destructive calls unaddressed, so every ' +
          'one must be allowed or denied explicitly.',
      );
    }

    const blind = pending.filter((r) => !r.call.complete && decisions.get(r.toolCallId)?.status === 'allow');
    if (blind.length > 0) {
      throw new Error(
        `cannot allow ${blind.length} tool call(s) whose arguments could not be ` +
          'resolved. Approving a call that could not be rendered is approving an ' +
          'unknown action; deny it or replay the turn to recover the stream.',
      );
    }

    const input: TurnInput[] = pending.map((request) => ({
      type: 'user.tool_approval',
      threadId: request.threadId,
      toolCallId: request.toolCallId,
      approval: decisions.get(request.toolCallId)!,
    }));

    this.#index.clearPauses();
    return this.#drive(this.#transport.createTurn(this.#sessionId, input));
  }

  async respondToQuestions(answers: ReadonlyMap<string, string>): Promise<RunOutcome> {
    const pending = this.#questionRequests();

    if (pending.length === 0) {
      throw new Error('no question is outstanding; nothing to respond to');
    }

    const unanswered = pending.filter((q) => !answers.has(q.toolCallId));
    if (unanswered.length > 0) {
      throw new Error(`${unanswered.length} pending question(s) were not answered`);
    }

    const input: TurnInput[] = pending.map((question) => ({
      type: 'user.tool_response',
      threadId: question.threadId,
      toolCallId: question.toolCallId,
      content: answers.get(question.toolCallId)!,
    }));

    this.#index.clearPauses();
    return this.#drive(this.#transport.createTurn(this.#sessionId, input));
  }

  /**
   * Recover after losing the connection.
   *
   * A running turn is reattached from the last position seen. A finished one
   * is replayed in full — replayed events are already merged, so they are read
   * into a fresh index rather than layered onto partial state whose fragments
   * may have arrived twice.
   *
   * This matters more here than in most systems: a request can pause for days
   * waiting for a person to sign, and the client will not survive that.
   */
  async reconnect(turnId: string): Promise<RunOutcome> {
    const state = await this.#transport.getTurn(this.#sessionId, turnId);

    if (state.status === 'running') {
      return this.#drive(
        this.#transport.subscribeToTurn(this.#sessionId, turnId, this.#index.lastSequence),
      );
    }

    this.#index = new EventIndex();
    return this.#drive(this.#transport.listTurnEvents(this.#sessionId, turnId), state.status);
  }

  async #drive(stream: AsyncIterable<ReceivedEvent>, fallbackStatus?: TurnStatus): Promise<RunOutcome> {
    let status: TurnStatus | undefined = fallbackStatus;

    for await (const received of stream) {
      this.#index.ingest(received);

      if (received.event.type === 'turn.created') {
        this.#turnId = received.event.turnId;
      }
      if (received.event.type === 'turn.done') {
        this.#turnId = received.event.turnId;
        status = received.event.status;
      }
    }

    const turnId = this.#turnId;
    if (turnId === undefined) {
      throw new Error('stream ended without identifying a turn');
    }
    if (status === undefined) {
      throw new Error(
        `turn ${turnId} ended without a terminal status. The stream was cut ` +
          'short; reconnect rather than treating the run as finished.',
      );
    }

    return this.#outcome(turnId, status);
  }

  #outcome(turnId: string, status: TurnStatus): RunOutcome {
    const approvals = this.#approvalRequests();
    const questions = this.#questionRequests();

    if (approvals.length > 0) {
      const unresolved = approvals.filter((r) => !r.call.complete);
      if (unresolved.length > 0) {
        return { kind: 'blocked', turnId, unresolved };
      }
      return { kind: 'awaiting_approval', turnId, requests: approvals };
    }

    if (questions.length > 0) {
      return { kind: 'awaiting_answer', turnId, questions };
    }

    if (status === 'completed') {
      return { kind: 'completed', turnId };
    }

    // A turn reported as paused with no pause event is a contradiction: the
    // run is waiting on something nobody can see or answer. Surfacing it as
    // completed would silently abandon whatever it was waiting for.
    if (status === 'paused') {
      throw new Error(
        `turn ${turnId} reports it is paused but carries no approval or question ` +
          'event. The stream is incomplete; replay the turn before continuing.',
      );
    }

    return { kind: 'failed', turnId, status };
  }

  #approvalRequests(): readonly ApprovalRequest[] {
    return this.#index.approvalRequests().flatMap((pause) =>
      pause.toolCalls.map((ref) => ({
        threadId: pause.threadId,
        toolCallId: ref.id,
        call: this.#index.resolveToolCall(ref),
      })),
    );
  }

  #questionRequests(): readonly QuestionRequest[] {
    return this.#index.questionRequests().flatMap((pause) =>
      pause.toolCalls.flatMap((ref): QuestionRequest[] => {
        const call = this.#index.resolveToolCall(ref);
        if (!call.complete) return [];

        const question = typeof call.arguments['question'] === 'string' ? call.arguments['question'] : '';
        const rawOptions = call.arguments['options'];
        const options = Array.isArray(rawOptions)
          ? rawOptions.filter((o): o is string => typeof o === 'string')
          : [];

        return [{ threadId: pause.threadId, toolCallId: ref.id, question, options }];
      }),
    );
  }
}
