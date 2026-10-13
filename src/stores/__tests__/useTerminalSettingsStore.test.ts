import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

const getAvailableFonts = vi.hoisted(() => vi.fn());

vi.mock("@/lib/fonts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fonts")>()),
  getAvailableFonts,
}));

import { type AvailableFont, EMBEDDED_FONT } from "@/lib/fonts";
import { DEFAULT_SCROLLBACK, useTerminalSettingsStore } from "../useTerminalSettingsStore";

const NERD: AvailableFont = { family: "Fira Code NF", is_nerd_font: true, is_monospace: true };
const MONO: AvailableFont = { family: "Consolas", is_nerd_font: false, is_monospace: true };

const DEFAULTS = {
  fontFamily: EMBEDDED_FONT,
  fontSize: 14,
  lineHeight: 1.2,
  zoomLevel: 100,
  scrollback: DEFAULT_SCROLLBACK,
};

function store() {
  return useTerminalSettingsStore.getState();
}

describe("useTerminalSettingsStore", () => {
  beforeEach(() => {
    getAvailableFonts.mockReset();
    useTerminalSettingsStore.setState({
      settings: { ...DEFAULTS },
      availableFonts: [],
      isLoading: false,
      isInitialized: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("initialize", () => {
    it("auto-selects the best font when the user kept the embedded default", async () => {
      getAvailableFonts.mockResolvedValue([MONO, NERD]);
      await store().initialize();
      const s = store();
      expect(s.availableFonts).toEqual([MONO, NERD]);
      expect(s.settings.fontFamily).toBe("Fira Code NF");
      expect(s.isInitialized).toBe(true);
      expect(s.isLoading).toBe(false);
    });

    it("keeps a custom font that is still installed", async () => {
      getAvailableFonts.mockResolvedValue([MONO, NERD]);
      store().setSetting("fontFamily", "Consolas");
      await store().initialize();
      expect(store().settings.fontFamily).toBe("Consolas");
    });

    it("falls back to the embedded font when the custom font is gone", async () => {
      getAvailableFonts.mockResolvedValue([MONO]);
      store().setSetting("fontFamily", "Removed Font");
      await store().initialize();
      expect(store().settings.fontFamily).toBe(EMBEDDED_FONT);
    });

    it("marks itself initialized with no fonts when detection fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      getAvailableFonts.mockRejectedValue(new Error("no font api"));
      await store().initialize();
      const s = store();
      expect(s.isInitialized).toBe(true);
      expect(s.isLoading).toBe(false);
      expect(s.availableFonts).toEqual([]);
      expect(s.settings.fontFamily).toBe(EMBEDDED_FONT);
    });

    it("runs only once", async () => {
      getAvailableFonts.mockResolvedValue([MONO]);
      await store().initialize();
      await store().initialize();
      expect(getAvailableFonts).toHaveBeenCalledTimes(1);
    });
  });

  it("setSetting updates one key and leaves the others alone", () => {
    store().setSetting("fontSize", 18);
    expect(store().settings).toEqual({ ...DEFAULTS, fontSize: 18 });
  });

  describe("resetToDefaults", () => {
    it("restores defaults with the embedded font when no fonts were detected", () => {
      useTerminalSettingsStore.setState({
        settings: { ...DEFAULTS, fontSize: 20, lineHeight: 2, zoomLevel: 150, scrollback: 50 },
      });
      store().resetToDefaults();
      expect(store().settings).toEqual(DEFAULTS);
    });

    it("picks the best detected font", () => {
      useTerminalSettingsStore.setState({
        availableFonts: [MONO, NERD],
        settings: { ...DEFAULTS, fontFamily: "Consolas", fontSize: 20 },
      });
      store().resetToDefaults();
      expect(store().settings).toEqual({ ...DEFAULTS, fontFamily: "Fira Code NF" });
    });
  });

  describe("getEffectiveFontFamily", () => {
    it("returns the embedded font when it is selected", () => {
      expect(store().getEffectiveFontFamily()).toBe(EMBEDDED_FONT);
    });

    it("returns the selected font when it is available", () => {
      useTerminalSettingsStore.setState({
        availableFonts: [MONO],
        settings: { ...DEFAULTS, fontFamily: "Consolas" },
      });
      expect(store().getEffectiveFontFamily()).toBe("Consolas");
    });

    it("falls back to the embedded font when the selection is unavailable", () => {
      useTerminalSettingsStore.setState({ settings: { ...DEFAULTS, fontFamily: "Consolas" } });
      expect(store().getEffectiveFontFamily()).toBe(EMBEDDED_FONT);
    });
  });

  describe("zoom", () => {
    it("zoomIn and zoomOut step by 10", () => {
      store().zoomIn();
      expect(store().settings.zoomLevel).toBe(110);
      store().zoomOut();
      store().zoomOut();
      expect(store().settings.zoomLevel).toBe(90);
    });

    it("zoomIn caps at 500 and zoomOut floors at 25", () => {
      store().setZoomLevel(495);
      store().zoomIn();
      expect(store().settings.zoomLevel).toBe(500);
      store().setZoomLevel(30);
      store().zoomOut();
      expect(store().settings.zoomLevel).toBe(25);
    });

    it("setZoomLevel clamps to 25..500", () => {
      store().setZoomLevel(10);
      expect(store().settings.zoomLevel).toBe(25);
      store().setZoomLevel(900);
      expect(store().settings.zoomLevel).toBe(500);
      store().setZoomLevel(175);
      expect(store().settings.zoomLevel).toBe(175);
    });

    it("resetZoom returns to 100", () => {
      store().setZoomLevel(200);
      store().resetZoom();
      expect(store().settings.zoomLevel).toBe(100);
    });

    it("getEffectiveFontSize scales and rounds the font size", () => {
      store().setZoomLevel(150);
      expect(store().getEffectiveFontSize()).toBe(21);
      store().setZoomLevel(125);
      expect(store().getEffectiveFontSize()).toBe(18); // 17.5 rounds up
    });

    it("reacts to native menu terminal-zoom events", () => {
      const handler = listeners.get("terminal-zoom");
      expect(handler).toBeDefined();
      handler?.({ payload: "zoom-in" });
      expect(store().settings.zoomLevel).toBe(110);
      handler?.({ payload: "zoom-out" });
      handler?.({ payload: "zoom-out" });
      expect(store().settings.zoomLevel).toBe(90);
      handler?.({ payload: "zoom-reset" });
      expect(store().settings.zoomLevel).toBe(100);
      handler?.({ payload: "unknown" });
      expect(store().settings.zoomLevel).toBe(100);
    });
  });

  describe("persist migration", () => {
    const migrate = useTerminalSettingsStore.persist.getOptions().migrate;

    it("adds zoomLevel and scrollback to version 1 data", async () => {
      const old = { settings: { fontFamily: "Consolas", fontSize: 12, lineHeight: 1 } };
      const migrated = (await migrate?.(old, 1)) as { settings: unknown };
      expect(migrated.settings).toEqual({
        fontFamily: "Consolas",
        fontSize: 12,
        lineHeight: 1,
        zoomLevel: 100,
        scrollback: DEFAULT_SCROLLBACK,
      });
    });

    it("adds only scrollback to version 2 data", async () => {
      const old = {
        settings: { fontFamily: "Consolas", fontSize: 12, lineHeight: 1, zoomLevel: 80 },
      };
      const migrated = (await migrate?.(old, 2)) as {
        settings: { zoomLevel: number; scrollback: number };
      };
      expect(migrated.settings.zoomLevel).toBe(80);
      expect(migrated.settings.scrollback).toBe(DEFAULT_SCROLLBACK);
    });
  });
});
