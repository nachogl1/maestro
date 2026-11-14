import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShortcutsPanel } from "../ShortcutsPanel";

describe("ShortcutsPanel", () => {
  it("lists Alt+C for Conclave", () => {
    render(<ShortcutsPanel />);
    const row = screen
      .getByText("Invoke Conclave (ask the ticked agents to coordinate)")
      .closest("li");
    expect(row).toHaveTextContent(/(Alt|⌥)\+C$/);
  });
});
