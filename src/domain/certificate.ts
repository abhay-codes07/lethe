/**
 * The Certificate of Erasure.
 *
 * This is what the whole system exists to produce. A regulator asking whether
 * an erasure happened is not asking for a log line saying the delete API was
 * called — they are asking what was found, what was destroyed, what was kept
 * and under what authority, who authorised it, and how anyone can check.
 *
 * Two properties shape the design.
 *
 * **A certificate contains no personal data.** It is a document about a
 * person, retained after that person asked to be erased, so it must not
 * reproduce what it certifies the removal of. Subjects appear as a salted
 * digest: enough to prove a later request concerns the same person, not
 * enough to recover who they were.
 *
 * **It is derived, not written.** Every entry is computed from the session's
 * own event history, and the events are hash-chained so that altering one
 * after the fact invalidates every digest after it. A certificate assembled
 * separately from the record of what happened is a claim; one derived from a
 * tamper-evident chain is evidence.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { PlannedAction } from './plan.ts';

/** One entry from the run's event history, in the order it occurred. */
export interface AuditEvent {
  /** Monotonic position in the session. Gaps mean the history is incomplete. */
  readonly sequence: number;
  readonly type: string;
  readonly at: string;
  /** Event payload. Must never carry personal data — see `assertNoRawSubject`. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ChainedEvent extends AuditEvent {
  /** Digest over this event and every event before it. */
  readonly digest: string;
}

const GENESIS = '0'.repeat(64);

/**
 * Canonical serialisation.
 *
 * Object key order must not change a digest, or a chain verified on one
 * machine fails on another for reasons nobody can debug.
 */
function canonicalise(event: AuditEvent): string {
  const detail = Object.keys(event.detail)
    .sort()
    .map((key) => `${key}=${String(event.detail[key])}`)
    .join('');

  return [event.sequence, event.type, event.at, detail].join('');
}

function digestOf(previous: string, event: AuditEvent): string {
  return createHash('sha256').update(previous).update('').update(canonicalise(event)).digest('hex');
}

/**
 * Hash-chain a run's events.
 *
 * Rejects out-of-order or gapped input: a chain over an incomplete history
 * would be internally consistent while attesting to something that did not
 * happen in that order, which is the one failure mode worth refusing outright.
 */
export function chainEvents(events: readonly AuditEvent[]): readonly ChainedEvent[] {
  const chained: ChainedEvent[] = [];
  let previous = GENESIS;

  events.forEach((event, index) => {
    const expected = index === 0 ? events[0]!.sequence : chained[index - 1]!.sequence + 1;
    if (event.sequence !== expected) {
      throw new Error(
        `event history is not contiguous at index ${index}: expected sequence ` +
          `${expected}, got ${event.sequence}. A certificate cannot be derived ` +
          'from an incomplete record.',
      );
    }

    previous = digestOf(previous, event);
    chained.push({ ...event, digest: previous });
  });

  return chained;
}

/** The digest covering the entire run. Absent for an empty history. */
export function chainHead(chained: readonly ChainedEvent[]): string {
  return chained.at(-1)?.digest ?? GENESIS;
}

export interface ChainVerification {
  readonly valid: boolean;
  /** Sequence number of the first event whose digest does not recompute. */
  readonly firstDivergence?: number;
}

/**
 * Recompute the chain and report where, if anywhere, it stops matching.
 *
 * Returns the divergence point rather than a bare boolean: knowing an audit
 * trail was altered is useful, knowing which event was altered is actionable.
 */
export function verifyChain(chained: readonly ChainedEvent[]): ChainVerification {
  let previous = GENESIS;

  for (const event of chained) {
    previous = digestOf(previous, event);
    if (!digestsEqual(previous, event.digest)) {
      return { valid: false, firstDivergence: event.sequence };
    }
  }

  return { valid: true };
}

function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * A subject reference that proves identity without disclosing it.
 *
 * The salt is per-installation and must be stored alongside the certificates:
 * without it the digest cannot be recomputed to answer "is this the same
 * person as request #118?", and with it published, the digest is reversible
 * by dictionary attack over an email address.
 */
export interface SubjectReference {
  readonly digest: string;
  readonly algorithm: 'sha256';
}

export function referenceSubject(identifierValue: string, salt: string): SubjectReference {
  if (salt.length < 32) {
    throw new Error(
      'subject salt must be at least 32 characters: a short salt makes the ' +
        'digest reversible by dictionary attack over plausible email addresses.',
    );
  }

  return {
    digest: createHash('sha256').update(salt).update('').update(identifierValue).digest('hex'),
    algorithm: 'sha256',
  };
}

export function generateSubjectSalt(): string {
  return randomBytes(32).toString('hex');
}

/** What happened to one finding, as it appears on the certificate. */
export interface CertificateEntry {
  readonly system: string;
  /** Structured locator description. Never the data itself. */
  readonly location: string;
  readonly disposition: PlannedAction['disposition'];
  readonly recordsAffected: number;
  /** Provision relied on, where the disposition was retain or anonymise. */
  readonly citation?: string;
  readonly justification: string;
  /** True once the follow-up that makes a delete stick has run. */
  readonly irrecoverable: boolean;
}

export interface Approval {
  /** Who authorised it. An account identifier, not a name. */
  readonly approvedBy: string;
  readonly approvedAt: string;
  /** Digest of the exact plan signed, so a swapped plan is detectable. */
  readonly planDigest: string;
}

/** The post-execution sweep that checks reality agreed with the simulation. */
export interface Verification {
  readonly rediscoveredAt: string;
  readonly systemsSwept: readonly string[];
  readonly residualTraces: number;
  /** Stores where a delete only tombstones, confirmed compacted. */
  readonly compactionsConfirmed: readonly string[];
}

/**
 * What the certificate is actually a statement about.
 *
 * Without this, "0 residual traces" reads as a claim that the subject is gone
 * from the world. It is not, and cannot be. Re-running discovery proves
 * absence only in the systems that were swept, under the identifiers that
 * were resolved — a clean sweep of nine systems says nothing about a tenth
 * nobody connected, and industry experience is that most personal data lives
 * in unstructured stores where discovery routinely misses it.
 *
 * A certificate that omits its own scope is an overclaim in a document
 * intended to be shown to a regulator. Recording the boundary is what makes
 * the rest of it defensible.
 */
export interface CertificateScope {
  /** Connectors configured for this request. */
  readonly systemsDeclared: readonly string[];
  /**
   * Declared systems that were not swept, each with the reason.
   *
   * Explicit rather than inferred: a system silently missing from the sweep is
   * the difference between a disclosed limitation and a false attestation.
   */
  readonly systemsExcluded: readonly ExcludedSystem[];
  /**
   * Identifier kinds searched — never the values. The certificate is retained
   * after the subject asked to be erased, so it must not carry their handles.
   */
  readonly identifierKindsSearched: readonly string[];
  readonly identifierCount: number;
}

export interface ExcludedSystem {
  readonly system: string;
  readonly reason: string;
}

/**
 * The limits clause, printed verbatim on every certificate.
 *
 * Fixed text rather than generated, so it cannot be softened per request.
 */
export const SCOPE_LIMITS =
  'This certifies erasure within the scope recorded above. It attests that the ' +
  'listed systems were searched under the listed identifier kinds and that no ' +
  'trace remained. It does not attest to absence in systems not listed, under ' +
  'identifiers not resolved, or in unstructured stores outside the declared ' +
  'connectors.';

export interface Certificate {
  readonly requestId: string;
  readonly subject: SubjectReference;
  readonly issuedAt: string;
  readonly entries: readonly CertificateEntry[];
  readonly approval: Approval;
  readonly verification: Verification;
  readonly scope: CertificateScope;
  /** The limits this attestation is bounded by. Always `SCOPE_LIMITS`. */
  readonly limits: string;
  /** Head of the hash chain over the run's full event history. */
  readonly auditChainHead: string;
  readonly eventCount: number;
}

export interface CertificateInput {
  readonly requestId: string;
  readonly subject: SubjectReference;
  readonly entries: readonly CertificateEntry[];
  readonly approval: Approval;
  readonly verification: Verification;
  readonly scope: CertificateScope;
  readonly events: readonly ChainedEvent[];
}

/**
 * Issue a certificate, refusing where the facts do not support one.
 *
 * The refusals matter more than the document. An erasure that left traces
 * behind, or whose compaction never ran, or whose audit trail does not
 * recompute, is not an erasure — and issuing a certificate saying otherwise
 * is worse than issuing nothing, because it converts an operational miss into
 * a false attestation.
 */
export function issueCertificate(input: CertificateInput, now = new Date().toISOString()): Certificate {
  const { verification, entries, events, scope } = input;

  // Every declared system must be either swept or explicitly excluded with a
  // reason. A system silently missing from both is the difference between a
  // disclosed limitation and a false attestation — and it is the easy mistake,
  // because a connector that failed early simply stops appearing.
  const accountedFor = new Set([
    ...verification.systemsSwept,
    ...scope.systemsExcluded.map((excluded) => excluded.system),
  ]);
  const unaccounted = scope.systemsDeclared.filter((system) => !accountedFor.has(system));

  if (unaccounted.length > 0) {
    throw new Error(
      `cannot certify request ${input.requestId}: ${unaccounted.join(', ')} ` +
        'was declared but neither swept nor recorded as excluded. Certifying ' +
        'would attest to erasure in a system nobody looked at.',
    );
  }

  if (verification.systemsSwept.length === 0) {
    throw new Error(
      `cannot certify request ${input.requestId}: no system was swept, so there ` +
        'is nothing the certificate can attest to.',
    );
  }

  if (scope.identifierCount < 1 || scope.identifierKindsSearched.length === 0) {
    throw new Error(
      `cannot certify request ${input.requestId}: no identifiers were recorded ` +
        'as searched, so the scope of the sweep is unknown.',
    );
  }

  if (verification.residualTraces > 0) {
    throw new Error(
      `cannot certify request ${input.requestId}: ${verification.residualTraces} ` +
        'trace(s) remained after execution. The erasure is incomplete.',
    );
  }

  const unfinished = entries.filter(
    (e) => (e.disposition === 'delete' || e.disposition === 'delete_and_compact') && !e.irrecoverable,
  );
  if (unfinished.length > 0) {
    throw new Error(
      `cannot certify request ${input.requestId}: ${unfinished.length} deletion(s) ` +
        'remain recoverable. Compaction or rotation has not completed, so the data ' +
        'is still present.',
    );
  }

  const chain = verifyChain(events);
  if (!chain.valid) {
    throw new Error(
      `cannot certify request ${input.requestId}: the audit trail does not ` +
        `recompute from event ${chain.firstDivergence}. The record has been altered.`,
    );
  }

  if (entries.length === 0) {
    throw new Error(`cannot certify request ${input.requestId}: no actions were recorded.`);
  }

  return {
    requestId: input.requestId,
    subject: input.subject,
    issuedAt: now,
    entries,
    approval: input.approval,
    verification,
    scope,
    limits: SCOPE_LIMITS,
    auditChainHead: chainHead(events),
    eventCount: events.length,
  };
}

/** Records destroyed unrecoverably, and records kept — both belong on the summary. */
export function certificateTotals(certificate: Certificate): {
  readonly erased: number;
  readonly anonymised: number;
  readonly retained: number;
} {
  let erased = 0;
  let anonymised = 0;
  let retained = 0;

  for (const entry of certificate.entries) {
    switch (entry.disposition) {
      case 'delete':
      case 'delete_and_compact':
        erased += entry.recordsAffected;
        break;
      case 'anonymise':
        anonymised += entry.recordsAffected;
        break;
      case 'retain':
        retained += entry.recordsAffected;
        break;
      case 'escalate':
        break;
    }
  }

  return { erased, anonymised, retained };
}
