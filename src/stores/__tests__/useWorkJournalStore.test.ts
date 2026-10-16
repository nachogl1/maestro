import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDateString } from "@/lib/workJournalDates";
import {
  discardWorkJournalConflicts,
  EMPTY_PAGE_BODY,
  nearestPageDate,
  retryWorkJournalSaves,
  useWorkJournalStore,
  WEEKEND_PAGE_BODY,
  WORK_JOURNAL_RESTORE_IN_PROGRESS_CODE,
  WORK_JOURNAL_SAVE_RETRY_DELAYS_MS,
  type WorkJournalFile,
  type WorkJournalPage,
  workJournalPageDeletedNotice,
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

  it("goPrev and goNext step one calendar day, onto days with no page too", () => {
    useWorkJournalStore.setState({
      pages: journal([page("2026-10-01"), page("2026-10-14")]).pages,
      viewedDate: "2026-10-14",
    });
    useWorkJournalStore.getState().goNext();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-15");
    useWorkJournalStore.getState().goPrev();
    useWorkJournalStore.getState().goPrev();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-13");

    // Across a month boundary, with no page on either side.
    useWorkJournalStore.setState({ viewedDate: "2026-10-01" });
    useWorkJournalStore.getState().goPrev();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-09-30");
    useWorkJournalStore.getState().goNext();
    useWorkJournalStore.getState().goNext();
    expect(useWorkJournalStore.getState().viewedDate).toBe("2026-10-02");
    // No page is created by moving.
    expect(Object.keys(useWorkJournalStore.getState().pages)).toEqual(["2026-10-01", "2026-10-14"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("goPrev and goNext do nothing before a date is viewed", () => {
    useWorkJournalStore.getState().goPrev();
    useWorkJournalStore.getState().goNext();
    expect(useWorkJournalStore.getState().viewedDate).toBeNull();
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

    expect(invokeMock).toHaveBeenCalledWith("delete_work_journal_page", {
      date: "2026-10-13",
      today: localDateString(new Date()),
    });
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
        const a = args as { date: string; title: string | null; body: WorkJournalPage["body"] };
        if (!disk.pages[a.date]) throw `No work journal page for ${a.date}`;
        if (failing) throw new Error("disk full");
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

  /** Reads the journal, then a body save is refused because a restore runs. */
  async function refusedSave(text: string): Promise<void> {
    await useWorkJournalStore.getState().load();
    failing = false;
    const refuse = holdRefusedSave();
    const saving = useWorkJournalStore.getState().updatePage(DATE, { body: body(text) });
    // The replacing event arrives while the save is on its way.
    useWorkJournalStore.setState({ replacing: true });
    refuse();
    expect(await saving).toBe(false);
  }

  it("a save attempted while the replacing event is active is dropped and not retried", async () => {
    await refusedSave("old");
    expect(useWorkJournalStore.getState().error).toBeNull();
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);

    // Frozen: later saves never reach the backend, and nothing is retried.
    expect(await useWorkJournalStore.getState().updatePage(DATE, { body: body("older") })).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_SAVE_RETRY_DELAYS_MS[1] * 3);
    expect(saves()).toHaveLength(1);

    // The restored journal read back ends the freeze and drops the old text.
    disk.pages[DATE].body = body("restored");
    await useWorkJournalStore.getState().sync(true);
    const state = useWorkJournalStore.getState();
    expect(state.replacing).toBe(false);
    expect(state.revision).toBe(1);
    expect(state.pages[DATE].body).toEqual(body("restored"));
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_SAVE_RETRY_DELAYS_MS[1] * 3);
    expect(saves()).toHaveLength(1);
  });

  it("text a restore refused is saved when the restore fails", async () => {
    await refusedSave("typed during the restore");
    useWorkJournalStore.getState().endReplace();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves()).toHaveLength(2);
    expect(disk.pages[DATE].body).toEqual(body("typed during the restore"));
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  /** Holds the next page save; `refuse()` answers it with the restore refusal. */
  function holdRefusedSave(): () => void {
    let refuse = (): void => {};
    const backend = invokeMock.getMockImplementation();
    invokeMock.mockImplementationOnce(async (cmd: string, args?: unknown) =>
      cmd === "update_work_journal_page"
        ? new Promise((_resolve, reject) => {
            refuse = () => reject(`${WORK_JOURNAL_RESTORE_IN_PROGRESS_CODE} restoring`);
          })
        : backend?.(cmd, args),
    );
    return () => refuse();
  }

  it("a refused save is forgotten when the restore lands before the reply", async () => {
    await useWorkJournalStore.getState().load();
    failing = false;
    const refuse = holdRefusedSave();
    const saving = useWorkJournalStore.getState().updatePage(DATE, { body: body("old journal") });

    useWorkJournalStore.setState({ replacing: true });
    useWorkJournalStore
      .getState()
      .replaceJournal(journal([{ ...page(DATE), body: body("restored") }]));
    refuse();
    expect(await saving).toBe(false);

    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
    await retryWorkJournalSaves();
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_SAVE_RETRY_DELAYS_MS[1] * 3);
    expect(saves()).toHaveLength(1);
  });

  it("a refused save is marked and retried when the failed restore unfroze the window first", async () => {
    await useWorkJournalStore.getState().load();
    failing = false;
    const refuse = holdRefusedSave();
    const saving = useWorkJournalStore.getState().updatePage(DATE, { body: body("kept") });

    // The restore starts, fails, and the unfreeze arrives before the reply.
    useWorkJournalStore.setState({ replacing: true });
    useWorkJournalStore.getState().endReplace();
    refuse();
    expect(await saving).toBe(false);

    expect(useWorkJournalStore.getState().unsavedDates).toEqual([DATE]);
    expect(useWorkJournalStore.getState().error).toBeNull();
    await vi.advanceTimersByTimeAsync(WORK_JOURNAL_SAVE_RETRY_DELAYS_MS[0]);
    expect(disk.pages[DATE].body).toEqual(body("kept"));
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  it("New page and Delete show a restore refusal without its code", async () => {
    await useWorkJournalStore.getState().load();
    const backend = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) =>
      cmd === "create_work_journal_page" || cmd === "delete_work_journal_page"
        ? Promise.reject(
            `${WORK_JOURNAL_RESTORE_IN_PROGRESS_CODE} The Work Journal is being restored`,
          )
        : backend?.(cmd, args),
    );
    await useWorkJournalStore.getState().createPage("2026-10-20");
    expect(useWorkJournalStore.getState().error).toBe("The Work Journal is being restored");
    // A failed delete reads the journal back; the error stays.
    await useWorkJournalStore.getState().deletePage(DATE);
    expect(useWorkJournalStore.getState().error).toBe("The Work Journal is being restored");
  });

  it("an unreadable restored journal unfreezes the window without the old pages", async () => {
    await useWorkJournalStore.getState().load();
    invokeMock.mockImplementation(async () => Promise.reject("disk gone"));
    useWorkJournalStore.setState({ replacing: true });

    await useWorkJournalStore.getState().sync(true);
    const state = useWorkJournalStore.getState();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "load_work_journal")).toHaveLength(3);
    expect(state.replacing).toBe(false);
    expect(state.pages).toEqual({});
    expect(state.error).toContain("could not be read");
  });

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

  it("a save for a page the other window deleted shows a short notice and is not retried", async () => {
    disk = journal([page("2026-10-13"), page(DATE)]);
    failing = false;
    await useWorkJournalStore.getState().load();
    useWorkJournalStore.setState({ viewedDate: DATE });
    delete disk.pages[DATE];

    const saved = await useWorkJournalStore.getState().updatePage(DATE, { body: body("typed") });
    await vi.advanceTimersByTimeAsync(0);

    expect(saved).toBe(false);
    const state = useWorkJournalStore.getState();
    expect(state.error).toBe(workJournalPageDeletedNotice(DATE));
    expect(state.error).not.toContain("No work journal page");
    expect(state.unsavedDates).toEqual([]);
    expect(state.pages[DATE]).toBeUndefined();
    expect(state.viewedDate).toBe("2026-10-13");
    // Nothing is retried, and the notice stays until dismissed.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves()).toHaveLength(1);
    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().error).toBe(workJournalPageDeletedNotice(DATE));
  });

  it("a save error goes once the other window deletes its page; other errors stay", async () => {
    disk = journal([page("2026-10-13"), page(DATE)]);
    await failSave("unsaved");
    expect(useWorkJournalStore.getState().error).toBe("disk full");

    // The page is still there: the error stays.
    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().error).toBe("disk full");

    // An error that is not about a page that went away stays too.
    useWorkJournalStore.setState({ error: "Backup failed" });
    delete disk.pages[DATE];
    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().error).toBe("Backup failed");
  });

  it("a page's save error is cleared when the other window deletes that page", async () => {
    disk = journal([page("2026-10-13"), page(DATE)]);
    await failSave("unsaved");
    delete disk.pages[DATE];

    await useWorkJournalStore.getState().sync(false);
    expect(useWorkJournalStore.getState().error).toBeNull();
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saves()).toHaveLength(1);
  });
});

describe("useWorkJournalStore page revs (the pane and the pop-out saving the same page)", () => {
  function body(text: string): WorkJournalPage["body"] {
    return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  }

  /** The backend's file; its pages carry a `rev` like the real one. */
  let disk: WorkJournalFile;

  function saves(): Array<{ title: string | null; body: unknown; baseRev?: number }> {
    return invokeMock.mock.calls
      .filter(([cmd]) => cmd === "update_work_journal_page")
      .map(([, args]) => args as { title: string | null; body: unknown; baseRev?: number });
  }

  /** The other window saves `change` to the page for `date`. */
  function otherWindowSaves(date: string, change: Partial<WorkJournalPage>): void {
    const saved = disk.pages[date];
    disk.pages[date] = { ...saved, ...change, rev: (saved.rev ?? 0) + 1 };
  }

  /** Lets the re-read a conflict starts finish. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(async () => {
    invokeMock.mockReset();
    disk = journal([]);
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "update_work_journal_page") {
        const a = args as { date: string; title: string | null; body: unknown; baseRev?: number };
        const saved = disk.pages[a.date];
        if (!saved) throw `No work journal page for ${a.date}`;
        if (a.baseRev !== undefined && a.baseRev !== saved.rev) {
          throw `PAGE_CHANGED: The page for ${a.date} was changed in another window; this change was not saved.`;
        }
        if (a.title != null) saved.title = a.title;
        if (a.body != null) saved.body = a.body as WorkJournalPage["body"];
        saved.rev = (saved.rev ?? 0) + 1;
      }
      if (cmd === "create_work_journal_page") {
        const a = args as { date: string; title: string; body: WorkJournalPage["body"] };
        // Starts over at rev 0, so only the window forgetting the old page's
        // history keeps its saves from being refused.
        disk.pages[a.date] = {
          date: a.date,
          title: a.title,
          body: a.body,
          origin: "manual",
          rev: 0,
        };
      }
      if (cmd === "delete_work_journal_page") {
        delete disk.pages[(args as { date: string }).date];
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

  it("a save based on an older copy is not written and lands in the conflict state", async () => {
    const date = "2026-11-02";
    disk.pages[date] = { ...page(date), body: body("start"), rev: 0 };
    await useWorkJournalStore.getState().load();
    // The pop-out accepts a suggestion while the pane's typing waits to be saved.
    otherWindowSaves(date, { body: body("start + accepted line") });

    const saved = await useWorkJournalStore
      .getState()
      .updatePage(date, { body: body("start + typing") }, 0);
    await settle();

    expect(saved).toBe(false);
    expect(disk.pages[date].body).toEqual(body("start + accepted line"));
    expect(saves()).toHaveLength(1);
    const state = useWorkJournalStore.getState();
    expect(state.conflictDates).toEqual([date]);
    expect(state.unsavedDates).toEqual([date]);
    expect(state.error).toBeNull();
    expect(state.pages[date].body).toEqual(body("start + typing"));

    // "Overwrite with mine" lands, and typing based on the old copy keeps saving.
    await retryWorkJournalSaves(true);
    expect(disk.pages[date].body).toEqual(body("start + typing"));
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);
    expect(
      await useWorkJournalStore.getState().updatePage(date, { body: body("start + more") }, 0),
    ).toBe(true);
    expect(disk.pages[date].body).toEqual(body("start + more"));
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);
  });

  it("a title change goes on top of the other window's body change", async () => {
    const date = "2026-11-03";
    disk.pages[date] = { ...page(date, "Old title"), body: body("start"), rev: 0 };
    await useWorkJournalStore.getState().load();
    otherWindowSaves(date, { body: body("accepted line") });

    expect(await useWorkJournalStore.getState().updatePage(date, { title: "Mine" })).toBe(true);

    expect(disk.pages[date]).toMatchObject({ title: "Mine", body: body("accepted line"), rev: 2 });
    expect(saves().map((s) => s.baseRev)).toEqual([0, 1]);
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
    // The other window's text, which the save went on top of, shows here too.
    await settle();
    expect(useWorkJournalStore.getState().pages[date].body).toEqual(body("accepted line"));
  });

  it("a second title commit during a title conflict does not overwrite the other window's title", async () => {
    const date = "2026-11-06";
    disk.pages[date] = { ...page(date, "Old title"), rev: 0 };
    await useWorkJournalStore.getState().load();
    otherWindowSaves(date, { title: "Theirs" });
    expect(await useWorkJournalStore.getState().updatePage(date, { title: "Mine" })).toBe(false);
    await settle();
    expect(useWorkJournalStore.getState().conflictDates).toEqual([date]);

    expect(await useWorkJournalStore.getState().updatePage(date, { title: "Mine again" })).toBe(
      false,
    );
    await settle();

    expect(disk.pages[date].title).toBe("Theirs");
    expect(useWorkJournalStore.getState().conflictDates).toEqual([date]);
    discardWorkJournalConflicts();
    expect(useWorkJournalStore.getState().pages[date].title).toBe("Theirs");
  });

  it("a save refused because the page then went away shows the deleted notice", async () => {
    const date = "2026-11-04";
    disk.pages[date] = { ...page(date), body: body("start"), rev: 0 };
    await useWorkJournalStore.getState().load();
    // The other window saved, then deleted the page, while this save was on its way.
    invokeMock.mockImplementationOnce(async () => {
      delete disk.pages[date];
      throw `PAGE_CHANGED: The page for ${date} was changed in another window; this change was not saved.`;
    });

    const saved = await useWorkJournalStore.getState().updatePage(date, { body: body("x") }, 0);
    await settle();

    expect(saved).toBe(false);
    const state = useWorkJournalStore.getState();
    expect(state.error).toBe(workJournalPageDeletedNotice(date));
    expect(state.conflictDates).toEqual([]);
    expect(state.unsavedDates).toEqual([]);
    expect(state.pages[date]).toBeUndefined();
  });

  it("a page deleted and made again saves without a conflict", async () => {
    const date = "2026-11-07";
    disk.pages[date] = { ...page(date), body: body("old page"), rev: 0 };
    await useWorkJournalStore.getState().load();
    expect(await useWorkJournalStore.getState().updatePage(date, { body: body("typed") }, 0)).toBe(
      true,
    );

    await useWorkJournalStore.getState().deletePage(date);
    await useWorkJournalStore.getState().createPage(date);
    const base = useWorkJournalStore.getState().pages[date].rev;
    const saved = await useWorkJournalStore
      .getState()
      .updatePage(date, { body: body("new page") }, base);

    expect(saved).toBe(true);
    expect(disk.pages[date].body).toEqual(body("new page"));
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);
    expect(useWorkJournalStore.getState().unsavedDates).toEqual([]);
  });

  it("a body change goes on top of the other window's title change", async () => {
    const date = "2026-11-04";
    disk.pages[date] = { ...page(date, "Old title"), body: body("start"), rev: 0 };
    await useWorkJournalStore.getState().load();
    otherWindowSaves(date, { title: "Theirs" });

    const saved = await useWorkJournalStore.getState().updatePage(date, { body: body("mine") }, 0);

    expect(saved).toBe(true);
    expect(disk.pages[date]).toMatchObject({ title: "Theirs", body: body("mine") });
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);
  });

  it("this window's own title and body saves never end in a conflict", async () => {
    const date = "2026-11-05";
    disk.pages[date] = { ...page(date), body: body("start"), rev: 0 };
    await useWorkJournalStore.getState().load();

    const { updatePage } = useWorkJournalStore.getState();
    const results = await Promise.all([
      updatePage(date, { body: body("a") }, 0),
      updatePage(date, { body: body("ab") }, 0),
      updatePage(date, { title: "New" }),
      updatePage(date, { body: body("abc") }, 0),
    ]);

    expect(results).toEqual([true, true, true, true]);
    expect(disk.pages[date]).toMatchObject({ title: "New", body: body("abc"), rev: 4 });
    // Body saves after the first go out on the rev the one before made.
    const bodySaves = saves().filter((s) => s.body != null);
    expect(bodySaves.map((s) => s.baseRev).slice(0, 2)).toEqual([0, 1]);
    expect(useWorkJournalStore.getState().conflictDates).toEqual([]);
  });
});
