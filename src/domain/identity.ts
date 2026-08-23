/**
 * Identity resolution.
 *
 * A person is almost never stored under one identifier. A deletion request
 * arrives with an email address; the data actually sits under a user id in
 * Postgres, a customer id in Stripe, a set of document ids in a vector index,
 * and a device id in an analytics table. Erasing only what the email matches
 * leaves most of the person behind.
 *
 * So discovery starts by expanding one seed identifier into the full set, and
 * records *how* each one was reached. That provenance matters: an identifier
 * we cannot justify is an identifier we must not delete against, because the
 * cost of a wrong link is erasing a different person's data.
 */

/** The kinds of handle a subject can be known by across connected systems. */
export type IdentifierKind =
  | 'email'
  | 'phone'
  | 'user_id'
  | 'account_id'
  | 'stripe_customer'
  | 'support_contact'
  | 'device_id'
  | 'vector_document'
  | 'object_key';

/** Stable name of a connected system, e.g. `acme-postgres`. */
export type SystemId = string;

export interface Identifier {
  readonly kind: IdentifierKind;
  readonly value: string;
  /** The system this identifier is meaningful in. */
  readonly system: SystemId;
}

/**
 * Why we believe an identifier belongs to the subject.
 *
 * `seed` is asserted by the requester and verified out of band. Everything
 * else is inferred, and inference can be wrong.
 */
export type Provenance =
  | { readonly kind: 'seed'; readonly verifiedAt: string }
  | {
      readonly kind: 'derived';
      /** The identifier this one was reached from. */
      readonly from: Identifier;
      /** Human-readable justification, e.g. "users.email = $1 -> users.id". */
      readonly rule: string;
      /**
       * Confidence in the link. Anything below `certain` needs a human to
       * confirm before it is deleted against.
       */
      readonly confidence: LinkConfidence;
    };

/**
 * `certain`   unique key or foreign key — the database guarantees the link.
 * `probable`  strong but not enforced, e.g. matching normalised email.
 * `possible`  heuristic, e.g. shared device or name similarity.
 */
export type LinkConfidence = 'certain' | 'probable' | 'possible';

export interface ResolvedIdentifier {
  readonly identifier: Identifier;
  readonly provenance: Provenance;
}

/** Canonical string form, used for de-duplication and stable ordering. */
export function identifierKey(id: Identifier): string {
  return `${id.system}:${id.kind}:${id.value}`;
}

/**
 * The set of identifiers belonging to one subject, and how each was reached.
 *
 * Deliberately append-only: an identity graph is evidence, and evidence that
 * can be quietly rewritten is not evidence. Narrowing happens at planning
 * time by filtering, never by deleting from the graph.
 */
export class IdentityGraph {
  readonly #nodes = new Map<string, ResolvedIdentifier>();

  constructor(seeds: readonly Identifier[] = [], verifiedAt = new Date().toISOString()) {
    for (const seed of seeds) {
      this.#nodes.set(identifierKey(seed), {
        identifier: seed,
        provenance: { kind: 'seed', verifiedAt },
      });
    }
  }

  /**
   * Record an identifier reached from one already in the graph.
   *
   * Returns `false` if the identifier was already known — discovery fans out
   * across systems in parallel and will rediscover the same links, which is
   * expected rather than an error. The first provenance recorded wins, so a
   * later weaker path cannot downgrade an established one.
   */
  derive(next: Identifier, from: Identifier, rule: string, confidence: LinkConfidence): boolean {
    const fromKey = identifierKey(from);
    if (!this.#nodes.has(fromKey)) {
      throw new Error(
        `cannot derive ${identifierKey(next)} from unknown identifier ${fromKey}: ` +
          'the source must already be part of the identity graph',
      );
    }

    const key = identifierKey(next);
    if (this.#nodes.has(key)) return false;

    this.#nodes.set(key, {
      identifier: next,
      provenance: { kind: 'derived', from, rule, confidence },
    });
    return true;
  }

  has(id: Identifier): boolean {
    return this.#nodes.has(identifierKey(id));
  }

  get(id: Identifier): ResolvedIdentifier | undefined {
    return this.#nodes.get(identifierKey(id));
  }

  get size(): number {
    return this.#nodes.size;
  }

  all(): readonly ResolvedIdentifier[] {
    return [...this.#nodes.values()];
  }

  /** Identifiers meaningful in one system, for handing to that system's scout. */
  forSystem(system: SystemId): readonly ResolvedIdentifier[] {
    return this.all().filter((n) => n.identifier.system === system);
  }

  /**
   * Identifiers reached only by inference weaker than `certain`.
   *
   * These are the ones worth putting in front of a human before anything is
   * deleted against them.
   */
  uncertain(): readonly ResolvedIdentifier[] {
    return this.all().filter(
      (n) => n.provenance.kind === 'derived' && n.provenance.confidence !== 'certain',
    );
  }

  /**
   * The chain of reasoning from a seed to this identifier, oldest first.
   *
   * This is what gets printed next to a finding when someone asks "why do you
   * think this row is theirs?".
   */
  provenanceChain(id: Identifier): readonly ResolvedIdentifier[] {
    const chain: ResolvedIdentifier[] = [];
    const seen = new Set<string>();

    let cursor = this.#nodes.get(identifierKey(id));
    while (cursor) {
      const key = identifierKey(cursor.identifier);
      // The graph is built append-only from existing nodes, so a cycle should
      // be unreachable — but a truncated chain beats an infinite loop.
      if (seen.has(key)) break;
      seen.add(key);

      chain.push(cursor);
      if (cursor.provenance.kind === 'seed') break;
      cursor = this.#nodes.get(identifierKey(cursor.provenance.from));
    }

    return chain.reverse();
  }
}
