import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_CONFIG, type AgentSpec } from '../agents/spec.ts';
import type { Identifier } from '../domain/identity.ts';
import { smoke } from './run.ts';

const seed: Identifier = { kind: 'email', value: 'ada@example.invalid', system: 'db' };

function spec(): AgentSpec {
  return {
    name: 'lethe-scout',
    model: 'test/model',
    instructions: 'test',
    mcpServers: [{ name: 'db', enableTools: '@read-only' }],
    skills: [],
    config: BASE_CONFIG,
  };
}

/** Captures stdout so the run's report can be asserted on. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';

  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    out += chunk;
    return true;
  };

  try {
    const code = await fn();
    return { code, out };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

/** A fetch that fails every request, standing in for "no harness there". */
const unreachable = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof globalThis.fetch;

describe('smoke', () => {
  // The point of the smoke run is to be pointed at something real. When
  // nothing answers it must say so plainly and fail, not report a clean sweep.
  it('fails and names the unreachable connector', async () => {
    const { code, out } = await capture(() =>
      smoke({
        baseUrl: 'http://nothing.invalid',
        apiKey: undefined,
        scout: spec(),
        seed,
        fetch: unreachable,
      }),
    );

    assert.equal(code, 1);
    assert.match(out, /connectors/);
  });

  // A session must exist before a turn can run on it; the smoke run creates
  // one and says so when it cannot.
  it('stops at session creation when the harness is unreachable', async () => {
    const { code, out } = await capture(() =>
      smoke({
        baseUrl: 'http://nothing.invalid',
        apiKey: undefined,
        scout: spec(),
        seed,
        fetch: unreachable,
      }),
    );

    assert.equal(code, 1);
    assert.match(out, /── session/);
    assert.match(out, /FAIL/);
  });

  it('prints the case file history when discovery fails after a session exists', async () => {
    // Session creation succeeds; everything after does not.
    const partial = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/sessions') && init?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ data: { id: 'sess-smoke' } }),
        } as unknown as Response;
      }
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const { out } = await capture(() =>
      smoke({
        baseUrl: 'http://nothing.invalid',
        apiKey: undefined,
        scout: spec(),
        seed,
        fetch: partial,
      }),
    );

    assert.match(out, /created sess-smoke/);
    assert.match(out, /case file:/);
  });
});
