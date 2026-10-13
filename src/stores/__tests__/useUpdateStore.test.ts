import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

type Handler = (event: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { type UpdateInfo, useUpdateStore } from "../useUpdateStore";

const mockInvoke = vi.mocked(invoke);

const INFO: UpdateInfo = {
  available: true,
  current_version: "1.0.0",
  latest_version: "1.1.0",
  release_notes: null,
  date: null,
};

function emit(name: string, payload: unknown = null) {
  const handler = listeners.get(name);
  if (!handler) throw new Error(`no listener for ${name}`);
  handler({ payload });
}

describe("useUpdateStore", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    listeners.clear();
    useUpdateStore.setState({
      autoCheckEnabled: true,
      checkIntervalMinutes: 60,
      dismissedVersion: null,
      customEndpoint: null,
      status: "idle",
      updateInfo: null,
      downloadProgress: null,
      error: null,
      lastCheckedAt: null,
    });
  });

  describe("checkForUpdates", () => {
    it("moves to available when an update exists", async () => {
      mockInvoke.mockResolvedValue(INFO);
      await useUpdateStore.getState().checkForUpdates();
      const s = useUpdateStore.getState();
      expect(mockInvoke).toHaveBeenCalledWith("check_for_updates", { customEndpoint: null });
      expect(s.status).toBe("available");
      expect(s.updateInfo).toEqual(INFO);
      expect(s.lastCheckedAt).not.toBeNull();
    });

    it("returns to idle when no update exists", async () => {
      mockInvoke.mockResolvedValue({ ...INFO, available: false });
      await useUpdateStore.getState().checkForUpdates();
      expect(useUpdateStore.getState().status).toBe("idle");
    });

    it("passes the custom endpoint, mapping empty string to null", async () => {
      mockInvoke.mockResolvedValue(INFO);
      useUpdateStore.getState().setCustomEndpoint("https://example.test/latest.json");
      await useUpdateStore.getState().checkForUpdates();
      expect(mockInvoke).toHaveBeenLastCalledWith("check_for_updates", {
        customEndpoint: "https://example.test/latest.json",
      });

      useUpdateStore.setState({ status: "idle" });
      useUpdateStore.getState().setCustomEndpoint("");
      await useUpdateStore.getState().checkForUpdates();
      expect(mockInvoke).toHaveBeenLastCalledWith("check_for_updates", { customEndpoint: null });
    });

    it("records the error on failure", async () => {
      mockInvoke.mockRejectedValue(new Error("offline"));
      await useUpdateStore.getState().checkForUpdates();
      const s = useUpdateStore.getState();
      expect(s.status).toBe("error");
      expect(s.error).toBe("offline");
      expect(s.lastCheckedAt).not.toBeNull();
    });

    it.each([
      "checking",
      "downloading",
      "installing",
    ] as const)("does nothing while %s", async (status) => {
      useUpdateStore.setState({ status });
      await useUpdateStore.getState().checkForUpdates();
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(useUpdateStore.getState().status).toBe(status);
    });
  });

  describe("downloadAndInstall", () => {
    it("does nothing unless an update is available", async () => {
      await useUpdateStore.getState().downloadAndInstall();
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(useUpdateStore.getState().status).toBe("idle");
    });

    it("moves to downloading and invokes the installer", async () => {
      mockInvoke.mockResolvedValue(undefined);
      useUpdateStore.setState({ status: "available", updateInfo: INFO });
      await useUpdateStore.getState().downloadAndInstall();
      const s = useUpdateStore.getState();
      expect(mockInvoke).toHaveBeenCalledWith("download_and_install_update", {
        customEndpoint: null,
      });
      expect(s.status).toBe("downloading");
      expect(s.downloadProgress).toBe(0);
    });

    it("records the error and clears progress on failure", async () => {
      mockInvoke.mockRejectedValue("signature mismatch");
      useUpdateStore.setState({ status: "available", updateInfo: INFO });
      await useUpdateStore.getState().downloadAndInstall();
      const s = useUpdateStore.getState();
      expect(s.status).toBe("error");
      expect(s.error).toBe("signature mismatch");
      expect(s.downloadProgress).toBeNull();
    });
  });

  describe("progress listeners", () => {
    it("accumulates chunk progress, clamps at 100, and flips to installing", async () => {
      mockInvoke.mockResolvedValue(undefined);
      const unlisten = await useUpdateStore.getState().initListeners();
      useUpdateStore.setState({ status: "available", updateInfo: INFO });
      await useUpdateStore.getState().downloadAndInstall();

      emit("update-download-progress", { chunk_length: 25, content_length: 100 });
      expect(useUpdateStore.getState().downloadProgress).toBe(25);
      emit("update-download-progress", { chunk_length: 50, content_length: 100 });
      expect(useUpdateStore.getState().downloadProgress).toBe(75);
      emit("update-download-progress", { chunk_length: 50, content_length: 100 });
      expect(useUpdateStore.getState().downloadProgress).toBe(100);

      emit("update-installing");
      expect(useUpdateStore.getState().status).toBe("installing");
      expect(useUpdateStore.getState().downloadProgress).toBe(100);

      unlisten();
      expect(listeners.size).toBe(0);
    });

    it("reports null progress when the total size is unknown", async () => {
      await useUpdateStore.getState().initListeners();
      emit("update-download-progress", { chunk_length: 10, content_length: null });
      expect(useUpdateStore.getState().downloadProgress).toBeNull();
    });

    it("restarts the byte count on a retry", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await useUpdateStore.getState().initListeners();

      useUpdateStore.setState({ status: "available", updateInfo: INFO });
      await useUpdateStore.getState().downloadAndInstall();
      emit("update-download-progress", { chunk_length: 80, content_length: 100 });
      expect(useUpdateStore.getState().downloadProgress).toBe(80);

      // Simulate the first attempt failing, then a retry.
      useUpdateStore.setState({ status: "available" });
      await useUpdateStore.getState().downloadAndInstall();
      emit("update-download-progress", { chunk_length: 10, content_length: 100 });
      expect(useUpdateStore.getState().downloadProgress).toBe(10);
    });
  });

  describe("settings", () => {
    it("dismissUpdate remembers the dismissed version and returns to idle", () => {
      useUpdateStore.setState({ status: "available", updateInfo: INFO });
      useUpdateStore.getState().dismissUpdate();
      const s = useUpdateStore.getState();
      expect(s.status).toBe("idle");
      expect(s.dismissedVersion).toBe("1.1.0");
    });

    it("dismissUpdate with no update info stores null", () => {
      useUpdateStore.getState().dismissUpdate();
      expect(useUpdateStore.getState().dismissedVersion).toBeNull();
    });

    it("setters update auto-check, interval and endpoint", () => {
      const s = useUpdateStore.getState();
      s.setAutoCheckEnabled(false);
      s.setCheckInterval(15);
      s.setCustomEndpoint("https://example.test");
      const next = useUpdateStore.getState();
      expect(next.autoCheckEnabled).toBe(false);
      expect(next.checkIntervalMinutes).toBe(15);
      expect(next.customEndpoint).toBe("https://example.test");
    });
  });
});
