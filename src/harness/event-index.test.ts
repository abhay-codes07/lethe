import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventIndex } from './event-index.ts';
import type { ModelMessageEvent, ReceivedEvent, TurnEvent } from './protocol.ts';

function received(event: TurnEvent, sequence?: number): ReceivedEvent {
  return sequence === undefined ? { event } : { event, sequence };
}

const emptyMessage: ModelMessageEvent = {
  type: 'model.message',
  id: 'msg-1',
  threadId: 'thread-1',
  content: '',
  toolCalls: [],
};

describe('EventIndex delta merging', () => {
  it('accumulates streamed content into the base message', () => {
    const index = new EventIndex();
    index.ingest(received(emptyMessage));
    index.ingest(received({ type: 'model.message.delta', id: 'msg-1', contentDelta: 'Found ' }));
    index.ingest(received({ type: 'model.message.delta', id: 'msg-1', contentDelta: '1,247 rows' }));

    assert.equal(index.messages()[0]?.content, 'Found 1,247 rows');
  });

  it('assembles tool call arguments across fragments', () => {
    const index = new EventIndex();
    index.ingest(received(emptyMessage));
    index.ingest(
      received({
        type: 'model.message.delta',
        id: 'msg-1',
        toolCallDeltas: [{ index: 0, id: 'call-1', name: 'delete_rows', argumentsDelta: '{"table"' }],
      }),
    );
    index.ingest(
      received({
        type: 'model.message.delta',
        id: 'msg-1',
        toolCallDeltas: [{ index: 0, argumentsDelta: ':"sessions"}' }],
      }),
    );

    const resolved = index.resolveToolCall({ id: 'call-1', sourceEventId: 'msg-1' });

    assert.equal(resolved.complete, true);
    assert.equal(resolved.complete && resolved.name, 'delete_rows');
    assert.deepEqual(resolved.complete && resolved.arguments, { table: 'sessions' });
  });

  // Calls stream interleaved and are addressed by position, so index 1 can
  // arrive before index 0 exists.
  it('handles tool call fragments arriving out of order', () => {
    const index = new EventIndex();
    index.ingest(received(emptyMessage));
    index.ingest(
      received({
        type: 'model.message.delta',
        id: 'msg-1',
        toolCallDeltas: [{ index: 1, id: 'call-b', name: 'delete_object', argumentsDelta: '{}' }],
      }),
    );
    index.ingest(
      received({
        type: 'model.message.delta',
        id: 'msg-1',
        toolCallDeltas: [{ index: 0, id: 'call-a', name: 'delete_rows', argumentsDelta: '{}' }],
      }),
    );

    assert.equal(index.resolveToolCall({ id: 'call-a', sourceEventId: 'msg-1' }).complete, true);
    assert.equal(index.resolveToolCall({ id: 'call-b', sourceEventId: 'msg-1' }).complete, true);
  });

  // Silently dropping it would produce a message missing whatever the base
  // carried, and nothing downstream would know.
  it('refuses a delta whose base it never saw', () => {
    const index = new EventIndex();
    assert.throws(
      () => index.ingest(received({ type: 'model.message.delta', id: 'ghost', contentDelta: 'x' })),
      /incomplete history/,
    );
  });

  it('refuses a delta addressed to an event that cannot take one', () => {
    const index = new EventIndex();
    index.ingest(received({ type: 'turn.created', id: 'turn-evt', turnId: 't1' }));
    assert.throws(
      () =>
        index.ingest({ event: { type: 'model.message.delta', id: 'turn-evt', contentDelta: 'x' } }),
      /cannot take deltas/,
    );
  });
});

describe('EventIndex.resolveToolCall', () => {
  function indexWithCall(args: string): EventIndex {
    const index = new EventIndex();
    index.ingest(
      received({
        ...emptyMessage,
        toolCalls: [{ id: 'call-1', toolInfo: { name: 'delete_rows', serverName: 'acme-postgres' }, arguments: args }],
      }),
    );
    return index;
  }

  it('carries the server name through, so the UI can say which system', () => {
    const resolved = indexWithCall('{}').resolveToolCall({ id: 'call-1', sourceEventId: 'msg-1' });
    assert.equal(resolved.complete && resolved.serverName, 'acme-postgres');
  });

  // Mid-stream JSON is invalid until the last fragment lands. Treating that as
  // an empty argument list would render "approve delete_rows()" — an approval
  // dialog showing no scope at all.
  it('reports incomplete arguments rather than pretending they are empty', () => {
    const resolved = indexWithCall('{"table":"sess').resolveToolCall({
      id: 'call-1',
      sourceEventId: 'msg-1',
    });

    assert.equal(resolved.complete, false);
    assert.equal(!resolved.complete && resolved.reason, 'incomplete_arguments');
    assert.equal(!resolved.complete && resolved.raw, '{"table":"sess');
  });

  it('treats genuinely empty arguments as an empty object', () => {
    const resolved = indexWithCall('').resolveToolCall({ id: 'call-1', sourceEventId: 'msg-1' });
    assert.deepEqual(resolved.complete && resolved.arguments, {});
  });

  it('rejects a non-object argument payload', () => {
    const resolved = indexWithCall('[1,2]').resolveToolCall({ id: 'call-1', sourceEventId: 'msg-1' });
    assert.equal(!resolved.complete && resolved.reason, 'incomplete_arguments');
  });

  it('distinguishes an unknown source event from an unknown call', () => {
    const index = indexWithCall('{}');

    assert.equal(
      (index.resolveToolCall({ id: 'call-1', sourceEventId: 'nope' }) as { reason: string }).reason,
      'unknown_event',
    );
    assert.equal(
      (index.resolveToolCall({ id: 'nope', sourceEventId: 'msg-1' }) as { reason: string }).reason,
      'unknown_call',
    );
  });
});

describe('EventIndex pauses', () => {
  const approval: TurnEvent = {
    type: 'tool.approval_required',
    id: 'pause-1',
    threadId: 'thread-1',
    toolCalls: [{ id: 'call-1', sourceEventId: 'msg-1' }],
  };
  const question: TurnEvent = {
    type: 'tool.response_required',
    id: 'pause-2',
    threadId: 'thread-1',
    toolCalls: [{ id: 'call-2', sourceEventId: 'msg-1' }],
  };

  it('separates approvals from questions', () => {
    const index = new EventIndex();
    index.ingest(received(approval));
    index.ingest(received(question));

    assert.equal(index.pauses().length, 2);
    assert.equal(index.approvalRequests().length, 1);
    assert.equal(index.questionRequests().length, 1);
  });

  it('forgets pauses once they have been answered', () => {
    const index = new EventIndex();
    index.ingest(received(approval));
    index.clearPauses();

    assert.deepEqual(index.pauses(), []);
    // Clearing pauses must not discard the events they refer to, or the next
    // resolution of the same tool call would fail.
    assert.ok(index.get('pause-1'));
  });
});

describe('EventIndex sequence tracking', () => {
  it('remembers the highest position seen, for resuming after a drop', () => {
    const index = new EventIndex();
    index.ingest(received({ type: 'turn.created', id: 'e1', turnId: 't1' }, 10));
    index.ingest(received(emptyMessage, 11));

    assert.equal(index.lastSequence, 11);
  });

  it('leaves the position unset when the transport supplies none', () => {
    const index = new EventIndex();
    index.ingest(received(emptyMessage));
    assert.equal(index.lastSequence, undefined);
  });

  it('does not let an unnumbered event erase a known position', () => {
    const index = new EventIndex();
    index.ingest(received(emptyMessage, 7));
    index.ingest(received({ type: 'model.message.delta', id: 'msg-1', contentDelta: 'x' }));

    assert.equal(index.lastSequence, 7);
  });
});
