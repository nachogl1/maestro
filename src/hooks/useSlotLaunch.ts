import { invoke } from "@tauri-apps/api/core";
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback } from "react";
import type { SessionSlot } from "@/components/terminal/PreLaunchCard";
import { defaultAgentName, listLiveAgentNames, sanitizeAgentName } from "@/lib/agentName";
import { setSessionMcpServers, writeOpenCodeMcpConfig, writeSessionMcpConfig } from "@/lib/mcp";
import { checkFullDiskAccess, pathRequiresFDA } from "@/lib/permissions";
import {
  saveBranchConfig,
  setSessionPlugins,
  setSessionSkills,
  writeSessionPluginConfig,
} from "@/lib/plugins";
import { samuraiHarvestArm, samuraiRevertLaunchLinePrompt } from "@/lib/samurai";
import type { ShellFamily } from "@/lib/shellEscape";
import { registerSamuraiSuccessor, samuraiSuccessorCliFlags } from "@/lib/spawnSession";
import {
  AI_CLI_CONFIG,
  assignSessionBranch,
  buildCliLaunchLine,
  checkCliAvailable,
  createSession,
  killSession,
  spawnShell,
  terminalShellFamily,
  waitForTerminalReady,
  writeSessionHooksConfig,
  writeStdin,
} from "@/lib/terminal";
import { terminalArmInitialPrompt } from "@/lib/terminalPrompt";
import { prepareSessionWorktree } from "@/lib/worktreeManager";
import { useCliSettingsStore } from "@/stores/useCliSettingsStore";
import { useFDAStore } from "@/stores/useFDAStore";
import { useSessionStore } from "@/stores/useSessionStore";

/**
 * Launch mutex to serialize session launches within the same project.
 * This prevents race conditions where multiple sessions share the same .mcp.json file.
 * Without worktrees, sessions can overwrite each other's MCP config before Claude CLI reads it.
 */
/**
 * Whether a `writeStdin` rejection PROVES nothing reached the PTY (issue
 * #158). Only `SessionNotFound` does: it is raised before any byte is
 * written. `WriteFailed` covers a failed `flush` as well as a failed
 * `write_all` (`process_manager::write_stdin`), so it cannot rule out a line
 * that already landed, and a non-`PtyError` rejection rules out nothing at
 * all. Anything unproven leaves the launch-line claim standing.
 *
 * `WriteFailed` is deliberately not split finer, even though one of its three
 * causes — a poisoned writer lock — is strictly PRE-write and would be safe to
 * revert on. It is indistinguishable from the other two at this boundary, and
 * nothing is lost by treating it as unproven: with no bytes sent, claude never
 * launches, `SessionStarted` never fires, and the entry ends on the ordinary
 * `successor_no_start` ALERT. Letting the sweep report it beats widening a
 * rule whose failure mode is a double paste.
 */
function writeReachedNothing(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  return (err as { code?: unknown }).code === "SessionNotFound";
}

/**
 * Hands a launch-line claim back to the typed route, reporting both ways it
 * can fail to take effect (issue #158). A `false` answer is NOT "nothing to
 * do": it also covers the entry having already been consumed by
 * `SessionStarted` on the launch-line route — audited as delivered, with
 * nothing actually typed — which only the 45s activity watch would otherwise
 * surface.
 */
async function revertLaunchLineClaim(sessionId: number): Promise<void> {
  try {
    if (!(await samuraiRevertLaunchLinePrompt(sessionId))) {
      console.warn(
        `[Samurai] No launch-line claim was reverted for session ${sessionId} — it may already have been consumed as delivered`,
      );
    }
  } catch (err) {
    console.error("[Samurai] Failed to revert the launch-line claim:", err);
  }
}

/**
 * The spawned shell's quoting family (issue #158), or `null` when the backend
 * cannot name it — including when the call itself fails. `null` is a refusal,
 * not an error: the caller keeps a route that needs no quoting.
 */
async function shellFamilyOrNull(): Promise<ShellFamily | null> {
  try {
    return await terminalShellFamily();
  } catch (err) {
    console.error("[Samurai] Could not read the session shell family:", err);
    return null;
  }
}

const projectLaunchLocks = new Map<string, Promise<void>>();

async function withProjectLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any pending launches to complete.
  // Use a while loop because multiple waiters may wake up when a lock resolves.
  // After waking, we must re-check if another waiter grabbed the lock first.
  while (projectLaunchLocks.has(projectPath)) {
    await projectLaunchLocks.get(projectPath);
  }

  // Now we're guaranteed to be the only one proceeding
  // The Promise executor runs synchronously, so `resolve` is always assigned
  // before this function can reach the `finally` block below.
  let resolve!: () => void;
  const newLock = new Promise<void>((r) => {
    resolve = r;
  });
  projectLaunchLocks.set(projectPath, newLock);

  try {
    return await fn();
  } finally {
    resolve();
    if (projectLaunchLocks.get(projectPath) === newLock) {
      projectLaunchLocks.delete(projectPath);
    }
  }
}

/**
 * Message of a backend `PtyError` (`{code, message}` — `src-tauri/src/core/error.rs`),
 * falling back to whatever shape actually arrived. The structured payload is
 * the only thing that names the real cause of a failed spawn.
 */
function describePtyError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    const text = typeof message === "string" ? message : String(message);
    return typeof code === "string" ? `${text} (${code})` : text;
  }
  return err instanceof Error ? err.message : String(err);
}

interface UseSlotLaunchOptions {
  projectPath: string | undefined;
  effectiveRepoPath: string | undefined;
  worktreeBasePath: string | null;
  tabId: string | undefined;
  addSessionToProject: (tabId: string, sessionId: number) => void;
  refreshBranches: () => void;
  slotsRef: MutableRefObject<SessionSlot[]>;
  setSlots: Dispatch<SetStateAction<SessionSlot[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

interface UseSlotLaunchResult {
  launchSlot: (slotId: string) => Promise<void>;
  launchAll: () => Promise<void>;
}

/**
 * The agent name a Claude slot launches with, or null to let Claude keep the
 * name it has (a resume with no typed name) — and for non-Claude modes.
 */
async function launchAgentName(slot: SessionSlot, directory: string): Promise<string | null> {
  if (slot.mode !== "Claude") return null;
  const typed = sanitizeAgentName(slot.customName);
  if (typed || slot.resumeSessionId) return typed;
  const live = await listLiveAgentNames().catch((err) => {
    console.warn("[Session] Could not read live agent names:", err);
    return [];
  });
  return defaultAgentName(directory, new Set(live.map((a) => a.name)));
}

/**
 * Slot launch pipeline for `TerminalGrid`: spawns the shell, registers the
 * session, writes per-session MCP/plugin/hooks config and starts the AI CLI.
 * Launches within one project are serialized by `withProjectLock`.
 */
export function useSlotLaunch({
  projectPath,
  effectiveRepoPath,
  worktreeBasePath,
  tabId,
  addSessionToProject,
  refreshBranches,
  slotsRef,
  setSlots,
  setError,
}: UseSlotLaunchOptions): UseSlotLaunchResult {
  /**
   * Inner implementation of launchSlot, called within the project lock.
   * Spawns a shell with the configured settings. If a branch is selected,
   * prepares a worktree for that branch first.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and state setters are passed in from TerminalGrid, where they are stable (useRef/useState); deps are kept identical to the pre-extraction inline version so behaviour does not change
  const launchSlotInner = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((s) => s.id === slotId);
      if (!slot || slot.sessionId !== null) return;

      // A spawned shell no slot owns yet. If a later step fails before the
      // slot takes it, the catch below must kill it — no pane would show it.
      let unownedSessionId: number | null = null;
      try {
        // Save branch config before launching (ensures it's persisted)
        if (effectiveRepoPath && slot.branch) {
          await saveBranchConfig(effectiveRepoPath, slot.branch, {
            enabled_plugins: slot.enabledPlugins,
            enabled_skills: slot.enabledSkills,
            enabled_mcp_servers: slot.enabledMcpServers,
          }).catch((err) => {
            console.error("Failed to save branch config on launch:", err);
            // Non-fatal - continue with launch
          });
        }

        // Determine the working directory
        // If a branch is selected, prepare a worktree first
        // For multi-repo workspaces, use effectiveRepoPath for git operations
        let workingDirectory = slot.workingDirOverride ?? effectiveRepoPath ?? projectPath;
        let worktreePath: string | null = null;
        let worktreeWarning: string | null = null;
        let detectedBranch: string | null = null;

        if (
          slot.workingDirOverride &&
          slot.workingDirOverride !== (effectiveRepoPath ?? projectPath)
        ) {
          // Recovered worktree from the History tab: run there as-is, no
          // preparation. Close-time deletion of a hand-made worktree is
          // prevented by the backend's managed-base guard.
          worktreePath = slot.workingDirOverride;
        } else if (effectiveRepoPath && slot.worktreeMode !== "project" && !slot.resumeSessionId) {
          // resumeSessionId pins the project dir: `claude --resume` cannot
          // find the conversation from a worktree (see updateSlotResumeSession).
          try {
            const result = await prepareSessionWorktree(
              effectiveRepoPath,
              slot.branch ?? null,
              worktreeBasePath,
              slot.worktreeMode === "new",
            );
            workingDirectory = result.working_directory;
            worktreePath = result.worktree_path;
            worktreeWarning = result.warning;
            detectedBranch = result.branch;

            if (worktreeWarning) {
              console.error(
                `[Worktree] Warning for branch "${slot.branch ?? "auto"}": ${worktreeWarning}`,
              );
            }
            if (worktreePath) {
              refreshBranches();
            }
          } catch (err) {
            console.warn(
              `[Worktree] Failed to prepare worktree, falling back to project path:`,
              err,
            );
            workingDirectory = effectiveRepoPath;
          }
        }

        // Generate project hash for MCP status identification
        // This is passed as MAESTRO_PROJECT_HASH env var to enable process-isolated
        // session identification (avoiding .mcp.json race conditions)
        let envVars: Record<string, string> | undefined;
        if (projectPath) {
          const projectHash = await invoke<string>("generate_project_hash", { projectPath });
          envVars = { MAESTRO_PROJECT_HASH: projectHash };
        }

        // Claude terminals launch with an explicit agent name: the typed
        // window name, else a fresh `<folder>-<NN>`. A resume keeps the name
        // the conversation already had unless one was typed.
        const agentName = await launchAgentName(slot, projectPath ?? workingDirectory ?? "");

        // Spawn the shell in the correct directory (worktree or project path)
        // MAESTRO_SESSION_ID is automatically injected by the backend
        const sessionId = await spawnShell(workingDirectory, envVars);
        unownedSessionId = sessionId;

        // Register the session in SessionManager (required before assigning branch)
        if (projectPath) {
          const sessionConfig = await createSession(
            sessionId,
            slot.mode,
            projectPath,
            workingDirectory,
          );

          // Apply optional custom window name. Empty/whitespace is treated as "no
          // custom name" — the backend normalizes it back to None. A Claude
          // terminal's title is its agent name instead (passed as `--name`
          // below), so other agents can message it by what the title shows.
          const trimmedName = agentName ?? slot.customName.trim();
          let finalName: string | null | undefined = sessionConfig.name;
          if (trimmedName) {
            try {
              const renamed = await invoke<{ name?: string | null }>("rename_session", {
                sessionId,
                name: trimmedName,
              });
              finalName = renamed.name;
            } catch (err) {
              console.warn(`[Session] Failed to set custom name for session ${sessionId}:`, err);
            }
          }

          // Add project to MCP status monitor for polling status updates
          await invoke("add_mcp_project", { projectPath });
          // Add session to store directly (don't refetch all sessions to avoid status reset)
          // Status is frontend-owned (issue #134): a freshly registered
          // session starts Idle and moves on the MCP status stream.
          useSessionStore.getState().addSession({
            ...sessionConfig,
            name: finalName,
            status: "Idle",
          });
        }

        // Assign the branch to the session so the header displays it.
        // Use the explicitly selected branch, or the one detected from the worktree.
        const effectiveBranch = slot.branch ?? detectedBranch;
        if (effectiveBranch && worktreePath) {
          const updatedConfig = await assignSessionBranch(sessionId, effectiveBranch, worktreePath);
          useSessionStore.getState().updateSession(sessionId, {
            branch: updatedConfig.branch,
            worktree_path: updatedConfig.worktree_path,
          });
        } else if (effectiveBranch) {
          useSessionStore.getState().updateSession(sessionId, { branch: effectiveBranch });
        }

        // Save enabled MCP servers for this session
        if (projectPath) {
          await setSessionMcpServers(projectPath, sessionId, slot.enabledMcpServers);
        }

        // Save enabled skills and plugins for this session
        if (projectPath) {
          await setSessionSkills(projectPath, sessionId, slot.enabledSkills);
          await setSessionPlugins(projectPath, sessionId, slot.enabledPlugins);
        }

        // Update slot state FIRST to mount TerminalView and initialize xterm.js.
        // This MUST happen before sending any commands to the PTY, otherwise
        // xterm.js won't be listening when output arrives and it will be lost.
        // This is also critical because CLIs like Codex send DSR (cursor position)
        // queries on startup, and xterm.js must be mounted to respond to them.
        setSlots((prev) =>
          prev.map((s) =>
            s.id === slotId
              ? { ...s, sessionId, worktreePath, worktreeWarning, configDir: workingDirectory }
              : s,
          ),
        );
        unownedSessionId = null;

        // Register session with the project
        if (tabId) {
          addSessionToProject(tabId, sessionId);
        }

        // Auto-launch AI CLI after shell initializes
        // IMPORTANT: For Claude mode, we must write MCP config and launch CLI atomically
        // to prevent race conditions when multiple sessions launch without worktrees.
        // Without worktrees, all sessions share the same .mcp.json file, so we must:
        // 1. Write .mcp.json for this session
        // 2. Launch CLI immediately (before any other session can overwrite .mcp.json)
        // 3. Wait for CLI to read the config
        if (slot.mode !== "Plain") {
          const cliConfig = AI_CLI_CONFIG[slot.mode];
          if (cliConfig.command) {
            const isAvailable = await checkCliAvailable(cliConfig.command);

            if (isAvailable) {
              // Write MCP config IMMEDIATELY before launching CLI
              // This allows the CLI to discover MCP servers including the Maestro status server
              if (workingDirectory && slot.mode === "Claude") {
                try {
                  await writeSessionMcpConfig(
                    workingDirectory,
                    sessionId,
                    projectPath ?? workingDirectory,
                    slot.enabledMcpServers,
                  );
                } catch (err) {
                  console.error("Failed to write MCP config:", err);
                  // Non-fatal - continue with CLI launch, MCP servers just won't be available
                }

                // Write plugin enabled/disabled state to settings.local.json
                // Uses enabledPlugins format (not the legacy plugins array)
                try {
                  await writeSessionPluginConfig(
                    workingDirectory,
                    projectPath ?? workingDirectory,
                    slot.enabledPlugins,
                  );
                } catch (err) {
                  console.error("Failed to write plugin config:", err);
                  // Non-fatal - continue with CLI launch
                }

                // Write hooks config for Claude sessions
                // This configures Claude Code to POST hook events back to Maestro's status server
                try {
                  await writeSessionHooksConfig(workingDirectory, sessionId);
                } catch (err) {
                  console.warn("Failed to write hooks config:", err);
                  // Non-fatal: hooks are enhancement, session can work without them
                }
              } else if (workingDirectory && slot.mode === "OpenCode") {
                // Write OpenCode MCP config (opencode.json format)
                try {
                  await writeOpenCodeMcpConfig(
                    workingDirectory,
                    sessionId,
                    projectPath ?? workingDirectory,
                    slot.enabledMcpServers,
                  );
                } catch (err) {
                  console.error("Failed to write OpenCode MCP config:", err);
                  // Non-fatal - continue with CLI launch
                }

                // Write plugin enabled/disabled state to settings.local.json
                try {
                  await writeSessionPluginConfig(
                    workingDirectory,
                    projectPath ?? workingDirectory,
                    slot.enabledPlugins,
                  );
                } catch (err) {
                  console.error("Failed to write plugin config:", err);
                  // Non-fatal - continue with CLI launch
                }
              }

              // Wait for xterm.js to mount and start listening for PTY output
              // This ensures we don't send CLI commands before the terminal is ready
              // (which would cause output to be lost since Tauri events aren't buffered)
              try {
                await waitForTerminalReady(sessionId);
              } catch (err) {
                console.warn("Terminal ready timeout, proceeding anyway:", err);
              }

              // Brief delay for shell to initialize
              await new Promise((resolve) => setTimeout(resolve, 100));

              // Build CLI command with user-configured flags. A samurai
              // successor (issue #55) additionally forces skip-permissions —
              // an autonomous generation cannot answer permission prompts —
              // and carries the run config's model preference (review F4).
              const cliFlags = useCliSettingsStore.getState().getFlags(slot.mode);
              const effectiveFlags = slot.samurai
                ? samuraiSuccessorCliFlags(cliFlags, slot.samurai.model)
                : cliFlags;
              // Issue #158: a gen-1 launch also carries its brief POINTER on
              // this very line, as a quoted positional initial prompt, so the
              // instruction that starts the run is submitted WITH the launch
              // instead of typed into claude's REPL afterwards. The quoting
              // family comes from the backend — the shell it actually spawns,
              // not a guess from the OS — and an unavailable answer simply
              // keeps the prompt off the line.
              const launchPrompt = slot.samurai?.launchPrompt ?? null;
              const shellFamily = launchPrompt ? await shellFamilyOrNull() : null;
              let launchLine = buildCliLaunchLine(
                slot.mode,
                effectiveFlags,
                slot.resumeSessionId ?? undefined,
                launchPrompt,
                shellFamily,
                agentName ?? undefined,
              );
              let launchPromptOnLine = launchLine?.launchPromptDelivered ?? false;

              // Samurai successor: register under supervision BEFORE the CLI
              // launches, so the backend's verify-ritual delivery is armed
              // strictly ahead of claude's SessionStart hook. Registration
              // failure is logged, not fatal — the session still launches and
              // the backend's successor_no_start ALERT surfaces the gap.
              //
              // Issue #158: the pointer may only stay on the line if the
              // backend says it ARMED the launch-line route. A refusal
              // resolves normally (it refuses a claim it never offered), and a
              // throw says nothing either way — read as acceptance, both write
              // a line carrying a pointer the backend is still going to type,
              // delivering the brief TWICE. Either answer takes it back off.
              //
              // The mirror case is accepted, not unhandled: if the backend
              // DID arm the route but the reply is lost, the pointer is
              // stripped here and neither route delivers. That is exactly
              // what the activity-only DeliveredWatch exists for — the
              // session starts, no turn follows, and it raises
              // `submit_unconfirmed`. A silent no-delivery is impossible; a
              // double paste, had this branch guessed the other way, would
              // not even be visible.
              if (slot.samurai) {
                let armed = false;
                try {
                  armed = await registerSamuraiSuccessor(
                    sessionId,
                    slot.samurai,
                    launchPromptOnLine,
                  );
                } catch (err) {
                  console.error("[Samurai] Failed to register successor session:", err);
                }
                if (launchPromptOnLine && !armed) {
                  console.warn(
                    "[Samurai] The backend did not arm the launch-line route — typing the pointer instead",
                  );
                  launchLine = buildCliLaunchLine(
                    slot.mode,
                    effectiveFlags,
                    slot.resumeSessionId ?? undefined,
                    null,
                    shellFamily,
                    agentName ?? undefined,
                  );
                  launchPromptOnLine = false;
                }
              }
              const cliCommand = launchLine?.command ?? null;

              // Harvest triage launch (issue #98): arm the backend BEFORE
              // the CLI launches, so the journal-prompt injection gate is
              // set strictly ahead of claude's SessionStart hook. Failure is
              // logged, not fatal — the terminal still opens, just without
              // the injected prompt.
              if (slot.harvest) {
                try {
                  await samuraiHarvestArm(sessionId);
                } catch (err) {
                  // Surfaced, not just logged: the Journal card has already
                  // told the user the entries will be injected here, so a
                  // silent failure leaves them believing the journal was
                  // triaged while the terminal sits at an empty prompt.
                  console.error("[Harvest] Failed to arm the triage prompt:", err);
                  setError(
                    `Harvest triage prompt was not armed (${err instanceof Error ? err.message : String(err)}) — the journal entries were NOT injected`,
                  );
                }
              }

              // Generic initial prompt: same gate as harvest — arm the
              // backend BEFORE the CLI launches so the injection is set
              // strictly ahead of claude's SessionStart hook, which is what
              // types the prompt in. Claude only: no other CLI posts that
              // hook, so an armed non-Claude session would never inject.
              // Failure is logged, not fatal — the terminal still opens, the
              // user just types the prompt themselves.
              if (slot.initialPrompt && slot.mode === "Claude") {
                try {
                  await terminalArmInitialPrompt(
                    sessionId,
                    slot.initialPrompt,
                    slot.briefDir,
                    slot.briefStem,
                    slot.prRun,
                  );
                } catch (err) {
                  console.error("[InitialPrompt] Failed to arm the initial prompt:", err);
                }
              }

              // Send CLI launch command
              try {
                await writeStdin(sessionId, `${cliCommand}\r`);
              } catch (err) {
                // Issue #158: the claim above told the backend the pointer
                // went out on this line. Hand the typed delivery back — but
                // ONLY when the error proves nothing reached the shell.
                // `writeStdin` also rejects after `write_all` succeeded (a
                // failing `flush`, a join error), and there the whole line is
                // already in the PTY: reverting would type the pointer a
                // second time on SessionStarted. An unnecessary ALERT on a
                // delivered run is cheap; a double paste corrupts it.
                if (launchPromptOnLine && writeReachedNothing(err)) {
                  await revertLaunchLineClaim(sessionId);
                }
                throw err;
              }

              // Brief delay for CLI initialization.
              // With session-specific MCP server names (maestro-1, maestro-2, etc.),
              // we no longer have race conditions on .mcp.json, so we only need
              // a minimal delay for general CLI startup.
              await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
              console.warn(
                `CLI '${cliConfig.command}' not found. Install with: ${cliConfig.installHint}`,
              );
            }
          }
        }
      } catch (err) {
        console.error("Failed to spawn shell:", err);
        if (unownedSessionId !== null) {
          // kill_session also drops the backend registry row; the store row
          // exists only for a project slot, and removing a missing one is a no-op.
          killSession(unownedSessionId).catch(console.error);
          useSessionStore.getState().removeSession(unownedSessionId);
        }
        // `spawn_shell` returns a structured `PtyError {code, message}`; the
        // fixed string threw away the only thing that says WHY (a missing
        // shell, a permission denial, a vanished working directory).
        setError(`Failed to start terminal session: ${describePtyError(err)}`);
      }
    },
    [projectPath, effectiveRepoPath, worktreeBasePath, tabId, addSessionToProject, refreshBranches],
  );

  /**
   * Launches a single slot by spawning a shell with the configured settings.
   *
   * NOTE: Uses withProjectLock to serialize launches within the same project.
   * This prevents race conditions where multiple sessions share the same .mcp.json file.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and state setters are passed in from TerminalGrid, where they are stable (useRef/useState); deps are kept identical to the pre-extraction inline version so behaviour does not change
  const launchSlot = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((s) => s.id === slotId);
      if (!slot || slot.sessionId !== null) return;

      // Gate on FDA: if the project is in a TCC-protected directory, check
      // Full Disk Access before any Rust-side filesystem operations.
      if (projectPath && pathRequiresFDA(projectPath)) {
        const hasAccess = await checkFullDiskAccess();
        if (!hasAccess) {
          useFDAStore.getState().requireAccess(projectPath, () => launchSlot(slotId));
          return;
        }
      }

      // Serialize launches within the same project to prevent .mcp.json race conditions
      const lockPath = projectPath ?? "no-project";
      await withProjectLock(lockPath, async () => {
        await launchSlotInner(slotId);
      });
    },
    [projectPath, launchSlotInner],
  );

  /**
   * Launches all unlaunched slots sequentially.
   * Note: launchSlot already uses withProjectLock, so launches are serialized.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and state setters are passed in from TerminalGrid, where they are stable (useRef/useState); deps are kept identical to the pre-extraction inline version so behaviour does not change
  const launchAll = useCallback(async () => {
    const unlaunchedSlots = slotsRef.current.filter((s) => s.sessionId === null);
    for (const slot of unlaunchedSlots) {
      await launchSlot(slot.id);
    }
  }, [launchSlot]);

  return { launchSlot, launchAll };
}
