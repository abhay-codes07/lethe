/**
 * Server-sent event parsing.
 *
 * The harness streams a turn as `text/event-stream`. That format looks trivial
 * and is not: chunks arrive on network boundaries rather than line boundaries,
 * so a field name, a JSON payload, or the two bytes of a `\r\n` can be split
 * across two reads. A parser that assumes whole lines works perfectly in
 * development and drops events under load.
 *
 * That failure mode matters more here than usual. A dropped event is a
 * dropped approval request — the run appears to stall with no gate to answer,
 * or worse, a partially parsed tool call reaches the approval screen with the
 * wrong arguments on it.
 *
 * Implemented against the WHATWG event-stream rules rather than by pattern
 * matching, because the edge cases are exactly the ones that only appear in
 * production.
 */

export interface SseFrame {
  /** Event type. Defaults to `message` when the stream does not name one. */
  readonly event: string;
  /** Payload. Multiple `data:` lines join with a newline, as per the spec. */
  readonly data: string;
  /** Last id seen, which persists across frames until the stream changes it. */
  readonly id?: string;
  readonly retry?: number;
}

/**
 * Incremental parser. Feed it chunks in order; it returns whatever frames
 * became complete.
 */
export class SseParser {
  #buffer = '';
  #data: string[] = [];
  #eventType = '';
  #lastId: string | undefined;
  #retry: number | undefined;

  /** The most recent id, for reconnecting with `Last-Event-ID`. */
  get lastEventId(): string | undefined {
    return this.#lastId;
  }

  /** Reconnection delay the server asked for, if any. */
  get retryMs(): number | undefined {
    return this.#retry;
  }

  push(chunk: string): readonly SseFrame[] {
    this.#buffer += chunk;

    const frames: SseFrame[] = [];
    for (;;) {
      const next = this.#takeLine();
      if (next === undefined) break;

      const frame = this.#handleLine(next);
      if (frame) frames.push(frame);
    }

    return frames;
  }

  /**
   * Called when the connection ends.
   *
   * A stream that closes without a trailing blank line leaves a complete event
   * sitting in the buffer. Discarding it loses the last thing the server said,
   * which is disproportionately likely to be the one that mattered — a
   * `turn.done`, or the approval request the run is now waiting on.
   */
  flush(): readonly SseFrame[] {
    const frames: SseFrame[] = [];

    // Any bytes left with no line terminator are still a line.
    if (this.#buffer.length > 0) {
      const line = this.#buffer;
      this.#buffer = '';
      const frame = this.#handleLine(line);
      if (frame) frames.push(frame);
    }

    const final = this.#dispatch();
    if (final) frames.push(final);

    return frames;
  }

  /**
   * Take one complete line, or nothing if the buffer does not hold one yet.
   *
   * A buffer ending in a lone `\r` is held back: the next chunk may begin with
   * `\n`, and treating the `\r` as a terminator would split one line in two.
   */
  #takeLine(): string | undefined {
    const buffer = this.#buffer;

    for (let i = 0; i < buffer.length; i += 1) {
      const char = buffer[i];

      if (char === '\n') {
        this.#buffer = buffer.slice(i + 1);
        return buffer.slice(0, i);
      }

      if (char === '\r') {
        if (i === buffer.length - 1) return undefined;
        const skip = buffer[i + 1] === '\n' ? 2 : 1;
        this.#buffer = buffer.slice(i + skip);
        return buffer.slice(0, i);
      }
    }

    return undefined;
  }

  #handleLine(line: string): SseFrame | undefined {
    if (line === '') return this.#dispatch();

    // A line beginning with a colon is a comment. Servers send these as
    // keep-alives, and treating one as a field would invent a frame.
    if (line.startsWith(':')) return undefined;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);

    // Exactly one leading space is part of the framing, not the value.
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'event':
        this.#eventType = value;
        break;
      case 'data':
        this.#data.push(value);
        break;
      case 'id':
        // Ids containing NUL are ignored rather than truncated.
        if (!value.includes('\0')) this.#lastId = value;
        break;
      case 'retry': {
        if (/^\d+$/.test(value)) this.#retry = Number(value);
        break;
      }
      default:
        // Unknown fields are ignored, so the server can add some without
        // breaking older clients.
        break;
    }

    return undefined;
  }

  #dispatch(): SseFrame | undefined {
    if (this.#data.length === 0) {
      // A blank line with nothing buffered still resets the event type, or a
      // stray type would attach itself to the next frame.
      this.#eventType = '';
      return undefined;
    }

    const frame: SseFrame = {
      event: this.#eventType === '' ? 'message' : this.#eventType,
      data: this.#data.join('\n'),
      ...(this.#lastId !== undefined ? { id: this.#lastId } : {}),
      ...(this.#retry !== undefined ? { retry: this.#retry } : {}),
    };

    this.#data = [];
    this.#eventType = '';

    return frame;
  }
}

/** Parse a whole stream of chunks. Convenience for tests and replay. */
export function parseSse(chunks: Iterable<string>): readonly SseFrame[] {
  const parser = new SseParser();
  const frames: SseFrame[] = [];

  for (const chunk of chunks) {
    frames.push(...parser.push(chunk));
  }
  frames.push(...parser.flush());

  return frames;
}
