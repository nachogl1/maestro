/**
 * Shell-escape file paths for safe pasting into a terminal.
 *
 * Uses POSIX single-quote wrapping: any internal single quotes are escaped
 * as `'\''` (end quote, escaped quote, reopen quote).
 */

export function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(" ");
}

/**
 * Which quoting rules a command line typed into a session PTY must follow.
 *
 * NEVER inferred from the operating system: the backend spawns whatever
 * `COMSPEC`/`$SHELL` names (`process_manager::spawn_shell`), so a Windows box
 * can be running PowerShell — where the backtick is the ESCAPE character and
 * `$(...)` executes — and a unix box csh, which mis-parses the `'\''` splice.
 * The family comes from `terminal_shell_family`, which classifies the shell
 * actually configured and answers `null` for anything Maestro has no verified
 * quoter for; such a shell gets POSIX single quotes (see `quotePathsForShell`).
 *
 * Verification caveat: the tests below assert the ESCAPED STRING only. No
 * test parses the result back through a real shell — that would mean spawning
 * bash/cmd in the unit suite — so the rules encoded here are reviewed
 * reasoning, not a round trip.
 */
export type ShellFamily = "posix" | "cmd";

/**
 * Dropped / attached file paths as one string to type into a session PTY.
 * Only the user's own Enter runs the line, so this never refuses a path:
 * - cmd: always double-quoted. Windows file names cannot contain `"`, so the
 *   quotes always hold and `&`, `|`, `(`, spaces stay literal. `%`/`!` can
 *   still expand inside them; that is cmd's rule, and typing the path bare
 *   would be strictly worse (every metacharacter live).
 * - posix, or an unknown shell (`null`): POSIX single quotes, the long-standing
 *   default. A newline stays inside the quotes (continuation prompt), never a
 *   half-written submit.
 */
export function quotePathsForShell(paths: string[], shell: ShellFamily | null): string {
  if (shell !== "cmd") return shellEscapePaths(paths);
  return paths.map(wrapForCmd).join(" ");
}

/**
 * cmd.exe double-quote wrapping. A backslash RUN immediately before the
 * closing quote would escape that quote for the launched program's own argv
 * split (`"C:\wt\"`), so the trailing run is doubled.
 */
function wrapForCmd(value: string): string {
  const trailingBackslashes = /\\*$/.exec(value)?.[0].length ?? 0;
  return `"${value}${"\\".repeat(trailingBackslashes)}"`;
}
