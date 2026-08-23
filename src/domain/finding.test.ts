import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeLocator, type Finding, needsFollowUp, totalRecords } from './finding.ts';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    system: 'acme-postgres',
    locator: { kind: 'table', schema: 'public', table: 'sessions', predicate: 'user_id = 4471' },
    category: 'behavioural',
    durability: 'hard_delete',
    count: 1,
    matchedBy: { kind: 'user_id', value: '4471', system: 'acme-postgres' },
    observedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

describe('describeLocator', () => {
  // This string is what a person reads on the approval card as the answer to
  // "what exactly are you about to delete?".
  it('names the table and the predicate', () => {
    assert.equal(
      describeLocator({ kind: 'table', schema: 'public', table: 'sessions', predicate: 'user_id = 4471' }),
      'public.sessions where user_id = 4471',
    );
  });

  it('renders an object as its full path', () => {
    assert.equal(
      describeLocator({ kind: 'object', bucket: 'acme-exports', key: 'users/4471.json' }),
      's3://acme-exports/users/4471.json',
    );
  });

  it('renders an API resource', () => {
    assert.equal(describeLocator({ kind: 'api_resource', resource: 'customer', id: 'cus_1' }), 'customer/cus_1');
  });

  // The document count matters more than the ids here: it is the figure that
  // tells someone how much of the index is about to change.
  it('renders a vector locator with how many documents it covers', () => {
    assert.equal(
      describeLocator({ kind: 'vector', index: 'support-tickets', documentIds: ['a', 'b', 'c'] }),
      'support-tickets (3 documents)',
    );
  });

  it('renders a log stream with its window', () => {
    assert.equal(describeLocator({ kind: 'log_stream', stream: 'app', window: '90d' }), 'app over 90d');
  });

  it('describes every locator kind, so none reaches the card unlabelled', () => {
    const locators: Finding['locator'][] = [
      { kind: 'table', schema: 's', table: 't', predicate: 'p' },
      { kind: 'object', bucket: 'b', key: 'k' },
      { kind: 'api_resource', resource: 'r', id: 'i' },
      { kind: 'vector', index: 'v', documentIds: ['d'] },
      { kind: 'log_stream', stream: 'l', window: 'w' },
    ];

    for (const locator of locators) {
      const described = describeLocator(locator);
      assert.ok(described.length > 0, locator.kind);
      assert.ok(!described.includes('undefined'), `${locator.kind}: ${described}`);
    }
  });
});

describe('needsFollowUp', () => {
  // These are the findings that turn "we deleted it" into a false statement.
  it('selects findings a plain delete would leave recoverable', () => {
    const findings = [
      finding({ id: 'gone', durability: 'hard_delete' }),
      finding({ id: 'tombstoned', durability: 'requires_compaction' }),
      finding({ id: 'immutable', durability: 'immutable_until_expiry' }),
    ];

    assert.deepEqual(needsFollowUp(findings).map((f) => f.id), ['tombstoned', 'immutable']);
  });

  it('returns nothing when every store forgets on delete', () => {
    assert.deepEqual(needsFollowUp([finding()]), []);
  });
});

describe('totalRecords', () => {
  it('sums the counts', () => {
    assert.equal(totalRecords([finding({ count: 10 }), finding({ count: 4 })]), 14);
  });

  it('is zero for no findings', () => {
    assert.equal(totalRecords([]), 0);
  });
});
