import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Finding } from './finding.ts';
import {
  assessRetention,
  DEFAULT_RETENTION_RULES,
  requiresHumanReview,
  type RetentionRule,
} from './legal.ts';

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

const table = (name: string): Finding['locator'] => ({
  kind: 'table',
  schema: 'public',
  table: name,
  predicate: 'x',
});

describe('assessRetention', () => {
  it('finds no ground for ordinary behavioural data', () => {
    assert.equal(assessRetention(finding()), undefined);
  });

  it('retains financial records under the tax obligation, anonymisable', () => {
    const assessment = assessRetention(finding({ locator: table('invoices') }));

    assert.equal(assessment?.rule.id, 'tax-records');
    assert.equal(assessment?.rule.anonymisationPermitted, true);
    assert.match(assessment?.rule.citation ?? '', /Art\.17\(3\)\(b\)/);
  });

  it('matches on the financial category as well as the table name', () => {
    const assessment = assessRetention(finding({ category: 'financial', locator: table('ledger_x') }));
    assert.equal(assessment?.rule.id, 'tax-records');
  });

  it('retains data under legal hold intact, refusing anonymisation', () => {
    const assessment = assessRetention(finding({ locator: table('legal_holds') }));

    assert.equal(assessment?.rule.id, 'active-legal-claim');
    assert.equal(assessment?.rule.anonymisationPermitted, false);
  });

  /**
   * Regression. The rules previously listed tax before legal claims, so a
   * financial record sitting under an open dispute matched the tax rule first
   * and was marked anonymisable — destroying the identity that is often the
   * very fact in dispute, while the matter was still live.
   */
  it('puts an open legal hold ahead of the tax obligation', () => {
    const assessment = assessRetention(
      finding({ category: 'financial', locator: table('legal_holds') }),
    );

    assert.equal(assessment?.rule.id, 'active-legal-claim');
    assert.equal(
      assessment?.rule.anonymisationPermitted,
      false,
      'data under an open dispute must not be anonymised',
    );
  });

  it('keeps the legal-claim rule ahead of every anonymisable rule', () => {
    const firstAnonymisable = DEFAULT_RETENTION_RULES.findIndex((r) => r.anonymisationPermitted);
    const legalClaim = DEFAULT_RETENTION_RULES.findIndex((r) => r.ground === 'legal_claims');

    assert.ok(legalClaim >= 0, 'a legal-claims rule must exist');
    assert.ok(
      legalClaim < firstAnonymisable,
      'an unbounded legal hold must be evaluated before any rule that would anonymise',
    );
  });

  it('anonymises published contributions rather than deleting them', () => {
    const assessment = assessRetention(
      finding({ category: 'communications', locator: table('comments') }),
    );

    assert.equal(assessment?.rule.ground, 'freedom_of_expression');
    assert.equal(assessment?.rule.anonymisationPermitted, true);
  });

  it('honours a caller-supplied rule set', () => {
    const custom: RetentionRule[] = [
      {
        id: 'everything',
        ground: 'legal_obligation',
        citation: 'local policy',
        rationale: 'test',
        anonymisationPermitted: false,
        appliesTo: () => true,
      },
    ];

    assert.equal(assessRetention(finding(), custom)?.rule.id, 'everything');
  });

  it('returns the first matching rule and stops', () => {
    const rules: RetentionRule[] = [
      { id: 'first', ground: 'legal_claims', citation: 'a', rationale: 'a', anonymisationPermitted: false, appliesTo: () => true },
      { id: 'second', ground: 'legal_obligation', citation: 'b', rationale: 'b', anonymisationPermitted: true, appliesTo: () => true },
    ];

    assert.equal(assessRetention(finding(), rules)?.rule.id, 'first');
  });
});

describe('DEFAULT_RETENTION_RULES', () => {
  it('gives every rule a citable provision', () => {
    for (const rule of DEFAULT_RETENTION_RULES) {
      assert.match(rule.citation, /GDPR Art\.17\(3\)/, rule.id);
    }
  });

  it('gives every rule a plain-English rationale a non-lawyer can check', () => {
    for (const rule of DEFAULT_RETENTION_RULES) {
      assert.ok(rule.rationale.length > 30, `${rule.id} rationale is too thin to be checkable`);
    }
  });

  it('uses unique ids, since the id is what appears on the certificate', () => {
    const ids = DEFAULT_RETENTION_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('bounds any retention period it states', () => {
    for (const rule of DEFAULT_RETENTION_RULES) {
      if (rule.retainForMonths !== undefined) {
        assert.ok(rule.retainForMonths > 0, rule.id);
      }
    }
  });
});

describe('requiresHumanReview', () => {
  // Both deleting and keeping special category data carries consequences, so
  // it is never resolved by rule.
  it('escalates special category data', () => {
    assert.equal(requiresHumanReview(finding({ category: 'special_category' })), true);
  });

  it('does not escalate ordinary categories', () => {
    for (const category of ['identity', 'contact', 'financial', 'behavioural', 'derived'] as const) {
      assert.equal(requiresHumanReview(finding({ category })), false, category);
    }
  });
});
