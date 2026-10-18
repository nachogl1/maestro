import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** One kept `/insights` run (backend `WorkshopRun`). */
export interface WorkshopRun {
  id: string;
  /** RFC 3339, when the run started. */
  ran_at: string;
  /** Why the run has no summary; the report is kept anyway. */
  summary_error: string | null;
}

/** A run that produced no report. */
export interface WorkshopFailure {
  at: string;
  message: string;
}

/** What `workshop_status` returns. */
export interface WorkshopStatus {
  /** Newest first. */
  runs: WorkshopRun[];
  /** RFC 3339; null = never run, due now. */
  next_run_at: string | null;
  last_failure: WorkshopFailure | null;
  running: boolean;
}

/** What `workshop_read` returns for one run. */
export interface WorkshopRunContent {
  report_html: string;
  summary: string | null;
}

/** What `workshop_run` did, tagged by `status`. */
export type WorkshopRunOutcome =
  | { status: "ran"; run: WorkshopRun }
  | { status: "not_due"; next_run_at: string }
  | { status: "busy" }
  | { status: "failed"; message: string };

export interface WorkshopState {
  status: WorkshopStatus | null;
  /** The run shown; null before the first run. */
  selectedRunId: string | null;
  /** The shown run's report and summary. */
  content: WorkshopRunContent | null;
  /** True while a run started from here is going. */
  running: boolean;
  /** The last failure to run or read; cleared by the next success. */
  error: string | null;
  /** Reads the status and the shown run (the newest unless another was picked). */
  load: () => Promise<void>;
  /** Shows run `id`. */
  select: (id: string) => Promise<void>;
  /** One run: when due, or now with `force`; shows the new run when there is one. */
  run: (force: boolean) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useWorkshopStore = create<WorkshopState>((set, get) => ({
  status: null,
  selectedRunId: null,
  content: null,
  running: false,
  error: null,

  load: async () => {
    try {
      const status = await invoke<WorkshopStatus>("workshop_status");
      set({ status });
      const picked = get().selectedRunId;
      const shown = status.runs.find((run) => run.id === picked) ?? status.runs[0];
      if (shown) {
        await get().select(shown.id);
      } else {
        set({ selectedRunId: null, content: null });
      }
    } catch (error) {
      console.error("Failed to load the Workshop:", error);
      set({ error: errorMessage(error) });
    }
  },

  select: async (id) => {
    try {
      const content = await invoke<WorkshopRunContent>("workshop_read", { id });
      set({ selectedRunId: id, content });
    } catch (error) {
      console.error("Failed to read the Workshop run:", error);
      set({ error: errorMessage(error) });
    }
  },

  run: async (force) => {
    set({ running: true });
    try {
      const outcome = await invoke<WorkshopRunOutcome>("workshop_run", { force });
      if (outcome.status === "ran") {
        set({ selectedRunId: outcome.run.id, error: null });
      } else if (outcome.status === "failed") {
        set({ error: outcome.message });
      }
    } catch (error) {
      console.error("Failed to run the Workshop:", error);
      set({ error: errorMessage(error) });
    } finally {
      set({ running: false });
    }
    await get().load();
  },
}));
