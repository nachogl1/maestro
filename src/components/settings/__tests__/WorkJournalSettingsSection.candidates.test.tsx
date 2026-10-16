import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalBackupStore } from "@/stores/useWorkJournalBackupStore";
import {
  CATCH_UP_TRUNCATED_NOTICE,
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

  it("shows the refusal and keeps the saved model when the model name is invalid", async () => {
    const refusal =
      'The Work Journal model "claude opus" is not a valid model name. Change it in Settings or leave it blank for your default model.';
    routeInvoke({
      load_work_journal: () => journal({ model: "sonnet" }),
      update_work_journal_settings: () => {
        throw refusal;
      },
    });
    await useWorkJournalCandidateRunStore.getState().load();
    render(<WorkJournalSettingsSection />);
    const input = screen.getByLabelText("Model");

    fireEvent.change(input, { target: { value: "claude opus" } });
    fireEvent.blur(input);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Could not save the model: ${refusal}`,
    );
    expect(useWorkJournalCandidateRunStore.getState().model).toBe("sonnet");
    expect(input).toHaveValue("claude opus");
  });

  it("keeps a refused model warning after another setting saves", async () => {
    const refusal = 'The Work Journal model "claude opus" is not a valid model name.';
    routeInvoke({
      load_work_journal: () => journal({ model: "sonnet" }),
      update_work_journal_settings: (args) => {
        const settings = (args as { settings: WorkJournalCandidateRunSettings }).settings;
        if (settings.model !== undefined) throw refusal;
        return journal({ model: "sonnet", ...settings });
      },
    });
    await useWorkJournalCandidateRunStore.getState().load();
    render(<WorkJournalSettingsSection />);
    const model = screen.getByLabelText("Model");

    fireEvent.change(model, { target: { value: "claude opus" } });
    fireEvent.blur(model);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Could not save the model: ${refusal}`,
    );

    const hours = screen.getByLabelText("Run every");
    fireEvent.change(hours, { target: { value: "3" } });
    fireEvent.blur(hours);
    await waitFor(() => expect(useWorkJournalCandidateRunStore.getState().runEveryHours).toBe(3));

    expect(useWorkJournalCandidateRunStore.getState().settingsError).toBeNull();
    expect(model).toHaveValue("claude opus");
    expect(screen.getByRole("alert")).toHaveTextContent(
      `Could not save the model: ${refusal} Runs still use "sonnet".`,
    );

    fireEvent.change(model, { target: { value: "claude-opus" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("runs with the open projects' paths and shows the new last run time", async () => {
    const lastRunAt = "2026-10-15T12:34:00Z";
    const lastAttemptAt = "2026-10-15T12:33:00Z";
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

    finish({ status: "ran", added: 2, dates: ["2026-10-15"], lastRunAt, lastAttemptAt });

    expect(
      await screen.findByText(
        `Last run: ${shownTime(lastAttemptAt)} (covered up to ${shownTime(lastRunAt)})`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a failed run in the section's error line, with when it ran and how far it got", async () => {
    const lastRunAt = "2026-10-15T00:00:00Z";
    const lastAttemptAt = "2026-10-15T14:00:00Z";
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () => ({
        status: "failed",
        message: "Candidate run for 2026-10-15 failed: claude did not answer within 180s",
        added: 1,
        dates: ["2026-10-14"],
        lastRunAt,
        lastAttemptAt,
      }),
    });
    render(<WorkJournalSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Candidate run for 2026-10-15 failed: claude did not answer within 180s",
    );
    expect(
      screen.getByText(
        `Last run: ${shownTime(lastAttemptAt)} (covered up to ${shownTime(lastRunAt)})`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(CATCH_UP_TRUNCATED_NOTICE)).toBeNull();
  });

  it("says when a catch-up skipped days older than the 7-day limit", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () => ({
        status: "ran",
        added: 0,
        dates: [],
        lastRunAt: "2026-10-15T12:00:00Z",
        lastAttemptAt: "2026-10-15T12:00:00Z",
        truncatedFrom: "2026-10-05T09:00:00Z",
      }),
    });
    render(<WorkJournalSettingsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Run now" }));

    expect(await screen.findByText(CATCH_UP_TRUNCATED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a command error and clears it after the next good run", async () => {
    let fail = true;
    routeInvoke({
      load_work_journal: () => journal({}),
      work_journal_run_candidates: () => {
        if (fail) throw new Error("journal locked");
        return {
          status: "ran",
          added: 0,
          dates: [],
          lastRunAt: "2026-10-15T13:00:00Z",
          lastAttemptAt: "2026-10-15T13:00:00Z",
        };
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

    outcome = {
      status: "ran",
      added: 0,
      dates: [],
      lastRunAt: "2026-10-15T13:00:00Z",
      lastAttemptAt: "2026-10-15T13:00:00Z",
    };
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
      lastAttemptAt: "2026-10-15T08:00:00Z",
    });

    await useWorkJournalBackupStore.getState().restore();

    const state = useWorkJournalCandidateRunStore.getState();
    expect(state.runEveryHours).toBe(4);
    expect(state.model).toBe("haiku");
    expect(state.lastRunAt).toBeNull();
    expect(state.lastAttemptAt).toBeNull();
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
    expect(
      screen.getByText(
        `Last run: not recorded (covered up to ${shownTime("2026-10-15T08:00:00Z")})`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reads the last run's start time from the journal", async () => {
    routeInvoke({
      load_work_journal: () =>
        journal({
          last_run_at: "2026-10-15T00:00:00Z",
          last_attempt_at: "2026-10-15T15:00:00Z",
        }),
    });
    useWorkJournalCandidateRunStore.setState({ settingsError: "Could not read the run settings" });

    render(<WorkJournalSettingsSection />);

    expect(
      await screen.findByText(
        `Last run: ${shownTime("2026-10-15T15:00:00Z")} (covered up to ${shownTime("2026-10-15T00:00:00Z")})`,
      ),
    ).toBeInTheDocument();
  });

  it("leaves out the covered-up-to time when it reads the same as the start time", async () => {
    routeInvoke({
      load_work_journal: () =>
        journal({
          last_run_at: "2026-10-15T15:00:10Z",
          last_attempt_at: "2026-10-15T15:00:00Z",
        }),
    });
    useWorkJournalCandidateRunStore.setState({ settingsError: "Could not read the run settings" });

    render(<WorkJournalSettingsSection />);

    expect(
      await screen.findByText(`Last run: ${shownTime("2026-10-15T15:00:00Z")}`),
    ).toBeInTheDocument();
    expect(screen.queryByText(/covered up to/)).toBeNull();
  });
});

describe("WorkJournalSettingsSection Granola row", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkJournalBackupStore.setState(BACKUP_INITIAL, true);
    useWorkJournalCandidateRunStore.setState(RUN_INITIAL, true);
  });

  function granolaSelect(): HTMLSelectElement {
    return screen.getByLabelText("Granola meeting notes") as HTMLSelectElement;
  }

  it("shows Not asked yet until a choice is made, then saves only granola_opt_in", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      update_work_journal_settings: (args) =>
        journal((args as { settings: WorkJournalCandidateRunSettings }).settings),
    });
    render(<WorkJournalSettingsSection />);

    expect(granolaSelect()).toHaveValue("unset");
    expect(screen.getByRole("option", { name: "Not asked yet" })).toBeDisabled();

    fireEvent.change(granolaSelect(), { target: { value: "yes" } });
    await waitFor(() => expect(granolaSelect()).toHaveValue("yes"));
    expect(screen.queryByRole("option", { name: "Not asked yet" })).toBeNull();

    fireEvent.change(granolaSelect(), { target: { value: "no" } });
    await waitFor(() => expect(granolaSelect()).toHaveValue("no"));

    expect(settingsPatches()).toEqual([
      { settings: { granola_opt_in: true } },
      { settings: { granola_opt_in: false } },
    ]);
  });

  it.each([
    [true, "yes"],
    [false, "no"],
  ])("shows a saved choice of %s", async (optIn, shown) => {
    routeInvoke({ load_work_journal: () => journal({ granola_opt_in: optIn }) });
    await useWorkJournalCandidateRunStore.getState().load();
    render(<WorkJournalSettingsSection />);
    expect(granolaSelect()).toHaveValue(shown);
    expect(screen.queryByRole("option", { name: "Not asked yet" })).toBeNull();
  });

  it("shows an error and keeps the choice when the save fails", async () => {
    routeInvoke({
      load_work_journal: () => journal({}),
      update_work_journal_settings: () => {
        throw new Error("disk full");
      },
    });
    render(<WorkJournalSettingsSection />);

    fireEvent.change(granolaSelect(), { target: { value: "yes" } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save the Granola choice: disk full",
    );
    expect(granolaSelect()).toHaveValue("unset");
  });
});
