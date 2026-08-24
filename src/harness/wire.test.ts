import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapWireStatus, WireTranslator } from './wire.ts';

describe('mapWireStatus', () => {
  it('maps the documented statuses', () => {
    assert.equal(mapWireStatus('done'), 'completed');
    assert.equal(mapWireStatus('cancelled'), 'cancelled');
    assert.equal(mapWireStatus('error'), 'failed');
    assert.equal(mapWireStatus('running'), 'running');
  });

  // Guessing whether an unknown status means finished or failed is guessing
  // whether an erasure ran.
  it('refuses a status it does not recognise', () => {
    assert.throws(() => mapWireStatus('almost_done'), /Refusing to guess/);
  });
});

describe('WireTranslator', () => {
  it('translates snake_case fields to the internal protocol', () => {
    const translator = new WireTranslator();
    const received = translator.translate(
      {
        type: 'tool.approval_required',
        id: 'p1',
        thread_id: 'thread-1',
        tool_calls: [{ id: 'call-1', source_event_id: 'msg-1' }],
      },
      3,
    );

    assert.deepEqual(received, {
      event: {
        type: 'tool.approval_required',
        id: 'p1',
        threadId: 'thread-1',
        toolCalls: [{ id: 'call-1', sourceEventId: 'msg-1' }],
      },
      sequence: 3,
    });
  });

  // Values must come through byte-for-byte: a predicate like `user_id = 4471`
  // inside tool arguments is data, not a key to rename.
  it('camelises keys but never values', () => {
    const translator = new WireTranslator();
    const received = translator.translate(
      {
        type: 'model.message',
        id: 'msg-1',
        thread_id: 'thread-1',
        content: 'checking analytics_events for actor_email',
        tool_calls: [
          {
            id: 'call-1',
            tool_info: { name: 'query', server_name: 'acme-postgres' },
            arguments: '{"predicate":"user_id = 4471"}',
          },
        ],
      },
      1,
    );

    const event = received?.event;
    assert.equal(event?.type, 'model.message');
    if (event?.type !== 'model.message') return;
    assert.equal(event.content, 'checking analytics_events for actor_email');
    assert.equal(event.toolCalls[0]?.toolInfo.serverName, 'acme-postgres');
    assert.equal(event.toolCalls[0]?.arguments, '{"predicate":"user_id = 4471"}');
  });

  // The OpenAI-style nesting. Arguments landing in the wrong place resolve as
  // incomplete and block an approval that should have rendered.
  it('lifts function.arguments onto the call', () => {
    const translator = new WireTranslator();
    const received = translator.translate(
      {
        type: 'model.message',
        id: 'msg-1',
        thread_id: 'thread-1',
        content: '',
        tool_calls: [
          { id: 'call-1', function: { name: 'delete_rows', arguments: '{"table":"sessions"}' } },
        ],
      },
      1,
    );

    const event = received?.event;
    if (event?.type !== 'model.message') return assert.fail('expected model.message');
    assert.equal(event.toolCalls[0]?.toolInfo.name, 'delete_rows');
    assert.equal(event.toolCalls[0]?.arguments, '{"table":"sessions"}');
  });

  it('unwraps the turn.done status from state', () => {
    const translator = new WireTranslator();
    translator.translate({ type: 'turn.created', id: 'c1', turn_id: 't-42' }, 1);

    const received = translator.translate(
      { type: 'turn.done', id: 'd1', state: { status: 'done', completed_at: 'x' } },
      2,
    );

    assert.deepEqual(received?.event, {
      type: 'turn.done',
      id: 'd1',
      turnId: 't-42',
      status: 'completed',
    });
  });

  // The wire's turn.done does not repeat the turn id; it arrived once, on
  // turn.created. Consumers should not need to have seen the beginning of the
  // stream, so the translator remembers it.
  it('remembers the turn id across the stream', () => {
    const translator = new WireTranslator();
    translator.translate({ type: 'turn.created', id: 'c1', turn_id: 't-9' }, 1);
    const done = translator.translate({ type: 'turn.done', id: 'd1', state: { status: 'error' } }, 2);

    assert.equal(done?.event.type === 'turn.done' && done.event.turnId, 't-9');
    assert.equal(done?.event.type === 'turn.done' && done.event.status, 'failed');
  });

  it('translates streaming deltas, including nested function arguments', () => {
    const translator = new WireTranslator();
    const received = translator.translate(
      {
        type: 'model.message.delta',
        id: 'msg-1',
        content_delta: 'more ',
        tool_call_deltas: [{ index: 0, id: 'call-1', function: { arguments: '{"a":' } }],
      },
      5,
    );

    const event = received?.event;
    if (event?.type !== 'model.message.delta') return assert.fail('expected delta');
    assert.equal(event.contentDelta, 'more ');
    assert.equal(event.toolCallDeltas?.[0]?.argumentsDelta, '{"a":');
  });

  // Wire-only lifecycle events are dropped at the boundary rather than taught
  // to every consumer.
  it('drops event types the internal protocol has no use for', () => {
    const translator = new WireTranslator();
    for (const type of ['thread.created', 'thread.done', 'sandbox.created', 'mcp.initialize']) {
      assert.equal(translator.translate({ type, id: 'x' }, 1), undefined, type);
    }
  });

  it('throws on an event with no type rather than guessing', () => {
    const translator = new WireTranslator();
    assert.throws(() => translator.translate({ id: 'x' }, 1), /no type/);
  });
});

describe('toWireInput', () => {
  it('serialises an approval with snake_case keys', async () => {
    const { toWireInput } = await import('./wire.ts');
    const wire = toWireInput([
      {
        type: 'user.tool_approval',
        threadId: 'thread-1',
        toolCallId: 'call-1',
        approval: { status: 'deny', reason: 'identity not verified' },
      },
    ]);

    // Sent with camelCase keys these fields are simply absent, the approval
    // matches nothing, and the gated call stays pending forever — a run that
    // hangs after the human said yes.
    assert.deepEqual(wire[0], {
      type: 'user.tool_approval',
      thread_id: 'thread-1',
      tool_call_id: 'call-1',
      approval: { status: 'deny', reason: 'identity not verified' },
    });
  });

  it('passes a user message through unchanged', async () => {
    const { toWireInput } = await import('./wire.ts');
    assert.deepEqual(toWireInput([{ type: 'user.message', content: 'go' }]), [
      { type: 'user.message', content: 'go' },
    ]);
  });

  it('serialises a tool response', async () => {
    const { toWireInput } = await import('./wire.ts');
    assert.deepEqual(
      toWireInput([
        { type: 'user.tool_response', threadId: 't', toolCallId: 'c', content: 'Yes' },
      ]),
      [{ type: 'user.tool_response', thread_id: 't', tool_call_id: 'c', content: 'Yes' }],
    );
  });
});
