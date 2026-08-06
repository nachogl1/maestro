/**
 * Samurai successor spawn (issue #55, PRD §5.4/§5.6).
 *
 * After a validated handoff the backend kills gen-N itself and emits
 * `samurai-spawn-successor`. There is no backend spawn path, so the frontend
 * answers by REUSING the existing out-of-grid launch mechanism — the
 * pending-launch store the sidebar History tab already goes through
 * (`usePendingLaunchStore` → TerminalGrid's consume effect → the exact
 * launch flow every manual session takes: spawn_shell → create_session →
 * hooks/MCP config → CLI via writeStdin). No parallel spawn implementation.
 *
 * The event deliberately does NOT carry the ritual prompt: the backend keeps
 * it queued and types it in on the successor's first SessionStarted hook
 * signal, when claude is actually up. This module only has to get a Claude
 * session running in the right directory and register it under supervision
 * (which is what arms that delivery).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { samePath } from "@/lib/path";
import { samuraiRegisterSession } from "@/lib/samurai";
import type { CliFlags } from "@/lib/terminal";
import {
  usePendingLaunchStore,
  type SamuraiSuccessorInfo,
} from "@/stores/usePendingLaunchStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/** Payload of the backend's `samurai-spawn-successor` event. */
export interface SamuraiSpawnSuccessorEvent {
  /** Canonical project path (`\\?\` prefix already stripped). */
  project: string;
  epic: string;
  /** The successor's generation (predecessor + 1). */
  generation: number;
  /** The predecessor's working directory — stable epic worktree (PRD §5.9). */
  working_dir: string;
  /** Display name for the new terminal, e.g. `samurai gen-3 37`. */
  session_name: string;
}

/**
 * The spawn helper: queues a successor launch for the project's grid, the
 * same way the History tab queues a recovery launch. `workingDirOverride`
 * pins the exact directory (no worktree derivation), `customName` names the
 * session, and the `samurai` block makes the grid force
 * `--dangerously-skip-permissions` and register the session after the CLI
 * launches. Returns false (and logs) when no open project tab matches — the
 * backend's `successor_no_start` ALERT then surfaces the stall.
 */
export function queueSamuraiSuccessorLaunch(event: SamuraiSpawnSuccessorEvent): boolean {
  const tab = useWorkspaceStore
    .getState()
    .tabs.find((t) => samePath(t.projectPath, event.project));
  if (!tab) {
    console.error(
      `[Samurai] No open project tab matches ${event.project} — cannot spawn successor gen-${event.generation}`,
    );
    return false;
  }
  usePendingLaunchStore.getState().request({
    tabId: tab.id,
    mode: "Claude",
    resumeSessionId: null,
    workingDirOverride: event.working_dir,
    branch: null,
    customName: event.session_name,
    samurai: {
      project: event.project,
      epic: event.epic,
      generation: event.generation,
    },
  });
  // Same as the History tab: make sure the grid is mounted to consume the
  // request (the project may have dropped to the idle landing view when the
  // predecessor was its last session).
  useWorkspaceStore.getState().setSessionsLaunched(tab.id, true);
  return true;
}

/**
 * CLI flags for a successor: autonomy requires skip-permissions regardless
 * of the user's manual-session preference; their custom flags still apply.
 */
export function samuraiSuccessorCliFlags(base: CliFlags): CliFlags {
  return { ...base, skipPermissions: true };
}

/**
 * Registers a just-launched successor under supervision. Called by the grid
 * right before the CLI command is typed, so the backend's ritual delivery is
 * armed strictly before claude's SessionStart hook can fire.
 */
export async function registerSamuraiSuccessor(
  sessionId: number,
  samurai: SamuraiSuccessorInfo,
): Promise<void> {
  await samuraiRegisterSession(sessionId, samurai.project, samurai.epic, samurai.generation);
}

// Same StrictMode-safe init/stop shape as the samurai supervisor listener in
// useSessionStore: `active` tracks the desired state so an init/stop pair
// racing the pending listen() promise cannot leak a second listener.
let spawnUnlisten: UnlistenFn | null = null;
let spawnStarting: Promise<void> | null = null;
let spawnActive = false;

export async function initSamuraiSpawnListener(): Promise<void> {
  spawnActive = true;
  if (spawnUnlisten || spawnStarting) return;
  spawnStarting = listen<SamuraiSpawnSuccessorEvent>("samurai-spawn-successor", (event) => {
    queueSamuraiSuccessorLaunch(event.payload);
  })
    .then((fn) => {
      if (!spawnActive) {
        fn();
        return;
      }
      spawnUnlisten = fn;
    })
    .finally(() => {
      spawnStarting = null;
    });
  await spawnStarting;
}

export function stopSamuraiSpawnListener(): void {
  spawnActive = false;
  if (spawnUnlisten) {
    spawnUnlisten();
    spawnUnlisten = null;
  }
}
