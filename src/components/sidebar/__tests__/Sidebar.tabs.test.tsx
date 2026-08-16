import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted zustand stores hydrate through the Tauri store plugin at
// import time; happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

// useTerminalSettingsStore subscribes to a Tauri event at module scope.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { type ComponentProps, useState } from "react";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import {
  loadSavedSidebarTab,
  Sidebar,
  type SidebarTabId,
  saveSidebarTab,
  sidebarTabShortcutTransition,
} from "../Sidebar";

const invokeMock = vi.mocked(invoke);

/**
 * The active tab is lifted to App (so Alt+1-4 shortcuts can drive it); this
 * harness recreates App's side of the contract: state + persistence.
 */
function ControlledSidebar(
  props: Omit<ComponentProps<typeof Sidebar>, "activeTab" | "onSelectTab">,
) {
  const [tab, setTab] = useState<SidebarTabId>(loadSavedSidebarTab);
  return (
    <Sidebar
      {...props}
      activeTab={tab}
      onSelectTab={(t) => {
        setTab(t);
        saveSidebarTab(t);
      }}
    />
  );
}

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: "C:\\git\\maestro",
    active: true,
    sessionIds: [],
    sessionsLaunched: false,
    workspaceType: "single-repo",
    repositories: [],
    selectedRepoPath: null,
    worktreeBasePath: null,
    ...overrides,
  };
}

/** The conversation in the mock ran inside the feature worktree, not the repo. */
const WORKTREE_PATH = "C:\\worktrees\\feat-login";

/** Routes the global invoke mock by command; unknown commands resolve empty. */
function mockInvoke() {
  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "list_context_docs":
        return [
          {
            tier: "user",
            kind: "claude",
            label: "CLAUDE.md",
            path: "C:\\Users\\me\\.claude\\CLAUDE.md",
            exists: true,
          },
        ];
      case "git_user_config":
        return { name: "Test User", email: "test@example.com" };
      case "git_list_remotes":
        return [];
      case "get_default_worktree_base_dir":
        return "C:\\worktrees";
      // Infra tab reads — stores write these results straight into arrays,
      // so they must resolve to the right shapes, not undefined.
      case "get_mcp_status":
        return { servers: [], connectors: [] };
      case "get_custom_mcp_servers":
      case "get_project_mcp_servers":
      case "refresh_project_mcp_servers":
      case "get_marketplace_sources":
      case "get_available_plugins":
      case "get_installed_plugins":
        return [];
      case "get_project_plugins":
      case "refresh_project_plugins":
        return { skills: [], plugins: [] };
      // History tab reads. Claude files transcripts per working directory, and
      // Maestro keeps worktrees outside the repo — so this conversation only
      // shows up if the worktree was passed as an extra scan root.
      case "list_claude_sessions": {
        const roots = (args?.extraRoots as string[] | undefined) ?? [];
        if (!roots.includes(WORKTREE_PATH)) {
          return { sessions: [], total_found: 0, truncated: false, unreadable: 0 };
        }
        return {
          sessions: [
            {
              session_id: "11111111-2222-3333-4444-555555555555",
              summary: null,
              first_prompt: "Fix the login bug",
              last_prompt: "Fix the login bug",
              last_activity: "Opened the PR",
              started_at: "2026-07-29T08:00:00Z",
              last_active: "2026-07-29T09:00:00Z",
              message_count: 42,
              git_branch: "feat/login",
              cwd: WORKTREE_PATH,
              cwd_exists: true,
              resumable: true,
              resume_blocked_reason: null,
            },
          ],
          total_found: 1,
          truncated: false,
          unreadable: 0,
        };
      }
      case "git_worktree_list":
        return [
          {
            path: "C:\\git\\maestro",
            head: "abc123",
            branch: "main",
            is_bare: false,
            is_main_worktree: true,
          },
          {
            path: WORKTREE_PATH,
            head: "def456",
            branch: "feat/login",
            is_bare: false,
            is_main_worktree: false,
          },
        ];
      default:
        return undefined;
    }
  });
}

describe("Sidebar tab bar", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    mockInvoke();
    localStorage.clear();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    useSessionStore.setState({ sessions: [], samuraiSchedule: [] });
  });

  it("renders the four tabs with General active by default", () => {
    render(<ControlledSidebar />);
    for (const label of ["General", "History", "Infra", "Settings"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // Processes and Memory moved to the right-side utility panel
    expect(screen.queryByRole("button", { name: "Processes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Memory" })).not.toBeInTheDocument();
    // General tab content
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Git Repository")).toBeInTheDocument();
    // Content from other tabs is not mounted
    expect(screen.queryByText("MCP Servers")).not.toBeInTheDocument();
  });

  // A parked project keeps its Agents row (the row carries the park chip),
  // but a scheduled-launch timer (issue #129) is a run that does not exist
  // yet: keeping the row alive for one leaves an empty project heading with
  // no chip under it.
  it("does not keep an Agents row alive for a scheduled launch", () => {
    useSessionStore.setState({
      sessions: [],
      samuraiSchedule: [
        {
          project_path: "C:\\git\\maestro",
          epic: "#42",
          fire_at: "2099-01-01T09:00:00Z",
          reason: "scheduled_launch",
        },
      ],
    });
    render(<ControlledSidebar />);

    expect(screen.getByText("No running agents")).toBeInTheDocument();
    expect(screen.queryByText("maestro")).not.toBeInTheDocument();
  });

  it("keeps the Agents row alive for a real park", () => {
    useSessionStore.setState({
      sessions: [],
      samuraiSchedule: [
        {
          project_path: "C:\\git\\maestro",
          epic: "#42",
          fire_at: "2099-01-01T09:00:00Z",
          reason: "park",
        },
      ],
    });
    render(<ControlledSidebar />);

    expect(screen.queryByText("No running agents")).not.toBeInTheDocument();
    expect(screen.getByText(/^parked/)).toBeInTheDocument();
  });

  it("switches to Infra (MCP + skills + project context)", () => {
    render(<ControlledSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Infra" }));
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("Plugins & Skills")).toBeInTheDocument();
    expect(screen.getByText("Project Context")).toBeInTheDocument();
    expect(screen.queryByText("Agents")).not.toBeInTheDocument();
  });

  it("switches to Settings and persists the chosen tab", async () => {
    render(<ControlledSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Terminal Settings")).toBeInTheDocument();
    await waitFor(() => {
      expect(localStorage.getItem("maestro-sidebar-tab")).toBe("settings");
    });
  });

  it("falls back to General when a removed tab id was persisted", () => {
    localStorage.setItem("maestro-sidebar-tab", "memory");
    render(<ControlledSidebar />);
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("History tab lists worktree conversations and resumes in their own directory", async () => {
    usePendingLaunchStore.setState({ pending: [] });
    const onHistoryLaunch = vi.fn();
    render(<ControlledSidebar onHistoryLaunch={onHistoryLaunch} />);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    // Expand the project's collapsible
    fireEvent.click(screen.getByRole("button", { name: /maestro/ }));

    const conversation = await screen.findByText("Fix the login bug");
    fireEvent.click(conversation);

    // `claude --resume` only finds the session from the directory it ran in,
    // so the launch must target the recorded cwd — never a derived worktree.
    expect(usePendingLaunchStore.getState().pending[0]).toMatchObject({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: "11111111-2222-3333-4444-555555555555",
      workingDirOverride: WORKTREE_PATH,
      branch: "feat/login",
    });
    // The project grid is set to mount, and App is asked to reveal it
    expect(useWorkspaceStore.getState().tabs[0].sessionsLaunched).toBe(true);
    expect(onHistoryLaunch).toHaveBeenCalledWith("tab-1");
  });

  it("History tab scans the repo and every worktree for conversations", async () => {
    render(<ControlledSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: /maestro/ }));

    await screen.findByText("Fix the login bug");
    // ONE call for the whole project (issue #78): the backend derives the
    // repo's subdirectories itself, and the worktrees ride along as extra
    // roots because Maestro keeps them outside the repo.
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "list_claude_sessions");
    expect(calls).toHaveLength(1);
    const args = calls[0][1] as { projectPath: string; extraRoots: string[] };
    expect(args.projectPath).toBe("C:\\git\\maestro");
    expect(args.extraRoots).toContain(WORKTREE_PATH);
  });

  it("History tab marks a conversation whose directory is gone as not resumable", async () => {
    usePendingLaunchStore.setState({ pending: [] });
    // A deleted worktree: the backend still reports the directory it recorded
    // (so the UI can name it) but flags it as gone and non-resumable — the
    // launch must not be pointed there or the shell cannot spawn, and
    // `claude --resume` only works from the transcript's own directory.
    // Override only the History reads — other sections feed shared stores that
    // outlive the test, so they must keep their well-formed shapes.
    const base = invokeMock.getMockImplementation();
    if (!base) throw new Error("expected invokeMock to have a base implementation");
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_claude_sessions") {
        return {
          sessions: [
            {
              session_id: "99999999-8888-7777-6666-555555555555",
              summary: null,
              first_prompt: "Work in a deleted worktree",
              last_prompt: "Work in a deleted worktree",
              last_activity: null,
              started_at: "2026-07-29T08:00:00Z",
              last_active: "2026-07-29T09:00:00Z",
              message_count: 7,
              git_branch: "feat/gone",
              cwd: "C:\\worktrees\\deleted",
              cwd_exists: false,
              resumable: false,
              resume_blocked_reason: "its directory no longer exists",
            },
          ],
          total_found: 1,
          truncated: false,
          unreadable: 0,
        };
      }
      if (cmd === "git_worktree_list") return [];
      return base(cmd, args);
    });

    render(<ControlledSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: /maestro/ }));

    const row = (await screen.findByText("Work in a deleted worktree")).closest("button");
    expect(row).not.toBeNull();
    // The marker and its reason are visible on the row, not just a tooltip.
    expect(screen.getByText(/Not resumable — its directory no longer exists/)).toBeInTheDocument();
    // Where it ran is still shown: the group the row sits under is headed by
    // the recorded cwd's folder name, badged GONE.
    expect(screen.getByText("deleted")).toBeInTheDocument();
    expect(screen.getByText("GONE")).toBeInTheDocument();

    // Resume is disabled: clicking must not queue a launch.
    expect(row).toBeDisabled();
    fireEvent.click(row as HTMLButtonElement);
    expect(usePendingLaunchStore.getState().pending).toHaveLength(0);
  });

  it("History tab shows the summary as title, plus branch and folder, on resumable rows", async () => {
    usePendingLaunchStore.setState({ pending: [] });
    const base = invokeMock.getMockImplementation();
    if (!base) throw new Error("expected invokeMock to have a base implementation");
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_claude_sessions") {
        return {
          sessions: [
            {
              session_id: "11111111-2222-3333-4444-555555555555",
              summary: "Login flow rework",
              first_prompt: "Fix the login bug",
              last_prompt: "now fix the flaky login test",
              last_activity: null,
              started_at: "2026-07-29T08:00:00Z",
              last_active: "2026-07-29T09:00:00Z",
              message_count: 12,
              git_branch: "feat/login",
              cwd: WORKTREE_PATH,
              cwd_exists: true,
              resumable: true,
              resume_blocked_reason: null,
            },
          ],
          total_found: 1,
          truncated: false,
          unreadable: 0,
        };
      }
      return base(cmd, args);
    });

    render(<ControlledSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: /maestro/ }));

    // Identity: Claude's title leads, the first prompt stays visible below it.
    const title = await screen.findByText("Login flow rework");
    const row = title.closest("button") as HTMLButtonElement;
    expect(within(row).getByText("Fix the login bug")).toBeInTheDocument();
    // Where it ran: the branch rides the row; the cwd's folder name heads the
    // group the row sits under (the #78 grouped layout carries the directory).
    expect(within(row).getByText("feat/login")).toBeInTheDocument();
    expect(screen.getByText("feat-login")).toBeInTheDocument();
    // Where resume opens is spelled out on the row.
    expect(row).toHaveAttribute("title", `Resume this conversation in ${WORKTREE_PATH}`);
    expect(row).toBeEnabled();
  });

  it("History tab launches an agent into a surviving worktree", async () => {
    usePendingLaunchStore.setState({ pending: [] });
    render(<ControlledSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: /maestro/ }));

    // Main worktree is filtered out; only the feature worktree is listed
    const worktreeRow = await screen.findByTitle("Launch an agent in C:\\worktrees\\feat-login");
    fireEvent.click(worktreeRow);

    expect(usePendingLaunchStore.getState().pending[0]).toMatchObject({
      tabId: "tab-1",
      resumeSessionId: null,
      workingDirOverride: "C:\\worktrees\\feat-login",
      branch: "feat/login",
    });
  });

  it("clicking a terminal row in Agents navigates to it", () => {
    useWorkspaceStore.setState({
      tabs: [buildTab({ sessionIds: [1], sessionsLaunched: true })],
    });
    // project_path must match the tab's projectPath or sessionsForTab drops the row.
    useSessionStore.setState({
      sessions: [
        {
          id: 1,
          mode: "Claude",
          name: "My agent",
          branch: null,
          status: "Working",
          worktree_path: null,
          project_path: "C:\\git\\maestro",
        },
      ],
    });
    const onNavigate = vi.fn();
    render(<ControlledSidebar onAgentNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("My agent"));
    expect(onNavigate).toHaveBeenCalledWith("tab-1", 1);
  });
});

describe("sidebarTabShortcutTransition (Alt+1-4 toggle semantics)", () => {
  it("opens the sidebar on the requested tab when closed", () => {
    expect(sidebarTabShortcutTransition(false, "general", 2)).toEqual({
      open: true,
      tab: "history",
    });
  });

  it("closes the sidebar when the active tab's shortcut repeats", () => {
    expect(sidebarTabShortcutTransition(true, "infra", 3)).toEqual({
      open: false,
      tab: "infra",
    });
  });

  it("switches tabs when the sidebar is open on another tab", () => {
    expect(sidebarTabShortcutTransition(true, "general", 4)).toEqual({
      open: true,
      tab: "settings",
    });
  });

  it("returns null for an index that names no tab", () => {
    expect(sidebarTabShortcutTransition(true, "general", 5)).toBeNull();
    expect(sidebarTabShortcutTransition(false, "general", 0)).toBeNull();
  });
});
