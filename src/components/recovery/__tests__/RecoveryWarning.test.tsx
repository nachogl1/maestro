import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { useOpenTerminalsSnapshotStore } from "@/stores/useOpenTerminalsSnapshotStore";
import { RecoveryWarning } from "../RecoveryWarning";
import { RECOVERY_WARNING_TEXT } from "../recovery";

describe("RecoveryWarning", () => {
  beforeEach(() => {
    useOpenTerminalsSnapshotStore.setState({ warnedSessionIds: [3] });
  });

  it("shows the amber line on a terminal brought back without its content until its × is clicked", () => {
    render(<RecoveryWarning sessionId={3} />);
    expect(screen.getByText(RECOVERY_WARNING_TEXT)).toBeInTheDocument();
    expect(RECOVERY_WARNING_TEXT).toBe(
      "Brought back after Maestro stopped. Its earlier content could not be retrieved.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close this warning" }));

    expect(screen.queryByText(RECOVERY_WARNING_TEXT)).toBeNull();
  });

  it("shows nothing on any other terminal (a resumed Claude terminal among them)", () => {
    render(<RecoveryWarning sessionId={4} />);
    expect(screen.queryByText(RECOVERY_WARNING_TEXT)).toBeNull();
  });
});
