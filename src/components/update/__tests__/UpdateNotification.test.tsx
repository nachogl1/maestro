import { render, screen } from "@testing-library/react";
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

import { useUpdateStore } from "@/stores/useUpdateStore";
import { UpdateNotification } from "../UpdateNotification";

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
