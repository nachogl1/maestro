import { type RefObject, useEffect, useState } from "react";

import { boundaryOffsets, dragBoundary, equalWeights } from "@/lib/eagleGridSizes";

interface EagleGridResizerProps {
  /** The eagle grid container. Its offsetParent is also the handles' containing block. */
  containerRef: RefObject<HTMLDivElement | null>;
  colWeights: number[];
  rowWeights: number[];
  onColWeightsChange: (weights: number[]) => void;
  onRowWeightsChange: (weights: number[]) => void;
  onDragStateChange: (dragging: boolean) => void;
  /** Grid gap and container padding in px — must match the grid's own styles. */
  gapPx: number;
  paddingPx: number;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Drag handles sitting in the gaps of the eagle view grid: drag one to resize
 * the columns (or rows) on either side of it, double-click to make that axis
 * equal again.
 *
 * The handles are absolutely positioned against the grid's offsetParent (App's
 * <main>) instead of the grid itself, because the grid is deliberately left
 * unpositioned — eagle-zoomed panes resolve their own positioning to <main>.
 * Being absolute, they also never take a grid cell.
 */
export function EagleGridResizer({
  containerRef,
  colWeights,
  rowWeights,
  onColWeightsChange,
  onRowWeightsChange,
  onDragStateChange,
  gapPx,
  paddingPx,
}: EagleGridResizerProps) {
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setBox({
        left: el.offsetLeft,
        top: el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  if (!box) return null;

  const innerWidth = box.width - 2 * paddingPx;
  const innerHeight = box.height - 2 * paddingPx;
  const availWidth = innerWidth - (colWeights.length - 1) * gapPx;
  const availHeight = innerHeight - (rowWeights.length - 1) * gapPx;

  const startDrag = (
    e: React.MouseEvent,
    axis: "col" | "row",
    index: number,
    startWeights: number[],
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const start = axis === "col" ? e.clientX : e.clientY;
    const avail = axis === "col" ? availWidth : availHeight;
    const apply = axis === "col" ? onColWeightsChange : onRowWeightsChange;
    onDragStateChange(true);
    document.body.style.cursor = axis === "col" ? "col-resize" : "row-resize";

    const handleMove = (ev: MouseEvent) => {
      const pos = axis === "col" ? ev.clientX : ev.clientY;
      apply(dragBoundary(startWeights, index, pos - start, avail));
    };
    const handleUp = () => {
      onDragStateChange(false);
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handleClass =
    "absolute z-30 rounded-sm bg-transparent transition-colors hover:bg-maestro-accent/60";

  return (
    <>
      {boundaryOffsets(colWeights, availWidth, gapPx).map((offset, index) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: mouse-drag resize handle, same as the split-pane divider.
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: one handle per track boundary; the index IS its identity.
          key={`col-${index}`}
          data-testid="eagle-col-resizer"
          className={`${handleClass} cursor-col-resize`}
          title="Drag to resize columns, double-click to reset"
          style={{
            left: box.left + paddingPx + offset - gapPx / 2,
            top: box.top + paddingPx,
            width: gapPx,
            height: innerHeight,
          }}
          onMouseDown={(e) => startDrag(e, "col", index, colWeights)}
          onDoubleClick={() => onColWeightsChange(equalWeights(colWeights.length))}
        />
      ))}
      {boundaryOffsets(rowWeights, availHeight, gapPx).map((offset, index) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: mouse-drag resize handle, same as the split-pane divider.
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: one handle per track boundary; the index IS its identity.
          key={`row-${index}`}
          data-testid="eagle-row-resizer"
          className={`${handleClass} cursor-row-resize`}
          title="Drag to resize rows, double-click to reset"
          style={{
            left: box.left + paddingPx,
            top: box.top + paddingPx + offset - gapPx / 2,
            width: innerWidth,
            height: gapPx,
          }}
          onMouseDown={(e) => startDrag(e, "row", index, rowWeights)}
          onDoubleClick={() => onRowWeightsChange(equalWeights(rowWeights.length))}
        />
      ))}
    </>
  );
}
