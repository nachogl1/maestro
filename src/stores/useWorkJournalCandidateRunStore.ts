import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** Hours between candidate runs when the setting is absent. */
export const DEFAULT_RUN_EVERY_HOURS = 1;

/** The largest "run every X hours" the setting accepts. */
export const MAX_RUN_EVERY_HOURS = 24;

/** The Work Journal settings keys the candidate run uses; other keys stay opaque here. */
export interface WorkJournalCandidateRunSettings {
  run_every_hours?: number | null;
  model?: string | null;
  last_run_at?: string | null;
  /** Whether runs may read Granola meeting notes; absent means not asked yet. */
  granola_opt_in?: boolean | null;
}

/** The part of `work-journal.json` (as the backend returns it) the candidate run reads. */
export interface WorkJournalCandidateRunFile {
  settings: WorkJournalCandidateRunSettings;
}

/** What `work_journal_run_candidates` did, tagged by `status`. */
export type CandidateRunOutcome =
  | { status: "ran"; added: number; dates: string[]; lastRunAt: string }
  | { status: "busy" }
  | { status: "no_projects" }
  | { status: "failed"; message: string; added: number; dates: string[]; lastRunAt: string };

/** Shown when a run is asked for while another one is going. */
export const RUN_BUSY_NOTICE = "A run is already in progress.";

/** Shown when a run is asked for before any project was opened (nothing is collected then). */
export const RUN_NO_PROJECTS_NOTICE =
  "No project has been opened in Maestro yet, so there was nothing to look at.";

export interface WorkJournalCandidateRunState {
  /** Hours between runs while Maestro is open (1–24). */
  runEveryHours: number;
  /** Model for the runs; "" means the user's default Claude model. */
  model: string;
  /** RFC 3339 time the last run's window ended; null when never. */
  lastRunAt: string | null;
  /** The Granola opt-in: true = yes, false = no, null = not asked yet. */
  granolaOptIn: boolean | null;
  /** True once the settings were read (or saved) at least once. */
  settingsLoaded: boolean;
  /** True while a run started from here is going. */
  running: boolean;
  /** The last run failure; cleared by a successful run. */
  runError: string | null;
  /** Why the last request did not run (busy, no project open); cleared by the next run. */
  runNotice: string | null;
  /** The last failure to read or save the run settings; cleared on success. */
  settingsError: string | null;
  /** The open projects' paths, kept current by the background timer for "Run now". */
  projects: string[];
  /** When the background timer's next interval run fires (epoch ms); null when not scheduled. */
  nextRunAt: number | null;
  /** True while the start-up catch-up run is still waiting to fire. */
  catchUpPending: boolean;
  /** Replaces `projects`. */
  setProjects: (projects: string[]) => void;
  /** Records what the background timer has scheduled. */
  setSchedule: (schedule: { nextRunAt?: number | null; catchUpPending?: boolean }) => void;
  /** Reads the run settings from the journal file. */
  load: () => Promise<void>;
  /** Takes the run settings from a journal the backend just returned (restore, undo). */
  applySettings: (journal: WorkJournalCandidateRunFile) => void;
  /** One candidate run over `projects` (their paths); skipped while one is running. */
  runNow: (projects: string[]) => Promise<void>;
  /** Saves "run every X hours"; values outside 1–24 are clamped, non-numbers ignored. */
  setRunEveryHours: (hours: number) => Promise<void>;
  /** Saves the model; blank means the user's default model. */
  setModel: (model: string) => Promise<void>;
  /** Saves the Granola opt-in (Yes or No). */
  setGranolaOptIn: (optIn: boolean) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "Run every X hours" as used: absent or invalid is the default, otherwise 1–24 whole hours. */
export function clampRunEveryHours(hours: number | null | undefined): number {
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 1) {
    return DEFAULT_RUN_EVERY_HOURS;
  }
  return Math.min(Math.round(hours), MAX_RUN_EVERY_HOURS);
}

function fromJournal(
  journal: WorkJournalCandidateRunFile,
): Pick<
  WorkJournalCandidateRunState,
  "runEveryHours" | "model" | "lastRunAt" | "granolaOptIn" | "settingsLoaded"
> {
  const granolaOptIn = journal.settings.granola_opt_in;
  return {
    runEveryHours: clampRunEveryHours(journal.settings.run_every_hours),
    model: journal.settings.model ?? "",
    lastRunAt: journal.settings.last_run_at || null,
    granolaOptIn: typeof granolaOptIn === "boolean" ? granolaOptIn : null,
    settingsLoaded: true,
  };
}

/** Patches only the keys sent (the backend shallow-merges them). */
async function patchSettings(
  settings: WorkJournalCandidateRunSettings,
): Promise<WorkJournalCandidateRunFile> {
  return invoke<WorkJournalCandidateRunFile>("update_work_journal_settings", { settings });
}

/**
 * Candidate-run state for the Work Journal settings section, shared with the
 * app's background timer (`useWorkJournalCandidateTimer`). The journal file
 * stays the source of truth; the backend reads the window and model itself.
 */
export const useWorkJournalCandidateRunStore = create<WorkJournalCandidateRunState>((set, get) => ({
  runEveryHours: DEFAULT_RUN_EVERY_HOURS,
  model: "",
  lastRunAt: null,
  granolaOptIn: null,
  settingsLoaded: false,
  running: false,
  runError: null,
  runNotice: null,
  settingsError: null,
  projects: [],
  nextRunAt: null,
  catchUpPending: false,

  setProjects: (projects: string[]) => set({ projects }),

  setSchedule: (schedule) => set(schedule),

  applySettings: (journal: WorkJournalCandidateRunFile) =>
    set({ ...fromJournal(journal), settingsError: null }),

  load: async () => {
    try {
      const journal = await invoke<WorkJournalCandidateRunFile>("load_work_journal");
      set({ ...fromJournal(journal), settingsError: null });
    } catch (error) {
      console.error("Failed to load the Work Journal run settings:", error);
      set({ settingsError: `Could not read the run settings: ${errorMessage(error)}` });
    }
  },

  runNow: async (projects: string[]) => {
    if (get().running) return;
    set({ running: true });
    try {
      const outcome = await invoke<CandidateRunOutcome>("work_journal_run_candidates", {
        projects,
      });
      if (outcome?.status === "ran") {
        set({ lastRunAt: outcome.lastRunAt, runError: null, runNotice: null });
      } else if (outcome?.status === "failed") {
        set({ lastRunAt: outcome.lastRunAt, runError: outcome.message, runNotice: null });
      } else if (outcome?.status === "busy") {
        set({ runNotice: RUN_BUSY_NOTICE });
      } else if (outcome?.status === "no_projects") {
        set({ runNotice: RUN_NO_PROJECTS_NOTICE });
      }
    } catch (error) {
      console.error("Work Journal candidate run failed:", error);
      set({ runError: `Candidate run failed: ${errorMessage(error)}`, runNotice: null });
    } finally {
      set({ running: false });
    }
  },

  setRunEveryHours: async (hours: number) => {
    if (!Number.isFinite(hours)) return;
    const value = clampRunEveryHours(hours);
    try {
      const journal = await patchSettings({ run_every_hours: value });
      set({ ...fromJournal(journal), settingsError: null });
    } catch (error) {
      console.error("Failed to save the Work Journal run interval:", error);
      set({ settingsError: `Could not save the run interval: ${errorMessage(error)}` });
    }
  },

  setModel: async (model: string) => {
    const value = model.trim();
    try {
      const journal = await patchSettings({ model: value === "" ? null : value });
      set({ ...fromJournal(journal), settingsError: null });
    } catch (error) {
      console.error("Failed to save the Work Journal model:", error);
      set({ settingsError: `Could not save the model: ${errorMessage(error)}` });
    }
  },

  setGranolaOptIn: async (optIn: boolean) => {
    try {
      const journal = await patchSettings({ granola_opt_in: optIn });
      set({ ...fromJournal(journal), settingsError: null });
    } catch (error) {
      console.error("Failed to save the Work Journal Granola choice:", error);
      set({ settingsError: `Could not save the Granola choice: ${errorMessage(error)}` });
    }
  },
}));
