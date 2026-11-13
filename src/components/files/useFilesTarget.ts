import { samePath } from "@/lib/path";
import { projectColorFor } from "@/lib/projectColor";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { useProjectColors } from "@/lib/useProjectColors";
import { useFocusedTerminalStore } from "@/stores/useFocusedTerminalStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { baseName } from "./filesApi";

/** The folder the Files panel shows and whose terminal it belongs to. */
export interface FilesTarget {
  terminalName: string;
  projectName: string;
  projectColor: string;
  /** A worktree terminal shows its worktree; any other its project folder. */
  kind: "worktree" | "project";
  folder: string;
}

/** The focused terminal's folder, or null when no terminal is open or focused. */
export function useFilesTarget(): FilesTarget | null {
  const focusedSessionId = useFocusedTerminalStore((s) => s.focusedSessionId);
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === focusedSessionId));
  const tabs = useWorkspaceStore((s) => s.tabs);
  const colors = useProjectColors();
  if (!session) return null;
  const tab = tabs.find((t) => samePath(t.projectPath, session.project_path));
  const projectName = tab?.name ?? baseName(session.project_path);
  const worktree = session.worktree_path;
  return {
    terminalName: sessionDisplayName(session),
    projectName,
    projectColor: colors.get(projectName) ?? projectColorFor(projectName),
    kind: worktree ? "worktree" : "project",
    folder: worktree || session.project_path,
  };
}
