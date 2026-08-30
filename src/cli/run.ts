/**
 * The runbook: one erasure request, walked end to end at a terminal.
 *
 *   TRUEFORGE_BASE_URL=http://localhost:8790 npm run case -- DSR-1 ada@example.invalid
 *
 * This is glue, kept deliberately thin: every decision it appears to make is
 * made by an orchestrator that has its own tests. What the CLI owns is the
 * two places a person belongs — answering the scout's identity questions,
 * and the signature on the plan card — and the honesty of what it prints.
 *
 * The card is rendered with formatPlanCard, the same text that is attached
 * to the case record. What the signer saw and what the audit trail says they
 * saw are the same bytes.
 */

import { createInterface } from 'node:readline/promises';
import { writeFile } from 'node:fs/promises';

import { executorAgent } from '../agents/executor.ts';
import { toManifest } from '../agents/manifest.ts';
import { scoutAgent } from '../agents/scout.ts';
import { scoutFromEnv, withExecutorConnectorFromEnv, withModelFromEnv, withoutSandboxFromEnv } from '../agents/credential-basis.ts';
import { restrictToSystems } from '../agents/spec.ts';
import { HttpToolCatalog } from '../connectors/http-catalog.ts';
import { generateSubjectSalt } from '../domain/certificate.ts';
import type { Identifier } from '../domain/identity.ts';
import { amendForViolations, draftPlan, resolveEscalation } from '../domain/plan.ts';
import { runDiscovery } from '../discovery/orchestrator.ts';
import { runExecution } from '../execution/orchestrator.ts';
import { HttpTransport } from '../harness/http-transport.ts';
import type { QuestionRequest } from '../harness/turn-runner.ts';
import { CaseFile } from '../lifecycle/case-file.ts';
import { formatPlanCard, renderPlanCard } from '../review/plan-card.ts';
import { runSimulation } from '../simulation/orchestrator.ts';
import { InMemoryLedgerStore, SuppressionLedger } from '../suppression/ledger.ts';
import { runVerification } from '../verification/orchestrator.ts';

export interface RunArgs {
  readonly requestId: string;
  readonly seedEmail: string;
}

/**
 * Argument parsing, exported for its test.
 *
 * Both arguments are required. Defaulting the subject of an erasure request
 * is not a convenience anybody should want.
 */
export function parseArgs(argv: readonly string[]): RunArgs {
  const [requestId, seedEmail] = argv;

  if (!requestId || !seedEmail) {
    throw new Error('usage: run.ts <request-id> <subject-email>');
  }
  if (!seedEmail.includes('@')) {
    throw new Error(`"${seedEmail}" does not look like an email address`);
  }

  return { requestId, seedEmail };
}

/** Default backup rotation: 90 days out, on the demo estate's cycle. */
export function rotationDate(now: Date): string {
  return new Date(now.getTime() + 90 * 86_400_000).toISOString();
}



async function main(): Promise<void> {
  const baseUrl = process.env['TRUEFORGE_BASE_URL'];
  if (!baseUrl) {
    process.stderr.write('TRUEFORGE_BASE_URL is not set; refusing to guess where the harness is\n');
    process.exitCode = 2;
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env['TRUEFORGE_API_KEY'];

  // LETHE_SYSTEMS narrows both agents to the connectors that exist for this
  // run. The certificate's scope section reflects the narrowing honestly.
  const scout = scoutFromEnv(scoutAgent);
  const systems = process.env['LETHE_SYSTEMS']?.split(',').map((s) => s.trim());
  const executor = withExecutorConnectorFromEnv(
    withModelFromEnv(
      withoutSandboxFromEnv(
        systems
          ? restrictToSystems(executorAgent, systems.filter((name) => executorAgent.mcpServers.some((b) => b.name === name)))
          : executorAgent,
      ),
    ),
  );

  const shared = { baseUrl, ...(apiKey ? { apiKey } : {}) };
  const transport = new HttpTransport(shared);
  const catalog = new HttpToolCatalog(shared);

  // In-memory for the runbook. A real deployment backs the ledger with a
  // database — a suppression list that evaporates on restart is the
  // appearance of a control, not a control — and stores the salt with it.
  const ledger = new SuppressionLedger({ store: new InMemoryLedgerStore(), salt: generateSubjectSalt() });
  const subjectSalt = generateSubjectSalt();
  process.stdout.write(
    'note: ledger and salt are in-memory for this run; production backs both with storage\n\n',
  );

  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  // LETHE_SCRIPT queues answers for unattended runs — recordings, CI smoke of
  // the loop — separated by '|'. Interactive remains the default; the script
  // exists because a piped stdin and readline disagree about EOF on Windows,
  // and a demo should not depend on winning that argument.
  // Entries may be keyed ("escalate=...", "sign=..."), matched to the prompt
  // that is actually showing — a sequential script feeds the wrong prompt the
  // moment an optional question does not fire, and an answer meant for an
  // escalation then reads as a refusal at the gate.
  const scripted = (process.env['LETHE_SCRIPT'] ?? '').split('|').filter((a) => a.trim() !== '');
  const ask = async (prompt: string): Promise<string> => {
    const keyed = scripted.findIndex((entry) => {
      const key = entry.split('=')[0]?.trim().toLowerCase();
      if (key === 'escalate') return prompt.includes("'delete <reason>'");
      if (key === 'sign') return prompt.includes("'sign'");
      return false;
    });
    if (keyed >= 0) {
      const value = scripted.splice(keyed, 1)[0]!.split(/=(.*)/s)[1] ?? '';
      process.stdout.write(`${prompt}${value}
`);
      return value;
    }
    const queued = scripted.find((e) => !e.includes('=')) !== undefined ? scripted.shift() : undefined;
    if (queued !== undefined) {
      process.stdout.write(`${prompt}${queued}
`);
      return queued;
    }
    return terminal.question(prompt);
  };
  const seed: Identifier = { kind: 'email', value: args.seedEmail, system: 'acme-postgres' };
  const caseFile = new CaseFile(args.requestId);

  // One session per agent, created up front with the spec inline: the agent
  // the harness runs is exactly the object the startup assertions checked.
  const asManifest = (spec: typeof scoutAgent) =>
    toManifest(spec) as unknown as Readonly<Record<string, unknown>>;
  const scoutSession = await transport.createSession(asManifest(scout));
  const executorSession = await transport.createSession(asManifest(executor));

  try {
    // 1 — discovery, with identity questions answered by the person running this.
    process.stdout.write(`── discovery: sweeping for ${args.seedEmail}\n`);
    const discovery = await runDiscovery({
      caseFile,
      transport,
      catalog,
      scout,
      sessionId: scoutSession,
      seeds: [seed],
      responder: {
        async answer(question: QuestionRequest): Promise<string> {
          process.stdout.write(`\nthe scout asks: ${question.question}\n`);
          if (question.options.length > 0) {
            process.stdout.write(`options: ${question.options.join(' / ')}\n`);
          }
          return terminal.question('> ');
        },
      },
    });
    process.stdout.write(`   ${discovery.findings.length} finding(s) across ${new Set(discovery.findings.map((f) => f.system)).size} system(s)\n\n`);

    // 2 — plan, resolve what needs a person, measure; amend and re-measure
    // when the measurement says no. The planning loop is the product: an FK
    // violation becoming an anonymisation is it working, not failing.
    let plan = draftPlan(args.requestId, [seed], discovery.findings);

    for (const action of plan.actions) {
      if (action.disposition !== 'escalate') continue;
      process.stdout.write(`\na finding needs your decision (${action.findingId}):\n  ${action.justification}\n`);
      const decision = await ask("type 'delete <reason>' or 'retain <reason>': ");
      const match = decision.trim().match(/^(delete|retain)\s+(.+)$/i);
      if (!match) {
        process.stdout.write('no decision given; the finding stays escalated and the plan cannot be signed.\n');
        continue;
      }
      plan = resolveEscalation(plan, action.findingId, match[1]!.toLowerCase() as 'delete' | 'retain', match[2]!);
    }

    caseFile.recordPlan(plan);
    caseFile.transition('simulating', 'plan drafted');

    process.stdout.write('── simulation: applying the plan to a copy\n');
    let simulation = await runSimulation({
      caseFile,
      transport,
      catalog,
      scout,
      sessionId: scoutSession,
    });

    for (let round = 0; simulation.kind === 'blocked' && round < 2; round += 1) {
      process.stdout.write('   the measurement says no:\n');
      for (const blocker of simulation.blockers) process.stdout.write(`   - ${blocker}\n`);

      const before = caseFile.plan!;
      const amended = amendForViolations(before, simulation.blastRadius.constraintViolations);
      if (amended === before) {
        process.stdout.write('   nothing amendable (no violation names its trigger); stopping here.\n');
        return;
      }

      const converted = amended.actions.filter(
        (a, i) => a.disposition !== before.actions[i]?.disposition,
      ).length;
      process.stdout.write(
        `   amended: ${converted} action(s) converted to anonymise, citing the constraint. Re-measuring.\n`,
      );
      caseFile.recordPlan(amended);
      caseFile.transition('simulating', `re-simulating after amendment round ${round + 1}`);
      simulation = await runSimulation({ caseFile, transport, catalog, scout, sessionId: scoutSession });
    }

    if (simulation.kind === 'blocked') {
      process.stdout.write('   still blocked after amendment; a person needs to look at the plan itself:\n');
      for (const blocker of simulation.blockers) process.stdout.write(`   - ${blocker}\n`);
      return;
    }

    // 3 — the gate. The card is the same text the record keeps.
    const card = renderPlanCard(caseFile.plan!, caseFile.findings);
    if (card.kind !== 'renderable') {
      throw new Error(`plan card refused to render: ${JSON.stringify(card)}`);
    }

    process.stdout.write(`\n${formatPlanCard(card.card)}\n\n`);
    const answer = await ask(
      "type 'sign' to execute, or anything else as the reason for refusal: ",
    );

    if (answer.trim().toLowerCase() !== 'sign') {
      const reason = answer.trim() || 'refused at the terminal without a stated reason';
      caseFile.reject(operator(), reason);
      process.stdout.write(`\nrefusal recorded: ${reason}\n`);
      process.stdout.write('a refused erasure is itself a compliance event; the case is closed.\n');
      return;
    }

    caseFile.approve(operator());

    // 4 — execution, gates answered against the plan that was just signed.
    process.stdout.write('\n── execution\n');
    const execution = await runExecution({
      caseFile,
      transport,
      catalog,
      executor,
      sessionId: executorSession,
      ledger,
      backupRotatesAt: rotationDate(new Date()),
      ...(process.env['LETHE_EXECUTOR_CONNECTOR']
        ? { connectorAliases: { [process.env['LETHE_EXECUTOR_CONNECTOR']]: 'acme-postgres' } }
        : {}),
    });
    process.stdout.write(
      `   ${execution.callsAuthorised} call(s) authorised against the signed plan, ` +
        `${execution.identifiersSuppressed} identifier(s) suppressed\n\n`,
    );

    // 5 — verify, and only then certify.
    process.stdout.write('── verification: sweeping again, expecting nothing\n');
    const verification = await runVerification({
      caseFile,
      transport,
      catalog,
      scout,
      sessionId: scoutSession,
      ledger,
      subjectSalt,
    });

    if (verification.kind === 'incomplete') {
      process.stdout.write(
        `   ${verification.residualTraces} trace(s) remain. The case is back in ` +
          'executing for another pass — run again to continue.\n',
      );
      return;
    }

    const out = `${args.requestId}.certificate.json`;
    await writeFile(out, JSON.stringify(verification.certificate, null, 2));
    process.stdout.write(`\ncertified. ${out}\n`);
    if (verification.certificate.beyondUse) {
      process.stdout.write(
        `backups: ${verification.certificate.beyondUse.identifiersSuppressed} identifier(s) ` +
          `suppressed until ${verification.certificate.beyondUse.finalRotationAt}\n`,
      );
    }
  } finally {
    terminal.close();
  }
}

function operator(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'operator';
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await main();
}
