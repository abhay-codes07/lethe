import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { executorAgent } from './executor.ts';
import { scoutAgent } from './scout.ts';

/**
 * Every skill a manifest references must exist as a SKILL.md with matching
 * frontmatter. A referenced-but-missing skill fails silently at runtime —
 * the harness simply has nothing to load — and the agent quietly runs
 * without the instruction pack its safety story assumes it has.
 */
describe('referenced skills exist', () => {
  const agents = [scoutAgent, executorAgent];

  for (const agent of agents) {
    for (const skill of agent.skills) {
      it(`${agent.name} -> ${skill}`, async () => {
        const raw = await readFile(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8');

        assert.match(raw, /^---\n/, 'must start with YAML frontmatter');
        const name = raw.match(/^name:\s*(.+)$/m)?.[1]?.trim();
        assert.equal(name, skill, 'frontmatter name must match the directory');
        assert.ok(
          (raw.match(/^description:\s*(.+)$/m)?.[1]?.trim().length ?? 0) > 40,
          'description is the discovery mechanism; a thin one never gets loaded',
        );
      });
    }
  }
});
