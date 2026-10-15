import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import {
  EMPTY_PAGE_BODY,
  useWorkJournalStore,
  type WorkJournalFile,
  type WorkJournalPage,
} from "@/stores/useWorkJournalStore";
import { WORK_JOURNAL_SAVE_DEBOUNCE_MS } from "../WorkJournalEditor";
import { WorkJournalPanel } from "../WorkJournalPanel";

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);

/** In-memory stand-in for `work-journal.json` behind the Tauri commands. */
let file: WorkJournalFile;

/** The pages the last report request found in `file`. */
let reportSaw = "";

function page(date: string, title: string): WorkJournalPage {
  return { date, title, body: EMPTY_PAGE_BODY, origin: "auto" };
}

function snapshot(): WorkJournalFile {
  return structuredClone(file);
}

/** Routes invoke like the backend commands do, mutating `file`. */
function mockBackend(): void {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "load_work_journal":
        return snapshot();
      case "work_journal_ensure_pages": {
        const today = a.today as string;
        if (!file.pages[today] && !file.deleted_dates.includes(today)) {
          file.pages[today] = page(today, `auto ${today}`);
        }
        return snapshot();
      }
      case "create_work_journal_page": {
        const date = a.date as string;
        file.pages[date] = {
          date,
          title: a.title as string,
          body: a.body as WorkJournalPage["body"],
          origin: "manual",
        };
        return snapshot();
      }
      case "update_work_journal_page": {
        const date = a.date as string;
        if (a.title != null) file.pages[date].title = a.title as string;
        if (a.body != null) file.pages[date].body = a.body as WorkJournalPage["body"];
        return snapshot();
      }
      case "delete_work_journal_page": {
        const date = a.date as string;
        delete file.pages[date];
        file.deleted_dates.push(date);
        return snapshot();
      }
      case "work_journal_generate_report":
        // The report reads the file: record what it would see.
        reportSaw = JSON.stringify(file.pages);
        return { status: "nothing_to_report" };
      default:
        return undefined;
    }
  });
}

function callsTo(cmd: string): unknown[] {
  return invokeMock.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
}

/** The TipTap editor behind the page body (TipTap puts it on its DOM node). */
function pageEditor(): Editor {
  const dom = screen.getByLabelText("Work Journal page") as HTMLElement & { editor: Editor };
  return dom.editor;
}

describe("WorkJournalPanel", () => {
  beforeEach(() => {
    // Wed 14 Oct 2026, 10:00 local. shouldAdvanceTime keeps findBy* working.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0));
    file = {
      layout_version: 1,
      pages: {
        "2026-10-12": page("2026-10-12", "Mon 12 Oct 2026"),
        "2026-10-13": page("2026-10-13", "Tue 13 Oct 2026"),
        "2026-10-14": page("2026-10-14", "Wed 14 Oct 2026"),
      },
      deleted_dates: [],
      last_auto_created_date: "2026-10-14",
      settings: {},
    };
    invokeMock.mockReset();
    askMock.mockReset();
    mockBackend();
    useWorkJournalStore.setState({ pages: {}, viewedDate: null, loading: false, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens on today's page and ensures pages for the local date", async () => {
    render(<WorkJournalPanel />);

    expect(await screen.findByDisplayValue("Wed 14 Oct 2026")).toBeInTheDocument();
    expect(callsTo("work_journal_ensure_pages")).toEqual([{ today: "2026-10-14" }]);
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();
  });

  it("navigates to the previous and next pages", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByLabelText("Page title")).toHaveValue("Tue 13 Oct 2026");
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByLabelText("Page title")).toHaveValue("Mon 12 Oct 2026");
    expect(screen.getByRole("button", { name: "Previous day" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(screen.getByLabelText("Page title")).toHaveValue("Tue 13 Oct 2026");
  });

  it("saves the body as editor JSON after the debounce, and the title on blur", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    act(() => {
      pageEditor().commands.insertContent("Reviewed the login fix");
    });
    expect(callsTo("update_work_journal_page")).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
    });
    expect(callsTo("update_work_journal_page")).toEqual([
      {
        date: "2026-10-14",
        title: null,
        body: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Reviewed the login fix" }] },
          ],
        },
      },
    ]);

    const title = screen.getByLabelText("Page title");
    fireEvent.change(title, { target: { value: "Release day" } });
    fireEvent.blur(title);
    await waitFor(() => expect(file.pages["2026-10-14"].title).toBe("Release day"));
    expect(callsTo("update_work_journal_page")[1]).toEqual({
      date: "2026-10-14",
      title: "Release day",
      body: null,
    });
  });

  it("flushes an unsaved body when switching to another day", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    act(() => {
      pageEditor().commands.insertContent("Half-typed");
    });
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));

    expect(callsTo("update_work_journal_page")).toHaveLength(1);
    expect(callsTo("update_work_journal_page")[0]).toMatchObject({ date: "2026-10-14" });
  });

  it("deletes the page after confirming and shows a neighbour", async () => {
    askMock.mockResolvedValue(true);
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    fireEvent.click(screen.getByRole("button", { name: "Delete page" }));

    expect(await screen.findByDisplayValue("Tue 13 Oct 2026")).toBeInTheDocument();
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(callsTo("delete_work_journal_page")).toEqual([{ date: "2026-10-14" }]);
    expect(file.pages["2026-10-14"]).toBeUndefined();
  });

  it("keeps the page when the delete is not confirmed", async () => {
    askMock.mockResolvedValue(false);
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    fireEvent.click(screen.getByRole("button", { name: "Delete page" }));

    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(callsTo("delete_work_journal_page")).toEqual([]);
    expect(screen.getByLabelText("Page title")).toHaveValue("Wed 14 Oct 2026");
  });

  it("creates a manual page for a chosen date", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    fireEvent.click(screen.getByRole("button", { name: "New page for a date" }));
    fireEvent.change(screen.getByLabelText("Date for the new page"), {
      target: { value: "2026-10-20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByDisplayValue("Tue 20 Oct 2026")).toBeInTheDocument();
    expect(callsTo("create_work_journal_page")).toEqual([
      {
        date: "2026-10-20",
        title: "Tue 20 Oct 2026",
        body: EMPTY_PAGE_BODY,
        origin: "manual",
      },
    ]);
  });

  it("jumps only on Enter, not on each partial value while typing", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    fireEvent.click(screen.getByRole("button", { name: "Jump to date" }));
    const input = screen.getByLabelText("Date to jump to");
    // Typing "1" of "12" in the day field already reports 1 Oct.
    fireEvent.change(input, { target: { value: "2026-10-01" } });
    expect(screen.getByLabelText("Page title")).toHaveValue("Wed 14 Oct 2026");
    expect(screen.getByLabelText("Date to jump to")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "2026-10-12" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByLabelText("Page title")).toHaveValue("Mon 12 Oct 2026");
    expect(screen.queryByLabelText("Date to jump to")).toBeNull();
  });

  it("jumps with Go and offers to create a page when the day has none", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    fireEvent.click(screen.getByRole("button", { name: "Jump to date" }));
    fireEvent.change(screen.getByLabelText("Date to jump to"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));

    expect(screen.getByText("No page for Thu 1 Oct 2026.")).toBeInTheDocument();
    const create = screen.getByRole("button", { name: "Create a page for this day" });
    // A double-click sends one create; the button is disabled while it runs.
    fireEvent.click(create);
    fireEvent.click(create);
    expect(await screen.findByDisplayValue("Thu 1 Oct 2026")).toBeInTheDocument();
    expect(callsTo("create_work_journal_page")).toHaveLength(1);
  });

  it("does not recreate a deleted page, but new page for a date does", async () => {
    askMock.mockResolvedValue(true);
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    fireEvent.click(screen.getByRole("button", { name: "Delete page" }));
    await screen.findByDisplayValue("Tue 13 Oct 2026");
    await act(async () => {
      await useWorkJournalStore.getState().ensurePages("2026-10-14");
    });
    expect(file.pages["2026-10-14"]).toBeUndefined();
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "New page for a date" }));
    fireEvent.change(screen.getByLabelText("Date for the new page"), {
      target: { value: "2026-10-14" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByDisplayValue("Wed 14 Oct 2026")).toBeInTheDocument();
    expect(file.pages["2026-10-14"].origin).toBe("manual");
  });

  it("saves unsaved text when the pane closes", async () => {
    const { unmount } = render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    act(() => {
      pageEditor().commands.insertContent("Closing now");
    });
    unmount();

    expect(callsTo("update_work_journal_page")).toHaveLength(1);
    expect(JSON.stringify(callsTo("update_work_journal_page")[0])).toContain("Closing now");
  });

  it("opens the report dialog, and the report sees typing not yet saved", async () => {
    file.settings = { report_folder: "D:\\Reports" };
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    act(() => {
      pageEditor().commands.insertContent("Shipped the export");
    });

    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(screen.getByRole("dialog", { name: "Work report" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByText("Nothing to report for these dates.")).toBeInTheDocument();
    expect(reportSaw).toContain("Shipped the export");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends pending body and title saves when the window is closing", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    act(() => {
      pageEditor().commands.insertContent("Before quit");
    });
    fireEvent.change(screen.getByLabelText("Page title"), { target: { value: "Quit day" } });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    const saves = callsTo("update_work_journal_page") as Array<Record<string, unknown>>;
    expect(saves.some((a) => JSON.stringify(a.body).includes("Before quit"))).toBe(true);
    expect(saves.some((a) => a.title === "Quit day")).toBe(true);
  });

  it("shows a body it cannot read as read-only and never saves it", async () => {
    file.pages["2026-10-14"].body = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "From a newer build", marks: [{ type: "highlight" }] }],
        },
      ],
    };
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    expect(screen.getByLabelText("Unreadable Work Journal page")).toHaveTextContent(
      "From a newer build",
    );
    expect(screen.queryByLabelText("Work Journal page")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(callsTo("update_work_journal_page")).toEqual([]);
  });

  it("ensures the new day's page on window focus after sleeping through midnight", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    // The PC slept: the clock jumps to the next morning without timers firing.
    vi.setSystemTime(new Date(2026, 9, 15, 8, 0, 0));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(callsTo("work_journal_ensure_pages")).toEqual([
      { today: "2026-10-14" },
      { today: "2026-10-15" },
    ]);

    // A second focus on the same day does not ask again.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(callsTo("work_journal_ensure_pages")).toHaveLength(2);
  });

  it("notices a changed date within a minute, even without focus", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    // A clock or time-zone change moves the local date.
    vi.setSystemTime(new Date(2026, 9, 15, 9, 0, 0));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(callsTo("work_journal_ensure_pages")).toEqual([
      { today: "2026-10-14" },
      { today: "2026-10-15" },
    ]);
  });

  it("creates the new day's page at local midnight while open", async () => {
    vi.setSystemTime(new Date(2026, 9, 14, 23, 59, 58));
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    await act(async () => {
      vi.advanceTimersByTime(4_000);
    });

    expect(callsTo("work_journal_ensure_pages")).toEqual([
      { today: "2026-10-14" },
      { today: "2026-10-15" },
    ]);
    // The view stays put; the arrow reaches the new page.
    expect(screen.getByLabelText("Page title")).toHaveValue("Wed 14 Oct 2026");
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(screen.getByLabelText("Page title")).toHaveValue("auto 2026-10-15");
  });
});

describe("WorkJournalPanel restore", () => {
  const RESTORED_BODY = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Restored text" }] }],
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0));
    file = {
      layout_version: 1,
      pages: { "2026-10-14": page("2026-10-14", "Wed 14 Oct 2026") },
      deleted_dates: [],
      last_auto_created_date: "2026-10-14",
      settings: {},
    };
    invokeMock.mockReset();
    mockBackend();
    // The restore command, on top of the in-memory backend: the backup holds
    // a different body for the same date.
    const backend = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "restore_work_journal") {
        file.pages["2026-10-14"] = { ...file.pages["2026-10-14"], body: RESTORED_BODY };
        return { journal: snapshot(), canUndo: true, autoBackup: "paused" };
      }
      if (cmd === "work_journal_restore_state") return { canUndo: false };
      return backend?.(cmd, args);
    });
    useWorkJournalStore.setState({
      pages: {},
      viewedDate: null,
      loading: false,
      error: null,
      replacing: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves unsaved text before a restore, then shows the restored body without saving the old one", async () => {
    const { unmount } = render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    act(() => {
      pageEditor().commands.insertContent("Typed before the restore");
    });
    // The debounce has not fired: the text is still unsaved.
    expect(callsTo("update_work_journal_page")).toEqual([]);

    await act(() => useWorkJournalBackupStore.getState().restore());

    const commands = invokeMock.mock.calls.map(([cmd]) => cmd);
    const saveAt = commands.indexOf("update_work_journal_page");
    expect(saveAt).toBeGreaterThanOrEqual(0);
    expect(saveAt).toBeLessThan(commands.indexOf("restore_work_journal"));
    expect(callsTo("update_work_journal_page")).toHaveLength(1);
    expect(await screen.findByText("Restored text")).toBeInTheDocument();
    expect(screen.queryByText("Typed before the restore")).toBeNull();

    // No late save of the old body: not after the debounce, not on unmount.
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS * 2);
    });
    unmount();
    expect(callsTo("update_work_journal_page")).toHaveLength(1);
    expect(file.pages["2026-10-14"].body).toEqual(RESTORED_BODY);
  });

  /**
   * Makes `restore_work_journal` stay pending until `settle` is called, like
   * a slow OneDrive or network backup. `settle(true)` applies the restore,
   * `settle(false)` fails it.
   */
  function slowRestore(): { settle: (ok: boolean) => void } {
    const withRestore = invokeMock.getMockImplementation();
    let settle: (ok: boolean) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd !== "restore_work_journal") return withRestore?.(cmd, args) as Promise<unknown>;
      return new Promise((resolve, reject) => {
        settle = (ok) => {
          if (!ok) return reject("Failed to write the work journal");
          resolve(withRestore?.(cmd, args));
        };
      });
    });
    return { settle: (ok) => settle(ok) };
  }

  it("saves nothing typed while a slow restore runs, then shows the restored body", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    const slow = slowRestore();

    let restoring: Promise<void> = Promise.resolve();
    await act(async () => {
      restoring = useWorkJournalBackupStore.getState().restore();
    });
    expect(useWorkJournalStore.getState().replacing).toBe(true);
    expect(pageEditor().isEditable).toBe(false);
    expect(screen.getByLabelText("Page title")).toBeDisabled();

    // Text reaching the editor anyway (a command, not the keyboard), with the
    // debounce firing while the restore is still pending.
    act(() => {
      pageEditor().commands.insertContent("Too late");
    });
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS * 2);
    });
    await act(async () => {
      await useWorkJournalStore.getState().updatePage("2026-10-14", { title: "Too late" });
    });
    expect(callsTo("update_work_journal_page")).toEqual([]);

    await act(async () => {
      slow.settle(true);
      await restoring;
    });
    expect(await screen.findByText("Restored text")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS * 2);
    });

    expect(callsTo("update_work_journal_page")).toEqual([]);
    expect(file.pages["2026-10-14"].body).toEqual(RESTORED_BODY);
    expect(file.pages["2026-10-14"].title).toBe("Wed 14 Oct 2026");
    expect(pageEditor().isEditable).toBe(true);
  });

  it("drops a save made while the pre-restore saves are still landing", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    // The flushed save is slow to land.
    const withRestore = invokeMock.getMockImplementation();
    let landSave: () => void = () => {};
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd !== "update_work_journal_page") return withRestore?.(cmd, args) as Promise<unknown>;
      return new Promise((resolve) => {
        landSave = () => resolve(withRestore?.(cmd, args));
      });
    });
    act(() => {
      pageEditor().commands.insertContent("Flushed first");
    });

    let restoring: Promise<void> = Promise.resolve();
    await act(async () => {
      restoring = useWorkJournalBackupStore.getState().restore();
    });
    expect(callsTo("update_work_journal_page")).toHaveLength(1);
    expect(callsTo("restore_work_journal")).toEqual([]);

    // A save made during that wait is dropped, not sent unawaited.
    await act(async () => {
      void useWorkJournalStore.getState().updatePage("2026-10-14", { title: "Too late" });
    });
    expect(callsTo("update_work_journal_page")).toHaveLength(1);

    await act(async () => {
      landSave();
      await restoring;
    });
    expect(callsTo("update_work_journal_page")).toHaveLength(1);
    expect(callsTo("restore_work_journal")).toHaveLength(1);
    expect(await screen.findByText("Restored text")).toBeInTheDocument();
  });

  it("lets editing and saving resume after a slow restore fails", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    const slow = slowRestore();

    let restoring: Promise<void> = Promise.resolve();
    await act(async () => {
      restoring = useWorkJournalBackupStore.getState().restore();
    });
    expect(pageEditor().isEditable).toBe(false);
    await act(async () => {
      slow.settle(false);
      await restoring;
    });

    expect(useWorkJournalStore.getState().replacing).toBe(false);
    expect(pageEditor().isEditable).toBe(true);
    act(() => {
      pageEditor().commands.insertContent("Kept typing");
    });
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
    });
    expect(callsTo("update_work_journal_page")).toHaveLength(1);
    expect(JSON.stringify(file.pages["2026-10-14"].body)).toContain("Kept typing");
  });

  it("saves typing made after a restore in the remounted editor", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    await act(() => useWorkJournalBackupStore.getState().restore());
    await screen.findByText("Restored text");

    act(() => {
      pageEditor().commands.insertContentAt(pageEditor().state.doc.content.size - 1, " and more");
    });
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
    });

    expect(callsTo("update_work_journal_page")).toHaveLength(1);
    expect(JSON.stringify(file.pages["2026-10-14"].body)).toContain("Restored text and more");
  });
});
