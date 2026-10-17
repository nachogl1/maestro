import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { useUpdateStore } from "@/stores/useUpdateStore";
import { AUTO_UPDATE_QUESTION, AutoUpdateQuestion } from "../AutoUpdateQuestion";

describe("AutoUpdateQuestion", () => {
  beforeEach(async () => {
    await useUpdateStore.persist.rehydrate();
    useUpdateStore.setState({ autoInstallOnLaunch: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks once the settings are loaded and nothing was chosen yet", () => {
    render(<AutoUpdateQuestion />);
    expect(screen.getByText(AUTO_UPDATE_QUESTION)).toBeTruthy();
  });

  it("stays hidden until the settings are loaded", () => {
    vi.spyOn(useUpdateStore.persist, "hasHydrated").mockReturnValue(false);
    vi.spyOn(useUpdateStore.persist, "onFinishHydration").mockReturnValue(() => {});
    render(<AutoUpdateQuestion />);
    expect(screen.queryByText(AUTO_UPDATE_QUESTION)).toBeNull();
  });

  it.each([true, false])("stays hidden once the user answered %s", (choice) => {
    useUpdateStore.setState({ autoInstallOnLaunch: choice });
    render(<AutoUpdateQuestion />);
    expect(screen.queryByText(AUTO_UPDATE_QUESTION)).toBeNull();
  });

  it("Turn on saves yes and closes", () => {
    render(<AutoUpdateQuestion />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(useUpdateStore.getState().autoInstallOnLaunch).toBe(true);
    expect(screen.queryByText(AUTO_UPDATE_QUESTION)).toBeNull();
  });

  it("Not now saves no and closes", () => {
    render(<AutoUpdateQuestion />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(useUpdateStore.getState().autoInstallOnLaunch).toBe(false);
    expect(screen.queryByText(AUTO_UPDATE_QUESTION)).toBeNull();
  });

  it("closing the dialog counts as Not now, so it never asks again", () => {
    render(<AutoUpdateQuestion />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useUpdateStore.getState().autoInstallOnLaunch).toBe(false);
  });
});
