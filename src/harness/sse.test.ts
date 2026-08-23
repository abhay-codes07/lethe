import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSse, SseParser } from './sse.ts';

describe('SseParser framing', () => {
  it('reads a single frame', () => {
    const frames = parseSse(['event: turn.done\ndata: {"status":"completed"}\n\n']);

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.event, 'turn.done');
    assert.equal(frames[0]?.data, '{"status":"completed"}');
  });

  it('defaults the event type when the stream does not name one', () => {
    assert.equal(parseSse(['data: hello\n\n'])[0]?.event, 'message');
  });

  it('joins multiple data lines with a newline', () => {
    assert.equal(parseSse(['data: one\ndata: two\n\n'])[0]?.data, 'one\ntwo');
  });

  it('strips exactly one leading space, preserving the rest', () => {
    assert.equal(parseSse(['data:  padded\n\n'])[0]?.data, ' padded');
  });

  it('treats a field with no colon as an empty value', () => {
    assert.deepEqual(parseSse(['data\n\n'])[0]?.data, '');
  });

  // Servers send these as keep-alives; treating one as a field invents a frame.
  it('ignores comment lines', () => {
    const frames = parseSse([': keep-alive\ndata: real\n\n']);

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, 'real');
  });

  it('emits nothing for a blank line with no data buffered', () => {
    assert.deepEqual(parseSse(['\n\n\n']), []);
  });

  // Otherwise a stray type attaches itself to whatever comes next.
  it('resets the event type on an empty dispatch', () => {
    const frames = parseSse(['event: ghost\n\ndata: later\n\n']);

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.event, 'message');
  });

  it('ignores unknown fields so the server can add some', () => {
    const frames = parseSse(['data: x\nunknown: y\n\n']);

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, 'x');
  });
});

describe('SseParser chunk boundaries', () => {
  // The failure that only appears under load: chunks arrive on network
  // boundaries, not line boundaries.
  it('reassembles a frame split mid-payload', () => {
    const frames = parseSse(['event: model.mess', 'age\ndata: {"id":', '"msg-1"}\n\n']);

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.event, 'model.message');
    assert.equal(frames[0]?.data, '{"id":"msg-1"}');
  });

  it('handles one byte at a time', () => {
    const stream = 'event: tool.approval_required\ndata: {"id":"p1"}\n\n';
    const frames = parseSse([...stream]);

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.event, 'tool.approval_required');
  });

  // A buffer ending in a lone \r must be held back: the next chunk may start
  // with \n, and splitting there would cut one line into two.
  it('does not split a CRLF that straddles two chunks', () => {
    const parser = new SseParser();

    assert.deepEqual(parser.push('data: value\r'), []);
    const frames = [...parser.push('\n\r\n')];

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, 'value');
  });

  it('accepts a bare CR as a line terminator', () => {
    const frames = parseSse(['data: value\r\r']);

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.data, 'value');
  });

  it('accepts CRLF throughout', () => {
    const frames = parseSse(['event: turn.done\r\ndata: {}\r\n\r\n']);

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.event, 'turn.done');
  });
});

describe('SseParser ids', () => {
  it('exposes the last id for reconnection', () => {
    const parser = new SseParser();
    parser.push('id: 41\ndata: a\n\n');
    parser.push('id: 42\ndata: b\n\n');

    assert.equal(parser.lastEventId, '42');
  });

  // Per spec the id persists until the stream changes it, so a frame that does
  // not restate it still belongs to that position.
  it('carries the last id onto frames that do not restate it', () => {
    const frames = parseSse(['id: 7\ndata: a\n\ndata: b\n\n']);

    assert.equal(frames[0]?.id, '7');
    assert.equal(frames[1]?.id, '7');
  });

  it('ignores an id containing NUL rather than truncating it', () => {
    const parser = new SseParser();
    parser.push('id: 12\ndata: a\n\n');
    parser.push('id: bad\0id\ndata: b\n\n');

    assert.equal(parser.lastEventId, '12');
  });

  it('reads a numeric retry hint and ignores a malformed one', () => {
    const parser = new SseParser();
    parser.push('retry: 3000\ndata: a\n\n');
    assert.equal(parser.retryMs, 3000);

    parser.push('retry: soon\ndata: b\n\n');
    assert.equal(parser.retryMs, 3000);
  });
});

describe('SseParser.flush', () => {
  // Disproportionately likely to be the frame that mattered — a turn.done, or
  // the approval request the run is now waiting on.
  it('emits a complete event left unterminated when the stream closed', () => {
    const parser = new SseParser();
    parser.push('event: turn.done\ndata: {"status":"completed"}');

    const frames = parser.flush();

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.event, 'turn.done');
  });

  it('emits nothing when the stream closed cleanly', () => {
    const parser = new SseParser();
    parser.push('data: a\n\n');

    assert.deepEqual(parser.flush(), []);
  });

  it('emits nothing for a trailing partial field with no data', () => {
    const parser = new SseParser();
    parser.push('event: turn.do');

    assert.deepEqual(parser.flush(), []);
  });
});
