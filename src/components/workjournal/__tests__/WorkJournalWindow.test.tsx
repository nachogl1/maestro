import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PAGE_BODY,
  retryWorkJournalSaves,
  useWorkJournalStore,
  type WorkJournalFile,
  type WorkJournalPage,
} from "@/stores/useWorkJournalStore";
import { WorkJournalWindow } from "../WorkJournalWindow";

// The pane's own behaviour (saving, restore, the other window's changes and
// the close-time flush of body and title) is tested in WorkJournalPanel.test.tsx;
// these cover what the pop-out window root adds around it.

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  emitTo: vi.fn(() => Promise.resolve()),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: vi.fn(),
  getCurrentWebviewWindow: vi.fn(() => ({ label: "work-journal" })),
}));

// Has its own tests; here it would add reads and listeners.
vi.mock("../WorkJournalBackupReminder", () => ({
  WorkJournalBackupReminder: () => <div data-testid="backup-reminder" />,
}));

const invokeMock = vi.mocked(invoke);
const askMock = vi.mocked(ask);

/** In-memory stand-in for `work-journal.json` behind the Tauri commands. */
let file: WorkJournalFile;

/** The window's close-requested handler, as the window API would call it. */
let closeRequested: (event: { preventDefault: () => void }) => Promise<void>;
const destroy = vi.fn(async () => {});

function page(date: string, title: string): WorkJournalPage {
  return { date, title, body: EMPTY_PAGE_BODY, origin: "auto" };
}

/** Routes the page commands the window uses, mutating `file`. */
function mockBackend(): void {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "load_work_journal":
      case "work_journal_ensure_pages":
        return structuredClone(file);
      case "update_work_journal_page": {
        const saved = file.pages[a.date as string];
        if (a.title != null) saved.title = a.title as string;
        if (a.body != null) saved.body = a.body as WorkJournalPage["body"];
        return structuredClone(file);
      }
      default:
        return undefined;
    }
  });
}

/** The TipTap editor behind the page body (TipTap puts it on its DOM node). */
function pageEditor(): Editor {
  const dom = screen.getByLabelText("Work Journal page") as HTMLElement & { editor: Editor };
  return dom.editor;
}

describe("WorkJournalWindow", () => {
  beforeEach(() => {
    // Wed 14 Oct 2026, 10:00 local. shouldAdvanceTime keeps findBy* working.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0));
    file = {
      layout_version: 1,
      pages: {
        "2026-10-12": page("2026-10-12", "Mon 12 Oct 2026"),
        "2026-10-14": page("2026-10-14", "Wed 14 Oct 2026"),
      },
      deleted_dates: [],
      last_auto_created_date: "2026-10-14",
      settings: {},
    };
    invokeMock.mockReset();
    askMock.mockReset();
    destroy.mockClear();
    mockBackend();
    closeRequested = async () => {};
    vi.mocked(getCurrentWindow).mockReturnValue({
      onCloseRequested: vi.fn(async (handler: typeof closeRequested) => {
        closeRequested = handler;
        return () => {};
      }),
      destroy,
    } as unknown as ReturnType<typeof getCurrentWindow>);
    useWorkJournalStore.setState({ pages: {}, viewedDate: null, loading: false, error: null });
    localStorage.removeItem("maestro-theme");
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem("maestro-theme");
  });

  it("shows the page of the day picked in the day list", async () => {
    render(<WorkJournalWindow />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    const days = screen.getByRole("navigation", { name: "Days" });

    fireEvent.click(within(days).getByRole("button", { name: /Mon 12 Oct 2026/ }));

    expect(screen.getByLabelText("Page title")).toHaveValue("Mon 12 Oct 2026");
    expect(within(days).getByRole("button", { name: /Mon 12 Oct 2026/ })).toHaveAttribute(
      "aria-current",
      "date",
    );
    expect(within(days).getByRole("button", { name: /Wed 14 Oct 2026/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("follows the app's theme setting, also when the main window changes it", async () => {
    localStorage.setItem("maestro-theme", "light");
    render(<WorkJournalWindow />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    // The main window switched to dark: the browser tells this window.
    act(() => {
      localStorage.setItem("maestro-theme", "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: "maestro-theme" }));
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("uses the dark theme when no theme is stored", async () => {
    render(<WorkJournalWindow />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("asks Close and lose it or Keep open while a save still fails, and Keep open keeps it", async () => {
    render(<WorkJournalWindow />);
    await screen.findByDisplayValue("Wed 14 Oct 2026");
    const backend = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "update_work_journal_page") throw new Error("disk full");
      return backend?.(cmd, args);
    });
    act(() => {
      pageEditor().commands.insertContent("Not saved yet");
    });

    askMock.mockResolvedValueOnce(false);
    const preventDefault = vi.fn();
    await act(async () => closeRequested({ preventDefault }));

    expect(askMock).toHaveBeenCalledTimes(1);
    expect(askMock).toHaveBeenCalledWith(
      expect.stringContaining("Some Work Journal text is not saved yet"),
      expect.objectContaining({
        title: "Unsaved Work Journal Text",
        kind: "warning",
        okLabel: "Close and lose it",
        cancelLabel: "Keep open",
      }),
    );
    expect(preventDefault).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(screen.getByText(/Unsaved changes, retrying/)).toBeInTheDocument();

    // Leaves the store clean for the next test.
    invokeMock.mockImplementation(backend ?? (async () => undefined));
    await act(async () => {
      await retryWorkJournalSaves();
    });
  });
});
