import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpTransport } from './http-transport.ts';
import type { ReceivedEvent } from './protocol.ts';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that replays a scripted SSE body and records what was sent. */
function fakeFetch(
  chunks: readonly string[],
  captured: Captured[],
  init: { status?: number; statusText?: string; text?: string; json?: unknown } = {},
): typeof globalThis.fetch {
  return (async (url: string | URL, options: RequestInit = {}) => {
    captured.push({
      url: String(url),
      method: options.method ?? 'GET',
      headers: { ...(options.headers as Record<string, string>) },
      ...(typeof options.body === 'string' ? { body: options.body } : {}),
    });

    const status = init.status ?? 200;

    if (status >= 400) {
      return {
        ok: false,
        status,
        statusText: init.statusText ?? 'Error',
        text: async () => init.text ?? '',
      } as unknown as Response;
    }

    if (init.json !== undefined) {
      return { ok: true, status, json: async () => init.json } as unknown as Response;
    }

    const encoder = new TextEncoder();
    const body = (async function* () {
      for (const chunk of chunks) yield encoder.encode(chunk);
    })();

    return { ok: true, status, body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

async function collect(stream: AsyncIterable<ReceivedEvent>): Promise<ReceivedEvent[]> {
  const events: ReceivedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// Documented wire format: snake_case fields, status nested under state.
const TURN_STREAM = [
  'id: 1\nevent: turn.created\ndata: {"type":"turn.created","id":"e1","turn_id":"t1"}\n\n',
  'id: 2\nevent: turn.done\ndata: {"type":"turn.done","id":"e2","state":{"status":"done"}}\n\n',
];

describe('HttpTransport streaming', () => {
  it('yields parsed events with their sequence numbers', async () => {
    const captured: Captured[] = [];
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(TURN_STREAM, captured),
    });

    const events = await collect(transport.createTurn('sess-1', [{ type: 'user.message', content: 'go' }]));

    assert.equal(events.length, 2);
    assert.equal(events[0]?.event.type, 'turn.created');
    assert.equal(events[0]?.sequence, 1);
    assert.equal(events[1]?.sequence, 2);
    // Translated into the internal protocol: flat status, turn id remembered.
    const done = events[1]?.event;
    assert.equal(done?.type === 'turn.done' && done.status, 'completed');
    assert.equal(done?.type === 'turn.done' && done.turnId, 't1');
  });

  it('survives a payload split across network chunks', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(
        ['id: 1\nevent: turn.cre', 'ated\ndata: {"type":"turn.crea', 'ted","id":"e1","turn_id":"t1"}\n\n'],
        [],
      ),
    });

    const events = await collect(transport.listTurnEvents('sess-1', 't1'));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.event.type, 'turn.created');
  });

  it('emits a final event the server never terminated', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(
        ['data: {"type":"turn.done","id":"e2","state":{"status":"done"}}'],
        [],
      ),
    });

    assert.equal((await collect(transport.listTurnEvents('sess-1', 't1'))).length, 1);
  });

  it('ignores keep-alives and the done sentinel', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(
        [': keep-alive\n\n', 'data: {"type":"turn.done","id":"e","state":{"status":"done"}}\n\n', 'data: [DONE]\n\n'],
        [],
      ),
    });

    assert.equal((await collect(transport.listTurnEvents('sess-1', 't1'))).length, 1);
  });

  // Skipping it would drop an approval request and leave the run looking
  // stalled rather than broken.
  it('throws on a malformed frame instead of skipping it', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(['data: {not json\n\n'], []),
    });

    await assert.rejects(collect(transport.listTurnEvents('sess-1', 't1')), /not JSON/);
  });

  it('throws on a frame carrying no event type', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(['data: {"id":"e1"}\n\n'], []),
    });

    await assert.rejects(collect(transport.listTurnEvents('sess-1', 't1')), /no type/);
  });

  // Lifecycle events the internal protocol has no use for are dropped at the
  // boundary, not surfaced to consumers.
  it('drops wire-only lifecycle events', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(
        [
          'data: {"type":"thread.created","id":"th1","thread_id":"t"}\n\n',
          'data: {"type":"sandbox.created","id":"sb1"}\n\n',
          'data: {"type":"turn.done","id":"e","state":{"status":"done"}}\n\n',
        ],
        [],
      ),
    });

    const events = await collect(transport.listTurnEvents('sess-1', 't1'));
    assert.deepEqual(events.map((e) => e.event.type), ['turn.done']);
  });
});

describe('HttpTransport requests', () => {
  it('sends the input as the request body', async () => {
    const captured: Captured[] = [];
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(TURN_STREAM, captured),
    });

    await collect(transport.createTurn('sess-1', [{ type: 'user.message', content: 'go' }]));

    assert.equal(captured[0]?.method, 'POST');
    assert.match(captured[0]?.body ?? '', /"user.message"/);
  });

  it('carries the key as a bearer header, never in the URL', async () => {
    const captured: Captured[] = [];
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      apiKey: 'secret-key',
      fetch: fakeFetch(TURN_STREAM, captured),
    });

    await collect(transport.listTurnEvents('sess-1', 't1'));

    assert.equal(captured[0]?.headers['authorization'], 'Bearer secret-key');
    assert.ok(!captured[0]?.url.includes('secret-key'), 'key must not reach the URL');
  });

  // The documented resume cursor. The first version sent Last-Event-ID, which
  // the endpoint ignores — every reconnect would have replayed the whole turn.
  it('resumes with the after_sequence_number query parameter', async () => {
    const captured: Captured[] = [];
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(TURN_STREAM, captured),
    });

    await collect(transport.subscribeToTurn('sess-1', 't1', 42));

    assert.match(captured[0]?.url ?? '', /\/subscribe\?after_sequence_number=42$/);
  });

  it('omits the cursor when starting fresh', async () => {
    const captured: Captured[] = [];
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(TURN_STREAM, captured),
    });

    await collect(transport.subscribeToTurn('sess-1', 't1'));

    assert.ok(!captured[0]?.url.includes('after_sequence_number'), captured[0]?.url);
  });

  it('trims a trailing slash so paths do not double up', async () => {
    const captured: Captured[] = [];
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test/',
      fetch: fakeFetch(TURN_STREAM, captured),
    });

    await collect(transport.listTurnEvents('sess-1', 't1'));

    assert.ok(!captured[0]?.url.includes('//api'), captured[0]?.url);
  });

  it('escapes identifiers into the path', async () => {
    const captured: Captured[] = [];
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch(TURN_STREAM, captured),
    });

    await collect(transport.listTurnEvents('sess/../admin', 't1'));

    assert.ok(!captured[0]?.url.includes('/../'), captured[0]?.url);
  });
});

describe('HttpTransport errors', () => {
  it('reports the status and the server explanation', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([], [], { status: 503, statusText: 'Service Unavailable', text: 'sandbox unavailable' }),
    });

    await assert.rejects(
      collect(transport.listTurnEvents('sess-1', 't1')),
      /503 Service Unavailable — sandbox unavailable/,
    );
  });

  it('reads a turn state and maps the wire status', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([], [], { json: { turn_id: 't1', state: { status: 'done' } } }),
    });

    assert.deepEqual(await transport.getTurn('sess-1', 't1'), { turnId: 't1', status: 'completed' });
  });

  it('rejects a turn state with no status rather than guessing', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([], [], { json: { turnId: 't1' } }),
    });

    await assert.rejects(transport.getTurn('sess-1', 't1'), /no status/);
  });
});

describe('HttpTransport.fromEnv', () => {
  // A silent localhost fallback in a deployed environment points an erasure
  // run at nothing, and surfaces much later as an empty discovery.
  it('refuses to guess where the harness is', () => {
    assert.throws(() => HttpTransport.fromEnv({}), /refusing to guess/);
  });

  it('builds when the base URL is present', () => {
    assert.doesNotThrow(() =>
      HttpTransport.fromEnv({ TRUEFORGE_BASE_URL: 'http://harness.test', TRUEFORGE_API_KEY: 'k' }),
    );
  });
});

describe('HttpTransport.createSession', () => {
  it('posts the inline spec and returns the allocated id', async () => {
    const captured: Captured[] = [];
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      apiKey: 'secret-key',
      fetch: fakeFetch([], captured, { json: { data: { id: 'sess-42' } } }),
    });

    const id = await transport.createSession({ model: { name: 'm' } });

    assert.equal(id, 'sess-42');
    assert.match(captured[0]?.url ?? '', /\/api\/v1\/sessions$/);
    assert.equal(captured[0]?.method, 'POST');
    assert.match(captured[0]?.body ?? '', /"agent":\{"spec":/);
    assert.equal(captured[0]?.headers['authorization'], 'Bearer secret-key');
  });

  // A session id is the handle every later call hangs off; guessing one turns
  // every subsequent failure into a mystery about the wrong resource.
  it('refuses a response carrying no id', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([], [], { json: { data: {} } }),
    });

    await assert.rejects(transport.createSession({}), /no id; refusing to guess/);
  });

  it('reports the server explanation on failure', async () => {
    const transport = new HttpTransport({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([], [], { status: 422, statusText: 'Unprocessable', text: 'bad manifest' }),
    });

    await assert.rejects(transport.createSession({}), /422 Unprocessable — bad manifest/);
  });
});
