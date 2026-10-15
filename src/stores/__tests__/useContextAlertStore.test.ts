import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted store hydrates through the Tauri store plugin at import time;
// happy-dom has no Tauri backend, so stub it out.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));

import {
  CONTEXT_ALERT_THRESHOLDS,
  DEFAULT_CONTEXT_ALERT_THRESHOLD,
  isContextAlert,
  useContextAlertStore,
} from "../useContextAlertStore";

describe("isContextAlert", () => {
  it("is off when no threshold is set", () => {
    expect(isContextAlert(99, null)).toBe(false);
  });

  it("never alerts before the first usage reading arrives", () => {
    expect(isContextAlert(undefined, 50)).toBe(false);
  });

  it("alerts at and above the threshold, not below it", () => {
    expect(isContextAlert(79.9, 80)).toBe(false);
    expect(isContextAlert(80, 80)).toBe(true);
    expect(isContextAlert(93.4, 80)).toBe(true);
  });
});

describe("useContextAlertStore", () => {
  beforeEach(() => {
    useContextAlertStore.setState({ threshold: DEFAULT_CONTEXT_ALERT_THRESHOLD });
  });

  it("defaults to a threshold that is one of the selectable options", () => {
    expect(useContextAlertStore.getState().threshold).toBe(DEFAULT_CONTEXT_ALERT_THRESHOLD);
    expect(CONTEXT_ALERT_THRESHOLDS).toContain(DEFAULT_CONTEXT_ALERT_THRESHOLD);
  });

  it("stores a new threshold and can be switched off", () => {
    useContextAlertStore.getState().setThreshold(90);
    expect(useContextAlertStore.getState().threshold).toBe(90);
    useContextAlertStore.getState().setThreshold(null);
    expect(useContextAlertStore.getState().threshold).toBeNull();
  });
});
