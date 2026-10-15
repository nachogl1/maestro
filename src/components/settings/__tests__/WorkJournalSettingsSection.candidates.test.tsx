import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import {
  type CandidateRunOutcome,
  RUN_BUSY_NOTICE,
  RUN_NO_PROJECTS_NOTICE,
  useWorkJournalCandidateRunStore,
  type WorkJournalCandidateRunSettings,
} from "@/stores/useWorkJournalCandidateRunStore";
import { WorkJournalSettingsSection } from "../WorkJournalSettingsSection";

const invokeMock = vi.mocked(invoke);

const BACKUP_INITIAL = useWorkJournalBackupStore.getState();
const RUN_INITIAL = useWorkJournalCandidateRunStore.getState();

function journal(settings: WorkJournalCandidateRunSettings) {
  return { layout_version: 1, pages: {}, deleted_dates: [], settings };
}

/**
 * Routes `invoke` by command name; each handler returns the reply or throws.
 * The restore-state read the section makes on mount answers "nothing to undo".
 */
function routeInvoke(handlers: Record<string, (args?: unknown) => unknown>): void {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    const handler =
      handlers[cmd] ??
      (cmd === "work_journal_restore_state" ? () => ({ canUndo: false }) : undefined);
    if (!handler) throw new Error(`unexpected command ${cmd}`);
    return handler(args);
  });
}

function shownTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function settingsPatches(): unknown[] {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "update_work_journal_settings")
    .map(([, args]) => args);
}

describe("WorkJournalSettingsSection candidate run rows", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkJournalBackupStore.setState(BACKUP_INITIAL, true);
    useWorkJournalCandidateRunStore.setState(RUN_INITIAL, true);
  });

  it("shows the defaults and never when nothing is set", async () => {
    routeInvoke({ load_work_journal: () => journal({}) });

    render(<WorkJournalSettingsSection />);

    expect(await screen.findByText("Never backed up")).toBeInTheDocument();
    expect(screen.getByLabelText("Run every")).toHaveValue(1);
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.getByLabelText("Model")).toHaveAttribute(
      "placeholder",
      "Your default Claude model",
    );
    expect(screen.getByText("Last run: never")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
  });

  it("patches only run_every_hours, clamped to 1-24", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      update_work_journal_settings: (args) =>
        journal((args as { settings: WorkJournalCandidateRunSettings }).settings),
    });
    render(<WorkJournalSettingsSection />);
    const input = screen.getByLabelText("Run every");

    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue(2));

    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue(24));

    expect(settingsPatches()).toEqual([
      { settings: { run_every_hours: 2 } },
      { settings: { run_every_hours: 24 } },
    ]);
    expect(useWorkJournalCandidateRunStore.getState().runEveryHours).toBe(24);
  });

  it("restores the value and saves nothing when the hours field is cleared", async () => {
    routeInvoke({ load_work_journal: () => journal({}) });
    useWorkJournalCandidateRunStore.setState({ runEveryHours: 3 });
    render(<WorkJournalSettingsSection />);
    const input = screen.getByLabelText("Run every");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(input).toHaveValue(3);
    expect(settingsPatches()).toEqual([]);
  });

  it("patches only model, and sends null for a blank model", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      update_work_journal_settings: (args) =>
        journal((args as { settings: WorkJournalCandidateRunSettings }).settings),
    });
    render(<WorkJournalSettingsSection />);
    const input = screen.getByLabelText("Model");

    fireEvent.change(input, { target: { value: " sonnet " } });
    fireEvent.blur(input);
    await waitFor(() => expect(useWorkJournalCandidateRunStore.getState().model).toBe("sonnet"));

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    await waitFor(() => expect(useWorkJournalCandidateRunStore.getState().model).toBe(""));

    expect(settingsPatches()).toEqual([
      { settings: { model: "sonnet" } },
      { settings: { model: null } },
    ]);
  });

  it("runs with the open projects' paths and shows the new last run time", async () => {
    const lastRunAt = "2026-10-15T12:34:00Z";
    let finish: (outcome: CandidateRunOutcome) => void = () => {};
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () =>
        new Promise<CandidateRunOutcome>((resolve) => {
          finish = resolve;
        }),
    });
    useWorkJournalCandidateRunStore.setState({ projects: ["C:\\git\\a", "C:\\git\\b\\repo"] });
    render(<WorkJournalSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled());
    expect(invokeMock).toHaveBeenCalledWith("work_journal_run_candidates", {
      projects: ["C:\\git\\a", "C:\\git\\b\\repo"],
    });

    finish({ status: "ran", added: 2, dates: ["2026-10-15"], lastRunAt });

    expect(await screen.findByText(`Last run: ${shownTime(lastRunAt)}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed run in the section's error line, with the time it got to", async () => {
    const lastRunAt = "2026-10-15T00:00:00Z";
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () => ({
        status: "failed",
        message: "Candidate run for 2026-10-15 failed: claude did not answer within 180s",
        added: 1,
        dates: ["2026-10-14"],
        lastRunAt,
      }),
    });
    render(<WorkJournalSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Candidate run for 2026-10-15 failed: claude did not answer within 180s",
    );
    expect(screen.getByText(`Last run: ${shownTime(lastRunAt)}`)).toBeInTheDocument();
  });

  it("shows a command error and clears it after the next good run", async () => {
    let fail = true;
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () => {
        if (fail) throw new Error("journal locked");
        return { status: "ran", added: 0, dates: [], lastRunAt: "2026-10-15T13:00:00Z" };
      },
    });
    render(<WorkJournalSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Candidate run failed: journal locked",
    );

    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says so when another run is busy, and leaves the rest alone", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () => ({ status: "busy" }),
    });
    render(<WorkJournalSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    expect(await screen.findByText(RUN_BUSY_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
    expect(screen.getByText("Last run: never")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when no project is open, and the next good run clears it", async () => {
    let outcome: CandidateRunOutcome = { status: "no_projects" };
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () => outcome,
    });
    render(<WorkJournalSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByText(RUN_NO_PROJECTS_NOTICE)).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("work_journal_run_candidates", { projects: [] });
    expect(screen.getByText("Last run: never")).toBeInTheDocument();

    outcome = { status: "ran", added: 0, dates: [], lastRunAt: "2026-10-15T13:00:00Z" };
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(screen.queryByText(RUN_NO_PROJECTS_NOTICE)).toBeNull());
  });

  it("shows the clamped value when the typed hours clamp to the current setting", async () => {
    routeInvoke({ load_work_journal: () => journal({}) });
    render(<WorkJournalSettingsSection />);
    const input = screen.getByLabelText("Run every");

    for (const typed of ["0", "-5", "1.4"]) {
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.blur(input);
      expect(input).toHaveValue(1);
    }
    expect(settingsPatches()).toEqual([]);
  });

  it("takes the run settings from a restored journal", async () => {
    routeInvoke({
      restore_work_journal: () => ({
        journal: journal({ run_every_hours: 4, model: "haiku" }),
        canUndo: true,
        autoBackup: "no_folder",
      }),
    });
    useWorkJournalCandidateRunStore.setState({
      runEveryHours: 1,
      model: "",
      lastRunAt: "2026-10-15T08:00:00Z",
    });

    await useWorkJournalBackupStore.getState().restore();

    const state = useWorkJournalCandidateRunStore.getState();
    expect(state.runEveryHours).toBe(4);
    expect(state.model).toBe("haiku");
    expect(state.lastRunAt).toBeNull();
  });

  it("clears an earlier notice when a run then fails", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () => {
        throw new Error("journal locked");
      },
    });
    useWorkJournalCandidateRunStore.setState({ runNotice: RUN_BUSY_NOTICE });
    render(<WorkJournalSettingsSection />);
    expect(screen.getByText(RUN_BUSY_NOTICE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("journal locked");
    expect(screen.queryByText(RUN_BUSY_NOTICE)).toBeNull();
  });

  it("retries reading the run settings on open after the start-up read failed", async () => {
    routeInvoke({
      load_work_journal: () =>
        journal({ run_every_hours: 6, model: "haiku", last_run_at: "2026-10-15T08:00:00Z" }),
    });
    useWorkJournalCandidateRunStore.setState({ settingsError: "Could not read the run settings" });

    render(<WorkJournalSettingsSection />);

    await waitFor(() => expect(screen.getByLabelText("Run every")).toHaveValue(6));
    expect(screen.getByLabelText("Model")).toHaveValue("haiku");
    expect(screen.getByText(`Last run: ${shownTime("2026-10-15T08:00:00Z")}`)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
