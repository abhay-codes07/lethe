/**
 * Proving the erasure, then certifying it.
 *
 * The plan was simulated; execution reported success. Neither is the claim
 * the certificate makes. This module makes the actual check: run discovery
 * again, against the live systems, with the same identifiers — and only if
 * nothing comes back does a certificate exist.
 *
 * Two outcomes are deliberately different in kind. Traces surviving the
 * sweep is not a failure of this code — it is the system working: the case
 * loops back to `executing` for another pass, because that is what the state
 * machine's `verifying → executing` edge is for. The sweep itself breaking —
 * a turn that dies, a reply that cannot be parsed — is a failure, and marks
 * the case failed, because an unverifiable erasure must not sit in
 * `verifying` looking like progress.
 */

import { createHash } from 'node:crypto';

import type { AgentSpec } from '../agents/spec.ts';
import type { ToolCatalog } from '../connectors/catalog.ts';
import { verifyOrThrow } from '../connectors/verify.ts';
import {
  type AuditEvent,
  type Certificate,
  type CertificateEntry,
  chainEvents,
  issueCertificate,
  referenceSubject,
} from '../domain/certificate.ts';
import { describeLocatorRedacted, totalRecords, type Finding } from '../domain/finding.ts';
import type { ErasurePlan } from '../domain/plan.ts';
import { TurnRunner, type RunOutcome } from '../harness/turn-runner.ts';
import type { Transport } from '../harness/transport.ts';
import type { CaseFile } from '../lifecycle/case-file.ts';
import { formatErrors, parseFindings } from '../discovery/parse.ts';
import type { SuppressionLedger } from '../suppression/ledger.ts';

export type VerificationStage = 'preconditions' | 'verification' | 'run' | 'parsing' | 'certification';

export class VerificationError extends Error {
  readonly stage: VerificationStage;

  constructor(stage: VerificationStage, message: string) {
    super(message);
    this.name = 'VerificationError';
    this.stage = stage;
  }
}

export interface VerificationOptions {
  readonly caseFile: CaseFile;
  readonly transport: Transport;
  readonly catalog: ToolCatalog;
  /** The read-only scout. Verification must be incapable of fixing what it finds. */
  readonly scout: AgentSpec;
  readonly sessionId: string;
  readonly ledger: SuppressionLedger;
  /** Per-installation salt for the subject reference on the certificate. */
  readonly subjectSalt: string;
  /** Systems where the executor confirmed compaction ran. */
  readonly compactionsConfirmed?: readonly string[];
  /** Declared systems this sweep could not reach, each with the reason. */
  readonly systemsExcluded?: readonly { readonly system: string; readonly reason: string }[];
}

export type VerificationResult =
  | { readonly kind: 'certified'; readonly certificate: Certificate }
  /**
   * Traces survived. Not an error: the case has looped back to `executing`
   * and the findings say exactly what is left.
   */
  | {
      readonly kind: 'incomplete';
      readonly residualTraces: number;
      readonly remaining: readonly Finding[];
    };

/**
 * Sweep, and certify only what the sweep supports.
 */
export async function runVerification(options: VerificationOptions): Promise<VerificationResult> {
  const { caseFile, scout } = options;

  if (caseFile.state !== 'verifying') {
    throw new VerificationError(
      'preconditions',
      `request ${caseFile.requestId} is ${caseFile.state}; verification follows ` +
        'execution, nothing else.',
    );
  }

  const plan = caseFile.plan;
  const identities = caseFile.identities;
  if (!plan || !identities) {
    throw new VerificationError('preconditions', 'case file is missing its plan or identity graph');
  }

  // The scout again, and deliberately so: the agent that checks whether the
  // erasure worked must be incapable of quietly finishing the job. A verifier
  // that can delete is a verifier whose clean report proves nothing.
  try {
    await verifyOrThrow([{ spec: scout, expectReadOnly: true }], options.catalog);
  } catch (error) {
    throw fail(caseFile, 'verification', (error as Error).message);
  }

  const knownSystems = new Set(scout.mcpServers.map((binding) => binding.name));
  const runner = new TurnRunner(options.transport, options.sessionId);

  let outcome: RunOutcome;
  try {
    outcome = await runner.start(sweepPrompt(identities.all().map((r) => r.identifier), [...knownSystems]));
  } catch (error) {
    throw fail(caseFile, 'run', `verification sweep failed: ${(error as Error).message}`);
  }

  if (outcome.kind !== 'completed') {
    // The sweep needs no questions (the identifiers are known) and holds no
    // writable tools (so no gates). Anything but completion is a broken sweep.
    throw fail(caseFile, 'run', `verification sweep ended as ${outcome.kind}`);
  }

  let reply = runner.index.messages().filter((m) => m.content.trim() !== '').at(-1)?.content;
  if (reply === undefined) {
    // Same live observation as discovery: replay the merged events when the
    // stream lost the reply.
    try {
      await runner.reconnect(outcome.turnId);
      reply = runner.index.messages().filter((m) => m.content.trim() !== '').at(-1)?.content;
    } catch {
      // fall through
    }
  }
  if (reply === undefined) {
    throw fail(caseFile, 'parsing', 'verification sweep finished without a reply');
  }

  const parsed = parseFindings(reply, { knownSystems, identities });
  if (!parsed.ok) {
    throw fail(
      caseFile,
      'parsing',
      `verification sweep returned findings that cannot be trusted:\n${formatErrors(parsed.errors)}`,
    );
  }

  const residualTraces = totalRecords(parsed.findings);

  if (residualTraces > 0) {
    // The legal loop, not a failure: back to execution with the remainder.
    caseFile.transition(
      'executing',
      `${residualTraces} trace(s) remained after execution; another pass is required`,
    );
    return { kind: 'incomplete', residualTraces, remaining: parsed.findings };
  }

  // The sweep is clean. Everything below is assembling the proof.
  const compactions = new Set(options.compactionsConfirmed ?? []);
  const entries = plan.actions.map((action): CertificateEntry => {
    const finding = caseFile.findings.find((f) => f.id === action.findingId);
    return {
      system: finding?.system ?? 'unknown',
      // Redacted: the full locator embeds the subject's identifiers, and this
      // document outlives their erasure.
      location: finding ? describeLocatorRedacted(finding.locator) : action.findingId,
      disposition: action.disposition,
      recordsAffected: action.count,
      justification: action.justification,
      ...(action.citation !== undefined ? { citation: action.citation } : {}),
      irrecoverable: isIrrecoverable(action.disposition, finding, compactions),
      ...(action.remediation !== undefined
        ? { remediation: `${action.remediation.action} by ${action.remediation.plannedAt}` }
        : {}),
    };
  });

  const approval = approvalFromHistory(caseFile, plan);
  const beyondUse = await options.ledger.attestation(plan.requestId);
  const seeds = identities.all().filter((r) => r.provenance.kind === 'seed');

  let certificate: Certificate;
  try {
    certificate = issueCertificate({
      requestId: plan.requestId,
      subject: referenceSubject(
        seeds.map((s) => s.identifier.value).join('|'),
        options.subjectSalt,
      ),
      entries,
      approval,
      verification: {
        rediscoveredAt: new Date().toISOString(),
        systemsSwept: [...knownSystems].filter(
          (system) => !(options.systemsExcluded ?? []).some((e) => e.system === system),
        ),
        residualTraces: 0,
        compactionsConfirmed: [...compactions],
      },
      scope: {
        systemsDeclared: [...knownSystems],
        systemsExcluded: options.systemsExcluded ?? [],
        identifierKindsSearched: [...new Set(identities.all().map((r) => r.identifier.kind))],
        identifierCount: identities.size,
      },
      ...(beyondUse !== undefined ? { beyondUse } : {}),
      events: chainEvents(auditTrail(caseFile)),
    });
  } catch (error) {
    throw fail(caseFile, 'certification', (error as Error).message);
  }

  caseFile.recordCertificate(certificate);
  return { kind: 'certified', certificate };
}

/**
 * Whether a disposition's data is genuinely unrecoverable now.
 *
 * `delete_and_compact` earns it only when the store's compaction was
 * confirmed — the entire reason the disposition exists is that the delete
 * alone leaves the data reconstructible.
 */
function isIrrecoverable(
  disposition: string,
  finding: Finding | undefined,
  compactions: ReadonlySet<string>,
): boolean {
  switch (disposition) {
    case 'delete':
    case 'anonymise':
      return true;
    case 'delete_and_compact':
      return finding !== undefined && compactions.has(finding.system);
    default:
      return false;
  }
}

/**
 * The audit trail, derived from the case file's own history.
 *
 * Derived rather than assembled by hand, which is the certificate's founding
 * principle applied to its own inputs: the history was written as the case
 * moved, each entry with its reason, and the chain is computed over exactly
 * that record.
 */
export function auditTrail(caseFile: CaseFile): readonly AuditEvent[] {
  return caseFile.history.map((transition, index) => ({
    sequence: index + 1,
    type: `case.${transition.to}`,
    at: transition.at,
    detail: { from: transition.from, to: transition.to, reason: transition.reason },
  }));
}

/** Digest of the exact plan that was signed, for the certificate's approval block. */
export function planDigest(plan: ErasurePlan): string {
  const canonical = plan.actions
    .map(
      (action) =>
        `${action.findingId}:${action.disposition}:${action.count}:${action.justification}`,
    )
    .sort()
    .join('\n');

  return createHash('sha256').update(canonical).digest('hex');
}

function approvalFromHistory(
  caseFile: CaseFile,
  plan: ErasurePlan,
): { approvedBy: string; approvedAt: string; planDigest: string } {
  const approval = caseFile.history.find(
    (t) => t.to === 'executing' && t.reason.startsWith('approved by '),
  );

  if (!approval) {
    // recordCertificate would refuse anyway (wrong state), but the message
    // should name the real problem: a certificate with no identifiable
    // approver attests to an authorisation nobody gave.
    throw new VerificationError(
      'certification',
      'no approval found in the case history; a certificate cannot attest to an ' +
        'authorisation nobody gave',
    );
  }

  return {
    approvedBy: approval.reason.slice('approved by '.length),
    approvedAt: approval.at,
    planDigest: planDigest(plan),
  };
}

function fail(caseFile: CaseFile, stage: VerificationStage, message: string): VerificationError {
  try {
    caseFile.transition('failed', `${stage}: ${message}`);
  } catch {
    // Already terminal; the original failure matters more.
  }
  return new VerificationError(stage, message);
}

function sweepPrompt(
  identifiers: readonly { kind: string; value: string; system: string }[],
  systems: readonly string[],
): string {
  const list = identifiers.map((id) => `  - ${id.kind}: ${id.value} (in ${id.system})`).join('\n');

  return [
    'An erasure has just been executed. Verify it: search every connected',
    'system for any remaining trace of these identifiers.',
    '',
    list,
    '',
    `Systems to sweep: ${systems.join(', ')}`,
    '',
    'The expected result is nothing. Report whatever you find, exactly as it',
    'is — a residual trace is precisely what this sweep exists to catch, and',
    'reporting a clean result over a dirty one converts an operational miss',
    'into a false attestation.',
    '',
    'Count records in code. Do not include personal data in your reply.',
    '',
    'Reply with JSON only, in this shape:',
    '{"findings":[{"id":"","system":"","locator":{"kind":"table","schema":"",',
    '"table":"","predicate":""},"category":"","durability":"","count":0,',
    '"matchedBy":{"kind":"","value":"","system":""},"observedAt":""}]}',
    '',
    'An empty findings array means the erasure verified clean.',
  ].join('\n');
}
