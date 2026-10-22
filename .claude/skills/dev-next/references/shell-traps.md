# Known shell traps

Things known to go wrong across Windows, macOS and Linux shells when agents drive `git` and `gh`. When a new one costs a
real run, add it here in a pull request. Read this the moment a command behaves strangely instead of retrying it.

## PowerShell 5.1 (Windows)

- **No `&&` and no `||`.** They are a parser error, not a fallback. Use `A; if ($?) { B }`.
- No ternary `?:`, no `??`, no `?.`.
- `Set-Content` and `Add-Content` default to the system ANSI codepage, and `-Encoding utf8` (also on `Out-File`) writes a
  **byte-order mark**. For a file another tool will read, write it BOM-free with
  `[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))` (`$path` must be absolute, e.g. `(Join-Path (Get-Location) '<file>')`, because .NET resolves relative paths against its own current directory, not PowerShell's) — or with Python.
- `2>&1` on a native executable wraps each stderr line in an error record and sets `$?` to false **even on exit code 0**.
  Do not redirect stderr; it is already captured.
- `-ErrorAction SilentlyContinue` hides the message but the tool still reports failure. Use `try { ... -ErrorAction Stop } catch {}`.

## Reading what `gh` prints

- **Piping `gh … --json` through PowerShell into Python fails**: PowerShell re-encodes the pipe with a byte-order mark
  and `json.load` rejects it. Run the pipe in bash (the Bash tool), or write `gh`'s output to a file with
  `--jq`/`> file` from bash and read the file with `encoding="utf-8-sig"`.

## Writing files that GitHub will read

- PowerShell 5.1's `-Encoding utf8` adds a **byte-order mark**, which renders as stray characters at the top of an issue or
  pull request. Write the body BOM-free with `[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding $false))` (`$path` must be absolute, e.g. `(Join-Path (Get-Location) '<file>')`, because .NET resolves relative paths against its own current directory, not PowerShell's) or with Python — `open(path, "w", encoding="utf-8")` — then pass it with `--body-file`.
- **Bash heredocs break on apostrophes** in the body, and long heredocs can fail to parse on some content. Same fix:
  write the file with Python or the file tool, pass `--body-file`.
- **The Bash tool on Windows de-escapes backslashes inside heredocs**: a path such as `C:\wt\<N>-<slug>` can reach
  Python with a backslash sequence read as an escape. Use forward slashes in issue and pull request bodies, or write
  the file with the file tool.
- **Never pass a body inline with `--body "..."`**: backticks in it are run as commands by bash. Always `--body-file`.

## Paths

- Windows refuses paths over roughly 260 characters. A worktree inside the project plus a dependency folder gets
  there. **This is why worktrees live outside the repository** (`<wt root>/<N>-<slug>`).
- Paths with spaces need quoting in every shell.

## Tools

- `gh` and the runtimes may be **off PATH in a fresh shell** even though they work in your terminal. Check in preflight.
- `git` returns `index.lock` when another terminal is mid-command. Wait 5 seconds, retry, up to 3 times. It is not corruption.
- **Git Bash: `git rev-parse` with two revisions in one call** fails with `Needed a single revision`. One call per revision.
- **Git Bash: `$TEMP` is not the session scratchpad** — it resolves to a different folder, so a file written there is
  not where the next tool looks. Use the scratchpad's explicit path.
- **zsh (macOS): an unquoted `echo ======`** is an `=` expansion error that aborts the whole compound command. Quote
  separators: `echo '-----'`.
- **zsh (macOS, the default shell) does not word-split an unquoted variable**: `for b in $list` runs once with the
  whole multi-line string, so a blocker list read that way names one issue that does not exist. Use an array, split
  explicitly with `${=list}`, loop over `$(…)` output directly, or run the loop under `bash -c`.
- **`gh api` paths: use the `{owner}/{repo}` placeholders**, never a hand-typed name — an underscore typed for a hyphen
  returns a 404 that reads like a missing relation.
- **The Playwright browser tool saves screenshots and logs under the main checkout's `.playwright-mcp/`**, not the
  worktree. Move the screenshot you need into the worktree, then delete what you left there (if it is gitignored, it
  never shows in `git status`).
- A repository this team does not own may be checked out next to this one. Never run `git` write commands in it, and
  never build it.

## Processes and ports

- **Kill a server by process id, never by image or process name.** Killing by name kills every teammate's server and
  every agent's tooling along with it.
- If a port is already in use, something of yours is still running — find it by port, not by name.

## Python

- On Windows the default encoding is cp1252, not UTF-8. Always pass `encoding="utf-8"` explicitly when reading or
  writing text, or an em dash in an issue body will crash the script.
