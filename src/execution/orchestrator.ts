/**
 * Running an approved plan.
 *
 * The mirror of discovery's orchestrator, with the opposite temperament.
 * Discovery is exploratory: it fans out, follows links, asks questions.
 * Execution is a clerk: it does exactly what the signed plan says, answers
 * the harness's per-call gates by checking each call against that plan, and
 * stops the moment anything falls outside it.
 *
 * The gate-answering is the part worth understanding. The human already made
 * their decision — once, on a measured plan card. The harness still pauses
 * before every destructive tool call, and those pauses are answered here,
 * mechanically: a call that reconciles against a line of the signed plan is
 * allowed, because allowing it is exactly what the signature meant; a call
 * that does not is denied and ends the run, because the plan is the whole of
 * the executor's authority and a call outside it has none. Asking the human
 * again per call would be worse, not better — twenty rubber-stamp prompts
 * after the real decision teach people to stop reading.
 */

import type { AgentSpec } from '../agents/spec.ts';
import type { ToolCatalog } from '../connectors/catalog.ts';
import { verifyOrThrow } from '../connectors/verify.ts';
import { describeLocator, type Finding } from '../domain/finding.ts';
import type { ApprovalDecision } from '../harness/protocol.ts';
import { TurnRunner, type RunOutcome } from '../harness/turn-runner.ts';
import type { Transport } from '../harness/transport.ts';
import type { CaseFile } from '../lifecycle/case-file.ts';
import { explainUnauthorised } from '../review/reconcile.ts';
import type { SuppressionLedger } from '../suppression/ledger.ts';

export type ExecutionStage =
  | 'preconditions'
  | 'verification'
  | 'run'
  | 'gates'
  | 'scope'
  | 'suppression';

export class ExecutionError extends Error {
  readonly stage: ExecutionStage;

  constructor(stage: ExecutionStage, message: string) {
    super(message);
    this.name = 'ExecutionError';
    this.stage = stage;
  }
}

export interface ExecutionOptions {
  readonly caseFile: CaseFile;
  readonly transport: Transport;
  readonly catalog: ToolCatalog;
  readonly executor: AgentSpec;
  readonly sessionId: string;
  /** Records what was erased so a backup restore cannot bring it back. */
  readonly ledger: SuppressionLedger;
  /** When the backup media holding the erased data rotates out. */
  readonly backupRotatesAt: string;
  /** Bound on gate rounds, so a looping executor ends rather than grinds. */
  readonly maxGateRounds?: number;
  /**
   * Physical connector → logical system, e.g. acme-postgres-rw →
   * acme-postgres. The plan speaks in systems; a credential split means the
   * executor reaches the same system through a differently-named connector,
   * and reconciliation must compare like with like.
   */
  readonly connectorAliases?: Readonly<Record<string, string>>;
}

export interface ExecutionResult {
  readonly turnId: string;
  /** Gated calls allowed because they reconciled against the signed plan. */
  readonly callsAuthorised: number;
  /** Identifiers recorded on the suppression ledger. */
  readonly identifiersSuppressed: number;
}

// Observed live: the harness's natural cadence is one gated call per round —
// the model issues a statement, awaits its result, issues the next. A plan of
// fifteen actions plus the id-resolving reads before them is comfortably
// forty rounds of ordinary progress. The bound guards against a loop, not
// against thoroughness.
const DEFAULT_GATE_ROUNDS = 80;

/**
 * Whether a SQL string provably cannot write.
 *
 * Provably, not plausibly: one statement, starting as a SELECT (WITH-prefixed
 * allowed), containing no write keyword anywhere — data-modifying CTEs are
 * caught by the keyword scan — and no statement separator that could smuggle
 * a second statement. Anything this cannot prove goes to reconciliation.
 */
export function isReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) return false;
  if (!/^\s*(?:with\b[\s\S]*?)?select\b/i.test(trimmed)) return false;
  if (/\b(?:insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|call|do)\b/i.test(trimmed)) {
    return false;
  }
  return true;
}

/** Dispositions the executor acts on. Everything else it must not touch. */
const ACTIONABLE = new Set(['delete', 'delete_and_compact', 'anonymise']);

/**
 * Execute the signed plan, end to end.
 *
 * Preconditions are the case file's, not this function's: it must already be
 * `executing`, which only `approve()` can produce, which re-checks the plan.
 * On any failure the case file is moved to `failed` with the stage and
 * reason, so a half-executed request is visibly broken rather than quietly
 * abandoned between states.
 */
export async function runExecution(options: ExecutionOptions): Promise<ExecutionResult> {
  const { caseFile, executor } = options;

  if (caseFile.state !== 'executing') {
    // Not a case-file transition to failed: nothing has been started, and
    // failing a request because the caller invoked execution out of order
    // would punish the subject for a programming error.
    throw new ExecutionError(
      'preconditions',
      `request ${caseFile.requestId} is ${caseFile.state}; execution requires an ` +
        'approved plan, which only approve() can produce.',
    );
  }

  const plan = caseFile.plan;
  if (!plan) {
    throw new ExecutionError('preconditions', 'case file holds no plan to execute');
  }

  try {
    await verifyOrThrow([{ spec: executor, expectReadOnly: false }], options.catalog);
  } catch (error) {
    throw fail(caseFile, 'verification', (error as Error).message);
  }

  const findings = caseFile.findings;
  const runner = new TurnRunner(options.transport, options.sessionId);

  let outcome: RunOutcome;
  try {
    outcome = await runner.start(
      executionPrompt(plan.requestId, findings, plan, caseFile.identities?.all() ?? []),
    );
  } catch (error) {
    throw fail(caseFile, 'run', `execution turn failed: ${(error as Error).message}`);
  }

  let callsAuthorised = 0;
  const limit = options.maxGateRounds ?? DEFAULT_GATE_ROUNDS;

  for (let round = 0; round < limit && outcome.kind === 'awaiting_approval'; round += 1) {
    // A plan's predicates are symbolic ("customer_id = :derived_user_id");
    // resolving them takes SELECTs, and gating execute_sql wholesale gates
    // those too. A statement that provably cannot write is allowed without a
    // plan line — it is reading, and reading is the scout's whole job done
    // with the executor's credential. Anything not provably read-only goes
    // through reconciliation like every write.
    const aliases = options.connectorAliases ?? {};
    const aliased = outcome.requests.map((request) => {
      const call = request.call;
      if (!call.complete || !call.serverName || !(call.serverName in aliases)) return request;
      return { ...request, call: { ...call, serverName: aliases[call.serverName]! } };
    });

    const readDecisions = new Map<string, ApprovalDecision>();
    const writeRequests = aliased.filter((request) => {
      const call = request.call;
      if (call.complete && call.name === 'execute_sql') {
        const sql = call.arguments['sql'];
        if (typeof sql === 'string' && isReadOnlySql(sql)) {
          readDecisions.set(request.toolCallId, { status: 'allow' });
          return false;
        }
      }
      return true;
    });

    if (writeRequests.length === 0) {
      callsAuthorised += readDecisions.size;
      try {
        outcome = await runner.respondToApprovals(readDecisions);
      } catch (error) {
        throw fail(caseFile, 'gates', (error as Error).message);
      }
      continue;
    }

    const reconciliation = caseFile.authoriseCalls(writeRequests);

    if (reconciliation.kind === 'scope_violation') {
      // Every call is denied — the authorised ones too. One call outside the
      // signed plan means the executor has drifted from its authority, and
      // letting the rest of the batch proceed would continue a run that has
      // already tried to exceed it. The denials are delivered before the run
      // is failed so the refusal, and its reason, land in the turn's own
      // record rather than only in ours.
      const decisions = new Map<string, ApprovalDecision>(readDecisions);
      for (const call of reconciliation.unauthorised) {
        decisions.set(call.request.toolCallId, { status: 'deny', reason: explainUnauthorised(call) });
      }
      for (const call of reconciliation.authorised) {
        decisions.set(call.request.toolCallId, {
          status: 'deny',
          reason: 'run aborted: the same batch contained a call outside the signed plan',
        });
      }

      try {
        await runner.respondToApprovals(decisions);
      } catch {
        // The denials could not be delivered; the failure below still stands.
      }

      const detail = reconciliation.unauthorised.map(explainUnauthorised).join('; ');
      throw fail(caseFile, 'scope', `execution exceeded the signed plan: ${detail}`);
    }

    const decisions = new Map<string, ApprovalDecision>(readDecisions);
    for (const call of reconciliation.calls) {
      decisions.set(call.request.toolCallId, { status: 'allow' });
    }
    callsAuthorised += decisions.size;

    try {
      outcome = await runner.respondToApprovals(decisions);
    } catch (error) {
      throw fail(caseFile, 'gates', (error as Error).message);
    }
  }

  switch (outcome.kind) {
    case 'completed':
      break;
    case 'awaiting_approval':
      throw fail(
        caseFile,
        'gates',
        `execution is still requesting approvals after ${limit} rounds; stopping ` +
          'rather than looping.',
      );
    case 'awaiting_answer':
      // The executor's whole authority is the plan. A question means the plan
      // is ambiguous, and an ambiguous plan is re-planned, not interpreted by
      // whoever happens to be watching the run.
      throw fail(
        caseFile,
        'run',
        'the executor asked a question mid-run. The signed plan is its entire ' +
          'authority; ambiguity means re-planning, not interpretation.',
      );
    case 'blocked': {
      const detail = outcome.unresolved
        .map((r) => `${r.call.complete ? r.call.name : r.toolCallId}: ${r.call.complete ? 'complete?' : r.call.reason}`)
        .join('; ');
      throw fail(caseFile, 'run', `execution stopped at a gate that could not be rendered (${detail})`);
    }
    case 'failed':
      throw fail(caseFile, 'run', `execution turn ended ${outcome.status}`);
  }

  // Suppression covers anonymised findings too: the record kept in the live
  // system is severed from the subject, but the backup still holds the
  // original, and a restore would reintroduce the link that was just cut.
  const acted = new Map(
    plan.actions
      .filter((action) => ACTIONABLE.has(action.disposition))
      .map((action) => [action.findingId, action] as const),
  );

  let identifiersSuppressed = 0;
  const suppressed = new Set<string>();

  for (const finding of findings) {
    if (!acted.has(finding.id)) continue;

    const key = `${finding.matchedBy.system}:${finding.matchedBy.kind}:${finding.matchedBy.value}`;
    if (suppressed.has(key)) continue;
    suppressed.add(key);

    try {
      await options.ledger.suppress(finding.matchedBy, plan.requestId, options.backupRotatesAt);
      identifiersSuppressed += 1;
    } catch (error) {
      // An erasure that executed but was never recorded on the ledger is the
      // worst of both worlds: the data is gone from live systems and the next
      // backup restore quietly brings it back.
      throw fail(caseFile, 'suppression', (error as Error).message);
    }
  }

  caseFile.transition(
    'verifying',
    `execution complete: ${callsAuthorised} call(s) authorised, ` +
      `${identifiersSuppressed} identifier(s) suppressed`,
  );

  return { turnId: outcome.turnId, callsAuthorised, identifiersSuppressed };
}

function fail(caseFile: CaseFile, stage: ExecutionStage, message: string): ExecutionError {
  try {
    caseFile.transition('failed', `${stage}: ${message}`);
  } catch {
    // Already terminal; the original failure matters more.
  }
  return new ExecutionError(stage, message);
}

/**
 * The executor's brief: the plan, verbatim, and nothing else.
 *
 * Lines the plan decided not to act on are listed explicitly rather than
 * omitted. An executor that never heard about the legal hold might "helpfully"
 * delete it when a query happens to surface it; one that was told hands-off
 * has no such excuse, and a violation is unambiguous.
 */
function executionPrompt(
  requestId: string,
  findings: readonly Finding[],
  plan: NonNullable<CaseFile['plan']>,
  identities: readonly { readonly identifier: { kind: string; value: string; system: string } }[],
): string {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));

  const act: string[] = [];
  const handsOff: string[] = [];

  for (const action of plan.actions) {
    const finding = byId.get(action.findingId);
    const where = finding ? `${finding.system}: ${describeLocator(finding.locator)}` : action.findingId;
    const line = `  - ${action.disposition.toUpperCase()} ${where} (${action.count} record(s))`;

    if (ACTIONABLE.has(action.disposition)) act.push(line);
    else handsOff.push(`${line} — ${action.justification}`);
  }

  const bindings = identities.map(
    (r) => `  - ${r.identifier.kind} (${r.identifier.system}): ${r.identifier.value}`,
  );

  return [
    `Execute erasure plan ${requestId} exactly as written. It has been approved`,
    'by a person and is the whole of your authority.',
    '',
    // Discovery redacts its predicates, so the plan reads symbolically
    // (:seed_email, :derived_user_id). Execution is the one place the values
    // belong: this agent is deleting the data, and a plan it cannot bind is
    // authority it cannot use. The subject identifiers, verbatim:
    'Subject identifiers — bind any placeholder in the plan to these:',
    ...(bindings.length > 0 ? bindings : ['  (none recorded)']),
    '',
    'Actions:',
    ...act,
    '',
    'Do not touch, under any circumstances:',
    ...(handsOff.length > 0 ? handsOff : ['  (nothing is exempt)']),
    '',
    'Issue ONE SQL statement per tool call, and each statement must write to',
    'exactly one table. Every call is checked against the signed plan by its',
    'target table before it is allowed; batched statements or multi-table',
    'writes cannot be attributed to a plan line and are denied, ending the',
    'run. Reads (plain SELECTs) are allowed freely to resolve identifiers.',
    '',
    'Order of operations matters. First resolve every identifier you will',
    'need into literal values with SELECTs. Then perform the deletes. Then',
    'anonymise identity-bearing rows (users last of all) — anonymising them',
    'early severs the very lookups your remaining statements depend on, and a',
    'DELETE that matches zero rows reports success while erasing nothing.',
    '',
    'Where the plan says anonymise, sever the link to the subject and keep the',
    'record. Compaction is owed only where a plan line itself says delete and',
    "compact, and then through that store's own compaction operation. Never",
    'issue storage-maintenance SQL (VACUUM, ANALYZE, REINDEX, CLUSTER): it does',
    'not name the rows it touches, so it cannot be checked against the plan and',
    'is denied, ending the run. Row-level erasure is the whole of the job;',
    'reclaiming physical storage belongs to the platform, not this run. If a',
    'line no longer applies, stop and report rather than improvising a',
    'replacement. Never widen scope: data the plan does not cover means a new',
    'plan, not a bigger run.',
  ].join('\n');
}
