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
 *
 * `prRun` is optional PR-review metadata (issue #139): supplying it makes the
 * backend write a persistent run record for the review, which is what gives it
 * an identity to group its artifacts under on disk. A failed
 * record write never fails the launch.
 */
export function terminalArmInitialPrompt(
  sessionId: number,
  prompt: string,
  briefDir?: string | null,
  briefStem?: string | null,
  prRun?: PrReviewLaunch | null,
): Promise<void> {
  return invoke("terminal_arm_initial_prompt", {
    sessionId,
    prompt,
    briefDir: briefDir ?? null,
    briefStem: briefStem ?? null,
    prRun: prRun ?? null,
  });
}

/**
 * What a PR-review launch records about itself (issue #139) — mirrors the Rust
 * `PrReviewLaunch`, snake_case on the wire. The
 * session id and the brief path are added backend-side: only the arm hop knows
 * them.
 */
export interface PrReviewLaunch {
  pr: number;
  /** The PR title, for the group's `PR #142 — <title>` label; may be empty. */
  title: string;
  /** `owner/repo`; empty when the PR url did not parse into a slug. */
  repo: string;
  /** The checkout the review terminal opens in. */
  project_path: string;
  /** The ticked workflow step ids, in order. */
  steps: string[];
}
