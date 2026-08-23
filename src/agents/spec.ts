/**
 * Agent specifications.
 *
 * Lethe runs on a self-hosted agent harness, and these are the declarations
 * handed to it. They are typed here rather than kept as loose JSON because
 * one of them encodes the system's central safety property, and a property
 * that matters is a property worth type-checking.
 *
 * That property: **the agent that finds personal data cannot delete it.**
 * Discovery is not an agent that has been instructed to behave — it is an
 * agent whose write tools are absent. See `assertReadOnly`.
 */

/** How much of a connected system's toolset an agent may see. */
export type ToolSelector =
  /** Every tool the server exposes. */
  | '@all'
  /** Only tools the server annotates as non-mutating. */
  | '@read-only'
  /** An explicit allow-list of tool names. */
  | readonly string[];

export interface McpServerBinding {
  /** Name of the connector as registered in the harness. Credentials live there. */
  readonly name: string;
  readonly enableTools: ToolSelector;
  /** Exceptions carved out of `enableTools`, applied after it resolves. */
  readonly disableTools?: readonly string[];
  /**
   * Tools that pause for human approval before running.
   *
   * Approval is a backstop, not the primary control. Where an agent has no
   * business writing at all, withhold the tools instead of gating them.
   */
  readonly requireApprovalForTools?: readonly string[];
  /**
   * Load this server's tool schemas up front rather than on demand. Worth it
   * only for small servers used on every run.
   */
  readonly preload?: boolean;
}

export interface AgentSpec {
  readonly name: string;
  readonly model: string;
  readonly instructions: string;
  readonly mcpServers: readonly McpServerBinding[];
  readonly skills: readonly string[];
  readonly config: AgentConfig;
}

export interface AgentConfig {
  /** Isolated execution for generated code. Required for simulation and skills. */
  readonly sandbox: { readonly enabled: boolean; readonly fileDownloads?: boolean };
  /** Parallel delegation. Subagents inherit the parent's tools — see the note below. */
  readonly subAgents: { readonly enabled: boolean };
  readonly generativeUi: { readonly enabled: boolean };
  readonly askUserQuestions: { readonly enabled: boolean };
  readonly contextManagement: {
    readonly compaction: { readonly enabled: boolean; readonly thresholdTokens: number };
    readonly largeToolResponse: { readonly enabled: boolean };
  };
  readonly iterationLimit: number;
}

/**
 * Whether a binding can mutate the system behind it.
 *
 * `@read-only` is resolved by the connector from the server's own tool
 * annotations, so it is trusted. An explicit allow-list is not — we cannot
 * tell from a tool name whether it writes, so any named list is treated as
 * potentially mutating. That is the safe direction to be wrong in.
 */
export function bindingIsReadOnly(binding: McpServerBinding): boolean {
  return binding.enableTools === '@read-only';
}

/**
 * Fail loudly if an agent meant to be read-only has been handed anything that
 * can write.
 *
 * Called at startup rather than trusted by review, because this is the kind of
 * mistake that is invisible in a diff — adding one connector to a list — and
 * catastrophic at runtime.
 */
export function assertReadOnly(spec: AgentSpec): void {
  const mutable = spec.mcpServers.filter((b) => !bindingIsReadOnly(b));

  if (mutable.length > 0) {
    const names = mutable.map((b) => b.name).join(', ');
    throw new Error(
      `agent "${spec.name}" is declared read-only but binds connectors that can ` +
        `mutate their systems: ${names}. Discovery must never hold write tools — ` +
        'gating them behind approval is not sufficient, because approval fatigue ' +
        'makes a gate that fires on every run worthless.',
    );
  }
}

/**
 * Fail loudly if any tool that can write is reachable without a human.
 *
 * The executor is allowed write tools, but never unattended ones.
 */
export function assertAllWritesGated(spec: AgentSpec): void {
  const ungated = spec.mcpServers.filter(
    (b) => !bindingIsReadOnly(b) && (b.requireApprovalForTools?.length ?? 0) === 0,
  );

  if (ungated.length > 0) {
    const names = ungated.map((b) => b.name).join(', ');
    throw new Error(
      `agent "${spec.name}" can write to ${names} with no approval gate. Every ` +
        'destructive tool must pause for a person.',
    );
  }
}

/**
 * Shared runtime configuration.
 *
 * A sweep across many systems produces far more intermediate output than it
 * does conclusions, so compaction and large-response offloading are on
 * everywhere. The iteration limit is a stop, not a target: a run that needs
 * more than this has lost the thread and should surface rather than grind.
 */
export const BASE_CONFIG: AgentConfig = {
  sandbox: { enabled: true, fileDownloads: true },
  subAgents: { enabled: true },
  generativeUi: { enabled: true },
  askUserQuestions: { enabled: true },
  contextManagement: {
    compaction: { enabled: true, thresholdTokens: 50_000 },
    largeToolResponse: { enabled: true },
  },
  iterationLimit: 100,
};
