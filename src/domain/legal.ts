/**
 * Retention law.
 *
 * The right to erasure is not absolute. GDPR Art.17(3) lists grounds on which
 * a controller must refuse, and separate statutes impose positive retention
 * duties — tax records being the usual one. An erasure tool that deletes
 * everything it is pointed at does not represent zero risk; it trades one
 * compliance failure for another, and the second one is harder to explain.
 *
 * So refusal is a first-class outcome here. Anything Lethe declines to erase
 * must name the ground it is relying on, and that ground appears on the
 * certificate alongside what was deleted.
 *
 * These rules encode the common, mechanical cases. They are not a substitute
 * for a data protection officer, and anything they do not recognise is
 * escalated to a human rather than silently deleted.
 */

import type { DataCategory, Finding } from './finding.ts';

/** Grounds on which data is kept despite a valid erasure request. */
export type RetentionGround =
  /** Art.17(3)(b) — compliance with a legal obligation, e.g. tax records. */
  | 'legal_obligation'
  /** Art.17(3)(e) — establishment, exercise or defence of legal claims. */
  | 'legal_claims'
  /** Art.17(3)(a) — exercising the right of freedom of expression. */
  | 'freedom_of_expression'
  /** Art.17(3)(c) — public interest in the area of public health. */
  | 'public_health'
  /** Art.17(3)(d) — archiving, scientific/historical research, statistics. */
  | 'research_archiving';

export interface RetentionRule {
  readonly id: string;
  readonly ground: RetentionGround;
  /** The provision relied on, as it should be cited on the certificate. */
  readonly citation: string;
  /** Plain-English reason a non-lawyer can check. */
  readonly rationale: string;
  /** How long the obligation runs, in months, where it is bounded. */
  readonly retainForMonths?: number;
  /** Whether the record may be anonymised in place instead of kept whole. */
  readonly anonymisationPermitted: boolean;
  readonly appliesTo: (finding: Finding) => boolean;
}

const FINANCIAL_TABLES = new Set(['invoices', 'payments', 'orders', 'ledger_entries', 'refunds']);

function isFinancialRecord(finding: Finding): boolean {
  if (finding.category === 'financial') return true;
  return finding.locator.kind === 'table' && FINANCIAL_TABLES.has(finding.locator.table);
}

/**
 * The default rule set.
 *
 * Kept small and mechanical on purpose. Each rule must be defensible on its
 * own line; anything requiring judgement belongs in front of a human.
 */
export const DEFAULT_RETENTION_RULES: readonly RetentionRule[] = [
  // Must precede every rule that permits anonymisation. A record under an open
  // dispute is often also a financial record, and the tax rule would anonymise
  // it — destroying the identity that is frequently the fact in dispute, while
  // the matter is still live.
  {
    id: 'active-legal-claim',
    ground: 'legal_claims',
    citation: 'GDPR Art.17(3)(e)',
    rationale:
      'Data subject to an open dispute, chargeback or legal hold must be preserved ' +
      'until the matter closes.',
    anonymisationPermitted: false,
    appliesTo: (finding) => finding.locator.kind === 'table' && finding.locator.table === 'legal_holds',
  },
  {
    id: 'tax-records',
    ground: 'legal_obligation',
    citation: 'GDPR Art.17(3)(b); national tax record-keeping obligation',
    rationale:
      'Transaction records supporting a filed tax return must be retained for the ' +
      'statutory period. The financial fact is retained; the identity attached to ' +
      'it can be removed.',
    retainForMonths: 84,
    anonymisationPermitted: true,
    appliesTo: isFinancialRecord,
  },
  {
    id: 'published-contributions',
    ground: 'freedom_of_expression',
    citation: 'GDPR Art.17(3)(a)',
    rationale:
      'Publicly published contributions by other users that reference the subject ' +
      'are not unilaterally erasable; the authoring identity is removed instead.',
    anonymisationPermitted: true,
    appliesTo: (finding) => finding.category === 'communications' && finding.locator.kind === 'table',
  },
];

export interface RetentionAssessment {
  readonly finding: Finding;
  readonly rule: RetentionRule;
}

/**
 * The first rule that applies to a finding, if any.
 *
 * First match wins, so rule order is meaningful: an unbounded legal hold must
 * be evaluated before a bounded tax obligation, or a record under active
 * dispute could be anonymised while the dispute is still open.
 */
export function assessRetention(
  finding: Finding,
  rules: readonly RetentionRule[] = DEFAULT_RETENTION_RULES,
): RetentionAssessment | undefined {
  const rule = rules.find((r) => r.appliesTo(finding));
  return rule ? { finding, rule } : undefined;
}

/**
 * Categories we refuse to act on without an explicit human decision.
 *
 * Special category data under Art.9 carries consequences in both directions —
 * deleting it and keeping it — so it is never resolved by rule alone.
 */
const ESCALATE_ALWAYS: ReadonlySet<DataCategory> = new Set<DataCategory>(['special_category']);

export function requiresHumanReview(finding: Finding): boolean {
  return ESCALATE_ALWAYS.has(finding.category);
}
