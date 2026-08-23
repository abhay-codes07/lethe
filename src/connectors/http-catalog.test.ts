import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classify } from './catalog.ts';
import { HttpToolCatalog } from './http-catalog.ts';

function fakeFetch(
  responses: readonly { status?: number; statusText?: string; json?: unknown; text?: string }[],
  captured: { url: string; headers: Record<string, string> }[] = [],
): typeof globalThis.fetch {
  let call = 0;
  return (async (url: string | URL, options: RequestInit = {}) => {
    captured.push({ url: String(url), headers: { ...(options.headers as Record<string, string>) } });
    const spec = responses[Math.min(call, responses.length - 1)]!;
    call += 1;

    const status = spec.status ?? 200;
    if (status >= 400) {
      return {
        ok: false,
        status,
        statusText: spec.statusText ?? 'Error',
        text: async () => spec.text ?? '',
      } as unknown as Response;
    }

    return { ok: true, status, json: async () => spec.json } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

describe('HttpToolCatalog', () => {
  it('reads tools with their annotations', async () => {
    const catalog = new HttpToolCatalog({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([
        {
          json: {
            tools: [
              { name: 'query', annotations: { readOnlyHint: true } },
              { name: 'delete_rows', annotations: { destructiveHint: true } },
            ],
          },
        },
      ]),
    });

    const tools = await catalog.listTools('acme-postgres');

    assert.equal(tools.length, 2);
    assert.equal(classify(tools[0]!), 'read_only');
    assert.equal(classify(tools[1]!), 'mutating');
  });

  // A string "true" must not be read as an assurance that a tool is safe.
  it('trusts only boolean annotations', async () => {
    const catalog = new HttpToolCatalog({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([{ json: { tools: [{ name: 'query', annotations: { readOnlyHint: 'true' } }] } }]),
    });

    const tools = await catalog.listTools('db');

    assert.equal(tools[0]?.annotations?.readOnlyHint, undefined);
    assert.equal(classify(tools[0]!), 'mutating');
  });

  it('skips entries with no usable name', async () => {
    const catalog = new HttpToolCatalog({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([{ json: { tools: [{ name: '' }, { description: 'orphan' }, { name: 'query' }] } }]),
    });

    assert.deepEqual((await catalog.listTools('db')).map((t) => t.name), ['query']);
  });

  // Conflating a protocol mismatch with an empty connector turns it into a
  // confident statement about somebody's data.
  it('rejects a response with no tools array rather than reporting none', async () => {
    const catalog = new HttpToolCatalog({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([{ json: { servers: [] } }]),
    });

    await assert.rejects(catalog.listTools('db'), /expected a "tools" array/);
  });

  it('reports the status and explanation on failure', async () => {
    const catalog = new HttpToolCatalog({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([{ status: 404, statusText: 'Not Found', text: 'no such connector' }]),
    });

    await assert.rejects(catalog.listTools('missing'), /404 Not Found — no such connector/);
  });

  it('sends the key as a bearer header, never in the URL', async () => {
    const captured: { url: string; headers: Record<string, string> }[] = [];
    const catalog = new HttpToolCatalog({
      baseUrl: 'http://harness.test',
      apiKey: 'secret-key',
      fetch: fakeFetch([{ json: { tools: [{ name: 'query' }] } }], captured),
    });

    await catalog.listTools('db');

    assert.equal(captured[0]?.headers['authorization'], 'Bearer secret-key');
    assert.ok(!captured[0]?.url.includes('secret-key'));
  });

  it('caches, since verification asks repeatedly and lists do not change mid-run', async () => {
    const captured: { url: string; headers: Record<string, string> }[] = [];
    const catalog = new HttpToolCatalog({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([{ json: { tools: [{ name: 'query' }] } }], captured),
    });

    await catalog.listTools('db');
    await catalog.listTools('db');

    assert.equal(captured.length, 1);
  });

  it('escapes the connector name into the path', async () => {
    const captured: { url: string; headers: Record<string, string> }[] = [];
    const catalog = new HttpToolCatalog({
      baseUrl: 'http://harness.test',
      fetch: fakeFetch([{ json: { tools: [{ name: 'query' }] } }], captured),
    });

    await catalog.listTools('db/../admin');

    assert.ok(!captured[0]?.url.includes('/../'), captured[0]?.url);
  });

  it('refuses to guess where the harness is', () => {
    assert.throws(() => HttpToolCatalog.fromEnv({}), /refusing to guess/);
  });
});
