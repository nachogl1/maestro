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

import { useSessionContextAlert } from "@/hooks/useSessionContextAlert";
import { useContextAlertStore } from "@/stores/useContextAlertStore";
import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";

function session(id: number, contextPercent?: number): SessionConfig {
  return { id, status: "Working", project_path: "C:\\git\\proj", contextPercent } as SessionConfig;
}

describe("useSessionContextAlert", () => {
  beforeEach(() => {
    useContextAlertStore.setState({ threshold: 80 });
    useSessionStore.setState({ sessions: [session(1, 91.4), session(2, 20)] });
  });

  it("is active, with hover text, for a terminal at or past the threshold", () => {
    const { result } = renderHook(() => useSessionContextAlert(1));
    expect(result.current.active).toBe(true);
    expect(result.current.title).toBe("Context 91% ≥ 80% alert");
  });

  it("is quiet for a terminal below the threshold", () => {
    const { result } = renderHook(() => useSessionContextAlert(2));
    expect(result.current).toEqual({ active: false, title: null });
  });

  it("never alerts for a pre-launch slot (no session id) or when the alert is off", () => {
    expect(renderHook(() => useSessionContextAlert(null)).result.current.active).toBe(false);
    useContextAlertStore.setState({ threshold: null });
    expect(renderHook(() => useSessionContextAlert(1)).result.current.active).toBe(false);
  });

  it("follows the live context percent of the session", () => {
    const { result, rerender } = renderHook(() => useSessionContextAlert(2));
    expect(result.current.active).toBe(false);
    useSessionStore.setState({ sessions: [session(1, 91.4), session(2, 80)] });
    rerender();
    expect(result.current.active).toBe(true);
  });
});
