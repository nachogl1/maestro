import { useCallback, useEffect, useRef, useState } from "react";

interface PanelResizeHandleProps {
  /** Current panel width in pixels. */
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  /**
   * Which edge of the panel the handle sits on: "left" for right-docked
   * panels (dragging left widens), "right" for left-docked ones.
   */
  edge: "left" | "right";
  label: string;
  /** Notifies the panel so it can pause width transitions during a drag. */
  onDraggingChange?: (dragging: boolean) => void;
}

/**
 * Vertical drag handle for resizing a docked panel, with keyboard support
 * (arrows / PageUp / PageDown / Home / End). The left icon strip's panels
 * use it on their right edge.
 */
export function PanelResizeHandle({
  width,
  min,
  max,
  onResize,
  edge,
  label,
  onDraggingChange,
}: PanelResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);

  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, Math.round(value))),
    [min, max],
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    onDraggingChange?.(true);
    dragStartRef.current = { x: e.clientX, w: width };
  };

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = e.clientX - dragStartRef.current.x;
      // Left-edge handle: moving the pointer left grows a right-docked panel.
      const raw = edge === "left" ? dragStartRef.current.w - delta : dragStartRef.current.w + delta;
      onResize(clamp(raw));
    };
    const onUp = () => {
      setIsDragging(false);
      onDraggingChange?.(false);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, edge, onResize, clamp, onDraggingChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const smallStep = 8;
    const largeStep = 24;
    // Arrows follow the pointer direction, so which one grows depends on edge.
    const grow = edge === "left" ? -1 : 1;
    let next = width;

    switch (e.key) {
      case "ArrowLeft":
        next = width - smallStep * grow;
        break;
      case "ArrowRight":
        next = width + smallStep * grow;
        break;
      case "PageDown":
        next = width - largeStep;
        break;
      case "PageUp":
        next = width + largeStep;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }

    e.preventDefault();
    onResize(clamp(next));
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: Vertical resizer requires interactive div for pointer/keyboard handling.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      aria-valuetext={`${Math.round(width)} pixels`}
      tabIndex={0}
      aria-label={label}
      className={`absolute ${
        edge === "left" ? "left-0" : "right-0"
      } top-0 z-10 h-full w-1 cursor-col-resize hover:bg-maestro-accent/30 active:bg-maestro-accent/40`}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  );
}
