import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import {
  ISSUE_MAP_CLOSED_EVENT,
  ISSUE_MAP_OPEN_EVENT,
  ISSUE_MAP_SELECT_EVENT,
  type IssueMapSelection,
  type IssueMapTarget,
  issueMapWindowTitle,
} from "@/lib/issueMapWindow";
import { IssueMapModal } from "./IssueMapModal";

interface IssueMapWindowProps {
  initial: IssueMapTarget;
}

/** Root of the separate issue map window; talks to the main window by events. */
export function IssueMapWindow({ initial }: IssueMapWindowProps) {
  const [target, setTarget] = useState<IssueMapTarget>(initial);

  // Same origin as the main window, so its stored theme applies here too.
  useEffect(() => {
    const applyTheme = () => {
      const theme = localStorage.getItem("maestro-theme") === "light" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", theme);
    };
    applyTheme();
    window.addEventListener("storage", applyTheme);
    return () => window.removeEventListener("storage", applyTheme);
  }, []);

  useEffect(() => {
    const unlisten = listen<IssueMapTarget>(ISSUE_MAP_OPEN_EVENT, (event) =>
      setTarget(event.payload),
    );
    // Tell the main window so it picks up assignment changes made here.
    const unlistenClose = getCurrentWindow().onCloseRequested(async () => {
      await emitTo("main", ISSUE_MAP_CLOSED_EVENT, target).catch(() => {});
    });
    return () => {
      void unlisten.then((fn) => fn());
      void unlistenClose.then((fn) => fn());
    };
  }, [target]);

  // The OS title bar does not follow document.title, so set both.
  const title = issueMapWindowTitle(target.repoPath);
  useEffect(() => {
    document.title = title;
    getCurrentWindow()
      .setTitle(title)
      .catch((err) => console.error("Failed to set the issue map window title:", err));
  }, [title]);

  return (
    <IssueMapModal
      key={target.repoPath}
      repoPath={target.repoPath}
      search={target.search}
      projects={target.projects ?? []}
      onSwitchProject={(repoPath) => setTarget({ ...target, repoPath })}
      onSelectIssue={(number) => {
        const selection: IssueMapSelection = { repoPath: target.repoPath, number };
        void emitTo("main", ISSUE_MAP_SELECT_EVENT, selection);
      }}
      onClose={() => void getCurrentWindow().close()}
    />
  );
}
