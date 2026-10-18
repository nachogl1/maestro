import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
}));

import { useFeatureSettingsStore } from "@/stores/useFeatureSettingsStore";
import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { FeaturesSettingsPanel } from "../FeaturesSettingsPanel";

function featureSwitch(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

describe("FeaturesSettingsPanel", () => {
  beforeEach(() => {
    useFeatureSettingsStore.setState({ samuraiLaunchEnabled: true, secondBrainEnabled: true });
    useWorkJournalSettingsStore.setState({ enabled: null });
  });

  it("shows a switch for each optional feature with its current state", () => {
    render(<FeaturesSettingsPanel />);
    expect(featureSwitch("Show Samurai launch").getAttribute("aria-checked")).toBe("true");
    expect(featureSwitch("Show Second Brain").getAttribute("aria-checked")).toBe("true");
    expect(featureSwitch("Enable the Work Journal").getAttribute("aria-checked")).toBe("false");
  });

  it("turning Samurai launch off saves the choice", () => {
    render(<FeaturesSettingsPanel />);
    fireEvent.click(featureSwitch("Show Samurai launch"));
    expect(useFeatureSettingsStore.getState().samuraiLaunchEnabled).toBe(false);
    expect(featureSwitch("Show Samurai launch").getAttribute("aria-checked")).toBe("false");
  });

  it("turning Second Brain off saves the choice", () => {
    render(<FeaturesSettingsPanel />);
    fireEvent.click(featureSwitch("Show Second Brain"));
    expect(useFeatureSettingsStore.getState().secondBrainEnabled).toBe(false);
  });

  it("turning the Work Journal on enables it", () => {
    render(<FeaturesSettingsPanel />);
    fireEvent.click(featureSwitch("Enable the Work Journal"));
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(true);
  });
});
