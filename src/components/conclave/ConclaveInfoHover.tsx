import { Info } from "lucide-react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** What Conclave does, shown beside the dialog's question. */
export const CONCLAVE_INFO =
  "Conclave asks the agents you tick to meet: each one messages the others, says what it is " +
  "working on, offers help where it can, and agrees how to share ports, files, worktrees and " +
  "machine time so nobody blocks anybody.";

/** Width of the floating box, in pixels (Tailwind `w-72`). */
const BOX_WIDTH_PX = 288;
/** Gap between the icon and the box, and the smallest margin to the window edge. */
const BOX_GAP_PX = 6;

/** Below the icon, kept inside the window horizontally. */
function boxPosition(icon: HTMLElement): CSSProperties {
  const rect = icon.getBoundingClientRect();
  const maxLeft = window.innerWidth - BOX_WIDTH_PX - BOX_GAP_PX;
  return {
    left: Math.max(BOX_GAP_PX, Math.min(rect.left, maxLeft)),
    top: rect.bottom + BOX_GAP_PX,
  };
}

/**
 * An (i) icon that shows {@link CONCLAVE_INFO} while the pointer is over it or
 * it has keyboard focus. Escape closes the box and stops there, so the dialog
 * around it stays open.
 */
export function ConclaveInfoHover(): JSX.Element {
  const iconRef = useRef<HTMLButtonElement>(null);
  const boxId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const open = hovered || focused;

  const show = (setter: (value: boolean) => void): void => {
    if (iconRef.current) setPosition(boxPosition(iconRef.current));
    setter(true);
  };

  useEffect(() => {
    if (!open) return;
    // Capture on window runs before the dialog's own Escape listener on the
    // document, so stopping here keeps the dialog open.
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setHovered(false);
      setFocused(false);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [open]);

  return (
    <>
      <button
        ref={iconRef}
        type="button"
        aria-label="About Conclave"
        aria-describedby={open ? boxId : undefined}
        onMouseEnter={() => show(setHovered)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => show(setFocused)}
        onBlur={() => setFocused(false)}
        className="flex shrink-0 cursor-help rounded text-maestro-muted outline-none transition-colors hover:text-maestro-text focus-visible:ring-2 focus-visible:ring-maestro-accent/40"
      >
        <Info size={13} />
      </button>
      {open &&
        createPortal(
          <div
            id={boxId}
            role="tooltip"
            style={position}
            className="pointer-events-none fixed z-[110] w-72 rounded-lg border border-maestro-border bg-maestro-card p-3 text-left text-[11px] text-maestro-muted shadow-lg"
          >
            {CONCLAVE_INFO}
          </div>,
          document.body,
        )}
    </>
  );
}
