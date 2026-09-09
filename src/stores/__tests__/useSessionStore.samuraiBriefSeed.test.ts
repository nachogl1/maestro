import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
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
vi.mock("@/lib/osNotification", () => ({
  notifyOs: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "@tauri-apps/api/core";
import type { SamuraiAuditEvent, SamuraiRunListEntry } from "@/lib/samurai";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import {
  initSamuraiSupervisorListener,
  samuraiBriefKey,
  stopSamuraiSupervisorListener,
  useSessionStore,
} from "../useSessionStore";

const invokeMock = vi.mocked(invoke);

function run(overrides: Partial<SamuraiRunListEntry> = {}): SamuraiRunListEntry {
  return {
    project_path: "C:/proj",
    epic: "epic-9",
    epics: [],
    issues: [],
    launch_text: null,
    repo_pin: null,
    worktree_path: "C:/wt/epic-9",
    model: null,
    thresholds: null,
    workflow: null,
    run_number: 1,
    display_name: null,
    status: "ACTIVE",
    interrupted_at: null,
    parked: null,
    created_at: "2026-09-09T09:00:00Z",
    orchestrator: {
      generation: null,
      session_id: null,
      model: null,
      context_window: null,
      context_percent: null,
    },
    ...overrides,
  };
}

function auditRow(overrides: Partial<SamuraiAuditEvent>): SamuraiAuditEvent {
  return {
    ts: "2026-09-09T10:00:00Z",
    epic: "epic-9",
    event: "INJECT",
    generation: 3,
    session_id: 1,
    details: {},
    ...overrides,
  };
}

/** Routes the invoke mock by command; unknown commands resolve empty. */
function mockInvoke(runs: SamuraiRunListEntry[], events: SamuraiAuditEvent[]) {
  invokeMock.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "samurai_list_runs":
        return runs;
      case "samurai_audit_read":
        return { events, file_size_bytes: 1 };
      default:
        return undefined;
    }
  });
}

/**
 * Issue #206: the receipt rows are written long before App mounts the audit
 * listener, and Tauri buffers no events — the same hole `interrupted_at`'s
 * seed (#190) exists to close. Without this the badge is blank on every cold
 * start, which is the state the issue exists to end.
 */
describe("brief state seeded at startup (issue #206)", () => {
  beforeEach(() => {
    stopSamuraiSupervisorListener();
    invokeMock.mockReset();
    useSessionStore.setState({ samuraiBriefByRun: {}, samuraiToasts: [], sessions: [] });
    useGitHubWatchdogStore.setState({ notificationsEnabled: false });
  });

  it("reads the newest generation's verdict back out of the audit log", async () => {
    mockInvoke(
      [run()],
      [
        // gen-3 was delivered AND read; gen-4 has only been delivered. The
        // newest generation is the one the badge speaks for.
        auditRow({ generation: 3, details: { phase: "delivered", instruction: "launch_brief" } }),
        auditRow({ generation: 3, details: { phase: "receipt", brief: "epic-9-gen-3.md" } }),
        auditRow({
          generation: 4,
          details: { phase: "delivered", instruction: "successor_ritual" },
        }),
      ],
    );
    await initSamuraiSupervisorListener();
    // The seeds are fire-and-forget; let their IPC round trips settle.
    await vi.waitFor(() => {
      expect(
        useSessionStore.getState().samuraiBriefByRun[samuraiBriefKey("C:/proj", "epic-9")],
      ).toBeDefined();
    });
    expect(
      useSessionStore.getState().samuraiBriefByRun[samuraiBriefKey("C:/proj", "epic-9")],
    ).toMatchObject({ generation: 4, status: "delivered" });
  });

  it("seeds nothing for a run that is no longer active", async () => {
    mockInvoke(
      [run({ status: "ARCHIVED" })],
      [auditRow({ details: { phase: "receipt", brief: "epic-9-gen-3.md" } })],
    );
    await initSamuraiSupervisorListener();
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "samurai_list_runs")).toBe(true);
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "samurai_audit_read")).toHaveLength(0);
    expect(useSessionStore.getState().samuraiBriefByRun).toEqual({});
  });
});
