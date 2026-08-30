/**
 * Applying a credential read-only basis — only where the evidence reaches.
 *
 * The first version of this helper lived twice, in the CLI and the smoke run,
 * and stamped one piece of evidence onto whatever connector the environment
 * named. Qodo's review caught what that means: naming `acme-stripe` would
 * apply the *Postgres* role's evidence to Stripe and expose its entire
 * toolset as "read-only" on the strength of a claim about a different
 * system. A basis whose evidence does not reach its subject is not a basis.
 *
 * So the evidence lives here, keyed by the one connector it is actually
 * about, and naming any other connector is refused with the covered set in
 * the error. Extending coverage means adding an entry with its own evidence
 * — which is exactly the friction it should have.
 */

import { restrictToSystems, type AgentSpec } from './spec.ts';

/**
 * Connectors whose credential is known to refuse writes, with the evidence.
 *
 * Each entry must state facts about *that* connector's credential, checkable
 * by a reader. There is deliberately no wildcard.
 */
const KNOWN_READONLY_CREDENTIALS: Readonly<Record<string, string>> = {
  'acme-postgres':
    'connector credential is the lethe_ro role: SELECT-only with writes ' +
    'explicitly revoked (demo/seed/03-roles.sql), refusal verified live by ' +
    'demo/verify.sh; server additionally runs in restricted read-only mode',
};

export function applyCredentialBasis(spec: AgentSpec, names: readonly string[]): AgentSpec {
  const uncovered = names.filter((name) => !(name in KNOWN_READONLY_CREDENTIALS));
  if (uncovered.length > 0) {
    throw new Error(
      `no read-only credential evidence exists for: ${uncovered.join(', ')}. ` +
        `Covered: ${Object.keys(KNOWN_READONLY_CREDENTIALS).join(', ')}. A basis ` +
        'whose evidence does not reach its subject is not a basis — add an ' +
        'entry with evidence about that connector, or do not name it.',
    );
  }

  return {
    ...spec,
    mcpServers: spec.mcpServers.map((binding) =>
      names.includes(binding.name)
        ? {
            ...binding,
            enableTools: '@all' as const,
            readOnlyBasis: {
              kind: 'credential' as const,
              evidence: KNOWN_READONLY_CREDENTIALS[binding.name]!,
            },
          }
        : binding,
    ),
  };
}

/**
 * The shared env handling for the two live entry points, so they cannot
 * drift: LETHE_SYSTEMS narrows the sweep, LETHE_CREDENTIAL_READONLY applies
 * the basis — and only to connectors the evidence table covers.
 */
export function scoutFromEnv(base: AgentSpec, env: NodeJS.ProcessEnv = process.env): AgentSpec {
  const systems = env['LETHE_SYSTEMS'];
  let spec = systems ? restrictToSystems(base, systems.split(',').map((s) => s.trim())) : base;

  const credentialReadOnly = env['LETHE_CREDENTIAL_READONLY'];
  if (credentialReadOnly) {
    spec = applyCredentialBasis(spec, credentialReadOnly.split(',').map((s) => s.trim()));
  }

  return withModelFromEnv(withoutSandboxFromEnv(spec, env), env);
}

/**
 * Run without harness-side skills or a sandbox.
 *
 * Skills are registered server-side and materialise in a sandbox, which is a
 * separate provider needing its own credentials. A harness without one can
 * still run the whole erasure loop: the retention rules that decide
 * dispositions live in this codebase's planner and are applied
 * deterministically — the skill packs are guidance for the agent on top,
 * not the mechanism. LETHE_NO_SANDBOX states plainly that this run does
 * without both.
 */
/**
 * Point the executor's Postgres binding at a differently-named connector.
 *
 * The split exists because one registered connector carries one credential.
 * The scout's connector holds the read-only role; execution needs the write
 * role, which therefore lives behind its own connector name. The gates
 * travel with the binding — the rename changes which credential answers,
 * never what is gated.
 */
export function withExecutorConnectorFromEnv(
  spec: AgentSpec,
  env: NodeJS.ProcessEnv = process.env,
): AgentSpec {
  const renamed = env['LETHE_EXECUTOR_CONNECTOR']?.trim();
  if (!renamed) return spec;
  return {
    ...spec,
    mcpServers: spec.mcpServers.map((binding) =>
      binding.name === 'acme-postgres'
        ? {
            ...binding,
            name: renamed,
            // Observed live: the harness refuses the whole toolset when the
            // enable list names tools the server does not have. postgres-mcp
            // exposes SQL, not per-operation tools, so the binding narrows to
            // the one tool that exists — gated by name, so every use pauses.
            enableTools: ['execute_sql'],
            requireApprovalForTools: ['@write', 'execute_sql'],
          }
        : binding,
    ),
  };
}

export function withoutSandboxFromEnv(spec: AgentSpec, env: NodeJS.ProcessEnv = process.env): AgentSpec {
  if (env['LETHE_NO_SANDBOX'] !== '1') return spec;
  return {
    ...spec,
    skills: [],
    config: { ...spec.config, sandbox: { enabled: false } },
  };
}

/**
 * Swap the model by environment.
 *
 * The specs name a default; the harness only knows the providers whose keys
 * were pasted into it. LETHE_MODEL bridges the two without editing code —
 * whichever provider the operator actually has, e.g. `openai/gpt-4o`.
 * The model is the one field where swapping changes no safety property:
 * every guarantee here binds tools and credentials, not the brain.
 */
export function withModelFromEnv(spec: AgentSpec, env: NodeJS.ProcessEnv = process.env): AgentSpec {
  const model = env['LETHE_MODEL']?.trim();
  return model ? { ...spec, model } : spec;
}
