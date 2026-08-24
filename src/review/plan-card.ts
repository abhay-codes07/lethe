/**
 * The erasure plan card.
 *
 * This is the last thing a person sees before authorising permanent deletion,
 * and the only evidence they have when they do. Everything else in the system
 * exists to make this screen truthful.
 *
 * The design rule is that the card describes a *measured consequence*, never a
 * proposed action. "Approve delete_rows?" invites a rubber stamp because there
 * is nothing to evaluate. "1,247 rows across 9 tables, 0 constraint
 * violations, 0 traces remaining on the snapshot, 14 rows anonymised instead
 * of deleted because a hard delete would orphan 41 order lines" is a decision
 * someone can actually make in ten seconds.
 *
 * The card therefore refuses to render at all when the facts behind it are not
 * good enough — see `renderPlanCard`. A card that renders regardless of the
 * evidence is the rubber stamp with extra formatting.
 */

import { describeLocator, type Finding } from '../domain/finding.ts';
import {
  approvalBlockers,
  type Disposition,
  type ErasurePlan,
  irreversibleRecordCount,
  summarise,
} from '../domain/plan.ts';

export interface PlanCardLine {
  readonly disposition: Disposition;
  readonly system: string;
  readonly location: string;
  readonly count: number;
  readonly justification: string;
  readonly citation?: string;
  readonly irreversible: boolean;
  /** For `unerasable`: the committed path out, shown on its own line. */
  readonly remediation?: string;
}

export interface PlanCard {
  readonly requestId: string;
  readonly lines: readonly PlanCardLine[];
  readonly totals: ReturnType<typeof summarise>;
  /** Records that would be destroyed unrecoverably. The number that matters. */
  readonly irreversibleRecords: number;
  readonly simulation: SimulationSummary;
  /** Shown verbatim above the buttons. Never softened. */
  readonly warning: string;
}

export interface SimulationSummary {
  readonly snapshotId: string;
  readonly simulatedAt: string;
  readonly constraintViolations: number;
  readonly orphanedRecords: number;
  readonly residualTraces: number;
}

export type PlanCardResult =
  | { readonly kind: 'renderable'; readonly card: PlanCard }
  /**
   * The plan is not in a state anyone should be asked to sign. Carries the
   * blockers so the interface can say which gate is closed rather than
   * greying out a button with no explanation.
   */
  | { readonly kind: 'not_approvable'; readonly blockers: readonly string[] }
  /**
   * The plan references findings that were not supplied, so the card cannot
   * state where the data is. Rendering it anyway would produce lines with a
   * count and no location — a number to approve with no subject.
   */
  | { readonly kind: 'incomplete'; readonly missingFindingIds: readonly string[] };

const WARNING =
  'This permanently destroys production data. It cannot be undone. ' +
  'Nothing has been touched yet — every figure above was measured against a ' +
  'snapshot, not estimated.';

/**
 * Build the card, or explain why one cannot honestly be built.
 *
 * Findings are passed in rather than embedded in the plan because the plan
 * records decisions and the findings record observations, and the card is the
 * one place both are needed at once.
 */
export function renderPlanCard(
  plan: ErasurePlan,
  findings: readonly Finding[],
): PlanCardResult {
  const blockers = approvalBlockers(plan);
  if (blockers.length > 0) {
    return { kind: 'not_approvable', blockers };
  }

  const byId = new Map(findings.map((f) => [f.id, f]));
  const missing = plan.actions.filter((a) => !byId.has(a.findingId)).map((a) => a.findingId);
  if (missing.length > 0) {
    return { kind: 'incomplete', missingFindingIds: missing };
  }

  // approvalBlockers has already established the plan is simulated, so a
  // blast radius is present. Narrowing rather than asserting keeps the type
  // honest if that guarantee ever changes.
  const blastRadius = plan.blastRadius;
  if (!blastRadius) {
    return { kind: 'not_approvable', blockers: ['Plan carries no simulation results.'] };
  }

  const lines = plan.actions.map((action): PlanCardLine => {
    const finding = byId.get(action.findingId)!;
    return {
      disposition: action.disposition,
      system: finding.system,
      location: describeLocator(finding.locator),
      count: action.count,
      justification: action.justification,
      ...(action.citation !== undefined ? { citation: action.citation } : {}),
      irreversible: action.irreversible,
      ...(action.remediation !== undefined
        ? { remediation: `${action.remediation.action} by ${action.remediation.plannedAt}` }
        : {}),
    };
  });

  return {
    kind: 'renderable',
    card: {
      requestId: plan.requestId,
      lines: sortForReading(lines),
      totals: summarise(plan),
      irreversibleRecords: irreversibleRecordCount(plan),
      simulation: {
        snapshotId: blastRadius.snapshotId,
        simulatedAt: blastRadius.simulatedAt,
        constraintViolations: blastRadius.constraintViolations.length,
        orphanedRecords: blastRadius.orphanedRecords,
        residualTraces: blastRadius.residualTraces,
      },
      warning: WARNING,
    },
  };
}

/**
 * Order the lines by how much they matter to the decision.
 *
 * Irreversible destruction first, then anything the plan is refusing to do.
 * A reader who stops after three lines should have seen the three that could
 * hurt them, not whichever system happened to answer first.
 */
const DISPOSITION_ORDER: Record<Disposition, number> = {
  delete_and_compact: 0,
  delete: 1,
  anonymise: 2,
  // Above retain: "we cannot erase this" is the line most likely to change a
  // signer's mind, and must not be buried under routine retentions.
  unerasable: 3,
  retain: 4,
  escalate: 5,
};

function sortForReading(lines: readonly PlanCardLine[]): readonly PlanCardLine[] {
  return [...lines].sort((a, b) => {
    const byDisposition = DISPOSITION_ORDER[a.disposition] - DISPOSITION_ORDER[b.disposition];
    if (byDisposition !== 0) return byDisposition;
    // Larger blast radius first within a disposition.
    if (a.count !== b.count) return b.count - a.count;
    return a.location.localeCompare(b.location);
  });
}

const DISPOSITION_LABEL: Record<Disposition, string> = {
  delete: 'DELETE',
  delete_and_compact: 'PURGE',
  anonymise: 'ANONYMISE',
  unerasable: 'UNERASABLE',
  retain: 'RETAIN',
  escalate: 'ESCALATE',
};

/**
 * Plain-text rendering, for terminals and for the audit record.
 *
 * The text form is not a fallback — it is what gets attached to the case file
 * as the exact wording someone was shown. A card whose text and UI could drift
 * would make the audit trail unfalsifiable.
 */
export function formatPlanCard(card: PlanCard): string {
  const header = [
    `ERASURE PLAN — request ${card.requestId}`,
    `Measured against snapshot ${card.simulation.snapshotId} at ${card.simulation.simulatedAt}.`,
    '',
  ];

  const body = card.lines.flatMap((line) => {
    const label = DISPOSITION_LABEL[line.disposition].padEnd(10);
    const head = `  ${label} ${formatCount(line.count)} — ${line.system}: ${line.location}`;
    const detail = `             ${line.justification}`;
    const citation = line.citation ? [`             Basis: ${line.citation}`] : [];
    const remediation = line.remediation ? [`             Remediation: ${line.remediation}`] : [];
    return [head, detail, ...citation, ...remediation, ''];
  });

  const footer = [
    `  Erased ${card.totals.deleted} · anonymised ${card.totals.anonymised} · ` +
      `retained ${card.totals.retained}`,
    `  Unrecoverable: ${card.irreversibleRecords} record(s)`,
    `  Dry run: ${card.simulation.constraintViolations} constraint violation(s), ` +
      `${card.simulation.residualTraces} trace(s) remaining`,
    '',
    `  ${card.warning}`,
  ];

  return [...header, ...body, ...footer].join('\n');
}

function formatCount(count: number): string {
  const noun = count === 1 ? 'record' : 'records';
  return `${count.toLocaleString('en-US')} ${noun}`;
}
