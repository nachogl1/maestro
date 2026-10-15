import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { useNotesStore } from "@/stores/useNotesStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { UtilityPanel } from "../UtilityPanel";

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
      case "samurai_harvest_list":
        return [];
      case "work_journal_ensure_pages":
        return {
          layout_version: 1,
          pages: {
            "2026-10-14": {
              date: "2026-10-14",
              title: "Wed 14 Oct 2026",
              body: { type: "doc", content: [{ type: "paragraph" }] },
              origin: "auto",
            },
          },
          deleted_dates: [],
          last_auto_created_date: "2026-10-14",
          settings: {},
        };
      case "samurai_files_list":
        return {
          // Issue #140: the panel renders one card per run / PR review, so
          // the entry's group must be in the listing for its row to appear.
          groups: [
            {
              id: "run:000000000000:38",
              kind: "RUN",
              label: "Epic #38 — Samurai supervision",
              refs: ["#38"],
              project_path: "C:\\git\\maestro",
              created_at: "2026-08-06T11:00:00Z",
              is_live: false,
              audit_rows: 0,
              journal_entries: 0,
            },
          ],
          entries: [
            {
              group_id: "run:000000000000:38",
              kind: "HANDOFF",
              path: "C:\\data\\worktrees\\maestro\\samurai-38\\.maestro\\handoffs\\38-gen2.md",
              size_bytes: 4096,
              modified_at: "2026-08-06T12:00:00Z",
              project_path: "C:\\git\\maestro",
              epic: "#38",
              in_use: false,
              has_live_session: false,
              fire_at: null,
            },
          ],
        };
      default:
        return undefined;
    }
  });
}

describe("UtilityPanel", () => {
  // NotepadPanel is lazy(() => import(...)) so React can only resolve it once
  // the dynamic import settles. Under full-suite load, transforming that
  // module (it drags in TipTap/ProseMirror) is slower than findByText's 1s
  // default wait, so the "notes" tests flake. Resolving the import once up
  // front here warms Vite's module cache: the in-component import() then
  // hits the cache instead of doing a cold transform, so the Suspense
  // boundary clears well within the default timeout.
  beforeAll(async () => {
    await import("@/components/notepad/NotepadPanel");
    await import("@/components/workjournal/WorkJournalPanel");
  });

  beforeEach(() => {
    invokeMock.mockReset();
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    // Notes live in a module-level zustand store — reset so tests don't leak.
    useNotesStore.setState({ notes: [], activeNoteId: null });
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

  it("renders the Second Brain panel with the audit stream and the files section", async () => {
    render(<UtilityPanel panel="secondbrain" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Second Brain")).toBeInTheDocument();
    // Audit on top: the absorbed AuditSection, behavior unchanged.
    expect(screen.getByText("Samurai Audit")).toBeInTheDocument();
    expect(await screen.findByText("SPAWN")).toBeInTheDocument();
    expect(screen.getByText("gen-2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear audit log" })).toBeInTheDocument();
    // Files below: the inventory grouped by run / PR review (issue #140).
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(await screen.findByText("38-gen2.md")).toBeInTheDocument();
    expect(screen.getByText("Epic #38 — Samurai supervision")).toBeInTheDocument();
  });

  it("renders the Launch panel with the run form and active runs", async () => {
    render(<UtilityPanel panel="launch" width={320} onResize={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Launch Run")).toBeInTheDocument();
    // Issue #128: one free-text box replaced the epics + issues fields.
    expect(screen.getByLabelText("What do you want to work on today")).toBeInTheDocument();
    // One button: it runs preflight itself, so there is no separate step.
    expect(screen.queryByRole("button", { name: "Run preflight" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(await screen.findByText("No active runs. Launch one above.")).toBeInTheDocument();
  });

  it("renders the Work Journal panel on today's page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0));
    try {
      render(
        <UtilityPanel panel="workjournal" width={560} onResize={() => {}} onClose={() => {}} />,
      );
      expect(screen.getByText("Work Journal")).toBeInTheDocument();
      // Lazy-loaded like Notes (TipTap), so the page arrives after the header.
      expect(await screen.findByDisplayValue("Wed 14 Oct 2026")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the Injector panel with its syringe title and the empty-terminals hint", () => {
    render(<UtilityPanel panel="inject" width={320} onResize={() => {}} onClose={() => {}} />);
    // "Injector" is both the panel title and the section's own heading.
    expect(screen.getAllByText("Injector").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Close Injector panel" })).toBeInTheDocument();
    // No terminal is running in this test, so the section says so.
    expect(screen.getByText("No running terminals")).toBeInTheDocument();
  });

  it("calls onClose from the header close button", () => {
    const onClose = vi.fn();
    render(<UtilityPanel panel="launch" width={320} onResize={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Launch panel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
