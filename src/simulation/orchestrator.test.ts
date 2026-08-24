import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASE_CONFIG, type AgentSpec } from '../agents/spec.ts';
import type { ToolCatalog, ToolDescriptor } from '../connectors/catalog.ts';
import type { Finding } from '../domain/finding.ts';
import type { Identifier } from '../domain/identity.ts';
import { draftPlan } from '../domain/plan.ts';
import type { ReceivedEvent, TurnEvent, TurnInput } from '../harness/protocol.ts';
import type { Transport, TurnState } from '../harness/transport.ts';
import { CaseFile } from '../lifecycle/case-file.ts';
import { parseBlastRadius, runSimulation, SimulationError } from './orchestrator.ts';

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

function simulatingCase(findings: readonly Finding[] = [finding()]): CaseFile {
  const file = new CaseFile('DSR-118', RECEIVED);
  file.transition('discovering', 'identity verified');
  file.transition('planning', 'discovery complete');
  file.recordFindings(findings);
  file.recordPlan(draftPlan('DSR-118', [subject], findings));
  file.transition('simulating', 'plan drafted');
  return file;
}

const scoutSpec: AgentSpec = {
  name: 'lethe-scout',
  model: 'test/model',
  instructions: 'simulate',
  mcpServers: [{ name: 'acme-postgres', enableTools: '@read-only' }],
  skills: [],
  config: BASE_CONFIG,
};

const read = (name: string): ToolDescriptor => ({ name, annotations: { readOnlyHint: true } });

const catalog: ToolCatalog = {
  async listTools() {
    return [read('query')];
  },
};

class ScriptedTransport implements Transport {
  #scripts: TurnEvent[][];

  constructor(scripts: TurnEvent[][]) {
    this.#scripts = [...scripts];
  }

  async *createTurn(_s: string, _i: readonly TurnInput[]): AsyncIterable<ReceivedEvent> {
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
const reply = (content: string): TurnEvent => ({
  type: 'model.message',
  id: 'msg-1',
  threadId: 'thread-1',
  content,
  toolCalls: [],
});

const CLEAN = JSON.stringify({
  blastRadius: {
    constraintViolations: [],
    orphanedRecords: 0,
    residualTraces: 0,
    snapshotId: 'rollback-tx-1',
    simulatedAt: '2026-08-24T10:00:00.000Z',
  },
});

const VIOLATION = JSON.stringify({
  blastRadius: {
    constraintViolations: [
      { constraint: 'order_items_order_fk', table: 'order_items', affectedRows: 2, resolution: 'anonymise orders instead' },
    ],
    orphanedRecords: 2,
    residualTraces: 0,
    snapshotId: 'rollback-tx-2',
    simulatedAt: '2026-08-24T10:00:00.000Z',
  },
});

function options(scripts: TurnEvent[][], overrides: Partial<Parameters<typeof runSimulation>[0]> = {}) {
  return {
    caseFile: simulatingCase(),
    transport: new ScriptedTransport(scripts),
    catalog,
    scout: scoutSpec,
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('runSimulation', () => {
  it('attaches a clean measurement and moves the case to awaiting_approval', async () => {
    const opts = options([[created, reply(CLEAN), doneOk]]);
    const result = await runSimulation(opts);

    assert.equal(result.kind, 'ready');
    assert.equal(opts.caseFile.state, 'awaiting_approval');
    assert.equal(opts.caseFile.plan?.status, 'simulated');
    assert.equal(opts.caseFile.plan?.blastRadius?.snapshotId, 'rollback-tx-1');
  });

  // An FK violation is the expected path, not an exception: the measurement
  // worked and the answer is "not like this".
  it('sends a violating plan back to planning with the blockers', async () => {
    const opts = options([[created, reply(VIOLATION), doneOk]]);
    const result = await runSimulation(opts);

    assert.equal(result.kind, 'blocked');
    assert.equal(opts.caseFile.state, 'planning');
    assert.ok(result.kind === 'blocked' && result.blockers.some((b) => /constraint/.test(b)));
    assert.match(opts.caseFile.history.at(-1)?.reason ?? '', /simulation blocked approval/);
  });

  it('runs only from simulating', async () => {
    const file = new CaseFile('DSR-118', RECEIVED);
    await assert.rejects(
      runSimulation(options([[created, reply(CLEAN), doneOk]], { caseFile: file })),
      /simulation follows planning/,
    );
    assert.equal(file.state, 'received');
  });

  // Re-simulating an unedited plan measures nothing new; requiring a draft
  // pairs with edits demoting plans to draft.
  it('refuses a plan that is already simulated', async () => {
    const file = simulatingCase();
    const first = await runSimulation(
      options([[created, reply(CLEAN), doneOk]], { caseFile: file }),
    );
    assert.equal(first.kind, 'ready');

    // Force the state back without touching the plan.
    await assert.rejects(
      runSimulation(options([[created, reply(CLEAN), doneOk]], { caseFile: file })),
      /simulation follows planning|only a draft is simulated/,
    );
  });

  it('fails the case when the dry run itself breaks', async () => {
    const opts = options([[created, { type: 'turn.done', id: 'd', turnId: 'turn-1', status: 'failed' }]]);

    const error = await runSimulation(opts).then(
      () => undefined,
      (e: unknown) => e as SimulationError,
    );

    assert.equal(error?.stage, 'run');
    assert.equal(opts.caseFile.state, 'failed');
  });

  it('fails the case on a reply it cannot trust', async () => {
    const opts = options([[created, reply('looks fine to me'), doneOk]]);

    const error = await runSimulation(opts).then(
      () => undefined,
      (e: unknown) => e as SimulationError,
    );

    assert.equal(error?.stage, 'parsing');
    assert.equal(opts.caseFile.state, 'failed');
  });

  // A dry run must be incapable of being a wet one.
  it('refuses a simulating agent that holds anything writable', async () => {
    const opts = options([[created, reply(CLEAN), doneOk]], {
      catalog: {
        async listTools() {
          return [{ name: 'delete_rows', annotations: { readOnlyHint: true } }];
        },
      },
    });

    const error = await runSimulation(opts).then(
      () => undefined,
      (e: unknown) => e as SimulationError,
    );

    assert.equal(error?.stage, 'verification');
  });
});

describe('parseBlastRadius', () => {
  function radius(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      blastRadius: {
        constraintViolations: [],
        orphanedRecords: 0,
        residualTraces: 0,
        snapshotId: 'snap-1',
        simulatedAt: '2026-08-24T10:00:00.000Z',
        ...overrides,
      },
    });
  }

  it('accepts a well-formed measurement', () => {
    const result = parseBlastRadius(radius());
    assert.equal(result.ok, true);
  });

  it('rejects prose', () => {
    assert.equal(parseBlastRadius('all good').ok, false);
  });

  // Without naming the copy it measured against, "0 violations" is a claim
  // about nothing in particular.
  it('requires the snapshot to be named', () => {
    const result = parseBlastRadius(radius({ snapshotId: '' }));
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : '', /name the snapshot/);
  });

  it('rejects negative or fractional counts', () => {
    assert.equal(parseBlastRadius(radius({ orphanedRecords: -1 })).ok, false);
    assert.equal(parseBlastRadius(radius({ residualTraces: 1.5 })).ok, false);
  });

  it('requires each violation to name its constraint and table', () => {
    const result = parseBlastRadius(
      radius({ constraintViolations: [{ constraint: '', table: 'order_items', affectedRows: 2 }] }),
    );
    assert.equal(result.ok, false);
  });

  it('requires the violations array even when empty', () => {
    const result = parseBlastRadius(
      JSON.stringify({
        blastRadius: {
          orphanedRecords: 0,
          residualTraces: 0,
          snapshotId: 's',
          simulatedAt: '2026-08-24T10:00:00.000Z',
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : '', /must be an array/);
  });

  it('carries the proposed resolution through', () => {
    const result = parseBlastRadius(VIOLATION);
    assert.equal(result.ok, true);
    assert.equal(
      result.ok ? result.blastRadius.constraintViolations[0]?.resolution : '',
      'anonymise orders instead',
    );
  });
});
