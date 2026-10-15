import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discardWorkJournalConflicts,
  EMPTY_PAGE_BODY,
  nearestPageDate,
  retryWorkJournalSaves,
  useWorkJournalStore,
  WEEKEND_PAGE_BODY,
  WORK_JOURNAL_SAVE_RETRY_DELAYS_MS,
  type WorkJournalFile,
  type WorkJournalPage,
} from "../useWorkJournalStore";

const invokeMock = vi.mocked(invoke);

function page(date: string, title = date): WorkJournalPage {
  return { date, title, body: EMPTY_PAGE_BODY, origin: "auto" };
}

function journal(pages: WorkJournalPage[]): WorkJournalFile {
  return {
    layout_version: 1,
    pages: Object.fromEntries(pages.map((p) => [p.date, p])),
    deleted_dates: [],
    last_auto_created_date: null,
    settings: {},
  };
}

describe("useWorkJournalStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkJournalStore.setState({ pages: {}, viewedDate: null, loading: false, error: null });
  });

  it("ensurePages sends the local date and stores the returned pages", async () => {
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-14")]));
    await useWorkJournalStore.getState().ensurePages("2026-10-14");

    expect(invokeMock).toHaveBeenCalledWith("work_journal_ensure_pages", { today: "2026-10-14" });
    expect(Object.keys(useWorkJournalStore.getState().pages)).toEqual(["2026-10-14"]);
  });

  it("goPrev and goNext jump to the nearest existing page", () => {
    useWorkJournalStore.setState({
      pages: journal([page("2026-10-01"), page("2026-10-10"), page("2026-10-14")]).pages,
      viewedDate: "2026-10-12",
    });
    useWorkJournalStore.getState().goPrev();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-10");
    useWorkJournalStore.getState().goPrev();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-01");
    useWorkJournalStore.getState().goPrev();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-01");
    useWorkJournalStore.getState().goNext();
    useWorkJournalStore.getState().goNext();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-14");
  });

  it("createPage sends a manual page with the default title and weekend body", async () => {
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-17", "Sat 17 Oct 2026")]));
    await useWorkJournalStore.getState().createPage("2026-10-17");

    expect(invokeMock).toHaveBeenCalledWith("create_work_journal_page", {
      date: "2026-10-17",
      title: "Sat 17 Oct 2026",
      body: WEEKEND_PAGE_BODY,
      origin: "manual",
    });
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-17");
  });

  it("updatePage is optimistic and skips dates without a page", async () => {
    useWorkJournalStore.setState({ pages: journal([page("2026-10-14")]).pages });
    invokeMock.mockResolvedValue(journal([page("2026-10-14")]));

    await useWorkJournalStore.getState().updatePage("2026-10-14", { title: "Busy day" });
    expect(useWorkJournalStore.getState().pages["2026-10-14"].title).toBe("Busy day");
    expect(invokeMock).toHaveBeenCalledWith("update_work_journal_page", {
      date: "2026-10-14",
      title: "Busy day",
      body: null,
    });

    invokeMock.mockClear();
    await useWorkJournalStore.getState().updatePage("2026-10-20", { title: "Nope" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("chains saves for a date so the backend writes them in order", async () => {
    useWorkJournalStore.setState({ pages: journal([page("2026-10-14")]).pages });
    let releaseFirst: () => void = () => {};
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(journal([page("2026-10-14")]));
        }),
    );
    invokeMock.mockResolvedValue(journal([page("2026-10-14")]));
    const bodyA = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
    };
    const bodyB = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }],
    };

    const first = useWorkJournalStore.getState().updatePage("2026-10-14", { body: bodyA });
    const second = useWorkJournalStore.getState().updatePage("2026-10-14", { body: bodyB });
    await Promise.resolve();
    // The second save waits until the first one has been written.
    expect(invokeMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    const bodies = invokeMock.mock.calls.map(([, args]) => (args as { body: unknown }).body);
    expect(bodies).toEqual([bodyA, bodyB]);
    expect(useWorkJournalStore.getState().pages["2026-10-14"].body).toEqual(bodyB);
  });

  it("a reply never overwrites a page whose save is still in flight", async () => {
    useWorkJournalStore.setState({ pages: journal([page("2026-10-14")]).pages });
    let releaseSave: () => void = () => {};
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = () => resolve(journal([page("2026-10-14")]));
        }),
    );
    const typed = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }],
    };
    const save = useWorkJournalStore.getState().updatePage("2026-10-14", { body: typed });

    // A load reply with the old body lands while the save is still in flight.
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-14"), page("2026-10-15")]));
    await useWorkJournalStore.getState().load();
    expect(useWorkJournalStore.getState().pages["2026-10-14"].body).toEqual(typed);
    expect(useWorkJournalStore.getState().pages["2026-10-15"]).toBeDefined();

    releaseSave();
    await save;
  });

  it("deletePage removes the page and shows the nearest one", async () => {
    useWorkJournalStore.setState({
      pages: journal([page("2026-10-10"), page("2026-10-13"), page("2026-10-14")]).pages,
      viewedDate: "2026-10-13",
    });
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-10"), page("2026-10-14")]));
    await useWorkJournalStore.getState().deletePage("2026-10-13");

    expect(invokeMock).toHaveBeenCalledWith("delete_work_journal_page", { date: "2026-10-13" });
    expect(useWorkJournalStore.getState().pages["2026-10-13"]).toBeUndefined();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-14");
  });

  it("nearestPageDate breaks ties toward the earlier date", () => {
    const pages = journal([page("2026-10-12"), page("2026-10-14")]).pages;
    expect(nearestPageDate(pages, "2026-10-13")).toBe("2026-10-12");
    expect(nearestPageDate({}, "2026-10-13")).toBeNull();
  });

  it("a failed command surfaces its error", async () => {
    invokeMock.mockRejectedValueOnce("disk full");
    await useWorkJournalStore.getState().ensurePages("2026-10-14");
    expect(useWorkJournalStore.getState().error).toBe("disk full");
    expect(useWorkJournalStore.getState().loading).toBe(false);
  });
});

describe("useWorkJournalStore sync (a change made in the other window)", () => {
  function body(text: string): WorkJournalPage["body"] {
    return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  }

  beforeEach(() => {
    invokeMock.mockReset();
    useWorkJournalStore.setState({
      pages: {},
      viewedDate: null,
      loading: false,
      error: null,
      revision: 0,
      replacing: false,
    });
  });

  it("takes the other window's text", async () => {
    useWorkJournalStore.setState({ pages: journal([page("2026-10-14")]).pages });
    invokeMock.mockResolvedValueOnce(journal([{ ...page("2026-10-14"), body: body("theirs") }]));

    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().pages["2026-10-14"].body).toEqual(body("theirs"));
    expect(useWorkJournalStore.getState().revision).toBe(0);
  });

  it("keeps a save made here after the read started", async () => {
    useWorkJournalStore.setState({ pages: journal([page("2026-10-14")]).pages });
    let answerRead: (j: WorkJournalFile) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_work_journal") {
        return new Promise((resolve) => {
          answerRead = resolve as typeof answerRead;
        });
      }
      return Promise.resolve(journal([{ ...page("2026-10-14"), body: body("mine") }]));
    });

    const syncing = useWorkJournalStore.getState().sync(false);
    // Saved (and confirmed) while the read is still on its way.
    await useWorkJournalStore.getState().updatePage("2026-10-14", { body: body("mine") });
    answerRead(journal([{ ...page("2026-10-14"), body: body("older disk copy") }]));
    await syncing;

    expect(useWorkJournalStore.getState().pages["2026-10-14"].body).toEqual(body("mine"));
  });

  it("keeps text whose save failed until a later save lands", async () => {
    useWorkJournalStore.setState({ pages: journal([page("2026-10-14")]).pages });
    invokeMock.mockRejectedValueOnce(new Error("disk full"));
    expect(
      await useWorkJournalStore.getState().updatePage("2026-10-14", { body: body("unsaved") }),
    ).toBe(false);

    invokeMock.mockResolvedValueOnce(journal([{ ...page("2026-10-14"), body: body("disk") }]));
    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().pages["2026-10-14"].body).toEqual(body("unsaved"));

    // The retry lands: from now on the other window's text is taken again.
    invokeMock.mockResolvedValueOnce(journal([{ ...page("2026-10-14"), body: body("unsaved") }]));
    await useWorkJournalStore.getState().updatePage("2026-10-14", { body: body("unsaved") });
    invokeMock.mockResolvedValueOnce(journal([{ ...page("2026-10-14"), body: body("theirs") }]));
    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().pages["2026-10-14"].body).toEqual(body("theirs"));
  });

  it("a failed title save keeps only the title local; the body still takes the other window's edits", async () => {
    useWorkJournalStore.setState({ pages: journal([page("2026-10-14", "Old")]).pages });
    invokeMock.mockRejectedValueOnce(new Error("disk full"));
    await useWorkJournalStore.getState().updatePage("2026-10-14", { title: "Mine" });

    invokeMock.mockResolvedValueOnce(
      journal([{ ...page("2026-10-14", "Theirs"), body: body("their text") }]),
    );
    await useWorkJournalStore.getState().sync(false);
    const synced = useWorkJournalStore.getState().pages["2026-10-14"];
    expect(synced.title).toBe("Mine");
    expect(synced.body).toEqual(body("their text"));

    // A later title save lands and clears the mark.
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-14", "Mine")]));
    await useWorkJournalStore.getState().updatePage("2026-10-14", { title: "Mine" });
  });

  it("a deleted page forgets its failed saves, so a page made again takes the disk copy", async () => {
    useWorkJournalStore.setState({
      pages: journal([page("2026-10-13"), page("2026-10-14")]).pages,
    });
    invokeMock.mockRejectedValueOnce(new Error("disk full"));
    await useWorkJournalStore.getState().updatePage("2026-10-14", { body: body("lost") });

    // Deleted here.
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-13")]));
    await useWorkJournalStore.getState().deletePage("2026-10-14");
    useWorkJournalStore.setState((s) => ({
      pages: { ...s.pages, "2026-10-14": { ...page("2026-10-14"), body: body("stale") } },
    }));
    invokeMock.mockResolvedValueOnce(
      journal([page("2026-10-13"), { ...page("2026-10-14"), body: body("new page") }]),
    );
    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().pages["2026-10-14"].body).toEqual(body("new page"));

    // Deleted in the other window.
    invokeMock.mockRejectedValueOnce(new Error("disk full"));
    await useWorkJournalStore.getState().updatePage("2026-10-14", { body: body("lost again") });
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-13")]));
    await useWorkJournalStore.getState().sync(false);
    invokeMock.mockResolvedValueOnce(
      journal([page("2026-10-13"), { ...page("2026-10-14"), body: body("made again") }]),
    );
    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().pages["2026-10-14"].body).toEqual(body("made again"));
  });

  it("a restore or undo in the other window replaces the journal and bumps the revision", async () => {
    useWorkJournalStore.setState({
      pages: journal([page("2026-10-13"), page("2026-10-14")]).pages,
      viewedDate: "2026-10-14",
    });
    invokeMock.mockResolvedValueOnce(journal([{ ...page("2026-10-14"), body: body("restored") }]));

    await useWorkJournalStore.getState().sync(true);
    const state = useWorkJournalStore.getState();
    expect(Object.keys(state.pages)).toEqual(["2026-10-14"]);
    expect(state.pages["2026-10-14"].body).toEqual(body("restored"));
    expect(state.revision).toBe(1);
  });

  it("moves to the nearest page when the other window deleted the viewed one", async () => {
    useWorkJournalStore.setState({
      pages: journal([page("2026-10-12"), page("2026-10-14")]).pages,
      viewedDate: "2026-10-14",
    });
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-12")]));

    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-12");
  });

  it("stays on an empty day the user is looking at", async () => {
    useWorkJournalStore.setState({
      pages: journal([page("2026-10-12")]).pages,
      viewedDate: "2026-10-20",
    });
    invokeMock.mockResolvedValueOnce(journal([page("2026-10-12")]));

    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-20");
  });
});

describe("useWorkJournalStore failed-save retries", () => {
  const DATE = "2026-10-14";

  function body(text: string): WorkJournalPage["body"] {
    return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  }

  /** The backend's file; `failing` makes every page save fail. */
  let disk: WorkJournalFile;
  let failing: boolean;
  /** When set, the next read waits for it and answers with what it gives. */
  let heldRead: Promise<WorkJournalFile> | null;

  function saves(): unknown[] {
    return invokeMock.mock.calls
      .filter(([cmd]) => cmd === "update_work_journal_page")
      .map(([, args]) => args);
  }

  /** Reads the journal, then a body save fails. */
  async function failSave(text: string): Promise<void> {
    await useWorkJournalStore.getState().load();
    await useWorkJournalStore.getState().updatePage(DATE, { body: body(text) });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    disk = journal([page(DATE)]);
    failing = true;
    heldRead = null;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "load_work_journal" && heldRead) {
        const read = heldRead;
        heldRead = null;
        return read;
      }
      if (cmd === "update_work_journal_page") {
        if (failing) throw new Error("disk full");
        const a = args as { date: string; title: string | null; body: WorkJournalPage["body"] };
        const saved = disk.pages[a.date];
        if (a.title != null) saved.title = a.title;
        if (a.body != null) saved.body = a.body;
      }
      if (cmd === "work_journal_ensure_pages") {
        const today = (args as { today: string }).today;
        disk.pages[today] ??= page(today);
      }
      return structuredClone(disk);
    });
    useWorkJournalStore.setState({
      pages: {},
      viewedDate: null,
      loading: false,
      error: null,
      revision: 0,
      replacing: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("failed save is retried and clears on success", async () => {
    await failSave("unsaved");
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([DATE]);

    // Other commands clear the error, never the unsaved mark.
    await useWorkJournalStore.getState().ensurePages(DATE);
    expect(useWorkJournalStore.getState().error).toBeNull();
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([DATE]);

    // The first retry comes after 5 s and fails again.
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_SAVE_RETRY_DELAYS_MS[0]);
    expect(saves()).toHaveLength(2);
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([DATE]);

    // The next one waits 30 s, sends the kept text and lands.
    failing = false;
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_SAVE_RETRY_DELAYS_MS[1] - 1);
    expect(saves()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves()).toHaveLength(3);
    expect(disk.pages[DATE].body).toEqual(body("unsaved"));
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  it("a sync retries a failed save the other window did not touch", async () => {
    await failSave("mine");
    failing = false;

    await useWorkJournalStore.getState().sync(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves()).toHaveLength(2);
    expect(disk.pages[DATE].body).toEqual(body("mine"));
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  it("the other window's newer save is not overwritten", async () => {
    await failSave("older, mine");
    // The pop-out saves the same page while this window cannot write.
    disk.pages[DATE].body = body("newer, theirs");
    failing = false;

    // The timed retry reads the file first and sees the newer text.
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_SAVE_RETRY_DELAYS_MS[0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves()).toHaveLength(1);
    expect(disk.pages[DATE].body).toEqual(body("newer, theirs"));
    const state = useWorkJournalStore.getState();
    expect(state.conflictDates).toEqual([DATE]);
    expect(state.unsavedDates).toEqual([DATE]);
    expect(state.pages[DATE].body).toEqual(body("older, mine"));

    // Discarding shows the other window's text and clears the marks.
    discardWorkJournalConflicts();
    expect(useWorkJournalStore.getState().pages[DATE].body).toEqual(body("newer, theirs"));
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);
  });

  it("overwrites the other window's text only when asked", async () => {
    await failSave("mine");
    disk.pages[DATE].body = body("theirs");
    failing = false;
    await useWorkJournalStore.getState().sync(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(saves()).toHaveLength(1);

    await retryWorkJournalSaves(true);
    expect(disk.pages[DATE].body).toEqual(body("mine"));
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  it("skips a field that already has a save queued", async () => {
    await failSave("first");
    failing = false;

    // A newer save of the same field is on its way: the retry leaves it to it.
    const newer = useWorkJournalStore.getState().updatePage(DATE, { body: body("second") });
    await retryWorkJournalSaves();
    await newer;
    expect(saves()).toHaveLength(2);
    expect(disk.pages[DATE].body).toEqual(body("second"));
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  /** Holds the next read; returns its answer function. */
  function holdRead(): (reply: WorkJournalFile) => void {
    let answer: (reply: WorkJournalFile) => void = () => {};
    heldRead = new Promise((resolve) => {
      answer = resolve;
    });
    return answer;
  }

  it("a sync reply that started before a restore is dropped", async () => {
    await useWorkJournalStore.getState().load();
    const before = structuredClone(disk);
    const answer = holdRead();
    const syncing = useWorkJournalStore.getState().sync(false);

    useWorkJournalStore
      .getState()
      .replaceJournal(journal([{ ...page(DATE), body: body("restored") }]));
    answer(before);
    await syncing;
    expect(useWorkJournalStore.getState().pages[DATE].body).toEqual(body("restored"));
  });

  it("a late read does not create a false conflict", async () => {
    await useWorkJournalStore.getState().load();
    const preSave = structuredClone(disk);
    const answer = holdRead();
    const syncing = useWorkJournalStore.getState().sync(false);

    // Saved while the read is on its way, then the next save fails.
    failing = false;
    await useWorkJournalStore.getState().updatePage(DATE, { body: body("saved") });
    failing = true;
    await useWorkJournalStore.getState().updatePage(DATE, { body: body("failed") });

    // The read answers with the disk from before the first save.
    answer(preSave);
    await syncing;
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);

    // So the retry still goes out and lands.
    failing = false;
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_SAVE_RETRY_DELAYS_MS[0]);
    expect(disk.pages[DATE].body).toEqual(body("failed"));
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  it("treats a failure with no known disk text as a conflict", async () => {
    // The page was never read from the backend in this window.
    useWorkJournalStore.setState({ pages: journal([page("2026-10-20")]).pages });
    disk.pages["2026-10-20"] = page("2026-10-20");
    await useWorkJournalStore.getState().updatePage("2026-10-20", { body: body("mine") });
    failing = false;

    await useWorkJournalStore.getState().sync(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorkJournalStore.getState().conflictDates).toEqual(["2026-10-20"]);
    expect(saves()).toHaveLength(1);

    discardWorkJournalConflicts();
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  it("drops the unsaved mark when the other window deleted that day", async () => {
    await failSave("lost with the page");
    delete disk.pages[DATE];

    // Read back with the pane reopened: the day is gone, so is its mark.
    await useWorkJournalStore.getState().ensurePages("2026-10-15");
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves()).toHaveLength(1);
  });
});
