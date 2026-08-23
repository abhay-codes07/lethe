import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ApprovalDecision, ReceivedEvent, TurnEvent, TurnInput, TurnStatus } from './protocol.ts';
import type { Transport, TurnState } from './transport.ts';
import { TurnRunner } from './turn-runner.ts';

/**
 * A transport that replays scripted event sequences. The failure modes worth
 * testing here — a drop mid-approval, a turn that ends while a gate is open —
 * are the ones hardest to provoke against a live server.
 */
class ScriptedTransport implements Transport {
  readonly inputs: TurnInput[][] = [];
  #scripts: TurnEvent[][];
  #state: TurnState;
  #replay: TurnEvent[] = [];

  constructor(scripts: TurnEvent[][], state: TurnState = { turnId: 'turn-1', status: 'completed' }) {
    this.#scripts = [...scripts];
    this.#state = state;
  }

  setReplay(events: TurnEvent[], state: TurnState): void {
    this.#replay = events;
    this.#state = state;
  }

  async *createTurn(_sessionId: string, input: readonly TurnInput[]): AsyncIterable<ReceivedEvent> {
    this.inputs.push([...input]);
    yield* emit(this.#scripts.shift() ?? []);
  }

  async *subscribeToTurn(
    _sessionId: string,
    _turnId: string,
    afterSequence?: number,
  ): AsyncIterable<ReceivedEvent> {
    const start = afterSequence ?? 0;
    yield* emit(this.#replay, start);
  }

  async *listTurnEvents(): AsyncIterable<ReceivedEvent> {
    yield* emit(this.#replay);
  }

  async getTurn(): Promise<TurnState> {
    return this.#state;
  }
}

async function* emit(events: readonly TurnEvent[], offset = 0): AsyncIterable<ReceivedEvent> {
  for (const [i, event] of events.entries()) {
    yield { event, sequence: offset + i + 1 };
  }
}

function created(turnId = 'turn-1'): TurnEvent {
  return { type: 'turn.created', id: `created-${turnId}`, turnId };
}

function done(status: TurnStatus, turnId = 'turn-1'): TurnEvent {
  return { type: 'turn.done', id: `done-${turnId}-${status}`, turnId, status };
}

function messageWithCall(
  callId: string,
  name: string,
  args: string,
  messageId = 'msg-1',
): TurnEvent {
  return {
    type: 'model.message',
    id: messageId,
    threadId: 'thread-1',
    content: '',
    toolCalls: [{ id: callId, toolInfo: { name, serverName: 'acme-postgres' }, arguments: args }],
  };
}

function approvalRequired(callId: string, messageId = 'msg-1'): TurnEvent {
  return {
    type: 'tool.approval_required',
    id: `pause-${callId}`,
    threadId: 'thread-1',
    toolCalls: [{ id: callId, sourceEventId: messageId }],
  };
}

const allow: ApprovalDecision = { status: 'allow' };
const deny: ApprovalDecision = { status: 'deny', reason: 'identity not verified' };

describe('TurnRunner', () => {
  it('reports completion when nothing needed a person', () => {
    return (async () => {
      const transport = new ScriptedTransport([[created(), done('completed')]]);
      const outcome = await new TurnRunner(transport, 'sess-1').start('find traces');

      assert.equal(outcome.kind, 'completed');
    })();
  });

  it('stops at a gate and resolves what is being asked', async () => {
    const transport = new ScriptedTransport([
      [
        created(),
        messageWithCall('call-1', 'delete_rows', '{"table":"sessions","rows":1247}'),
        approvalRequired('call-1'),
        done('paused'),
      ],
    ]);

    const outcome = await new TurnRunner(transport, 'sess-1').start('erase subject');

    assert.equal(outcome.kind, 'awaiting_approval');
    if (outcome.kind !== 'awaiting_approval') return;

    const call = outcome.requests[0]?.call;
    assert.equal(call?.complete, true);
    assert.equal(call?.complete && call.name, 'delete_rows');
    assert.deepEqual(call?.complete && call.arguments, { table: 'sessions', rows: 1247 });
  });

  // The central refusal. A gate whose arguments never finished streaming
  // cannot be rendered, so it must not become an approval prompt.
  it('blocks rather than presenting a gate it cannot render', async () => {
    const transport = new ScriptedTransport([
      [
        created(),
        messageWithCall('call-1', 'delete_rows', '{"table":"sess'),
        approvalRequired('call-1'),
        done('paused'),
      ],
    ]);

    const outcome = await new TurnRunner(transport, 'sess-1').start('erase subject');

    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.kind === 'blocked' && outcome.unresolved.length, 1);
  });

  it('resumes with the decisions, preserving the deny reason', async () => {
    const transport = new ScriptedTransport([
      [created(), messageWithCall('call-1', 'delete_rows', '{}'), approvalRequired('call-1'), done('paused')],
      [created(), done('completed')],
    ]);

    const runner = new TurnRunner(transport, 'sess-1');
    await runner.start('erase subject');
    const outcome = await runner.respondToApprovals(new Map([['call-1', deny]]));

    assert.equal(outcome.kind, 'completed');

    const resume = transport.inputs[1]?.[0];
    assert.equal(resume?.type, 'user.tool_approval');
    assert.deepEqual(resume?.type === 'user.tool_approval' && resume.approval, deny);
  });

  // Resuming with some gates unanswered leaves destructive calls outstanding
  // and the harness free to run them.
  it('refuses to resume while any gate is undecided', async () => {
    const transport = new ScriptedTransport([
      [
        created(),
        messageWithCall('call-1', 'delete_rows', '{}'),
        messageWithCall('call-2', 'delete_object', '{}', 'msg-2'),
        approvalRequired('call-1'),
        approvalRequired('call-2', 'msg-2'),
        done('paused'),
      ],
    ]);

    const runner = new TurnRunner(transport, 'sess-1');
    await runner.start('erase subject');

    await assert.rejects(
      runner.respondToApprovals(new Map([['call-1', allow]])),
      /were not\s+decided/,
    );
  });

  it('refuses to allow a call whose arguments could not be resolved', async () => {
    const transport = new ScriptedTransport([
      [
        created(),
        messageWithCall('call-1', 'delete_rows', '{"table":'),
        approvalRequired('call-1'),
        done('paused'),
      ],
    ]);

    const runner = new TurnRunner(transport, 'sess-1');
    await runner.start('erase subject');

    await assert.rejects(
      runner.respondToApprovals(new Map([['call-1', allow]])),
      /approving an unknown action/,
    );
  });

  it('permits denying a call that could not be resolved', async () => {
    const transport = new ScriptedTransport([
      [created(), messageWithCall('call-1', 'delete_rows', '{"table":'), approvalRequired('call-1'), done('paused')],
      [created(), done('completed')],
    ]);

    const runner = new TurnRunner(transport, 'sess-1');
    await runner.start('erase subject');

    const outcome = await runner.respondToApprovals(new Map([['call-1', deny]]));
    assert.equal(outcome.kind, 'completed');
  });

  it('rejects a response when nothing is outstanding', async () => {
    const transport = new ScriptedTransport([[created(), done('completed')]]);
    const runner = new TurnRunner(transport, 'sess-1');
    await runner.start('find traces');

    await assert.rejects(runner.respondToApprovals(new Map()), /no approval is outstanding/);
  });

  it('surfaces a question with its options', async () => {
    const transport = new ScriptedTransport([
      [
        created(),
        messageWithCall(
          'call-q',
          'ask_user_question',
          '{"question":"Two accounts share this email. Same person?","options":["Yes","No"]}',
        ),
        {
          type: 'tool.response_required',
          id: 'pause-q',
          threadId: 'thread-1',
          toolCalls: [{ id: 'call-q', sourceEventId: 'msg-1' }],
        },
        done('paused'),
      ],
    ]);

    const outcome = await new TurnRunner(transport, 'sess-1').start('erase subject');

    assert.equal(outcome.kind, 'awaiting_answer');
    if (outcome.kind !== 'awaiting_answer') return;
    assert.match(outcome.questions[0]?.question ?? '', /Same person/);
    assert.deepEqual(outcome.questions[0]?.options, ['Yes', 'No']);
  });

  it('reports a failed turn rather than treating it as finished', async () => {
    const transport = new ScriptedTransport([[created(), done('failed')]]);
    const outcome = await new TurnRunner(transport, 'sess-1').start('erase subject');

    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.kind === 'failed' && outcome.status, 'failed');
  });

  // A cut stream looks exactly like a finished one if you only check for the
  // absence of events, so the terminal status is required explicitly.
  it('refuses to call a truncated stream complete', async () => {
    const transport = new ScriptedTransport([[created(), messageWithCall('call-1', 'query', '{}')]]);

    await assert.rejects(
      new TurnRunner(transport, 'sess-1').start('find traces'),
      /without a terminal status/,
    );
  });

  it('refuses a paused turn that carries no gate to answer', async () => {
    const transport = new ScriptedTransport([[created(), done('paused')]]);

    await assert.rejects(
      new TurnRunner(transport, 'sess-1').start('erase subject'),
      /carries no approval or question event/,
    );
  });
});

describe('TurnRunner reconnection', () => {
  // A request can wait days for a signature; no client survives that.
  it('replays a finished turn into fresh state', async () => {
    const transport = new ScriptedTransport([]);
    transport.setReplay(
      [created(), messageWithCall('call-1', 'delete_rows', '{"rows":1247}'), approvalRequired('call-1'), done('paused')],
      { turnId: 'turn-1', status: 'paused' },
    );

    const outcome = await new TurnRunner(transport, 'sess-1').reconnect('turn-1');

    assert.equal(outcome.kind, 'awaiting_approval');
    if (outcome.kind !== 'awaiting_approval') return;
    assert.deepEqual(outcome.requests[0]?.call.complete && outcome.requests[0].call.arguments, {
      rows: 1247,
    });
  });

  it('reattaches to a still-running turn from the last position seen', async () => {
    const transport = new ScriptedTransport([], { turnId: 'turn-1', status: 'running' });
    transport.setReplay([created(), done('completed')], { turnId: 'turn-1', status: 'running' });

    const outcome = await new TurnRunner(transport, 'sess-1').reconnect('turn-1');

    assert.equal(outcome.kind, 'completed');
  });

  // Replayed events are already merged; layering them onto partial state would
  // double-apply fragments that arrived before the drop.
  it('discards partial state so a replay cannot double-apply fragments', async () => {
    const transport = new ScriptedTransport([
      [created(), { type: 'model.message', id: 'msg-1', threadId: 'thread-1', content: 'partial', toolCalls: [] }, done('completed')],
    ]);

    const runner = new TurnRunner(transport, 'sess-1');
    await runner.start('find traces');

    transport.setReplay(
      [created(), { type: 'model.message', id: 'msg-1', threadId: 'thread-1', content: 'partial and complete', toolCalls: [] }, done('completed')],
      { turnId: 'turn-1', status: 'completed' },
    );
    await runner.reconnect('turn-1');

    assert.equal(runner.index.messages()[0]?.content, 'partial and complete');
  });
});
