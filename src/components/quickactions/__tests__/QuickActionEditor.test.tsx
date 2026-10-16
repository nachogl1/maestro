import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickActionEditor } from "../QuickActionEditor";

describe("QuickActionEditor", () => {
  it("keeps the editor open on an outside click so unsaved edits survive", () => {
    const onClose = vi.fn();
    render(<QuickActionEditor onSave={vi.fn()} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes on Escape", () => {
    const onClose = vi.fn();
    render(<QuickActionEditor onSave={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
