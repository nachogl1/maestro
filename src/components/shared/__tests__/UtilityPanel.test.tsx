import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

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

// AuditSection subscribes to the samurai-audit-event stream on mount.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { UtilityPanel } from "../UtilityPanel";
import { useNotesStore } from "@/stores/useNotesStore";
import { usePlanStore } from "@/stores/usePlanStore";
import { useStandupStore } from "@/stores/useStandupStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

const invokeMock = vi.mocked(invoke);

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

/** Routes the global invoke mock by command; unknown commands resolve empty. */
function mockInvoke() {
  invokeMock.mockImplementation(async (cmd: string) => {
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
      case "list_memory_projects":
        return [
          {
            dirName: "C--git-maestro",
            memoryPath: "C:\\Users\\me\\.claude\\projects\\C--git-maestro\\memory",
            fileCount: 2,
            isActive: true,
          },
        ];
      case "list_memory_files":
        return [
          {
            relPath: "MEMORY.md",
            path: "C:\\Users\\me\\.claude\\projects\\C--git-maestro\\memory\\MEMORY.md",
            description: null,
            memType: null,
            isIndex: true,
            sizeBytes: 100,
            modified: null,
          },
          {
            relPath: "user_profile.md",
            path: "C:\\Users\\me\\.claude\\projects\\C--git-maestro\\memory\\user_profile.md",
            description: "Who the user is",
            memType: "user",
            isIndex: false,
            sizeBytes: 200,
            modified: null,
          },
        ];
      case "list_dev_processes":
        return [];
      case "list_docker_containers":
        return { available: false, containers: [] };
      case "samurai_audit_read":
        return {
          events: [
            {
              ts: "2026-08-06T12:00:00Z",
              epic: "#36",
              event: "SPAWN",
              generation: 2,
              session_id: 1,
              details: { kind: "registered" },
            },
          ],
          file_size_bytes: 128,
        };
      case "samurai_list_runs":
        return [];
      case "samurai_files_list":
        return [
          {
            kind: "HANDOFF",
            path: "C:\\data\\worktrees\\maestro\\samurai-38\\.maestro\\handoffs\\38-gen2.md",
            size_bytes: 4096,
            modified_at: "2026-08-06T12:00:00Z",
            project_path: "C:\\git\\maestro",
            epic: "#38",
            in_use: false,
            fire_at: null,
          },
        ];
      default:
        return undefined;
    }
  });
}

describe("UtilityPanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    // Notes live in a module-level zustand store — reset so tests don't leak.
    useNotesStore.setState({ notes: [], activeNoteId: null });
    usePlanStore.setState({ status: "idle", plan: null, error: null, concerns: "" });
    useStandupStore.setState({ reports: {}, scheduleEnabled: false, scheduleTime: "08:30" });
    // The processes poll skips when the window is unfocused; happy-dom is headless.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("renders the Memory panel: user CLAUDE.md plus per-project files", async () => {
    render(<UtilityPanel panel="memory" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(screen.getByText("User Memory")).toBeInTheDocument();
    expect(await screen.findByText("~/.claude/CLAUDE.md")).toBeInTheDocument();
    // Active project auto-expands with its memory files
    expect(await screen.findByText("C--git-maestro")).toBeInTheDocument();
    expect(await screen.findByText("MEMORY.md")).toBeInTheDocument();
    expect(screen.getByText("INDEX")).toBeInTheDocument();
    expect(screen.getByText("user_profile.md")).toBeInTheDocument();
    expect(screen.getByText("Who the user is")).toBeInTheDocument();
  });

  it("renders the Processes panel", async () => {
    render(<UtilityPanel panel="processes" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(
      screen.getByText("Dev processes on this machine, grouped by command."),
    ).toBeInTheDocument();
    expect(await screen.findByText("No watched processes running")).toBeInTheDocument();
  });

  it("renders the Notes panel with its empty state", async () => {
    render(<UtilityPanel panel="notes" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Notes")).toBeInTheDocument();
    // NotepadPanel is lazy-loaded (TipTap is heavy), so its body arrives a
    // microtask after the header; the panel itself still renders synchronously.
    expect(await screen.findByText("No notes yet.")).toBeInTheDocument();
  });

  it("renders note markdown formatted inside the editable surface itself", async () => {
    useNotesStore.setState({
      notes: [{ id: "n1", title: "Note", content: "# Hello", createdAt: 0, updatedAt: 0 }],
      activeNoteId: "n1",
    });
    render(<UtilityPanel panel="notes" width={320} onResize={() => {}} onClose={() => {}} />);

    // The markdown renders as a real heading INSIDE the contenteditable —
    // formatting happens where you type, not in a separate preview pane.
    const heading = await screen.findByRole("heading", { name: "Hello" });
    expect(heading.closest('[contenteditable="true"]')).not.toBeNull();

    // The old two-pane implementation is gone: no Preview toggle, no textarea.
    expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("renders the AI panel on the Report tab and switches to Plan", async () => {
    render(<UtilityPanel panel="ai" width={320} onResize={() => {}} onClose={() => {}} />);
    // Opening the panel always lands on Report (where Standup used to live).
    expect(screen.getByRole("tab", { name: "Report" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Daily report time")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("What's on your mind?")).toBeInTheDocument();
    // The plan has no schedule of its own; with the report schedule off it
    // says so rather than silently never running.
    expect(screen.getByText(/daily schedule is off/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Catalog" }));
    // Catalog is on-demand only: no schedule, just the scan button and the
    // empty state until the user runs one.
    expect(screen.getByRole("button", { name: /scan project/i })).toBeInTheDocument();
  });

  it("Plan tab subscribes to the open projects without an infinite render loop", () => {
    // Regression guard: a selector returning a freshly mapped array re-renders
    // forever under zustand v5 (React logs "getSnapshot should be cached" and
    // then throws "Maximum update depth exceeded"). useShallow is what stops it.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<UtilityPanel panel="ai" width={320} onResize={() => {}} onClose={() => {}} />);
      fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
      expect(screen.getByRole("button", { name: /generate plan/i })).toBeEnabled();
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain("getSnapshot should be cached");
      expect(logged).not.toContain("Maximum update depth");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("renders the Second Brain panel with the audit stream and the files section", async () => {
    render(<UtilityPanel panel="secondbrain" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Second Brain")).toBeInTheDocument();
    // Audit on top: the absorbed AuditSection, behavior unchanged.
    expect(screen.getByText("Samurai Audit")).toBeInTheDocument();
    expect(await screen.findByText("SPAWN")).toBeInTheDocument();
    expect(screen.getByText("gen-2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear audit log" })).toBeInTheDocument();
    // Files below: the grouped inventory from samurai_files_list.
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();
    expect(screen.getByText("Handoffs")).toBeInTheDocument();
  });

  it("renders the Launch panel with the run form and active runs", async () => {
    render(<UtilityPanel panel="launch" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Launch Run")).toBeInTheDocument();
    expect(screen.getByLabelText("Epic ref")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run preflight" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(await screen.findByText("No active runs. Launch one above.")).toBeInTheDocument();
  });

  it("calls onClose from the header close button", () => {
    const onClose = vi.fn();
    render(<UtilityPanel panel="processes" width={320} onResize={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Processes panel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
