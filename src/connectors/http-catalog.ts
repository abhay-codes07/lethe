/**
 * Reading the live tool list from the harness.
 *
 * Thin on purpose. The judgement lives in `verify.ts`; this only fetches, and
 * fetches carefully enough that a bad response becomes an error rather than an
 * empty list — an empty list would read as "this connector exposes nothing",
 * which verification treats as fatal for good reasons but for the wrong one.
 */

import type { ToolCatalog, ToolDescriptor } from './catalog.ts';

export interface HttpToolCatalogOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface RawTool {
  readonly name?: string;
  readonly description?: string;
  readonly annotations?: Record<string, unknown>;
}

interface ToolListResponse {
  readonly tools?: readonly RawTool[];
}

export class HttpToolCatalog implements ToolCatalog {
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof globalThis.fetch;
  /** Tool lists do not change during a run, and verification asks repeatedly. */
  readonly #cache = new Map<string, readonly ToolDescriptor[]>();

  constructor(options: HttpToolCatalogOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpToolCatalog {
    const baseUrl = env['TRUEFORGE_BASE_URL'];
    if (!baseUrl) {
      throw new Error('TRUEFORGE_BASE_URL is not set; refusing to guess where the harness is');
    }

    const apiKey = env['TRUEFORGE_API_KEY'];
    return new HttpToolCatalog({ baseUrl, ...(apiKey ? { apiKey } : {}) });
  }

  async listTools(serverName: string): Promise<readonly ToolDescriptor[]> {
    const cached = this.#cache.get(serverName);
    if (cached) return cached;

    const url = `${this.#baseUrl}/api/v1/mcp-servers/${encodeURIComponent(serverName)}/tools`;

    const response = await this.#fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `listing tools for ${serverName} failed: ${response.status} ${response.statusText}` +
          (detail ? ` — ${detail.slice(0, 200)}` : ''),
      );
    }

    const body = (await response.json()) as ToolListResponse;

    // A response with no tools array is a shape we did not expect, not a
    // connector with no tools. Conflating them would turn a protocol mismatch
    // into a confident statement about somebody's data.
    if (!Array.isArray(body.tools)) {
      throw new Error(
        `harness returned no tool list for ${serverName}; expected a "tools" array`,
      );
    }

    const tools = body.tools.map(toDescriptor).filter((tool): tool is ToolDescriptor => tool !== undefined);
    this.#cache.set(serverName, tools);

    return tools;
  }
}

function toDescriptor(raw: RawTool): ToolDescriptor | undefined {
  if (typeof raw.name !== 'string' || raw.name === '') return undefined;

  const annotations = raw.annotations ?? {};

  // Only booleans are trusted. A string "true" or a missing key must not be
  // read as an assurance that a tool is safe.
  const readOnlyHint = annotations['readOnlyHint'];
  const destructiveHint = annotations['destructiveHint'];
  const idempotentHint = annotations['idempotentHint'];

  return {
    name: raw.name,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    annotations: {
      ...(typeof readOnlyHint === 'boolean' ? { readOnlyHint } : {}),
      ...(typeof destructiveHint === 'boolean' ? { destructiveHint } : {}),
      ...(typeof idempotentHint === 'boolean' ? { idempotentHint } : {}),
    },
  };
}
