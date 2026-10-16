import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextDocEditorModal } from "../ContextDocEditorModal";

vi.mock("@/lib/claudemd", () => ({ writeContextDoc: vi.fn() }));

describe("ContextDocEditorModal", () => {
  it("keeps the editor open on an outside click so unsaved edits survive", () => {
    const onClose = vi.fn();
    render(
      <ContextDocEditorModal
        path="C:/repo/.gitignore"
        label=".gitignore"
        tier="project"
        kind="gitignore"
        exists
        initialContent="node_modules"
        onClose={onClose}
      />,
    );
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
