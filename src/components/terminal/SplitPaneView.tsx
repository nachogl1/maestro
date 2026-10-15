import { type CSSProperties, type ReactNode, useCallback, useRef } from "react";

import type { TreeNode } from "./splitTree";

interface SplitPaneViewProps {
  node: TreeNode;
  renderLeaf: (slotId: string) => ReactNode;
  onRatioChange: (nodeId: string, ratio: number) => void;
  onDragStateChange: (dragging: boolean) => void;
  /**
   * Eagle view: flatten this tree out of the layout entirely.
   * Leaf hosts stop participating in layout (`display: contents`, no
   * dividers) so every pane becomes a direct item of the global eagle grid —
   * WITHOUT changing the React tree, which keeps the xterm instances mounted
   * (no remount, no lost scrollback).
   */
  eagleMode?: boolean;
  /**
   * Id written to `data-split-stage` on the split area (non-eagle only), so
   * a pane drag can hit-test the area's outer edges and keyboard moves can
   * find this grid's panes.
   */
  stageId?: string;
  /**
   * Slots to CSS-hide (parked terminals). Hiding is className-only — the
   * React element tree never changes shape, so the xterm instances stay
   * mounted (same keep-alive trick as eagle mode's flattening).
   */
  hiddenSlotIds?: ReadonlySet<string>;
  /**
   * Per-project zoom: when set, this slot's host overlays the whole container
   * (inset-0) and every other host turns visibility:hidden — again CSS-only,
   * so zooming in/out never remounts an xterm (the old dedicated zoom render
   * swapped the element tree and wiped every pane's scrollback). Ignored in
   * eagle mode, which has its own zoom mechanism.
   */
  zoomedSlotId?: string | null;
}

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
/** Thickness of the draggable divider (matches .split-divider-* in CSS). */
const DIVIDER_PX = 4;

function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** True when every leaf under `node` is hidden (the subtree occupies no space). */
function subtreeAllHidden(node: TreeNode, hidden: ReadonlySet<string> | undefined): boolean {
  if (!hidden || hidden.size === 0) return false;
  if (node.type === "leaf") return hidden.has(node.slotId);
  return subtreeAllHidden(node.children[0], hidden) && subtreeAllHidden(node.children[1], hidden);
}

/**
 * A length/offset expressed as a fraction of the root container plus a pixel
 * adjustment (the pixels account for the divider thickness consumed at each
 * split boundary).
 */
interface Affine {
  f: number;
  px: number;
}

interface Rect {
  left: Affine;
  top: Affine;
  width: Affine;
  height: Affine;
}

interface LeafBox {
  slotId: string;
  rect: Rect;
}

interface DividerBox {
  nodeId: string;
  direction: "horizontal" | "vertical";
  /** The divider bar itself. */
  rect: Rect;
  /** The full rect of the split node — ratio math during drag needs it. */
  region: Rect;
}

const FULL_RECT: Rect = {
  left: { f: 0, px: 0 },
  top: { f: 0, px: 0 },
  width: { f: 1, px: 0 },
  height: { f: 1, px: 0 },
};

function scaled(a: Affine, k: number, pxAdjust: number): Affine {
  return { f: a.f * k, px: a.px * k + pxAdjust };
}

/**
 * In-order walk computing every leaf's rectangle and every divider's
 * rectangle. Hidden (parked) subtrees stay in the output — their leaves must
 * keep rendering (display:none) so nothing remounts — but they yield their
 * space to the visible sibling and paint no divider.
 */
function collectBoxes(
  node: TreeNode,
  rect: Rect,
  hidden: ReadonlySet<string> | undefined,
  leaves: LeafBox[],
  dividers: DividerBox[],
): void {
  if (node.type === "leaf") {
    leaves.push({ slotId: node.slotId, rect });
    return;
  }

  const h0 = subtreeAllHidden(node.children[0], hidden);
  const h1 = subtreeAllHidden(node.children[1], hidden);

  // A fully hidden side yields the whole rect to the other; no divider.
  if (h0 || h1) {
    collectBoxes(node.children[0], rect, hidden, leaves, dividers);
    collectBoxes(node.children[1], rect, hidden, leaves, dividers);
    return;
  }

  const r = node.ratio;
  if (node.direction === "vertical") {
    // left + r*width — where the divider's center line sits.
    const boundary: Affine = {
      f: rect.left.f + rect.width.f * r,
      px: rect.left.px + rect.width.px * r,
    };
    dividers.push({
      nodeId: node.id,
      direction: node.direction,
      region: rect,
      rect: {
        left: { f: boundary.f, px: boundary.px - DIVIDER_PX / 2 },
        top: rect.top,
        width: { f: 0, px: DIVIDER_PX },
        height: rect.height,
      },
    });
    collectBoxes(
      node.children[0],
      { ...rect, width: scaled(rect.width, r, -DIVIDER_PX / 2) },
      hidden,
      leaves,
      dividers,
    );
    collectBoxes(
      node.children[1],
      {
        ...rect,
        left: { f: boundary.f, px: boundary.px + DIVIDER_PX / 2 },
        width: scaled(rect.width, 1 - r, -DIVIDER_PX / 2),
      },
      hidden,
      leaves,
      dividers,
    );
  } else {
    const boundary: Affine = {
      f: rect.top.f + rect.height.f * r,
      px: rect.top.px + rect.height.px * r,
    };
    dividers.push({
      nodeId: node.id,
      direction: node.direction,
      region: rect,
      rect: {
        left: rect.left,
        top: { f: boundary.f, px: boundary.px - DIVIDER_PX / 2 },
        width: rect.width,
        height: { f: 0, px: DIVIDER_PX },
      },
    });
    collectBoxes(
      node.children[0],
      { ...rect, height: scaled(rect.height, r, -DIVIDER_PX / 2) },
      hidden,
      leaves,
      dividers,
    );
    collectBoxes(
      node.children[1],
      {
        ...rect,
        top: { f: boundary.f, px: boundary.px + DIVIDER_PX / 2 },
        height: scaled(rect.height, 1 - r, -DIVIDER_PX / 2),
      },
      hidden,
      leaves,
      dividers,
    );
  }
}

function affineCss(a: Affine): string {
  if (a.px === 0) return `${a.f * 100}%`;
  return `calc(${a.f * 100}% + ${a.px}px)`;
}

function rectStyle(rect: Rect): CSSProperties {
  return {
    left: affineCss(rect.left),
    top: affineCss(rect.top),
    width: affineCss(rect.width),
    height: affineCss(rect.height),
  };
}

/**
 * Renders the binary split tree as a FLAT list of absolutely positioned leaf
 * hosts (keyed by slotId) plus divider bars, with every rectangle computed
 * from the tree geometry.
 *
 * Flat-and-keyed is deliberate: with the previous nested-flexbox rendering,
 * swapping two slots moved the keyed pane between different parent elements,
 * which React can only do by unmounting — both xterms were disposed, wiping
 * scrollback and dropping any PTY output emitted during the remount window.
 * Here a swap only changes each host's inline style, so the live terminals
 * are never torn down by layout changes.
 */
export function SplitPaneView({
  node,
  renderLeaf,
  onRatioChange,
  onDragStateChange,
  eagleMode = false,
  hiddenSlotIds,
  zoomedSlotId = null,
  stageId,
}: SplitPaneViewProps) {
  const leaves: LeafBox[] = [];
  const dividers: DividerBox[] = [];
  collectBoxes(node, FULL_RECT, hiddenSlotIds, leaves, dividers);

  const zoomActive = !eagleMode && zoomedSlotId !== null;

  // Leaves keep the tree's in-order traversal order — in eagle mode the DOM
  // order IS the grid tile order, and keeping it identical in both modes
  // means toggling eagle view never reorders (or otherwise touches) the
  // mounted pane elements.
  return (
    <div
      className={eagleMode ? "contents" : "relative h-full w-full min-h-0 min-w-0"}
      // Lets a pane drag find the whole split area (drop on its outer edge =
      // full column/row) and keyboard moves find this grid's panes.
      data-split-stage={eagleMode ? undefined : stageId}
    >
      {leaves.map(({ slotId, rect }) => {
        const isHidden = hiddenSlotIds?.has(slotId) ?? false;
        const isZoomed = zoomActive && slotId === zoomedSlotId;
        // While zoomed, the other panes keep their layout rect but stop
        // painting (visibility) — they're behind an opaque overlay, and
        // keeping their size stable avoids a refit storm on zoom-out.
        const isObscured = zoomActive && slotId !== zoomedSlotId;
        return (
          <div
            key={slotId}
            data-slot-id={slotId}
            className={
              isHidden
                ? "hidden"
                : eagleMode
                  ? "contents"
                  : isZoomed
                    ? "absolute inset-0 min-w-0 min-h-0 overflow-hidden"
                    : `absolute min-w-0 min-h-0 overflow-hidden${isObscured ? " invisible" : ""}`
            }
            style={isHidden || eagleMode || isZoomed ? undefined : rectStyle(rect)}
          >
            {renderLeaf(slotId)}
          </div>
        );
      })}
      {!eagleMode &&
        !zoomActive &&
        dividers.map((d) => (
          <Divider
            key={d.nodeId}
            box={d}
            onRatioChange={onRatioChange}
            onDragStateChange={onDragStateChange}
          />
        ))}
    </div>
  );
}

interface DividerProps {
  box: DividerBox;
  onRatioChange: (nodeId: string, ratio: number) => void;
  onDragStateChange: (dragging: boolean) => void;
}

function Divider({ box, onRatioChange, onDragStateChange }: DividerProps) {
  const dividerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const divider = dividerRef.current;
      if (!divider) return;

      // The flat container — all rects are fractions of it.
      const container = divider.parentElement;
      if (!container) return;

      onDragStateChange(true);

      const isVertical = box.direction === "vertical";
      const { region } = box;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        let ratio: number;
        if (isVertical) {
          const regionLeft = rect.left + region.left.f * rect.width + region.left.px;
          const regionWidth = region.width.f * rect.width + region.width.px;
          ratio = (moveEvent.clientX - regionLeft) / regionWidth;
        } else {
          const regionTop = rect.top + region.top.f * rect.height + region.top.px;
          const regionHeight = region.height.f * rect.height + region.height.px;
          ratio = (moveEvent.clientY - regionTop) / regionHeight;
        }
        onRatioChange(box.nodeId, clampRatio(ratio));
      };

      const handleMouseUp = () => {
        onDragStateChange(false);
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [box, onRatioChange, onDragStateChange],
  );

  const isVertical = box.direction === "vertical";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-drag resize divider; a full keyboard-resizable separator (role="separator" + aria-valuenow/min/max + arrow-key handling) is a real feature addition, not a safe lint fix.
    <div
      ref={dividerRef}
      className={`split-divider absolute ${isVertical ? "split-divider-vertical" : "split-divider-horizontal"}`}
      style={rectStyle(box.rect)}
      onMouseDown={handleMouseDown}
    />
  );
}
