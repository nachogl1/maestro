import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DialogRow, DialogSection, DialogShell, DialogToggle } from "../DialogShell";

describe("DialogShell", () => {
  it("renders an accessible dialog with its title, body and footer at the top of the document", () => {
    const { container } = render(
      <div data-testid="host">
        <DialogShell title="Example Settings" subtitle="A hint" onClose={vi.fn()} footer={<b>F</b>}>
          <p>Body text</p>
        </DialogShell>
      </div>,
    );
    const dialog = screen.getByRole("dialog", { name: "Example Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("A hint")).toBeInTheDocument();
    expect(screen.getByText("Body text")).toBeInTheDocument();
    expect(screen.getByText("F")).toBeInTheDocument();
    // A portal: the dialog is not inside the component that opened it...
    expect(container.querySelector('[data-testid="host"]')?.contains(dialog)).toBe(false);
    // ...and its backdrop outranks the z-50 tab bar and zoomed panes.
    const backdrop = dialog.closest(".fixed");
    expect(backdrop?.parentElement).toBe(document.body);
    expect(backdrop?.className).toContain("z-[100]");
  });

  it("closes from the X button", () => {
    const onClose = vi.fn();
    render(
      <DialogShell title="Example" onClose={onClose}>
        x
      </DialogShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and on a click outside the panel by default", () => {
    const onClose = vi.fn();
    render(
      <DialogShell title="Example" onClose={onClose}>
        <span>inside</span>
      </DialogShell>,
    );
    fireEvent.mouseDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the dialog open on Escape and outside clicks when asked to", () => {
    const onClose = vi.fn();
    render(
      <DialogShell
        title="Example"
        onClose={onClose}
        closeOnEscape={false}
        closeOnOutsideClick={false}
      >
        <span>inside</span>
      </DialogShell>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hands the scrollable body to the caller through bodyRef", () => {
    const bodyRef = { current: null as HTMLDivElement | null };
    render(
      <DialogShell title="Example" onClose={vi.fn()} bodyRef={bodyRef}>
        <DialogSection title="Section A" hint="What A does">
          one
        </DialogSection>
        <DialogSection title="Section B">two</DialogSection>
      </DialogShell>,
    );
    expect(bodyRef.current).not.toBeNull();
    expect(bodyRef.current?.children).toHaveLength(2);
    expect(screen.getByText("Section A")).toHaveAttribute("title", "What A does");
  });

  it("renders a labelled row and a switch toggle", () => {
    const onChange = vi.fn();
    render(
      <DialogShell title="Example" onClose={vi.fn()}>
        <DialogRow label="Auto-check" hint="Looks for newer versions">
          <DialogToggle checked={false} onChange={onChange} aria-label="Toggle auto-check" />
        </DialogRow>
      </DialogShell>,
    );
    expect(screen.getByText("Auto-check").closest("[title]")).toHaveAttribute(
      "title",
      "Looks for newer versions",
    );
    const toggle = screen.getByRole("switch", { name: "Toggle auto-check" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
