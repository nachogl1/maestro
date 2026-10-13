import { fireEvent, render, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type UseDismissableOptions, useDismissable } from "@/hooks/useDismissable";

interface HarnessProps {
  onDismiss: () => void;
  options?: Omit<UseDismissableOptions, "ref">;
  withRef?: boolean;
}

/** An overlay with an inner button, plus a sibling outside it. */
function Harness({ onDismiss, options, withRef = true }: HarnessProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(onDismiss, { ...options, ref: withRef ? ref : undefined });
  return (
    <div>
      <div ref={ref} data-testid="inside">
        <button type="button">inner</button>
      </div>
      <div data-testid="outside" />
    </div>
  );
}

describe("useDismissable", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dismisses on Escape", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses on a mousedown outside the element", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness onDismiss={onDismiss} />);
    fireEvent.mouseDown(getByTestId("outside"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss on a mousedown inside the element", () => {
    const onDismiss = vi.fn();
    const { getByText, getByTestId } = render(<Harness onDismiss={onDismiss} />);
    fireEvent.mouseDown(getByTestId("inside"));
    fireEvent.mouseDown(getByText("inner"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("without a ref, only Escape dismisses", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness onDismiss={onDismiss} withRef={false} />);
    fireEvent.mouseDown(getByTestId("outside"));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("escape: false keeps outside clicks but ignores Escape", () => {
    const onDismiss = vi.fn();
    const { getByTestId } = render(<Harness onDismiss={onDismiss} options={{ escape: false }} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(getByTestId("outside"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("binds nothing while disabled, and binds once enabled", () => {
    const onDismiss = vi.fn();
    const { getByTestId, rerender } = render(
      <Harness onDismiss={onDismiss} options={{ enabled: false }} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(getByTestId("outside"));
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<Harness onDismiss={onDismiss} options={{ enabled: true }} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls the latest callback without re-binding listeners", () => {
    const add = vi.spyOn(document, "addEventListener");
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useDismissable(cb), {
      initialProps: { cb: first },
    });
    const bound = add.mock.calls.filter(([type]) => type === "keydown").length;
    rerender({ cb: second });
    expect(add.mock.calls.filter(([type]) => type === "keydown").length).toBe(bound);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("removes its listeners on unmount", () => {
    const onDismiss = vi.fn();
    const { getByTestId, unmount } = render(<Harness onDismiss={onDismiss} />);
    const outside = getByTestId("outside");
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(outside);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
