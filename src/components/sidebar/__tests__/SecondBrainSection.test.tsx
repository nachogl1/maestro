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

// The absorbed AuditSection subscribes to samurai-audit-event on mount.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

import { SecondBrainSection } from "../SecondBrainSection";
import { SAMURAI_IN_USE_ERROR_PREFIX, type SamuraiFileEntry } from "@/lib/samurai";
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

function fileEntry(overrides: Partial<SamuraiFileEntry> = {}): SamuraiFileEntry {
  return {
    kind: "HANDOFF",
    path: "C:\\data\\worktrees\\maestro\\samurai-38\\.maestro\\handoffs\\38-gen2.md",
    size_bytes: 4096,
    modified_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    project_path: "C:\\git\\maestro",
    epic: "#38",
    in_use: false,
    fire_at: null,
    ...overrides,
  };
}

/**
 * Routes the global invoke mock. `deleteRejections` maps a path to the error
 * its non-forced `samurai_file_delete` calls reject with (the in-use
 * refusal); forced calls always succeed.
 */
function mockInvoke(files: SamuraiFileEntry[], deleteRejections: Record<string, string> = {}) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "samurai_files_list":
        return files;
      case "samurai_audit_read":
        return { events: [], file_size_bytes: 0 };
      case "samurai_file_delete": {
        const { path, force } = args as { path: string; force: boolean };
        if (!force && deleteRejections[path]) throw deleteRejections[path];
        return undefined;
      }
      case "samurai_cleanup_epic":
        return {
          epic: "#38",
          branch: "samurai/38",
          timer_cancelled: false,
          config_archived: true,
          worktree_removed: true,
          worktree_path: "C:\\data\\worktrees\\maestro\\samurai-38",
          branch_deleted: true,
        };
      default:
        return undefined;
    }
  });
}

describe("SecondBrainSection (issue #66)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
  });

  it("renders both sections: the audit stream on top and the files below", async () => {
    mockInvoke([fileEntry()]);
    render(<SecondBrainSection />);

    expect(screen.getByText("Samurai Audit")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();
  });

  it("groups files by kind with sizes, ages and human-readable timers", async () => {
    mockInvoke([
      fileEntry(), // HANDOFF, 4 KB, 2h old
      fileEntry({
        kind: "RUN_CONFIG",
        path: "C:\\appdata\\samurai\\runs\\maestro-38.json",
        size_bytes: 2.5 * 1024 * 1024,
        in_use: true,
      }),
      fileEntry({
        kind: "TIMER",
        path: "C:\\appdata\\samurai\\schedule.json",
        fire_at: new Date(Date.now() + 3600_000).toISOString(),
        in_use: true,
      }),
    ]);
    render(<SecondBrainSection />);

    // Group headers, in kind order; JOURNAL/HARVEST stay hidden (no files),
    // AUDIT_LOG shows its empty hint instead.
    expect(await screen.findByText("Handoffs")).toBeInTheDocument();
    expect(screen.getByText("Run configs")).toBeInTheDocument();
    expect(screen.getByText("Timers")).toBeInTheDocument();
    expect(screen.getByText("Audit logs")).toBeInTheDocument();
    expect(screen.queryByText("Journal")).toBeNull();
    expect(screen.queryByText("Harvest reports")).toBeNull();
    expect(screen.getByText("None.")).toBeInTheDocument();

    // Row details: basename or epic, size + age, timer fire time, in-use.
    expect(screen.getByText("38-gen2.md")).toBeInTheDocument();
    expect(screen.getByText("4 KB · 2h ago")).toBeInTheDocument();
    expect(screen.getByText("2.5 MB · 2h ago")).toBeInTheDocument();
    expect(screen.getByText(/^resumes at /)).toBeInTheDocument();
    expect(screen.getAllByText("IN USE")).toHaveLength(2);
  });

  it("shows the Journal and Harvest reports groups once files exist", async () => {
    mockInvoke([
      fileEntry({ kind: "JOURNAL", path: "C:\\appdata\\samurai\\journal.jsonl", epic: null }),
      fileEntry({
        kind: "HARVEST_REPORT",
        path: "C:\\appdata\\samurai\\harvest-2026-08.md",
        epic: null,
      }),
    ]);
    render(<SecondBrainSection />);

    expect(await screen.findByText("Journal")).toBeInTheDocument();
    expect(screen.getByText("Harvest reports")).toBeInTheDocument();
  });

  it("deletes a file only after the user confirms", async () => {
    mockInvoke([fileEntry()]);
    askMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<SecondBrainSection />);
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();

    // First click: declined — nothing deleted.
    fireEvent.click(screen.getByRole("button", { name: "Delete 38-gen2.md" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_file_delete", expect.anything());

    // Second click: confirmed — deleted without force.
    fireEvent.click(screen.getByRole("button", { name: "Delete 38-gen2.md" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_file_delete", {
        path: fileEntry().path,
        force: false,
      }),
    );
    expect(await screen.findByText("Deleted 38-gen2.md.")).toBeInTheDocument();
  });

  it("routes an in-use refusal to the harder confirm before force-deleting", async () => {
    const entry = fileEntry({ in_use: true });
    mockInvoke([entry], {
      [entry.path]: `${SAMURAI_IN_USE_ERROR_PREFIX} referenced by an active run`,
    });
    // First ask: normal delete confirm. Second ask: the harder in-use confirm.
    askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    render(<SecondBrainSection />);
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete 38-gen2.md" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_file_delete", {
        path: entry.path,
        force: true,
      }),
    );
    expect(askMock).toHaveBeenCalledTimes(2);
    // The harder confirm names the danger explicitly and uses the error kind.
    expect(askMock.mock.calls[1][0]).toMatch(/ACTIVE run/);
    expect(askMock.mock.calls[1][1]).toMatchObject({
      title: "File In Use — Force Delete?",
      kind: "error",
    });
    expect(await screen.findByText("Force-deleted 38-gen2.md.")).toBeInTheDocument();
  });

  it("never force-deletes when the harder confirm is declined", async () => {
    const entry = fileEntry({ in_use: true });
    mockInvoke([entry], {
      [entry.path]: `${SAMURAI_IN_USE_ERROR_PREFIX} referenced by an active run`,
    });
    askMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    render(<SecondBrainSection />);
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete 38-gen2.md" }));
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_file_delete", {
      path: entry.path,
      force: true,
    });
  });

  it("offers clean-this-epic only on inactive run configs and confirms first", async () => {
    mockInvoke([
      // Archived config → cleanable.
      fileEntry({
        kind: "RUN_CONFIG",
        path: "C:\\appdata\\samurai\\runs\\maestro-38.json",
        epic: "#38",
        in_use: false,
      }),
      // Active config → no cleanup button.
      fileEntry({
        kind: "RUN_CONFIG",
        path: "C:\\appdata\\samurai\\runs\\maestro-40.json",
        epic: "#40",
        in_use: true,
      }),
    ]);
    askMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<SecondBrainSection />);
    expect(await screen.findByText("#38")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "Clean up epic #40" })).toBeNull();
    const cleanButton = screen.getByRole("button", { name: "Clean up epic #38" });

    // Declined — nothing cleaned.
    fireEvent.click(cleanButton);
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_cleanup_epic", expect.anything());

    // Confirmed — cleanup runs and its report is summarized.
    fireEvent.click(cleanButton);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_cleanup_epic", {
        projectPath: "C:\\git\\maestro",
        epic: "#38",
      }),
    );
    expect(
      await screen.findByText(
        "Cleaned up epic #38: removed worktree, branch samurai/38, run config.",
      ),
    ).toBeInTheDocument();
  });
});
