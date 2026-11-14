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
import { UpdateNotification, updateRestartsTerminalsLine } from "../UpdateNotification";

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

  it("says the open terminals close and come back, with the three points, then installs on agreement", () => {
    openTerminals(6);
    render(<UpdateNotification />);
    fireEvent.click(screen.getByRole("button", { name: /download and install/i }));
    expect(downloadAndInstall).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Update Maestro to 1.1.0?");
    expect(dialog.textContent).toContain(
      "Your 6 open terminals will close and come back after the update.",
    );
    const points = Array.from(dialog.querySelectorAll("li")).map((li) => li.textContent);
    expect(points).toEqual([
      "Whatever they are doing right now is cut off. Make sure none is doing critical work.",
      "Claude conversations come back; the step that was running does not.",
      "Plain shells come back empty, in the same folder.",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Update and restart" }));
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("changes nothing when the user picks Not now", () => {
    openTerminals(1);
    render(<UpdateNotification />);
    fireEvent.click(screen.getByRole("button", { name: /download and install/i }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useUpdateStore.getState().status).toBe("available");
  });

  it("words the first line for one terminal", () => {
    expect(updateRestartsTerminalsLine(1)).toBe(
      "Your 1 open terminal will close and come back after the update.",
    );
  });
});
