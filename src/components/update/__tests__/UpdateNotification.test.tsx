import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The update store persists through the Tauri store plugin; happy-dom has no
// Tauri backend, so stub it out.
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

import { type SessionConfig, useSessionStore } from "@/stores/useSessionStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { UpdateNotification, updateKillsTerminalsWarning } from "../UpdateNotification";

const LONG_ERROR =
  "Failed to check for updates: error sending request for url " +
  "(https://github.com/nachogl1/maestro/releases/latest/download/latest.json)";

describe("UpdateNotification", () => {
  beforeEach(() => {
    useUpdateStore.setState({ status: "error", error: LONG_ERROR });
  });

  it("wraps and clamps a long error so it stays inside the toast", () => {
    render(<UpdateNotification />);
    const message = screen.getByText(LONG_ERROR);
    expect(message.className).toContain("break-words");
    expect(message.className).toContain("line-clamp-3");
  });

  it("shows the full error on hover", () => {
    render(<UpdateNotification />);
    expect(screen.getByText(LONG_ERROR).getAttribute("title")).toBe(LONG_ERROR);
  });
});

describe("UpdateNotification install with open terminals", () => {
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    downloadAndInstall.mockClear();
    useUpdateStore.setState({
      status: "available",
      dismissedVersion: null,
      updateInfo: {
        available: true,
        current_version: "1.0.0",
        latest_version: "1.1.0",
        release_notes: null,
        date: null,
      },
      downloadAndInstall,
    });
  });

  function openTerminals(count: number) {
    const sessions = Array.from({ length: count }, (_, i) => ({ id: i + 1 }) as SessionConfig);
    useSessionStore.setState({ sessions });
  }

  it("installs straight away when no terminal is open", () => {
    openTerminals(0);
    render(<UpdateNotification />);
    fireEvent.click(screen.getByRole("button", { name: /download and install/i }));
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("warns that the terminals will close and installs only after the user agrees", () => {
    openTerminals(2);
    render(<UpdateNotification />);
    fireEvent.click(screen.getByRole("button", { name: /download and install/i }));
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(updateKillsTerminalsWarning(2))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not install when the user cancels the warning", () => {
    openTerminals(1);
    render(<UpdateNotification />);
    fireEvent.click(screen.getByRole("button", { name: /download and install/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("words the warning for one terminal", () => {
    expect(updateKillsTerminalsWarning(1)).toMatch(/^1 terminal is open\./);
  });
});
