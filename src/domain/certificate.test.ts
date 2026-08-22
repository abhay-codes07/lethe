import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type AuditEvent,
  type CertificateEntry,
  type CertificateInput,
  chainEvents,
  chainHead,
  certificateTotals,
  generateSubjectSalt,
  issueCertificate,
  referenceSubject,
  verifyChain,
} from './certificate.ts';

function events(count: number, startAt = 1): AuditEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    sequence: startAt + i,
    type: 'tool.response',
    at: `2026-08-22T10:0${i}:00.000Z`,
    detail: { system: 'acme-postgres', rows: i },
  }));
}

const entry: CertificateEntry = {
  system: 'acme-postgres',
  location: 'public.sessions where user_id = 4471',
  disposition: 'delete',
  recordsAffected: 10,
  justification: 'No retention ground applies.',
  irrecoverable: true,
};

function input(overrides: Partial<CertificateInput> = {}): CertificateInput {
  return {
    requestId: 'DSR-118',
    subject: referenceSubject('ada@example.com', generateSubjectSalt()),
    entries: [entry],
    approval: {
      approvedBy: 'acct_9f2',
      approvedAt: '2026-08-22T11:00:00.000Z',
      planDigest: 'abc123',
    },
    verification: {
      rediscoveredAt: '2026-08-22T11:05:00.000Z',
      systemsSwept: ['acme-postgres', 'acme-s3'],
      residualTraces: 0,
      compactionsConfirmed: [],
    },
    events: chainEvents(events(3)),
    ...overrides,
  };
}

describe('chainEvents', () => {
  it('produces a digest per event', () => {
    const chained = chainEvents(events(3));
    assert.equal(chained.length, 3);
    assert.equal(new Set(chained.map((e) => e.digest)).size, 3);
  });

  it('makes every digest depend on everything before it', () => {
    const a = chainEvents(events(3));
    const altered = events(3);
    altered[0] = { ...altered[0]!, detail: { system: 'acme-postgres', rows: 999 } };

    // Changing the first event must change the head, not just its own digest.
    assert.notEqual(chainHead(chainEvents(altered)), chainHead(a));
  });

  it('is insensitive to detail key order', () => {
    const forward: AuditEvent = {
      sequence: 1,
      type: 'tool.response',
      at: '2026-08-22T10:00:00.000Z',
      detail: { alpha: 1, beta: 2 },
    };
    const reversed: AuditEvent = { ...forward, detail: { beta: 2, alpha: 1 } };

    assert.equal(chainHead(chainEvents([forward])), chainHead(chainEvents([reversed])));
  });

  // A chain over a gapped history is internally consistent while attesting to
  // something that did not happen that way, which is worse than no chain.
  it('refuses a history with a gap', () => {
    const gapped = [...events(2), { ...events(1, 9)[0]! }];
    assert.throws(() => chainEvents(gapped), /not contiguous/);
  });

  it('refuses a history that is out of order', () => {
    const [first, second] = events(2);
    assert.throws(() => chainEvents([second!, first!]), /not contiguous/);
  });

  it('accepts a history that does not start at sequence 1', () => {
    assert.doesNotThrow(() => chainEvents(events(3, 500)));
  });

  it('treats an empty history as the genesis digest', () => {
    assert.equal(chainHead(chainEvents([])), '0'.repeat(64));
  });
});

describe('verifyChain', () => {
  it('accepts an untouched chain', () => {
    assert.deepEqual(verifyChain(chainEvents(events(4))), { valid: true });
  });

  it('reports which event was altered, not merely that one was', () => {
    const chained = [...chainEvents(events(4))];
    chained[1] = { ...chained[1]!, detail: { system: 'acme-postgres', rows: 4242 } };

    const result = verifyChain(chained);

    assert.equal(result.valid, false);
    assert.equal(result.firstDivergence, 2);
  });
});

describe('referenceSubject', () => {
  it('never reproduces the identifier it references', () => {
    const salt = generateSubjectSalt();
    const ref = referenceSubject('ada@example.com', salt);
    assert.ok(!ref.digest.includes('ada'));
    assert.equal(ref.digest.length, 64);
  });

  it('matches the same person across requests under one salt', () => {
    const salt = generateSubjectSalt();
    assert.equal(
      referenceSubject('ada@example.com', salt).digest,
      referenceSubject('ada@example.com', salt).digest,
    );
  });

  it('does not correlate the same person across installations', () => {
    assert.notEqual(
      referenceSubject('ada@example.com', generateSubjectSalt()).digest,
      referenceSubject('ada@example.com', generateSubjectSalt()).digest,
    );
  });

  // An email address is guessable; a short salt makes the digest reversible.
  it('rejects a salt short enough to brute force', () => {
    assert.throws(() => referenceSubject('ada@example.com', 'salt'), /at least 32/);
  });
});

describe('issueCertificate', () => {
  it('issues when the erasure is complete and the trail verifies', () => {
    const certificate = issueCertificate(input());
    assert.equal(certificate.requestId, 'DSR-118');
    assert.equal(certificate.eventCount, 3);
    assert.equal(certificate.auditChainHead.length, 64);
  });

  it('refuses when traces survived the sweep', () => {
    assert.throws(
      () =>
        issueCertificate(
          input({
            verification: {
              rediscoveredAt: '2026-08-22T11:05:00.000Z',
              systemsSwept: ['acme-postgres'],
              residualTraces: 3,
              compactionsConfirmed: [],
            },
          }),
        ),
      /erasure is incomplete/,
    );
  });

  // Deleting a vector without compacting leaves it reconstructible. Certifying
  // that as erased is a false attestation, not an operational near-miss.
  it('refuses while a deletion remains recoverable', () => {
    assert.throws(
      () =>
        issueCertificate(
          input({
            entries: [
              { ...entry, disposition: 'delete_and_compact', irrecoverable: false },
            ],
          }),
        ),
      /remain recoverable/,
    );
  });

  it('refuses when the audit trail has been altered', () => {
    const chained = [...chainEvents(events(3))];
    chained[0] = { ...chained[0]!, type: 'tool.response.forged' };

    assert.throws(() => issueCertificate(input({ events: chained })), /has been altered/);
  });

  it('refuses to certify a run that did nothing', () => {
    assert.throws(() => issueCertificate(input({ entries: [] })), /no actions were recorded/);
  });

  it('does not require irrecoverability for data that was retained', () => {
    assert.doesNotThrow(() =>
      issueCertificate(
        input({
          entries: [
            {
              ...entry,
              disposition: 'retain',
              irrecoverable: false,
              citation: 'GDPR Art.17(3)(e)',
            },
          ],
        }),
      ),
    );
  });
});

describe('certificateTotals', () => {
  it('reports what was kept as well as what was destroyed', () => {
    const certificate = issueCertificate(
      input({
        entries: [
          { ...entry, recordsAffected: 10 },
          { ...entry, disposition: 'anonymise', recordsAffected: 4, irrecoverable: true },
          { ...entry, disposition: 'retain', recordsAffected: 7, irrecoverable: false },
        ],
      }),
    );

    assert.deepEqual(certificateTotals(certificate), { erased: 10, anonymised: 4, retained: 7 });
  });
});
