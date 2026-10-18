import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { GitFork, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { MAC_TITLE_BAR_INSET_PX, useMacTitleBarPadding } from "@/hooks/useMacTitleBarPadding";
import { getDeduplicatedCurrentBranch, invalidateCurrentBranchCache } from "@/lib/git";
import { samePath } from "@/lib/path";
import { isMac } from "@/lib/platform";
import { projectColorFor } from "@/lib/projectColor";
import { killSession } from "@/lib/terminal";
import { useOpenProject } from "@/lib/useOpenProject";
import { useProjectColors } from "@/lib/useProjectColors";
import { useFDAStore } from "@/stores/useFDAStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { type RepositoryInfo, useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { GitGraphPanel } from "./components/git/GitGraphPanel";
import type { GitPanelTab } from "./components/git/GitPanelTabs";
import { BottomBar } from "./components/shared/BottomBar";
import { EagleProjectPickerModal } from "./components/shared/EagleProjectPickerModal";
import { FDADialog } from "./components/shared/FDADialog";
import {
  MultiProjectView,
  type MultiProjectViewHandle,
} from "./components/shared/MultiProjectView";
import { NotificationToasts } from "./components/shared/NotificationToasts";
import {
  loadRightPanelWidth,
  RIGHT_PANEL_WIDTH_STORAGE_KEY,
} from "./components/shared/PanelResizeHandle";
import { ParticleEffectsLayer } from "./components/shared/ParticleEffectsLayer";
import { ProjectTabs } from "./components/shared/ProjectTabs";
import { type EagleProjectOption, TopBar } from "./components/shared/TopBar";
import { UtilityPanel, type UtilityPanelKind } from "./components/shared/UtilityPanel";
import {
  loadSavedSidebarTab,
  Sidebar,
  type SidebarTabId,
  saveSidebarTab,
  sidebarTabShortcutTransition,
} from "./components/sidebar/Sidebar";
import { MAX_SESSIONS } from "./components/terminal/splitTree";
import { AutoUpdateQuestion } from "./components/update/AutoUpdateQuestion";
import { UpdateNotification } from "./components/update/UpdateNotification";
import { WorkJournalBackgroundWork } from "./components/workjournal/WorkJournalBackgroundWork";
import { WorkJournalOptInDialog } from "./components/workjournal/WorkJournalOptInDialog";
import { WorkJournalSettingsHost } from "./components/workjournal/WorkJournalSettingsHost";
import { useAppKeyboard } from "./hooks/useAppKeyboard";
import { useAppListeners } from "./hooks/useAppListeners";
import { useBackgroundPollers } from "./hooks/useBackgroundPollers";
import { useSwipeNavigation } from "./hooks/useSwipeNavigation";
import { useFeatureSettingsStore } from "./stores/useFeatureSettingsStore";
import { useGitHubStore } from "./stores/useGitHubStore";
import {
  useGitHubWatchdogStore,
  WATCHDOG_ISSUE_SEARCH,
  WATCHDOG_PR_SEARCH,
} from "./stores/useGitHubWatchdogStore";
import { useGitStore } from "./stores/useGitStore";
import { useWorkflowsViewStore } from "./stores/useWorkflowsViewStore";
import { useWorkJournalEnabled } from "./stores/useWorkJournalSettingsStore";

/**
 * Full-screen workflow editor, loaded on demand: it pulls in React Flow,
 * which would otherwise sit in the entry chunk even though the editor only
 * renders once opened from the Launch tab via `useWorkflowsViewStore`.
 */
const WorkflowsView = lazy(() =>
  import("./components/workflows/WorkflowsView").then((m) => ({ default: m.WorkflowsView })),
);

/** Header title for each git-panel tab. */
const GIT_PANEL_TITLES: Record<GitPanelTab, string> = {
  commits: "Commits",
  branches: "Branches",
  status: "Status",
  prs: "Pull Requests",
  issues: "Issues",
  discussions: "Discussions",
};

type Theme = "dark" | "light";

function isValidTheme(value: string | null): value is Theme {
  return value === "dark" || value === "light";
}

function App() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const projectColors = useProjectColors();
  const selectTab = useWorkspaceStore((s) => s.selectTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const reorderTabs = useWorkspaceStore((s) => s.reorderTabs);
  const moveTab = useWorkspaceStore((s) => s.moveTab);
  const setSessionsLaunched = useWorkspaceStore((s) => s.setSessionsLaunched);
  const setSelectedRepo = useWorkspaceStore((s) => s.setSelectedRepo);
  const rehydrateRepositories = useWorkspaceStore((s) => s.rehydrateRepositories);
  const { openProject: handleOpenProject } = useOpenProject();
  const showFDADialog = useFDAStore((s) => s.showDialog);
  const fdaPath = useFDAStore((s) => s.pendingPath);
  const dismissFDADialog = useFDAStore((s) => s.dismiss);
  const dismissFDADialogPermanently = useFDAStore((s) => s.dismissPermanently);
  const retryAfterFDAGrant = useFDAStore((s) => s.retryAfterGrant);
  const multiProjectRef = useRef<MultiProjectViewHandle>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Active left-sidebar tab — lifted out of Sidebar so Alt+1-3 can drive it.
  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>(loadSavedSidebarTab);
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  // Git-panel tab (commits/branches/…) is deliberately a single app-level
  // state shared across eagle carousel cards: swiping keeps you on the same
  // tab for every project. Per-repo selections are cleared by GitGraphPanel
  // whenever repoPath changes, so no per-project tab state is needed.
  const [gitPanelTab, setGitPanelTab] = useState<GitPanelTab>("status");
  const [sessionCounts, setSessionCounts] = useState<
    Map<string, { slotCount: number; launchedCount: number; occupiedCount: number }>
  >(new Map());
  const [isStoppingAll, setIsStoppingAll] = useState(false);
  const [currentBranch, setCurrentBranch] = useState<string | undefined>(undefined);
  // Eagle view: one flat grid of every project's terminals at once
  const [eagleView, setEagleView] = useState(false);
  // Eagle view Cmd/Ctrl+T: arrow-navigable project picker for the new terminal.
  const [eagleAddPickerOpen, setEagleAddPickerOpen] = useState(false);
  // Eagle view git carousel: index of the project whose git panel card shows.
  const [eagleGitIndex, setEagleGitIndex] = useState(0);
  // Full-screen workflow editor (Launch tab → "Open workflow editor"):
  // opened via a store rather than local state, since the trigger lives deep
  // inside the sidebar rather than a prop App can pass down.
  const workflowsViewOpen = useWorkflowsViewStore((s) => s.isOpen);
  const closeWorkflowsView = useWorkflowsViewStore((s) => s.close);
  // Right-side utility panel (Notes / Second Brain / Launch), opened from the
  // top bar. One at a time: opening one replaces the other.
  const [utilityPanel, setUtilityPanel] = useState<UtilityPanelKind | null>(null);
  // One shared width for every right-docked panel (utility panels, Git),
  // so switching between them never changes the pane size. Persisted.
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(loadRightPanelWidth);
  const handleRightPanelResize = useCallback((width: number) => {
    setRightPanelWidth(width);
    localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, String(width));
  }, []);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("maestro-theme");
    return isValidTheme(stored) ? stored : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("maestro-theme", theme);
  }, [theme]);

  useAppListeners();
  useBackgroundPollers(tabs);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  const macTitleBarPadding = useMacTitleBarPadding();
  const activeTab = tabs.find((tab) => tab.active) ?? null;

  // Eagle view git carousel: the git panel shows one project card at a time.
  // The index is clamped as a derivation (not an effect) so closing tabs can
  // never leave it out of bounds; zero tabs → null target → the panel's
  // "open a git repository" empty state. Outside eagle view this collapses to
  // the active tab, so non-eagle behavior is unchanged.
  const clampedEagleGitIndex = tabs.length === 0 ? 0 : Math.min(eagleGitIndex, tabs.length - 1);
  const gitTargetTab = eagleView ? (tabs[clampedEagleGitIndex] ?? null) : activeTab;
  const gitRepoPath = gitTargetTab
    ? (gitTargetTab.selectedRepoPath ?? gitTargetTab.projectPath)
    : undefined;

  // Entering eagle view starts the carousel on the currently active project.
  useEffect(() => {
    if (!eagleView) return;
    const ts = useWorkspaceStore.getState().tabs;
    const idx = ts.findIndex((t) => t.active);
    if (idx >= 0) setEagleGitIndex(idx);
  }, [eagleView]);

  // Swipe between carousel cards with wraparound. `getState()` keeps these
  // callbacks stable (mirrors switchToNextTab/switchToPrevTab semantics).
  const handleEagleGitPrev = useCallback(() => {
    setEagleGitIndex((i) => {
      const n = useWorkspaceStore.getState().tabs.length;
      return n === 0 ? 0 : (Math.min(i, n - 1) - 1 + n) % n;
    });
  }, []);

  const handleEagleGitNext = useCallback(() => {
    setEagleGitIndex((i) => {
      const n = useWorkspaceStore.getState().tabs.length;
      return n === 0 ? 0 : (Math.min(i, n - 1) + 1) % n;
    });
  }, []);

  // Trackpad two-finger horizontal swipe to switch project tabs
  const switchToNextTab = useCallback(() => {
    const idx = tabs.findIndex((t) => t.active);
    const next = tabs[(idx + 1) % tabs.length];
    if (next) selectTab(next.id);
  }, [tabs, selectTab]);

  const switchToPrevTab = useCallback(() => {
    const idx = tabs.findIndex((t) => t.active);
    const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
    if (prev) selectTab(prev.id);
  }, [tabs, selectTab]);

  useSwipeNavigation({
    onSwipeLeft: switchToNextTab,
    onSwipeRight: switchToPrevTab,
    enabled: tabs.length >= 2,
  });

  // Git store for commit count and refresh. Granular selectors, not the whole
  // store: a selector-less subscription re-renders App on every git `set()`,
  // and App has no memo barrier in front of the terminals.
  const commitCount = useGitStore((s) => s.commits.length);
  const fetchCommits = useGitStore((s) => s.fetchCommits);
  const [isRefreshingGit, setIsRefreshingGit] = useState(false);

  const handleRefreshGit = useCallback(async () => {
    if (!gitRepoPath) return;
    setIsRefreshingGit(true);
    try {
      await fetchCommits(gitRepoPath);
    } finally {
      setIsRefreshingGit(false);
    }
  }, [gitRepoPath, fetchCommits]);

  useEffect(() => {
    let cancelled = false;
    if (!gitRepoPath) {
      setCurrentBranch(undefined);
      return () => {};
    }
    getDeduplicatedCurrentBranch(gitRepoPath)
      .then((branch) => {
        if (!cancelled) setCurrentBranch(branch);
      })
      .catch((err) => {
        console.error("Failed to load current branch:", err);
        if (!cancelled) setCurrentBranch(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [gitRepoPath]);

  // Rehydrate multi-repo tabs after store rehydration
  useEffect(() => {
    rehydrateRepositories().catch((err) => {
      console.error("Failed to rehydrate repositories:", err);
    });
  }, [rehydrateRepositories]);

  // Auto-refresh repos on window focus (with 2s debounce)
  useEffect(() => {
    let lastRefresh = 0;
    const COOLDOWN_MS = 2000;

    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefresh < COOLDOWN_MS) return;
      lastRefresh = now;

      const tab = useWorkspaceStore.getState().tabs.find((t) => t.active);
      if (!tab) return;

      if (tab.workspaceType === "multi-repo") {
        invoke<RepositoryInfo[]>("detect_repositories", { path: tab.projectPath })
          .then((repos) => {
            useWorkspaceStore.getState().updateRepositories(tab.id, repos);
          })
          .catch((err) => console.error("Failed to refresh repos on focus:", err));
      }

      // Refresh branch for the active repo. The branch may have changed while
      // the window was away, so drop the short-lived cache first — this path
      // exists precisely to re-read git.
      const repoPath = tab.selectedRepoPath ?? tab.projectPath;
      if (repoPath) {
        invalidateCurrentBranchCache(repoPath);
        getDeduplicatedCurrentBranch(repoPath)
          .then(setCurrentBranch)
          .catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // Derive state from active tab
  const activeTabSessionsLaunched = activeTab?.sessionsLaunched ?? false;
  const activeTabCounts = activeTab ? sessionCounts.get(activeTab.id) : undefined;
  const activeTabSlotCount = activeTabCounts?.slotCount ?? 0;
  const activeTabLaunchedCount = activeTabCounts?.launchedCount ?? 0;
  // What the "+" button weighs against MAX_SESSIONS: parked samurai terminal-state
  // tiles are exempt, same as addSession, so the button and Ctrl+T agree.
  const activeTabOccupiedCount = activeTabCounts?.occupiedCount ?? 0;

  const handleStopAll = useCallback(async () => {
    if (!activeTab || isStoppingAll) return;
    setIsStoppingAll(true);
    try {
      const sessionStore = useSessionStore.getState();
      const projectSessions = sessionStore.getSessionsByProject(activeTab.projectPath);
      const results = await Promise.allSettled(projectSessions.map((s) => killSession(s.id)));
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("Failed to stop session:", result.reason);
        }
      }
      await sessionStore.removeSessionsForProject(activeTab.projectPath);
      // Drop the dead ids from the tab too, or the close-tab confirm and the
      // eagle zoom strip keep counting terminals that no longer run.
      const { removeSessionFromProject } = useWorkspaceStore.getState();
      for (const s of projectSessions) {
        removeSessionFromProject(activeTab.id, s.id);
      }
      setSessionsLaunched(activeTab.id, false);
      setSessionCounts((prev) => {
        const next = new Map(prev);
        next.set(activeTab.id, { slotCount: 0, launchedCount: 0, occupiedCount: 0 });
        return next;
      });
    } finally {
      setIsStoppingAll(false);
    }
  }, [activeTab, isStoppingAll, setSessionsLaunched]);

  // Cmd/Ctrl+T: add a new terminal. In eagle view this opens the project
  // picker modal; otherwise the active project's grid gets a new slot (the
  // grid keeps the zoom-in view and zooms the new slot when one is zoomed).
  const handleAddSessionShortcut = useCallback(() => {
    if (eagleView) {
      setEagleAddPickerOpen(true);
      return;
    }
    // addSessionInProject also covers an idle project (no grid mounted yet).
    if (activeTab) multiProjectRef.current?.addSessionInProject(activeTab.id);
  }, [eagleView, activeTab]);

  // Leaving eagle view always drops the picker.
  useEffect(() => {
    if (!eagleView) setEagleAddPickerOpen(false);
  }, [eagleView]);

  const handleToggleUtilityPanel = useCallback((panel: UtilityPanelKind) => {
    setUtilityPanel((prev) => (prev === panel ? null : panel));
  }, []);

  // Work Journal is opt-in: turning it off hides its button and closes its pane.
  const workJournalEnabled = useWorkJournalEnabled();
  useEffect(() => {
    if (!workJournalEnabled) setUtilityPanel((prev) => (prev === "workjournal" ? null : prev));
  }, [workJournalEnabled]);

  // Samurai launch and Second Brain can be switched off in Settings → Features:
  // their buttons leave the top bar and an open pane closes.
  const samuraiLaunchEnabled = useFeatureSettingsStore((s) => s.samuraiLaunchEnabled);
  const secondBrainEnabled = useFeatureSettingsStore((s) => s.secondBrainEnabled);
  useEffect(() => {
    if (!samuraiLaunchEnabled) setUtilityPanel((prev) => (prev === "launch" ? null : prev));
  }, [samuraiLaunchEnabled]);
  useEffect(() => {
    if (!secondBrainEnabled) setUtilityPanel((prev) => (prev === "secondbrain" ? null : prev));
  }, [secondBrainEnabled]);

  // Eagle view add-terminal dropdown: every open project tab is offered.
  // Picking one stays in eagle view: a pre-launch card tiles into the eagle
  // grid for that project, so the terminal is configured (name/branch/worktree/…)
  // and launched right there — the same flow as adding a session outside eagle
  // view, just rendered as a tile among the other projects' panes.
  const eagleProjects: EagleProjectOption[] = tabs.map((t) => ({
    tabId: t.id,
    name: t.name,
    color: projectColors.get(t.name) ?? projectColorFor(t.name),
    atMax: (sessionCounts.get(t.id)?.occupiedCount ?? 0) >= MAX_SESSIONS,
  }));

  const handleAddSessionToProject = useCallback(
    (tabId: string) => {
      // Stays in eagle view — selectTab keeps the tab tracked as active so
      // leaving eagle view later lands on this project.
      selectTab(tabId);
      multiProjectRef.current?.addSessionInProject(tabId);
    },
    [selectTab],
  );

  // Sidebar History tab queued a recovery launch: leave eagle view and select
  // the project so its grid mounts and consumes the pending launch.
  const handleHistoryLaunch = useCallback(
    (tabId: string) => {
      setEagleView(false);
      selectTab(tabId);
    },
    [selectTab],
  );

  // Sidebar Agents section: zoom into a terminal. In eagle view the eagle zoom
  // overlay is used (panes stay mounted); otherwise activate the project tab
  // and zoom its pane once the tab switch has committed to the DOM.
  const handleAgentNavigate = useCallback(
    (tabId: string, sessionId: number) => {
      selectTab(tabId);
      requestAnimationFrame(() => {
        multiProjectRef.current?.zoomSessionInProject(tabId, sessionId);
      });
    },
    [selectTab],
  );

  // Sidebar Agents section: kill one terminal. Normally routed through the
  // project's grid for full pane cleanup; if that grid isn't mounted (stale
  // session row), fall back to killing the PTY and store entries directly so
  // a confirmed kill never silently no-ops.
  const handleAgentKill = useCallback((tabId: string, sessionId: number) => {
    const handledByGrid = multiProjectRef.current?.killSessionInProject(tabId, sessionId) ?? false;
    if (!handledByGrid) {
      killSession(sessionId).catch(console.error);
      useSessionStore.getState().removeSession(sessionId);
      useWorkspaceStore.getState().removeSessionFromProject(tabId, sessionId);
    }
  }, []);

  // Top-bar parked-runs badge: land on the project whose Samurai run is
  // parked. Leaves eagle view because the project's own grid is where the
  // park's chip and shelf chip live.
  const handleParkNavigate = useCallback(
    (projectPath: string) => {
      const target = useWorkspaceStore
        .getState()
        .tabs.find((t) => samePath(t.projectPath, projectPath));
      if (!target) return;
      setEagleView(false);
      selectTab(target.id);
    },
    [selectTab],
  );

  const handleSelectSidebarTab = useCallback((tab: SidebarTabId) => {
    setSidebarTab(tab);
    saveSidebarTab(tab);
  }, []);

  // Alt+1-3: open the sidebar on tab N; pressing the active tab's shortcut
  // again closes the sidebar (per-tab toggle, no separate pane toggle).
  const handleSidebarTabShortcut = useCallback(
    (index: number) => {
      const next = sidebarTabShortcutTransition(sidebarOpen, sidebarTab, index);
      if (!next) return;
      setSidebarOpen(next.open);
      if (next.open && next.tab !== sidebarTab) {
        handleSelectSidebarTab(next.tab);
      }
    },
    [sidebarOpen, sidebarTab, handleSelectSidebarTab],
  );

  // Closing a project tab terminates every terminal running in it, so when the
  // tab has live sessions we confirm first. `getState()` (not the reactive
  // `tabs` closure) keeps this callback stable and always reads fresh counts.
  const handleCloseTab = useCallback(
    async (id: string) => {
      const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === id);
      const count = tab?.sessionIds.length ?? 0;
      if (count > 0) {
        const confirmed = await ask(
          `Close "${tab?.name}"? This will terminate ${count} running terminal${
            count === 1 ? "" : "s"
          } in this project.`,
          { title: "Close project", kind: "warning" },
        ).catch(() => false);
        if (!confirmed) return;
      }
      closeTab(id);
    },
    [closeTab],
  );

  // Ctrl/Cmd+2 always lands the panel on the Status tab when toggling open.
  // Manual tab switches while the panel is open are preserved until the next open.
  // Works in eagle view too, where the panel is a per-project carousel.
  const handleToggleGitPanel = useCallback(() => {
    setGitPanelOpen((prev) => {
      if (!prev) setGitPanelTab("status");
      return !prev;
    });
  }, []);

  // GitHub watchdog badge click: land on the git panel's PRs/Issues tab with
  // the watchdog's search filter, in the project that has matching items
  // (preferring the active project). Reuses the git-panel store fetches; the
  // in-flight token guard absorbs the duplicate fetch GitGraphPanel fires.
  const handleWatchdogNavigate = useCallback(
    (kind: "prs" | "issues") => {
      const watchdogProjects = useGitHubWatchdogStore.getState().projects;
      const wsTabs = useWorkspaceStore.getState().tabs;
      const pick = kind === "prs" ? "reviewRequests" : "assignedIssues";
      const withItems = watchdogProjects.filter((p) => p[pick].length > 0);
      const activeWsTab = wsTabs.find((t) => t.active);
      const activeRepo = activeWsTab
        ? (activeWsTab.selectedRepoPath ?? activeWsTab.projectPath)
        : null;
      const target = withItems.find((p) => p.repoPath === activeRepo) ?? withItems[0] ?? null;

      if (target) {
        const targetTab = wsTabs.find(
          (t) => (t.selectedRepoPath ?? t.projectPath) === target.repoPath,
        );
        if (targetTab && !targetTab.active) selectTab(targetTab.id);
      }
      // The git panel targets the active tab outside eagle view; leave eagle
      // view so the selected project is actually the one shown.
      setEagleView(false);

      const repoPath = target?.repoPath ?? activeRepo;
      if (repoPath) {
        if (kind === "prs") {
          void useGitHubStore.getState().fetchPullRequests(repoPath, "open", WATCHDOG_PR_SEARCH);
        } else {
          void useGitHubStore.getState().fetchIssues(repoPath, "open", WATCHDOG_ISSUE_SEARCH);
        }
      }
      setGitPanelTab(kind);
      setGitPanelOpen(true);
    },
    [selectTab],
  );

  useAppKeyboard({
    onAddSession: handleAddSessionShortcut,
    // Eagle view: Cmd/Ctrl+T opens the project picker instead of adding
    // directly, so it only needs at least one open project.
    canAddSession: eagleView ? tabs.length > 0 : activeTab != null,
    onSidebarTab: handleSidebarTabShortcut,
    onToggleGitPanel: handleToggleGitPanel,
    onToggleUtilityPanel: handleToggleUtilityPanel,
    onToggleEagleView: useCallback(() => setEagleView((v) => !v), []),
    onNextProject: switchToNextTab,
    onPrevProject: switchToPrevTab,
  });

  // Handler to enter grid view for the active project
  const handleEnterGridView = () => {
    if (activeTab) {
      setSessionsLaunched(activeTab.id, true);
    }
  };

  const handleSessionCountChange = useCallback(
    (tabId: string, slotCount: number, launchedCount: number, occupiedCount: number) => {
      setSessionCounts((prev) => {
        const next = new Map(prev);
        next.set(tabId, { slotCount, launchedCount, occupiedCount });
        return next;
      });
    },
    [],
  );

  const macTitleBarInset = isMac() && macTitleBarPadding ? `${MAC_TITLE_BAR_INSET_PX}px` : "0";

  return (
    <div
      className="flex h-screen w-screen flex-col bg-maestro-bg"
      style={{ ["--mac-title-bar-inset" as string]: macTitleBarInset }}
    >
      {/* Project tabs — full width at top (with window controls) */}
      <ProjectTabs
        tabs={tabs.map((t) => ({
          id: t.id,
          name: t.name,
          active: t.active,
          color: projectColors.get(t.name) ?? projectColorFor(t.name),
        }))}
        onSelectTab={selectTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleOpenProject}
        onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
        sidebarOpen={sidebarOpen}
        onReorderTab={reorderTabs}
        onMoveTab={moveTab}
      />

      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — below project tabs */}
        <Sidebar
          collapsed={!sidebarOpen}
          onCollapse={() => setSidebarOpen(false)}
          activeTab={sidebarTab}
          onSelectTab={handleSelectSidebarTab}
          theme={theme}
          onToggleTheme={toggleTheme}
          launchedCount={activeTabLaunchedCount}
          isStoppingAll={isStoppingAll}
          onStopAll={handleStopAll}
          onAgentNavigate={handleAgentNavigate}
          onAgentKill={handleAgentKill}
          onHistoryLaunch={handleHistoryLaunch}
        />

        {/* Right column: top bar + content + bottom bar */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top bar row - includes git panel header when open */}
          <div className="flex h-10 shrink-0 bg-maestro-bg">
            {/* TopBar takes flex-1 to fill available space */}
            <TopBar
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
              onToggleGitPanel={() => setGitPanelOpen((prev) => !prev)}
              gitPanelOpen={gitPanelOpen}
              hideWindowControls
              hasActiveProject={activeTab != null}
              slotCount={activeTabOccupiedCount}
              maxSessions={MAX_SESSIONS}
              onAddSession={handleAddSessionShortcut}
              onTidyLayout={() => multiProjectRef.current?.tidyActiveProject()}
              eagleView={eagleView}
              onToggleEagleView={() => setEagleView((v) => !v)}
              eagleProjects={eagleProjects}
              onAddSessionToProject={handleAddSessionToProject}
              notesPanelOpen={utilityPanel === "notes"}
              onToggleNotesPanel={() => handleToggleUtilityPanel("notes")}
              secondBrainPanelOpen={utilityPanel === "secondbrain"}
              onToggleSecondBrainPanel={
                secondBrainEnabled ? () => handleToggleUtilityPanel("secondbrain") : undefined
              }
              launchPanelOpen={utilityPanel === "launch"}
              onToggleLaunchPanel={
                samuraiLaunchEnabled ? () => handleToggleUtilityPanel("launch") : undefined
              }
              workJournalPanelOpen={utilityPanel === "workjournal"}
              onToggleWorkJournalPanel={
                workJournalEnabled ? () => handleToggleUtilityPanel("workjournal") : undefined
              }
              workshopPanelOpen={utilityPanel === "workshop"}
              onToggleWorkshopPanel={() => handleToggleUtilityPanel("workshop")}
              injectPanelOpen={utilityPanel === "inject"}
              onToggleInjectPanel={() => handleToggleUtilityPanel("inject")}
              onWatchdogNavigate={handleWatchdogNavigate}
              onParkNavigate={handleParkNavigate}
            />

            {/* Git panel header - inline at same level as TopBar.
                In eagle view it describes the carousel-selected project. */}
            {gitPanelOpen && (
              <div
                className="flex h-10 shrink-0 items-center border-l border-maestro-border px-3 gap-2 bg-maestro-bg"
                style={{ width: rightPanelWidth }}
              >
                <GitFork size={14} className="text-maestro-muted" />
                {gitTargetTab?.workspaceType === "multi-repo" && gitTargetTab.selectedRepoPath && (
                  <span className="text-xs font-medium text-maestro-accent">
                    {
                      gitTargetTab.repositories.find(
                        (r) => r.path === gitTargetTab.selectedRepoPath,
                      )?.name
                    }
                  </span>
                )}
                <span className="text-sm font-medium text-maestro-text">
                  {GIT_PANEL_TITLES[gitPanelTab]}
                </span>
                {gitPanelTab === "commits" && commitCount > 0 && (
                  <span className="rounded-full bg-maestro-accent/15 px-1.5 py-px text-[10px] font-medium text-maestro-accent">
                    {commitCount}
                  </span>
                )}
                <div className="flex-1" />
                {gitRepoPath && (
                  <button
                    type="button"
                    onClick={handleRefreshGit}
                    disabled={isRefreshingGit}
                    className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text disabled:opacity-50"
                    aria-label="Refresh commits"
                  >
                    <RefreshCw size={14} className={isRefreshingGit ? "animate-spin" : ""} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setGitPanelOpen(false)}
                  className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
                  aria-label="Close git panel"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Content area (main + optional git panel) */}
          <div className="flex flex-1 overflow-hidden">
            {/* Main content - MultiProjectView keeps all projects alive */}
            <main className="relative flex-1 overflow-hidden bg-maestro-bg">
              <MultiProjectView
                ref={multiProjectRef}
                onSessionCountChange={handleSessionCountChange}
                eagleView={eagleView}
              />

              {/* Workflow editor — an overlay, never a replacement: unmounting
                  MultiProjectView would tear down every live terminal. */}
              {workflowsViewOpen && (
                <Suspense
                  fallback={
                    /* z-50 like the editor itself: the zoomed eagle pane is
                       z-40, and the fallback must cover it too. */
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-maestro-bg text-xs text-maestro-muted">
                      Loading…
                    </div>
                  }
                >
                  <WorkflowsView onClose={closeWorkflowsView} />
                </Suspense>
              )}
            </main>

            {/* Notes / Second Brain / Launch utility panel (optional right side) */}

            {utilityPanel && (
              <UtilityPanel
                panel={utilityPanel}
                width={rightPanelWidth}
                onResize={handleRightPanelResize}
                onClose={() => setUtilityPanel(null)}
                onNavigateToSession={handleAgentNavigate}
              />
            )}

            {/* Git graph panel (optional right side). Stays mounted when
                closed (width 0 + inert) so its state survives toggling. In
                eagle view it becomes a carousel: one project card at a time,
                switched via the EagleProjectSwitcher strip — the git stores
                are singletons, so exactly one panel is ever mounted. */}
            <GitGraphPanel
              open={gitPanelOpen}
              onClose={() => setGitPanelOpen(false)}
              repoPath={gitRepoPath ?? null}
              currentBranch={currentBranch ?? null}
              repositories={gitTargetTab?.repositories ?? []}
              workspaceType={gitTargetTab?.workspaceType ?? "single-repo"}
              onRepoChange={(path) => gitTargetTab && setSelectedRepo(gitTargetTab.id, path)}
              activeTab={gitPanelTab}
              onActiveTabChange={setGitPanelTab}
              width={rightPanelWidth}
              onResize={handleRightPanelResize}
              eagleProjects={eagleView ? eagleProjects : undefined}
              eagleIndex={clampedEagleGitIndex}
              onEaglePrev={handleEagleGitPrev}
              onEagleNext={handleEagleGitNext}
            />
          </div>

          {/* Bottom action bar */}
          <div className="bg-maestro-bg">
            <BottomBar
              slotCount={activeTabSlotCount}
              launchedCount={activeTabLaunchedCount}
              onLaunchAll={() => {
                if (!activeTabSessionsLaunched && activeTab) {
                  // First enter grid view, then launch
                  handleEnterGridView();
                }
                multiProjectRef.current?.launchAllInActiveProject();
              }}
              onNavigateToSession={(tabId, sessionId) => {
                multiProjectRef.current?.navigateToSession(tabId, sessionId);
              }}
            />
          </div>
        </div>
      </div>

      {/* Eagle view Cmd/Ctrl+T: pick which project gets the new terminal */}
      {eagleAddPickerOpen && (
        <EagleProjectPickerModal
          projects={eagleProjects}
          onPick={(tabId) => {
            setEagleAddPickerOpen(false);
            handleAddSessionToProject(tabId);
          }}
          onClose={() => setEagleAddPickerOpen(false)}
        />
      )}

      {/* FDA Dialog for macOS TCC-protected paths */}
      {showFDADialog && (
        <FDADialog
          path={fdaPath}
          onDismiss={dismissFDADialog}
          onDismissPermanently={dismissFDADialogPermanently}
          onRetry={retryAfterFDAGrant}
        />
      )}

      <UpdateNotification />
      <AutoUpdateQuestion />
      <NotificationToasts />
      <ParticleEffectsLayer />
      <WorkJournalSettingsHost theme={theme} onToggleTheme={toggleTheme} />
      <WorkJournalBackgroundWork tabs={tabs} />
      <WorkJournalOptInDialog />
    </div>
  );
}

export default App;
