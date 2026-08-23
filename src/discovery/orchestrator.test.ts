import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scoutAgent } from '../agents/scout.ts';
import type { ToolCatalog, ToolDescriptor } from '../connectors/catalog.ts';
import type { Identifier } from '../domain/identity.ts';
import { CaseFile } from '../lifecycle/case-file.ts';
import type { ReceivedEvent, TurnEvent, TurnInput } from '../harness/protocol.ts';
import type { Transport, TurnState } from '../harness/transport.ts';
import type { QuestionRequest } from '../harness/turn-runner.ts';
import { DiscoveryError, runDiscovery, type QuestionResponder } from './orchestrator.ts';

const seed: Identifier = { kind: 'email', value: 'ada@example.com', system: 'acme-postgres' };

const readTool = (name: string): ToolDescriptor => ({ name, annotations: { readOnlyHint: true } });

/** A catalog where every scout connector exposes something readable. */
function goodCatalog(): ToolCatalog {
  return {
    async listTools(server) {
      if (!scoutAgent.mcpServers.some((b) => b.name === server)) {
        throw new Error(`unknown connector ${server}`);
      }
      return [readTool('query'), readTool('search')];
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

const created: TurnEvent = { type: 'turn.created', id: 'c1', turnId: 'turn-1' };
const doneOk: TurnEvent = { type: 'turn.done', id: 'd1', turnId: 'turn-1', status: 'completed' };

function reply(content: string, id = 'msg-1'): TurnEvent {
  return { type: 'model.message', id, threadId: 'thread-1', content, toolCalls: [] };
}

const FINDINGS_JSON = JSON.stringify({
  findings: [
    {
      id: 'f1',
      system: 'acme-postgres',
      locator: { kind: 'table', schema: 'public', table: 'sessions', predicate: 'email = $1' },
      category: 'behavioural',
      durability: 'hard_delete',
      count: 12,
      matchedBy: { kind: 'email', value: 'ada@example.com', system: 'acme-postgres' },
      observedAt: '2026-08-23T10:00:00.000Z',
    },
  ],
});

const refuser: QuestionResponder = {
  async answer() {
    throw new Error('no responder configured');
  },
};

function options(
  scripts: TurnEvent[][],
  overrides: Partial<Parameters<typeof runDiscovery>[0]> = {},
) {
  return {
    caseFile: new CaseFile('DSR-118', '2026-08-01T09:00:00.000Z'),
    transport: new ScriptedTransport(scripts),
    catalog: goodCatalog(),
    scout: scoutAgent,
    sessionId: 'sess-1',
    seeds: [seed],
    responder: refuser,
    ...overrides,
  };
}

describe('runDiscovery — success', () => {
  it('parses findings and advances the case file to planning', async () => {
    const opts = options([[created, reply(FINDINGS_JSON), doneOk]]);
    const result = await runDiscovery(opts);

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.count, 12);
    assert.equal(opts.caseFile.state, 'planning');
    assert.equal(opts.caseFile.findings.length, 1);
  });

  it('seeds the identity graph before sweeping', async () => {
    const opts = options([[created, reply(FINDINGS_JSON), doneOk]]);
    const result = await runDiscovery(opts);

    assert.equal(result.identities.has(seed), true);
    assert.equal(opts.caseFile.identities?.size, 1);
  });

  it('answers a clarifying question and continues', async () => {
    const question: TurnEvent = {
      type: 'model.message',
      id: 'msg-q',
      threadId: 'thread-1',
      content: '',
      toolCalls: [
        {
          id: 'call-q',
          toolInfo: { name: 'ask_user_question' },
          arguments: '{"question":"Two accounts share this email. Same person?","options":["Yes","No"]}',
        },
      ],
    };

    const asked: QuestionRequest[] = [];
    const responder: QuestionResponder = {
      async answer(q) {
        asked.push(q);
        return 'Yes';
      },
    };

    const opts = options(
      [
        [
          created,
          question,
          { type: 'tool.response_required', id: 'p1', threadId: 'thread-1', toolCalls: [{ id: 'call-q', sourceEventId: 'msg-q' }] },
          { type: 'turn.done', id: 'd0', turnId: 'turn-1', status: 'paused' },
        ],
        [created, reply(FINDINGS_JSON), doneOk],
      ],
      { responder },
    );

    const result = await runDiscovery(opts);

    assert.equal(asked.length, 1);
    assert.match(asked[0]?.question ?? '', /Same person/);
    assert.equal(result.findings.length, 1);
  });
});

describe('runDiscovery — failures leave the case file honest', () => {
  async function expectFailure(opts: ReturnType<typeof options>, stage: string, pattern: RegExp) {
    const error = await runDiscovery(opts).then(
      () => undefined,
      (e: unknown) => e as DiscoveryError,
    );

    assert.ok(error instanceof DiscoveryError, 'expected a DiscoveryError');
    assert.equal(error.stage, stage);
    assert.match(error.message, pattern);
    assert.equal(opts.caseFile.state, 'failed');
  }

  it('refuses to start with no verified seed', async () => {
    const opts = options([], { seeds: [] });
    await expectFailure(opts, 'verification', /at least one verified seed/);
  });

  // Verification runs before the case file moves, so a misconfigured connector
  // never produces a request that looks like it started work.
  it('stops when a connector cannot be verified', async () => {
    const opts = options([[created, reply(FINDINGS_JSON), doneOk]], {
      catalog: {
        async listTools() {
          throw new Error('connector unreachable');
        },
      },
    });

    await expectFailure(opts, 'verification', /unverifiable connector/);
  });

  it('stops when the scout exposes a tool that can write', async () => {
    const opts = options([[created, reply(FINDINGS_JSON), doneOk]], {
      catalog: {
        async listTools() {
          return [{ name: 'delete_rows', annotations: { readOnlyHint: true } }];
        },
      },
    });

    await expectFailure(opts, 'verification', /absence of the capability/);
  });

  // Half a sweep builds a plan that deletes half a person and certifies it as
  // complete.
  it('rejects findings that cannot be trusted rather than keeping the good ones', async () => {
    const mixed = JSON.stringify({
      findings: [
        JSON.parse(FINDINGS_JSON).findings[0],
        {
          id: 'f2',
          system: 'acme-postgres',
          locator: { kind: 'table', schema: 'public', table: 'orders', predicate: 'x' },
          category: 'financial',
          durability: 'hard_delete',
          count: 4,
          matchedBy: { kind: 'email', value: 'bob@example.com', system: 'acme-postgres' },
          observedAt: '2026-08-23T10:00:00.000Z',
        },
      ],
    });

    const opts = options([[created, reply(mixed), doneOk]]);
    await expectFailure(opts, 'parsing', /not in the identity graph/);
  });

  it('stops when the reply is not JSON', async () => {
    const opts = options([[created, reply('I found some rows in sessions.'), doneOk]]);
    await expectFailure(opts, 'parsing', /not valid JSON/);
  });

  it('stops when the turn ends with no reply at all', async () => {
    const opts = options([[created, doneOk]]);
    await expectFailure(opts, 'parsing', /without a reply/);
  });

  it('stops when the turn fails', async () => {
    const opts = options([[created, { type: 'turn.done', id: 'd', turnId: 'turn-1', status: 'failed' }]]);
    await expectFailure(opts, 'run', /ended failed/);
  });

  // The scout holds nothing that can write, so a gate means verification's
  // guarantee has been broken.
  it('stops if discovery pauses for a tool approval', async () => {
    const opts = options([
      [
        created,
        {
          type: 'model.message',
          id: 'msg-1',
          threadId: 'thread-1',
          content: '',
          toolCalls: [{ id: 'call-1', toolInfo: { name: 'delete_rows' }, arguments: '{}' }],
        },
        { type: 'tool.approval_required', id: 'p1', threadId: 'thread-1', toolCalls: [{ id: 'call-1', sourceEventId: 'msg-1' }] },
        { type: 'turn.done', id: 'd', turnId: 'turn-1', status: 'paused' },
      ],
    ]);

    await expectFailure(opts, 'approval', /must hold nothing that requires one/);
  });

  // A request stuck in a question loop quietly consumes its statutory month.
  it('stops asking after the round limit rather than looping', async () => {
    const questionTurn: TurnEvent[] = [
      created,
      {
        type: 'model.message',
        id: 'msg-q',
        threadId: 'thread-1',
        content: '',
        toolCalls: [{ id: 'call-q', toolInfo: { name: 'ask_user_question' }, arguments: '{"question":"again?"}' }],
      },
      { type: 'tool.response_required', id: 'p', threadId: 'thread-1', toolCalls: [{ id: 'call-q', sourceEventId: 'msg-q' }] },
      { type: 'turn.done', id: 'd', turnId: 'turn-1', status: 'paused' },
    ];

    const opts = options([questionTurn, questionTurn, questionTurn], {
      responder: { async answer() { return 'yes'; } },
      maxQuestionRounds: 2,
    });

    await expectFailure(opts, 'clarification', /after the round limit/);
  });

  it('stops when a question cannot be answered', async () => {
    const opts = options([
      [
        created,
        {
          type: 'model.message',
          id: 'msg-q',
          threadId: 'thread-1',
          content: '',
          toolCalls: [{ id: 'call-q', toolInfo: { name: 'ask_user_question' }, arguments: '{"question":"which?"}' }],
        },
        { type: 'tool.response_required', id: 'p', threadId: 'thread-1', toolCalls: [{ id: 'call-q', sourceEventId: 'msg-q' }] },
        { type: 'turn.done', id: 'd', turnId: 'turn-1', status: 'paused' },
      ],
    ]);

    await expectFailure(opts, 'clarification', /could not answer/);
  });
});
