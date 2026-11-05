import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The persisted stores hydrate through the Tauri store plugin at import time;
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

import { useAttentionSoundStore } from "@/stores/useAttentionSoundStore";
import { NotificationsSettingsSection } from "../NotificationsSettingsSection";

describe("NotificationsSettingsSection: attention sound switch", () => {
  beforeEach(() => {
    useAttentionSoundStore.setState({ enabled: false });
  });

  it("offers a sound switch, off by default, that turns the sound on and off", () => {
    render(<NotificationsSettingsSection />);
    expect(screen.getByText("Play a sound when a terminal needs you")).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Toggle attention sound" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    expect(useAttentionSoundStore.getState().enabled).toBe(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    expect(useAttentionSoundStore.getState().enabled).toBe(false);
  });
});
