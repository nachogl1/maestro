import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSONContent } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATCH_UP_TRUNCATED_NOTICE,
  type CandidateRunOutcome,
  useWorkJournalCandidateRunStore,
} from "@/stores/useWorkJournalCandidateRunStore";
import {
  ACCEPT_NO_EDITOR_ERROR,
  ACCEPT_SAVE_FAILED_ERROR,
  useWorkJournalCandidatesStore,
  type WorkJournalCandidate,
} from "@/stores/useWorkJournalCandidatesStore";
import {
  EMPTY_PAGE_BODY,
  useWorkJournalStore,
  type WorkJournalFile,
  type WorkJournalPage,
} from "@/stores/useWorkJournalStore";
import { GRANOLA_OPT_IN_QUESTION } from "../SuggestionsBox";
import { WorkJournalPanel } from "../WorkJournalPanel";

const invokeMock = vi.mocked(invoke);
const RUN_INITIAL = useWorkJournalCandidateRunStore.getState();
const CANDIDATES_INITIAL = useWorkJournalCandidatesStore.getState();

const TODAY = "2026-10-14";

/** In-memory stand-ins for `work-journal.json` and `activity.json`. */
let file: WorkJournalFile;
let candidates: WorkJournalCandidate[];
/** When set, page saves go through it first (it may throw or wait). */
let saveHook: (() => Promise<void>) | null;
/** When set, the accept command goes through it first (it may throw). */
let acceptHook: (() => Promise<void>) | null;
/** When true, the accept command answers null (the candidate was already gone). */
let acceptGone: boolean;
/** What the Granola preflight answers. */
let granolaConnected: boolean;
/** What a candidate run answers. */
let runOutcome: CandidateRunOutcome;

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
        if (saveHook) await saveHook();
        if (a.body != null) file.pages[date].body = a.body as JSONContent;
        return structuredClone(file);
      }
      case "list_work_journal_candidates":
        return structuredClone(candidates.filter((c) => c.date === a.date));
      case "accept_work_journal_candidate": {
        if (acceptHook) await acceptHook();
        if (acceptGone) return null;
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
        return runOutcome;
      case "work_journal_granola_status":
        return { connected: granolaConnected };
      case "update_work_journal_settings":
        file.settings = { ...file.settings, ...(a.settings as Record<string, unknown>) };
        return structuredClone(file);
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
    saveHook = null;
    acceptHook = null;
    acceptGone = false;
    runOutcome = {
      status: "ran",
      added: 0,
      dates: [],
      lastRunAt: "2026-10-14T10:00:00Z",
      lastAttemptAt: "2026-10-14T10:00:00Z",
    };
    invokeMock.mockReset();
    mockBackend();
    useWorkJournalStore.setState({
      pages: {},
      viewedDate: null,
      loading: false,
      error: null,
      replacing: false,
    });
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
      expect(within(item).getByRole("button", { name: /^Accept suggestion: / })).toBeEnabled();
      expect(within(item).getByRole("button", { name: /^Reject suggestion: / })).toBeEnabled();
    }
    expect(screen.queryByText("Rejected earlier")).not.toBeInTheDocument();
    expect(screen.queryByText(/Yesterday's commit/)).not.toBeInTheDocument();
    expect(within(box()).getByText("Suggestions (3)")).toBeInTheDocument();
  });

  it("names each row's Accept and Reject buttons after its suggestion, cut to 60 characters", async () => {
    const long = "A".repeat(80);
    candidates = [
      candidate("n1", "Merged the login fix"),
      candidate("n2", long),
      candidate("n3", `${"B".repeat(50)}😀 tail`),
    ];
    render(<WorkJournalPanel />);
    await screen.findByText("14:05 - Merged the login fix");

    expect(
      within(box()).getByRole("button", {
        name: "Accept suggestion: 14:05 - Merged the login fix",
      }),
    ).toBeInTheDocument();
    expect(
      within(box()).getByRole("button", {
        name: "Reject suggestion: 14:05 - Merged the login fix",
      }),
    ).toBeInTheDocument();
    const cut = `14:05 - ${"A".repeat(51)}…`;
    expect(cut).toHaveLength(60);
    expect(within(box()).getByRole("button", { name: `Accept suggestion: ${cut}` })).toBeVisible();
    expect(within(box()).getByRole("button", { name: `Reject suggestion: ${cut}` })).toBeVisible();
    // An emoji at the cut is kept whole, not split into half a surrogate pair.
    const emojiCut = `14:05 - ${"B".repeat(50)}😀…`;
    expect(
      within(box()).getByRole("button", { name: `Accept suggestion: ${emojiCut}` }),
    ).toBeVisible();
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
    fireEvent.click(
      within(item as HTMLElement).getByRole("button", { name: /^Accept suggestion: / }),
    );

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
    fireEvent.click(within(item).getByRole("button", { name: /^Accept suggestion: / }));
    await waitFor(() => expect(callsTo("accept_work_journal_candidate")).toEqual([{ id: "c3" }]));
    expect(savedParagraphs()).toEqual(["Standup", "Design sync on Work Journal"]);
  });

  it("accept replaces a fresh page's lone empty paragraph instead of leaving a blank line", async () => {
    file.pages[TODAY] = page(TODAY);
    render(<WorkJournalPanel />);
    await screen.findByText("13:42 - Merged the PR for the login fix");

    const item = within(box()).getByText("13:42 - Merged the PR for the login fix").closest("li");
    fireEvent.click(
      within(item as HTMLElement).getByRole("button", { name: /^Accept suggestion: / }),
    );
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
    fireEvent.click(
      within(item as HTMLElement).getByRole("button", { name: /^Reject suggestion: / }),
    );

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
    expect(screen.getByRole("button", { name: /^Accept suggestion: / })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Reject suggestion: / })).toBeEnabled();
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

  it("says once when a catch-up skipped older days, next to a failure, and the next run clears it", async () => {
    candidates = [];
    runOutcome = {
      status: "failed",
      message: "Candidate run for 2026-10-13 failed: claude did not answer within 180s",
      added: 0,
      dates: [],
      lastRunAt: "2026-10-14T10:00:00Z",
      lastAttemptAt: "2026-10-14T10:00:00Z",
      truncatedFrom: "2026-10-04T09:00:00Z",
    };
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue(`Page ${TODAY}`);

    fireEvent.click(within(box()).getByRole("button", { name: "run now" }));

    expect(await within(box()).findByText(CATCH_UP_TRUNCATED_NOTICE)).toBeInTheDocument();
    expect(
      within(box()).getByText(
        "Candidate run for 2026-10-13 failed: claude did not answer within 180s",
      ),
    ).toBeInTheDocument();

    runOutcome = {
      status: "ran",
      added: 0,
      dates: [],
      lastRunAt: "2026-10-14T11:00:00Z",
      lastAttemptAt: "2026-10-14T11:00:00Z",
    };
    fireEvent.click(within(box()).getByRole("button", { name: "run now" }));
    await waitFor(() => expect(within(box()).queryByText(CATCH_UP_TRUNCATED_NOTICE)).toBeNull());
  });
  /** Clicks a box row's button. */
  function clickRow(text: string, button: "Accept suggestion" | "Reject suggestion"): void {
    const item = within(box()).getByText(text).closest("li") as HTMLElement;
    fireEvent.click(within(item).getByRole("button", { name: new RegExp(`^${button}: `) }));
  }

  /** The editor's paragraphs as text. */
  function editorParagraphs(): string[] {
    const dom = screen.getByLabelText("Work Journal page");
    return Array.from(dom.querySelectorAll("p")).map((p) => p.textContent ?? "");
  }

  const LINE = "13:42 - Merged the PR for the login fix";

  /** Renders the panel and waits for the first suggestion. */
  async function renderWithSuggestions(): Promise<void> {
    render(<WorkJournalPanel />);
    await within(await screen.findByRole("region", { name: "Suggestions" })).findByText(LINE);
  }

  it("fills an empty last paragraph instead of adding the line after it", async () => {
    file.pages[TODAY] = page(TODAY, {
      type: "doc",
      content: [paragraph("Standup"), { type: "paragraph" }],
    });
    await renderWithSuggestions();
    clickRow(LINE, "Accept suggestion");
    await waitFor(() => expect(callsTo("accept_work_journal_candidate")).toHaveLength(1));
    expect(file.pages[TODAY].body).toEqual({
      type: "doc",
      content: [paragraph("Standup"), paragraph(LINE)],
    });
  });

  it("a failed save takes the line back out and keeps the suggestion; a retry adds one copy", async () => {
    saveHook = async () => {
      throw new Error("disk full");
    };
    await renderWithSuggestions();

    clickRow(LINE, "Accept suggestion");
    await within(box()).findByText(ACCEPT_SAVE_FAILED_ERROR);
    expect(callsTo("accept_work_journal_candidate")).toEqual([]);
    expect(editorParagraphs()).toEqual(["Standup"]);
    expect(useWorkJournalStore.getState().pages[TODAY].body).toEqual({
      type: "doc",
      content: [paragraph("Standup")],
    });
    expect(within(box()).getByText(LINE)).toBeInTheDocument();

    saveHook = null;
    clickRow(LINE, "Accept suggestion");
    await waitFor(() => expect(callsTo("accept_work_journal_candidate")).toEqual([{ id: "c1" }]));
    expect(savedParagraphs()).toEqual(["Standup", LINE]);
    expect(editorParagraphs()).toEqual(["Standup", LINE]);
  });

  it("when only the removal failed, Accept again retries the removal without a second line", async () => {
    let failures = 1;
    acceptHook = async () => {
      if (failures-- > 0) throw new Error("activity file locked");
    };
    await renderWithSuggestions();

    clickRow(LINE, "Accept suggestion");
    await within(box()).findByText(/The line is on the page, but the suggestion stayed/);
    expect(savedParagraphs()).toEqual(["Standup", LINE]);
    const savesBefore = callsTo("update_work_journal_page").length;

    clickRow(LINE, "Accept suggestion");
    await waitFor(() => expect(within(box()).queryByText(LINE)).not.toBeInTheDocument());
    expect(callsTo("accept_work_journal_candidate")).toHaveLength(2);
    expect(callsTo("update_work_journal_page")).toHaveLength(savesBefore);
    expect(savedParagraphs()).toEqual(["Standup", LINE]);
    expect(editorParagraphs()).toEqual(["Standup", LINE]);
  });

  it("a removal of a candidate already gone (null reply) counts as accepted", async () => {
    acceptGone = true;
    acceptHook = async () => {
      candidates = candidates.filter((c) => c.id !== "c1");
    };
    await renderWithSuggestions();
    clickRow(LINE, "Accept suggestion");
    await waitFor(() => expect(within(box()).queryByText(LINE)).not.toBeInTheDocument());
    expect(useWorkJournalCandidatesStore.getState().error).toBeNull();
    expect(useWorkJournalCandidatesStore.getState().landedIds).toEqual([]);
    expect(savedParagraphs()).toEqual(["Standup", LINE]);
  });

  it("does not send the removal until the save has landed", async () => {
    let release: () => void = () => {};
    saveHook = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await renderWithSuggestions();

    clickRow(LINE, "Accept suggestion");
    await waitFor(() => expect(callsTo("update_work_journal_page")).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(callsTo("accept_work_journal_candidate")).toEqual([]);
    const row = within(box()).getByText(LINE).closest("li") as HTMLElement;
    expect(within(row).getByRole("button", { name: /^Accept suggestion: / })).toBeDisabled();

    await act(async () => release());
    await waitFor(() => expect(callsTo("accept_work_journal_candidate")).toEqual([{ id: "c1" }]));
  });

  it("disables Accept and Reject while a restore replaces the journal", async () => {
    await renderWithSuggestions();
    act(() => useWorkJournalStore.setState({ replacing: true }));

    const row = within(box()).getByText(LINE).closest("li") as HTMLElement;
    const accept = within(row).getByRole("button", { name: /^Accept suggestion: / });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAttribute("title", "Wait for the restore to finish");
    expect(within(row).getByRole("button", { name: /^Reject suggestion: / })).toBeDisabled();
    clickRow(LINE, "Accept suggestion");
    clickRow(LINE, "Reject suggestion");
    expect(callsTo("accept_work_journal_candidate")).toEqual([]);
    expect(callsTo("reject_work_journal_candidate")).toEqual([]);
    expect(callsTo("update_work_journal_page")).toEqual([]);
    expect(editorParagraphs()).toEqual(["Standup"]);
  });

  it("on a read-only (unreadable) page, Accept is disabled with a hint and refused", async () => {
    file.pages[TODAY] = page(TODAY, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "From a newer build", marks: [{ type: "highlight" }] }],
        },
      ],
    });
    await renderWithSuggestions();

    expect(
      within(box()).getByText(
        "This page is read-only here, so a suggestion cannot be added to it.",
      ),
    ).toBeInTheDocument();
    for (const button of within(box()).getAllByRole("button", { name: /^Accept suggestion: / })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "This page is read-only here");
    }
    await act(async () => useWorkJournalCandidatesStore.getState().accept(candidates[0]));
    expect(useWorkJournalCandidatesStore.getState().error).toBe(ACCEPT_NO_EDITOR_ERROR);
    expect(callsTo("accept_work_journal_candidate")).toEqual([]);
    expect(callsTo("update_work_journal_page")).toEqual([]);
  });

  it("disables Accept while a candidate run is going", async () => {
    await renderWithSuggestions();
    act(() => useWorkJournalCandidateRunStore.setState({ running: true }));

    for (const button of within(box()).getAllByRole("button", { name: /^Accept suggestion: / })) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", "Wait for the run to finish");
    }
    expect(within(box()).getAllByRole("button", { name: /^Reject suggestion: / })[0]).toBeEnabled();
    await act(async () => useWorkJournalCandidatesStore.getState().accept(candidates[0]));
    expect(callsTo("update_work_journal_page")).toEqual([]);
    expect(callsTo("accept_work_journal_candidate")).toEqual([]);
  });
});

describe("SuggestionsBox Granola opt-in question", () => {
  beforeEach(() => {
    file = {
      layout_version: 1,
      pages: { [TODAY]: page(TODAY) },
      deleted_dates: [],
      last_auto_created_date: TODAY,
      settings: {},
    };
    candidates = [];
    saveHook = null;
    acceptHook = null;
    acceptGone = false;
    granolaConnected = true;
    invokeMock.mockReset();
    mockBackend();
    useWorkJournalStore.setState({
      pages: {},
      viewedDate: null,
      loading: false,
      error: null,
      replacing: false,
    });
    useWorkJournalCandidatesStore.setState(CANDIDATES_INITIAL, true);
    useWorkJournalCandidateRunStore.setState(
      { ...RUN_INITIAL, settingsLoaded: true, granolaOptIn: null },
      true,
    );
  });

  async function renderPanel(): Promise<void> {
    render(<WorkJournalPanel />);
    await screen.findByRole("region", { name: "Suggestions" });
  }

  it("asks once when Granola is connected and the choice was never made", async () => {
    await renderPanel();
    expect(await within(box()).findByText(GRANOLA_OPT_IN_QUESTION)).toBeInTheDocument();
    expect(within(box()).getByRole("button", { name: "Yes" })).toBeEnabled();
    expect(within(box()).getByRole("button", { name: "No" })).toBeEnabled();
    act(() => useWorkJournalCandidateRunStore.setState({ running: true }));
    act(() => useWorkJournalCandidateRunStore.setState({ running: false }));
    expect(callsTo("work_journal_granola_status")).toHaveLength(1);
    expect(callsTo("update_work_journal_settings")).toEqual([]);
  });

  it.each([
    ["Yes", true],
    ["No", false],
  ])("%s saves only granola_opt_in and hides the question for good", async (label, value) => {
    await renderPanel();
    await within(box()).findByText(GRANOLA_OPT_IN_QUESTION);

    fireEvent.click(within(box()).getByRole("button", { name: label }));

    await waitFor(() =>
      expect(within(box()).queryByText(GRANOLA_OPT_IN_QUESTION)).not.toBeInTheDocument(),
    );
    expect(callsTo("update_work_journal_settings")).toEqual([
      { settings: { granola_opt_in: value } },
    ]);
    expect(useWorkJournalCandidateRunStore.getState().granolaOptIn).toBe(value);
    expect(file.settings).toEqual({ granola_opt_in: value });
  });

  it("keeps the question with a hint when the choice cannot be saved", async () => {
    await renderPanel();
    await within(box()).findByText(GRANOLA_OPT_IN_QUESTION);
    invokeMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    fireEvent.click(within(box()).getByRole("button", { name: "Yes" }));

    expect(
      await within(box()).findByText("Could not save your choice. Try again."),
    ).toBeInTheDocument();
    expect(within(box()).getByText(GRANOLA_OPT_IN_QUESTION)).toBeInTheDocument();
  });

  it.each([true, false])("never asks once the choice is %s", async (optIn) => {
    useWorkJournalCandidateRunStore.setState({ granolaOptIn: optIn });
    await renderPanel();
    await act(async () => {});
    expect(within(box()).queryByText(GRANOLA_OPT_IN_QUESTION)).not.toBeInTheDocument();
    expect(callsTo("work_journal_granola_status")).toEqual([]);
  });

  it("does not ask when Granola is not connected", async () => {
    granolaConnected = false;
    await renderPanel();
    await waitFor(() => expect(callsTo("work_journal_granola_status")).toHaveLength(1));
    await act(async () => {});
    expect(within(box()).queryByText(GRANOLA_OPT_IN_QUESTION)).not.toBeInTheDocument();
  });

  it("does not ask when the check fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "work_journal_granola_status") throw new Error("no claude");
      if (cmd === "load_work_journal" || cmd === "work_journal_ensure_pages") {
        return structuredClone(file);
      }
      if (cmd === "list_work_journal_candidates") return [];
      return undefined;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderPanel();
    await waitFor(() => expect(callsTo("work_journal_granola_status")).toHaveLength(1));
    await act(async () => {});
    expect(within(box()).queryByText(GRANOLA_OPT_IN_QUESTION)).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("waits for the run settings before checking", async () => {
    useWorkJournalCandidateRunStore.setState({ settingsLoaded: false });
    await renderPanel();
    await act(async () => {});
    expect(callsTo("work_journal_granola_status")).toEqual([]);

    act(() => useWorkJournalCandidateRunStore.setState({ settingsLoaded: true }));
    expect(await within(box()).findByText(GRANOLA_OPT_IN_QUESTION)).toBeInTheDocument();
  });
});
