import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("jumps to a date and offers to create a page when it has none", async () => {
    render(<WorkJournalPanel />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");

    fireEvent.click(screen.getByRole("button", { name: "Jump to date" }));
    fireEvent.change(screen.getByLabelText("Date to jump to"), {
      target: { value: "2026-10-01" },
    });

    expect(screen.getByText("No page for Thu 1 Oct 2026.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create a page for this day" }));
    expect(await screen.findByDisplayValue("Thu 1 Oct 2026")).toBeInTheDocument();
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
