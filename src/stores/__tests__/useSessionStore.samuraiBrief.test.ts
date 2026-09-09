import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Tauri APIs must be mocked before importing store modules.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
// The watchdog store persists through the Tauri store plugin; happy-dom has
// no Tauri backend, so stub it out (same as useSessionStore.samuraiFatal).
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

import { listen } from "@tauri-apps/api/event";
import { notifyOs } from "@/lib/osNotification";
import type { SamuraiAuditEvent } from "@/lib/samurai";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import {
  type BackendSessionStatus,
  initSamuraiSupervisorListener,
  type SessionConfig,
  samuraiBriefKey,
  useSessionStore,
} from "../useSessionStore";

const listenMock = vi.mocked(listen);

function session(
  id: number,
  status: BackendSessionStatus = "Working",
  projectPath = "C:/proj",
): SessionConfig {
  return {
    id,
    mode: "Claude",
    branch: null,
    status,
    worktree_path: null,
    project_path: projectPath,
  };
}

/** Captured `samurai-audit-event` handler, so tests can stream rows in. */
let emitAuditEvent: (event: Partial<SamuraiAuditEvent>, project?: string) => void;

function auditRow(overrides: Partial<SamuraiAuditEvent>): SamuraiAuditEvent {
  return {
    ts: "2026-09-09T10:00:00Z",
    epic: "epic-9",
    event: "ALERT",
    generation: 3,
    session_id: 1,
    details: {},
    ...overrides,
  };
}

const KEY = samuraiBriefKey("C:/proj", "epic-9");

beforeAll(async () => {
  listenMock.mockImplementation(((event: string, handler: (e: unknown) => void) => {
    if (event === "samurai-audit-event") {
      emitAuditEvent = (row, project = "C:/proj") => {
        handler({ payload: { project, event: auditRow(row) } });
      };
    }
    return Promise.resolve(() => {});
  }) as typeof listen);
  await initSamuraiSupervisorListener();
});

describe("brief read/unread from the audit stream (issue #206)", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: [session(1)],
      parkedSessionIds: [],
      attentionSessionIds: [],
      runFatalSessionIds: [],
      samuraiBySessionId: {},
      samuraiToasts: [],
      samuraiBriefByRun: {},
    });
    useGitHubWatchdogStore.setState({ notificationsEnabled: true });
    vi.mocked(notifyOs).mockClear();
  });

  /**
   * The whole point of the issue: an unread brief used to reach nothing but
   * the passive audit list — the surface that let 22 alerts pile up unread
   * (#185/#190).
   */
  it("raises the toast + OS notification for an unread brief, and clears it on the receipt", () => {
    emitAuditEvent({
      event: "INJECT",
      details: { phase: "delivered", instruction: "successor_ritual", gate: "session_started" },
    });
    expect(useSessionStore.getState().samuraiBriefByRun[KEY]).toMatchObject({
      generation: 3,
      status: "delivered",
    });
    // Delivery alone is not a complaint: nothing is raised for it.
    expect(useSessionStore.getState().samuraiToasts).toHaveLength(0);
    expect(notifyOs).not.toHaveBeenCalled();

    emitAuditEvent({
      details: {
        kind: "brief_unread",
        instruction: "successor_ritual",
        gate: "session_started",
        brief: "epic-9-gen-3-ritual.md",
        escalated: false,
      },
    });
    const alerted = useSessionStore.getState();
    expect(alerted.samuraiToasts).toHaveLength(1);
    expect(alerted.samuraiToasts[0]).toMatchObject({
      kind: "attention",
      project: "C:/proj",
      epic: "epic-9",
      generation: 3,
      label: "Has not read its brief yet — nudging it",
    });
    expect(notifyOs).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyOs).mock.calls[0][1]).toContain("Has not read its brief yet");
    // Attention, not fatal: the run is being corrected, not declared dead.
    expect(alerted.attentionSessionIds).toEqual([1]);
    expect(alerted.runFatalSessionIds).toEqual([]);
    expect(alerted.samuraiBriefByRun[KEY]).toMatchObject({ generation: 3, status: "unread" });

    // The agent opens the file: the badge state goes back to read.
    emitAuditEvent({
      event: "INJECT",
      details: { phase: "receipt", brief: "epic-9-gen-3-ritual.md", gate: "session_started" },
    });
    expect(useSessionStore.getState().samuraiBriefByRun[KEY]).toMatchObject({
      generation: 3,
      status: "read",
    });
  });

  it("takes the escalated rung to the fatal tier instead", () => {
    emitAuditEvent({
      details: {
        kind: "brief_unread",
        brief: "epic-9-gen-3-ritual.md",
        escalated: true,
        respawned: true,
      },
    });
    const state = useSessionStore.getState();
    expect(state.samuraiToasts).toHaveLength(1);
    expect(state.samuraiToasts[0]).toMatchObject({
      kind: "fatal",
      label: "Brief was never read — the run was respawned",
    });
    expect(state.runFatalSessionIds).toEqual([1]);
  });

  it("never lets an older generation's verdict overwrite the newest one", () => {
    emitAuditEvent({
      event: "INJECT",
      generation: 4,
      details: { phase: "receipt", brief: "epic-9-gen-4-ritual.md" },
    });
    // A gen-3 row arriving late (a seed racing the live stream) says nothing
    // about the agent working now.
    emitAuditEvent({ generation: 3, details: { kind: "brief_unread", escalated: false } });
    expect(useSessionStore.getState().samuraiBriefByRun[KEY]).toMatchObject({
      generation: 4,
      status: "read",
    });
  });

  it("keeps runs in different projects apart", () => {
    emitAuditEvent({ event: "INJECT", details: { phase: "receipt" } }, "C:/proj");
    emitAuditEvent({ details: { kind: "brief_unread", escalated: false } }, "C:/other");
    const map = useSessionStore.getState().samuraiBriefByRun;
    expect(map[KEY]).toMatchObject({ status: "read" });
    expect(map[samuraiBriefKey("C:/other", "epic-9")]).toMatchObject({ status: "unread" });
  });
});
