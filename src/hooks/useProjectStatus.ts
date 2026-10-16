import { useMemo } from "react";
import { samePath } from "@/lib/path";
import {
  type BackendSessionStatus,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

/**
 * The sessions belonging to a project tab.
 * Filters by both session ID and project_path to prevent cross-project session
 * matching — this guards against session ID collision when IDs reset after an
 * app restart. Shared by useProjectStatus and the sidebar Agents section so
 * the collision rule can't drift between them.
 */
export function sessionsForTab(tab: WorkspaceTab, sessions: SessionConfig[]): SessionConfig[] {
  return sessions.filter(
    (s) => tab.sessionIds.includes(s.id) && samePath(s.project_path, tab.projectPath),
  );
}

/**
 * Aggregated status for a project, derived from its sessions.
 * Priority order: NeedsInput > Working > Error (or a startup Timeout) > Done > Starting > Idle
 *
 * NeedsInput comes first on purpose: the tab strip answers "does this project
 * need me?", and with several terminals per project something is almost always
 * working — ranking Working first hid every blocked terminal behind a busy one.
 */
export type ProjectStatus = "idle" | "starting" | "working" | "needs-input" | "done" | "error";

/**
 * Maps backend session status to CSS color class names.
 *
 * Blue means working, the neon accent means "needs your input" — the same
 * convention the session badges, terminal chrome and thinking dots use. These
 * two used to be swapped here (working painted accent-red, needs-input yellow),
 * which taught the opposite of every other surface.
 */
export const STATUS_COLORS: Record<ProjectStatus, string> = {
  idle: "bg-maestro-muted",
  starting: "bg-orange-500",
  working: "bg-maestro-blue",
  "needs-input": "bg-maestro-accent",
  done: "bg-maestro-green",
  error: "bg-maestro-red",
};

/**
 * Hook to get the aggregated status for a project tab.
 * Derives status from all sessions belonging to the project.
 */
export function useProjectStatus(tabId: string): {
  status: ProjectStatus;
  sessionCount: number;
  activeSessionCount: number;
} {
  const tab = useWorkspaceStore((s) => s.tabs.find((t) => t.id === tabId));
  const sessions = useSessionStore((s) => s.sessions);

  return useMemo(() => {
    if (!tab) {
      return { status: "idle" as ProjectStatus, sessionCount: 0, activeSessionCount: 0 };
    }

    const projectSessions = sessionsForTab(tab, sessions);
    const sessionCount = projectSessions.length;

    if (sessionCount === 0) {
      return { status: "idle" as ProjectStatus, sessionCount: 0, activeSessionCount: 0 };
    }

    // Count active sessions (not Done, Error or Timeout — a startup timeout is a failure)
    const activeSessionCount = projectSessions.filter(
      (s) => s.status !== "Done" && s.status !== "Error" && s.status !== "Timeout",
    ).length;

    // Priority-based status aggregation
    const hasStatus = (status: BackendSessionStatus) =>
      projectSessions.some((s) => s.status === status);

    let status: ProjectStatus;
    if (hasStatus("NeedsInput")) {
      status = "needs-input";
    } else if (hasStatus("Working")) {
      status = "working";
    } else if (hasStatus("Error") || hasStatus("Timeout")) {
      // A startup timeout is painted red by the status dot and the parked chip too.
      status = "error";
    } else if (projectSessions.every((s) => s.status === "Done")) {
      status = "done";
    } else if (hasStatus("Starting")) {
      status = "starting";
    } else {
      status = "idle";
    }

    return { status, sessionCount, activeSessionCount };
  }, [tab, sessions]);
}
