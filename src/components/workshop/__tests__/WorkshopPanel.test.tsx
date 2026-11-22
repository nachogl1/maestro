import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatWorkshopTime } from "@/lib/workshopReport";
import { usePrivacySettingsStore } from "@/stores/usePrivacySettingsStore";
import { useWorkshopStore, type WorkshopStatus } from "@/stores/useWorkshopStore";
import { WorkshopPanel } from "../WorkshopPanel";

// The privacy setting persists through the Tauri store plugin; happy-dom has
// no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

const OLDER = { id: "2026-10-11-090000", ran_at: "2026-10-11T09:00:00Z", summary_error: null };
const NEWER = { id: "2026-10-18-090000", ran_at: "2026-10-18T09:00:00Z", summary_error: null };

const STATUS: WorkshopStatus = {
  runs: [NEWER, OLDER],
  next_run_at: "2026-10-25T09:00:00Z",
  last_failure: null,
  running: false,
};

const load = vi.fn(async () => {});
const select = vi.fn(async () => {});
const run = vi.fn(async () => {});

function showStore(state: Partial<ReturnType<typeof useWorkshopStore.getState>>) {
  useWorkshopStore.setState({
    status: STATUS,
    selectedRunId: NEWER.id,
    content: {
      report_html: "<h1>Claude Code Insights</h1>",
      summary: "## At a glance\n\nA **good** week.",
      summary_cards: null,
    },
    running: false,
    error: null,
    load,
    select,
    run,
    ...state,
  });
}

/** The user's Workshop answer, as the backend confirmed it. */
function allowWorkshop(allowed: boolean | null) {
  usePrivacySettingsStore.setState({
    workshop: allowed,
    confirmed: { workshop: allowed === true, historySummaries: false },
    settingsRequested: false,
  });
}

describe("WorkshopPanel", () => {
  beforeEach(() => {
    load.mockClear();
    select.mockClear();
    run.mockClear();
    allowWorkshop(true);
  });

  it("loads the runs when it opens", () => {
    showStore({});
    render(<WorkshopPanel />);
    expect(load).toHaveBeenCalled();
  });

  it("shows when the shown run ran and when the next run is", () => {
    const nextRunAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    showStore({ status: { ...STATUS, next_run_at: nextRunAt } });
    render(<WorkshopPanel />);
    expect(screen.getByText("Ran").nextSibling).toHaveTextContent(formatWorkshopTime(NEWER.ran_at));
    expect(screen.getByText("Next run").nextSibling).toHaveTextContent(
      formatWorkshopTime(nextRunAt),
    );
  });

  it("lists every past run and switches to the one picked", () => {
    showStore({});
    render(<WorkshopPanel />);

    const runs = screen.getByLabelText("Past runs");
    expect(runs.querySelectorAll("option")).toHaveLength(2);
    fireEvent.change(runs, { target: { value: OLDER.id } });

    expect(select).toHaveBeenCalledWith(OLDER.id);
  });

  it("opens on the summary, rendered read-only", () => {
    showStore({});
    render(<WorkshopPanel />);

    expect(screen.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "At a glance" })).toBeInTheDocument();
    expect(screen.getByText("good").tagName).toBe("STRONG");
    expect(document.querySelector("[contenteditable], textarea, input[type=text]")).toBeNull();
  });

  it("draws a run with a card summary as cards, not Markdown", () => {
    const verdict = "An invented week spent on pretend widgets; plan them first.";
    showStore({
      content: {
        report_html: "<p>r</p>",
        summary: null,
        summary_cards: {
          verdict,
          problems: [],
          ideas: [],
          wins: [{ title: "Made-up win", text: "A pretend change shipped." }],
        },
      },
    });
    render(<WorkshopPanel />);

    expect(screen.getByText(verdict)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /What went well/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "At a glance" })).toBeNull();
  });

  it("shows the real report in a script-free frame on the Real Transcript tab", () => {
    showStore({});
    render(<WorkshopPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "Real Transcript" }));

    const frame = screen.getByTitle("Insights report");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Claude Code Insights</h1>");
  });

  it("explains a missing summary", () => {
    showStore({
      status: { ...STATUS, runs: [{ ...NEWER, summary_error: "summary timed out" }, OLDER] },
      content: { report_html: "<p>r</p>", summary: null, summary_cards: null },
    });
    render(<WorkshopPanel />);

    expect(screen.getByText(/summary timed out/)).toBeInTheDocument();
  });

  it("runs now on click and shows that it is running", () => {
    showStore({});
    const { rerender } = render(<WorkshopPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(run).toHaveBeenCalledWith(true);

    showStore({ running: true });
    rerender(<WorkshopPanel />);
    expect(screen.getByRole("button", { name: /Running/ })).toBeDisabled();
  });

  it("says when nothing has run yet", () => {
    showStore({
      status: { runs: [], next_run_at: null, last_failure: null, running: false },
      selectedRunId: null,
      content: null,
    });
    render(<WorkshopPanel />);

    expect(screen.getByText(/No insights yet/)).toBeInTheDocument();
    expect(screen.getByText("Due now")).toBeInTheDocument();
  });

  it("shows the last failure", () => {
    showStore({
      status: {
        ...STATUS,
        last_failure: { at: "2026-10-18T10:00:00Z", message: "claude not found" },
      },
    });
    render(<WorkshopPanel />);

    expect(screen.getByRole("alert")).toHaveTextContent("claude not found");
  });

  it.each([
    ["unanswered", null],
    ["switched off", false],
  ])("while the Workshop is %s, says how to turn it on and still shows the saved report", (_case, choice) => {
    allowWorkshop(choice);
    showStore({});
    render(<WorkshopPanel />);

    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(
      screen.getByText(
        "Workshop is off, so no report is made. Claude would read the past week's " +
          "conversations to write it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "At a glance" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Turn it on in Settings → Privacy" }));
    expect(usePrivacySettingsStore.getState().settingsRequested).toBe(true);
  });

  it("shows no off notice while the Workshop is on", () => {
    showStore({});
    render(<WorkshopPanel />);

    expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
    expect(screen.queryByText(/Workshop is off/)).toBeNull();
  });
});
