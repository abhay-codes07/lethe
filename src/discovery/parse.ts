/**
 * Turning what the agent said into findings we are willing to act on.
 *
 * Everything downstream — the plan, the blast radius, the approval card, the
 * certificate — is computed from findings. A finding is therefore the point
 * where a model's output stops being text and starts being an instruction to
 * delete somebody's data.
 *
 * So this layer is adversarial by design. Not because the model is hostile,
 * but because it does not have to be: a scout that misreads a schema, or is
 * steered by a support ticket that happens to contain instructions, produces
 * output shaped exactly like a good result. Downstream code cannot tell the
 * difference, and the approval card would render an invented target as
 * confidently as a real one.
 *
 * Two rules carry most of the weight.
 *
 * **A finding may only reference an identifier already in the identity
 * graph.** The graph is built from verified seeds and recorded derivations, so
 * requiring membership means the agent cannot introduce a subject. Without it,
 * "delete everything matching bob@example.com" is a sentence the model can
 * simply write.
 *
 * **A finding may only name a declared connector.** A system nobody configured
 * is a system nobody can verify was read-only.
 */

import type { DataCategory, Durability, Finding, Locator } from '../domain/finding.ts';
import { type Identifier, type IdentityGraph, identifierKey, type SystemId } from '../domain/identity.ts';

export interface ParseError {
  /** Position in the findings array, where the failure is attributable. */
  readonly index?: number;
  readonly field?: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly findings: readonly Finding[] }
  | { readonly ok: false; readonly errors: readonly ParseError[] };

export interface ParseContext {
  /** Connectors the agent was actually given. Anything else is invented. */
  readonly knownSystems: ReadonlySet<SystemId>;
  /** Identifiers established by discovery. A finding may not add to these. */
  readonly identities: IdentityGraph;
}

const CATEGORIES: ReadonlySet<string> = new Set<DataCategory>([
  'identity',
  'contact',
  'financial',
  'behavioural',
  'communications',
  'special_category',
  'derived',
]);

const DURABILITIES: ReadonlySet<string> = new Set<Durability>([
  'hard_delete',
  'requires_compaction',
  'immutable_until_expiry',
]);

const IDENTIFIER_KINDS: ReadonlySet<string> = new Set([
  'email',
  'phone',
  'user_id',
  'account_id',
  'stripe_customer',
  'support_contact',
  'device_id',
  'vector_document',
  'object_key',
]);

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse a scout's reply.
 *
 * Collects every error rather than stopping at the first. A run that produced
 * eight malformed findings needs one report, not eight round trips.
 */
export function parseFindings(raw: unknown, context: ParseContext): ParseResult {
  const errors: ParseError[] = [];

  const payload = typeof raw === 'string' ? tryJson(raw, errors) : raw;
  if (errors.length > 0) return { ok: false, errors };

  if (!isBag(payload)) {
    return { ok: false, errors: [{ message: 'expected an object with a "findings" array' }] };
  }

  const list = payload['findings'];
  if (!Array.isArray(list)) {
    return { ok: false, errors: [{ field: 'findings', message: 'expected an array' }] };
  }

  const findings: Finding[] = [];
  const seenIds = new Set<string>();

  list.forEach((entry, index) => {
    const parsed = parseOne(entry, index, context, seenIds, errors);
    if (parsed) {
      findings.push(parsed);
      seenIds.add(parsed.id);
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, findings };
}

function tryJson(raw: string, errors: ParseError[]): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    errors.push({ message: 'reply is not valid JSON' });
    return undefined;
  }
}

function parseOne(
  entry: unknown,
  index: number,
  context: ParseContext,
  seenIds: ReadonlySet<string>,
  errors: ParseError[],
): Finding | undefined {
  const before = errors.length;
  const fail = (field: string, message: string): void => {
    errors.push({ index, field, message });
  };

  if (!isBag(entry)) {
    fail('', 'expected an object');
    return undefined;
  }

  const id = entry['id'];
  if (typeof id !== 'string' || id.trim() === '') {
    fail('id', 'must be a non-empty string');
  } else if (seenIds.has(id)) {
    // Duplicates would double-count records on the approval card, and the
    // count is the figure a person judges the request by.
    fail('id', `duplicate finding id "${id}"`);
  }

  const system = entry['system'];
  if (typeof system !== 'string' || !context.knownSystems.has(system)) {
    fail(
      'system',
      `"${String(system)}" is not a configured connector. A system nobody ` +
        'declared is a system nobody verified was read-only.',
    );
  }

  const category = entry['category'];
  if (typeof category !== 'string' || !CATEGORIES.has(category)) {
    fail('category', `"${String(category)}" is not a known data category`);
  }

  const durability = entry['durability'];
  if (typeof durability !== 'string' || !DURABILITIES.has(durability)) {
    fail(
      'durability',
      `"${String(durability)}" is not a known durability. This decides whether a ` +
        'delete actually deletes, so it cannot be guessed.',
    );
  }

  const count = entry['count'];
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    fail('count', 'must be a whole number of at least one; zero traces is not a finding');
  }

  const observedAt = entry['observedAt'];
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
    fail('observedAt', 'must be an ISO timestamp');
  }

  const locator = parseLocator(entry['locator'], fail);
  const matchedBy = parseMatchedBy(entry['matchedBy'], context, fail);

  if (errors.length !== before) return undefined;

  return {
    id: id as string,
    system: system as SystemId,
    locator: locator!,
    category: category as DataCategory,
    durability: durability as Durability,
    count: count as number,
    matchedBy: matchedBy!,
    observedAt: observedAt as string,
    ...(parseDependents(entry['dependents']) ?? {}),
  };
}

function parseDependents(value: unknown): { dependents: readonly string[] } | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((v): v is string => typeof v === 'string');
  return ids.length > 0 ? { dependents: ids } : undefined;
}

function parseLocator(
  value: unknown,
  fail: (field: string, message: string) => void,
): Locator | undefined {
  if (!isBag(value)) {
    fail('locator', 'must be an object');
    return undefined;
  }

  const kind = value['kind'];
  const text = (key: string): string | undefined => {
    const found = value[key];
    return typeof found === 'string' && found !== '' ? found : undefined;
  };

  switch (kind) {
    case 'table': {
      const schema = text('schema');
      const table = text('table');
      const predicate = text('predicate');
      if (!schema || !table || !predicate) {
        fail('locator', 'a table locator needs schema, table and predicate');
        return undefined;
      }
      return { kind: 'table', schema, table, predicate };
    }
    case 'object': {
      const bucket = text('bucket');
      const key = text('key');
      if (!bucket || !key) {
        fail('locator', 'an object locator needs bucket and key');
        return undefined;
      }
      return { kind: 'object', bucket, key };
    }
    case 'api_resource': {
      const resource = text('resource');
      const id = text('id');
      if (!resource || !id) {
        fail('locator', 'an api_resource locator needs resource and id');
        return undefined;
      }
      return { kind: 'api_resource', resource, id };
    }
    case 'vector': {
      const index = text('index');
      const documentIds = value['documentIds'];
      if (!index || !Array.isArray(documentIds) || documentIds.length === 0) {
        fail('locator', 'a vector locator needs an index and at least one document id');
        return undefined;
      }
      const ids = documentIds.filter((d): d is string => typeof d === 'string');
      if (ids.length !== documentIds.length) {
        fail('locator', 'vector document ids must all be strings');
        return undefined;
      }
      return { kind: 'vector', index, documentIds: ids };
    }
    case 'log_stream': {
      const stream = text('stream');
      const window = text('window');
      if (!stream || !window) {
        fail('locator', 'a log_stream locator needs stream and window');
        return undefined;
      }
      return { kind: 'log_stream', stream, window };
    }
    default:
      fail('locator', `"${String(kind)}" is not a known locator kind`);
      return undefined;
  }
}

/**
 * The rule that stops the agent inventing a subject.
 *
 * A finding must attach to an identifier the identity graph already holds.
 * The graph is built from a verified seed and recorded derivations, each with
 * its provenance, so membership is the difference between "this row belongs to
 * the person who asked" and "the model wrote an email address".
 */
function parseMatchedBy(
  value: unknown,
  context: ParseContext,
  fail: (field: string, message: string) => void,
): Identifier | undefined {
  if (!isBag(value)) {
    fail('matchedBy', 'must be an object naming the identifier this was found by');
    return undefined;
  }

  const kind = value['kind'];
  const identifierValue = value['value'];
  const system = value['system'];

  if (typeof kind !== 'string' || !IDENTIFIER_KINDS.has(kind)) {
    fail('matchedBy.kind', `"${String(kind)}" is not a known identifier kind`);
    return undefined;
  }
  if (typeof identifierValue !== 'string' || identifierValue === '') {
    fail('matchedBy.value', 'must be a non-empty string');
    return undefined;
  }
  if (typeof system !== 'string') {
    fail('matchedBy.system', 'must name the system the identifier is meaningful in');
    return undefined;
  }

  const identifier: Identifier = { kind: kind as Identifier['kind'], value: identifierValue, system };

  if (!context.identities.has(identifier)) {
    fail(
      'matchedBy',
      `${identifierKey(identifier)} is not in the identity graph. A finding may ` +
        'only reference an identifier discovery established, or the agent could ' +
        "introduce a subject and delete a different person's data.",
    );
    return undefined;
  }

  return identifier;
}

/** Render errors for a log line or a run report. */
export function formatErrors(errors: readonly ParseError[]): string {
  return errors
    .map((error) => {
      const where = error.index === undefined ? '' : `findings[${error.index}]`;
      const field = error.field ? `${where ? '.' : ''}${error.field}` : '';
      return `  ${where}${field}${where || field ? ': ' : ''}${error.message}`;
    })
    .join('\n');
}
