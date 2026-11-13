import { killSession } from "@/lib/terminal";
import { useScratchStore } from "@/stores/useScratchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";

/**
 * The sidebar's Stop All: kills every terminal of one project and drops them
 * from the session store and from the project's tab. On a scratch project that
 * closes its last terminal, so it asks Delete or Keep like any other close.
 */
export async function stopProjectSessions(tabId: string, projectPath: string): Promise<void> {
  const sessionStore = useSessionStore.getState();
  const projectSessions = sessionStore.getSessionsByProject(projectPath);
  const results = await Promise.allSettled(projectSessions.map((s) => killSession(s.id)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Failed to stop session:", result.reason);
    }
  }
  await sessionStore.removeSessionsForProject(projectPath);
  // Drop the dead ids from the tab too, or the close-tab confirm and the
  // eagle zoom strip keep counting terminals that no longer run.
  const { removeSessionFromProject } = useWorkspaceStore.getState();
  for (const s of projectSessions) {
    removeSessionFromProject(tabId, s.id);
  }
  if (projectSessions.length > 0) useScratchStore.getState().askAfterTerminalClosed(tabId);
}
