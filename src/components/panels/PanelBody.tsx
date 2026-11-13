import { lazy, Suspense } from "react";
import { FilesPanel } from "@/components/files/FilesPanel";
import { HistorySection } from "@/components/sidebar/HistorySection";
import { InfraTab } from "@/components/sidebar/InfraTab";
import { InjectorSection } from "@/components/sidebar/InjectorSection";
import { InjectorTriggersSection } from "@/components/sidebar/InjectorTriggersSection";
import { LaunchSection } from "@/components/sidebar/LaunchSection";
import { SecondBrainSection } from "@/components/sidebar/SecondBrainSection";
import { SettingsPanelContent } from "@/components/sidebar/Sidebar";
import type { PanelId } from "@/stores/usePanelStripStore";
import { GitPanelBody, type GitPanelProps } from "./GitPanel";

// NotepadPanel drags in TipTap + ProseMirror, which are only needed once the
// user opens the Notes panel; a static import parses them all at startup.
const NotepadPanel = lazy(() =>
  import("@/components/notepad/NotepadPanel").then((m) => ({
    default: m.NotepadPanel,
  })),
);

// WorkJournalPanel drags in TipTap too, so it is lazy-loaded the same way.
const WorkJournalPanel = lazy(() =>
  import("@/components/workjournal/WorkJournalPanel").then((m) => ({
    default: m.WorkJournalPanel,
  })),
);

// WorkshopPanel drags in react-markdown, so it is lazy-loaded the same way.
const WorkshopPanel = lazy(() =>
  import("@/components/workshop/WorkshopPanel").then((m) => ({
    default: m.WorkshopPanel,
  })),
);

/** What the panels need from App: callbacks into the terminals and the Git panel's state. */
export interface PanelContentProps {
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  /** Running sessions in the active project (drives Stop All). */
  launchedCount?: number;
  isStoppingAll?: boolean;
  onStopAll?: () => void;
  /** Zoom into a terminal (Agents list, History, Launch's open button). */
  onAgentNavigate?: (tabId: string, sessionId: number) => void;
  onAgentKill?: (tabId: string, sessionId: number) => void;
  /** History queued a recovery launch: reveal that project's grid. */
  onHistoryLaunch?: (tabId: string) => void;
  git: GitPanelProps;
}

/** One panel's contents, unchanged from where it lived before the icon strip. */
export function PanelBody({
  id,
  open,
  content,
}: {
  id: PanelId;
  /** False while a kept-mounted panel is hidden. */
  open: boolean;
  content: PanelContentProps;
}) {
  switch (id) {
    case "git":
      return <GitPanelBody {...content.git} open={open} />;
    // Files, Notes, Work Journal and Workshop lay themselves out edge to edge
    // and scroll internally, so they skip the padded scroll wrapper.
    case "files":
      return <FilesPanel />;
    case "notes":
      return (
        <Suspense fallback={<div className="flex-1" />}>
          <NotepadPanel />
        </Suspense>
      );
    case "workjournal":
      return (
        <Suspense fallback={<div className="flex-1" />}>
          <WorkJournalPanel />
        </Suspense>
      );
    case "workshop":
      return (
        <Suspense fallback={<div className="flex-1" />}>
          <WorkshopPanel />
        </Suspense>
      );
    default:
      return (
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3">
          <PaddedPanelBody id={id} content={content} />
        </div>
      );
  }
}

function PaddedPanelBody({ id, content }: { id: PanelId; content: PanelContentProps }) {
  switch (id) {
    case "history":
      // onAgentNavigate reaches a conversation that is already running
      // instead of dropping it from the list.
      return (
        <HistorySection onLaunch={content.onHistoryLaunch} onNavigate={content.onAgentNavigate} />
      );
    case "infra":
      return <InfraTab />;
    case "settings":
      return (
        <SettingsPanelContent
          theme={content.theme}
          onToggleTheme={content.onToggleTheme}
          launchedCount={content.launchedCount}
          isStoppingAll={content.isStoppingAll}
          onStopAll={content.onStopAll}
          onAgentNavigate={content.onAgentNavigate}
          onAgentKill={content.onAgentKill}
        />
      );
    case "inject":
      return (
        <>
          <InjectorSection />
          <InjectorTriggersSection />
        </>
      );
    case "launch":
      return <LaunchSection onNavigate={content.onAgentNavigate} />;
    case "secondbrain":
      return <SecondBrainSection />;
    default:
      return null;
  }
}
