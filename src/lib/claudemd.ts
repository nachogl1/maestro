import { invoke } from "@tauri-apps/api/core";

/** Status of CLAUDE.md file at project root */
export interface ClaudeMdStatus {
  exists: boolean;
  path: string;
  content: string | null;
}

/** A context doc/config file surfaced in the sidebar. */
export type ContextDocTier = "user" | "project";
export type ContextDocKind = "claude" | "agents" | "readme" | "gitignore" | "settings" | "mcp";

export interface ContextDoc {
  tier: ContextDocTier;
  kind: ContextDocKind;
  /** Display label (the filename, e.g. "CLAUDE.md"). */
  label: string;
  path: string;
  exists: boolean;
}

/** Check if CLAUDE.md exists at project root */
export async function checkClaudeMd(projectPath: string): Promise<ClaudeMdStatus> {
  return invoke<ClaudeMdStatus>("check_claude_md", { projectPath });
}

/** Read CLAUDE.md content */
export async function readClaudeMd(projectPath: string): Promise<string> {
  return invoke<string>("read_claude_md", { projectPath });
}

/** Write CLAUDE.md content (creates or updates) */
export async function writeClaudeMd(projectPath: string, content: string): Promise<void> {
  return invoke<void>("write_claude_md", { projectPath, content });
}

/** List all context docs (user + project) for the active project. */
export async function listContextDocs(projectPath: string): Promise<ContextDoc[]> {
  return invoke<ContextDoc[]>("list_context_docs", { projectPath });
}

/** Read a context doc by absolute path. Returns "" if the file doesn't exist. */
export async function readContextDoc(path: string): Promise<string> {
  return invoke<string>("read_context_doc", { path });
}

/** Write a context doc by absolute path (creates parent dirs as needed). */
export async function writeContextDoc(path: string, content: string): Promise<void> {
  return invoke<void>("write_context_doc", { path, content });
}
