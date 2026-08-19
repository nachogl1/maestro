import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
}));

import type { SamuraiJournalEntry, SamuraiJournalEntryStatus } from "@/lib/samurai";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { JournalSection } from "../JournalSection";

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

type JournalRow = { entry: SamuraiJournalEntry; status: SamuraiJournalEntryStatus; raw: string };

function journalRow(
  overrides: Partial<SamuraiJournalEntry> = {},
  status: SamuraiJournalEntryStatus = "UNCONSUMED",
): JournalRow {
  const entry: SamuraiJournalEntry = {
    ts: "2026-08-06T10:00:00Z",
    category: "BOTTLENECK",
    text: "CI queue blocked for an hour",
    project: "C:\\git\\maestro",
    ...overrides,
  };
  // The identity `samurai_journal_delete` matches on — a real backend hands
  // back the entry's exact on-disk JSONL text; any string unique per entry
  // is enough to exercise the round trip here.
  return { entry, status, raw: JSON.stringify(entry) };
}

/**
 * Routes the global invoke mock. `rows` is mutated by `samurai_journal_add`
 * (newest LAST, like the backend) so a post-add refresh shows the new entry,
 * and by `samurai_journal_delete` (removes the row whose `raw` matches,
 * rejecting like the backend when nothing matches). "Harvest now" only asks
 * the backend for its deliverable count (`samurai_harvest_preview`, issue
 * #159) and queues a pending launch — the injection itself happens in the
 * terminal that opens.
 */
function mockInvoke(
  rows: JournalRow[],
  opts: { fileSizeBytes?: number; harvestPreview?: number } = {},
) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "samurai_journal_list":
        return { entries: rows, file_size_bytes: opts.fileSizeBytes ?? 2048 };
      case "samurai_harvest_list":
        return [];
      case "samurai_harvest_preview":
        // The backend's deliverable count (issue #159): UNCONSUMED rows,
        // plus an evidence-less PENDING batch when the override says so.
        return opts.harvestPreview ?? rows.filter((r) => r.status === "UNCONSUMED").length;
      case "samurai_journal_add": {
        const { category, text, project } = args as SamuraiJournalEntry & { project?: string };
        const entry: SamuraiJournalEntry = {
          ts: new Date().toISOString(),
          category,
          text,
          project,
        };
        rows.push({ entry, status: "UNCONSUMED", raw: JSON.stringify(entry) });
        return undefined;
      }
      case "samurai_journal_delete": {
        const { raw } = args as { raw: string };
        const remaining = rows.filter((r) => r.raw !== raw);
        const removed = rows.length - remaining.length;
        rows.length = 0;
        rows.push(...remaining);
        if (removed === 0) throw "journal entry not found";
        return removed;
      }
      default:
        return undefined;
    }
  });
}

describe("JournalSection (issue #71)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    askMock.mockReset();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
    usePendingLaunchStore.setState({ pending: [] });
  });

  it("renders entries newest-first with category badges and harvest statuses", async () => {
    // Backend order is newest LAST: the consumed skill note is older.
    mockInvoke([
      journalRow(
        { ts: "2026-08-05T09:00:00Z", category: "SKILL", text: "Older skill note" },
        "CONSUMED",
      ),
      journalRow({ ts: "2026-08-06T10:00:00Z", category: "BOTTLENECK", text: "Newest bottleneck" }),
    ]);
    const { container } = render(<JournalSection />);

    expect(await screen.findByText("Newest bottleneck")).toBeInTheDocument();
    expect(screen.getByText("Older skill note")).toBeInTheDocument();

    // Newest first in the DOM.
    const body = container.textContent ?? "";
    expect(body.indexOf("Newest bottleneck")).toBeLessThan(body.indexOf("Older skill note"));

    // Category badges, consumed label, unconsumed dot, file-size line.
    expect(screen.getByText("BOTTLENECK")).toBeInTheDocument();
    expect(screen.getByText("SKILL")).toBeInTheDocument();
    expect(screen.getByText("CONSUMED")).toBeInTheDocument();
    expect(screen.getByTitle("Not yet harvested")).toBeInTheDocument();
    expect(screen.getByText(/2 KB on disk\./)).toBeInTheDocument();
  });

  it("submits a new entry with the selected category and active project, then refreshes", async () => {
    mockInvoke([]);
    render(<JournalSection />);
    expect(await screen.findByText("No journal entries yet.")).toBeInTheDocument();

    // Empty text keeps the submit disabled.
    const submit = screen.getByRole("button", { name: "Add journal entry" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole("combobox", { name: "Entry category" }), {
      target: { value: "ERROR" },
    });
    const input = screen.getByRole("textbox", { name: "Entry text" });
    fireEvent.change(input, { target: { value: "CI flaked twice" } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("samurai_journal_add", {
        category: "ERROR",
        text: "CI flaked twice",
        project: "C:\\git\\maestro",
      }),
    );
    // Refreshed: the new row renders and the input cleared for the next one.
    expect(await screen.findByText("CI flaked twice")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  // Issue #98: "Harvest now" opens an interactive triage session instead of
  // running a headless report — the click queues a pending launch for the
  // active tab's grid (the History-tab mechanism) and mounts the grid.
  it("opens a harvest triage session via the pending-launch store", async () => {
    mockInvoke([journalRow()]);
    render(<JournalSection />);
    expect(await screen.findByText("CI queue blocked for an hour")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Harvest now" }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    expect(usePendingLaunchStore.getState().pending[0]).toMatchObject({
      tabId: "tab-1",
      mode: "Claude",
      resumeSessionId: null,
      // The active project's MAIN checkout — the journal is account-wide,
      // no worktree is derived.
      workingDirOverride: "C:\\git\\maestro",
      customName: "harvest triage",
      harvest: true,
    });
    // The grid must be (re)mounted to consume the request.
    expect(useWorkspaceStore.getState().tabs[0].sessionsLaunched).toBe(true);
    expect(
      await screen.findByText("Triage session opened — 1 entry will be injected there"),
    ).toBeInTheDocument();
    // No headless run: the only backend calls are journal lists/adds.
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_harvest_run");
  });

  it("keeps the last good rows when a refresh fails", async () => {
    // Fix m6a: a failed samurai_journal_list must not wipe rendered rows —
    // only the error line appears.
    let fail = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_journal_list") {
        if (fail) throw "journal file unreadable";
        return { entries: [journalRow()], file_size_bytes: 1024 };
      }
      // The Journal card mounts HarvestReportsSection (issue #142), which
      // lists on mount — the command answers a `Vec`, never `undefined`.
      if (cmd === "samurai_harvest_list") return [];
      return undefined;
    });
    render(<JournalSection />);
    expect(await screen.findByText("CI queue blocked for an hour")).toBeInTheDocument();

    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh journal" }));
    expect(await screen.findByText("journal file unreadable")).toBeInTheDocument();
    // The previously rendered rows survived the failed refresh.
    expect(screen.getByText("CI queue blocked for an hour")).toBeInTheDocument();
  });

  it("badges the full journal entry count, not the rendered tail", async () => {
    // Fix m6c: 60 entries, only the newest 50 render — the badge says 60.
    const rows = Array.from({ length: 60 }, (_, i) => journalRow({ text: `entry ${i}` }));
    mockInvoke(rows);
    render(<JournalSection />);

    // Newest (last in backend order) renders; the oldest 10 fall off the tail.
    expect(await screen.findByText("entry 59")).toBeInTheDocument();
    expect(screen.queryByText("entry 0")).toBeNull();
    expect(screen.getByText("60")).toBeInTheDocument();
  });

  it("refuses to open a session when nothing is unconsumed", async () => {
    // Issue #98: an empty (or fully consumed) journal shows the pinned
    // refusal WITHOUT opening a terminal — no launch is queued. The count
    // is the backend's (samurai_harvest_preview, issue #159), which
    // answers 0 here.
    mockInvoke([journalRow({}, "CONSUMED")]);
    render(<JournalSection />);
    expect(await screen.findByText("CI queue blocked for an hour")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Harvest now" }));
    expect(
      await screen.findByText("Nothing to harvest — no unconsumed journal entries."),
    ).toBeInTheDocument();
    expect(usePendingLaunchStore.getState().pending).toHaveLength(0);
    expect(screen.queryByText(/Triage session opened/)).toBeNull();
  });

  it("opens a session for a PENDING batch the backend counts as re-deliverable", async () => {
    // Issue #159: every row is PENDING — delivered once, but the run left
    // no evidence of triage, so the backend's preview counts the batch
    // deliverable again. The client-side UNCONSUMED filter this replaced
    // would have refused a journal that still has work.
    mockInvoke([journalRow({}, "PENDING")], { harvestPreview: 1 });
    render(<JournalSection />);
    expect(await screen.findByText("CI queue blocked for an hour")).toBeInTheDocument();
    // The new status renders as a muted badge like CONSUMED/ARCHIVED do.
    expect(screen.getByText("PENDING")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Harvest now" }));

    await waitFor(() => expect(usePendingLaunchStore.getState().pending).toHaveLength(1));
    expect(
      await screen.findByText("Triage session opened — 1 entry will be injected there"),
    ).toBeInTheDocument();
  });

  // Issue #100: per-entry delete with a guarded confirm.
  it("deletes an entry only after confirming; cancel does nothing", async () => {
    const rows = [journalRow({ text: "delete me" })];
    const raw = rows[0].raw;
    mockInvoke(rows);
    render(<JournalSection />);
    expect(await screen.findByText("delete me")).toBeInTheDocument();

    const deleteBtn = screen.getByRole("button", { name: "Delete journal entry: delete me" });

    // Cancel: the confirm is asked, but nothing is deleted.
    askMock.mockResolvedValueOnce(false);
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("samurai_journal_delete", expect.anything());
    expect(screen.getByText("delete me")).toBeInTheDocument();

    // Confirm: deletes by the row's raw identity and refreshes.
    askMock.mockResolvedValueOnce(true);
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("samurai_journal_delete", { raw }));
    expect(await screen.findByText("Deleted journal entry.")).toBeInTheDocument();
    expect(screen.queryByText("delete me")).toBeNull();
  });

  it("deletes a CONSUMED entry too — harvest status does not gate the delete control", async () => {
    mockInvoke([journalRow({ text: "already harvested" }, "CONSUMED")]);
    render(<JournalSection />);
    expect(await screen.findByText("already harvested")).toBeInTheDocument();

    askMock.mockResolvedValueOnce(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete journal entry: already harvested" }),
    );
    await waitFor(() => expect(screen.queryByText("already harvested")).toBeNull());
  });

  it("surfaces the backend error when a delete fails", async () => {
    const rows = [journalRow({ text: "will fail" })];
    mockInvoke(rows);
    render(<JournalSection />);
    expect(await screen.findByText("will fail")).toBeInTheDocument();

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_journal_list") return { entries: rows, file_size_bytes: 1024 };
      if (cmd === "samurai_journal_delete") {
        throw "journal entry not found — it may already be gone, or a harvest changed it";
      }
      // See above: the mounted HarvestReportsSection re-lists on every render.
      if (cmd === "samurai_harvest_list") return [];
      return undefined;
    });
    askMock.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete journal entry: will fail" }));

    expect(
      await screen.findByText(/journal entry not found — it may already be gone/),
    ).toBeInTheDocument();
    // The failed delete did not remove the row.
    expect(screen.getByText("will fail")).toBeInTheDocument();
  });

  // Issue #142: the legacy harvest reports surface (HarvestReportsSection)
  // is mounted inside the Journal card, below the entries.
  it("mounts the legacy harvest reports surface inside the Journal card", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "samurai_journal_list") return { entries: [], file_size_bytes: 0 };
      if (cmd === "samurai_harvest_list") {
        return [
          {
            path: "C:\\data\\harvest\\maestro-harvest-insights-2026-08-07.md",
            size_bytes: 1024,
            modified_at: "2026-08-07T10:00:00Z",
          },
        ];
      }
      return undefined;
    });
    render(<JournalSection />);

    expect(await screen.findByText("maestro-harvest-insights-2026-08-07.md")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("samurai_harvest_list");
  });
});
