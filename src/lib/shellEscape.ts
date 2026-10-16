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
 * quoter for. `null` is not an error: it means refuse to build a quoted
 * command line and use a route that needs no quoting.
 *
 * Verification caveat: the tests below assert the ESCAPED STRING only. No
 * test parses the result back through a real shell — that would mean spawning
 * bash/cmd in the unit suite — so the rules encoded here are reviewed
 * reasoning, not a round trip.
 */
export type ShellFamily = "posix" | "cmd";

/**
 * Control characters are refused outright, on both families: the quoted
 * argument is TYPED into a live PTY, and a CR or LF inside it submits the
 * line half-written — the exact failure #137 was fixed to stop.
 *
 * Scanned rather than matched with a regex: the lint that bans control
 * characters inside a pattern is right everywhere else, and a range test
 * reads as what this actually means.
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * cmd.exe has no escape for these, so a payload carrying one cannot ride a
 * launch line at all (issue #158):
 * - `"` closes the quoted region mid-argument, exposing every metacharacter
 *   after it (`^` cannot escape it back — cmd resolves quotes first).
 * - `%` is expanded (`%VAR%`) BEFORE quote processing, and `%%` collapses
 *   only inside a batch file, never at an interactive prompt.
 * - `!` is expanded the same way whenever the user has delayed expansion on
 *   (`cmd /V:ON`, or the `DelayedExpansion` registry value).
 * Everything else cmd treats as special — `&`, `|`, `<`, `>`, `^`, `(`, `)` —
 * is inert inside double quotes, so wrapping is enough for those.
 *
 * This set also has to survive a SECOND batch pass: `claude` on Windows is an
 * npm shim, `claude.cmd`, which forwards its arguments with `%*`. That pass
 * re-expands `%…%` and (with delayed expansion on) `!…!`, which is safe here
 * only because both are already refused above. Narrowing this set later must
 * account for the shim, not just cmd.exe's own parsing.
 */
const CMD_UNESCAPABLE = /["%!]/;

/**
 * Quotes `value` as ONE positional argument for `shell`, or returns `null`
 * when it cannot be quoted safely.
 *
 * Refusing is a first-class outcome (issue #158): the caller falls back to
 * the delivery route it already had rather than emitting a half-escaped
 * command line. A partially escaped line is not a cosmetic defect — the
 * payload this exists for, `samurai_brief::pointer_instruction`, wraps the
 * brief path in BACKTICKS, and a backtick inside double quotes is command
 * substitution in bash/zsh: the shell would try to EXECUTE the brief path.
 */
export function quoteShellArgument(value: string, shell: ShellFamily): string | null {
  if (value.length === 0) return null;
  if (hasControlCharacter(value)) return null;
  return shell === "cmd" ? quoteForCmd(value) : quoteForPosix(value);
}

/**
 * POSIX single-quote wrapping: inside single quotes NOTHING is special —
 * backtick, `$`, `\` and every metacharacter are literal — and an internal
 * single quote is spliced back in with the `'\''` idiom.
 */
function quoteForPosix(value: string): string {
  return shellEscapePath(value);
}

/**
 * cmd.exe double-quote wrapping. Two parsers see this string: cmd.exe, for
 * which quotes neutralize the metacharacters above, and the launched
 * program's own `CommandLineToArgvW`-style argv split, for which a backslash
 * RUN immediately before the closing quote escapes that quote (`"C:\wt\"`
 * would swallow it). Interior backslashes matter only in front of a quote,
 * and quotes are refused, so doubling the trailing run is the whole fix.
 */
function quoteForCmd(value: string): string | null {
  if (CMD_UNESCAPABLE.test(value)) return null;
  const trailingBackslashes = /\\*$/.exec(value)?.[0].length ?? 0;
  return `"${value}${"\\".repeat(trailingBackslashes)}"`;
}

/**
 * Dropped / attached file paths as one string to type into a session PTY,
 * each quoted for the shell actually running there (`terminal_shell_family`).
 * A path that `quoteShellArgument` refuses, or every path when the family is
 * unknown (`null`), goes in bare: quoting with another shell's rules is worse
 * than none — POSIX single quotes are literal characters in cmd.exe.
 */
export function quotePathsForShell(paths: string[], shell: ShellFamily | null): string {
  return paths
    .map((path) => (shell === null ? null : quoteShellArgument(path, shell)) ?? path)
    .join(" ");
}
