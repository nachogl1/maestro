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
  DEFAULT_CONTEXT_ALERT_THRESHOLD,
  isContextAlert,
  MAX_CONTEXT_ALERT_THRESHOLD,
  MIN_CONTEXT_ALERT_THRESHOLD,
  parseContextAlertThreshold,
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

  it("defaults to a threshold within the allowed range", () => {
    expect(useContextAlertStore.getState().threshold).toBe(DEFAULT_CONTEXT_ALERT_THRESHOLD);
    expect(DEFAULT_CONTEXT_ALERT_THRESHOLD).toBeGreaterThanOrEqual(MIN_CONTEXT_ALERT_THRESHOLD);
    expect(DEFAULT_CONTEXT_ALERT_THRESHOLD).toBeLessThanOrEqual(MAX_CONTEXT_ALERT_THRESHOLD);
  });

  it("stores a new threshold and can be switched off", () => {
    useContextAlertStore.getState().setThreshold(90);
    expect(useContextAlertStore.getState().threshold).toBe(90);
    useContextAlertStore.getState().setThreshold(null);
    expect(useContextAlertStore.getState().threshold).toBeNull();
  });
});

describe("parseContextAlertThreshold", () => {
  it("accepts whole percents inside the range", () => {
    expect(parseContextAlertThreshold("65")).toBe(65);
    expect(parseContextAlertThreshold(" 1 ")).toBe(1);
    expect(parseContextAlertThreshold("100")).toBe(100);
  });

  it("clamps to the range and rounds decimals", () => {
    expect(parseContextAlertThreshold("0")).toBe(MIN_CONTEXT_ALERT_THRESHOLD);
    expect(parseContextAlertThreshold("-5")).toBe(MIN_CONTEXT_ALERT_THRESHOLD);
    expect(parseContextAlertThreshold("250")).toBe(MAX_CONTEXT_ALERT_THRESHOLD);
    expect(parseContextAlertThreshold("72.6")).toBe(73);
  });

  it("rejects empty or non-numeric text", () => {
    expect(parseContextAlertThreshold("")).toBeNull();
    expect(parseContextAlertThreshold("   ")).toBeNull();
    expect(parseContextAlertThreshold("abc")).toBeNull();
    expect(parseContextAlertThreshold("Infinity")).toBeNull();
  });
});
