import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Finding } from '../domain/finding.ts';
import type { Identifier } from '../domain/identity.ts';
import { type BlastRadius, draftPlan, withBlastRadius } from '../domain/plan.ts';
import type { ResolvedToolCall } from '../harness/event-index.ts';
import type { ApprovalRequest } from '../harness/turn-runner.ts';
import { explainUnauthorised, reconcile, scopeKeyForCall } from './reconcile.ts';

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

function planFor(findings: readonly Finding[]) {
  return withBlastRadius(draftPlan('DSR-118', [subject], findings), clean);
}

function request(call: Partial<ResolvedToolCall> & { name: string }): ApprovalRequest {
  return {
    threadId: 'thread-1',
    toolCallId: call.id ?? 'call-1',
    call: {
      complete: true,
      id: call.id ?? 'call-1',
      name: call.name,
      serverName: call.serverName ?? 'acme-postgres',
      arguments: call.arguments ?? {},
    },
  };
}

describe('scopeKeyForCall', () => {
  it('identifies the table a deletion would touch', () => {
    const key = scopeKeyForCall({
      complete: true,
      id: 'c',
      name: 'delete_rows',
      serverName: 'acme-postgres',
      arguments: { schema: 'public', table: 'sessions' },
    });

    assert.equal(key, 'acme-postgres:table:public.sessions');
  });

  // A bare name and a qualified one must not produce different keys, or the
  // same target reconciles inconsistently depending on how it was written.
  it('treats a schema-qualified table name as the same target', () => {
    const bare = scopeKeyForCall({
      complete: true, id: 'c', name: 'delete_rows', serverName: 'acme-postgres',
      arguments: { table: 'sessions' },
    });
    const qualified = scopeKeyForCall({
      complete: true, id: 'c', name: 'delete_rows', serverName: 'acme-postgres',
      arguments: { table: 'public.sessions' },
    });

    assert.equal(bare, qualified);
  });

  it('cannot scope a call with no server', () => {
    assert.equal(
      scopeKeyForCall({ complete: true, id: 'c', name: 'delete_rows', arguments: { table: 'x' } }),
      undefined,
    );
  });

  it('cannot scope a tool it has no rule for', () => {
    assert.equal(
      scopeKeyForCall({
        complete: true, id: 'c', name: 'truncate_everything', serverName: 'acme-postgres',
        arguments: { table: 'x' },
      }),
      undefined,
    );
  });
});

describe('reconcile', () => {
  it('authorises a call that matches a line in the signed plan', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [
      request({ name: 'delete_rows', arguments: { schema: 'public', table: 'sessions' } }),
    ]);

    assert.equal(result.kind, 'authorised');
    assert.equal(result.kind === 'authorised' && result.calls[0]?.action.disposition, 'delete');
  });

  // The whole point. An instruction not to widen scope is not a control.
  it('refuses a call against a table no line in the plan covers', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [
      request({ name: 'delete_rows', arguments: { schema: 'public', table: 'audit_log' } }),
    ]);

    assert.equal(result.kind, 'scope_violation');
    if (result.kind !== 'scope_violation') return;
    assert.equal(result.unauthorised[0]?.reason, 'outside_plan');
    assert.equal(result.unauthorised[0]?.scope, 'acme-postgres:table:public.audit_log');
  });

  // Retained data is data the plan explicitly decided to keep, so a call
  // against it is a violation, not an authorised action.
  it('refuses a call against data the plan decided to retain', () => {
    const findings = [
      finding({ locator: { kind: 'table', schema: 'public', table: 'legal_holds', predicate: 'x' } }),
    ];
    const result = reconcile(planFor(findings), findings, [
      request({ name: 'delete_rows', arguments: { schema: 'public', table: 'legal_holds' } }),
    ]);

    assert.equal(result.kind, 'scope_violation');
    assert.equal(result.kind === 'scope_violation' && result.unauthorised[0]?.reason, 'outside_plan');
  });

  it('refuses a call against data escalated for human decision', () => {
    const findings = [finding({ category: 'special_category' })];
    const result = reconcile(planFor(findings), findings, [
      request({ name: 'delete_rows', arguments: { schema: 'public', table: 'sessions' } }),
    ]);

    assert.equal(result.kind, 'scope_violation');
  });

  // Fail closed: an unknown tool cannot be checked, so it cannot be trusted.
  it('refuses a tool it has no scoping rule for', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [
      request({ name: 'run_arbitrary_sql', arguments: { table: 'sessions' } }),
    ]);

    assert.equal(result.kind === 'scope_violation' && result.unauthorised[0]?.reason, 'unrecognised_tool');
  });

  it('refuses a call whose arguments do not identify a target', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [
      request({ name: 'delete_rows', arguments: {} }),
    ]);

    assert.equal(
      result.kind === 'scope_violation' && result.unauthorised[0]?.reason,
      'unscopeable_arguments',
    );
  });

  it('refuses a call whose arguments never finished streaming', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [
      {
        threadId: 'thread-1',
        toolCallId: 'call-1',
        call: { complete: false, id: 'call-1', reason: 'incomplete_arguments', raw: '{"table":' },
      },
    ]);

    assert.equal(result.kind === 'scope_violation' && result.unauthorised[0]?.reason, 'unresolved_call');
  });

  // One bad call taints the batch: approving the rest would let a run proceed
  // that had already tried to exceed its authority.
  it('reports a violation even when other calls in the batch are fine', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [
      request({ id: 'ok', name: 'delete_rows', arguments: { table: 'sessions' } }),
      request({ id: 'bad', name: 'delete_rows', arguments: { table: 'audit_log' } }),
    ]);

    assert.equal(result.kind, 'scope_violation');
    if (result.kind !== 'scope_violation') return;
    assert.equal(result.authorised.length, 1);
    assert.equal(result.unauthorised.length, 1);
  });

  it('matches across systems, not just Postgres', () => {
    const findings = [
      finding({
        id: 'f-obj',
        system: 'acme-s3',
        locator: { kind: 'object', bucket: 'acme-exports', key: 'users/4471.json' },
      }),
    ];

    const result = reconcile(planFor(findings), findings, [
      request({
        name: 'delete_object',
        serverName: 'acme-s3',
        arguments: { bucket: 'acme-exports', key: 'users/4471.json' },
      }),
    ]);

    assert.equal(result.kind, 'authorised');
  });

  it('does not match the right key in the wrong system', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [
      request({ name: 'delete_rows', serverName: 'acme-warehouse', arguments: { table: 'sessions' } }),
    ]);

    assert.equal(result.kind, 'scope_violation');
  });
});

describe('explainUnauthorised', () => {
  it('names what the call would have touched', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [
      request({ name: 'delete_rows', arguments: { table: 'audit_log' } }),
    ]);

    assert.equal(result.kind, 'scope_violation');
    if (result.kind !== 'scope_violation') return;

    const text = explainUnauthorised(result.unauthorised[0]!);
    assert.match(text, /public\.audit_log/);
    assert.match(text, /whole of the authority/);
  });

  it('says an unrecognised tool was refused rather than assumed harmless', () => {
    const findings = [finding()];
    const result = reconcile(planFor(findings), findings, [request({ name: 'mystery_tool' })]);

    assert.equal(result.kind, 'scope_violation');
    if (result.kind !== 'scope_violation') return;
    assert.match(explainUnauthorised(result.unauthorised[0]!), /assumed harmless/);
  });
});

describe('execute_sql scope from raw SQL', () => {
  // Observed live: SQL-shaped servers take {sql}, not {table}.
  it('reads a single write target out of the statement', () => {
    const key = scopeKeyForCall({
      complete: true, id: 'c', name: 'execute_sql', serverName: 'acme-postgres',
      arguments: { sql: 'DELETE FROM public.sessions WHERE user_id IN (SELECT id FROM users)' },
    });
    assert.equal(key, 'acme-postgres:table:public.sessions');
  });

  it('qualifies a bare table with the default schema', () => {
    const key = scopeKeyForCall({
      complete: true, id: 'c', name: 'execute_sql', serverName: 'acme-postgres',
      arguments: { sql: 'UPDATE users SET full_name = NULL WHERE id = 4471' },
    });
    assert.equal(key, 'acme-postgres:table:public.users');
  });

  // Several targets, or none recognisable, stay unscopeable and fail closed.
  it('refuses to scope a statement touching two tables', () => {
    const key = scopeKeyForCall({
      complete: true, id: 'c', name: 'execute_sql', serverName: 'acme-postgres',
      arguments: { sql: 'DELETE FROM sessions; DELETE FROM orders' },
    });
    assert.equal(key, undefined);
  });
});
