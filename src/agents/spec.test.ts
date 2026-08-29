import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executorAgent } from './executor.ts';
import { scoutAgent } from './scout.ts';
import {
  assertAllWritesGated,
  assertReadOnly,
  BASE_CONFIG,
  bindingIsReadOnly,
  restrictToSystems,
  type AgentSpec,
} from './spec.ts';

function specWith(servers: AgentSpec['mcpServers']): AgentSpec {
  return {
    name: 'test-agent',
    model: 'test/model',
    instructions: 'test',
    mcpServers: servers,
    skills: [],
    config: BASE_CONFIG,
  };
}

describe('bindingIsReadOnly', () => {
  it('trusts the @read-only selector, which the connector resolves from annotations', () => {
    assert.equal(bindingIsReadOnly({ name: 'db', enableTools: '@read-only' }), true);
  });

  it('treats @all as mutable', () => {
    assert.equal(bindingIsReadOnly({ name: 'db', enableTools: '@all' }), false);
  });

  // A tool name tells us nothing about whether it writes. Assuming an explicit
  // list is safe would let `run_query` — which happens to accept DELETE —
  // through unnoticed, so any named list counts as mutable.
  it('treats an explicit allow-list as mutable even when the names look harmless', () => {
    assert.equal(bindingIsReadOnly({ name: 'db', enableTools: ['query', 'describe'] }), false);
  });
});

describe('assertReadOnly', () => {
  it('accepts an agent bound entirely read-only', () => {
    assert.doesNotThrow(() =>
      assertReadOnly(specWith([{ name: 'db', enableTools: '@read-only' }])),
    );
  });

  it('rejects a writable connector and names it', () => {
    assert.throws(
      () =>
        assertReadOnly(
          specWith([
            { name: 'db', enableTools: '@read-only' },
            { name: 'billing', enableTools: '@all' },
          ]),
        ),
      /billing/,
    );
  });

  // Approval is a backstop, not a substitute for withholding the tool. A gate
  // that fires on every run of a parallel fan-out is a gate people click
  // through without reading.
  it('rejects a writable connector even when every write is gated', () => {
    assert.throws(
      () =>
        assertReadOnly(
          specWith([
            { name: 'db', enableTools: ['delete_rows'], requireApprovalForTools: ['delete_rows'] },
          ]),
        ),
      /must never hold write tools/,
    );
  });
});

describe('assertAllWritesGated', () => {
  it('accepts writable connectors when every write pauses for a person', () => {
    assert.doesNotThrow(() =>
      assertAllWritesGated(
        specWith([
          { name: 'db', enableTools: ['delete_rows'], requireApprovalForTools: ['delete_rows'] },
        ]),
      ),
    );
  });

  it('rejects a writable connector with no gate at all', () => {
    assert.throws(
      () => assertAllWritesGated(specWith([{ name: 'db', enableTools: '@all' }])),
      /no approval gate/,
    );
  });

  it('ignores read-only connectors, which need no gate', () => {
    assert.doesNotThrow(() =>
      assertAllWritesGated(specWith([{ name: 'db', enableTools: '@read-only' }])),
    );
  });
});

describe('the shipped agents', () => {
  // The central safety property of the system. If this ever fails, discovery
  // is capable of deleting the data it was sent to find.
  it('scout holds no tool that can mutate a connected system', () => {
    assert.doesNotThrow(() => assertReadOnly(scoutAgent));
    for (const binding of scoutAgent.mcpServers) {
      assert.equal(bindingIsReadOnly(binding), true, `${binding.name} is not read-only`);
    }
  });

  it('executor cannot reach production unattended', () => {
    assert.doesNotThrow(() => assertAllWritesGated(executorAgent));
  });

  it('every executor connector that can write gates its destructive tools', () => {
    for (const binding of executorAgent.mcpServers) {
      if (bindingIsReadOnly(binding)) continue;
      assert.ok(
        (binding.requireApprovalForTools?.length ?? 0) > 0,
        `${binding.name} can write with no approval required`,
      );
    }
  });

  // Subagents inherit the parent's toolset, so an executor that fans out would
  // hand delete tools to several agents at once.
  it('executor does not fan out', () => {
    assert.equal(executorAgent.config.subAgents.enabled, false);
  });

  it('scout does fan out, since parallel discovery is the point', () => {
    assert.equal(scoutAgent.config.subAgents.enabled, true);
  });

  it('both agents have the sandbox available for simulation and skills', () => {
    assert.equal(scoutAgent.config.sandbox.enabled, true);
    assert.equal(executorAgent.config.sandbox.enabled, true);
  });
});

describe('restrictToSystems', () => {
  it('keeps only the named connectors, invariants intact', () => {
    const scoped = restrictToSystems(scoutAgent, ['acme-postgres']);
    assert.equal(scoped.mcpServers.length, 1);
    assert.equal(scoped.mcpServers[0]?.name, 'acme-postgres');
    // The narrowing must never weaken the safety property.
    assert.doesNotThrow(() => assertReadOnly(scoped));
  });

  it('refuses to narrow to nothing', () => {
    assert.throws(() => restrictToSystems(scoutAgent, []), /no connectors/);
  });

  // A typo would silently narrow the sweep; the certificate would honestly
  // attest to the narrower scope — correct, but not what was meant.
  it('refuses a system the spec never declared', () => {
    assert.throws(() => restrictToSystems(scoutAgent, ['acme-postgres', 'acme-postgress']), /no connector named: acme-postgress/);
  });
});
