import { invoke } from "@tauri-apps/api/core";

/**
 * Thin wrapper over the generic initial-prompt tauri command
 * (`src-tauri/src/commands/initial_prompt.rs`), following the per-domain lib
 * module convention (`lib/processes.ts`, …).
 *
 * This is the "launch a terminal with an initial prompt" capability any
 * feature can reuse: queue a `PendingLaunch` carrying `initialPrompt` and the
 * grid does the rest.
 */

/**
 * Arms a one-shot initial prompt for a just-launched session (Rust
 * `terminal_arm_initial_prompt`). TerminalGrid calls this right before it
 * types the CLI command, so the backend can type the prompt into the PTY on the
 * session's first SessionStarted hook signal, when claude is actually up.
 *
 * The prompt may be multi-line: the backend collapses every whitespace run to
 * a single space before typing, because a newline inside an injected prompt
 * submits a partial message. Rejects when the prompt is empty once
 * normalized.
 *
 * `briefDir` + `briefStem` are optional (issue #138): supplying both lets the
 * backend write a long prompt UNFLATTENED to
 * `<briefDir>/.maestro/briefs/<briefStem>.md` and type a one-line pointer at
 * it, which is the only payload size the PTY delivers reliably. Omitting them
 * keeps the inline delivery.
 */
export function terminalArmInitialPrompt(
  sessionId: number,
  prompt: string,
  briefDir?: string | null,
  briefStem?: string | null,
): Promise<void> {
  return invoke("terminal_arm_initial_prompt", {
    sessionId,
    prompt,
    briefDir: briefDir ?? null,
    briefStem: briefStem ?? null,
  });
}
