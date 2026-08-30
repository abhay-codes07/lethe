import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_CONFIG, type AgentSpec } from '../agents/spec.ts';
import type { ToolCatalog, ToolDescriptor } from '../connectors/catalog.ts';
import { generateSubjectSalt } from '../domain/certificate.ts';
import type { Finding } from '../domain/finding.ts';
import type { Identifier } from '../domain/identity.ts';
import { type BlastRadius, draftPlan, withBlastRadius } from '../domain/plan.ts';
import type { ReceivedEvent, TurnEvent, TurnInput } from '../harness/protocol.ts';
import type { Transport, TurnState } from '../harness/transport.ts';
import { CaseFile } from '../lifecycle/case-file.ts';
import { InMemoryLedgerStore, SuppressionLedger } from '../suppression/ledger.ts';
import { ExecutionError, runExecution } from './orchestrator.ts';

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

/** A case file walked to `executing`, the only state execution accepts. */
function executingCase(findings: readonly Finding[] = [finding()]): CaseFile {
  const file = new CaseFile('DSR-118', RECEIVED);
  file.transition('discovering', 'identity verified');
  file.transition('planning', 'discovery complete');
  file.transition('simulating', 'plan drafted');
  file.recordFindings(findings);
  file.recordPlan(withBlastRadius(draftPlan('DSR-118', [subject], findings), clean));
  file.transition('awaiting_approval', 'simulation clean');
  file.approve('acct_9f2');
  return file;
}

const executorSpec: AgentSpec = {
  name: 'lethe-executor',
  model: 'test/model',
  instructions: 'execute',
  mcpServers: [
    {
      name: 'acme-postgres',
      enableTools: ['query', 'delete_rows', 'anonymise_rows'],
      requireApprovalForTools: ['delete_rows', 'anonymise_rows'],
    },
  ],
  skills: [],
  config: { ...BASE_CONFIG, subAgents: { enabled: false } },
};

const read = (name: string): ToolDescriptor => ({ name, annotations: { readOnlyHint: true } });
const write = (name: string): ToolDescriptor => ({ name, annotations: { destructiveHint: true } });

function catalog(): ToolCatalog {
  return {
    async listTools(server) {
      if (server !== 'acme-postgres') throw new Error(`unknown connector ${server}`);
      return [read('query'), write('delete_rows'), write('anonymise_rows')];
    },
  };
}

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
const donePaused: TurnEvent = { type: 'turn.done', id: 'd0', turnId: 'turn-1', status: 'paused' };
const doneOk: TurnEvent = { type: 'turn.done', id: 'd1', turnId: 'turn-1', status: 'completed' };

function gatedCall(table: string, callId = 'call-1'): TurnEvent[] {
  return [
    {
      type: 'model.message',
      id: `msg-${callId}`,
      threadId: 'thread-1',
      content: '',
      toolCalls: [
        {
          id: callId,
          toolInfo: { name: 'delete_rows', serverName: 'acme-postgres' },
          arguments: JSON.stringify({ schema: 'public', table }),
        },
      ],
    },
    {
      type: 'tool.approval_required',
      id: `pause-${callId}`,
      threadId: 'thread-1',
      toolCalls: [{ id: callId, sourceEventId: `msg-${callId}` }],
    },
  ];
}

function ledger(): SuppressionLedger {
  return new SuppressionLedger({ store: new InMemoryLedgerStore(), salt: generateSubjectSalt() });
}

function options(
  scripts: TurnEvent[][],
  overrides: Partial<Parameters<typeof runExecution>[0]> = {},
) {
  return {
    caseFile: executingCase(),
    transport: new ScriptedTransport(scripts),
    catalog: catalog(),
    executor: executorSpec,
    sessionId: 'sess-1',
    ledger: ledger(),
    backupRotatesAt: ROTATES,
    ...overrides,
  };
}

describe('runExecution — the happy path', () => {
  it('allows a gated call that reconciles against the signed plan', async () => {
    const transport = new ScriptedTransport([
      [created, ...gatedCall('sessions'), donePaused],
      [created, doneOk],
    ]);
    const opts = options([], { transport });

    const result = await runExecution(opts);

    assert.equal(result.callsAuthorised, 1);
    // The signature on the plan is what the allow means; delivered mechanically.
    const resume = transport.inputs[1]?.[0];
    assert.equal(resume?.type, 'user.tool_approval');
    assert.deepEqual(resume?.type === 'user.tool_approval' && resume.approval, { status: 'allow' });
  });

  it('records the erasure on the suppression ledger and moves to verifying', async () => {
    const opts = options([[created, ...gatedCall('sessions'), donePaused], [created, doneOk]]);

    const result = await runExecution(opts);

    assert.equal(result.identifiersSuppressed, 1);
    assert.equal(await opts.ledger.isSuppressed(subject), true);
    assert.equal(opts.caseFile.state, 'verifying');
  });

  // The live record is severed from the subject, but the backup still holds
  // the original — a restore would reintroduce the link that was just cut.
  it('suppresses identifiers for anonymised findings too', async () => {
    const f = finding({
      id: 'f-tax',
      category: 'financial',
      locator: { kind: 'table', schema: 'public', table: 'invoices', predicate: 'customer_id = 4471' },
    });
    const opts = options([[created, doneOk]], { caseFile: executingCase([f]) });

    const result = await runExecution(opts);

    assert.equal(result.identifiersSuppressed, 1);
    assert.equal(await opts.ledger.isSuppressed(subject), true);
  });

  it('suppresses each identifier once across many findings', async () => {
    const findings = [finding({ id: 'f1' }), finding({ id: 'f2', locator: { kind: 'table', schema: 'public', table: 'events', predicate: 'x' } })];
    const opts = options([[created, doneOk]], { caseFile: executingCase(findings) });

    const result = await runExecution(opts);

    assert.equal(result.identifiersSuppressed, 1);
  });

  it('completes without gates when nothing paused', async () => {
    const opts = options([[created, doneOk]]);
    const result = await runExecution(opts);

    assert.equal(result.callsAuthorised, 0);
    assert.equal(opts.caseFile.state, 'verifying');
  });
});

describe('runExecution — scope violations', () => {
  it('denies the whole batch and fails the case when one call exceeds the plan', async () => {
    const transport = new ScriptedTransport([
      [
        created,
        ...gatedCall('sessions', 'call-ok'),
        ...gatedCall('audit_log', 'call-bad'),
        donePaused,
      ],
      [created, doneOk],
    ]);
    const opts = options([], { transport });

    const error = await runExecution(opts).then(
      () => undefined,
      (e: unknown) => e as ExecutionError,
    );

    assert.ok(error instanceof ExecutionError);
    assert.equal(error.stage, 'scope');
    assert.equal(opts.caseFile.state, 'failed');

    // Both calls denied — the in-plan one too. A batch that tried to exceed
    // its authority does not get to keep the parts that looked fine.
    const denials = transport.inputs[1] ?? [];
    assert.equal(denials.length, 2);
    for (const denial of denials) {
      assert.equal(denial.type === 'user.tool_approval' && denial.approval.status, 'deny');
    }
    const reasons = denials
      .map((d) => (d.type === 'user.tool_approval' && d.approval.status === 'deny' ? d.approval.reason : ''))
      .join(' | ');
    assert.match(reasons, /audit_log/);
    assert.match(reasons, /run aborted/);
  });

  it('still fails the run when the denials cannot be delivered', async () => {
    const transport = new ScriptedTransport([
      [created, ...gatedCall('audit_log', 'call-bad'), donePaused],
      // No second script: respondToApprovals sees a truncated stream and throws.
    ]);
    const opts = options([], { transport });

    const error = await runExecution(opts).then(
      () => undefined,
      (e: unknown) => e as ExecutionError,
    );

    assert.equal(error?.stage, 'scope');
    assert.equal(opts.caseFile.state, 'failed');
  });
});

describe('runExecution — refusals', () => {
  it('refuses to run before approve(), without failing the case', async () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    file.transition('discovering', 'identity verified');

    const opts = options([[created, doneOk]], { caseFile: file });
    const error = await runExecution(opts).then(
      () => undefined,
      (e: unknown) => e as ExecutionError,
    );

    assert.equal(error?.stage, 'preconditions');
    // A programming error by the caller must not mark the subject's request
    // failed — nothing was started.
    assert.equal(file.state, 'discovering');
  });

  it('stops when the executor has an ungated destructive tool', async () => {
    const opts = options([[created, doneOk]], {
      executor: {
        ...executorSpec,
        mcpServers: [{ name: 'acme-postgres', enableTools: ['query', 'delete_rows'], requireApprovalForTools: [] }],
      },
    });

    const error = await runExecution(opts).then(
      () => undefined,
      (e: unknown) => e as ExecutionError,
    );

    assert.equal(error?.stage, 'verification');
    assert.equal(opts.caseFile.state, 'failed');
  });

  // The signed plan is the executor's entire authority. A question means the
  // plan is ambiguous, and ambiguity is re-planned, not interpreted mid-run.
  it('fails when the executor asks a question', async () => {
    const opts = options([
      [
        created,
        {
          type: 'model.message',
          id: 'msg-q',
          threadId: 'thread-1',
          content: '',
          toolCalls: [{ id: 'call-q', toolInfo: { name: 'ask_user_question' }, arguments: '{"question":"row is gone?"}' }],
        },
        { type: 'tool.response_required', id: 'p-q', threadId: 'thread-1', toolCalls: [{ id: 'call-q', sourceEventId: 'msg-q' }] },
        donePaused,
      ],
    ]);

    const error = await runExecution(opts).then(
      () => undefined,
      (e: unknown) => e as ExecutionError,
    );

    assert.equal(error?.stage, 'run');
    assert.match(error?.message ?? '', /re-planning, not interpretation/);
  });

  it('stops after the gate round limit rather than looping', async () => {
    const gateTurn = [created, ...gatedCall('sessions'), donePaused];
    const opts = options([gateTurn, gateTurn, gateTurn], { maxGateRounds: 2 });

    const error = await runExecution(opts).then(
      () => undefined,
      (e: unknown) => e as ExecutionError,
    );

    assert.equal(error?.stage, 'gates');
    assert.match(error?.message ?? '', /after 2 rounds/);
  });

  it('fails the case when the turn itself fails', async () => {
    const opts = options([[created, { type: 'turn.done', id: 'd', turnId: 'turn-1', status: 'failed' }]]);

    const error = await runExecution(opts).then(
      () => undefined,
      (e: unknown) => e as ExecutionError,
    );

    assert.equal(error?.stage, 'run');
    assert.equal(opts.caseFile.state, 'failed');
  });

  // An erasure that executed but was never recorded on the ledger is the worst
  // of both worlds: gone from live, and the next restore brings it back.
  it('fails when the suppression cannot be recorded', async () => {
    const opts = options([[created, doneOk]], { backupRotatesAt: 'not-a-date' });

    const error = await runExecution(opts).then(
      () => undefined,
      (e: unknown) => e as ExecutionError,
    );

    assert.equal(error?.stage, 'suppression');
    assert.equal(opts.caseFile.state, 'failed');
  });
});

describe('isReadOnlySql', () => {
  const cases: [string, boolean][] = [
    ['SELECT * FROM users WHERE id = 1', true],
    ['  WITH seed AS (SELECT 1) SELECT * FROM seed', true],
    ['SELECT 1; DELETE FROM users', false],
    ['DELETE FROM sessions WHERE user_id = 4471', false],
    ['UPDATE users SET email = NULL', false],
    // A data-modifying CTE is a write wearing a SELECT hat.
    ['WITH gone AS (DELETE FROM sessions RETURNING id) SELECT count(*) FROM gone', false],
    ['TRUNCATE users', false],
    ['SELECT * FROM users; --', false],
  ];

  for (const [sql, expected] of cases) {
    it(`${expected ? 'allows' : 'refuses'}: ${sql.slice(0, 44)}`, async () => {
      const { isReadOnlySql } = await import('./orchestrator.ts');
      assert.equal(isReadOnlySql(sql), expected);
    });
  }
});
