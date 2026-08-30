/**
 * Exporting an agent spec as the harness's documented manifest.
 *
 * The internal `AgentSpec` and the wire manifest are different on purpose,
 * for the same reason the event protocol is: the internal type is what the
 * safety assertions run against, and the manifest is what `POST
 * /api/v1/agents` and inline session specs accept — snake_case fields,
 * skills as objects, the compaction threshold under its long name. This file
 * is the only one that knows both, so the next divergence in the API is a
 * one-file fix.
 *
 * The export is where the specs stop being documentation. Until it existed,
 * `assertReadOnly` guarded a TypeScript object the harness never saw; now the
 * object it guards is the one the harness runs.
 */

import type { AgentSpec, McpServerBinding } from './spec.ts';

/** The manifest shape `POST /api/v1/agents` documents. */
export interface WireManifest {
  readonly model: { readonly name: string };
  readonly instructions: string;
  readonly mcp_servers: readonly WireMcpServer[];
  readonly skills: readonly { readonly name: string }[];
  readonly config: WireConfig;
}

export interface WireMcpServer {
  readonly name: string;
  readonly enable_tools: readonly string[];
  readonly disable_tools?: readonly string[];
  readonly preload?: boolean;
  readonly require_approval_for_tools?: readonly string[];
}

export interface WireConfig {
  readonly sandbox: { readonly enabled: boolean; readonly file_downloads?: boolean };
  readonly generative_ui: { readonly enabled: boolean };
  readonly ask_user_questions: { readonly enabled: boolean };
  readonly dynamic_sub_agents: { readonly enabled: boolean };
  readonly context_management: {
    readonly compaction: {
      readonly enabled: boolean;
    };
    readonly large_tool_response: { readonly enabled: boolean };
  };
  readonly iteration_limit: number;
}

/** Agent names the registry accepts: lowercase, dot/dash/underscore, 2–64. */
const AGENT_NAME = /^[a-z](?:[a-z0-9._-]{0,62}[a-z0-9])$/;

export function toManifest(spec: AgentSpec): WireManifest {
  return {
    model: { name: spec.model },
    instructions: spec.instructions,
    mcp_servers: spec.mcpServers.map(toWireServer),
    // Skills are objects on the wire, not bare strings.
    skills: spec.skills.map((name) => ({ name })),
    config: {
      sandbox: {
        enabled: spec.config.sandbox.enabled,
        ...(spec.config.sandbox.fileDownloads !== undefined
          ? { file_downloads: spec.config.sandbox.fileDownloads }
          : {}),
      },
      generative_ui: { enabled: spec.config.generativeUi.enabled },
      ask_user_questions: { enabled: spec.config.askUserQuestions.enabled },
      dynamic_sub_agents: { enabled: spec.config.subAgents.enabled },
      context_management: {
        // The live server (0.2.0-rc.0) rejects the docs' threshold field:
        // CompactionConfig is additionalProperties:false with enabled+trigger,
        // and the sensible default (80% of model context) needs no trigger.
        // Found by the first live session-create, not by the docs.
        compaction: {
          enabled: spec.config.contextManagement.compaction.enabled,
        },
        large_tool_response: {
          enabled: spec.config.contextManagement.largeToolResponse.enabled,
        },
      },
      iteration_limit: spec.config.iterationLimit,
    },
  };
}

function toWireServer(binding: McpServerBinding): WireMcpServer {
  // The selector forms (`@read-only`, `@all`) travel as a one-element array;
  // an explicit list travels as itself.
  const enable = typeof binding.enableTools === 'string' ? [binding.enableTools] : binding.enableTools;

  return {
    name: binding.name,
    enable_tools: enable,
    ...(binding.disableTools !== undefined ? { disable_tools: binding.disableTools } : {}),
    ...(binding.preload !== undefined ? { preload: binding.preload } : {}),
    ...(binding.requireApprovalForTools !== undefined
      ? { require_approval_for_tools: binding.requireApprovalForTools }
      : {}),
  };
}

/**
 * The full registration request, for `POST /api/v1/agents`.
 *
 * The name is validated here rather than left to the server, because the
 * registry's 404 for a malformed name arrives much later — at session
 * creation — where it reads as "agent not found" and sends whoever is
 * debugging toward the wrong problem.
 */
export function toCreateAgentRequest(
  name: string,
  spec: AgentSpec,
): { readonly name: string; readonly manifest: WireManifest } {
  if (!AGENT_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a valid agent name: lowercase letters, digits, dot, ` +
        'dash and underscore, starting with a letter, 2-64 characters.',
    );
  }

  return { name, manifest: toManifest(spec) };
}
