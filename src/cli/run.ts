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
import { HttpToolCatalog } from '../connectors/http-catalog.ts';
import { generateSubjectSalt } from '../domain/certificate.ts';
import type { Identifier } from '../domain/identity.ts';
import { draftPlan } from '../domain/plan.ts';
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
  const seed: Identifier = { kind: 'email', value: args.seedEmail, system: 'acme-postgres' };
  const caseFile = new CaseFile(args.requestId);

  // One session per agent, created up front with the spec inline: the agent
  // the harness runs is exactly the object the startup assertions checked.
  const asManifest = (spec: typeof scoutAgent) =>
    toManifest(spec) as unknown as Readonly<Record<string, unknown>>;
  const scoutSession = await transport.createSession(asManifest(scoutAgent));
  const executorSession = await transport.createSession(asManifest(executorAgent));

  try {
    // 1 — discovery, with identity questions answered by the person running this.
    process.stdout.write(`── discovery: sweeping for ${args.seedEmail}\n`);
    const discovery = await runDiscovery({
      caseFile,
      transport,
      catalog,
      scout: scoutAgent,
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

    // 2 — plan and measure.
    caseFile.recordPlan(draftPlan(args.requestId, [seed], discovery.findings));
    caseFile.transition('simulating', 'plan drafted');

    process.stdout.write('── simulation: applying the plan to a copy\n');
    const simulation = await runSimulation({
      caseFile,
      transport,
      catalog,
      scout: scoutAgent,
      sessionId: scoutSession,
    });

    if (simulation.kind === 'blocked') {
      process.stdout.write('   the measurement says no. The case is back in planning:\n');
      for (const blocker of simulation.blockers) process.stdout.write(`   - ${blocker}\n`);
      return;
    }

    // 3 — the gate. The card is the same text the record keeps.
    const card = renderPlanCard(caseFile.plan!, caseFile.findings);
    if (card.kind !== 'renderable') {
      throw new Error(`plan card refused to render: ${JSON.stringify(card)}`);
    }

    process.stdout.write(`\n${formatPlanCard(card.card)}\n\n`);
    const answer = await terminal.question(
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
      executor: executorAgent,
      sessionId: executorSession,
      ledger,
      backupRotatesAt: rotationDate(new Date()),
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
      scout: scoutAgent,
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
