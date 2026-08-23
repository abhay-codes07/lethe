/**
 * Running discovery.
 *
 * The first code that drives an agent rather than describing one. It verifies
 * the connectors, starts a session, answers the scout's questions, parses what
 * comes back, and moves the case file from `discovering` to `planning`.
 *
 * The shape worth noticing: this function can fail in six places and each
 * failure leaves the case file honest. Nothing here half-succeeds. A run that
 * cannot verify its connectors, cannot understand the reply, or is asked a
 * question nobody answers, ends with the request marked failed rather than
 * with a partial set of findings that looks like a complete sweep.
 *
 * That matters because the next step after discovery is building a plan, and a
 * plan built from half a sweep deletes half a person — leaving the rest behind
 * while the certificate says otherwise.
 */

import type { AgentSpec } from '../agents/spec.ts';
import type { ToolCatalog } from '../connectors/catalog.ts';
import { verifyOrThrow, type VerificationReport } from '../connectors/verify.ts';
import type { Finding } from '../domain/finding.ts';
import { IdentityGraph, type Identifier } from '../domain/identity.ts';
import type { CaseFile } from '../lifecycle/case-file.ts';
import { TurnRunner, type QuestionRequest, type RunOutcome } from '../harness/turn-runner.ts';
import type { Transport } from '../harness/transport.ts';
import { formatErrors, parseFindings } from './parse.ts';

/**
 * Answers the scout's clarifying questions.
 *
 * Supplied by the caller rather than defaulted, because there is no safe
 * default. "Two accounts share this email — same person?" answered wrongly by
 * a machine either erases a stranger's data or leaves the subject's behind,
 * and both are the kind of mistake a person is supposed to be there for.
 */
export interface QuestionResponder {
  answer(question: QuestionRequest): Promise<string>;
}

export interface DiscoveryOptions {
  readonly caseFile: CaseFile;
  readonly transport: Transport;
  readonly catalog: ToolCatalog;
  readonly scout: AgentSpec;
  readonly sessionId: string;
  /** Verified out of band before the request was accepted. */
  readonly seeds: readonly Identifier[];
  readonly responder: QuestionResponder;
  /** Bound on clarification rounds, so a confused run ends rather than loops. */
  readonly maxQuestionRounds?: number;
}

export interface DiscoveryResult {
  readonly findings: readonly Finding[];
  readonly identities: IdentityGraph;
  readonly verification: readonly VerificationReport[];
  readonly turnId: string;
}

const DEFAULT_QUESTION_ROUNDS = 5;

export class DiscoveryError extends Error {
  readonly stage: DiscoveryStage;

  constructor(stage: DiscoveryStage, message: string) {
    super(message);
    this.name = 'DiscoveryError';
    this.stage = stage;
  }
}

export type DiscoveryStage =
  | 'verification'
  | 'transition'
  | 'run'
  | 'clarification'
  | 'parsing'
  | 'approval';

/**
 * Discover every trace of the subject.
 *
 * On any failure the case file is moved to `failed` with the reason, so a
 * stalled request is visibly stalled rather than sitting in `discovering`
 * looking like work in progress.
 */
export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const { caseFile, scout, seeds } = options;

  if (seeds.length === 0) {
    throw fail(caseFile, 'verification', 'discovery needs at least one verified seed identifier');
  }

  // Verification runs before the case file moves, so a misconfigured connector
  // never produces a request that looks like it started.
  let verification: readonly VerificationReport[];
  try {
    verification = await verifyOrThrow([{ spec: scout, expectReadOnly: true }], options.catalog);
  } catch (error) {
    throw fail(caseFile, 'verification', (error as Error).message);
  }

  caseFile.transition('discovering', `sweeping ${scout.mcpServers.length} system(s)`);

  const identities = new IdentityGraph(seeds);
  caseFile.recordIdentities(identities);

  const runner = new TurnRunner(options.transport, options.sessionId);
  const knownSystems = new Set(scout.mcpServers.map((binding) => binding.name));

  let outcome: RunOutcome;
  try {
    outcome = await runner.start(discoveryPrompt(seeds, [...knownSystems]));
  } catch (error) {
    throw fail(caseFile, 'run', `discovery turn failed: ${(error as Error).message}`);
  }

  outcome = await answerQuestions(outcome, runner, options);

  switch (outcome.kind) {
    case 'completed':
      break;
    case 'awaiting_approval':
      // The scout holds no tools that can write, so a gate here means it was
      // given one it should not have. Verification is meant to make this
      // unreachable; if it happens, the guarantee has been broken.
      throw fail(
        caseFile,
        'approval',
        'discovery paused for tool approval, but the scout must hold nothing ' +
          'that requires one. Its bindings are not what verification reported.',
      );
    case 'blocked':
      throw fail(caseFile, 'run', 'discovery stopped at a gate that could not be rendered');
    case 'awaiting_answer':
      throw fail(
        caseFile,
        'clarification',
        'discovery is still asking questions after the round limit; stopping ' +
          'rather than looping.',
      );
    case 'failed':
      throw fail(caseFile, 'run', `discovery turn ended ${outcome.status}`);
  }

  const reply = lastReply(runner);
  if (reply === undefined) {
    throw fail(caseFile, 'parsing', 'discovery finished without a reply to parse');
  }

  const parsed = parseFindings(reply, { knownSystems, identities });
  if (!parsed.ok) {
    throw fail(
      caseFile,
      'parsing',
      `discovery returned findings that cannot be trusted:\n${formatErrors(parsed.errors)}`,
    );
  }

  caseFile.recordFindings(parsed.findings);
  caseFile.transition('planning', `${parsed.findings.length} finding(s) across ${knownSystems.size} system(s)`);

  return {
    findings: parsed.findings,
    identities,
    verification,
    turnId: outcome.turnId,
  };
}

/**
 * Answer clarifications until the scout stops asking or the bound is reached.
 *
 * Bounded because an agent that misunderstands the task can ask forever, and
 * an erasure request sitting in a question loop is one quietly consuming its
 * statutory month.
 */
async function answerQuestions(
  outcome: RunOutcome,
  runner: TurnRunner,
  options: DiscoveryOptions,
): Promise<RunOutcome> {
  const limit = options.maxQuestionRounds ?? DEFAULT_QUESTION_ROUNDS;
  let current = outcome;

  for (let round = 0; round < limit && current.kind === 'awaiting_answer'; round += 1) {
    const answers = new Map<string, string>();

    for (const question of current.questions) {
      try {
        answers.set(question.toolCallId, await options.responder.answer(question));
      } catch (error) {
        throw fail(
          options.caseFile,
          'clarification',
          `could not answer "${question.question}": ${(error as Error).message}`,
        );
      }
    }

    try {
      current = await runner.respondToQuestions(answers);
    } catch (error) {
      throw fail(options.caseFile, 'clarification', (error as Error).message);
    }
  }

  return current;
}

/** The assembled text of the scout's final message. */
function lastReply(runner: TurnRunner): string | undefined {
  const withContent = runner.index.messages().filter((message) => message.content.trim() !== '');
  return withContent.at(-1)?.content;
}

/**
 * Mark the request failed and return the error to throw.
 *
 * Returning rather than throwing so call sites read `throw fail(...)`, which
 * keeps the control flow visible instead of hiding a throw inside a helper.
 */
function fail(caseFile: CaseFile, stage: DiscoveryStage, message: string): DiscoveryError {
  // A case file already terminal cannot be moved, and trying would replace the
  // real failure with a confusing one about state transitions.
  try {
    caseFile.transition('failed', `${stage}: ${message}`);
  } catch {
    // Already terminal; the original failure is the one that matters.
  }

  return new DiscoveryError(stage, message);
}

function discoveryPrompt(seeds: readonly Identifier[], systems: readonly string[]): string {
  const seedList = seeds.map((seed) => `  - ${seed.kind}: ${seed.value} (in ${seed.system})`).join('\n');

  return [
    'Locate every trace of this data subject across the connected systems.',
    '',
    'Verified seed identifiers:',
    seedList,
    '',
    `Systems to sweep: ${systems.join(', ')}`,
    '',
    'Delegate one subagent per system and run them in parallel. Count records',
    'in code rather than estimating. Do not include personal data in your',
    'reply — a locator and a count describe a deletion without reproducing',
    'what is being deleted.',
    '',
    'Every finding must be attached to one of the seed identifiers above or to',
    'an identifier you derived from them and reported. If you cannot justify',
    'the link, ask rather than assume.',
    '',
    'Reply with JSON only, in this shape:',
    '{"findings":[{"id":"","system":"","locator":{"kind":"table","schema":"",',
    '"table":"","predicate":""},"category":"","durability":"","count":0,',
    '"matchedBy":{"kind":"","value":"","system":""},"observedAt":""}]}',
    '',
    'durability is hard_delete, requires_compaction, or immutable_until_expiry.',
    'Use requires_compaction wherever a delete only tombstones the data.',
  ].join('\n');
}
