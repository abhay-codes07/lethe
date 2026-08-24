/**
 * The erasure plan.
 *
 * This is the artefact a human signs, and the only thing the executor is
 * allowed to act on. Everything about it is shaped by one observation: asking
 * someone to approve `delete_user(id=4471)` produces rubber-stamping, because
 * nobody can evaluate a consequence they cannot see.
 *
 * So a plan is never a list of tool calls. It is a list of dispositions, each
 * with a measured count, a justification, and — once simulation has run — the
 * damage it would do. Approval is granted against evidence or not at all.
 */

import { describeLocatorRedacted, type Finding, totalRecords } from './finding.ts';
import type { Identifier } from './identity.ts';
import { assessRetention, requiresHumanReview, type RetentionRule } from './legal.ts';

/** What is to become of a finding. */
export type Disposition =
  /** Remove the data entirely. */
  | 'delete'
  /** Sever the link to the subject, keep the record. Used where law requires. */
  | 'anonymise'
  /** Keep intact, citing a ground under Art.17(3). */
  | 'retain'
  /** Delete, then run the follow-up that makes the delete actually stick. */
  | 'delete_and_compact'
  /** Refuse to decide by rule; put it in front of a person. */
  | 'escalate'
  /**
   * Cannot be erased by any operation this system can perform — data baked
   * into model weights being the canonical case. Machine unlearning does not
   * reliably work, and pretending otherwise would put a false statement on
   * the certificate. The honest product is the disclosure: what remains,
   * why, and when remediation removes it from the world.
   */
  | 'unerasable';

export interface PlannedAction {
  readonly findingId: string;
  readonly disposition: Disposition;
  /** Records affected, carried from the finding so the plan totals are real. */
  readonly count: number;
  /** Why this disposition and not another — shown verbatim on the plan card. */
  readonly justification: string;
  /** Present when the disposition is driven by a retention rule. */
  readonly citation?: string;
  /** Whether this action destroys data that cannot be recovered. */
  readonly irreversible: boolean;
  /** Present only for `unerasable`: how and when the data leaves the world. */
  readonly remediation?: Remediation;
}

/**
 * The path by which unerasable data eventually stops existing.
 *
 * Mandatory wherever `unerasable` appears. A disclosure with no remediation
 * is a shrug; "the model is retrained without this data on 2026-11-01" is a
 * commitment someone can hold the controller to.
 */
export interface Remediation {
  /** What will happen, e.g. "model retrained without the subject's data". */
  readonly action: string;
  readonly plannedAt: string;
}

/**
 * What the deletion would break, measured by applying it to a snapshot rather
 * than reasoned about in prose.
 */
export interface BlastRadius {
  /** Referential integrity failures the deletion would cause. */
  readonly constraintViolations: readonly ConstraintViolation[];
  /** Rows in other tables left pointing at nothing. */
  readonly orphanedRecords: number;
  /** Traces still present on the snapshot after the plan was applied to it. */
  readonly residualTraces: number;
  /** Identifier of the snapshot the simulation ran against. */
  readonly snapshotId: string;
  readonly simulatedAt: string;
}

export interface ConstraintViolation {
  readonly constraint: string;
  readonly table: string;
  readonly affectedRows: number;
  /** The disposition change that resolves it, if one exists. */
  readonly resolution?: string;
}

export type PlanStatus =
  /** Built from findings; not yet simulated. Cannot be approved. */
  | 'draft'
  /** Simulated against a snapshot; carries a blast radius. Approvable. */
  | 'simulated'
  | 'approved'
  | 'rejected'
  | 'executed';

export interface ErasurePlan {
  readonly requestId: string;
  /** Identifiers the plan acts against. Anything outside this set is out of scope. */
  readonly subjectIdentifiers: readonly Identifier[];
  readonly actions: readonly PlannedAction[];
  readonly status: PlanStatus;
  readonly createdAt: string;
  /** Absent until simulation has run. Its absence is what blocks approval. */
  readonly blastRadius?: BlastRadius;
}

/**
 * Turn findings into a draft plan by applying the retention rules.
 *
 * The result is deliberately not approvable: it has no blast radius yet, so
 * `assertApprovable` will reject it. A plan becomes signable only after it has
 * been tried against a snapshot.
 */
export function draftPlan(
  requestId: string,
  subjectIdentifiers: readonly Identifier[],
  findings: readonly Finding[],
  rules?: readonly RetentionRule[],
  now = new Date().toISOString(),
): ErasurePlan {
  const actions = findings.map((finding) => planFinding(finding, rules));
  return {
    requestId,
    subjectIdentifiers,
    actions,
    status: 'draft',
    createdAt: now,
  };
}

function planFinding(finding: Finding, rules?: readonly RetentionRule[]): PlannedAction {
  if (requiresHumanReview(finding)) {
    return {
      findingId: finding.id,
      disposition: 'escalate',
      count: finding.count,
      justification:
        'Special category data under GDPR Art.9. Both deleting and keeping this ' +
        'carries consequences, so it is not resolved by rule.',
      irreversible: false,
    };
  }

  const retention = assessRetention(finding, rules);

  if (retention) {
    const { rule } = retention;
    if (rule.anonymisationPermitted) {
      return {
        findingId: finding.id,
        disposition: 'anonymise',
        count: finding.count,
        justification: `${rule.rationale} Link to the subject is severed; the record is kept.`,
        citation: rule.citation,
        irreversible: true,
      };
    }
    return {
      findingId: finding.id,
      disposition: 'retain',
      count: finding.count,
      justification: rule.rationale,
      citation: rule.citation,
      irreversible: false,
    };
  }

  // No retention ground: the data goes. How thoroughly depends on whether the
  // store actually forgets when told to.
  const compactionNeeded = finding.durability !== 'hard_delete';
  return {
    findingId: finding.id,
    disposition: compactionNeeded ? 'delete_and_compact' : 'delete',
    count: finding.count,
    justification: compactionNeeded
      ? `Delete alone leaves this recoverable (${finding.durability}); ` +
        'compaction is scheduled so the erasure is real.'
      // The redacted form: justifications end up on the certificate, which
      // outlives the subject's erasure, so they must not embed the predicate
      // that names them. The card shows the full locator on its own line.
      : `No retention ground applies to ${describeLocatorRedacted(finding.locator)}.`,
    irreversible: true,
  };
}

/** Attach simulation results, moving the plan from draft to approvable. */
export function withBlastRadius(plan: ErasurePlan, blastRadius: BlastRadius): ErasurePlan {
  return { ...plan, blastRadius, status: 'simulated' };
}

export interface PlanSummary {
  readonly deleted: number;
  readonly anonymised: number;
  readonly retained: number;
  readonly escalated: number;
  readonly unerasable: number;
  readonly irreversibleActions: number;
  readonly totalRecords: number;
}

export function summarise(plan: ErasurePlan): PlanSummary {
  let deleted = 0;
  let anonymised = 0;
  let retained = 0;
  let escalated = 0;
  let unerasable = 0;
  let irreversibleActions = 0;

  for (const action of plan.actions) {
    switch (action.disposition) {
      case 'delete':
      case 'delete_and_compact':
        deleted += action.count;
        break;
      case 'anonymise':
        anonymised += action.count;
        break;
      case 'retain':
        retained += action.count;
        break;
      case 'escalate':
        escalated += action.count;
        break;
      case 'unerasable':
        unerasable += action.count;
        break;
    }
    if (action.irreversible) irreversibleActions += 1;
  }

  return {
    deleted,
    anonymised,
    retained,
    escalated,
    unerasable,
    irreversibleActions,
    totalRecords: deleted + anonymised + retained + escalated + unerasable,
  };
}

/**
 * Reasons a plan must not be put in front of someone for approval.
 *
 * Returning the reasons rather than a boolean so the UI can say which gate is
 * closed instead of greying out a button with no explanation.
 */
export function approvalBlockers(plan: ErasurePlan): readonly string[] {
  const blockers: string[] = [];

  if (plan.status !== 'simulated') {
    blockers.push(
      `Plan is ${plan.status}. Only a simulated plan can be approved — approving ` +
        'an unsimulated plan is approving an unknown consequence.',
    );
  }

  if (!plan.blastRadius) {
    blockers.push('No simulation results: the effect of this plan has not been measured.');
  } else {
    if (plan.blastRadius.constraintViolations.length > 0) {
      blockers.push(
        `${plan.blastRadius.constraintViolations.length} unresolved constraint ` +
          'violation(s): executing would corrupt referential integrity.',
      );
    }
    if (plan.blastRadius.residualTraces > 0) {
      blockers.push(
        `${plan.blastRadius.residualTraces} trace(s) remained after the plan was ` +
          'applied to the snapshot, so this plan does not achieve erasure.',
      );
    }
  }

  const escalations = plan.actions.filter((a) => a.disposition === 'escalate');
  if (escalations.length > 0) {
    blockers.push(`${escalations.length} finding(s) need a human decision before the plan is complete.`);
  }

  if (plan.actions.length === 0) {
    blockers.push('Plan contains no actions.');
  }

  return blockers;
}

export function assertApprovable(plan: ErasurePlan): void {
  const blockers = approvalBlockers(plan);
  if (blockers.length > 0) {
    throw new Error(`plan ${plan.requestId} is not approvable:\n- ${blockers.join('\n- ')}`);
  }
}

/** Records that would be destroyed unrecoverably. The number that matters most. */
export function irreversibleRecordCount(plan: ErasurePlan): number {
  return plan.actions.filter((a) => a.irreversible).reduce((sum, a) => sum + a.count, 0);
}

/**
 * Convert one planned action into an unerasable disclosure.
 *
 * Not produced by `draftPlan`: recognising that a finding lives in model
 * weights takes information the rules do not have, so the marking is an
 * explicit decision by whoever (or whatever) knows the artefact — with the
 * basis and the remediation both mandatory.
 *
 * The returned plan is demoted to `draft`. Any edit to a plan invalidates
 * its simulation: the blast radius was measured for a different set of
 * actions, and carrying it forward would let a person sign figures that no
 * longer describe the plan in front of them.
 */
export function markUnerasable(
  plan: ErasurePlan,
  findingId: string,
  basis: string,
  remediation: Remediation,
  now = new Date().toISOString(),
): ErasurePlan {
  if (plan.status !== 'draft' && plan.status !== 'simulated') {
    throw new Error(
      `cannot mark a finding unerasable on a ${plan.status} plan; the decision ` +
        'belongs before approval, not after.',
    );
  }
  if (!basis.trim()) {
    throw new Error('an unerasable marking needs a basis; it is a disclosure, not a shrug');
  }
  if (!remediation.action.trim()) {
    throw new Error('remediation must say what will happen to the data');
  }
  if (Number.isNaN(Date.parse(remediation.plannedAt)) || Date.parse(remediation.plannedAt) <= Date.parse(now)) {
    throw new Error(
      'remediation must be planned for a future date; a past one claims the ' +
        'data is already gone, which contradicts marking it unerasable.',
    );
  }

  const target = plan.actions.find((action) => action.findingId === findingId);
  if (!target) {
    throw new Error(`plan has no action for finding ${findingId}`);
  }

  const actions = plan.actions.map((action) =>
    action.findingId === findingId
      ? {
          findingId: action.findingId,
          disposition: 'unerasable' as const,
          count: action.count,
          justification: basis,
          irreversible: false,
          remediation,
        }
      : action,
  );

  // Demoted deliberately: the blast radius on this plan was measured for a
  // different set of actions.
  return { ...plan, actions, status: 'draft' };
}

export { totalRecords };
