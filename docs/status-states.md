# Session status: signal → state mapping

How the per-session status (the 3-dot indicator: blue = working, red = needs
input, green = done, gray = idle) is derived, and how to verify each failure
class from issue #105 in the live app.

Statuses live in `useSessionStore` (`src/stores/useSessionStore.ts`). Every
producer below ends up either as a `session-status-changed` Tauri event
(merged by `resolveStatusEvent`) or as a direct store write.

## Producers

### Claude Code hooks → status server (`src-tauri/src/core/status_server.rs`)

Written per session into `.claude/settings.local.json` by
`hook_config_writer.rs` (Claude sessions only — other CLIs get none of these):

| Hook | Route | Wire status | Meaning |
| --- | --- | --- | --- |
| `SessionStart` | `/hook/session-start` | `Idle` | CLI (re)started and sits at its prompt. It is *not* working yet. |
| `UserPromptSubmit` | `/hook/user-prompt` | `Working` | A prompt was submitted (typed by the human or injected by Maestro). Authoritative turn start. |
| `PreToolUse` (any tool) | `/hook/pre-tool` | `Working` ("Running {tool}") | The agent is executing a tool. **Window rule (issue #109):** within 2s of a `Notification` for the same session the `Working` is suppressed — PreToolUse is async fire-and-forget, so a gated tool's `Working` can land *after* the permission prompt's `NeedsInput`; a later PreToolUse (fresh tool start after approval) repaints normally. |
| `PreToolUse` (`AskUserQuestion`) | `/hook/pre-tool` | `NeedsInput` | The agent opened an interactive question dialog mid-turn. Never suppressed by the window rule. |
| `PostToolUse` (any tool) | `/hook/post-tool` | `Working` ("Finished {tool}") | A tool ran to completion — proof any permission prompt was answered (issue #109). Clears `NeedsInput` *unconditionally* (deliberately exempt from the window rule: this is exactly the fresh after-approval signal) and closes the digit-shortcut gap where approving the turn's LAST long tool left `NeedsInput` painted until Stop. |
| `PreToolUse` / `PostToolUse` (`maestro_status`) | both | *(none)* | Maestro's own status tool is a report, not work — its `/status` call is the status. A `Working` here overwrote the report (`Done` → `Working`), so the turn's Stop then read as a second "ready" transition and auto-unparked a session the user had just re-parked. |
| `Notification` | `/hook/notification` | `NeedsInput` | The CLI is waiting on the human: permission prompt, or the 60s idle-prompt reminder. The notification text becomes the needs-input prompt. Also arms the 2s PreToolUse shield above. |
| `Stop` | `/hook/stop` | `AwaitingInput` (wire-only) | Turn ended, control returned to the user. |
| `SessionEnd` | `/hook/session-end` | `SessionEnded` (wire-only) | The claude process exited (`/exit`, `/clear`, logout). |

### MCP status tool (`maestro-mcp-server`, tool `maestro_status`)

Voluntary agent self-reports: `idle`/`working`/`needs_input`/`finished`/`error`
→ `Idle`/`Working`/`NeedsInput`/`Done`/`Error`. `Done` and `Error` only ever
come from here (and from the samurai watchdog).

### Frontend-only producers

| Producer | Where | Writes |
| --- | --- | --- |
| PTY-output heuristic | `TerminalView.tsx` | `Working` after ≥500ms of output, `Idle` after 5s of silence — but only when the last wire status is >10s old, and never over `NeedsInput`/`Done`/`Error`/`Timeout`. Main signal for non-Claude CLIs. |
| Enter-key flip | `TerminalView.tsx` | Bare `\r` while `NeedsInput` → `Working` (the user just answered). |
| Startup timeout | `useSessionStore.ts` | `Starting` for >30s → `Timeout`. |
| Samurai watchdog | `useSessionStore.ts` | Supervisor `DEAD` → `Error`. |

## Merge rules (`resolveStatusEvent`, exact order)

1. **`AwaitingInput`** (Stop hook — weak, fires on every turn end):
   - dropped ONLY if the agent reported `Done`/`Error` during the very turn
     this stop closes (the store tracks that mark and the stop consumes it).
     The session's *current* status is deliberately not consulted: one stale
     `Done` would otherwise swallow every later turn end forever (issue #77
     cause 1), and a live stop is better evidence than a startup `Timeout`
     heuristic — a stop on a `Timeout` session recovers it to `NeedsInput`;
   - `Working` ("N subagents running") while background subagents are
     *plausibly* alive — a running subagent only counts for 30 minutes from
     spawn, and a watchdog re-checks when the last one ages out so a
     completion event that never arrives cannot pin the dots (issue #77
     cause 4);
   - otherwise `NeedsInput`.
2. **`SessionEnded`**: dropped if `Done`/`Error` (the outcome stays visible);
   otherwise `Idle`, clearing any needs-input prompt.
3. **`NeedsInput`**: dropped if `Done`/`Error` (the 60s idle reminder fires
   after every turn and must not repaint a finished session red). A `Timeout`
   session *is* overwritten — an explicit needs-input proves the CLI is alive.
4. **Everything else applies verbatim** — last writer wins. In particular
   `Working` from `UserPromptSubmit` is what moves a session out of
   `Done`/`Error` when a new turn starts.

Precedence is therefore temporal, not ranked: the newest signal wins unless a
rule above drops it. The PTY heuristic sits below all wire signals (10s grace,
restricted target states).

## Repro checklists (issue #105 — human sign-off)

Run `npm run tauri dev`, open a project, start a Claude session.

### Class 1 — "working while waiting"

1. Ask the agent to run a command that needs permission approval (e.g.
   "run `git push --dry-run`" with no pre-approval for it).
2. Wait for the permission dialog to render in the terminal. Do not touch it.
3. **Correct:** within ~1s of the dialog appearing, the indicator turns red
   (needs input) and the header shows the permission message. Broken behavior
   was: stays blue (working) or gray for as long as the dialog sits there.
4. Also: launch a fresh session and type nothing. **Correct:** the indicator
   is gray (idle) after startup, not blue. It turns blue only once you submit
   a prompt.

### Class 2 — "stale after finish"

1. Ask the agent: "report your status as finished via the maestro status
   tool, then stop." When the session shows green (done), send a NEW prompt
   ("say hi").
2. **Correct:** the indicator flips to blue the moment the prompt is
   submitted, and to red when the turn ends. Broken behavior was: stays green
   forever after the first Done.
3. Then type `/exit` in the terminal (while the status is red or blue).
4. **Correct:** the indicator goes gray (idle) within ~1s of the CLI exiting
   and any "needs input" prompt text disappears. A green/red Done/Error badge
   from a reported outcome survives `/exit` on purpose.

### Class 3 — "needs-input missed"

1. Ask the agent: "use the AskUserQuestion tool to ask me which of two
   options I prefer." Wait for the question dialog.
2. **Correct:** the indicator turns red as soon as the dialog appears
   (mid-turn — before the turn ends), with "Waiting for you to answer a
   question". Broken behavior was: blue/gray until the whole turn ended.
3. Answer the question (arrow keys + Enter). **Correct:** back to blue while
   the agent continues, red again at turn end.

### Class 4 — "lag / flicker"

1. Submit any prompt. **Correct:** blue within ~1s of pressing Enter (no
   longer waits for 500ms of sustained output after a 10s grace window).
2. Let a turn run tools (e.g. "list the files in this repo, then count the
   lines in three of them"). **Correct:** solid blue for the whole turn — no
   blue↔gray flapping between tool calls (every tool start refreshes the
   authoritative Working signal, which keeps the PTY heuristic silenced).
3. Leave the finished session alone for >60s after the turn-end red.
   **Correct:** stays red (the idle reminder re-asserts needs-input); a
   session that reported Done stays green.

### Class 5 — permission-prompt repaints (issue #109 — pending human sign-off)

1. Ask the agent to run a command that needs permission approval. Wait for
   the permission dialog. **Correct:** the indicator turns red and STAYS red
   while the dialog is up — the gated tool's own late async `PreToolUse`
   (Working) no longer repaints it blue within the 2s window rule.
2. Approve the prompt with a **digit shortcut** (press the option's number,
   no Enter) when the approved command is the turn's LAST, long-running tool
   (e.g. "run `npm install` and then stop"). **Correct:** the indicator
   flips to blue as soon as the tool *finishes* (the new `PostToolUse` hook)
   — not only at the turn's Stop as before.
3. Approve a prompt normally mid-turn and let the agent continue with more
   tools. **Correct:** blue from the next tool start (a `PreToolUse` later
   than 2s after the notification repaints normally).

## Known residual gaps (documented, not silently ignored)

- **Esc-interrupt:** interrupting a turn fires no Stop hook. The status stays
  blue until the CLI's 60s idle Notification (→ red) or the PTY heuristic's
  idle flip (→ gray) corrects it.
- **Hard kill:** a `kill -9`/crash fires no SessionEnd hook. Samurai-supervised
  sessions are covered by the watchdog (→ Error); unsupervised sessions keep
  their last status until PTY output resumes.
- **Empty-Enter flip:** pressing Enter on an empty prompt while red flips the
  indicator to blue even though no turn starts (the flip cannot distinguish a
  submit from a nudge). The next real signal corrects it.
- **Non-Claude CLIs** (Gemini/Codex/OpenCode/Plain) have no hooks: they keep
  the PTY heuristic + (OpenCode) MCP self-reports, with all four classes'
  original limitations.
