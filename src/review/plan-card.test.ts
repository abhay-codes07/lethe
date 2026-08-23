import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Finding } from '../domain/finding.ts';
import type { Identifier } from '../domain/identity.ts';
import { type BlastRadius, draftPlan, withBlastRadius } from '../domain/plan.ts';
import { formatPlanCard, renderPlanCard } from './plan-card.ts';

const subject: Identifier = { kind: 'user_id', value: '4471', system: 'acme-postgres' };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    system: 'acme-postgres',
    locator: { kind: 'table', schema: 'public', table: 'sessions', predicate: 'user_id = 4471' },
    category: 'behavioural',
    durability: 'hard_delete',
    count: 10,
    matchedBy: subject,
    observedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

const clean: BlastRadius = {
  constraintViolations: [],
  orphanedRecords: 0,
  residualTraces: 0,
  snapshotId: 'snap-7',
  simulatedAt: '2026-08-23T10:05:00.000Z',
};

function simulated(findings: readonly Finding[], blast: BlastRadius = clean) {
  return withBlastRadius(draftPlan('DSR-118', [subject], findings), blast);
}

describe('renderPlanCard', () => {
  it('renders a simulated plan with its measured figures', () => {
    const findings = [finding()];
    const result = renderPlanCard(simulated(findings), findings);

    assert.equal(result.kind, 'renderable');
    if (result.kind !== 'renderable') return;

    assert.equal(result.card.requestId, 'DSR-118');
    assert.equal(result.card.irreversibleRecords, 10);
    assert.equal(result.card.simulation.snapshotId, 'snap-7');
    assert.equal(result.card.lines[0]?.location, 'public.sessions where user_id = 4471');
  });

  // A card that renders regardless of the evidence behind it is a rubber stamp
  // with formatting.
  it('refuses to render an unsimulated plan, and says why', () => {
    const findings = [finding()];
    const result = renderPlanCard(draftPlan('DSR-118', [subject], findings), findings);

    assert.equal(result.kind, 'not_approvable');
    assert.ok(
      result.kind === 'not_approvable' &&
        result.blockers.some((b) => /has not been measured/.test(b)),
    );
  });

  it('refuses to render a plan that would break referential integrity', () => {
    const findings = [finding()];
    const plan = simulated(findings, {
      ...clean,
      constraintViolations: [
        { constraint: 'order_items_customer_fk', table: 'order_items', affectedRows: 41 },
      ],
    });

    assert.equal(renderPlanCard(plan, findings).kind, 'not_approvable');
  });

  // Rendering anyway would produce a line with a count and no location — a
  // number to approve with no subject.
  it('refuses when a planned action refers to a finding it was not given', () => {
    const plan = simulated([finding({ id: 'f1' })]);
    const result = renderPlanCard(plan, [finding({ id: 'other' })]);

    assert.equal(result.kind, 'incomplete');
    assert.deepEqual(result.kind === 'incomplete' && result.missingFindingIds, ['f1']);
  });

  it('orders irreversible destruction ahead of everything else', () => {
    const findings = [
      finding({ id: 'f-retain', count: 99, locator: { kind: 'table', schema: 'public', table: 'legal_holds', predicate: 'x' } }),
      finding({ id: 'f-delete', count: 5 }),
      finding({
        id: 'f-purge',
        count: 218,
        durability: 'requires_compaction',
        system: 'acme-vectors',
        locator: { kind: 'vector', index: 'support-tickets', documentIds: ['a'] },
      }),
    ];

    const result = renderPlanCard(simulated(findings), findings);
    assert.equal(result.kind, 'renderable');
    if (result.kind !== 'renderable') return;

    assert.deepEqual(
      result.card.lines.map((l) => l.disposition),
      ['delete_and_compact', 'delete', 'retain'],
    );
  });

  it('puts the larger blast radius first within a disposition', () => {
    const findings = [finding({ id: 'small', count: 3 }), finding({ id: 'large', count: 900, locator: { kind: 'table', schema: 'public', table: 'events', predicate: 'x' } })];

    const result = renderPlanCard(simulated(findings), findings);
    assert.equal(result.kind, 'renderable');
    if (result.kind !== 'renderable') return;

    assert.deepEqual(result.card.lines.map((l) => l.count), [900, 3]);
  });

  it('carries the legal citation onto the line that relies on it', () => {
    const findings = [
      finding({
        id: 'f-tax',
        category: 'financial',
        locator: { kind: 'table', schema: 'public', table: 'invoices', predicate: 'customer_id = 4471' },
      }),
    ];

    const result = renderPlanCard(simulated(findings), findings);
    assert.equal(result.kind, 'renderable');
    if (result.kind !== 'renderable') return;

    assert.match(result.card.lines[0]?.citation ?? '', /Art\.17\(3\)\(b\)/);
  });
});

describe('formatPlanCard', () => {
  function card() {
    const findings = [
      finding({ id: 'f-delete', count: 1247 }),
      finding({
        id: 'f-tax',
        count: 14,
        category: 'financial',
        locator: { kind: 'table', schema: 'public', table: 'invoices', predicate: 'customer_id = 4471' },
      }),
    ];
    const result = renderPlanCard(simulated(findings), findings);
    assert.equal(result.kind, 'renderable');
    return result.kind === 'renderable' ? result.card : undefined;
  }

  it('states the snapshot the figures came from', () => {
    assert.match(formatPlanCard(card()!), /snapshot snap-7/);
  });

  it('groups thousands so a large count is readable at a glance', () => {
    assert.match(formatPlanCard(card()!), /1,247 records/);
  });

  it('uses the singular for a single record', () => {
    const findings = [finding({ count: 1 })];
    const result = renderPlanCard(simulated(findings), findings);
    assert.equal(result.kind, 'renderable');
    if (result.kind !== 'renderable') return;

    assert.match(formatPlanCard(result.card), /1 record —/);
  });

  it('shows the legal basis for anything it is refusing to delete outright', () => {
    assert.match(formatPlanCard(card()!), /Basis: GDPR Art\.17\(3\)\(b\)/);
  });

  // The warning is what makes the consequence explicit. It is never softened,
  // and it must survive any change to the formatter.
  it('always states that the action is permanent and that nothing has happened yet', () => {
    const text = formatPlanCard(card()!);
    assert.match(text, /cannot be undone/);
    assert.match(text, /Nothing has been touched yet/);
  });

  it('reports the dry run alongside the totals', () => {
    const text = formatPlanCard(card()!);
    assert.match(text, /0 constraint violation\(s\), 0 trace\(s\) remaining/);
  });
});
