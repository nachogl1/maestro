import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
import { type PanelId, usePanelStripStore } from "@/stores/usePanelStripStore";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import type { GitPanelProps } from "../GitPanel";
import { LeftPanels } from "../LeftPanels";

const GIT: GitPanelProps = {
  repoPath: null,
  currentBranch: null,
  repositories: [],
  workspaceType: "single-repo",
  onRepoChange: vi.fn(),
  activeTab: "status",
  onActiveTabChange: vi.fn(),
};

/** The icon strip with just this panel open, as App renders it. */
function renderPanel(id: PanelId) {
  usePanelStripStore.setState({ openPanels: [id], widths: {}, refusal: null });
  return render(<LeftPanels content={{ git: GIT }} />);
}

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

describe("panel contents in the left icon strip (formerly the right-hand panel slot)", () => {
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
    await import("@/components/workshop/WorkshopPanel");
  });

  beforeEach(() => {
    invokeMock.mockReset();
    mockInvoke();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    // Notes live in a module-level zustand store — reset so tests don't leak.
    useNotesStore.setState({ notes: [], activeNoteId: null });
    // The Work Journal is opt-in; its panel only opens once it is switched on.
    useWorkJournalSettingsStore.setState({ enabled: true });
  });

  it("renders the Notes panel with its empty state", async () => {
    renderPanel("notes");
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
    renderPanel("notes");

    // The markdown renders as a real heading INSIDE the contenteditable —
    // formatting happens where you type, not in a separate preview pane.
    const heading = await screen.findByRole("heading", { name: "Hello" });
    expect(heading.closest('[contenteditable="true"]')).not.toBeNull();

    // The old two-pane implementation is gone: no Preview toggle, no textarea.
    expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("renders the Second Brain panel with the audit stream and the files section", async () => {
    renderPanel("secondbrain");
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
    renderPanel("launch");
    expect(screen.getByText("Launch Run")).toBeInTheDocument();
    // Issue #128: one free-text box replaced the epics + issues fields.
    expect(screen.getByLabelText("What do you want to work on today")).toBeInTheDocument();
    // One button: it runs preflight itself, so there is no separate step.
    expect(screen.queryByRole("button", { name: "Run preflight" })).not.toBeInTheDocument();
    // Scoped to the panel: the strip icon that opens it is also named "Launch".
    const panel = screen.getByRole("region", { name: "Launch panel" });
    expect(within(panel).getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(await screen.findByText("No active runs. Launch one above.")).toBeInTheDocument();
  });

  it("renders the Work Journal panel on today's page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0));
    try {
      renderPanel("workjournal");
      expect(screen.getByText("Work Journal")).toBeInTheDocument();
      // Lazy-loaded like Notes (TipTap), so the page arrives after the header.
      expect(await screen.findByDisplayValue("Wed 14 Oct 2026")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the Workshop panel with its Summary and Real Transcript tabs", async () => {
    renderPanel("workshop");
    expect(screen.getByText("Workshop")).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Real Transcript" })).toBeInTheDocument();
  });

  it("renders the Files panel asking for a terminal when none is focused", () => {
    renderPanel("files");
    const panel = screen.getByRole("region", { name: "Files panel" });
    expect(within(panel).getByText("Showing files of")).toBeInTheDocument();
    expect(within(panel).getByText(/No terminal open/)).toBeInTheDocument();
  });

  it("renders the Injector panel with its syringe title and the empty-terminals hint", () => {
    renderPanel("inject");
    // "Injector" is both the panel title and the section's own heading.
    expect(screen.getAllByText("Injector").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Close Injector panel" })).toBeInTheDocument();
    // No terminal is running in this test, so the section says so.
    expect(screen.getByText("No running terminals")).toBeInTheDocument();
  });

  it("renders the Git panel with its tab title and, in eagle view, the project carousel", () => {
    usePanelStripStore.setState({ openPanels: ["git"], widths: {}, refusal: null });
    render(
      <LeftPanels
        content={{
          git: {
            ...GIT,
            eagleProjects: [
              { tabId: "a", name: "alpha", color: "#f00" },
              { tabId: "b", name: "beta", color: "#0f0" },
            ],
            eagleIndex: 0,
            onEaglePrev: vi.fn(),
            onEagleNext: vi.fn(),
          },
        }}
      />,
    );
    const panel = screen.getByRole("region", { name: "Git panel" });
    // The header names the open tab, beside the tab strip's own Status tab.
    expect(within(panel).getAllByText("Status")).toHaveLength(2);
    expect(within(panel).getByRole("button", { name: "Previous project" })).toBeEnabled();
    expect(within(panel).getByText("Open a git repository to view commits")).toBeInTheDocument();
  });

  it("closes the panel from the header close button", () => {
    renderPanel("launch");
    fireEvent.click(screen.getByRole("button", { name: "Close Launch panel" }));

    expect(usePanelStripStore.getState().openPanels).toEqual([]);
    expect(screen.queryByRole("region", { name: "Launch panel" })).not.toBeInTheDocument();
  });
});
