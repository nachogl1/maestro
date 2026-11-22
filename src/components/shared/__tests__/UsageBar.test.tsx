import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageData } from "@/lib/usageParser";

// The privacy switch persists through the Tauri store plugin; happy-dom has no
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

const getClaudeUsage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/usageParser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/usageParser")>()),
  getClaudeUsage,
}));

import { usePrivacySettingsStore } from "@/stores/usePrivacySettingsStore";
import { useUsageStore } from "@/stores/useUsageStore";
import { UsageBar } from "../UsageBar";

const SOME_USAGE: UsageData = {
  sessionPercent: 42,
  sessionResetsAt: null,
  weeklyPercent: 17,
  weeklyResetsAt: null,
  weeklyOpusPercent: null,
  weeklyOpusResetsAt: null,
  weeklySonnetPercent: null,
  weeklySonnetResetsAt: null,
  weeklyOauthAppsPercent: null,
  weeklyOauthAppsResetsAt: null,
  spendPercent: null,
  spendResetsAt: null,
  spendUsedDollars: null,
  spendLimitDollars: null,
  modelWindows: [],
  errorMessage: null,
  needsAuth: false,
};

describe("UsageBar", () => {
  beforeEach(async () => {
    await usePrivacySettingsStore.persist.rehydrate();
    usePrivacySettingsStore.setState({ usageBar: null, settingsRequested: false });
    useUsageStore.setState({ usage: null, isLoading: false, error: null, needsAuth: false });
    getClaudeUsage.mockReset().mockResolvedValue(SOME_USAGE);
  });

  it("with no stored choice, asks for usage and shows the bars as today", async () => {
    const { unmount } = render(<UsageBar />);
    expect(await screen.findByText("Session")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(getClaudeUsage).toHaveBeenCalled();
    unmount();
  });

  it("switched off, asks nothing and shows 'Usage bar off', which opens Settings → Privacy", async () => {
    usePrivacySettingsStore.setState({ usageBar: false });
    const { unmount } = render(<UsageBar />);
    const off = screen.getByRole("button", { name: "Usage bar off" });
    expect(screen.queryByRole("button", { name: "Refresh usage data" })).not.toBeInTheDocument();

    fireEvent.click(off);

    expect(usePrivacySettingsStore.getState().settingsRequested).toBe(true);
    await act(async () => {});
    expect(getClaudeUsage).not.toHaveBeenCalled();
    unmount();
  });
});
