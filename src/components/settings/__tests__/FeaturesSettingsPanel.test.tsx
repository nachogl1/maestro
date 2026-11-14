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

import { useWorkJournalSettingsStore } from "@/stores/useWorkJournalSettingsStore";
import { FeaturesSettingsPanel } from "../FeaturesSettingsPanel";

function featureSwitch(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

describe("FeaturesSettingsPanel", () => {
  beforeEach(() => {
    useWorkJournalSettingsStore.setState({ enabled: null });
  });

  it("shows a switch for each optional feature with its current state", () => {
    render(<FeaturesSettingsPanel />);
    expect(featureSwitch("Enable the Work Journal").getAttribute("aria-checked")).toBe("false");
  });

  it("offers no Samurai launch switch and no Second Brain switch", () => {
    render(<FeaturesSettingsPanel />);
    expect(screen.queryByRole("switch", { name: "Show Samurai launch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Show Second Brain" })).not.toBeInTheDocument();
    expect(screen.queryByText("Second Brain")).not.toBeInTheDocument();
  });

  it("turning the Work Journal on enables it", () => {
    render(<FeaturesSettingsPanel />);
    fireEvent.click(featureSwitch("Enable the Work Journal"));
    expect(useWorkJournalSettingsStore.getState().enabled).toBe(true);
  });
});
