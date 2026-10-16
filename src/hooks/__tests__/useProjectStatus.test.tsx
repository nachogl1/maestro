import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted stores hydrate through the Tauri store plugin at import time.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

import { useProjectStatus } from "@/hooks/useProjectStatus";
import {
  type BackendSessionStatus,
  type SessionConfig,
  useSessionStore,
} from "@/stores/useSessionStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";

function session(id: number, status: BackendSessionStatus): SessionConfig {
  return { id, status, project_path: "C:\\git\\proj" } as SessionConfig;
}

function withSessions(...sessions: SessionConfig[]) {
  const tab = {
    id: "tab-1",
    name: "proj",
    projectPath: "C:\\git\\proj",
    active: true,
    sessionIds: sessions.map((s) => s.id),
    sessionsLaunched: true,
  } as WorkspaceTab;
  useWorkspaceStore.setState({ tabs: [tab] });
  useSessionStore.setState({ sessions });
}

describe("useProjectStatus", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ tabs: [] });
    useSessionStore.setState({ sessions: [] });
  });

  it("paints the project red when its only terminal timed out at startup", () => {
    withSessions(session(1, "Timeout"));
    const { result } = renderHook(() => useProjectStatus("tab-1"));

    expect(result.current.status).toBe("error");
    expect(result.current.activeSessionCount).toBe(0);
  });

  it("still ranks a terminal that needs input above a timed-out one", () => {
    withSessions(session(1, "Timeout"), session(2, "NeedsInput"));
    const { result } = renderHook(() => useProjectStatus("tab-1"));

    expect(result.current.status).toBe("needs-input");
    expect(result.current.activeSessionCount).toBe(1);
  });
});
