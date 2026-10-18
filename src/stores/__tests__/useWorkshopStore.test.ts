import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorkshopStore,
  type WorkshopRunContent,
  type WorkshopRunOutcome,
  type WorkshopStatus,
} from "../useWorkshopStore";

const invokeMock = vi.mocked(invoke);

const OLDER = { id: "2026-10-11-090000", ran_at: "2026-10-11T09:00:00Z", summary_error: null };
const NEWER = { id: "2026-10-18-090000", ran_at: "2026-10-18T09:00:00Z", summary_error: null };

function statusWith(runs: WorkshopStatus["runs"]): WorkshopStatus {
  return { runs, next_run_at: "2026-10-25T09:00:00Z", last_failure: null, running: false };
}

function contentOf(id: string): WorkshopRunContent {
  return { report_html: `<h1>${id}</h1>`, summary: `## At a glance\n${id}` };
}

/** Routes the invoke mock: `status` for workshop_status, `outcome` for workshop_run. */
function mockBackend(status: WorkshopStatus, outcome?: WorkshopRunOutcome) {
  invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
    switch (cmd) {
      case "workshop_status":
        return status;
      case "workshop_read":
        return contentOf((args as { id: string }).id);
      case "workshop_run":
        return outcome;
      default:
        return undefined;
    }
  });
}

describe("useWorkshopStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkshopStore.setState({
      status: null,
      selectedRunId: null,
      content: null,
      running: false,
      error: null,
    });
  });

  it("loads the status and shows the newest run", async () => {
    mockBackend(statusWith([NEWER, OLDER]));

    await useWorkshopStore.getState().load();

    const state = useWorkshopStore.getState();
    expect(state.status?.runs).toHaveLength(2);
    expect(state.selectedRunId).toBe(NEWER.id);
    expect(state.content).toEqual(contentOf(NEWER.id));
  });

  it("keeps an older run selected across a reload", async () => {
    mockBackend(statusWith([NEWER, OLDER]));
    await useWorkshopStore.getState().load();

    await useWorkshopStore.getState().select(OLDER.id);
    await useWorkshopStore.getState().load();

    expect(useWorkshopStore.getState().selectedRunId).toBe(OLDER.id);
    expect(useWorkshopStore.getState().content).toEqual(contentOf(OLDER.id));
  });

  it("has no content before the first run", async () => {
    mockBackend(statusWith([]));

    await useWorkshopStore.getState().load();

    expect(useWorkshopStore.getState().selectedRunId).toBeNull();
    expect(useWorkshopStore.getState().content).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("workshop_read", expect.anything());
  });

  it("runs now with force and then shows the new run", async () => {
    mockBackend(statusWith([NEWER, OLDER]), { status: "ran", run: NEWER });
    useWorkshopStore.setState({ selectedRunId: OLDER.id });

    await useWorkshopStore.getState().run(true);

    expect(invokeMock).toHaveBeenCalledWith("workshop_run", { force: true });
    const state = useWorkshopStore.getState();
    expect(state.selectedRunId).toBe(NEWER.id);
    expect(state.running).toBe(false);
    expect(state.error).toBeNull();
  });

  it("shows why a run failed", async () => {
    mockBackend(statusWith([]), { status: "failed", message: "claude not found" });

    await useWorkshopStore.getState().run(false);

    expect(useWorkshopStore.getState().error).toBe("claude not found");
    expect(useWorkshopStore.getState().running).toBe(false);
  });

  it("is running while the run is going", async () => {
    let finish: (outcome: WorkshopRunOutcome) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "workshop_run") {
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return statusWith([]);
    });

    const going = useWorkshopStore.getState().run(true);
    expect(useWorkshopStore.getState().running).toBe(true);

    finish({ status: "busy" });
    await going;
    expect(useWorkshopStore.getState().running).toBe(false);
  });
});
