import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSONContent } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalCandidateRunStore } from "@/stores/useWorkJournalCandidateRunStore";
import {
  ACCEPT_NO_EDITOR_ERROR,
  useWorkJournalCandidatesStore,
  type WorkJournalCandidate,
} from "@/stores/useWorkJournalCandidatesStore";
import {
  EMPTY_PAGE_BODY,
  useWorkJournalStore,
  type WorkJournalFile,
  type WorkJournalPage,
} from "@/stores/useWorkJournalStore";
import { WorkJournalPanel } from "../WorkJournalPanel";

const invokeMock = vi.mocked(invoke);
const RUN_INITIAL = useWorkJournalCandidateRunStore.getState();
const CANDIDATES_INITIAL = useWorkJournalCandidatesStore.getState();

const TODAY = "2026-10-14";

/** In-memory stand-ins for `work-journal.json` and `activity.json`. */
let file: WorkJournalFile;
let candidates: WorkJournalCandidate[];

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function page(date: string, body: JSONContent = EMPTY_PAGE_BODY): WorkJournalPage {
  return { date, title: `Page ${date}`, body, origin: "auto" };
}

function candidate(
  id: string,
  text: string,
  overrides: Partial<WorkJournalCandidate> = {},
): WorkJournalCandidate {
  return {
    id,
    date: TODAY,
    time: "14:05",
    text,
    source: "git",
    state: "pending",
    createdAt: "2026-10-14T14:10:00+01:00",
    ...overrides,
  };
}

function callsTo(cmd: string): unknown[] {
  return invokeMock.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

/** Routes invoke like the backend commands do. */
function mockBackend(): void {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "load_work_journal":
      case "work_journal_ensure_pages":
        return structuredClone(file);
      case "update_work_journal_page": {
        const date = a.date as string;
        if (a.body != null) file.pages[date].body = a.body as JSONContent;
        return structuredClone(file);
      }
      case "list_work_journal_candidates":
        return structuredClone(candidates.filter((c) => c.date === a.date));
      case "accept_work_journal_candidate": {
        const found = candidates.find((c) => c.id === a.id);
        if (!found) throw new Error(`No work journal candidate with id ${a.id}`);
        candidates = candidates.filter((c) => c.id !== a.id);
        return found;
      }
      case "reject_work_journal_candidate": {
        const found = candidates.find((c) => c.id === a.id);
        if (!found) throw new Error(`No work journal candidate with id ${a.id}`);
        found.state = "rejected";
        return found;
      }
      case "work_journal_run_candidates":
        return { status: "ran", added: 0, dates: [], lastRunAt: "2026-10-14T10:00:00Z" };
      default:
        return undefined;
    }
  });
}

function box(): HTMLElement {
  return screen.getByRole("region", { name: "Suggestions" });
}

/** The page body as text, one paragraph per entry. */
function savedParagraphs(date = TODAY): string[] {
  return (file.pages[date].body.content ?? []).map((node) =>
    (node.content ?? []).map((t) => t.text ?? "").join(""),
  );
}

describe("SuggestionsBox", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0));
    file = {
      layout_version: 1,
      pages: {
        "2026-10-13": page("2026-10-13"),
        [TODAY]: page(TODAY, { type: "doc", content: [paragraph("Standup")] }),
      },
      deleted_dates: [],
      last_auto_created_date: TODAY,
      settings: {},
    };
    candidates = [
      candidate("c1", "Merged the PR for the login fix", { source: "github", time: "13:42" }),
      candidate("c2", "Worked on agent-name terminal titles", { source: "claude" }),
      candidate("c3", "Design sync on Work Journal", { source: "granola", time: null }),
      candidate("old", "Rejected earlier", { state: "rejected" }),
      candidate("y1", "Yesterday's commit", { date: "2026-10-13" }),
    ];
    invokeMock.mockReset();
    mockBackend();
    useWorkJournalStore.setState({ pages: {}, viewedDate: null, loading: false, error: null });
    useWorkJournalCandidatesStore.setState(CANDIDATES_INITIAL, true);
    useWorkJournalCandidateRunStore.setState(RUN_INITIAL, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the viewed day's pending candidates with their tag and icons", async () => {
    render(<WorkJournalPanel />);
    await screen.findByText("13:42 - Merged the PR for the login fix");

    const items = within(box()).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText("GitHub")).toBeInTheDocument();
    expect(
      within(items[1]).getByText("14:05 - Worked on agent-name terminal titles"),
    ).toBeVisible();
    expect(within(items[1]).getByText("Claude")).toBeInTheDocument();
    expect(within(items[2]).getByText("Design sync on Work Journal")).toBeInTheDocument();
    expect(within(items[2]).getByText("Granola")).toBeInTheDocument();
    for (const item of items) {
      expect(within(item).getByRole("button", { name: "Accept suggestion" })).toBeEnabled();
      expect(within(item).getByRole("button", { name: "Reject suggestion" })).toBeEnabled();
    }
    expect(screen.queryByText("Rejected earlier")).not.toBeInTheDocument();
    expect(screen.queryByText(/Yesterday's commit/)).not.toBeInTheDocument();
    expect(within(box()).getByText("Suggestions (3)")).toBeInTheDocument();
  });

  it("maps every source to its exact tag", async () => {
    candidates = (["github", "git", "claude", "terminal", "granola"] as const).map((source, i) =>
      candidate(`s${i}`, `line ${source}`, { source }),
    );
    render(<WorkJournalPanel />);
    await screen.findByText("14:05 - line github");
    for (const tag of ["GitHub", "Git", "Claude", "Terminal", "Granola"]) {
      expect(within(box()).getByText(tag)).toBeInTheDocument();
    }
  });

  it("accept appends `time - action` at the end of the page and removes the candidate", async () => {
    render(<WorkJournalPanel />);
    await screen.findByText("13:42 - Merged the PR for the login fix");

    const item = within(box()).getByText("13:42 - Merged the PR for the login fix").closest("li");
    fireEvent.click(within(item as HTMLElement).getByRole("button", { name: "Accept suggestion" }));

    await waitFor(() =>
      expect(
        within(box()).queryByText("13:42 - Merged the PR for the login fix"),
      ).not.toBeInTheDocument(),
    );
    // Saved through the editor's save path, then removed from the activity file.
    expect(savedParagraphs()).toEqual(["Standup", "13:42 - Merged the PR for the login fix"]);
    expect(callsTo("accept_work_journal_candidate")).toEqual([{ id: "c1" }]);
    const order = invokeMock.mock.calls.map(([c]) => c);
    expect(order.lastIndexOf("update_work_journal_page")).toBeLessThan(
      order.indexOf("accept_work_journal_candidate"),
    );
    // The open editor shows the line too.
    expect(
      within(screen.getByLabelText("Work Journal page")).getByText(/13:42 - Merged/),
    ).toBeVisible();
    expect(within(box()).getAllByRole("listitem")).toHaveLength(2);
  });

  it("accept of an untimed candidate appends its text as given", async () => {
    render(<WorkJournalPanel />);
    await screen.findByText("Design sync on Work Journal");
    const item = screen.getByText("Design sync on Work Journal").closest("li") as HTMLElement;
    fireEvent.click(within(item).getByRole("button", { name: "Accept suggestion" }));
    await waitFor(() => expect(callsTo("accept_work_journal_candidate")).toEqual([{ id: "c3" }]));
    expect(savedParagraphs()).toEqual(["Standup", "Design sync on Work Journal"]);
  });

  it("accept replaces a fresh page's lone empty paragraph instead of leaving a blank line", async () => {
    file.pages[TODAY] = page(TODAY);
    render(<WorkJournalPanel />);
    await screen.findByText("13:42 - Merged the PR for the login fix");

    const item = within(box()).getByText("13:42 - Merged the PR for the login fix").closest("li");
    fireEvent.click(within(item as HTMLElement).getByRole("button", { name: "Accept suggestion" }));
    await waitFor(() => expect(callsTo("accept_work_journal_candidate")).toHaveLength(1));

    expect(file.pages[TODAY].body).toEqual({
      type: "doc",
      content: [paragraph("13:42 - Merged the PR for the login fix")],
    });
  });

  it("reject calls the reject command and the candidate leaves the box", async () => {
    render(<WorkJournalPanel />);
    await screen.findByText("14:05 - Worked on agent-name terminal titles");

    const item = screen.getByText("14:05 - Worked on agent-name terminal titles").closest("li");
    fireEvent.click(within(item as HTMLElement).getByRole("button", { name: "Reject suggestion" }));

    await waitFor(() =>
      expect(
        screen.queryByText("14:05 - Worked on agent-name terminal titles"),
      ).not.toBeInTheDocument(),
    );
    expect(callsTo("reject_work_journal_candidate")).toEqual([{ id: "c2" }]);
    expect(candidates.find((c) => c.id === "c2")?.state).toBe("rejected");
    expect(callsTo("update_work_journal_page")).toEqual([]);
    expect(savedParagraphs()).toEqual(["Standup"]);
  });

  it("on a day with no page, Accept is disabled with a hint; Reject still works", async () => {
    candidates = [candidate("f1", "Future plan", { date: "2026-10-20" })];
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue(`Page ${TODAY}`);
    act(() => useWorkJournalStore.getState().selectDate("2026-10-20"));

    await screen.findByText("14:05 - Future plan");
    expect(screen.getByText("Create the page first to accept a suggestion.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept suggestion" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject suggestion" })).toBeEnabled();
  });

  it("does not remove the candidate when no editor can take the line", async () => {
    const result = useWorkJournalCandidatesStore.getState();
    await act(async () => result.accept(candidate("c1", "Merged")));
    expect(callsTo("accept_work_journal_candidate")).toEqual([]);
    expect(useWorkJournalCandidatesStore.getState().error).toBe(ACCEPT_NO_EDITOR_ERROR);
  });

  it("shows only the footer when nothing is pending, and run now runs with the open projects", async () => {
    candidates = [];
    useWorkJournalCandidateRunStore.setState({ projects: ["C:\\git\\a"], nextRunAt: null });
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue(`Page ${TODAY}`);

    expect(within(box()).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(box()).getByText(/next run —/)).toBeInTheDocument();
    fireEvent.click(within(box()).getByRole("button", { name: "run now" }));
    await waitFor(() =>
      expect(callsTo("work_journal_run_candidates")).toEqual([{ projects: ["C:\\git\\a"] }]),
    );
  });

  it("shows the next run time, 'soon' before the catch-up, and the run's notices", async () => {
    candidates = [];
    useWorkJournalCandidateRunStore.setState({
      nextRunAt: new Date(2026, 9, 14, 15, 0, 0).getTime(),
    });
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue(`Page ${TODAY}`);
    expect(within(box()).getByText(/next run 15:00/)).toBeInTheDocument();

    act(() => useWorkJournalCandidateRunStore.setState({ catchUpPending: true }));
    expect(within(box()).getByText(/next run soon/)).toBeInTheDocument();

    act(() =>
      useWorkJournalCandidateRunStore.setState({
        running: true,
        runNotice: "No project is open, so there was nothing to look at.",
      }),
    );
    expect(within(box()).getByRole("button", { name: "running…" })).toBeDisabled();
    expect(
      within(box()).getByText("No project is open, so there was nothing to look at."),
    ).toBeInTheDocument();
  });
});
