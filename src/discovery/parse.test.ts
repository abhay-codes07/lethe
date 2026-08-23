import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IdentityGraph, type Identifier } from '../domain/identity.ts';
import { formatErrors, parseFindings, type ParseContext } from './parse.ts';

const email: Identifier = { kind: 'email', value: 'ada@example.com', system: 'acme-postgres' };
const userId: Identifier = { kind: 'user_id', value: '4471', system: 'acme-postgres' };

function context(): ParseContext {
  const identities = new IdentityGraph([email]);
  identities.derive(userId, email, 'users.email = $1 -> users.id', 'certain');

  return {
    knownSystems: new Set(['acme-postgres', 'acme-s3', 'acme-vectors']),
    identities,
  };
}

function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f1',
    system: 'acme-postgres',
    locator: { kind: 'table', schema: 'public', table: 'sessions', predicate: 'user_id = 4471' },
    category: 'behavioural',
    durability: 'hard_delete',
    count: 10,
    matchedBy: { kind: 'user_id', value: '4471', system: 'acme-postgres' },
    observedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

function parse(findings: unknown[], ctx = context()) {
  return parseFindings({ findings }, ctx);
}

describe('parseFindings — well-formed input', () => {
  it('accepts a valid finding', () => {
    const result = parse([validFinding()]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.findings[0]?.count, 10);
  });

  it('accepts a JSON string as well as an object', () => {
    const result = parseFindings(JSON.stringify({ findings: [validFinding()] }), context());
    assert.equal(result.ok, true);
  });

  it('accepts every locator shape', () => {
    const result = parse([
      validFinding({ id: 'a' }),
      validFinding({ id: 'b', system: 'acme-s3', locator: { kind: 'object', bucket: 'x', key: 'y' } }),
      validFinding({ id: 'c', locator: { kind: 'api_resource', resource: 'customer', id: 'cus_1' } }),
      validFinding({
        id: 'd',
        system: 'acme-vectors',
        locator: { kind: 'vector', index: 'tickets', documentIds: ['d1'] },
      }),
      validFinding({ id: 'e', locator: { kind: 'log_stream', stream: 'app', window: '90d' } }),
    ]);

    assert.equal(result.ok, true, result.ok ? '' : formatErrors(result.errors));
  });

  it('carries dependents through when present', () => {
    const result = parse([validFinding({ dependents: ['f2', 'f3'] })]);
    assert.deepEqual(result.ok && result.findings[0]?.dependents, ['f2', 'f3']);
  });

  it('accepts an empty result — a subject may genuinely have no data', () => {
    const result = parse([]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.findings, []);
  });
});

describe('parseFindings — invented targets', () => {
  // The rule that stops the model introducing a subject. Without it, "delete
  // everything matching bob@example.com" is a sentence it can simply write.
  it('rejects a finding matched by an identifier discovery never established', () => {
    const result = parse([
      validFinding({ matchedBy: { kind: 'email', value: 'bob@example.com', system: 'acme-postgres' } }),
    ]);

    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors.some((e) => /not in the identity graph/.test(e.message)),
    );
  });

  it('rejects the right identifier attributed to the wrong system', () => {
    const result = parse([
      validFinding({ matchedBy: { kind: 'user_id', value: '4471', system: 'acme-s3' } }),
    ]);

    assert.equal(result.ok, false);
  });

  // A system nobody declared is a system nobody verified was read-only.
  it('rejects a finding in an undeclared system', () => {
    const result = parse([validFinding({ system: 'shadow-warehouse' })]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => /not a configured connector/.test(e.message)));
  });

  it('rejects an unknown identifier kind', () => {
    const result = parse([
      validFinding({ matchedBy: { kind: 'social_security', value: '1', system: 'acme-postgres' } }),
    ]);

    assert.equal(result.ok, false);
  });
});

describe('parseFindings — malformed fields', () => {
  it('rejects a missing or empty id', () => {
    assert.equal(parse([validFinding({ id: '' })]).ok, false);
    assert.equal(parse([validFinding({ id: undefined })]).ok, false);
  });

  // Duplicates double-count records on the approval card, and the count is the
  // figure a person judges the request by.
  it('rejects a duplicate id', () => {
    const result = parse([validFinding({ id: 'same' }), validFinding({ id: 'same' })]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => /duplicate finding id/.test(e.message)));
  });

  it('rejects an unknown data category', () => {
    assert.equal(parse([validFinding({ category: 'vibes' })]).ok, false);
  });

  // Durability decides whether a delete actually deletes, so it cannot be
  // guessed or defaulted.
  it('rejects an unknown durability', () => {
    const result = parse([validFinding({ durability: 'probably_gone' })]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => /cannot be guessed/.test(e.message)));
  });

  it('rejects counts that are not whole positive numbers', () => {
    for (const count of [0, -3, 1.5, '10', Number.NaN]) {
      assert.equal(parse([validFinding({ count })]).ok, false, String(count));
    }
  });

  it('rejects a malformed timestamp', () => {
    assert.equal(parse([validFinding({ observedAt: 'yesterday' })]).ok, false);
  });

  it('rejects an incomplete table locator', () => {
    const result = parse([
      validFinding({ locator: { kind: 'table', schema: 'public', table: 'sessions' } }),
    ]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => /needs schema, table and predicate/.test(e.message)));
  });

  it('rejects a vector locator with no documents', () => {
    const result = parse([
      validFinding({ system: 'acme-vectors', locator: { kind: 'vector', index: 'tickets', documentIds: [] } }),
    ]);

    assert.equal(result.ok, false);
  });

  it('rejects an unknown locator kind', () => {
    assert.equal(parse([validFinding({ locator: { kind: 'somewhere' } })]).ok, false);
  });
});

describe('parseFindings — shape', () => {
  it('rejects a reply that is not JSON', () => {
    const result = parseFindings('I looked and found some rows', context());

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => /not valid JSON/.test(e.message)));
  });

  it('rejects a reply with no findings array', () => {
    assert.equal(parseFindings({ results: [] }, context()).ok, false);
  });

  it('rejects a non-object entry', () => {
    assert.equal(parse(['public.sessions']).ok, false);
  });
});

describe('parseFindings — reporting', () => {
  // A run that produced eight malformed findings needs one report, not eight
  // round trips.
  it('collects every error rather than stopping at the first', () => {
    const result = parse([
      validFinding({ id: '', category: 'vibes' }),
      validFinding({ id: 'f2', system: 'nowhere' }),
    ]);

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.length >= 3);
  });

  it('attributes each error to its position', () => {
    const result = parse([validFinding(), validFinding({ id: 'f2', count: -1 })]);

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.errors[0]?.index, 1);
    assert.match(!result.ok ? formatErrors(result.errors) : '', /findings\[1\]\.count/);
  });

  it('rejects the whole batch when any finding is bad', () => {
    const result = parse([validFinding({ id: 'good' }), validFinding({ id: 'bad', count: 0 })]);
    assert.equal(result.ok, false);
  });
});
