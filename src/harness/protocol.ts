/**
 * The wire protocol Lethe speaks to the agent harness.
 *
 * A turn is streamed as a sequence of events. Assistant output arrives as a
 * base `model.message` followed by `model.message.delta` fragments that must
 * be merged into it — the base is a skeleton, and reading it before the
 * deltas land gives you an empty message rather than an error.
 *
 * A turn does not always run to completion. It can stop and wait for a person
 * — for approval before a destructive tool, or for an answer to a question —
 * and is resumed by starting a new turn carrying the response. Those pauses
 * are the mechanism the entire product is built on, so they are modelled
 * explicitly rather than treated as an interruption.
 */

export type ThreadId = string;

/** A tool the model wants to run. Arguments stream in fragments. */
export interface ToolCall {
  readonly id: string;
  readonly toolInfo: { readonly name: string; readonly serverName?: string };
  /** Raw JSON, assembled across deltas. Not parseable until the stream settles. */
  readonly arguments: string;
}

export interface TurnCreatedEvent {
  readonly type: 'turn.created';
  readonly id: string;
  readonly turnId: string;
}

export interface ModelMessageEvent {
  readonly type: 'model.message';
  readonly id: string;
  readonly threadId: ThreadId;
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

/** An increment to a `model.message`, keyed by the same id. */
export interface ModelMessageDeltaEvent {
  readonly type: 'model.message.delta';
  readonly id: string;
  readonly contentDelta?: string;
  readonly toolCallDeltas?: readonly ToolCallDelta[];
}

export interface ToolCallDelta {
  /** Position in the message's tool call list. Calls stream interleaved. */
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly serverName?: string;
  readonly argumentsDelta?: string;
}

export interface ToolResponseEvent {
  readonly type: 'tool.response';
  readonly id: string;
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly ok: boolean;
}

/** Points at a tool call in an earlier event, rather than repeating it. */
export interface ToolCallRef {
  readonly id: string;
  readonly sourceEventId: string;
}

/** The turn has stopped before a gated tool and is waiting for a decision. */
export interface ToolApprovalRequiredEvent {
  readonly type: 'tool.approval_required';
  readonly id: string;
  readonly threadId: ThreadId;
  readonly toolCalls: readonly ToolCallRef[];
}

/** The turn has stopped to ask the user something. */
export interface ToolResponseRequiredEvent {
  readonly type: 'tool.response_required';
  readonly id: string;
  readonly threadId: ThreadId;
  readonly toolCalls: readonly ToolCallRef[];
}

export type TurnStatus = 'running' | 'completed' | 'paused' | 'failed' | 'cancelled';

export interface TurnDoneEvent {
  readonly type: 'turn.done';
  readonly id: string;
  readonly turnId: string;
  readonly status: TurnStatus;
}

export type TurnEvent =
  | TurnCreatedEvent
  | ModelMessageEvent
  | ModelMessageDeltaEvent
  | ToolResponseEvent
  | ToolApprovalRequiredEvent
  | ToolResponseRequiredEvent
  | TurnDoneEvent;

/**
 * An event as received, with its position in the session.
 *
 * The sequence number is transport metadata rather than part of the event, and
 * it is what makes resumption possible: reconnecting asks for everything after
 * the last number seen.
 */
export interface ReceivedEvent {
  readonly event: TurnEvent;
  readonly sequence?: number;
}

// --- Input ------------------------------------------------------------------

export interface UserMessageInput {
  readonly type: 'user.message';
  readonly content: string;
}

export interface UserToolApprovalInput {
  readonly type: 'user.tool_approval';
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly approval: ApprovalDecision;
}

/**
 * A denial carries a reason.
 *
 * Not politeness: a refused erasure is itself a compliance event, and "denied
 * because identity was not verified" is what the audit trail needs to record.
 * A bare rejection tells a later reader nothing.
 */
export type ApprovalDecision =
  | { readonly status: 'allow' }
  | { readonly status: 'deny'; readonly reason: string };

export interface UserToolResponseInput {
  readonly type: 'user.tool_response';
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly content: string;
}

export type TurnInput = UserMessageInput | UserToolApprovalInput | UserToolResponseInput;

export function isDelta(event: TurnEvent): event is ModelMessageDeltaEvent {
  return event.type === 'model.message.delta';
}

export function isPause(
  event: TurnEvent,
): event is ToolApprovalRequiredEvent | ToolResponseRequiredEvent {
  return event.type === 'tool.approval_required' || event.type === 'tool.response_required';
}
