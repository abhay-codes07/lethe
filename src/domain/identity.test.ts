import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IdentityGraph, identifierKey, type Identifier } from './identity.ts';

const email: Identifier = { kind: 'email', value: 'ada@example.com', system: 'acme-postgres' };
const userId: Identifier = { kind: 'user_id', value: '4471', system: 'acme-postgres' };
const stripeId: Identifier = { kind: 'stripe_customer', value: 'cus_123', system: 'acme-stripe' };

describe('identifierKey', () => {
  it('distinguishes the same value in different systems', () => {
    const inPostgres: Identifier = { kind: 'user_id', value: '1', system: 'acme-postgres' };
    const inStripe: Identifier = { kind: 'user_id', value: '1', system: 'acme-stripe' };
    assert.notEqual(identifierKey(inPostgres), identifierKey(inStripe));
  });
});

describe('IdentityGraph', () => {
  it('records seeds as verified rather than inferred', () => {
    const graph = new IdentityGraph([email]);
    assert.equal(graph.get(email)?.provenance.kind, 'seed');
  });

  it('links a derived identifier back to its source', () => {
    const graph = new IdentityGraph([email]);
    const added = graph.derive(userId, email, 'users.email = $1 -> users.id', 'certain');

    assert.equal(added, true);
    assert.equal(graph.size, 2);
    assert.equal(graph.get(userId)?.provenance.kind, 'derived');
  });

  it('refuses to derive from an identifier it has never seen', () => {
    const graph = new IdentityGraph([email]);
    assert.throws(
      () => graph.derive(stripeId, userId, 'users.stripe_id', 'certain'),
      /must already be part of the identity graph/,
    );
  });

  // Scouts run in parallel and will rediscover the same links. That is normal,
  // and must not let a weaker path overwrite an established one.
  it('keeps the first provenance when an identifier is rediscovered', () => {
    const graph = new IdentityGraph([email]);
    graph.derive(userId, email, 'users.email = $1 -> users.id', 'certain');

    const readded = graph.derive(userId, email, 'fuzzy name match', 'possible');

    assert.equal(readded, false);
    assert.equal(graph.size, 2);
    const provenance = graph.get(userId)?.provenance;
    assert.equal(provenance?.kind === 'derived' && provenance.confidence, 'certain');
  });

  it('surfaces weakly-linked identifiers for human confirmation', () => {
    const graph = new IdentityGraph([email]);
    graph.derive(userId, email, 'users.email = $1 -> users.id', 'certain');
    graph.derive(stripeId, userId, 'shared billing postcode', 'possible');

    const uncertain = graph.uncertain();

    assert.equal(uncertain.length, 1);
    assert.equal(uncertain[0]?.identifier.value, 'cus_123');
  });

  it('scopes identifiers to the system that understands them', () => {
    const graph = new IdentityGraph([email]);
    graph.derive(userId, email, 'users.email = $1 -> users.id', 'certain');
    graph.derive(stripeId, userId, 'users.stripe_customer_id', 'certain');

    assert.equal(graph.forSystem('acme-postgres').length, 2);
    assert.equal(graph.forSystem('acme-stripe').length, 1);
  });

  it('reconstructs the reasoning from seed to identifier, oldest first', () => {
    const graph = new IdentityGraph([email]);
    graph.derive(userId, email, 'users.email = $1 -> users.id', 'certain');
    graph.derive(stripeId, userId, 'users.stripe_customer_id', 'certain');

    const chain = graph.provenanceChain(stripeId).map((r) => r.identifier.value);

    assert.deepEqual(chain, ['ada@example.com', '4471', 'cus_123']);
  });

  it('returns an empty chain for an identifier it does not hold', () => {
    const graph = new IdentityGraph([email]);
    assert.deepEqual(graph.provenanceChain(stripeId), []);
  });
});
