import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo } from "react";
import { WorkJournalDayList } from "@/components/workjournal/WorkJournalDayList";
import { WorkJournalPanel } from "@/components/workjournal/WorkJournalPanel";
import { followWorkJournalRunState } from "@/lib/workJournalWindow";
import {
  pendingCountsByDate,
  useWorkJournalCandidatesStore,
} from "@/stores/useWorkJournalCandidatesStore";
import { flushWorkJournalSaves, useWorkJournalStore } from "@/stores/useWorkJournalStore";

/**
 * Root of the pop-out Work Journal window (layout B): the day list on the
 * left and the same header, toolbar, page and suggestions box as the pane on
 * the right. It reads and writes through the same backend commands as the
 * pane; each re-reads when the other changed something.
 */
export function WorkJournalWindow() {
  const pages = useWorkJournalStore((s) => s.pages);
  const viewedDate = useWorkJournalStore((s) => s.viewedDate);
  const selectDate = useWorkJournalStore((s) => s.selectDate);
  const byDate = useWorkJournalCandidatesStore((s) => s.byDate);
  const pendingCounts = useWorkJournalCandidatesStore((s) => s.pendingCounts);
  const pendingByDate = useMemo(
    () =>
      pendingCountsByDate({ ...useWorkJournalCandidatesStore.getState(), byDate, pendingCounts }),
    [byDate, pendingCounts],
  );

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
    document.title = "Work Journal";
  }, []);

  // Suggestions follow the candidates event and the other window's changes;
  // runs stay with the main window, which sends its run state here.
  useEffect(() => {
    const stopCandidates = useWorkJournalCandidatesStore
      .getState()
      .initListeners()
      .catch((err) => {
        console.error("Failed to initialize Work Journal suggestion listeners:", err);
        return () => {};
      });
    const stopRunState = followWorkJournalRunState().catch((err) => {
      console.error("Failed to follow the Work Journal run state:", err);
      return () => {};
    });
    // Typing still waiting for the save debounce is sent before the window goes.
    const stopClose = getCurrentWindow()
      .onCloseRequested(async () => {
        await flushWorkJournalSaves();
      })
      .catch((err) => {
        console.error("Failed to save the Work Journal before its window closes:", err);
        return () => {};
      });
    return () => {
      void stopCandidates.then((stop) => stop());
      void stopRunState.then((stop) => stop());
      void stopClose.then((stop) => stop());
    };
  }, []);

  return (
    <div className="flex h-screen min-h-0 w-screen bg-maestro-surface text-maestro-text">
      <WorkJournalDayList
        pages={pages}
        viewedDate={viewedDate}
        pendingByDate={pendingByDate}
        onSelect={selectDate}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <WorkJournalPanel inWindow />
      </div>
    </div>
  );
}
