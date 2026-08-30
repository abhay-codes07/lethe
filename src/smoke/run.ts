/**
 * The smoke run.
 *
 * Everything in this project is tested against fakes written alongside the
 * code it exercises. That verifies the reasoning and proves nothing about the
 * harness: the endpoint paths, the event framing, the tool-list response
 * shape, and whether a real scout produces findings that survive validation
 * are all still assumptions.
 *
 * This is the smallest thing that turns those assumptions into observations.
 * It runs discovery once against a live harness and one seeded connector, and
 * reports what actually happened at each stage — including, especially, where
 * it stopped.
 *
 * It is deliberately not a test. A test that needs credentials and a running
 * server either gets skipped in CI or makes CI flaky, and both teach you to
 * ignore it. This is a command somebody runs, reads, and acts on.
 *
 *   TRUEFORGE_BASE_URL=http://localhost:3000 \
 *   TRUEFORGE_API_KEY=... \
 *   node src/smoke/run.ts
 */

import { toManifest } from '../agents/manifest.ts';
import { scoutAgent } from '../agents/scout.ts';
import { restrictToSystems, type AgentSpec } from '../agents/spec.ts';
import { HttpToolCatalog } from '../connectors/http-catalog.ts';
import { verifyAgent } from '../connectors/verify.ts';

import { HttpTransport } from '../harness/http-transport.ts';
import type { QuestionRequest } from '../harness/turn-runner.ts';
import { CaseFile } from '../lifecycle/case-file.ts';
import { DiscoveryError, runDiscovery, type QuestionResponder } from '../discovery/orchestrator.ts';
import type { Identifier } from '../domain/identity.ts';

/** The seeded subject from `demo/`. Synthetic; see demo/README.md. */
const DEMO_SEED: Identifier = {
  kind: 'email',
  value: 'ada@example.invalid',
  system: 'acme-postgres',
};

/**
 * Answers clarifications with a refusal.
 *
 * A smoke run must not invent answers about whose data to erase. If the scout
 * asks something, that is a finding in itself — it tells you the prompt or the
 * seeded estate is ambiguous — and the run should stop and say so rather than
 * guessing its way to a green tick.
 */
const stopOnQuestion: QuestionResponder = {
  async answer(question: QuestionRequest): Promise<string> {
    throw new Error(
      `the scout asked "${question.question}" — a smoke run does not answer ` +
        'questions about whose data to erase. Decide the answer, then re-run.',
    );
  },
};

interface SmokeOptions {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly scout: AgentSpec;
  readonly seed: Identifier;
  /** Injected so the run's reporting can be exercised without a network. */
  readonly fetch?: typeof globalThis.fetch;
}

function step(label: string): void {
  process.stdout.write(`\n── ${label}\n`);
}

function ok(message: string): void {
  process.stdout.write(`   ok    ${message}\n`);
}

function bad(message: string): void {
  process.stdout.write(`   FAIL  ${message}\n`);
}

function note(message: string): void {
  process.stdout.write(`         ${message}\n`);
}

export async function smoke(options: SmokeOptions): Promise<number> {
  const shared = {
    baseUrl: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };

  const catalog = new HttpToolCatalog(shared);
  const transport = new HttpTransport(shared);

  // Checked one connector at a time rather than through verifyOrThrow, because
  // the useful output here is which connector answered and what it exposed —
  // not a single pass/fail.
  step('connectors');
  for (const binding of options.scout.mcpServers) {
    try {
      const tools = await catalog.listTools(binding.name);
      ok(`${binding.name}: ${tools.length} tool(s) — ${tools.map((t) => t.name).join(', ') || 'none'}`);
    } catch (error) {
      bad(`${binding.name}: ${(error as Error).message}`);
    }
  }

  step('read-only guarantee');
  try {
    const report = await verifyAgent(options.scout, catalog, true);
    if (report.violations.length === 0) {
      ok(`${report.toolsChecked} tool(s) verified read-only`);
    } else {
      for (const violation of report.violations) {
        const where = `${violation.server}${violation.tool ? `.${violation.tool}` : ''}`;
        if (violation.severity === 'fatal') bad(`${where}: ${violation.message}`);
        else note(`warning: ${where}: ${violation.message}`);
      }
    }
  } catch (error) {
    bad((error as Error).message);
  }

  // A session must exist before a turn can run on it. Inventing an id and
  // starting a turn 404s — sessions are created, not named into being.
  step('session');
  let sessionId: string;
  try {
    sessionId = await transport.createSession(
      toManifest(options.scout) as unknown as Readonly<Record<string, unknown>>,
    );
    ok(`created ${sessionId} with the scout inline`);
  } catch (error) {
    bad((error as Error).message);
    return 1;
  }

  step('discovery');
  const caseFile = new CaseFile('SMOKE-1');

  try {
    const result = await runDiscovery({
      caseFile,
      transport,
      catalog,
      scout: options.scout,
      sessionId,
      seeds: [options.seed],
      responder: stopOnQuestion,
      maxQuestionRounds: 0,
    });

    ok(`${result.findings.length} finding(s), case file now ${caseFile.state}`);
    for (const finding of result.findings) {
      note(`${finding.system} · ${finding.count} record(s) · ${finding.durability}`);
    }

    if (result.findings.length === 0) {
      note('');
      note('Zero findings against a seeded estate means discovery is not working,');
      note('not that the subject is clean. Check the connector is pointed at the');
      note('demo database and that the seed identifier matches.');
      return 1;
    }

    return 0;
  } catch (error) {
    if (error instanceof DiscoveryError) {
      bad(`stopped at ${error.stage}: ${error.message}`);
    } else {
      bad((error as Error).message);
    }
    note(`case file: ${caseFile.state}`);
    note(caseFile.history.map((t) => `  ${t.from} → ${t.to}: ${t.reason}`).join('\n') || '  (no transitions)');
    return 1;
  }
}


/**
 * Apply a credential read-only basis to the named connectors.
 *
 * For servers whose SDK predates tool annotations: `@read-only` resolves to
 * nothing there, and the guarantee rests on the credential instead. The env
 * names which connectors that applies to; the evidence is fixed because for
 * the demo estate it is always the same two facts, both checkable.
 */
function withCredentialBasis(spec: AgentSpec, names: readonly string[]): AgentSpec {
  const evidence =
    'connector credential is the lethe_ro role: SELECT-only with writes ' +
    'explicitly revoked (demo/seed/03-roles.sql), refusal verified live by ' +
    'demo/verify.sh; server additionally runs in restricted read-only mode';

  return {
    ...spec,
    mcpServers: spec.mcpServers.map((binding) =>
      names.includes(binding.name)
        ? { ...binding, enableTools: '@all' as const, readOnlyBasis: { kind: 'credential' as const, evidence } }
        : binding,
    ),
  };
}

async function main(): Promise<void> {
  const baseUrl = process.env['TRUEFORGE_BASE_URL'];

  if (!baseUrl) {
    process.stderr.write(
      'TRUEFORGE_BASE_URL is not set.\n\n' +
        'The smoke run exists to replace assumptions about the harness with\n' +
        'observations, so it will not fall back to a default and report on\n' +
        'something that is not there.\n\n' +
        '  TRUEFORGE_BASE_URL=http://localhost:3000 node src/smoke/run.ts\n',
    );
    process.exitCode = 2;
    return;
  }

  process.stdout.write(`smoke run against ${baseUrl}\n`);

  // LETHE_SYSTEMS narrows the sweep to the connectors that actually exist —
  // a first run with one Postgres should be one command, not five servers.
  const systems = process.env['LETHE_SYSTEMS'];
  let scout = systems
    ? restrictToSystems(scoutAgent, systems.split(',').map((name) => name.trim()))
    : scoutAgent;

  const credentialReadOnly = process.env['LETHE_CREDENTIAL_READONLY'];
  if (credentialReadOnly) {
    scout = withCredentialBasis(scout, credentialReadOnly.split(',').map((name) => name.trim()));
  }

  const code = await smoke({
    baseUrl,
    apiKey: process.env['TRUEFORGE_API_KEY'],
    scout,
    seed: DEMO_SEED,
  });

  process.stdout.write(code === 0 ? '\nsmoke run passed\n' : '\nsmoke run failed\n');
  process.exitCode = code;
}

// Only when executed directly, so the module stays importable from a test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await main();
}
