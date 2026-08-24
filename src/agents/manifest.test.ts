import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executorAgent } from './executor.ts';
import { toCreateAgentRequest, toManifest } from './manifest.ts';
import { scoutAgent } from './scout.ts';
import { BASE_CONFIG, type AgentSpec } from './spec.ts';

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'test-agent',
    model: 'anthropic/claude-sonnet-4-6',
    instructions: 'do the thing',
    mcpServers: [{ name: 'db', enableTools: '@read-only', preload: true }],
    skills: ['article-17-exemptions'],
    config: BASE_CONFIG,
    ...overrides,
  };
}

describe('toManifest', () => {
  it('emits the documented snake_case field names', () => {
    const manifest = toManifest(spec());

    // Asserted as literal keys: this is the wire contract, and a rename that
    // typechecks internally still breaks registration.
    assert.deepEqual(Object.keys(manifest).sort(), [
      'config',
      'instructions',
      'mcp_servers',
      'model',
      'skills',
    ]);
    assert.deepEqual(Object.keys(manifest.config).sort(), [
      'ask_user_questions',
      'context_management',
      'dynamic_sub_agents',
      'generative_ui',
      'iteration_limit',
      'sandbox',
    ]);
  });

  it('travels a selector as a one-element array and a list as itself', () => {
    const manifest = toManifest(
      spec({
        mcpServers: [
          { name: 'a', enableTools: '@read-only' },
          { name: 'b', enableTools: ['query', 'delete_rows'], requireApprovalForTools: ['delete_rows'] },
        ],
      }),
    );

    assert.deepEqual(manifest.mcp_servers[0]?.enable_tools, ['@read-only']);
    assert.deepEqual(manifest.mcp_servers[1]?.enable_tools, ['query', 'delete_rows']);
    assert.deepEqual(manifest.mcp_servers[1]?.require_approval_for_tools, ['delete_rows']);
  });

  // Skills are objects on the wire, not bare strings — a list of strings is
  // silently invalid.
  it('wraps each skill name in an object', () => {
    assert.deepEqual(toManifest(spec()).skills, [{ name: 'article-17-exemptions' }]);
  });

  it('maps the compaction threshold to its long wire name', () => {
    const manifest = toManifest(spec());
    assert.equal(
      manifest.config.context_management.compaction.compaction_threshold_tokens,
      50_000,
    );
  });

  it('omits optional binding fields it was not given', () => {
    const manifest = toManifest(spec({ mcpServers: [{ name: 'a', enableTools: '@all' }] }));
    const server = manifest.mcp_servers[0]!;

    assert.ok(!('preload' in server));
    assert.ok(!('require_approval_for_tools' in server));
    assert.ok(!('disable_tools' in server));
  });

  // The manifest the harness runs must be exactly what the assertions checked.
  it('exports both shipped agents without loss', () => {
    const scout = toManifest(scoutAgent);
    assert.equal(scout.mcp_servers.length, scoutAgent.mcpServers.length);
    for (const server of scout.mcp_servers) {
      assert.deepEqual(server.enable_tools, ['@read-only'], server.name);
    }

    const executor = toManifest(executorAgent);
    assert.equal(executor.config.dynamic_sub_agents.enabled, false);
    for (const server of executor.mcp_servers) {
      assert.ok(
        (server.require_approval_for_tools?.length ?? 0) > 0,
        `${server.name} exported without its gate`,
      );
    }
  });

  it('survives a JSON round trip unchanged', () => {
    const manifest = toManifest(spec());
    assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
  });
});

describe('toCreateAgentRequest', () => {
  it('wraps the manifest under the registry name', () => {
    const request = toCreateAgentRequest('lethe-scout', spec());
    assert.equal(request.name, 'lethe-scout');
    assert.equal(request.manifest.model.name, 'anthropic/claude-sonnet-4-6');
  });

  // The registry's 404 for a bad name arrives at session creation, where it
  // reads as "agent not found" and points whoever is debugging at the wrong
  // problem.
  it('rejects names the registry would refuse, early', () => {
    for (const bad of ['X', 'Has-Caps', '-leading', 'trailing-', 'a', 'a'.repeat(65)]) {
      assert.throws(() => toCreateAgentRequest(bad, spec()), /not a valid agent name/, bad);
    }
  });

  it('accepts the names the shipped agents use', () => {
    assert.doesNotThrow(() => toCreateAgentRequest('lethe-scout', scoutAgent));
    assert.doesNotThrow(() => toCreateAgentRequest('lethe-executor', executorAgent));
  });
});
