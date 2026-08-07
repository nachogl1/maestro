import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { JournalSection } from "../JournalSection";
import type {
  SamuraiJournalEntry,
  SamuraiJournalEntryStatus,
} from "@/lib/samurai";
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

type JournalRow = { entry: SamuraiJournalEntry; status: SamuraiJournalEntryStatus };

function journalRow(
  overrides: Partial<SamuraiJournalEntry> = {},
  status: SamuraiJournalEntryStatus = "UNCONSUMED",
): JournalRow {
  return {
    entry: {
      ts: "2026-08-06T10:00:00Z",
      category: "BOTTLENECK",
      text: "CI queue blocked for an hour",
      project: "C:\\git\\maestro",
      ...overrides,
    },
    status,
  };
}

/**
 * Routes the global invoke mock. `rows` is mutated by `samurai_journal_add`
 * (newest LAST, like the backend) so a post-add refresh shows the new entry;
 * `harvestError` makes `samurai_harvest_run` reject with that string.
 */
function mockInvoke(rows: JournalRow[], opts: { fileSizeBytes?: number; harvestError?: string } = {}) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "samurai_journal_list":
        return { entries: rows, file_size_bytes: opts.fileSizeBytes ?? 2048 };
      case "samurai_journal_add": {
        const { category, text, project } = args as SamuraiJournalEntry & { project?: string };
        rows.push({
          entry: { ts: new Date().toISOString(), category, text, project },
          status: "UNCONSUMED",
        });
        return undefined;
      }
      case "samurai_harvest_run":
        if (opts.harvestError) throw opts.harvestError;
        return {
          date: "2026-08-06",
          markdown: "# Harvest 2026-08-06",
          generated_at: "2026-08-06T18:00:00Z",
        };
      default:
        return undefined;
    }
  });
}

describe("JournalSection (issue #71)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkspaceStore.setState({ tabs: [buildTab()] });
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

  it("runs the harvest, shows the success notice and tells the parent", async () => {
    const onHarvested = vi.fn();
    mockInvoke([journalRow()]);
    render(<JournalSection onHarvested={onHarvested} />);
    expect(await screen.findByText("CI queue blocked for an hour")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Harvest now" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("samurai_harvest_run"));
    expect(await screen.findByText("Report 2026-08-06 written — see Files")).toBeInTheDocument();
    await waitFor(() => expect(onHarvested).toHaveBeenCalledTimes(1));
  });

  it("surfaces the harvest error string inline, matter-of-fact", async () => {
    const onHarvested = vi.fn();
    mockInvoke([], {
      harvestError: "Nothing to harvest — no unconsumed journal entries.",
    });
    render(<JournalSection onHarvested={onHarvested} />);
    expect(await screen.findByText("No journal entries yet.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Harvest now" }));
    expect(
      await screen.findByText("Nothing to harvest — no unconsumed journal entries."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/written — see Files/)).toBeNull();
    expect(onHarvested).not.toHaveBeenCalled();
  });
});
