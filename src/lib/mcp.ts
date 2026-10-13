/**
 * Thin wrappers around Tauri `invoke` for MCP server discovery and configuration.
 *
 * Each function maps 1:1 to a Rust `#[tauri::command]` handler.
 */

import { invoke } from "@tauri-apps/api/core";

/** Environment variables for stdio MCP servers. */
export type McpEnv = Record<string, string>;

/**
 * A custom MCP server configured by the user.
 * Stored globally (user-level) and available across all projects.
 */
export interface McpCustomServer {
  /** Unique identifier for the custom server. */
  id: string;
  /** Display name for the server. */
  name: string;
  /** Command to run (e.g., "npx", "node", "python"). */
  command: string;
  /** Arguments to pass to the command. */
  args: string[];
  /** Environment variables for the server process. */
  env: McpEnv;
  /** Working directory for the server process. */
  workingDirectory?: string;
  /** Whether this server is enabled by default. */
  isEnabled: boolean;
  /** ISO timestamp of when the server was created. */
  createdAt: string;
}

/** Source of an MCP server discovery. */
export type McpServerSource = "project" | "user" | "local" | "custom";

/**
 * Stdio MCP server config (flattened from backend).
 * The backend uses `#[serde(flatten)]` so type fields are at the root level.
 */
interface McpStdioServerConfig {
  name: string;
  type: "stdio";
  command: string;
  args: string[];
  env: McpEnv;
  source?: McpServerSource;
}

/**
 * HTTP MCP server config (flattened from backend).
 * The backend uses `#[serde(flatten)]` so type fields are at the root level.
 */
interface McpHttpServerConfig {
  name: string;
  type: "http";
  url: string;
  source?: McpServerSource;
}

/** Union of all MCP server config types. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/**
 * Discovers MCP servers configured in the project's `.mcp.json`.
 * Results are cached by the backend.
 */
export async function getProjectMcpServers(projectPath: string): Promise<McpServerConfig[]> {
  return invoke<McpServerConfig[]>("get_project_mcp_servers", { projectPath });
}

/**
 * Re-parses the `.mcp.json` file for a project, updating the cache.
 */
export async function refreshProjectMcpServers(projectPath: string): Promise<McpServerConfig[]> {
  return invoke<McpServerConfig[]>("refresh_project_mcp_servers", { projectPath });
}

/**
 * Sets the enabled MCP server names for a specific session.
 */
export async function setSessionMcpServers(
  projectPath: string,
  sessionId: number,
  enabled: string[],
): Promise<void> {
  return invoke("set_session_mcp_servers", { projectPath, sessionId, enabled });
}

/**
 * Saves the default enabled MCP servers for a project.
 * These persist across app restarts.
 */
export async function saveProjectMcpDefaults(
  projectPath: string,
  enabledServers: string[],
): Promise<void> {
  return invoke("save_project_mcp_defaults", { projectPath, enabledServers });
}

/**
 * Loads the default enabled MCP servers for a project.
 * Returns null if no defaults have been saved.
 */
export async function loadProjectMcpDefaults(projectPath: string): Promise<string[] | null> {
  return invoke<string[] | null>("load_project_mcp_defaults", { projectPath });
}

/**
 * Writes a session-specific `.mcp.json` to the working directory.
 *
 * This MUST be called BEFORE launching the Claude CLI so it can discover
 * the configured MCP servers, including the Maestro status server.
 *
 * @param workingDir - Directory where the CLI will be launched
 * @param sessionId - Session ID for the Maestro MCP server env vars
 * @param projectPath - Project path for hash generation and server lookup
 * @param enabledServerNames - Names of MCP servers enabled for this session
 */
export async function writeSessionMcpConfig(
  workingDir: string,
  sessionId: number,
  projectPath: string,
  enabledServerNames: string[],
): Promise<void> {
  return invoke("write_session_mcp_config", {
    workingDir,
    sessionId,
    projectPath,
    enabledServerNames,
  });
}

/**
 * Writes a session-specific `opencode.json` for OpenCode CLI.
 *
 * This writes the Maestro MCP server configuration plus any enabled user MCP servers,
 * translated to OpenCode's config format.
 *
 * @param workingDir - Directory where opencode.json will be written
 * @param sessionId - Session ID for the Maestro MCP server env vars
 * @param projectPath - Project path for server lookup
 * @param enabledServerNames - Names of MCP servers enabled for this session
 */
export async function writeOpenCodeMcpConfig(
  workingDir: string,
  sessionId: number,
  projectPath: string,
  enabledServerNames: string[],
): Promise<void> {
  return invoke("write_opencode_mcp_config", {
    workingDir,
    sessionId,
    projectPath,
    enabledServerNames,
  });
}

/**
 * Removes a session-specific Maestro server from `.mcp.json`.
 *
 * This should be called when a session is killed to clean up the config file.
 * The function is idempotent - it does nothing if the session entry doesn't exist.
 *
 * @param workingDir - Directory containing the `.mcp.json` file
 * @param sessionId - Session ID to remove from the config
 */
export async function removeSessionMcpConfig(workingDir: string, sessionId: number): Promise<void> {
  return invoke("remove_session_mcp_config", { workingDir, sessionId });
}

/**
 * Removes a session-specific Maestro server from `opencode.json`.
 *
 * This should be called when an OpenCode session is killed to clean up the config file.
 *
 * @param workingDir - Directory containing the opencode.json file
 * @param sessionId - Session ID to remove from the config
 */
export async function removeOpenCodeMcpConfig(
  workingDir: string,
  sessionId: number,
): Promise<void> {
  return invoke("remove_opencode_mcp_config", { workingDir, sessionId });
}

/* ── Management of Claude Code's real MCP configuration ──
 *
 * These commands read and edit the files Claude Code itself uses:
 * project = <project>/.mcp.json, user/local = ~/.claude.json.
 * Enable/disable piggybacks on Claude Code's native per-project lists,
 * so toggles here are honored by the Claude CLI directly.
 */

/** Scope of a managed MCP server. `connector` = claude.ai account (toggle only). */
export type McpManagedScope = "project" | "user" | "local" | "connector";

/** A server as read from the real config files, with its raw JSON entry. */
export interface McpManagedServer {
  name: string;
  scope: McpManagedScope;
  /** Enabled for the current project (per Claude Code's disable lists). */
  enabled: boolean;
  /**
   * Project-scope only: in neither the enabled nor the disabled list, so
   * Claude Code treats it as awaiting user approval (won't load it yet).
   */
  pending: boolean;
  /** "stdio" | "http" | "sse" | … */
  transport: string;
  /** Raw config entry — command/args/env for stdio, url for http/sse. */
  config: Record<string, unknown>;
}

/** A claude.ai account connector. Defined remotely; only toggleable locally. */
export interface McpConnector {
  name: string;
  enabled: boolean;
}

/** Full management view for a project, read fresh from disk. */
export interface McpStatusView {
  servers: McpManagedServer[];
  connectors: McpConnector[];
}

/** Reads the full MCP management view for a project (no cache). */
export async function getMcpStatus(projectPath: string): Promise<McpStatusView> {
  return invoke<McpStatusView>("get_mcp_status", { projectPath });
}

/**
 * Adds or replaces a server in the real config file for the given scope.
 * With `overwrite: false` (Add flow) an existing same-name entry is an error
 * instead of being silently replaced.
 */
export async function upsertMcpServer(
  projectPath: string,
  scope: McpManagedScope,
  name: string,
  config: Record<string, unknown>,
  overwrite: boolean,
): Promise<void> {
  return invoke("upsert_mcp_server", { projectPath, scope, name, config, overwrite });
}

/** Removes a server from the real config file for the given scope. */
export async function removeMcpServer(
  projectPath: string,
  scope: McpManagedScope,
  name: string,
): Promise<void> {
  return invoke("remove_mcp_server", { projectPath, scope, name });
}

/** Enables/disables a server (or claude.ai connector) for this project. */
export async function setMcpServerEnabled(
  projectPath: string,
  scope: McpManagedScope,
  name: string,
  enabled: boolean,
): Promise<void> {
  return invoke("set_mcp_server_enabled", { projectPath, scope, name, enabled });
}

/**
 * Gets all custom MCP servers configured by the user.
 * Custom servers are stored globally and available across all projects.
 */
export async function getCustomMcpServers(): Promise<McpCustomServer[]> {
  return invoke<McpCustomServer[]>("get_custom_mcp_servers");
}

/**
 * Saves a custom MCP server configuration.
 * If the server already exists (by ID), it will be updated.
 */
export async function saveCustomMcpServer(server: McpCustomServer): Promise<void> {
  return invoke("save_custom_mcp_server", { server });
}

/**
 * Deletes a custom MCP server by ID.
 */
export async function deleteCustomMcpServer(serverId: string): Promise<void> {
  return invoke("delete_custom_mcp_server", { serverId });
}
