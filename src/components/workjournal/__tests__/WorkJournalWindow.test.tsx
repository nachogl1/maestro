import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_PAGE_BODY,
  useWorkJournalStore,
  type WorkJournalFile,
  type WorkJournalPage,
} from "@/stores/useWorkJournalStore";
import { WorkJournalWindow } from "../WorkJournalWindow";

// The pop-out's close-time flush (body and title, the quit answer and the
// "Close and lose it / Keep open" guard) is tested under "WorkJournalWindow
// closing" in WorkJournalPanel.test.tsx; these cover the day list and theme.

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

/** In-memory stand-in for `work-journal.json` behind the Tauri commands. */
let file: WorkJournalFile;

function page(date: string, title: string): WorkJournalPage {
  return { date, title, body: EMPTY_PAGE_BODY, origin: "auto" };
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
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "load_work_journal" || cmd === "work_journal_ensure_pages"
        ? structuredClone(file)
        : undefined,
    );
    vi.mocked(getCurrentWindow).mockReturnValue({
      onCloseRequested: vi.fn(async () => () => {}),
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
});
