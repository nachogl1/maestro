import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalReportStore } from "@/stores/useWorkJournalReportStore";
import { NOTHING_TO_REPORT, RANGE_REVERSED, ReportDialog } from "../ReportDialog";

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);
const revealMock = vi.mocked(revealItemInDir);

const INITIAL_STATE = useWorkJournalReportStore.getState();
const FOLDER = "D:\\Reports";
const SAVED = `${FOLDER}\\work-report_2026-10-09_to_2026-10-15.html`;

/** Routes `invoke` by command name; `folder` is the stored report folder. */
function routeInvoke(folder: string | null, generate: () => unknown): void {
  let stored = folder;
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "load_work_journal":
        return { settings: stored ? { report_folder: stored } : {} };
      case "update_work_journal_settings": {
        const settings = (args as { settings: { report_folder: string } }).settings;
        stored = settings.report_folder;
        return { settings: { report_folder: stored } };
      }
      case "work_journal_generate_report":
        return generate();
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
}

function commands(): string[] {
  return invokeMock.mock.calls.map(([cmd]) => cmd);
}

function generateButton(): HTMLElement {
  return screen.getByRole("button", { name: "Generate" });
}

describe("ReportDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Thu 15 Oct 2026, 10:00 local.
    vi.setSystemTime(new Date(2026, 9, 15, 10, 0, 0));
    invokeMock.mockReset();
    openMock.mockReset();
    revealMock.mockClear();
    useWorkJournalReportStore.setState(INITIAL_STATE, true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to the last seven days ending today", () => {
    routeInvoke(FOLDER, () => ({ status: "nothing_to_report" }));
    render(<ReportDialog onClose={vi.fn()} />);

    expect(screen.getByLabelText("From date")).toHaveValue("2026-10-09");
    expect(screen.getByLabelText("To date")).toHaveValue("2026-10-15");
    expect(generateButton()).toBeEnabled();
  });

  it("refuses a start date after the end date", () => {
    routeInvoke(FOLDER, () => ({ status: "saved", path: SAVED }));
    render(<ReportDialog onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-10-16" } });

    expect(screen.getByText(RANGE_REVERSED)).toBeInTheDocument();
    expect(generateButton()).toBeDisabled();
    fireEvent.click(generateButton());
    expect(commands()).not.toContain("work_journal_generate_report");
  });

  it("asks for the folder before the first report, saves it, then generates", async () => {
    routeInvoke(null, () => ({ status: "saved", path: SAVED }));
    openMock.mockResolvedValue(FOLDER);
    render(<ReportDialog onClose={vi.fn()} />);

    fireEvent.click(generateButton());

    expect(await screen.findByText(`Saved to ${SAVED}`)).toBeInTheDocument();
    expect(openMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    // Only the report folder key is patched.
    expect(invokeMock).toHaveBeenCalledWith("update_work_journal_settings", {
      settings: { report_folder: FOLDER },
    });
    expect(invokeMock).toHaveBeenCalledWith("work_journal_generate_report", {
      from: "2026-10-09",
      to: "2026-10-15",
    });
    const order = commands();
    expect(order.indexOf("update_work_journal_settings")).toBeLessThan(
      order.indexOf("work_journal_generate_report"),
    );
    expect(useWorkJournalReportStore.getState().reportFolder).toBe(FOLDER);

    fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(revealMock).toHaveBeenCalledWith(SAVED));
  });

  it("generates nothing when the folder picker is cancelled", async () => {
    routeInvoke(null, () => ({ status: "saved", path: SAVED }));
    openMock.mockResolvedValue(null);
    render(<ReportDialog onClose={vi.fn()} />);

    fireEvent.click(generateButton());

    await waitFor(() => expect(openMock).toHaveBeenCalled());
    await waitFor(() => expect(generateButton()).toBeEnabled());
    expect(commands()).not.toContain("update_work_journal_settings");
    expect(commands()).not.toContain("work_journal_generate_report");
    expect(screen.queryByText(/Saved to/)).toBeNull();
  });

  it("uses the chosen folder without asking again", async () => {
    routeInvoke(FOLDER, () => ({ status: "saved", path: SAVED }));
    render(<ReportDialog onClose={vi.fn()} />);

    fireEvent.click(generateButton());

    expect(await screen.findByText(`Saved to ${SAVED}`)).toBeInTheDocument();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("says when there is nothing to report", async () => {
    routeInvoke(FOLDER, () => ({ status: "nothing_to_report" }));
    render(<ReportDialog onClose={vi.fn()} />);

    fireEvent.click(generateButton());

    expect(await screen.findByText(NOTHING_TO_REPORT)).toBeInTheDocument();
    expect(screen.queryByText(/Saved to/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open folder" })).toBeNull();
  });

  it("shows an error in plain words", async () => {
    routeInvoke(FOLDER, () => {
      throw "Claude could not write the report: claude did not answer within 300s";
    });
    render(<ReportDialog onClose={vi.fn()} />);

    fireEvent.click(generateButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The report could not be made: Claude could not write the report: claude did not answer within 300s",
    );
    expect(screen.queryByText(/Saved to/)).toBeNull();
    expect(generateButton()).toBeEnabled();
  });

  it("says when another report is still being made", async () => {
    routeInvoke(FOLDER, () => ({ status: "busy" }));
    render(<ReportDialog onClose={vi.fn()} />);

    fireEvent.click(generateButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("already being made");
  });

  it("closes on Cancel and on Escape", () => {
    routeInvoke(FOLDER, () => ({ status: "nothing_to_report" }));
    const onClose = vi.fn();
    render(<ReportDialog onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
