import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_CONFIG, type AgentSpec } from '../agents/spec.ts';
import type { ToolCatalog, ToolDescriptor } from '../connectors/catalog.ts';
import { generateSubjectSalt, verifyChain, chainEvents } from '../domain/certificate.ts';
import type { Identifier } from '../domain/identity.ts';
import { draftPlan, withBlastRadius } from '../domain/plan.ts';
import { runDiscovery } from '../discovery/orchestrator.ts';
import { runExecution } from '../execution/orchestrator.ts';
import type { ReceivedEvent, TurnEvent, TurnInput } from '../harness/protocol.ts';
import type { Transport, TurnState } from '../harness/transport.ts';
import { renderPlanCard } from '../review/plan-card.ts';
import { InMemoryLedgerStore, SuppressionLedger } from '../suppression/ledger.ts';
import { auditTrail, runVerification } from '../verification/orchestrator.ts';
import { CaseFile } from './case-file.ts';

/**
 * The whole loop, request to certificate, against scripted turns.
 *
 * Every orchestrator is tested in isolation elsewhere. This exists because
 * the loop is the product, and the seams — discovery's findings feeding the
 * plan, the approval unlocking execution, execution's suppressions surfacing
 * on the certificate — are exactly where isolated tests prove nothing.
 */

const ROTATES = '2026-11-24T09:00:00.000Z';
const seed: Identifier = { kind: 'email', value: 'ada@example.invalid', system: 'acme-postgres' };

const read = (name: string): ToolDescriptor => ({ name, annotations: { readOnlyHint: true } });
const write = (name: string): ToolDescriptor => ({ name, annotations: { destructiveHint: true } });

const scout: AgentSpec = {
  name: 'lethe-scout',
  model: 'test/model',
  instructions: 'find',
  mcpServers: [{ name: 'acme-postgres', enableTools: '@read-only' }],
  skills: [],
  config: BASE_CONFIG,
};

const executor: AgentSpec = {
  name: 'lethe-executor',
  model: 'test/model',
  instructions: 'execute',
  mcpServers: [
    { name: 'acme-postgres', enableTools: ['query', 'delete_rows'], requireApprovalForTools: ['delete_rows'] },
  ],
  skills: [],
  config: { ...BASE_CONFIG, subAgents: { enabled: false } },
};

const catalog: ToolCatalog = {
  async listTools(server) {
    if (server !== 'acme-postgres') throw new Error(`unknown connector ${server}`);
    return [read('query'), write('delete_rows')];
  },
};

class ScriptedTransport implements Transport {
  readonly inputs: TurnInput[][] = [];
  #scripts: TurnEvent[][];

  constructor(scripts: TurnEvent[][]) {
    this.#scripts = [...scripts];
  }

  async *createTurn(_s: string, input: readonly TurnInput[]): AsyncIterable<ReceivedEvent> {
    this.inputs.push([...input]);
    const script = this.#scripts.shift() ?? [];
    for (const [i, event] of script.entries()) yield { event, sequence: i + 1 };
  }

  async *subscribeToTurn(): AsyncIterable<ReceivedEvent> {}
  async *listTurnEvents(): AsyncIterable<ReceivedEvent> {}
  async getTurn(): Promise<TurnState> {
    return { turnId: 'turn-1', status: 'completed' };
  }
}

const created: TurnEvent = { type: 'turn.created', id: 'c1', turnId: 'turn-1' };
const doneOk: TurnEvent = { type: 'turn.done', id: 'd1', turnId: 'turn-1', status: 'completed' };
const donePaused: TurnEvent = { type: 'turn.done', id: 'd0', turnId: 'turn-1', status: 'paused' };

const reply = (content: string): TurnEvent => ({
  type: 'model.message',
  id: `msg-${content.length}`,
  threadId: 'thread-1',
  content,
  toolCalls: [],
});

const DISCOVERED = JSON.stringify({
  findings: [
    {
      id: 'f-sessions',
      system: 'acme-postgres',
      locator: { kind: 'table', schema: 'public', table: 'sessions', predicate: 'email = $1' },
      category: 'behavioural',
      durability: 'hard_delete',
      count: 3,
      matchedBy: { kind: 'email', value: 'ada@example.invalid', system: 'acme-postgres' },
      observedAt: '2026-08-24T09:00:00.000Z',
    },
  ],
});

describe('the whole loop', () => {
  it('walks one request from received to certified', async () => {
    const caseFile = new CaseFile('DSR-1', '2026-08-20T09:00:00.000Z');
    const ledger = new SuppressionLedger({ store: new InMemoryLedgerStore(), salt: generateSubjectSalt() });

    // 1 — discovery fans out and comes back with findings.
    const discovery = await runDiscovery({
      caseFile,
      transport: new ScriptedTransport([[created, reply(DISCOVERED), doneOk]]),
      catalog,
      scout,
      sessionId: 'sess-1',
      seeds: [seed],
      responder: { answer: async () => { throw new Error('no questions expected'); } },
    });
    assert.equal(caseFile.state, 'planning');

    // 2 — plan, simulate, and render the card a person will sign.
    let plan = draftPlan('DSR-1', [seed], discovery.findings);
    caseFile.transition('simulating', 'plan drafted');
    plan = withBlastRadius(plan, {
      constraintViolations: [],
      orphanedRecords: 0,
      residualTraces: 0,
      snapshotId: 'snap-e2e',
      simulatedAt: '2026-08-24T09:05:00.000Z',
    });
    caseFile.recordPlan(plan);

    const card = renderPlanCard(plan, discovery.findings);
    assert.equal(card.kind, 'renderable');

    // 3 — the human gate.
    caseFile.transition('awaiting_approval', 'simulation clean');
    caseFile.approve('acct_9f2');

    // 4 — execution: the gated delete reconciles against the plan and is
    // allowed mechanically; the identifier lands on the suppression ledger.
    const execution = await runExecution({
      caseFile,
      transport: new ScriptedTransport([
        [
          created,
          {
            type: 'model.message',
            id: 'msg-x',
            threadId: 'thread-1',
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                toolInfo: { name: 'delete_rows', serverName: 'acme-postgres' },
                arguments: '{"schema":"public","table":"sessions"}',
              },
            ],
          },
          { type: 'tool.approval_required', id: 'p1', threadId: 'thread-1', toolCalls: [{ id: 'call-1', sourceEventId: 'msg-x' }] },
          donePaused,
        ],
        [created, doneOk],
      ]),
      catalog,
      executor,
      sessionId: 'sess-1',
      ledger,
      backupRotatesAt: ROTATES,
    });
    assert.equal(execution.callsAuthorised, 1);
    assert.equal(await ledger.isSuppressed(seed), true);
    assert.equal(caseFile.state, 'verifying');

    // 5 — verification sweeps clean and the certificate is issued.
    const verification = await runVerification({
      caseFile,
      transport: new ScriptedTransport([[created, reply('{"findings":[]}'), doneOk]]),
      catalog,
      scout,
      sessionId: 'sess-1',
      ledger,
      subjectSalt: generateSubjectSalt(),
    });

    assert.equal(verification.kind, 'certified');
    assert.equal(caseFile.state, 'certified');
    if (verification.kind !== 'certified') return;

    const certificate = verification.certificate;

    // The seams, checked end to end:
    // discovery's finding became the certificate's entry —
    assert.equal(certificate.entries[0]?.recordsAffected, 3);
    // — the approval that unlocked execution is the one attested —
    assert.equal(certificate.approval.approvedBy, 'acct_9f2');
    // — execution's suppression became the backup disclosure —
    assert.equal(certificate.beyondUse?.identifiersSuppressed, 1);
    assert.equal(certificate.beyondUse?.finalRotationAt, ROTATES);
    // — and nothing on the retained document names the subject.
    assert.ok(!JSON.stringify(certificate).includes('ada@example.invalid'));

    // The audit chain over the case's own history still verifies.
    assert.equal(verifyChain(chainEvents(auditTrail(caseFile))).valid, true);
  });

  it('a residual trace loops the case back instead of certifying', async () => {
    const caseFile = new CaseFile('DSR-2', '2026-08-20T09:00:00.000Z');
    const ledger = new SuppressionLedger({ store: new InMemoryLedgerStore(), salt: generateSubjectSalt() });

    const discovery = await runDiscovery({
      caseFile,
      transport: new ScriptedTransport([[created, reply(DISCOVERED.replace('DSR-1', 'DSR-2')), doneOk]]),
      catalog,
      scout,
      sessionId: 'sess-2',
      seeds: [seed],
      responder: { answer: async () => { throw new Error('no questions expected'); } },
    });

    caseFile.transition('simulating', 'plan drafted');
    caseFile.recordPlan(
      withBlastRadius(draftPlan('DSR-2', [seed], discovery.findings), {
        constraintViolations: [],
        orphanedRecords: 0,
        residualTraces: 0,
        snapshotId: 'snap-e2e',
        simulatedAt: '2026-08-24T09:05:00.000Z',
      }),
    );
    caseFile.transition('awaiting_approval', 'simulation clean');
    caseFile.approve('acct_9f2');

    await runExecution({
      caseFile,
      transport: new ScriptedTransport([[created, doneOk]]),
      catalog,
      executor,
      sessionId: 'sess-2',
      ledger,
      backupRotatesAt: ROTATES,
    });

    const verification = await runVerification({
      caseFile,
      transport: new ScriptedTransport([[created, reply(DISCOVERED), doneOk]]),
      catalog,
      scout,
      sessionId: 'sess-2',
      ledger,
      subjectSalt: generateSubjectSalt(),
    });

    assert.equal(verification.kind, 'incomplete');
    assert.equal(caseFile.state, 'executing');
    assert.equal(caseFile.certificate, undefined);
  });
});
