import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Finding } from './finding.ts';
import type { Identifier } from './identity.ts';
import {
  type BlastRadius,
  draftPlan,
  markUnerasable,
  summarise,
  withBlastRadius,
} from './plan.ts';
import { renderPlanCard, formatPlanCard } from '../review/plan-card.ts';
import { reconcile } from '../review/reconcile.ts';
import type { ApprovalRequest } from '../harness/turn-runner.ts';

const NOW = '2026-08-24T09:00:00.000Z';
const subject: Identifier = { kind: 'user_id', value: '4471', system: 'acme-postgres' };

const remediation = {
  action: 'support-classifier-v4 retrained without the subject data',
  plannedAt: '2026-11-01T00:00:00.000Z',
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-weights',
    system: 'acme-vectors',
    locator: { kind: 'vector', index: 'support-tickets', documentIds: ['d1'] },
    category: 'derived',
    durability: 'immutable_until_expiry',
    count: 1,
    matchedBy: subject,
    observedAt: NOW,
    ...overrides,
  };
}

const clean: BlastRadius = {
  constraintViolations: [],
  orphanedRecords: 0,
  residualTraces: 0,
  snapshotId: 'snap-1',
  simulatedAt: NOW,
};

describe('markUnerasable', () => {
  it('converts the action into a disclosure with basis and remediation', () => {
    const plan = markUnerasable(
      draftPlan('DSR-118', [subject], [finding()]),
      'f-weights',
      'Data is present in fine-tuned model weights; unlearning is not reliable.',
      remediation,
      NOW,
    );

    const action = plan.actions[0];
    assert.equal(action?.disposition, 'unerasable');
    assert.equal(action?.irreversible, false);
    assert.equal(action?.remediation?.plannedAt, remediation.plannedAt);
    assert.equal(summarise(plan).unerasable, 1);
  });

  // The blast radius was measured for a different set of actions; carrying it
  // forward lets a person sign figures that no longer describe the plan.
  it('demotes a simulated plan back to draft', () => {
    const simulated = withBlastRadius(draftPlan('DSR-118', [subject], [finding()]), clean);
    const plan = markUnerasable(simulated, 'f-weights', 'in model weights', remediation, NOW);

    assert.equal(plan.status, 'draft');
  });

  it('needs a basis — it is a disclosure, not a shrug', () => {
    assert.throws(
      () => markUnerasable(draftPlan('DSR-118', [subject], [finding()]), 'f-weights', '  ', remediation, NOW),
      /needs a basis/,
    );
  });

  // A past remediation date claims the data is already gone, which contradicts
  // marking it unerasable in the same breath.
  it('rejects a remediation planned for the past', () => {
    assert.throws(
      () =>
        markUnerasable(
          draftPlan('DSR-118', [subject], [finding()]),
          'f-weights',
          'in weights',
          { action: 'retrain', plannedAt: '2026-01-01T00:00:00.000Z' },
          NOW,
        ),
      /future date/,
    );
  });

  it('rejects an unknown finding', () => {
    assert.throws(
      () => markUnerasable(draftPlan('DSR-118', [subject], [finding()]), 'ghost', 'x', remediation, NOW),
      /no action for finding ghost/,
    );
  });

  it('refuses to edit a plan that has already been approved', () => {
    const approved = { ...withBlastRadius(draftPlan('DSR-118', [subject], [finding()]), clean), status: 'approved' as const };
    assert.throws(
      () => markUnerasable(approved, 'f-weights', 'x', remediation, NOW),
      /before approval, not after/,
    );
  });
});

describe('unerasable on the card', () => {
  function cardFor() {
    const f = finding();
    const plan = withBlastRadius(
      markUnerasable(draftPlan('DSR-118', [subject], [f]), 'f-weights', 'Data is in model weights.', remediation, NOW),
      clean,
    );
    const result = renderPlanCard(plan, [f]);
    assert.equal(result.kind, 'renderable');
    return result.kind === 'renderable' ? result.card : undefined;
  }

  it('labels the line UNERASABLE and shows the committed way out', () => {
    const text = formatPlanCard(cardFor()!);
    assert.match(text, /UNERASABLE/);
    assert.match(text, /Remediation: support-classifier-v4 retrained without the subject data by 2026-11-01/);
  });

  it('sorts the disclosure above routine retentions', () => {
    const f1 = finding({ id: 'f-weights' });
    const f2 = finding({
      id: 'f-hold',
      system: 'acme-postgres',
      category: 'behavioural',
      durability: 'hard_delete',
      locator: { kind: 'table', schema: 'public', table: 'legal_holds', predicate: 'x' },
    });
    const plan = withBlastRadius(
      markUnerasable(draftPlan('DSR-118', [subject], [f1, f2]), 'f-weights', 'in weights', remediation, NOW),
      clean,
    );
    const result = renderPlanCard(plan, [f1, f2]);
    assert.equal(result.kind, 'renderable');
    if (result.kind !== 'renderable') return;

    const order = result.card.lines.map((l) => l.disposition);
    assert.ok(order.indexOf('unerasable') < order.indexOf('retain'), order.join(','));
  });
});

describe('unerasable at the execution boundary', () => {
  // The disposition exists because no tool call can erase this. A call that
  // claims to is therefore wrong about something, and must not be authorised.
  it('treats a tool call against unerasable data as a scope violation', () => {
    const f = finding();
    const plan = withBlastRadius(
      markUnerasable(draftPlan('DSR-118', [subject], [f]), 'f-weights', 'in weights', remediation, NOW),
      clean,
    );

    const request: ApprovalRequest = {
      threadId: 'thread-1',
      toolCallId: 'call-1',
      call: {
        complete: true,
        id: 'call-1',
        name: 'delete_vectors',
        serverName: 'acme-vectors',
        arguments: { index: 'support-tickets' },
      },
    };

    const result = reconcile(plan, [f], [request]);
    assert.equal(result.kind, 'scope_violation');
    assert.equal(result.kind === 'scope_violation' && result.unauthorised[0]?.reason, 'outside_plan');
  });
});
