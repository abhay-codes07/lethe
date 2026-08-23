import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type AuditEvent,
  chainEvents,
  generateSubjectSalt,
  issueCertificate,
  referenceSubject,
} from '../domain/certificate.ts';
import type { Finding } from '../domain/finding.ts';
import type { Identifier } from '../domain/identity.ts';
import { type BlastRadius, draftPlan, withBlastRadius } from '../domain/plan.ts';
import type { ApprovalRequest } from '../harness/turn-runner.ts';
import { CaseFile, isTerminal, type CaseState } from './case-file.ts';

const RECEIVED = '2026-08-01T09:00:00.000Z';
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
    observedAt: RECEIVED,
    ...overrides,
  };
}

const clean: BlastRadius = {
  constraintViolations: [],
  orphanedRecords: 0,
  residualTraces: 0,
  snapshotId: 'snap-7',
  simulatedAt: '2026-08-02T09:00:00.000Z',
};

function simulatedPlan(requestId = 'DSR-118', findings: readonly Finding[] = [finding()]) {
  return withBlastRadius(draftPlan(requestId, [subject], findings), clean);
}

/** Walk a fresh case file to `awaiting_approval` with a signable plan. */
function awaitingApproval(findings: readonly Finding[] = [finding()]): CaseFile {
  const file = new CaseFile('DSR-118', RECEIVED);
  file.transition('discovering', 'identity verified');
  file.transition('planning', 'discovery complete');
  file.transition('simulating', 'plan drafted');
  file.recordFindings(findings);
  file.recordPlan(simulatedPlan('DSR-118', findings));
  file.transition('awaiting_approval', 'simulation clean');
  return file;
}

function callRequest(table: string): ApprovalRequest {
  return {
    threadId: 'thread-1',
    toolCallId: `call-${table}`,
    call: {
      complete: true,
      id: `call-${table}`,
      name: 'delete_rows',
      serverName: 'acme-postgres',
      arguments: { schema: 'public', table },
    },
  };
}

describe('CaseFile transitions', () => {
  it('starts received, with a month to respond', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    assert.equal(file.state, 'received');
    assert.equal(file.deadline.dueAt, '2026-08-31T09:00:00.000Z');
  });

  it('records why each move happened', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    file.transition('discovering', 'identity verified', '2026-08-01T10:00:00.000Z');

    assert.deepEqual(file.history[0], {
      from: 'received',
      to: 'discovering',
      at: '2026-08-01T10:00:00.000Z',
      reason: 'identity verified',
    });
  });

  it('refuses a move with no reason, since the history is evidence', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    assert.throws(() => file.transition('discovering', '   '), /needs a reason/);
  });

  // The single most important thing this class prevents.
  it('refuses to execute without passing through approval', () => {
    const file = awaitingApproval();
    assert.throws(() => file.transition('certified', 'skip ahead'), /cannot move from/);
  });

  it('refuses to certify straight from executing, before the sweep', () => {
    const file = awaitingApproval();
    file.approve('acct_9f2');

    assert.throws(() => file.transition('certified', 'assume it worked'), /cannot move from/);
  });

  it('lets discovery loop when a weak identity link is confirmed', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    file.transition('discovering', 'identity verified');
    assert.doesNotThrow(() => file.transition('discovering', 'subject confirmed a second account'));
  });

  it('lets simulation send a plan back when the blast radius forces a change', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    file.transition('discovering', 'identity verified');
    file.transition('planning', 'discovery complete');
    file.transition('simulating', 'plan drafted');

    assert.doesNotThrow(() =>
      file.transition('planning', 'FK violation on order_items forces anonymisation'),
    );
  });

  it('lets verification send execution back when traces survived', () => {
    const file = awaitingApproval();
    file.approve('acct_9f2');
    file.transition('verifying', 'execution complete');

    assert.doesNotThrow(() => file.transition('executing', '3 traces remained in the vector index'));
  });

  // Reopening a refused request would let it be quietly restarted without a
  // fresh decision.
  it('treats rejection as terminal', () => {
    const file = awaitingApproval();
    file.reject('acct_9f2', 'identity not verified');

    assert.equal(isTerminal(file.state), true);
    assert.throws(() => file.transition('planning', 'try again'), /is terminal/);
  });

  it('treats certification as terminal', () => {
    const states: CaseState[] = ['rejected', 'certified', 'failed'];
    for (const state of states) {
      assert.equal(isTerminal(state), true, `${state} should be terminal`);
    }
  });
});

describe('CaseFile.approve', () => {
  it('moves to executing and records who signed', () => {
    const file = awaitingApproval();
    file.approve('acct_9f2');

    assert.equal(file.state, 'executing');
    assert.match(file.history.at(-1)?.reason ?? '', /approved by acct_9f2/);
  });

  it('refuses approval from any state but awaiting_approval', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    assert.throws(() => file.approve('acct_9f2'), /only a request awaiting approval/);
  });

  // The card and the signature can be separated by days and a restart, and the
  // plan may have been replaced in between.
  it('re-checks the plan rather than trusting whoever rendered the card', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    file.transition('discovering', 'identity verified');
    file.transition('planning', 'discovery complete');
    file.transition('simulating', 'plan drafted');
    file.recordFindings([finding()]);
    file.recordPlan(simulatedPlan());
    file.transition('awaiting_approval', 'simulation clean');

    // A plan swapped for an unsimulated one after the card was shown.
    file.recordPlan(draftPlan('DSR-118', [subject], [finding()]));

    assert.throws(() => file.approve('acct_9f2'), /no longer approvable/);
  });

  it('refuses to attach a plan belonging to another request', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    assert.throws(() => file.recordPlan(simulatedPlan('DSR-999')), /wrong person's data/);
  });
});

describe('CaseFile.reject', () => {
  it('requires a reason, because the subject is entitled to one', () => {
    const file = awaitingApproval();
    assert.throws(() => file.reject('acct_9f2', ''), /needs a reason/);
  });

  it('keeps the reason in the history', () => {
    const file = awaitingApproval();
    file.reject('acct_9f2', 'identity not verified');

    assert.match(file.history.at(-1)?.reason ?? '', /identity not verified/);
  });
});

describe('CaseFile.authoriseCalls', () => {
  it('authorises calls covered by the signed plan', () => {
    const file = awaitingApproval();
    file.approve('acct_9f2');

    assert.equal(file.authoriseCalls([callRequest('sessions')]).kind, 'authorised');
  });

  it('flags a call the plan does not cover', () => {
    const file = awaitingApproval();
    file.approve('acct_9f2');

    assert.equal(file.authoriseCalls([callRequest('audit_log')]).kind, 'scope_violation');
  });

  // Answering confidently about an authority that does not exist is worse than
  // refusing to answer.
  it('refuses to check scope before anyone approved the plan', () => {
    const file = awaitingApproval();
    assert.throws(
      () => file.authoriseCalls([callRequest('sessions')]),
      /only be authorised while executing/,
    );
  });
});

describe('CaseFile.recordCertificate', () => {
  function certificate(requestId = 'DSR-118') {
    const events: AuditEvent[] = [
      { sequence: 1, type: 'tool.response', at: RECEIVED, detail: { rows: 10 } },
    ];
    return issueCertificate({
      requestId,
      subject: referenceSubject('ada@example.com', generateSubjectSalt()),
      entries: [
        {
          system: 'acme-postgres',
          location: 'public.sessions',
          disposition: 'delete',
          recordsAffected: 10,
          justification: 'No retention ground applies.',
          irrecoverable: true,
        },
      ],
      approval: { approvedBy: 'acct_9f2', approvedAt: RECEIVED, planDigest: 'abc' },
      verification: {
        rediscoveredAt: RECEIVED,
        systemsSwept: ['acme-postgres'],
        residualTraces: 0,
        compactionsConfirmed: [],
      },
      scope: {
        systemsDeclared: ['acme-postgres'],
        systemsExcluded: [],
        identifierKindsSearched: ['user_id'],
        identifierCount: 1,
      },
      events: chainEvents(events),
    });
  }

  it('certifies from verifying and becomes terminal', () => {
    const file = awaitingApproval();
    file.approve('acct_9f2');
    file.transition('verifying', 'execution complete');
    file.recordCertificate(certificate());

    assert.equal(file.state, 'certified');
    assert.ok(file.certificate);
  });

  it('refuses a certificate before the verification sweep has run', () => {
    const file = awaitingApproval();
    file.approve('acct_9f2');

    assert.throws(() => file.recordCertificate(certificate()), /only be issued from verifying/);
  });

  it('refuses a certificate belonging to another request', () => {
    const file = awaitingApproval();
    file.approve('acct_9f2');
    file.transition('verifying', 'execution complete');

    assert.throws(() => file.recordCertificate(certificate('DSR-999')), /not DSR-118/);
  });
});

describe('CaseFile deadline', () => {
  it('counts down whole days', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    assert.equal(file.daysRemaining('2026-08-21T09:00:00.000Z'), 10);
  });

  it('goes negative once the statutory month has passed', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    assert.equal(file.isOverdue('2026-09-05T09:00:00.000Z'), true);
  });

  // The obligation was discharged when the request was answered.
  it('does not call a finished request overdue', () => {
    const file = awaitingApproval();
    file.reject('acct_9f2', 'identity not verified');

    assert.equal(file.isOverdue('2026-12-01T09:00:00.000Z'), false);
  });

  it('extends by whole months with a reason', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    file.extendDeadline(1, 'nine systems, two under legal hold');

    assert.equal(file.deadline.dueAt, '2026-09-30T09:00:00.000Z');
    assert.equal(file.deadline.extensions.length, 1);
  });

  // A cap that only exists in a comment is a cap that gets exceeded.
  it('refuses to extend beyond the two-month statutory maximum', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    file.extendDeadline(2, 'complex');

    assert.throws(() => file.extendDeadline(1, 'more complex'), /statutory maximum/);
  });

  it('refuses a fractional or zero extension', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    assert.throws(() => file.extendDeadline(0.5, 'half a month'), /whole number of months/);
    assert.throws(() => file.extendDeadline(0, 'none'), /whole number of months/);
  });

  it('refuses an extension with no reason to communicate', () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    assert.throws(() => file.extendDeadline(1, ''), /needs a reason/);
  });
});
