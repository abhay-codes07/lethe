/**
 * The transport boundary.
 *
 * Everything above this interface is decision logic — when to pause, what to
 * show a person, whether a run may continue. Everything below is HTTP. Keeping
 * them apart means the pause behaviour can be tested exhaustively against a
 * scripted transport, which matters because the failure modes worth testing
 * (a drop mid-approval, a turn that ends while a gate is open) are the ones
 * hardest to reproduce against a live server.
 */

import type { ReceivedEvent, TurnInput, TurnStatus } from './protocol.ts';

export interface TurnHandle {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface TurnState {
  readonly turnId: string;
  readonly status: TurnStatus;
}

export interface Transport {
  /**
   * Start a turn and stream its events.
   *
   * The same call resumes a paused turn: resumption is a new turn carrying
   * approval or answer inputs, not a distinct endpoint.
   */
  createTurn(sessionId: string, input: readonly TurnInput[]): AsyncIterable<ReceivedEvent>;

  /** Reattach to a turn already running, skipping what has been seen. */
  subscribeToTurn(
    sessionId: string,
    turnId: string,
    afterSequence?: number,
  ): AsyncIterable<ReceivedEvent>;

  /** Replay a turn's full history, pre-merged. The recovery path. */
  listTurnEvents(sessionId: string, turnId: string): AsyncIterable<ReceivedEvent>;

  getTurn(sessionId: string, turnId: string): Promise<TurnState>;
}
