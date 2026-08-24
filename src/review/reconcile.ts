/**
 * Reconciling what the executor asks to run against what was signed.
 *
 * The executor is instructed never to widen scope. Instructions are not a
 * control — a model that misreads a plan, or is steered by data it read along
 * the way, will happily request a deletion nobody authorised, and it will
 * arrive at the approval gate looking exactly like the ones that were.
 *
 * So every gated call is matched back to a line in the signed plan before a
 * person is asked about it. A call with no matching line is not a call to
 * approve carefully; it is a call to refuse, because the plan is the whole of
 * the authority the executor has.
 *
 * Matching fails closed. If the scope of a call cannot be determined — an
 * unrecognised tool, a missing argument — it is treated as out of scope. The
 * cost of being wrong in that direction is a refused run; the cost of being
 * wrong in the other is an unauthorised deletion.
 */

import type { Finding, Locator } from '../domain/finding.ts';
import type { SystemId } from '../domain/identity.ts';
import type { ErasurePlan, PlannedAction } from '../domain/plan.ts';
import type { ResolvedToolCall } from '../harness/event-index.ts';
import type { ApprovalRequest } from '../harness/turn-runner.ts';

/**
 * A stable handle for "the thing this touches", comparable across a tool call
 * and a finding. Deliberately coarse: it identifies the resource, not the rows
 * within it, because a predicate written by the executor cannot be compared to
 * one recorded at discovery without re-running both.
 */
export type ScopeKey = string;

export function scopeKeyOf(system: SystemId, kind: string, identifier: string): ScopeKey {
  return `${system}:${kind}:${identifier}`;
}

export function scopeKeyForLocator(system: SystemId, locator: Locator): ScopeKey {
  switch (locator.kind) {
    case 'table':
      return scopeKeyOf(system, 'table', `${locator.schema}.${locator.table}`);
    case 'object':
      return scopeKeyOf(system, 'object', `${locator.bucket}/${locator.key}`);
    case 'api_resource':
      return scopeKeyOf(system, 'api_resource', `${locator.resource}/${locator.id}`);
    case 'vector':
      return scopeKeyOf(system, 'vector', locator.index);
    case 'log_stream':
      return scopeKeyOf(system, 'log_stream', locator.stream);
  }
}

type ArgumentBag = Readonly<Record<string, unknown>>;

/**
 * How a tool's arguments identify what it touches.
 *
 * Declared rather than inferred, so adding a connector means adding a rule
 * here — and forgetting to means its calls fail closed rather than being
 * waved through.
 */
interface ScopeRule {
  readonly tools: readonly string[];
  readonly scope: (args: ArgumentBag) => { kind: string; identifier: string } | undefined;
}

function str(args: ArgumentBag, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export const DEFAULT_SCOPE_RULES: readonly ScopeRule[] = [
  {
    tools: ['delete_rows', 'anonymise_rows', 'execute_sql'],
    scope: (args) => {
      const table = str(args, 'table');
      if (!table) return undefined;
      // A bare table name and a schema-qualified one must not produce
      // different keys, or the same target reconciles inconsistently.
      const schema = str(args, 'schema') ?? 'public';
      const identifier = table.includes('.') ? table : `${schema}.${table}`;
      return { kind: 'table', identifier };
    },
  },
  {
    tools: ['delete_object'],
    scope: (args) => {
      const bucket = str(args, 'bucket');
      const key = str(args, 'key');
      return bucket && key ? { kind: 'object', identifier: `${bucket}/${key}` } : undefined;
    },
  },
  {
    tools: ['delete_customer'],
    scope: (args) => {
      const id = str(args, 'customer') ?? str(args, 'id');
      return id ? { kind: 'api_resource', identifier: `customer/${id}` } : undefined;
    },
  },
  {
    tools: ['delete_vectors', 'compact_index'],
    scope: (args) => {
      const index = str(args, 'index');
      return index ? { kind: 'vector', identifier: index } : undefined;
    },
  },
];

/**
 * Work out what a gated call would touch.
 *
 * Returns undefined when it cannot be determined, which callers must treat as
 * out of scope rather than as "no restriction".
 */
export function scopeKeyForCall(
  call: ResolvedToolCall,
  rules: readonly ScopeRule[] = DEFAULT_SCOPE_RULES,
): ScopeKey | undefined {
  const system = call.serverName;
  if (!system) return undefined;

  const rule = rules.find((r) => r.tools.includes(call.name));
  if (!rule) return undefined;

  const scope = rule.scope(call.arguments);
  if (!scope) return undefined;

  return scopeKeyOf(system, scope.kind, scope.identifier);
}

export interface AuthorisedCall {
  readonly request: ApprovalRequest;
  readonly action: PlannedAction;
  readonly scope: ScopeKey;
}

export interface UnauthorisedCall {
  readonly request: ApprovalRequest;
  readonly reason: UnauthorisedReason;
  /** Present when the scope resolved but matched no planned line. */
  readonly scope?: ScopeKey;
}

export type UnauthorisedReason =
  /** The call touches something no line in the signed plan covers. */
  | 'outside_plan'
  /** The tool is not one the reconciler knows how to scope. Fails closed. */
  | 'unrecognised_tool'
  /** Arguments did not identify a target. Fails closed. */
  | 'unscopeable_arguments'
  /** The arguments never finished streaming, so nothing can be checked. */
  | 'unresolved_call';

export type Reconciliation =
  | { readonly kind: 'authorised'; readonly calls: readonly AuthorisedCall[] }
  /**
   * At least one call is not covered by the signed plan. The run must stop:
   * the plan is the entire authority the executor holds, so a call outside it
   * has no authority at all, and asking a person to approve it turns the gate
   * back into the rubber stamp the plan was built to replace.
   */
  | {
      readonly kind: 'scope_violation';
      readonly authorised: readonly AuthorisedCall[];
      readonly unauthorised: readonly UnauthorisedCall[];
    };

/**
 * Match every gated call against the signed plan.
 *
 * `findings` supplies the locators the plan's actions refer to; without them a
 * planned action is only a finding id and cannot be compared to anything.
 */
export function reconcile(
  plan: ErasurePlan,
  findings: readonly Finding[],
  requests: readonly ApprovalRequest[],
  rules: readonly ScopeRule[] = DEFAULT_SCOPE_RULES,
): Reconciliation {
  const findingById = new Map(findings.map((f) => [f.id, f]));

  const plannedScopes = new Map<ScopeKey, PlannedAction>();
  for (const action of plan.actions) {
    // Retained, escalated and unerasable data is not to be touched, so a call
    // against it is a scope violation rather than an authorised one. For
    // unerasable especially: the disposition exists because no tool call can
    // erase it, so any tool call claiming to is wrong about something.
    if (
      action.disposition === 'retain' ||
      action.disposition === 'escalate' ||
      action.disposition === 'unerasable'
    )
      continue;

    const finding = findingById.get(action.findingId);
    if (!finding) continue;

    plannedScopes.set(scopeKeyForLocator(finding.system, finding.locator), action);
  }

  const authorised: AuthorisedCall[] = [];
  const unauthorised: UnauthorisedCall[] = [];

  for (const request of requests) {
    // Hoisted to a const: narrowing on a property access does not survive the
    // closure passed to find().
    const call = request.call;

    if (!call.complete) {
      unauthorised.push({ request, reason: 'unresolved_call' });
      continue;
    }

    const rule = rules.find((r) => r.tools.includes(call.name));
    if (!rule) {
      unauthorised.push({ request, reason: 'unrecognised_tool' });
      continue;
    }

    const scope = scopeKeyForCall(call, rules);
    if (!scope) {
      unauthorised.push({ request, reason: 'unscopeable_arguments' });
      continue;
    }

    const action = plannedScopes.get(scope);
    if (!action) {
      unauthorised.push({ request, reason: 'outside_plan', scope });
      continue;
    }

    authorised.push({ request, action, scope });
  }

  if (unauthorised.length > 0) {
    return { kind: 'scope_violation', authorised, unauthorised };
  }

  return { kind: 'authorised', calls: authorised };
}

/** Human-readable explanation, for the interface and the audit record. */
export function explainUnauthorised(call: UnauthorisedCall): string {
  const name = call.request.call.complete ? call.request.call.name : call.request.toolCallId;

  switch (call.reason) {
    case 'outside_plan':
      return (
        `${name} would touch ${call.scope}, which no line in the signed plan ` +
        'covers. The plan is the whole of the authority for this run.'
      );
    case 'unrecognised_tool':
      return (
        `${name} is not a tool this reconciler can scope, so it cannot be ` +
        'matched to the plan. Refused rather than assumed harmless.'
      );
    case 'unscopeable_arguments':
      return `${name} did not identify what it would touch, so it cannot be checked against the plan.`;
    case 'unresolved_call':
      return 'The arguments never finished streaming, so there is nothing to check against the plan.';
  }
}
