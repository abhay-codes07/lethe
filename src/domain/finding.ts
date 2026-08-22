/**
 * Findings — what discovery actually located.
 *
 * A finding is one place personal data sits: a set of rows, an object, a
 * customer record, a block of vectors. Findings are produced by read-only
 * scouts and are purely descriptive; deciding what happens to them is the
 * planner's job (see `plan.ts`).
 *
 * Findings never carry the personal data itself. They carry a locator and a
 * count. Copying the data into a report to describe deleting it would be its
 * own privacy problem.
 */

import type { Identifier, SystemId } from './identity.ts';

/**
 * Where a finding lives, in terms the owning system understands.
 *
 * Kept structured rather than a display string so the executor can act on it
 * without re-parsing prose.
 */
export type Locator =
  | { readonly kind: 'table'; readonly schema: string; readonly table: string; readonly predicate: string }
  | { readonly kind: 'object'; readonly bucket: string; readonly key: string }
  | { readonly kind: 'api_resource'; readonly resource: string; readonly id: string }
  | { readonly kind: 'vector'; readonly index: string; readonly documentIds: readonly string[] }
  | { readonly kind: 'log_stream'; readonly stream: string; readonly window: string };

/**
 * What kind of personal data this is.
 *
 * Drives both the legal analysis and how loudly the plan flags it: special
 * category data under GDPR Art.9 gets surfaced whether or not the requester
 * mentioned it.
 */
export type DataCategory =
  | 'identity'
  | 'contact'
  | 'financial'
  | 'behavioural'
  | 'communications'
  | 'special_category'
  | 'derived';

/**
 * Whether the data is still recoverable after an ordinary delete.
 *
 * This is the distinction most erasure tooling misses. A row deleted from
 * Postgres is gone. A vector "deleted" from an HNSW index is usually only
 * tombstoned, and remains reconstructible from the raw index files until the
 * index is compacted — so a delete call alone is not erasure.
 */
export type Durability =
  /** Delete removes the data. */
  | 'hard_delete'
  /** Delete only tombstones; a further compaction or rewrite is required. */
  | 'requires_compaction'
  /** Lives in an immutable or append-only store; needs rotation or expiry. */
  | 'immutable_until_expiry';

export interface Finding {
  readonly id: string;
  readonly system: SystemId;
  readonly locator: Locator;
  readonly category: DataCategory;
  readonly durability: Durability;
  /** Rows, objects, or vectors matched. Counted in code, never estimated. */
  readonly count: number;
  /** Which identifier matched here — the link back to the identity graph. */
  readonly matchedBy: Identifier;
  /** When the scout observed this. Counts go stale; the plan records freshness. */
  readonly observedAt: string;
  /**
   * Other findings that cannot survive this one being deleted, expressed as
   * finding ids. Populated by referential analysis during simulation.
   */
  readonly dependents?: readonly string[];
}

/** Human-readable one-line locator, for the plan card and the certificate. */
export function describeLocator(locator: Locator): string {
  switch (locator.kind) {
    case 'table':
      return `${locator.schema}.${locator.table} where ${locator.predicate}`;
    case 'object':
      return `s3://${locator.bucket}/${locator.key}`;
    case 'api_resource':
      return `${locator.resource}/${locator.id}`;
    case 'vector':
      return `${locator.index} (${locator.documentIds.length} documents)`;
    case 'log_stream':
      return `${locator.stream} over ${locator.window}`;
  }
}

/**
 * Findings whose data survives an ordinary delete call.
 *
 * These are the ones that turn "we deleted it" into a false statement, so the
 * plan must schedule the follow-up work — compaction, rotation, expiry — and
 * the certificate must not claim erasure until it has run.
 */
export function needsFollowUp(findings: readonly Finding[]): readonly Finding[] {
  return findings.filter((f) => f.durability !== 'hard_delete');
}

export function totalRecords(findings: readonly Finding[]): number {
  return findings.reduce((sum, f) => sum + f.count, 0);
}

/** Group findings by system, preserving input order within each group. */
export function bySystem(findings: readonly Finding[]): ReadonlyMap<SystemId, readonly Finding[]> {
  const grouped = new Map<SystemId, Finding[]>();
  for (const finding of findings) {
    const existing = grouped.get(finding.system);
    if (existing) existing.push(finding);
    else grouped.set(finding.system, [finding]);
  }
  return grouped;
}
