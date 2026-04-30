/**
 * Path utilities for comparing filesystem paths that may originate from
 * different sources within the app (Tauri backend vs. user-supplied tab paths).
 *
 * The Windows quirk we care about: Rust's `std::fs::canonicalize` returns
 * extended-length UNC paths like `\\?\C:\git\maestro`, while the workspace
 * stores the raw path the user opened (`C:\git\maestro`). Strict-equality
 * comparison between the two never matches.
 */

/**
 * Normalizes a filesystem path for comparison. Strips the Windows `\\?\`
 * extended-length prefix (preserving `\\?\UNC\server\share` → `\\server\share`),
 * converts backslashes to forward slashes, trims trailing separators, and
 * case-folds. Case-folding is a small white lie on case-sensitive filesystems
 * (Linux), but our paths originate from a desktop app where the user owns
 * the directories they open, so case-only collisions are not a real concern.
 */
export function normalizePath(path: string): string {
  let p = path;
  if (p.startsWith("\\\\?\\UNC\\")) {
    p = "\\\\" + p.slice(8);
  } else if (p.startsWith("\\\\?\\")) {
    p = p.slice(4);
  }
  p = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return p.toLowerCase();
}

/** True when two paths refer to the same location after normalization. */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}
