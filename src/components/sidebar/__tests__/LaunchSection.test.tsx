import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

import { LaunchSection } from "../LaunchSection";
import type { SamuraiPreflight, SamuraiRunConfig } from "@/lib/samurai";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);

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

function passPreflight(overrides: Partial<SamuraiPreflight> = {}): SamuraiPreflight {
  return {
    gh_auth: { ok: true, username: "nachogl1", error: null },
    windows_reported: true,
    ...overrides,
  };
}

function run(overrides: Partial<SamuraiRunConfig> = {}): SamuraiRunConfig {
  return {
    project_path: "C:\\git\\maestro",
    epic: "#38",
    repo_pin: "nachogl1/maestro",
    worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-38",
    model: null,
    thresholds: null,
    status: "ACTIVE",
    created_at: "2026-08-06T10:00:00Z",
    ...overrides,
  };
}

/** Routes the invoke mock by command; unknown commands resolve empty. */
function mockInvoke({
  preflight = passPreflight(),
  runs = [] as SamuraiRunConfig[],
} = {}) {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "samurai_preflight":
        return preflight;
      case "samurai_list_runs":
        return runs;
      case "samurai_launch_run":
        return {
          epic: "#38",
          branch: "samurai/38",
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-38",
          repo_pin: "nachogl1/maestro",
          stale_timer_cancelled: false,
        };
      case "samurai_cleanup_epic":
        return {
          epic: "#38",
          branch: "samurai/38",
          timer_cancelled: true,
          config_archived: true,
          worktree_removed: true,
          worktree_path: "C:\\data\\worktrees\\maestro-abc\\samurai-38",
          branch_deleted: true,
        };
      default:
        return undefined;
    }
  });
}

/** Calls of one command name, for argument assertions. */
function callsOf(cmd: string) {
  return invokeMock.mock.calls.filter(([name]) => name === cmd);
}

describe("LaunchSection (issue #63)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
  });

  it("renders the form with the active project and a disabled Launch button", async () => {
    render(<LaunchSection />);
    expect(screen.getByText("Launch Run")).toBeInTheDocument();
    expect(screen.getByText("C:\\git\\maestro")).toBeInTheDocument();
    expect(screen.getByLabelText("Epic ref")).toBeInTheDocument();
    expect(screen.getByLabelText("Model (optional)")).toBeInTheDocument();
    expect(
      screen.getByText("Issues are triaged/agent-ready — planned with Claude"),
    ).toBeInTheDocument();
    // No preflight yet → Launch stays disabled.
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(await screen.findByText("No active runs. Launch one above.")).toBeInTheDocument();
  });

  it("enables Launch only after epic + declaration + passing preflight", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epic ref"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Run preflight" }));
    // Pass rows render with the gh username; the declaration row passes too.
    expect(await screen.findByText("gh authenticated as nachogl1")).toBeInTheDocument();
    expect(screen.getByText("Allowance windows reported")).toBeInTheDocument();
    expect(screen.getByText("Issues declared triaged/agent-ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
      model: null,
      issuesTriaged: true,
      handoffContextPct: null,
    });
    expect(await screen.findByText(/Run launched: epic #38 on samurai\/38/)).toBeInTheDocument();
  });

  it("passes the per-run handoff % override to the launch (review F4)", async () => {
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epic ref"), { target: { value: "#38" } });
    fireEvent.change(screen.getByLabelText("Handoff context % (this run)"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run preflight" }));
    expect(await screen.findByText("gh authenticated as nachogl1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    await waitFor(() => expect(callsOf("samurai_launch_run")).toHaveLength(1));
    expect(callsOf("samurai_launch_run")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
      model: null,
      issuesTriaged: true,
      handoffContextPct: 30,
    });
    // The field clears with the rest of the form after a launch.
    await screen.findByText(/Run launched: epic #38/);
    expect(screen.getByLabelText("Handoff context % (this run)")).toHaveValue(null);
  });

  it("renders failing preflight rows and keeps Launch disabled", async () => {
    mockInvoke({
      preflight: {
        gh_auth: { ok: false, username: null, error: "gh is not authenticated" },
        windows_reported: false,
      },
    });
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epic ref"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run preflight" }));

    expect(await screen.findByText(/gh auth failed/)).toBeInTheDocument();
    expect(screen.getByText(/gh is not authenticated/)).toBeInTheDocument();
    expect(screen.getByText(/No governing allowance window/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  it("lists active runs and cleans one up after the ask() confirm", async () => {
    mockInvoke({ runs: [run()] });
    askMock.mockResolvedValue(true);
    render(<LaunchSection />);

    expect(await screen.findByText("#38")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clean up epic #38" }));

    await waitFor(() => expect(callsOf("samurai_cleanup_epic")).toHaveLength(1));
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(String(askMock.mock.calls[0][0])).toContain("cannot be undone");
    expect(callsOf("samurai_cleanup_epic")[0][1]).toEqual({
      projectPath: "C:\\git\\maestro",
      epic: "#38",
    });
    expect(
      await screen.findByText(/Cleaned up epic #38: removed worktree, branch samurai\/38/),
    ).toBeInTheDocument();
  });

  it("never cleans up when the confirm is declined", async () => {
    mockInvoke({ runs: [run()] });
    askMock.mockResolvedValue(false);
    render(<LaunchSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Clean up epic #38" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(callsOf("samurai_cleanup_epic")).toHaveLength(0);
  });

  it("shows a backend launch refusal as an error", async () => {
    mockInvoke();
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "samurai_preflight":
          return passPreflight();
        case "samurai_list_runs":
          return [];
        case "samurai_launch_run":
          throw "launch refused: declare the epic's issues triaged/agent-ready (planned with Claude) first";
        default:
          return undefined;
      }
    });
    render(<LaunchSection />);
    fireEvent.change(screen.getByLabelText("Epic ref"), { target: { value: "#38" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run preflight" }));
    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));

    expect(await screen.findByText(/launch refused: declare the epic's issues/)).toBeInTheDocument();
  });
});
