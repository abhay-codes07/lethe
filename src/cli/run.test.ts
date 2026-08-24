import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArgs, rotationDate } from './run.ts';

describe('parseArgs', () => {
  it('reads the request id and subject email', () => {
    assert.deepEqual(parseArgs(['DSR-1', 'ada@example.invalid']), {
      requestId: 'DSR-1',
      seedEmail: 'ada@example.invalid',
    });
  });

  // Defaulting the subject of an erasure request is not a convenience anybody
  // should want.
  it('refuses to default either argument', () => {
    assert.throws(() => parseArgs(['DSR-1']), /usage/);
    assert.throws(() => parseArgs([]), /usage/);
  });

  it('rejects a subject that does not look like an email', () => {
    assert.throws(() => parseArgs(['DSR-1', 'not-an-email']), /does not look like an email/);
  });
});

describe('rotationDate', () => {
  it('is ninety days out', () => {
    const now = new Date('2026-08-24T09:00:00.000Z');
    assert.equal(rotationDate(now), '2026-11-22T09:00:00.000Z');
  });
});
