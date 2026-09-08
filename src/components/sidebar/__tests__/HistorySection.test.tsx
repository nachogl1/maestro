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

// useSessionStore binds Tauri event listeners at call time; nothing in these
// tests listens, but the import must not reach a real event bridge.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import type { ClaudeSessionInfo, ClaudeSessionListing } from "@/lib/terminal";
import type { WorktreeInfo } from "@/lib/worktreeManager";
import { useActivityStore } from "@/stores/useActivityStore";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { HistorySection } from "../HistorySection";

const invokeMock = vi.mocked(invoke);

const REPO = "C:\\git\\maestro";
const WORKTREE = "C:\\data\\worktrees\\maestro-abc\\maestro-78";

function buildTab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "tab-1",
    name: "maestro",
    projectPath: REPO,
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

function conversation(overrides: Partial<ClaudeSessionInfo> = {}): ClaudeSessionInfo {
  return {
    session_id: "conv-repo",
    summary: null,
    first_prompt: "Fix the login bug",
    last_prompt: null,
    last_activity: "Updated auth.ts and ran the suite",
    started_at: "2026-08-10T09:00:00Z",
    last_active: "2026-08-10T10:00:00Z",
    message_count: 42,
    git_branch: "main",
    cwd: REPO,
    cwd_exists: true,
    resumable: true,
    resume_blocked_reason: null,
    ...overrides,
  };
}

/** `total_found` follows the session count unless a test overrides it. */
function buildListing(
  sessions: ClaudeSessionInfo[],
  overrides: Partial<ClaudeSessionListing> = {},
): ClaudeSessionListing {
  return {
    sessions,
    total_found: sessions.length,
    truncated: false,
    unreadable: 0,
    ...overrides,
  };
}

function worktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: WORKTREE,
    head: "abc1234",
    branch: "maestro-78",
    is_bare: false,
    is_main_worktree: false,
    ...overrides,
  };
}

/** Routes the invoke mock by command; either call can be made to reject. */
function mockInvoke({
  worktrees = [] as WorktreeInfo[],
  listing = buildListing([]),
  worktreeError = null as string | null,
  listingError = null as string | null,
} = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "git_worktree_list":
        if (worktreeError) throw worktreeError;
        return worktrees;
      case "list_claude_sessions":
        if (listingError) throw listingError;
        return listing;
      default:
        return undefined;
    }
  });
}

function callsOf(cmd: string) {
  return invokeMock.mock.calls.filter(([name]) => name === cmd);
}

/** Opens the project collapsible and waits for the load to land. */
async function expandProject() {
  fireEvent.click(screen.getByRole("button", { name: "maestro" }));
  await waitFor(() => expect(callsOf("list_claude_sessions").length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
}

/**
 * The group container for one directory: the header's label span carries the
 * full path as its title, and the group root is its grandparent.
 */
function groupFor(path: string): HTMLElement {
  const root = screen.getByTitle(path).parentElement?.parentElement;
  if (!root) throw new Error(`No group container rendered for ${path}`);
  return root as HTMLElement;
}

const resumeRows = () => screen.queryAllByTitle(/Resume this conversation in/);

describe("HistorySection (issue #78)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    useSessionStore.setState({ sessions: [] });
    useActivityStore.setState({ sessions: {} });
    usePendingLaunchStore.setState({ pending: [] });
  });

  it("groups conversations by the checkout or worktree they ran in", async () => {
    mockInvoke({
      // The main worktree is the checkout under another entry — it must not
      // become a second group.
      worktrees: [worktree({ path: REPO, is_main_worktree: true, branch: "main" }), worktree()],
      listing: buildListing([
        conversation(),
        conversation({
          session_id: "conv-wt",
          first_prompt: "Rebuild the history rows",
          last_activity: "Opened the PR",
          cwd: WORKTREE,
          git_branch: "maestro-78",
          message_count: 7,
          last_active: "2026-08-11T08:00:00Z",
        }),
      ]),
    });
    render(<HistorySection />);
    await expandProject();

    // One call for the whole project, with the worktrees as extra scan roots —
    // Maestro keeps them outside the repo, where no path prefix reaches them.
    expect(callsOf("list_claude_sessions")).toHaveLength(1);
    expect(callsOf("list_claude_sessions")[0][1]).toEqual({
      projectPath: REPO,
      extraRoots: [REPO, WORKTREE],
    });

    const checkout = groupFor(REPO);
    const branch = groupFor(WORKTREE);
    // Checkout and worktree are distinguished, not just listed (scoped to the
    // group's own badge — the filter chips above the list say the same word).
    expect(within(checkout).getByText("CHECKOUT")).toBeInTheDocument();
    expect(within(branch).getByText("WORKTREE")).toBeInTheDocument();

    expect(within(checkout).getByText("Fix the login bug")).toBeInTheDocument();
    expect(within(checkout).queryByText("Rebuild the history rows")).not.toBeInTheDocument();

    expect(within(branch).getByText("Rebuild the history rows")).toBeInTheDocument();
    // Enough content to recognise the run: the closing summary and its length.
    expect(within(branch).getByText(/Opened the PR/)).toBeInTheDocument();
    expect(within(branch).getByText(/7 msgs/)).toBeInTheDocument();
    // Scoped to the row: this worktree's directory is named after its branch,
    // so the label also matches the group header.
    const worktreeRow = within(branch).getByTitle(`Resume this conversation in ${WORKTREE}`);
    expect(within(worktreeRow).getByText("maestro-78")).toBeInTheDocument();
    // Absolute time on hover, next to the relative label.
    expect(
      within(branch).getByTitle(new Date("2026-08-11T08:00:00Z").toLocaleString()),
    ).toBeInTheDocument();

    // The worktree launch action survives the merge of the two flat lists.
    fireEvent.click(screen.getByRole("button", { name: `Launch an agent in ${WORKTREE}` }));
    expect(usePendingLaunchStore.getState().pending[0]).toMatchObject({
      tabId: "tab-1",
      resumeSessionId: null,
      workingDirOverride: WORKTREE,
      branch: "maestro-78",
    });
  });

  it("disables the row when the conversation's directory is gone, with the reason", async () => {
    // Adapted after the samurai-epic-106 merge: issue #104 replaced the
    // resume-in-project-path fallback with a DISABLED row — `claude --resume`
    // only finds a session from its own directory, so retargeting the shell
    // could never actually resume the conversation.
    mockInvoke({
      listing: buildListing([
        conversation({
          session_id: "conv-gone",
          cwd: "C:\\git\\maestro\\gone-worktree",
          cwd_exists: false,
          resumable: false,
          resume_blocked_reason: "its directory no longer exists",
        }),
      ]),
    });
    render(<HistorySection />);
    await expandProject();

    // Visible on the row itself — a tooltip is not enough. (Scoped to the
    // group's own badge — the filter chips above the list say the same word.)
    expect(
      within(groupFor("C:\\git\\maestro\\gone-worktree")).getByText("GONE"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not resumable — its directory no longer exists/)).toBeInTheDocument();

    // And the launch never points a shell at the missing directory: the row
    // is disabled outright, so nothing is queued.
    const row = screen.getByTitle(/Not resumable — its directory no longer exists/);
    expect(row).toBeDisabled();
    fireEvent.click(row);
    expect(usePendingLaunchStore.getState().pending).toHaveLength(0);
  });

  it("says how many rows the display cap cut, and reveals them", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      conversation({
        session_id: `conv-${i}`,
        first_prompt: `Conversation ${i}`,
        last_active: `2026-08-1${i < 10 ? "0" : "1"}T0${i % 10}:00:00Z`,
      }),
    );
    mockInvoke({ listing: buildListing(many) });
    render(<HistorySection />);
    await expandProject();

    expect(resumeRows()).toHaveLength(10);
    const reveal = screen.getByRole("button", { name: /Showing 10 of 12 — show all/ });
    fireEvent.click(reveal);

    expect(resumeRows()).toHaveLength(12);
    expect(screen.getByRole("button", { name: /Showing all 12/ })).toBeInTheDocument();
  });

  it("counts live conversations and jumps to the terminal running one", async () => {
    useWorkspaceStore.setState({ tabs: [buildTab({ sessionIds: [7] })] });
    useSessionStore.setState({
      sessions: [
        {
          id: 7,
          mode: "Claude",
          branch: null,
          status: "Working",
          worktree_path: null,
          project_path: REPO,
        },
      ],
    });
    useActivityStore.setState({
      sessions: {
        7: {
          events: [],
          totalInputTokens: 0,
          totalOutputTokens: 0,
          filesModified: [],
          conversationUuids: ["conv-live"],
        },
      },
    });
    mockInvoke({
      listing: buildListing([
        conversation({ session_id: "conv-live", first_prompt: "Still running here" }),
        conversation({ session_id: "conv-done", first_prompt: "Finished earlier" }),
      ]),
    });
    const onNavigate = vi.fn();
    render(<HistorySection onNavigate={onNavigate} />);
    await expandProject();

    // Counted and reachable, not silently dropped.
    expect(screen.getByText("Running now — 1 not resumable")).toBeInTheDocument();
    expect(resumeRows()).toHaveLength(1);
    expect(screen.getByText("Finished earlier")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Open the live terminal for conversation conv-liv" }),
    );
    expect(onNavigate).toHaveBeenCalledWith("tab-1", 7);
  });

  it("states Claude's own cap, unreadable transcripts and the known limit", async () => {
    mockInvoke({
      listing: buildListing([conversation()], {
        total_found: 60,
        truncated: true,
        unreadable: 3,
      }),
    });
    render(<HistorySection />);
    await expandProject();

    expect(screen.getByText(/1 of 60 conversations were returned/)).toBeInTheDocument();
    expect(screen.getByText(/The other 59 are still on disk/)).toBeInTheDocument();
    expect(screen.getByText(/3 transcripts could not be read/)).toBeInTheDocument();
    // The out-of-scope case is stated in the UI rather than left looking broken.
    expect(screen.getByText(/deleted worktree that lived outside the repo/)).toBeInTheDocument();
  });

  it("renders an error state when the session list fails, not an empty list", async () => {
    mockInvoke({ listingError: "permission denied reading ~/.claude/projects" });
    render(<HistorySection />);
    await expandProject();

    expect(screen.getByText(/Conversations could not be listed/)).toBeInTheDocument();
    expect(screen.getByText(/permission denied/)).toBeInTheDocument();
    expect(screen.getByText(/This list is incomplete/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(callsOf("list_claude_sessions")).toHaveLength(2));
  });

  it("reports a failed worktree list too — fewer scan roots, not fewer worktrees", async () => {
    mockInvoke({ worktreeError: "not a git repository" });
    render(<HistorySection />);
    await expandProject();

    expect(screen.getByText(/Worktrees could not be listed/)).toBeInTheDocument();
    // The session scan still runs, just without the extra roots.
    expect(callsOf("list_claude_sessions")[0][1]).toEqual({
      projectPath: REPO,
      extraRoots: [],
    });
  });

  it("filters conversations by the search query, case-insensitively", async () => {
    mockInvoke({
      listing: buildListing([
        conversation({ session_id: "conv-login", first_prompt: "Fix the login bug" }),
        conversation({ session_id: "conv-payment", first_prompt: "Refactor the payment service" }),
      ]),
    });
    render(<HistorySection />);
    await expandProject();

    expect(resumeRows()).toHaveLength(2);

    fireEvent.change(screen.getByPlaceholderText("Search conversations..."), {
      target: { value: "LOGIN" },
    });

    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
    expect(screen.queryByText("Refactor the payment service")).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 2 conversations/)).toBeInTheDocument();

    // The clear ("X") button empties the box and restores every row.
    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(resumeRows()).toHaveLength(2);
  });

  it("filters groups by kind via the toggle chips", async () => {
    mockInvoke({
      worktrees: [worktree({ path: REPO, is_main_worktree: true, branch: "main" }), worktree()],
      listing: buildListing([
        conversation(),
        conversation({
          session_id: "conv-wt",
          first_prompt: "Rebuild the history rows",
          cwd: WORKTREE,
          git_branch: "maestro-78",
        }),
      ]),
    });
    render(<HistorySection />);
    await expandProject();

    // The chip and the group's own badge both say "WORKTREE" to start.
    expect(screen.getAllByText("WORKTREE")).toHaveLength(2);
    expect(screen.getByText("Rebuild the history rows")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "WORKTREE" }));

    // The worktree group disappears entirely — only the (now inactive) chip remains.
    expect(screen.getAllByText("WORKTREE")).toHaveLength(1);
    expect(screen.queryByText("Rebuild the history rows")).not.toBeInTheDocument();
    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
  });

  it("lifts the display cap while a search query is active", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      conversation({
        session_id: `conv-${i}`,
        first_prompt: `Conversation ${i}`,
        last_active: `2026-08-1${i < 10 ? "0" : "1"}T0${i % 10}:00:00Z`,
      }),
    );
    mockInvoke({ listing: buildListing(many) });
    render(<HistorySection />);
    await expandProject();

    expect(resumeRows()).toHaveLength(10);

    fireEvent.change(screen.getByPlaceholderText("Search conversations..."), {
      target: { value: "Conversation" },
    });

    // All 12 match — a search that hides its own matches behind the cap is useless.
    expect(resumeRows()).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /show all/ })).not.toBeInTheDocument();
  });

  it("shows an empty state with a one-click clear when filters hide everything", async () => {
    mockInvoke({
      listing: buildListing([conversation({ first_prompt: "Fix the login bug" })]),
    });
    render(<HistorySection />);
    await expandProject();

    fireEvent.change(screen.getByPlaceholderText("Search conversations..."), {
      target: { value: "no such conversation anywhere" },
    });

    expect(screen.getByText("No conversations match your filters.")).toBeInTheDocument();
    expect(screen.queryByText("Fix the login bug")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
    expect(screen.queryByText("No conversations match your filters.")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search conversations...")).toHaveValue("");
  });
});
