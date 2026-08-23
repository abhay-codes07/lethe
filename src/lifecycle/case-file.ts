/**
 * The case file.
 *
 * An erasure request is not a conversation, it is a legal proceeding with a
 * statutory clock. It arrives, it is worked on across days by more than one
 * person, it pauses for a signature, and it ends in a document somebody may
 * have to defend to a regulator. The case file is what holds that together
 * between sessions.
 *
 * Its job is to make illegal sequences unrepresentable. Executing before
 * anyone approved, certifying before the verification sweep ran, reopening a
 * request that was already refused — each is a serious failure and each is
 * easy to reach by accident when the work spans days and reconnects. So the
 * transitions are enumerated and anything outside them throws, rather than
 * being prevented by whoever is calling remembering the right order.
 */

import type { Certificate } from '../domain/certificate.ts';
import type { Finding } from '../domain/finding.ts';
import type { IdentityGraph } from '../domain/identity.ts';
import { approvalBlockers, type ErasurePlan } from '../domain/plan.ts';
import type { ApprovalRequest } from '../harness/turn-runner.ts';
import { reconcile, type Reconciliation } from '../review/reconcile.ts';

export type CaseState =
  /** Received. The subject's identity has not been verified yet. */
  | 'received'
  /** Scouts are fanning out across the connected systems. */
  | 'discovering'
  /** Findings are being turned into dispositions. */
  | 'planning'
  /** The plan is being applied to a shadow snapshot. */
  | 'simulating'
  /** A person is looking at a measured plan. */
  | 'awaiting_approval'
  /** Refused by a person. Terminal. */
  | 'rejected'
  /** Carrying out an approved plan. */
  | 'executing'
  /** Re-running discovery against live systems to prove the erasure. */
  | 'verifying'
  /** Certificate issued. Terminal. */
  | 'certified'
  /** Stopped and needs a human. Terminal until reopened deliberately. */
  | 'failed';

/**
 * Legal transitions.
 *
 * Written as data rather than as branching, so the whole state machine can be
 * read at once — including, importantly, what is *absent*. There is no path
 * from `awaiting_approval` to `executing` that does not go through `approve`,
 * and no path into `certified` that does not pass through `verifying`.
 */
const TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  received: ['discovering', 'failed'],
  // Discovery can loop: confirming a weak identity link reopens the fan-out.
  discovering: ['discovering', 'planning', 'failed'],
  planning: ['simulating', 'failed'],
  // Simulation can send a plan back when the blast radius forces a different
  // disposition — an FK violation turning a delete into an anonymise.
  simulating: ['awaiting_approval', 'planning', 'failed'],
  awaiting_approval: ['executing', 'rejected', 'planning', 'failed'],
  rejected: [],
  executing: ['verifying', 'failed'],
  // Verification can send execution back round: a store that reported success
  // but still holds traces needs another pass, not a certificate.
  verifying: ['certified', 'executing', 'failed'],
  certified: [],
  failed: [],
};

export function isTerminal(state: CaseState): boolean {
  return TRANSITIONS[state].length === 0;
}

export interface Transition {
  readonly from: CaseState;
  readonly to: CaseState;
  readonly at: string;
  readonly reason: string;
}

/**
 * The statutory response deadline.
 *
 * One month from receipt under GDPR Art.12(3), extendable by two further
 * months where the request is complex — but the extension must be
 * communicated to the subject within the original month, so it is recorded
 * with a reason rather than silently applied.
 */
export interface Deadline {
  readonly receivedAt: string;
  readonly dueAt: string;
  readonly extensions: readonly DeadlineExtension[];
}

export interface DeadlineExtension {
  readonly grantedAt: string;
  readonly months: number;
  readonly reason: string;
}

const ONE_MONTH_DAYS = 30;
const MAX_EXTENSION_MONTHS = 2;

export interface CaseFileSnapshot {
  readonly requestId: string;
  readonly state: CaseState;
  readonly deadline: Deadline;
  readonly history: readonly Transition[];
}

export class CaseFile {
  readonly requestId: string;

  #state: CaseState = 'received';
  #history: Transition[] = [];
  #deadline: Deadline;

  #identities: IdentityGraph | undefined;
  #findings: readonly Finding[] = [];
  #plan: ErasurePlan | undefined;
  #certificate: Certificate | undefined;

  constructor(requestId: string, receivedAt = new Date().toISOString()) {
    this.requestId = requestId;
    this.#deadline = {
      receivedAt,
      dueAt: addDays(receivedAt, ONE_MONTH_DAYS),
      extensions: [],
    };
  }

  get state(): CaseState {
    return this.#state;
  }

  get deadline(): Deadline {
    return this.#deadline;
  }

  get history(): readonly Transition[] {
    return [...this.#history];
  }

  get findings(): readonly Finding[] {
    return this.#findings;
  }

  get plan(): ErasurePlan | undefined {
    return this.#plan;
  }

  get certificate(): Certificate | undefined {
    return this.#certificate;
  }

  /**
   * Move to a new state, refusing anything the machine does not permit.
   *
   * The reason is mandatory. A state change with no explanation is useless in
   * an audit trail, and this history is what a certificate is defended with.
   */
  transition(to: CaseState, reason: string, at = new Date().toISOString()): void {
    const from = this.#state;

    if (!reason.trim()) {
      throw new Error(`transition ${from} -> ${to} needs a reason; the case history is evidence`);
    }

    if (isTerminal(from)) {
      throw new Error(
        `request ${this.requestId} is ${from}, which is terminal. Reopening it ` +
          'would let a refused or completed erasure be quietly restarted; open a ' +
          'new request instead.',
      );
    }

    if (!TRANSITIONS[from].includes(to)) {
      throw new Error(
        `request ${this.requestId} cannot move from ${from} to ${to}. ` +
          `Permitted: ${TRANSITIONS[from].join(', ') || 'none'}.`,
      );
    }

    this.#state = to;
    this.#history.push({ from, to, at, reason });
  }

  recordIdentities(graph: IdentityGraph): void {
    this.#identities = graph;
  }

  get identities(): IdentityGraph | undefined {
    return this.#identities;
  }

  recordFindings(findings: readonly Finding[]): void {
    this.#findings = findings;
  }

  recordPlan(plan: ErasurePlan): void {
    if (plan.requestId !== this.requestId) {
      throw new Error(
        `plan is for request ${plan.requestId}, not ${this.requestId}. Attaching ` +
          "another request's plan would authorise deleting the wrong person's data.",
      );
    }
    this.#plan = plan;
  }

  /**
   * Record a human's approval and move to execution.
   *
   * Re-checks the plan rather than trusting that whoever rendered the card did.
   * The card and the approval can be separated by days and a process restart,
   * and the plan may have been replaced in between.
   */
  approve(approvedBy: string, at = new Date().toISOString()): void {
    if (this.#state !== 'awaiting_approval') {
      throw new Error(
        `request ${this.requestId} is ${this.#state}; only a request awaiting ` +
          'approval can be approved.',
      );
    }

    const plan = this.#plan;
    if (!plan) {
      throw new Error(`request ${this.requestId} has no plan to approve`);
    }

    const blockers = approvalBlockers(plan);
    if (blockers.length > 0) {
      throw new Error(
        `plan for ${this.requestId} is no longer approvable:\n- ${blockers.join('\n- ')}`,
      );
    }

    this.transition('executing', `approved by ${approvedBy}`, at);
  }

  reject(rejectedBy: string, reason: string, at = new Date().toISOString()): void {
    if (this.#state !== 'awaiting_approval') {
      throw new Error(
        `request ${this.requestId} is ${this.#state}; only a request awaiting ` +
          'approval can be rejected.',
      );
    }
    if (!reason.trim()) {
      throw new Error(
        'a rejection needs a reason. A refused erasure is itself a compliance ' +
          'event, and the subject is entitled to know why.',
      );
    }

    this.transition('rejected', `rejected by ${rejectedBy}: ${reason}`, at);
  }

  /**
   * Decide whether the executor's gated calls are within the signed plan.
   *
   * Refuses outright unless the request is actually executing: a scope check
   * against a plan nobody approved would return a confident answer about an
   * authority that does not exist.
   */
  authoriseCalls(requests: readonly ApprovalRequest[]): Reconciliation {
    if (this.#state !== 'executing') {
      throw new Error(
        `request ${this.requestId} is ${this.#state}; calls can only be ` +
          'authorised while executing an approved plan.',
      );
    }

    const plan = this.#plan;
    if (!plan) {
      throw new Error(`request ${this.requestId} has no plan to authorise against`);
    }

    return reconcile(plan, this.#findings, requests);
  }

  recordCertificate(certificate: Certificate, at = new Date().toISOString()): void {
    if (this.#state !== 'verifying') {
      throw new Error(
        `request ${this.requestId} is ${this.#state}; a certificate may only be ` +
          'issued from verifying, after the post-execution sweep has run.',
      );
    }
    if (certificate.requestId !== this.requestId) {
      throw new Error(`certificate is for request ${certificate.requestId}, not ${this.requestId}`);
    }

    this.#certificate = certificate;
    this.transition('certified', 'erasure verified and certified', at);
  }

  /**
   * Extend the statutory deadline.
   *
   * Capped at two further months in total, because that is the statutory
   * limit — a cap that only exists in a comment is a cap that gets exceeded.
   */
  extendDeadline(months: number, reason: string, at = new Date().toISOString()): void {
    if (!Number.isInteger(months) || months < 1) {
      throw new Error('an extension must be a whole number of months, at least one');
    }
    if (!reason.trim()) {
      throw new Error('an extension needs a reason; it must be communicated to the subject');
    }

    const already = this.#deadline.extensions.reduce((sum, e) => sum + e.months, 0);
    if (already + months > MAX_EXTENSION_MONTHS) {
      throw new Error(
        `extending by ${months} month(s) would total ${already + months}, beyond the ` +
          `${MAX_EXTENSION_MONTHS}-month statutory maximum.`,
      );
    }

    this.#deadline = {
      ...this.#deadline,
      dueAt: addDays(this.#deadline.dueAt, months * ONE_MONTH_DAYS),
      extensions: [...this.#deadline.extensions, { grantedAt: at, months, reason }],
    };
  }

  /** Whole days left before the statutory deadline. Negative once overdue. */
  daysRemaining(now = new Date().toISOString()): number {
    const remaining = Date.parse(this.#deadline.dueAt) - Date.parse(now);
    return Math.floor(remaining / 86_400_000);
  }

  isOverdue(now = new Date().toISOString()): boolean {
    // A finished request cannot become overdue afterwards — the obligation was
    // discharged when it was certified or refused.
    if (isTerminal(this.#state)) return false;
    return this.daysRemaining(now) < 0;
  }

  snapshot(): CaseFileSnapshot {
    return {
      requestId: this.requestId,
      state: this.#state,
      deadline: this.#deadline,
      history: this.history,
    };
  }
}

function addDays(iso: string, days: number): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid timestamp: ${iso}`);
  }
  return new Date(parsed + days * 86_400_000).toISOString();
}
