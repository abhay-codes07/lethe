/**
 * Measuring a plan before anyone is asked to sign it.
 *
 * The approval card's authority is that every number on it was measured, not
 * estimated. This is where the measuring happens: the read-only scout applies
 * the drafted plan to a copy — a snapshot restored in its sandbox, or a
 * transaction it rolls back — and reports what would have broken.
 *
 * The scout, again, and for the same reason as verification: an agent that
 * simulates a deletion must be incapable of performing one. The whole value
 * of a dry run is that nothing happened, and only a read-only credential
 * makes that a property rather than a promise.
 *
 * The output is a blast radius, parsed as adversarially as findings are. A
 * fabricated "0 constraint violations" is worse than a missing one — it
 * becomes a number on the card a person signs.
 */

import type { AgentSpec } from '../agents/spec.ts';
import type { ToolCatalog } from '../connectors/catalog.ts';
import { verifyOrThrow } from '../connectors/verify.ts';
import { describeLocator } from '../domain/finding.ts';
import { approvalBlockers, withBlastRadius, type BlastRadius, type ConstraintViolation } from '../domain/plan.ts';
import { TurnRunner, type RunOutcome } from '../harness/turn-runner.ts';
import type { Transport } from '../harness/transport.ts';
import type { CaseFile } from '../lifecycle/case-file.ts';

export type SimulationStage = 'preconditions' | 'verification' | 'run' | 'parsing';

export class SimulationError extends Error {
  readonly stage: SimulationStage;

  constructor(stage: SimulationStage, message: string) {
    super(message);
    this.name = 'SimulationError';
    this.stage = stage;
  }
}

export interface SimulationOptions {
  readonly caseFile: CaseFile;
  readonly transport: Transport;
  readonly catalog: ToolCatalog;
  /** The read-only scout: a dry run must be incapable of being a wet one. */
  readonly scout: AgentSpec;
  readonly sessionId: string;
}

export type SimulationResult =
  /** Measured clean. The plan is signable and the case awaits approval. */
  | { readonly kind: 'ready'; readonly blastRadius: BlastRadius }
  /**
   * Measured, and the measurement says no. The case is back in planning with
   * the blockers as the reason — an FK violation forcing anonymisation is the
   * expected path here, not an exception.
   */
  | {
      readonly kind: 'blocked';
      readonly blastRadius: BlastRadius;
      readonly blockers: readonly string[];
    };

export async function runSimulation(options: SimulationOptions): Promise<SimulationResult> {
  const { caseFile, scout } = options;

  if (caseFile.state !== 'simulating') {
    throw new SimulationError(
      'preconditions',
      `request ${caseFile.requestId} is ${caseFile.state}; simulation follows planning.`,
    );
  }

  const plan = caseFile.plan;
  if (!plan) {
    throw new SimulationError('preconditions', 'case file holds no plan to simulate');
  }
  if (plan.status !== 'draft') {
    throw new SimulationError(
      'preconditions',
      `plan is ${plan.status}; only a draft is simulated — a simulated plan that ` +
        'is re-simulated without an edit measures nothing new.',
    );
  }

  try {
    await verifyOrThrow([{ spec: scout, expectReadOnly: true }], options.catalog);
  } catch (error) {
    throw fail(caseFile, 'verification', (error as Error).message);
  }

  const runner = new TurnRunner(options.transport, options.sessionId);

  let outcome: RunOutcome;
  try {
    outcome = await runner.start(simulationPrompt(caseFile));
  } catch (error) {
    throw fail(caseFile, 'run', `simulation turn failed: ${(error as Error).message}`);
  }

  if (outcome.kind !== 'completed') {
    // The plan is fixed and the identifiers known: nothing to ask, nothing to
    // gate. Anything but completion is a broken dry run.
    throw fail(caseFile, 'run', `simulation ended as ${outcome.kind}`);
  }

  let reply = runner.index.messages().filter((m) => m.content.trim() !== '').at(-1)?.content;
  if (reply === undefined) {
    // Same live observation as discovery and verification: the stream can
    // lose the reply; the merged-events replay has it.
    try {
      await runner.reconnect(outcome.turnId);
      reply = runner.index.messages().filter((m) => m.content.trim() !== '').at(-1)?.content;
    } catch {
      // fall through
    }
  }
  if (reply === undefined) {
    throw fail(caseFile, 'parsing', 'simulation finished without a reply');
  }

  const parsed = parseBlastRadius(reply);
  if (!parsed.ok) {
    throw fail(caseFile, 'parsing', `simulation reply cannot be trusted: ${parsed.error}`);
  }

  const simulated = withBlastRadius(plan, parsed.blastRadius);
  caseFile.recordPlan(simulated);

  const blockers = approvalBlockers(simulated);
  if (blockers.length > 0) {
    // The measurement worked and the answer is "not like this". Back to
    // planning with the reasons — the expected loop, not a failure.
    caseFile.transition('planning', `simulation blocked approval: ${blockers.join('; ')}`);
    return { kind: 'blocked', blastRadius: parsed.blastRadius, blockers };
  }

  caseFile.transition('awaiting_approval', 'simulation clean; plan is signable');
  return { kind: 'ready', blastRadius: parsed.blastRadius };
}

type ParsedBlastRadius = { ok: true; blastRadius: BlastRadius } | { ok: false; error: string };

/**
 * Parse the scout's measurement.
 *
 * Every field is checked, because every field ends up on the card. The rules
 * mirror findings parsing: nothing is defaulted, nothing malformed is
 * repaired, and one bad field rejects the reply.
 */
export function parseBlastRadius(raw: string): ParsedBlastRadius {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'reply is not valid JSON' };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, error: 'expected an object with a "blastRadius" property' };
  }

  const bag = payload as Record<string, unknown>;
  const radius = bag['blastRadius'];
  if (typeof radius !== 'object' || radius === null || Array.isArray(radius)) {
    return { ok: false, error: 'expected a "blastRadius" object' };
  }

  const r = radius as Record<string, unknown>;

  const orphaned = r['orphanedRecords'];
  if (typeof orphaned !== 'number' || !Number.isSafeInteger(orphaned) || orphaned < 0) {
    return { ok: false, error: 'orphanedRecords must be a whole non-negative number' };
  }

  const residual = r['residualTraces'];
  if (typeof residual !== 'number' || !Number.isSafeInteger(residual) || residual < 0) {
    return { ok: false, error: 'residualTraces must be a whole non-negative number' };
  }

  const snapshotId = r['snapshotId'];
  if (typeof snapshotId !== 'string' || snapshotId.trim() === '') {
    // Without naming the copy it measured against, "0 violations" is a claim
    // about nothing in particular.
    return { ok: false, error: 'snapshotId must name the snapshot the plan was applied to' };
  }

  const simulatedAt = r['simulatedAt'];
  if (typeof simulatedAt !== 'string' || Number.isNaN(Date.parse(simulatedAt))) {
    return { ok: false, error: 'simulatedAt must be an ISO timestamp' };
  }

  const rawViolations = r['constraintViolations'];
  if (!Array.isArray(rawViolations)) {
    return { ok: false, error: 'constraintViolations must be an array (empty when none)' };
  }

  const violations: ConstraintViolation[] = [];
  for (const [index, entry] of rawViolations.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: `constraintViolations[${index}] must be an object` };
    }
    const v = entry as Record<string, unknown>;
    const constraint = v['constraint'];
    const table = v['table'];
    const affectedRows = v['affectedRows'];

    if (typeof constraint !== 'string' || constraint === '') {
      return { ok: false, error: `constraintViolations[${index}].constraint must name the constraint` };
    }
    if (typeof table !== 'string' || table === '') {
      return { ok: false, error: `constraintViolations[${index}].table must name the table` };
    }
    if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows) || affectedRows < 0) {
      return { ok: false, error: `constraintViolations[${index}].affectedRows must be a whole number` };
    }

    violations.push({
      constraint,
      table,
      affectedRows,
      ...(typeof v['resolution'] === 'string' && v['resolution'] !== ''
        ? { resolution: v['resolution'] as string }
        : {}),
      ...(typeof v['triggeredBy'] === 'string' && v['triggeredBy'] !== ''
        ? { triggeredBy: v['triggeredBy'] as string }
        : {}),
    });
  }

  return {
    ok: true,
    blastRadius: {
      constraintViolations: violations,
      orphanedRecords: orphaned,
      residualTraces: residual,
      snapshotId,
      simulatedAt,
    },
  };
}

function fail(caseFile: CaseFile, stage: SimulationStage, message: string): SimulationError {
  try {
    caseFile.transition('failed', `${stage}: ${message}`);
  } catch {
    // Already terminal; the original failure matters more.
  }
  return new SimulationError(stage, message);
}

function simulationPrompt(caseFile: CaseFile): string {
  const plan = caseFile.plan!;
  const byId = new Map(caseFile.findings.map((f) => [f.id, f]));

  const lines = plan.actions.map((action) => {
    const finding = byId.get(action.findingId);
    const where = finding ? `${finding.system}: ${describeLocator(finding.locator)}` : action.findingId;
    return `  - [${action.findingId}] ${action.disposition.toUpperCase()} ${where} (${action.count} record(s))`;
  });

  return [
    `Simulate erasure plan ${plan.requestId} without changing anything.`,
    '',
    'The plan:',
    ...lines,
    '',
    'Apply it to a copy, never to the live data: restore a snapshot in your',
    'sandbox, or run the statements inside a transaction you roll back. Then',
    'measure:',
    '  - every referential constraint the deletions would violate, by name,',
    '    each with "triggeredBy" set to the [finding id] of the plan line',
    '    whose statement violated it — amendment is deterministic only when',
    '    the trigger is named',
    '  - how many rows would be left orphaned',
    '  - residualTraces: traces of the subject that the plan CLAIMS to remove',
    '    but which would survive it. Rows the plan explicitly RETAINs or',
    '    ANONYMISEs are accounted for, not residual — a retained legal hold',
    '    still naming the subject is the plan working, not failing.',
    '',
    'Count in code. Report what you measured, exactly — a violation you',
    'find now is a correction to the plan; one that appears during execution',
    'is an incident.',
    '',
    'Reply with JSON only, in this shape:',
    '{"blastRadius":{"constraintViolations":[{"constraint":"","table":"",',
    '"affectedRows":0,"resolution":"","triggeredBy":""}],"orphanedRecords":0,',
    '"residualTraces":0,"snapshotId":"","simulatedAt":""}}',
    '',
    'snapshotId names the copy you measured against.',
  ].join('\n');
}
