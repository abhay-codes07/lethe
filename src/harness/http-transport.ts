/**
 * `Transport` over HTTP.
 *
 * The first code in the project that leaves the process. Everything above it
 * decides; this fetches.
 *
 * Two things it is careful about.
 *
 * **Credentials never leave this file.** The API key is read once and attached
 * as a header. It is not logged, not put in a URL where it would land in an
 * access log, and not carried in anything a caller can print.
 *
 * **A dropped stream is never mistaken for a finished one.** The turn runner
 * refuses to treat a stream ending without a terminal status as complete, and
 * that guarantee only holds if this layer surfaces a truncated response as an
 * error rather than as a tidy end of iteration.
 */

import type { ReceivedEvent, TurnEvent, TurnInput } from './protocol.ts';
import { SseParser } from './sse.ts';
import type { Transport, TurnState } from './transport.ts';

export interface HttpTransportOptions {
  /** Base URL of the harness, e.g. `http://localhost:3000`. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Injected for tests, and to allow a caller to supply a proxied fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Abort a request that produces no data at all within this window. */
  readonly requestTimeoutMs?: number;
}

/**
 * Endpoint paths, in one place.
 *
 * Collected here rather than inlined so that adapting to a different harness
 * build is a single edit in a single file, instead of a search through the
 * call sites.
 */
const routes = {
  turns: (sessionId: string) => `/api/v1/sessions/${encode(sessionId)}/turns`,
  turn: (sessionId: string, turnId: string) =>
    `/api/v1/sessions/${encode(sessionId)}/turns/${encode(turnId)}`,
  subscribe: (sessionId: string, turnId: string) =>
    `/api/v1/sessions/${encode(sessionId)}/turns/${encode(turnId)}/subscribe`,
  events: (sessionId: string, turnId: string) =>
    `/api/v1/sessions/${encode(sessionId)}/turns/${encode(turnId)}/events`,
};

function encode(segment: string): string {
  return encodeURIComponent(segment);
}

const DEFAULT_TIMEOUT_MS = 600_000;

export class HttpTransport implements Transport {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpTransportOptions) {
    // Trailing slashes turn every path into a double slash, which some
    // routers treat as a different resource.
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Build from the environment.
   *
   * Fails loudly on a missing base URL rather than defaulting to localhost: a
   * silent fallback in a deployed environment would point an erasure run at
   * nothing, and the failure would surface much later as an empty discovery.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpTransport {
    const baseUrl = env['TRUEFORGE_BASE_URL'];
    if (!baseUrl) {
      throw new Error('TRUEFORGE_BASE_URL is not set; refusing to guess where the harness is');
    }

    const apiKey = env['TRUEFORGE_API_KEY'];
    return new HttpTransport({ baseUrl, ...(apiKey ? { apiKey } : {}) });
  }

  createTurn(sessionId: string, input: readonly TurnInput[]): AsyncIterable<ReceivedEvent> {
    return this.#stream(routes.turns(sessionId), {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
  }

  subscribeToTurn(
    sessionId: string,
    turnId: string,
    afterSequence?: number,
  ): AsyncIterable<ReceivedEvent> {
    // Last-Event-ID is the standard mechanism and the one the harness honours
    // on reconnect, so the sequence number travels as a header rather than a
    // query parameter.
    const headers: Record<string, string> =
      afterSequence === undefined ? {} : { 'Last-Event-ID': String(afterSequence) };

    return this.#stream(routes.subscribe(sessionId, turnId), { method: 'GET', headers });
  }

  listTurnEvents(sessionId: string, turnId: string): AsyncIterable<ReceivedEvent> {
    return this.#stream(routes.events(sessionId, turnId), { method: 'GET' });
  }

  async getTurn(sessionId: string, turnId: string): Promise<TurnState> {
    const response = await this.#fetch(this.#url(routes.turn(sessionId, turnId)), {
      method: 'GET',
      headers: this.#headers(),
    });

    await assertOk(response, 'get turn');

    const body = (await response.json()) as { turnId?: string; state?: { status?: string } };
    const status = body.state?.status;

    if (!status) {
      throw new Error(`harness returned a turn with no status for ${turnId}`);
    }

    return { turnId: body.turnId ?? turnId, status: status as TurnState['status'] };
  }

  #url(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      ...extra,
    };
  }

  async *#stream(
    path: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): AsyncIterable<ReceivedEvent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(this.#url(path), {
        method: init.method,
        headers: this.#headers(init.headers),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: controller.signal,
      });

      await assertOk(response, `stream ${path}`);

      if (!response.body) {
        throw new Error(`harness returned no body for ${path}`);
      }

      const parser = new SseParser();
      const decoder = new TextDecoder();

      for await (const chunk of response.body) {
        const text = decoder.decode(chunk, { stream: true });
        for (const frame of parser.push(text)) {
          const event = toReceivedEvent(frame.data, frame.id);
          if (event) yield event;
        }
      }

      // A stream that closed mid-frame still holds a complete event, and it is
      // disproportionately likely to be the turn.done or the approval request
      // the run is now waiting on.
      for (const frame of parser.flush()) {
        const event = toReceivedEvent(frame.data, frame.id);
        if (event) yield event;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Turn one frame's payload into an event.
 *
 * Returns undefined for the stream's own control frames — a `[DONE]` sentinel
 * or a keep-alive — which carry no event. A malformed payload throws, because
 * skipping it would silently drop an approval request and leave the run
 * looking stalled rather than broken.
 */
function toReceivedEvent(data: string, id: string | undefined): ReceivedEvent | undefined {
  const trimmed = data.trim();
  if (trimmed === '' || trimmed === '[DONE]') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`harness sent a frame that is not JSON: ${truncate(trimmed)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
    throw new Error(`harness sent a frame with no event type: ${truncate(trimmed)}`);
  }

  const sequence = id === undefined ? undefined : Number(id);

  return {
    event: parsed as TurnEvent,
    ...(sequence !== undefined && Number.isFinite(sequence) ? { sequence } : {}),
  };
}

async function assertOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;

  // Read the body for the server's explanation, but never echo headers — the
  // request carried a bearer token.
  const detail = await response.text().catch(() => '');
  throw new Error(
    `${what} failed: ${response.status} ${response.statusText}${detail ? ` — ${truncate(detail)}` : ''}`,
  );
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
