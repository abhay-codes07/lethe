/**
 * What a connected system actually exposes.
 *
 * Every safety guarantee in this project so far rests on a claim we have never
 * checked: that `@read-only` means what it says. The scout is safe because its
 * bindings are read-only; the executor is safe because its destructive tools
 * are named in `require_approval_for_tools`. Both are assertions about our own
 * spec, and neither has ever been compared to the tools the harness will
 * really hand the agent.
 *
 * This module is that comparison.
 *
 * The trust model is worth stating plainly. Tool annotations come from the MCP
 * server, which is software somebody else configured. `readOnlyHint` is a
 * claim by that operator, not a property the harness verifies. A server can be
 * misconfigured, out of date, or simply wrong, and a tool called
 * `purge_customer` can arrive annotated as read-only. So annotations are
 * treated as evidence rather than proof, and cross-checked against the one
 * thing the server cannot misreport: what the tool is called.
 */

/** A tool as the harness reports it, including the server's own claims. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly annotations?: ToolAnnotations;
}

/**
 * Hints supplied by the MCP server. Named `Hint` in the protocol for a
 * reason — they are advisory, and absent far more often than they are wrong.
 */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
}

export interface ToolCatalog {
  /** Tools the harness would expose for a registered connector. */
  listTools(serverName: string): Promise<readonly ToolDescriptor[]>;
}

/**
 * Name fragments that indicate a tool mutates, whatever it claims.
 *
 * This list exists because an annotation is the operator's word. It is a
 * backstop against a misconfigured server, not a security boundary against a
 * hostile one — a determined name like `fetch_records` that quietly deletes
 * would pass. It catches the realistic failure: a server that never set
 * annotations at all, or set them wrong.
 */
const MUTATING_WORDS: readonly string[] = [
  'delete',
  'drop',
  'purge',
  'truncate',
  'remove',
  'destroy',
  'erase',
  'write',
  'update',
  'upsert',
  'insert',
  'create',
  'modify',
  'patch',
  'set',
  'exec',
  'execute',
  'anonymise',
  'anonymize',
  'compact',
  'rotate',
  'revoke',
];

/**
 * Split a tool name into words.
 *
 * Underscores are word characters as far as a regular expression is
 * concerned, so `\bdelete\b` does not match `delete_rows` — it matches the
 * plain-English phrasing nobody names a tool with. Separators and camelCase
 * boundaries are turned into spaces first so the words are actually
 * addressable.
 */
function words(toolName: string): readonly string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

export function nameSuggestsMutation(toolName: string): boolean {
  const parts = new Set(words(toolName));
  return MUTATING_WORDS.some((word) => parts.has(word));
}

export type MutationVerdict =
  /** The server says it mutates, or the name gives it away. */
  | 'mutating'
  /** Annotated read-only and the name agrees. */
  | 'read_only'
  /**
   * The server annotated it read-only but the name says otherwise. Treated as
   * mutating, and reported separately because a contradiction is a
   * misconfiguration somebody should fix rather than a routine finding.
   */
  | 'contradictory';

/**
 * Decide whether a tool can mutate.
 *
 * Unannotated tools are treated as mutating. Most servers annotate nothing,
 * and defaulting an unknown tool to safe would quietly hand the scout write
 * access the moment a connector was added by someone who did not know to
 * check.
 */
export function classify(tool: ToolDescriptor): MutationVerdict {
  const suspiciousName = nameSuggestsMutation(tool.name);
  const annotations = tool.annotations;

  if (annotations?.destructiveHint === true) return 'mutating';

  if (annotations?.readOnlyHint === true) {
    return suspiciousName ? 'contradictory' : 'read_only';
  }

  // No usable annotation: the name is all we have, and absence of evidence
  // that it is safe is not evidence that it is.
  return 'mutating';
}

export function isMutating(tool: ToolDescriptor): boolean {
  return classify(tool) !== 'read_only';
}

/**
 * Whether the harness would expose this tool under an `@read-only` selector.
 *
 * Deliberately more permissive than `classify`, and the difference is the
 * whole point of verifying anything. The harness resolves `@read-only` from
 * the server's annotation, because that is all it has. We additionally
 * disbelieve an annotation the tool's own name contradicts.
 *
 * So a tool called `delete_rows` annotated `readOnlyHint: true` *is* exposed
 * to a read-only agent by the harness, and is caught here as a violation. If
 * this function applied our stricter rule instead, the tool would never appear
 * in the exposed set and the check would silently pass — verifying our
 * opinion of the spec rather than what the agent actually receives.
 */
export function harnessTreatsAsReadOnly(tool: ToolDescriptor): boolean {
  const annotations = tool.annotations;
  if (!annotations) return false;
  return annotations.readOnlyHint === true && annotations.destructiveHint !== true;
}
