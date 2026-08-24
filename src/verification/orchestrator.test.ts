import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_CONFIG, type AgentSpec } from '../agents/spec.ts';
import type { ToolCatalog, ToolDescriptor } from '../connectors/catalog.ts';
import { generateSubjectSalt, verifyChain, chainEvents } from '../domain/certificate.ts';
import type { Finding } from '../domain/finding.ts';
import type { Identifier } from '../domain/identity.ts';
import { IdentityGraph } from '../domain/identity.ts';
import { type BlastRadius, draftPlan, withBlastRadius } from '../domain/plan.ts';
import type { ReceivedEvent, TurnEvent, TurnInput } from '../harness/protocol.ts';
import type { Transport, TurnState } from '../harness/transport.ts';
import { CaseFile } from '../lifecycle/case-file.ts';
import { InMemoryLedgerStore, SuppressionLedger } from '../suppression/ledger.ts';
import { auditTrail, planDigest, runVerification, VerificationError } from './orchestrator.ts';

const RECEIVED = '2026-08-01T09:00:00.000Z';
const ROTATES = '2026-11-24T09:00:00.000Z';
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
  simulatedAt: RECEIVED,
};

/** A case walked all the way to `verifying`, as execution leaves it. */
function verifyingCase(findings: readonly Finding[] = [finding()]): CaseFile {
  const file = new CaseFile('DSR-118', RECEIVED);
  file.transition('discovering', 'identity verified');
  const graph = new IdentityGraph([subject], RECEIVED);
  file.recordIdentities(graph);
  file.transition('planning', 'discovery complete');
  file.transition('simulating', 'plan drafted');
  file.recordFindings(findings);
  file.recordPlan(withBlastRadius(draftPlan('DSR-118', [subject], findings), clean));
  file.transition('awaiting_approval', 'simulation clean');
  file.approve('acct_9f2');
  file.transition('verifying', 'execution complete');
  return file;
}

const scoutSpec: AgentSpec = {
  name: 'lethe-scout',
  model: 'test/model',
  instructions: 'sweep',
  mcpServers: [{ name: 'acme-postgres', enableTools: '@read-only' }],
  skills: [],
  config: BASE_CONFIG,
};

const read = (name: string): ToolDescriptor => ({ name, annotations: { readOnlyHint: true } });

function catalog(): ToolCatalog {
  return {
    async listTools(server) {
      if (server !== 'acme-postgres') throw new Error(`unknown connector ${server}`);
      return [read('query'), read('search')];
    },
  };
}

class ScriptedTransport implements Transport {
  #scripts: TurnEvent[][];

  constructor(scripts: TurnEvent[][]) {
    this.#scripts = [...scripts];
  }

  async *createTurn(_s: string, _input: readonly TurnInput[]): AsyncIterable<ReceivedEvent> {
    const script = this.#scripts.shift() ?? [];
    for (const [i, event] of script.entries()) yield { event, sequence: i + 1 };
  }

  async *subscribeToTurn(): AsyncIterable<ReceivedEvent> {}
  async *listTurnEvents(): AsyncIterable<ReceivedEvent> {}
  async getTurn(): Promise<TurnState> {
    return { turnId: 'turn-1', status: 'completed' };
  }
}

const created: TurnEvent = { type: 'turn.created', id: 'c1', turnId: 'turn-v' };
const doneOk: TurnEvent = { type: 'turn.done', id: 'd1', turnId: 'turn-v', status: 'completed' };

function reply(content: string): TurnEvent {
  return { type: 'model.message', id: 'msg-1', threadId: 'thread-1', content, toolCalls: [] };
}

const CLEAN_SWEEP = JSON.stringify({ findings: [] });

function residual(count: number): string {
  return JSON.stringify({
    findings: [
      {
        id: 'r1',
        system: 'acme-postgres',
        locator: { kind: 'table', schema: 'public', table: 'sessions', predicate: 'user_id = 4471' },
        category: 'behavioural',
        durability: 'hard_delete',
        count,
        matchedBy: { kind: 'user_id', value: '4471', system: 'acme-postgres' },
        observedAt: RECEIVED,
      },
    ],
  });
}

async function suppressedLedger(): Promise<SuppressionLedger> {
  const ledger = new SuppressionLedger({ store: new InMemoryLedgerStore(), salt: generateSubjectSalt() });
  await ledger.suppress(subject, 'DSR-118', ROTATES);
  return ledger;
}

function options(
  scripts: TurnEvent[][],
  overrides: Partial<Parameters<typeof runVerification>[0]> = {},
) {
  return {
    caseFile: verifyingCase(),
    transport: new ScriptedTransport(scripts),
    catalog: catalog(),
    scout: scoutSpec,
    sessionId: 'sess-1',
    ledger: new SuppressionLedger({ store: new InMemoryLedgerStore(), salt: generateSubjectSalt() }),
    subjectSalt: generateSubjectSalt(),
    ...overrides,
  };
}

describe('runVerification — clean sweep', () => {
  it('certifies, and the case ends certified', async () => {
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]], { ledger: await suppressedLedger() });

    const result = await runVerification(opts);

    assert.equal(result.kind, 'certified');
    assert.equal(opts.caseFile.state, 'certified');
    assert.ok(opts.caseFile.certificate);
  });

  it('derives the audit chain from the case history, and it verifies', async () => {
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]]);
    const result = await runVerification(opts);

    assert.equal(result.kind, 'certified');
    if (result.kind !== 'certified') return;

    const rebuilt = chainEvents(auditTrail(opts.caseFile));
    // The final transition (verifying -> certified) happened after issuance,
    // so the certificate's chain covers everything up to it.
    assert.equal(verifyChain(rebuilt).valid, true);
    assert.ok(result.certificate.eventCount >= 6);
  });

  it('names the approver from the case history', async () => {
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]]);
    const result = await runVerification(opts);

    assert.equal(result.kind === 'certified' && result.certificate.approval.approvedBy, 'acct_9f2');
  });

  it('carries the backup disclosure when the ledger holds suppressions', async () => {
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]], { ledger: await suppressedLedger() });
    const result = await runVerification(opts);

    assert.equal(result.kind === 'certified' && result.certificate.beyondUse?.identifiersSuppressed, 1);
  });

  it('records identifier kinds on the scope, never values', async () => {
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]]);
    const result = await runVerification(opts);

    assert.equal(result.kind, 'certified');
    if (result.kind !== 'certified') return;
    assert.deepEqual(result.certificate.scope.identifierKindsSearched, ['user_id']);
    assert.ok(!JSON.stringify(result.certificate).includes('4471'));
  });
});

describe('runVerification — compaction', () => {
  const vectorFinding = finding({
    id: 'f-vec',
    system: 'acme-postgres',
    durability: 'requires_compaction',
    locator: { kind: 'vector', index: 'support-tickets', documentIds: ['d1'] },
  });

  // The whole reason delete_and_compact exists: the delete alone leaves the
  // data reconstructible, so an unconfirmed compaction must not certify.
  it('refuses to certify a purge whose compaction was never confirmed', async () => {
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]], {
      caseFile: verifyingCase([vectorFinding]),
    });

    const error = await runVerification(opts).then(
      () => undefined,
      (e: unknown) => e as VerificationError,
    );

    assert.equal(error?.stage, 'certification');
    assert.match(error?.message ?? '', /remain recoverable/);
    assert.equal(opts.caseFile.state, 'failed');
  });

  it('certifies once the compaction is confirmed', async () => {
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]], {
      caseFile: verifyingCase([vectorFinding]),
      compactionsConfirmed: ['acme-postgres'],
    });

    const result = await runVerification(opts);
    assert.equal(result.kind, 'certified');
  });
});

describe('runVerification — residual traces', () => {
  // Not a failure: the system working. The verifying -> executing edge exists
  // for exactly this.
  it('loops the case back to executing with what remains', async () => {
    const opts = options([[created, reply(residual(3)), doneOk]]);

    const result = await runVerification(opts);

    assert.equal(result.kind, 'incomplete');
    assert.equal(result.kind === 'incomplete' && result.residualTraces, 3);
    assert.equal(opts.caseFile.state, 'executing');
    assert.match(opts.caseFile.history.at(-1)?.reason ?? '', /another pass is required/);
  });
});

describe('runVerification — refusals', () => {
  it('runs only from verifying', async () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]], { caseFile: file });

    await assert.rejects(runVerification(opts), /verification follows\s+execution/);
    assert.equal(file.state, 'received');
  });

  // A verifier that can delete is a verifier whose clean report proves nothing.
  it('refuses a sweep agent that holds anything writable', async () => {
    const opts = options([[created, reply(CLEAN_SWEEP), doneOk]], {
      catalog: {
        async listTools() {
          return [{ name: 'delete_rows', annotations: { readOnlyHint: true } }];
        },
      },
    });

    const error = await runVerification(opts).then(
      () => undefined,
      (e: unknown) => e as VerificationError,
    );

    assert.equal(error?.stage, 'verification');
    assert.equal(opts.caseFile.state, 'failed');
  });

  it('fails the case when the sweep turn dies', async () => {
    const opts = options([[created, { type: 'turn.done', id: 'd', turnId: 'turn-v', status: 'failed' }]]);

    const error = await runVerification(opts).then(
      () => undefined,
      (e: unknown) => e as VerificationError,
    );

    assert.equal(error?.stage, 'run');
    assert.equal(opts.caseFile.state, 'failed');
  });

  it('fails the case when the reply cannot be trusted', async () => {
    const opts = options([[created, reply('all clean, trust me'), doneOk]]);

    const error = await runVerification(opts).then(
      () => undefined,
      (e: unknown) => e as VerificationError,
    );

    assert.equal(error?.stage, 'parsing');
  });
});

describe('planDigest', () => {
  it('is stable regardless of action order', () => {
    const findings = [finding({ id: 'a' }), finding({ id: 'b', locator: { kind: 'table', schema: 'public', table: 'events', predicate: 'x' } })];
    const plan = draftPlan('DSR-118', [subject], findings);
    const reversed = { ...plan, actions: [...plan.actions].reverse() };

    assert.equal(planDigest(plan), planDigest(reversed));
  });

  it('changes when any disposition changes', () => {
    const plan = draftPlan('DSR-118', [subject], [finding()]);
    const altered = {
      ...plan,
      actions: plan.actions.map((a) => ({ ...a, disposition: 'retain' as const })),
    };

    assert.notEqual(planDigest(plan), planDigest(altered));
  });
});
