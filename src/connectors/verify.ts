/**
 * Checking an agent's declared bindings against the tools it will really get.
 *
 * Two failures this is built to catch, both of which are silent today.
 *
 * **A read-only binding that is not.** The scout's safety is the claim that it
 * holds nothing which can write. If a connector's `@read-only` selector
 * resolves to a tool the server never annotated — or annotated wrongly — the
 * scout has delete access and nothing in the codebase would say so.
 *
 * **An ungated destructive tool on the executor.** `require_approval_for_tools`
 * lists the tools *we know about*. A server exposing one we did not think of
 * puts an unattended destructive call one model decision away from production.
 * This is the more likely of the two, because it needs no misconfiguration at
 * all — only a connector that gained a tool since the spec was written.
 *
 * Both are startup checks. Discovering them at runtime means discovering them
 * during an erasure.
 */

import type { AgentSpec, McpServerBinding } from '../agents/spec.ts';
import { bindingIsReadOnly } from '../agents/spec.ts';
import {
  classify,
  harnessTreatsAsReadOnly,
  isMutating,
  type ToolCatalog,
  type ToolDescriptor,
} from './catalog.ts';

export type ViolationSeverity = 'fatal' | 'warning';

export interface BindingViolation {
  readonly severity: ViolationSeverity;
  readonly server: string;
  readonly tool?: string;
  readonly message: string;
}

export interface VerificationReport {
  readonly agent: string;
  readonly violations: readonly BindingViolation[];
  /** Tools examined, for the record. */
  readonly toolsChecked: number;
}

export function isFatal(report: VerificationReport): boolean {
  return report.violations.some((v) => v.severity === 'fatal');
}

/**
 * Which tools a binding actually exposes.
 *
 * `@read-only` is resolved here the way the harness resolves it, so that what
 * we check is what the agent will get rather than what we hope it will.
 */
export function exposedTools(
  binding: McpServerBinding,
  available: readonly ToolDescriptor[],
): readonly ToolDescriptor[] {
  if (binding.enableTools === '@all') return filterDisabled(binding, available);

  if (binding.enableTools === '@read-only') {
    // Resolved with the harness's rule, not ours. Using our stricter one would
    // filter out exactly the tools this check exists to catch.
    return filterDisabled(
      binding,
      available.filter((tool) => harnessTreatsAsReadOnly(tool)),
    );
  }

  const allowed = new Set(binding.enableTools);
  return filterDisabled(
    binding,
    available.filter((tool) => allowed.has(tool.name)),
  );
}

function filterDisabled(
  binding: McpServerBinding,
  tools: readonly ToolDescriptor[],
): readonly ToolDescriptor[] {
  const disabled = new Set(binding.disableTools ?? []);
  return disabled.size === 0 ? tools : tools.filter((tool) => !disabled.has(tool.name));
}

/**
 * Verify one agent against the live catalog.
 *
 * `expectReadOnly` says which guarantee to hold the agent to. It is passed in
 * rather than inferred from the spec, because inferring it from the same spec
 * being checked would make the check circular — it would confirm the agent is
 * what it says it is, which is never in doubt.
 */
export async function verifyAgent(
  spec: AgentSpec,
  catalog: ToolCatalog,
  expectReadOnly: boolean,
): Promise<VerificationReport> {
  const violations: BindingViolation[] = [];
  let toolsChecked = 0;

  for (const binding of spec.mcpServers) {
    let available: readonly ToolDescriptor[];

    try {
      available = await catalog.listTools(binding.name);
    } catch (error) {
      violations.push({
        severity: 'fatal',
        server: binding.name,
        message:
          `could not list tools: ${(error as Error).message}. An unverifiable ` +
          'connector is not a safe one.',
      });
      continue;
    }

    // A binding that resolves to nothing is not harmless. Discovery would run,
    // find no traces, and report a clean sweep — a result indistinguishable
    // from a subject who genuinely has no data in that system.
    const exposed = exposedTools(binding, available);
    if (exposed.length === 0) {
      violations.push({
        severity: 'fatal',
        server: binding.name,
        message:
          'exposes no tools. Discovery would report a clean sweep of this ' +
          'system, which is indistinguishable from finding nothing.',
      });
      continue;
    }

    toolsChecked += exposed.length;

    for (const tool of exposed) {
      const verdict = classify(tool);

      if (verdict === 'contradictory') {
        violations.push({
          severity: 'warning',
          server: binding.name,
          tool: tool.name,
          message:
            'is annotated read-only but named as though it mutates. Treated as ' +
            'mutating; the server configuration should be corrected.',
        });
      }

      if (expectReadOnly && verdict !== 'read_only') {
        violations.push({
          severity: 'fatal',
          server: binding.name,
          tool: tool.name,
          message:
            `can mutate ${binding.name}, but this agent must hold nothing that ` +
            'writes. Its safety is the absence of the capability, not a gate on it.',
        });
      }
    }

    if (!expectReadOnly && !bindingIsReadOnly(binding)) {
      violations.push(...ungatedWrites(binding, exposed));
    }
  }

  if (spec.mcpServers.length === 0) {
    violations.push({
      severity: 'fatal',
      server: '(none)',
      message: 'agent has no connectors, so it can reach nothing.',
    });
  }

  return { agent: spec.name, violations, toolsChecked };
}

/**
 * Destructive tools the binding exposes but does not gate.
 *
 * The likeliest real failure in this codebase: `require_approval_for_tools`
 * names the tools that existed when the spec was written, and a connector that
 * later gained one leaves it unattended.
 */
function ungatedWrites(
  binding: McpServerBinding,
  exposed: readonly ToolDescriptor[],
): readonly BindingViolation[] {
  const gated = new Set(binding.requireApprovalForTools ?? []);

  return exposed
    .filter((tool) => isMutating(tool) && !gated.has(tool.name))
    .map((tool) => ({
      severity: 'fatal' as const,
      server: binding.name,
      tool: tool.name,
      message:
        'can write but is not in require_approval_for_tools, so it would run ' +
        'unattended. Add it to the gate or remove it from enable_tools.',
    }));
}

/** Verify every agent, and refuse to start if any check is fatal. */
export async function verifyOrThrow(
  agents: readonly { readonly spec: AgentSpec; readonly expectReadOnly: boolean }[],
  catalog: ToolCatalog,
): Promise<readonly VerificationReport[]> {
  const reports = await Promise.all(
    agents.map(({ spec, expectReadOnly }) => verifyAgent(spec, catalog, expectReadOnly)),
  );

  const fatal = reports.filter(isFatal);
  if (fatal.length > 0) {
    throw new Error(
      'connector verification failed:\n' +
        fatal
          .flatMap((report) =>
            report.violations
              .filter((v) => v.severity === 'fatal')
              .map((v) => `  [${report.agent}] ${v.server}${v.tool ? `.${v.tool}` : ''}: ${v.message}`),
          )
          .join('\n'),
    );
  }

  return reports;
}

/** One-line summaries, for logging at startup. */
export function formatReport(report: VerificationReport): string {
  if (report.violations.length === 0) {
    return `${report.agent}: ${report.toolsChecked} tool(s) verified`;
  }

  const lines = report.violations.map(
    (v) => `  ${v.severity}: ${v.server}${v.tool ? `.${v.tool}` : ''} — ${v.message}`,
  );

  return [`${report.agent}: ${report.violations.length} issue(s)`, ...lines].join('\n');
}
