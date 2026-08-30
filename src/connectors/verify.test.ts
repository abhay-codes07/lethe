import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executorAgent } from '../agents/executor.ts';
import { scoutAgent } from '../agents/scout.ts';
import { BASE_CONFIG, type AgentSpec, type McpServerBinding } from '../agents/spec.ts';
import { classify, nameSuggestsMutation, type ToolCatalog, type ToolDescriptor } from './catalog.ts';
import { exposedTools, isFatal, verifyAgent, verifyOrThrow } from './verify.ts';

function catalogOf(tools: Record<string, readonly ToolDescriptor[]>): ToolCatalog {
  return {
    async listTools(serverName) {
      const found = tools[serverName];
      if (!found) throw new Error(`unknown connector ${serverName}`);
      return found;
    },
  };
}

const readTool = (name: string): ToolDescriptor => ({ name, annotations: { readOnlyHint: true } });
const writeTool = (name: string): ToolDescriptor => ({ name, annotations: { destructiveHint: true } });

function specWith(servers: readonly McpServerBinding[], name = 'test-agent'): AgentSpec {
  return { name, model: 'test/model', instructions: 't', mcpServers: servers, skills: [], config: BASE_CONFIG };
}

describe('classify', () => {
  it('trusts a clean read-only annotation', () => {
    assert.equal(classify(readTool('query')), 'read_only');
  });

  it('believes a destructive annotation', () => {
    assert.equal(classify(writeTool('delete_rows')), 'mutating');
  });

  // Most servers annotate nothing. Defaulting an unknown tool to safe would
  // quietly hand the scout write access the moment someone added a connector.
  it('treats an unannotated tool as mutating', () => {
    assert.equal(classify({ name: 'list_things' }), 'mutating');
  });

  // The annotation is the server operator's word, and the name is the one
  // thing they cannot misreport.
  it('flags a read-only annotation contradicted by the name', () => {
    assert.equal(classify({ name: 'purge_customer', annotations: { readOnlyHint: true } }), 'contradictory');
  });

  it('recognises destructive verbs', () => {
    for (const name of ['delete_rows', 'drop_table', 'truncate_log', 'compact_index', 'set_flag']) {
      assert.equal(nameSuggestsMutation(name), true, name);
    }
  });

  it('does not flag ordinary read verbs', () => {
    for (const name of ['query', 'list_objects', 'search', 'describe_table', 'get_customer']) {
      assert.equal(nameSuggestsMutation(name), false, name);
    }
  });
});

describe('exposedTools', () => {
  const available = [readTool('query'), writeTool('delete_rows'), { name: 'unannotated' }];

  it('resolves @read-only the way the harness would', () => {
    const exposed = exposedTools({ name: 's', enableTools: '@read-only' }, available);
    assert.deepEqual(exposed.map((t) => t.name), ['query']);
  });

  it('resolves @all to everything', () => {
    assert.equal(exposedTools({ name: 's', enableTools: '@all' }, available).length, 3);
  });

  it('resolves an explicit list', () => {
    const exposed = exposedTools({ name: 's', enableTools: ['query', 'delete_rows'] }, available);
    assert.deepEqual(exposed.map((t) => t.name), ['query', 'delete_rows']);
  });

  it('applies disableTools after the selector resolves', () => {
    const exposed = exposedTools({ name: 's', enableTools: '@all', disableTools: ['delete_rows'] }, available);
    assert.ok(!exposed.some((t) => t.name === 'delete_rows'));
  });
});

describe('verifyAgent — read-only agents', () => {
  it('passes when every exposed tool is genuinely read-only', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@read-only' }]),
      catalogOf({ db: [readTool('query'), readTool('list_tables')] }),
      true,
    );

    assert.equal(isFatal(report), false);
    assert.equal(report.toolsChecked, 2);
  });

  // The failure the whole module exists for: a server that annotated a
  // destructive tool as safe, so the harness exposes it under @read-only.
  it('catches a mutating tool that slipped through a read-only selector', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@read-only' }]),
      // Annotated read-only, but it deletes.
      catalogOf({ db: [{ name: 'delete_rows', annotations: { readOnlyHint: true } }] }),
      true,
    );

    assert.equal(isFatal(report), true);
    assert.ok(report.violations.some((v) => /absence of the capability/.test(v.message)));
  });

  it('warns separately about a contradictory annotation', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@all' }]),
      catalogOf({ db: [{ name: 'purge_old', annotations: { readOnlyHint: true } }] }),
      true,
    );

    assert.ok(report.violations.some((v) => v.severity === 'warning' && /should be corrected/.test(v.message)));
  });

  // Discovery would run, find nothing, and report a clean sweep — a result
  // indistinguishable from a subject who genuinely has no data there.
  it('treats a binding that exposes nothing as fatal', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@read-only' }]),
      catalogOf({ db: [writeTool('delete_rows')] }),
      true,
    );

    assert.equal(isFatal(report), true);
    assert.ok(report.violations.some((v) => /indistinguishable from finding nothing/.test(v.message)));
  });

  it('treats an unreachable connector as fatal rather than skipping it', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'missing', enableTools: '@read-only' }]),
      catalogOf({}),
      true,
    );

    assert.equal(isFatal(report), true);
    assert.ok(report.violations.some((v) => /unverifiable connector/.test(v.message)));
  });

  it('treats an agent with no connectors as fatal', async () => {
    const report = await verifyAgent(specWith([]), catalogOf({}), true);
    assert.equal(isFatal(report), true);
  });
});

describe('verifyAgent — executing agents', () => {
  it('passes when every destructive tool is gated', async () => {
    const report = await verifyAgent(
      specWith([
        { name: 'db', enableTools: ['query', 'delete_rows'], requireApprovalForTools: ['delete_rows'] },
      ]),
      catalogOf({ db: [readTool('query'), writeTool('delete_rows')] }),
      false,
    );

    assert.equal(isFatal(report), false);
  });

  // The likeliest real failure: require_approval_for_tools names the tools that
  // existed when the spec was written, and the connector later gained one.
  it('catches a destructive tool the spec never thought to gate', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@all', requireApprovalForTools: ['delete_rows'] }]),
      catalogOf({ db: [writeTool('delete_rows'), writeTool('truncate_table')] }),
      false,
    );

    assert.equal(isFatal(report), true);
    const violation = report.violations.find((v) => v.tool === 'truncate_table');
    assert.match(violation?.message ?? '', /would run\s+unattended/);
  });

  it('does not demand a gate on read-only tools', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: ['query'], requireApprovalForTools: [] }]),
      catalogOf({ db: [readTool('query')] }),
      false,
    );

    assert.equal(isFatal(report), false);
  });
});

describe('verifyOrThrow', () => {
  it('reports every fatal issue at once rather than the first', async () => {
    await assert.rejects(
      verifyOrThrow(
        [
          { spec: specWith([{ name: 'db', enableTools: '@read-only' }], 'scout'), expectReadOnly: true },
          { spec: specWith([{ name: 'db', enableTools: '@read-only' }], 'other'), expectReadOnly: true },
        ],
        catalogOf({ db: [{ name: 'delete_rows', annotations: { readOnlyHint: true } }] }),
      ),
      /\[scout\][\s\S]*\[other\]/,
    );
  });

  it('returns reports when everything verifies', async () => {
    const reports = await verifyOrThrow(
      [{ spec: specWith([{ name: 'db', enableTools: '@read-only' }]), expectReadOnly: true }],
      catalogOf({ db: [readTool('query')] }),
    );

    assert.equal(reports.length, 1);
  });
});

describe('the shipped agents against a well-behaved catalog', () => {
  const catalog = catalogOf({
    'acme-postgres': [
      readTool('query'),
      readTool('describe_table'),
      writeTool('execute_sql'),
      writeTool('delete_rows'),
      writeTool('anonymise_rows'),
    ],
    'acme-s3': [readTool('list_objects'), readTool('get_object'), writeTool('delete_object')],
    'acme-stripe': [readTool('retrieve_customer'), writeTool('delete_customer')],
    'acme-vectors': [readTool('search'), writeTool('delete_vectors'), writeTool('compact_index')],
    'acme-logs': [readTool('search_logs')],
  });

  it('the scout resolves to read-only tools only', async () => {
    const report = await verifyAgent(scoutAgent, catalog, true);
    assert.equal(isFatal(report), false, JSON.stringify(report.violations));
  });

  it('every destructive tool the executor can reach is gated', async () => {
    const report = await verifyAgent(executorAgent, catalog, false);
    assert.equal(isFatal(report), false, JSON.stringify(report.violations));
  });
});

describe('selector gates', () => {
  // The likeliest real failure, structurally closed: a name list gates the
  // tools that existed when the spec was written; @write gates whatever the
  // connector grows later.
  it('@write covers a destructive tool the spec never named', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@all', requireApprovalForTools: ['@write'] }]),
      catalogOf({ db: [writeTool('delete_rows'), writeTool('truncate_table')] }),
      false,
    );

    assert.equal(isFatal(report), false, JSON.stringify(report.violations));
  });

  it('@destructive covers only tools annotated destructive', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@all', requireApprovalForTools: ['@destructive'] }]),
      catalogOf({
        db: [
          writeTool('delete_rows'),
          // Write-but-not-destructive: readOnlyHint explicitly false.
          { name: 'update_row', annotations: { readOnlyHint: false } },
        ],
      }),
      false,
    );

    assert.equal(isFatal(report), true);
    assert.equal(report.violations[0]?.tool, 'update_row');
  });

  // Whether the harness would gate an unannotated tool is the server
  // operator's annotation call; assuming a gate that might not fire is the
  // unsafe direction.
  it('an unannotated mutating tool is not assumed covered by @write', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@all', requireApprovalForTools: ['@write'] }]),
      catalogOf({ db: [{ name: 'mystery_op' }] }),
      false,
    );

    assert.equal(isFatal(report), true);
    assert.equal(report.violations[0]?.tool, 'mystery_op');
  });

  it('@all covers everything, unannotated included', async () => {
    const report = await verifyAgent(
      specWith([{ name: 'db', enableTools: '@all', requireApprovalForTools: ['@all'] }]),
      catalogOf({ db: [{ name: 'mystery_op' }, writeTool('delete_rows')] }),
      false,
    );

    assert.equal(isFatal(report), false);
  });
});

describe('credential-basis bindings', () => {
  const credential = {
    name: 'db',
    enableTools: '@all' as const,
    readOnlyBasis: {
      kind: 'credential' as const,
      evidence: 'lethe_ro role, writes revoked, refusal verified by demo/verify.sh',
    },
  };

  // The real-world case this exists for: postgres-mcp's SDK predates tool
  // annotations entirely, so @read-only resolves to zero tools and the
  // guarantee must rest on the credential instead.
  it('passes read-only verification on an unannotated server, with a loud warning', async () => {
    const report = await verifyAgent(
      specWith([credential]),
      catalogOf({ db: [{ name: 'list_schemas' }, { name: 'execute_sql' }] }),
      true,
    );

    assert.equal(isFatal(report), false, JSON.stringify(report.violations));
    // The basis is surfaced, never silent: a reader of the report must see
    // what each binding's guarantee rests on.
    const warning = report.violations.find((v) => v.severity === 'warning');
    assert.match(warning?.message ?? '', /read-only by credential/);
    assert.match(warning?.message ?? '', /verified/);
    assert.equal(report.toolsChecked, 2);
  });

  it('still treats an empty toolset as fatal', async () => {
    const report = await verifyAgent(specWith([credential]), catalogOf({ db: [] }), true);
    assert.equal(isFatal(report), true);
  });
});
