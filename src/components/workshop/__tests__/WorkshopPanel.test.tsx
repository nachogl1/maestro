import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatWorkshopTime } from "@/lib/workshopReport";
import { useWorkshopStore, type WorkshopStatus } from "@/stores/useWorkshopStore";
import { WorkshopPanel } from "../WorkshopPanel";

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
    },
    running: false,
    error: null,
    load,
    select,
    run,
    ...state,
  });
}

describe("WorkshopPanel", () => {
  beforeEach(() => {
    load.mockClear();
    select.mockClear();
    run.mockClear();
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
      content: { report_html: "<p>r</p>", summary: null },
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
});
