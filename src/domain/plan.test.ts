import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Finding } from './finding.ts';
import type { Identifier } from './identity.ts';
import {
  approvalBlockers,
  assertApprovable,
  type BlastRadius,
  draftPlan,
  irreversibleRecordCount,
  summarise,
  withBlastRadius,
} from './plan.ts';

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
    observedAt: '2026-08-22T10:00:00.000Z',
    ...overrides,
  };
}

const cleanSimulation: BlastRadius = {
  constraintViolations: [],
  orphanedRecords: 0,
  residualTraces: 0,
  snapshotId: 'snap-1',
  simulatedAt: '2026-08-22T10:05:00.000Z',
};

describe('draftPlan', () => {
  it('deletes data with no retention ground', () => {
    const plan = draftPlan('DSR-1', [subject], [finding()]);
    assert.equal(plan.actions[0]?.disposition, 'delete');
    assert.equal(plan.actions[0]?.irreversible, true);
  });

  // A row deleted from an HNSW index is usually only tombstoned and stays
  // reconstructible from the raw index files, so "delete" alone would make the
  // certificate a false statement.
  it('schedules compaction where a delete leaves data recoverable', () => {
    const plan = draftPlan(
      'DSR-1',
      [subject],
      [
        finding({
          durability: 'requires_compaction',
          locator: { kind: 'vector', index: 'support-tickets', documentIds: ['d1', 'd2'] },
        }),
      ],
    );

    assert.equal(plan.actions[0]?.disposition, 'delete_and_compact');
    assert.match(plan.actions[0]?.justification ?? '', /recoverable/);
  });

  it('anonymises financial records instead of deleting them, and cites the ground', () => {
    const plan = draftPlan(
      'DSR-1',
      [subject],
      [finding({ category: 'financial', locator: { kind: 'table', schema: 'public', table: 'invoices', predicate: 'customer_id = 4471' } })],
    );

    assert.equal(plan.actions[0]?.disposition, 'anonymise');
    assert.match(plan.actions[0]?.citation ?? '', /Art\.17\(3\)\(b\)/);
  });

  it('retains, without anonymising, data under an active legal hold', () => {
    const plan = draftPlan(
      'DSR-1',
      [subject],
      [finding({ locator: { kind: 'table', schema: 'public', table: 'legal_holds', predicate: 'subject_id = 4471' } })],
    );

    assert.equal(plan.actions[0]?.disposition, 'retain');
    assert.equal(plan.actions[0]?.irreversible, false);
  });

  it('escalates special category data rather than deciding by rule', () => {
    const plan = draftPlan('DSR-1', [subject], [finding({ category: 'special_category' })]);
    assert.equal(plan.actions[0]?.disposition, 'escalate');
  });

  it('starts as a draft, which is not approvable', () => {
    const plan = draftPlan('DSR-1', [subject], [finding()]);
    assert.equal(plan.status, 'draft');
    assert.throws(() => assertApprovable(plan), /not approvable/);
  });
});

describe('approvalBlockers', () => {
  it('blocks approval until the plan has been measured against a snapshot', () => {
    const plan = draftPlan('DSR-1', [subject], [finding()]);
    const blockers = approvalBlockers(plan);
    assert.ok(blockers.some((b) => /has not been measured/.test(b)));
  });

  it('clears once a clean simulation is attached', () => {
    const plan = withBlastRadius(draftPlan('DSR-1', [subject], [finding()]), cleanSimulation);
    assert.deepEqual(approvalBlockers(plan), []);
    assert.doesNotThrow(() => assertApprovable(plan));
  });

  it('blocks a plan that would break referential integrity', () => {
    const plan = withBlastRadius(draftPlan('DSR-1', [subject], [finding()]), {
      ...cleanSimulation,
      constraintViolations: [
        { constraint: 'order_items_customer_fk', table: 'order_items', affectedRows: 41 },
      ],
    });

    assert.ok(approvalBlockers(plan).some((b) => /constraint/.test(b)));
  });

  // The plan claims to erase the subject. If traces survive on the snapshot,
  // the claim is false and must not reach a signature.
  it('blocks a plan that leaves traces behind on the snapshot', () => {
    const plan = withBlastRadius(draftPlan('DSR-1', [subject], [finding()]), {
      ...cleanSimulation,
      residualTraces: 3,
    });

    assert.ok(approvalBlockers(plan).some((b) => /does not achieve erasure/.test(b)));
  });

  it('blocks while any finding still awaits a human decision', () => {
    const plan = withBlastRadius(
      draftPlan('DSR-1', [subject], [finding({ category: 'special_category' })]),
      cleanSimulation,
    );

    assert.ok(approvalBlockers(plan).some((b) => /human decision/.test(b)));
  });

  it('blocks an empty plan', () => {
    const plan = withBlastRadius(draftPlan('DSR-1', [subject], []), cleanSimulation);
    assert.ok(approvalBlockers(plan).some((b) => /no actions/.test(b)));
  });
});

describe('summarise', () => {
  it('counts records by disposition without double counting', () => {
    const plan = draftPlan('DSR-1', [subject], [
      finding({ id: 'f1', count: 10 }),
      finding({
        id: 'f2',
        count: 4,
        category: 'financial',
        locator: { kind: 'table', schema: 'public', table: 'invoices', predicate: 'customer_id = 4471' },
      }),
      finding({ id: 'f3', count: 2, category: 'special_category' }),
    ]);

    const summary = summarise(plan);

    assert.equal(summary.deleted, 10);
    assert.equal(summary.anonymised, 4);
    assert.equal(summary.escalated, 2);
    assert.equal(summary.totalRecords, 16);
  });

  it('counts only unrecoverable destruction as irreversible', () => {
    const plan = draftPlan('DSR-1', [subject], [
      finding({ id: 'f1', count: 10 }),
      finding({
        id: 'f2',
        count: 7,
        locator: { kind: 'table', schema: 'public', table: 'legal_holds', predicate: 'subject_id = 4471' },
      }),
    ]);

    assert.equal(irreversibleRecordCount(plan), 10);
  });
});
