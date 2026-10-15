import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PAGE_BODY,
  nearestPageDate,
  useWorkJournalStore,
  WEEKEND_PAGE_BODY,
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
