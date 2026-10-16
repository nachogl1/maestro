import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMarketplaceStore } from "@/stores/useMarketplaceStore";
import type { MarketplacePlugin } from "@/types/marketplace";
import { PluginInstallModal } from "../PluginInstallModal";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const plugin = {
  id: "demo",
  name: "Demo Plugin",
  description: "A demo",
  version: "1.0.0",
  author: "Someone",
  types: [],
  tags: [],
  download_url: null,
  repository_url: null,
  source_path: null,
  marketplace_id: "official",
} as unknown as MarketplacePlugin;

describe("PluginInstallModal", () => {
  it("shows the store's install error in the dialog when the install fails", async () => {
    useMarketplaceStore.setState({
      installPlugin: async () => {
        useMarketplaceStore.setState({ error: "git clone failed", installingPluginId: null });
        return null;
      },
    });
    const onInstalled = vi.fn();
    render(<PluginInstallModal plugin={plugin} onClose={vi.fn()} onInstalled={onInstalled} />);

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(await screen.findByText("git clone failed")).toBeTruthy();
    expect(onInstalled).not.toHaveBeenCalled();
  });
});
