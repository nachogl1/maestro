import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** One entry of a folder listing, as `files_list_dir` returns it. */
export interface FileEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isDir: boolean;
  /** Git ignores it: shown dimmed, never hidden. */
  ignored: boolean;
}

/** One level of `dir`, which must lie inside `root` (the folder the panel shows). */
export function listDir(root: string, dir: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("files_list_dir", { root, dir });
}

/** The text of a file for the read-only preview; rejects with the reason it can't be previewed. */
export function readPreview(root: string, path: string): Promise<string> {
  return invoke<string>("files_read_preview", { root, path });
}

/** Opens a file in the computer's default app (a folder in the file manager). */
export function openInDefaultApp(root: string, path: string): Promise<void> {
  return invoke<void>("files_open_default", { root, path });
}

export function copyPath(path: string): Promise<void> {
  return writeText(path);
}

/** The backend's errors are one plain sentence; anything else is shown as text. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "Unknown error";
}

/** The last part of a path, split on either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** `path` relative to `root`, with forward slashes, for the preview header. */
export function relativePath(root: string, path: string): string {
  const rest = path.slice(root.length).replace(/^[\\/]+/, "");
  return rest.replace(/\\/g, "/") || baseName(path);
}
