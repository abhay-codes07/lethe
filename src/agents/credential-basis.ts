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

  return spec;
}
