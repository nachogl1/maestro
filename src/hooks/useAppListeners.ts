import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { initSamuraiSpawnListener, stopSamuraiSpawnListener } from "@/lib/spawnSession";
import { initActivityListener, stopActivityListener } from "@/stores/useActivityStore";
import { initAgentListener, stopAgentListener } from "@/stores/useAgentStore";
import {
  initBackgroundTaskListener,
  stopBackgroundTaskListener,
} from "@/stores/useBackgroundTaskStore";
import {
  initContextUsageListener,
  initSamuraiSupervisorListener,
  stopContextUsageListener,
  stopSamuraiSupervisorListener,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useTerminalSettingsStore } from "@/stores/useTerminalSettingsStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/**
 * App-lifetime setup and backend event subscriptions, mounted once by `App`:
 * platform tagging, orphaned-PTY cleanup + session fetch, terminal settings,
 * and the update / activity / context-usage / Samurai / agent / CLI-open
 * listeners. Each effect tears down its own subscription on unmount.
 */
export function useAppListeners(): void {
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const initListeners = useSessionStore((s) => s.initListeners);

  // Tag the document with platform class so CSS can disable expensive effects
  // (e.g. box-shadow animations) that aren't GPU-accelerated on WebKitGTK/Linux.
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("linux")) {
      document.documentElement.classList.add("platform-linux");
    }
  }, []);

  // Clean up orphaned PTY sessions on mount, then fetch fresh session state.
  // kill_all_sessions clears both ProcessManager (PTYs) and SessionManager
  // (metadata), so fetchSessions must run AFTER cleanup completes to avoid
  // loading stale "idle" sessions from a previous frontend lifecycle.
  useEffect(() => {
    invoke<number>("kill_all_sessions")
      .then((count) => {
        if (count > 0) {
          console.log(`Cleaned up ${count} orphaned PTY session(s) from previous page load`);
        }
      })
      .catch((err) => {
        console.error("Failed to clean up orphaned sessions:", err);
      })
      .finally(() => {
        fetchSessions().catch((err) => {
          console.error("Failed to fetch sessions:", err);
        });
      });

    const unlistenPromise = initListeners().catch((err) => {
      console.error("Failed to initialize listeners:", err);
      return () => {}; // no-op cleanup
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [fetchSessions, initListeners]);

  // Initialize terminal settings store (detects available fonts)
  const initializeTerminalSettings = useTerminalSettingsStore((s) => s.initialize);
  useEffect(() => {
    initializeTerminalSettings().catch((err) => {
      console.error("Failed to initialize terminal settings:", err);
    });
  }, [initializeTerminalSettings]);

  // Initialize update event listeners (the periodic auto-check lives in
  // useBackgroundPollers)
  const initUpdateListeners = useUpdateStore((s) => s.initListeners);
  useEffect(() => {
    const unlistenPromise = initUpdateListeners().catch((err) => {
      console.error("Failed to initialize update listeners:", err);
      return () => {};
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [initUpdateListeners]);

  // Initialize activity event listener (batched claude-events from the transcript watcher)
  useEffect(() => {
    initActivityListener().catch((err) => {
      console.error("Failed to initialize activity listener:", err);
    });
    return () => {
      stopActivityListener();
    };
  }, []);

  // Initialize context usage listener (per-session context-window % from
  // ContextUsageUpdate events, surfaced on the session store)
  useEffect(() => {
    initContextUsageListener().catch((err) => {
      console.error("Failed to initialize context usage listener:", err);
    });
    return () => {
      stopContextUsageListener();
    };
  }, []);

  // Samurai supervisor listener: tracks generation/state for the badges
  // (issue #46), flips DEAD sessions (silent-death watchdog, issue #44) to
  // Error chrome + attention, and flags supervised sessions on allowance
  // threshold crossings (issue #45).
  useEffect(() => {
    initSamuraiSupervisorListener().catch((err) => {
      console.error("Failed to initialize samurai supervisor listener:", err);
    });
    return () => {
      stopSamuraiSupervisorListener();
    };
  }, []);

  // Samurai successor spawns (issue #55): after killing gen-N the backend
  // emits samurai-spawn-successor; this listener queues the gen-N+1 launch
  // through the existing pending-launch flow (same path as History-tab
  // recoveries) and the grid registers it under supervision.
  useEffect(() => {
    initSamuraiSpawnListener().catch((err) => {
      console.error("Failed to initialize samurai spawn listener:", err);
    });
    return () => {
      stopSamuraiSpawnListener();
    };
  }, []);

  // Initialize agent listener (tracks subagents for the sidebar Agents section)
  useEffect(() => {
    initAgentListener().catch((err) => {
      console.error("Failed to initialize agent listener:", err);
    });
    return () => {
      stopAgentListener();
    };
  }, []);

  // Initialize background-work listener (keeps a session Working while its
  // agent waits on background commands, monitors, workflows or loops)
  useEffect(() => {
    initBackgroundTaskListener().catch((err) => {
      console.error("Failed to initialize background task listener:", err);
    });
    return () => {
      stopBackgroundTaskListener();
    };
  }, []);

  // Listen for CLI-initiated project open events (from `maestro /path`).
  //
  // Two triggers:
  //   1. A subsequent `maestro <path>` invocation fires the
  //      `cli-open-project` event immediately via the single-instance plugin.
  //   2. On first launch the path was captured in a backend slot; we drain it
  //      here on mount via `take_pending_cli_path`. That replaces the older
  //      500ms sleep + emit dance, which raced against slow frontend mounts.
  useEffect(() => {
    const openFromCli = async (path: string) => {
      if (!path) return;
      try {
        await useWorkspaceStore.getState().openProject(path);
      } catch (err) {
        console.error("cli-open-project failed:", err);
        return;
      }
      getCurrentWindow()
        .setFocus()
        .catch(() => {});
    };

    // Drain any path captured before we mounted.
    invoke<string | null>("take_pending_cli_path")
      .then((path) => {
        if (path) void openFromCli(path);
      })
      .catch(() => {});

    const unlisten = listen<string>("cli-open-project", (event) => {
      void openFromCli(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
