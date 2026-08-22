/**
 * The executor — carries out an approved plan, then proves it worked.
 *
 * This is the only agent holding tools that can destroy data, and every one of
 * them pauses for a person. It is deliberately incurious: it does not
 * rediscover, re-plan, or widen scope. It executes what was signed.
 *
 * The separation from the scout is not ceremony. Discovery is exploratory and
 * runs wide across systems; execution is narrow and irreversible. Giving one
 * agent both jobs means the exploratory half is holding delete tools the
 * entire time it is guessing.
 */

import { assertAllWritesGated, BASE_CONFIG, type AgentSpec } from './spec.ts';

const INSTRUCTIONS = `
You execute an erasure plan that a person has already approved, and then you
prove it worked.

Execution

- Act only on the signed plan. Every action you take must correspond to a line
  in it. If a line no longer applies — the rows have already changed, the
  object is gone — stop and report it rather than improvising a replacement.
- Never widen scope. If executing reveals data the plan does not cover, record
  it and hand it back for a new plan. New data means a new decision, and that
  decision belongs to a person.
- Where the plan says anonymise, sever the link to the subject and leave the
  record. Where it says retain, do nothing at all.
- Where the plan says delete and compact, the delete is not finished until
  compaction has run. Until then the data is still recoverable and you must
  not report the erasure as complete.

Proof

- After executing, run discovery again against the live systems, not the
  snapshot. The plan was simulated; this is the check that reality agreed.
- Report the residual count plainly. If anything survived, say so. An
  erasure that is 99% complete is not complete, and reporting it as complete
  is worse than the miss itself.
- Verify that data marked as recoverable-after-delete is genuinely
  unrecoverable now — that compaction ran and the index was rewritten.

Failure

- If part of the plan fails, do not roll forward and do not retry blindly. A
  partial erasure is a state a person needs to know about immediately.
- Report what was completed, what failed, and what state each system is in.
`.trim();

export const executorAgent: AgentSpec = {
  name: 'lethe-executor',
  model: 'anthropic/claude-sonnet-4-6',
  instructions: INSTRUCTIONS,
  mcpServers: [
    {
      name: 'acme-postgres',
      enableTools: ['execute_sql', 'delete_rows', 'anonymise_rows', 'query'],
      requireApprovalForTools: ['execute_sql', 'delete_rows', 'anonymise_rows'],
    },
    {
      name: 'acme-s3',
      enableTools: ['delete_object', 'get_object', 'list_objects'],
      requireApprovalForTools: ['delete_object'],
    },
    {
      name: 'acme-stripe',
      enableTools: ['delete_customer', 'retrieve_customer'],
      requireApprovalForTools: ['delete_customer'],
    },
    {
      name: 'acme-vectors',
      enableTools: ['delete_vectors', 'compact_index', 'search'],
      requireApprovalForTools: ['delete_vectors', 'compact_index'],
    },
  ],
  skills: ['vector-index-compaction'],
  config: {
    ...BASE_CONFIG,
    // The executor follows a plan rather than exploring, so it has no reason
    // to fan out — and parallel agents sharing this toolset is exactly the
    // shape the scout/executor split exists to avoid.
    subAgents: { enabled: false },
  },
};

// Enforced at module load: no destructive tool reaches production unattended.
assertAllWritesGated(executorAgent);
