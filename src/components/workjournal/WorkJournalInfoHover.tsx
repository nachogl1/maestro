import { Info } from "lucide-react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * What the Work Journal does and which sources it reads, written once and
 * shown both on the first-run question and in Settings → Work Journal.
 */
export const WORK_JOURNAL_INFO = {
  whatHeading: "What the Work Journal does",
  what:
    "It keeps one page per day. Claude reads your activity and suggests short lines; " +
    "nothing is added until you accept it.",
  sourcesHeading: "Sources it reads",
  sources: [
    "Claude conversations in Maestro",
    "Terminal sessions in Maestro",
    "Git commits — needs your git name/email set",
    "Pull requests and issues — needs gh signed in",
    "Granola meetings — off until you turn it on in Settings, and Granola connected to Claude",
  ],
  closing: "Suggestions are written by the Claude CLI.",
} as const;

/** Width of the floating box, in pixels (Tailwind `w-72`). */
const BOX_WIDTH_PX = 288;
/** Gap between the icon and the box, and the smallest margin to the window edge. */
const BOX_GAP_PX = 6;

/** Where the box sits: below the icon, or above it when the icon is in the lower half. */
function boxPosition(icon: HTMLElement): CSSProperties {
  const rect = icon.getBoundingClientRect();
  const maxLeft = window.innerWidth - BOX_WIDTH_PX - BOX_GAP_PX;
  const left = Math.max(BOX_GAP_PX, Math.min(rect.left, maxLeft));
  if (rect.top > window.innerHeight / 2) {
    return { left, bottom: window.innerHeight - rect.top + BOX_GAP_PX };
  }
  return { left, top: rect.bottom + BOX_GAP_PX };
}

/**
 * An (i) icon that shows {@link WORK_JOURNAL_INFO} in a floating box while the
 * pointer is over it or it has keyboard focus. Escape closes the box and stops
 * there, so the dialog around it stays open.
 */
export function WorkJournalInfoHover(): JSX.Element {
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
    // document, so stopping here keeps the dialog (and its question) open.
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
        aria-label="About the Work Journal"
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
            className="pointer-events-none fixed z-[110] w-72 space-y-2 rounded-lg border border-maestro-border bg-maestro-card p-3 text-left text-[11px] normal-case tracking-normal text-maestro-text shadow-lg"
          >
            <div>
              <p className="font-semibold">{WORK_JOURNAL_INFO.whatHeading}</p>
              <p className="mt-0.5 text-maestro-muted">{WORK_JOURNAL_INFO.what}</p>
            </div>
            <div>
              <p className="font-semibold">{WORK_JOURNAL_INFO.sourcesHeading}</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-maestro-muted">
                {WORK_JOURNAL_INFO.sources.map((source) => (
                  <li key={source}>{source}</li>
                ))}
              </ul>
            </div>
            <p className="text-maestro-muted">{WORK_JOURNAL_INFO.closing}</p>
          </div>,
          document.body,
        )}
    </>
  );
}
