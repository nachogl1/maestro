import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ClaudeSessionInfo, listClaudeSessions } from "@/lib/terminal";
import { PreLaunchCard, type SessionSlot } from "../PreLaunchCard";

vi.mock("@/lib/terminal", () => ({
  listClaudeSessions: vi
    .fn()
    .mockResolvedValue({ sessions: [], total_found: 0, truncated: false, unreadable: 0 }),
  deleteClaudeSession: vi.fn().mockResolvedValue(undefined),
}));

describe("PreLaunchCard branch creation", () => {
  const makeSlot = (overrides?: Partial<SessionSlot>): SessionSlot => ({
    id: "slot-1",
    mode: "Claude",
    branch: null,
    sessionId: null,
    worktreePath: null,
    worktreeWarning: null,
    enabledMcpServers: [],
    enabledSkills: [],
    enabledPlugins: [],
    ...overrides,
  });

  const defaultProps = {
    slot: makeSlot(),
    projectPath: "/tmp/test-repo",
    branches: [
      { name: "main", isRemote: false, isCurrent: true, hasWorktree: false },
      { name: "develop", isRemote: false, isCurrent: false, hasWorktree: false },
    ],
    isLoadingBranches: false,
    isGitRepo: true,
    mcpServers: [],
    skills: [],
    plugins: [],
    onModeChange: vi.fn(),
    onBranchChange: vi.fn(),
    onMcpToggle: vi.fn(),
    onSkillToggle: vi.fn(),
    onPluginToggle: vi.fn(),
    onMcpSelectAll: vi.fn(),
    onMcpUnselectAll: vi.fn(),
    onPluginsSelectAll: vi.fn(),
    onPluginsUnselectAll: vi.fn(),
    onLaunch: vi.fn(),
    onRemove: vi.fn(),
    onResumeSessionChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Helper to open the branch dropdown */
  function openBranchDropdown() {
    // The branch selector button contains the display branch name ("main")
    // and a GitBranch icon. Find and click it.
    const branchButton = screen.getByText("main").closest("button");
    if (branchButton) fireEvent.click(branchButton);
  }

  it("shows 'Create New Branch' button in branch dropdown when onCreateBranch is provided", () => {
    const onCreateBranch = vi.fn().mockResolvedValue(undefined);
    render(<PreLaunchCard {...defaultProps} onCreateBranch={onCreateBranch} />);

    openBranchDropdown();

    expect(screen.getByText("Create New Branch")).toBeInTheDocument();
  });

  it("does NOT show 'Create New Branch' when onCreateBranch prop is omitted", () => {
    render(<PreLaunchCard {...defaultProps} />);

    openBranchDropdown();

    expect(screen.queryByText("Create New Branch")).not.toBeInTheDocument();
  });

  it("clicking 'Create New Branch' shows input with 'Create' and 'Create & Select' buttons", () => {
    const onCreateBranch = vi.fn().mockResolvedValue(undefined);
    render(<PreLaunchCard {...defaultProps} onCreateBranch={onCreateBranch} />);

    openBranchDropdown();
    fireEvent.click(screen.getByText("Create New Branch"));

    expect(screen.getByPlaceholderText("feature/my-branch")).toBeInTheDocument();
    expect(screen.getByTitle("Create branch without selecting")).toBeInTheDocument();
    expect(screen.getByTitle("Create branch and select it")).toBeInTheDocument();
  });

  it("'Create' calls onCreateBranch(name, false) and does NOT call onBranchChange", async () => {
    const onCreateBranch = vi.fn().mockResolvedValue(undefined);
    render(<PreLaunchCard {...defaultProps} onCreateBranch={onCreateBranch} />);

    openBranchDropdown();
    fireEvent.click(screen.getByText("Create New Branch"));
    fireEvent.change(screen.getByPlaceholderText("feature/my-branch"), {
      target: { value: "feature/test" },
    });
    fireEvent.click(screen.getByTitle("Create branch without selecting"));

    await waitFor(() => {
      expect(onCreateBranch).toHaveBeenCalledWith("feature/test", false);
    });
    // onBranchChange should NOT be called by the "Create" button
    expect(defaultProps.onBranchChange).not.toHaveBeenCalled();
  });

  it("'Create & Select' calls onCreateBranch(name, false) and then onBranchChange(name)", async () => {
    const onCreateBranch = vi.fn().mockResolvedValue(undefined);
    render(<PreLaunchCard {...defaultProps} onCreateBranch={onCreateBranch} />);

    openBranchDropdown();
    fireEvent.click(screen.getByText("Create New Branch"));
    fireEvent.change(screen.getByPlaceholderText("feature/my-branch"), {
      target: { value: "feature/select" },
    });
    fireEvent.click(screen.getByTitle("Create branch and select it"));

    await waitFor(() => {
      expect(onCreateBranch).toHaveBeenCalledWith("feature/select", false);
    });
    await waitFor(() => {
      expect(defaultProps.onBranchChange).toHaveBeenCalledWith("feature/select");
    });
  });

  it("invalid branch name shows validation error", async () => {
    const onCreateBranch = vi.fn().mockResolvedValue(undefined);
    render(<PreLaunchCard {...defaultProps} onCreateBranch={onCreateBranch} />);

    openBranchDropdown();
    fireEvent.click(screen.getByText("Create New Branch"));
    fireEvent.change(screen.getByPlaceholderText("feature/my-branch"), {
      target: { value: "bad name with spaces" },
    });
    fireEvent.click(screen.getByTitle("Create branch and select it"));

    await waitFor(() => {
      expect(
        screen.getByText("Invalid name. Use letters, numbers, dots, dashes, slashes."),
      ).toBeInTheDocument();
    });
    expect(onCreateBranch).not.toHaveBeenCalled();
  });

  it("Escape closes the creation input", () => {
    const onCreateBranch = vi.fn().mockResolvedValue(undefined);
    render(<PreLaunchCard {...defaultProps} onCreateBranch={onCreateBranch} />);

    openBranchDropdown();
    fireEvent.click(screen.getByText("Create New Branch"));

    const input = screen.getByPlaceholderText("feature/my-branch");
    expect(input).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByPlaceholderText("feature/my-branch")).not.toBeInTheDocument();
    expect(screen.getByText("Create New Branch")).toBeInTheDocument();
  });
});

describe("PreLaunchCard AI Mode Selection", () => {
  const makeSlot = (overrides?: Partial<SessionSlot>): SessionSlot => ({
    id: "slot-1",
    mode: "Claude",
    branch: null,
    sessionId: null,
    worktreePath: null,
    worktreeWarning: null,
    enabledMcpServers: [],
    enabledSkills: [],
    enabledPlugins: [],
    ...overrides,
  });

  const defaultProps = {
    slot: makeSlot(),
    projectPath: "/tmp/test-repo",
    branches: [
      { name: "main", isRemote: false, isCurrent: true, hasWorktree: false },
      { name: "develop", isRemote: false, isCurrent: false, hasWorktree: false },
    ],
    isLoadingBranches: false,
    isGitRepo: true,
    mcpServers: [],
    skills: [],
    plugins: [],
    onModeChange: vi.fn(),
    onBranchChange: vi.fn(),
    onMcpToggle: vi.fn(),
    onSkillToggle: vi.fn(),
    onPluginToggle: vi.fn(),
    onMcpSelectAll: vi.fn(),
    onMcpUnselectAll: vi.fn(),
    onPluginsSelectAll: vi.fn(),
    onPluginsUnselectAll: vi.fn(),
    onLaunch: vi.fn(),
    onRemove: vi.fn(),
    onResumeSessionChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Helper to open the AI mode dropdown */
  function openModeDropdown() {
    // Find the AI Mode section and click its dropdown button
    const aiModeLabel = screen.getByText("AI Mode");
    const dropdownContainer = aiModeLabel.parentElement;
    const modeButton = dropdownContainer?.querySelector("button");
    if (modeButton) fireEvent.click(modeButton);
  }

  it("displays all AI providers in the mode dropdown", () => {
    render(<PreLaunchCard {...defaultProps} />);

    openModeDropdown();

    // Verify all providers are shown in the dropdown
    // Use getAllByText since provider names may appear in both button and dropdown
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Gemini CLI").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Codex").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("OpenCode").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Terminal").length).toBeGreaterThanOrEqual(1);
  });

  it("calls onModeChange with correct mode when each provider is selected", () => {
    const providers = [
      { label: "Claude Code", mode: "Claude" },
      { label: "Gemini CLI", mode: "Gemini" },
      { label: "Codex", mode: "Codex" },
      { label: "OpenCode", mode: "OpenCode" },
      { label: "Terminal", mode: "Plain" },
    ];

    for (const { label, mode } of providers) {
      vi.clearAllMocks();

      // Render fresh for each provider test
      render(<PreLaunchCard {...defaultProps} />);

      openModeDropdown();

      // Click on the provider - use getAllByText and click the last one (in dropdown)
      const providerButtons = screen.getAllByText(label);
      // The last one should be in the dropdown
      const providerButton = providerButtons[providerButtons.length - 1];
      fireEvent.click(providerButton);

      // Verify onModeChange was called with the correct mode
      expect(defaultProps.onModeChange).toHaveBeenCalledWith(mode);
      expect(defaultProps.onModeChange).toHaveBeenCalledTimes(1);

      // Cleanup for next iteration
      cleanup();
    }
  });
});

describe("PreLaunchCard resume session search", () => {
  const makeSlot = (overrides?: Partial<SessionSlot>): SessionSlot => ({
    id: "slot-1",
    mode: "Claude",
    branch: null,
    sessionId: null,
    worktreePath: null,
    worktreeWarning: null,
    enabledMcpServers: [],
    enabledSkills: [],
    enabledPlugins: [],
    ...overrides,
  });

  const makeSession = (overrides?: Partial<ClaudeSessionInfo>): ClaudeSessionInfo => ({
    session_id: "session-1",
    summary: null,
    first_prompt: "Fix the login bug",
    last_prompt: null,
    last_activity: null,
    started_at: "2026-01-01T00:00:00Z",
    last_active: "2026-01-01T00:00:00Z",
    message_count: 3,
    git_branch: "main",
    cwd: "/tmp/test-repo",
    cwd_exists: true,
    resumable: true,
    resume_blocked_reason: null,
    ...overrides,
  });

  const defaultProps = {
    slot: makeSlot(),
    projectPath: "/tmp/test-repo",
    branches: [{ name: "main", isRemote: false, isCurrent: true, hasWorktree: false }],
    isLoadingBranches: false,
    isGitRepo: true,
    mcpServers: [],
    skills: [],
    plugins: [],
    onModeChange: vi.fn(),
    onBranchChange: vi.fn(),
    onMcpToggle: vi.fn(),
    onSkillToggle: vi.fn(),
    onPluginToggle: vi.fn(),
    onMcpSelectAll: vi.fn(),
    onMcpUnselectAll: vi.fn(),
    onPluginsSelectAll: vi.fn(),
    onPluginsUnselectAll: vi.fn(),
    onLaunch: vi.fn(),
    onRemove: vi.fn(),
    onResumeSessionChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides the search input when there are 4 or fewer sessions", async () => {
    const sessions = [1, 2, 3, 4].map((n) =>
      makeSession({ session_id: `session-${n}`, first_prompt: `Prompt ${n}` }),
    );
    vi.mocked(listClaudeSessions).mockResolvedValueOnce({
      sessions,
      total_found: sessions.length,
      truncated: false,
      unreadable: 0,
    });

    render(<PreLaunchCard {...defaultProps} />);

    await screen.findByText("Prompt 1");

    expect(screen.queryByPlaceholderText("Search sessions...")).not.toBeInTheDocument();
  });

  it("shows the search input and filters by first_prompt when there are more than 4 sessions", async () => {
    const sessions = [1, 2, 3, 4, 5].map((n) =>
      makeSession({
        session_id: `session-${n}`,
        first_prompt: n === 3 ? "Investigate flaky test" : `Prompt ${n}`,
        git_branch: `branch-${n}`,
      }),
    );
    vi.mocked(listClaudeSessions).mockResolvedValueOnce({
      sessions,
      total_found: sessions.length,
      truncated: false,
      unreadable: 0,
    });

    render(<PreLaunchCard {...defaultProps} />);

    await screen.findByText("Prompt 1");

    const input = screen.getByPlaceholderText("Search sessions...");
    fireEvent.change(input, { target: { value: "flaky" } });

    expect(screen.getByText("Investigate flaky test")).toBeInTheDocument();
    expect(screen.queryByText("Prompt 1")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 5")).toBeInTheDocument();
  });

  it("filters by git_branch", async () => {
    const sessions = [1, 2, 3, 4, 5].map((n) =>
      makeSession({
        session_id: `session-${n}`,
        first_prompt: `Prompt ${n}`,
        git_branch: n === 2 ? "feat/unicorn" : `branch-${n}`,
      }),
    );
    vi.mocked(listClaudeSessions).mockResolvedValueOnce({
      sessions,
      total_found: sessions.length,
      truncated: false,
      unreadable: 0,
    });

    render(<PreLaunchCard {...defaultProps} />);

    await screen.findByText("Prompt 1");

    const input = screen.getByPlaceholderText("Search sessions...");
    fireEvent.change(input, { target: { value: "unicorn" } });

    expect(screen.getByText("Prompt 2")).toBeInTheDocument();
    expect(screen.queryByText("Prompt 1")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 5")).toBeInTheDocument();
  });

  it("shows a 'No sessions match' empty state when the query matches nothing", async () => {
    const sessions = [1, 2, 3, 4, 5].map((n) =>
      makeSession({ session_id: `session-${n}`, first_prompt: `Prompt ${n}` }),
    );
    vi.mocked(listClaudeSessions).mockResolvedValueOnce({
      sessions,
      total_found: sessions.length,
      truncated: false,
      unreadable: 0,
    });

    render(<PreLaunchCard {...defaultProps} />);

    await screen.findByText("Prompt 1");

    const input = screen.getByPlaceholderText("Search sessions...");
    fireEvent.change(input, { target: { value: "nonexistent-query" } });

    expect(screen.getByText('No sessions match "nonexistent-query"')).toBeInTheDocument();
    expect(screen.queryByText("Prompt 1")).not.toBeInTheDocument();
  });

  it("clears the query via the clear button", async () => {
    const sessions = [1, 2, 3, 4, 5].map((n) =>
      makeSession({ session_id: `session-${n}`, first_prompt: `Prompt ${n}` }),
    );
    vi.mocked(listClaudeSessions).mockResolvedValueOnce({
      sessions,
      total_found: sessions.length,
      truncated: false,
      unreadable: 0,
    });

    render(<PreLaunchCard {...defaultProps} />);

    await screen.findByText("Prompt 1");

    const input = screen.getByPlaceholderText("Search sessions...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Prompt 2" } });
    expect(screen.queryByText("Prompt 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Clear search"));

    expect(input.value).toBe("");
    expect(screen.getByText("Prompt 1")).toBeInTheDocument();
  });
});
