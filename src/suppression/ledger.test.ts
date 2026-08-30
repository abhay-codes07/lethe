import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateSubjectSalt } from '../domain/certificate.ts';
import type { Identifier } from '../domain/identity.ts';
import {
  BEYOND_USE_STATEMENT,
  filterRestore,
  InMemoryLedgerStore,
  LedgerUnavailableError,
  SuppressionLedger,
  type LedgerStore,
  type SuppressionEntry,
} from './ledger.ts';

const NOW = '2026-08-24T09:00:00.000Z';
const ROTATES = '2026-11-24T09:00:00.000Z';

const ada: Identifier = { kind: 'email', value: 'ada@example.com', system: 'acme-postgres' };
const bob: Identifier = { kind: 'email', value: 'bob@example.com', system: 'acme-postgres' };

function ledger(store: LedgerStore = new InMemoryLedgerStore()): SuppressionLedger {
  return new SuppressionLedger({ store, salt: generateSubjectSalt() });
}

describe('SuppressionLedger — recording', () => {
  it('suppresses an identifier until the media rotates', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    assert.equal(await l.isSuppressed(ada, NOW), true);
  });

  it('does not suppress an identifier it never saw', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    assert.equal(await l.isSuppressed(bob, NOW), false);
  });

  // A list of the email addresses of everyone who asked to be forgotten,
  // retained indefinitely, would be an obvious own goal.
  it('stores a digest, never the identifier', async () => {
    const store = new InMemoryLedgerStore();
    await ledger(store).suppress(ada, 'DSR-118', ROTATES, NOW);

    const serialised = JSON.stringify(await store.all());
    // Checked against the identifier and its parts — but not bare 'ada',
    // which is valid hex and can legitimately appear inside a digest. That
    // exact flake fired once in CI-like conditions before this comment.
    assert.ok(!serialised.includes('ada@example.com'));
    assert.ok(!serialised.includes('example.com'));
    assert.ok(!serialised.includes('ada@'));
  });

  it('does not correlate the same person across installations', async () => {
    const a = ledger();
    const b = ledger();

    assert.notEqual(a.digestOf(ada), b.digestOf(ada));
  });

  it('rejects a salt short enough to brute force', () => {
    assert.throws(
      () => new SuppressionLedger({ store: new InMemoryLedgerStore(), salt: 'short' }),
      /at least 32 characters/,
    );
  });

  // Telling the requester their data is already gone when it is not is worse
  // than telling them nothing.
  it('rejects a rotation date in the past', async () => {
    await assert.rejects(
      ledger().suppress(ada, 'DSR-118', '2026-01-01T00:00:00.000Z', NOW),
      /rotatesAt is in the past/,
    );
  });

  it('rejects a malformed rotation date', async () => {
    await assert.rejects(ledger().suppress(ada, 'DSR-118', 'soon', NOW), /must be a timestamp/);
  });
});

describe('SuppressionLedger — expiry', () => {
  it('stops suppressing once the media has rotated', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    assert.equal(await l.isSuppressed(ada, '2026-12-01T09:00:00.000Z'), false);
  });

  // Housekeeping, not a control: isSuppressed already ignores a rotated entry,
  // so a missed sweep cannot change what is withheld.
  it('marks rotated entries expired without changing behaviour', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    const before = await l.isSuppressed(ada, '2026-12-01T09:00:00.000Z');
    const expired = await l.expire('2026-12-01T09:00:00.000Z');
    const after = await l.isSuppressed(ada, '2026-12-01T09:00:00.000Z');

    assert.equal(expired, 1);
    assert.equal(before, after);
    assert.equal((await l.current(ada))?.status, 'expired');
  });

  it('does not expire an entry whose media has not rotated', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    assert.equal(await l.expire(NOW), 0);
  });
});

describe('SuppressionLedger — lifting', () => {
  // Restoring data somebody asked to have erased is a decision a person makes,
  // with an explanation recorded.
  it('requires a reason', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    await assert.rejects(l.lift(ada, '   '), /needs a reason/);
  });

  it('stops suppressing once lifted, and keeps the reason', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);
    await l.lift(ada, 'supervisory authority ordered restoration', NOW);

    assert.equal(await l.isSuppressed(ada, NOW), false);
    assert.equal((await l.current(ada))?.liftedReason, 'supervisory authority ordered restoration');
  });

  it('refuses to lift something never suppressed', async () => {
    await assert.rejects(ledger().lift(ada, 'mistake'), /never recorded/);
  });

  // The ledger is append-only, so the original suppression stays visible.
  it('keeps the original entry in the history', async () => {
    const store = new InMemoryLedgerStore();
    const l = ledger(store);
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);
    await l.lift(ada, 'ordered restoration', NOW);

    const history = await store.all();
    assert.equal(history.length, 2);
    assert.equal(history[0]?.status, 'active');
    assert.equal(history[1]?.status, 'lifted');
  });
});

describe('filterRestore', () => {
  interface Row {
    readonly email: string;
    readonly note: string;
  }

  const identify = (row: Row): Identifier => ({
    kind: 'email',
    value: row.email,
    system: 'acme-postgres',
  });

  /**
   * The deliverable. Everything else in this module exists so that this
   * assertion can be made: a restore does not bring an erased person back.
   */
  it('withholds a restored record belonging to an erased subject', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    const backup: Row[] = [
      { email: 'ada@example.com', note: 'erased last month' },
      { email: 'bob@example.com', note: 'never asked' },
    ];

    const result = await filterRestore(backup, identify, l, NOW);

    assert.deepEqual(result.admitted.map((r) => r.email), ['bob@example.com']);
    assert.deepEqual(result.withheld.map((r) => r.email), ['ada@example.com']);
  });

  it('admits everything when nobody has been erased', async () => {
    const backup: Row[] = [{ email: 'bob@example.com', note: 'x' }];
    const result = await filterRestore(backup, identify, ledger(), NOW);

    assert.equal(result.admitted.length, 1);
    assert.equal(result.withheld.length, 0);
  });

  it('admits the record again once the media has rotated', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    const backup: Row[] = [{ email: 'ada@example.com', note: 'x' }];
    const result = await filterRestore(backup, identify, l, '2026-12-01T09:00:00.000Z');

    // After rotation the backup no longer contains the row at all, so nothing
    // is being reintroduced — the filter simply has nothing left to withhold.
    assert.equal(result.admitted.length, 1);
  });

  // A record we cannot attribute might belong to an erased subject. Restoring
  // too little is recoverable by hand; restoring an erased person is not.
  it('withholds a record whose subject cannot be identified', async () => {
    const backup: Row[] = [{ email: '', note: 'orphan' }];
    const result = await filterRestore(backup, () => undefined, ledger(), NOW);

    assert.equal(result.withheld.length, 1);
    assert.equal(result.admitted.length, 0);
  });

  // Blocking a restore is an operational problem. Silently reintroducing
  // erased data is a breach.
  it('refuses to filter at all when the ledger cannot be read', async () => {
    const broken: LedgerStore = {
      async append() {},
      async find(): Promise<readonly SuppressionEntry[]> {
        throw new Error('database unreachable');
      },
      async all() {
        return [];
      },
    };

    const backup: Row[] = [{ email: 'bob@example.com', note: 'x' }];

    await assert.rejects(
      filterRestore(backup, identify, ledger(broken), NOW),
      (error: unknown) =>
        error instanceof LedgerUnavailableError && /Refusing to proceed/.test(error.message),
    );
  });
});

describe('SuppressionLedger — attestation', () => {
  it('reports how many identifiers are suppressed and when they clear', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);
    await l.suppress(bob, 'DSR-118', '2026-10-01T09:00:00.000Z', NOW);

    const attestation = await l.attestation('DSR-118');

    assert.equal(attestation?.identifiersSuppressed, 2);
    // The requester should be told when all of it is gone, not the earliest.
    assert.equal(attestation?.finalRotationAt, ROTATES);
    assert.equal(attestation?.statement, BEYOND_USE_STATEMENT);
  });

  it('says nothing when this request suppressed nothing', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-999', ROTATES, NOW);

    assert.equal(await l.attestation('DSR-118'), undefined);
  });

  it('drops out once every entry has rotated or been lifted', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);
    await l.lift(ada, 'ordered restoration', NOW);

    assert.equal(await l.attestation('DSR-118'), undefined);
  });

  it('states that the data is beyond use rather than deleted', async () => {
    const l = ledger();
    await l.suppress(ada, 'DSR-118', ROTATES, NOW);

    const attestation = await l.attestation('DSR-118');
    assert.match(attestation?.statement ?? '', /cannot re-enter a live system/);
    assert.match(attestation?.statement ?? '', /remain in backup media/);
  });
});
