import { useEffect, useRef } from "react";
import { DialogShell } from "@/components/shared/DialogShell";

interface WorkJournalEntryDialogProps {
  time: string | null;
  project: string | null;
  /** The card's whole text, each line break kept. */
  text: string;
  onClose: () => void;
}

/**
 * A long entry card's whole text, read-only, under its time and project.
 * Esc, Close or a click outside closes it. Keyboard focus sits in the dialog
 * while it is open, so no key reaches the page behind it, and goes back to
 * where it was when it closes.
 */
export function WorkJournalEntryDialog({
  time,
  project,
  text,
  onClose,
}: WorkJournalEntryDialogProps) {
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const body = textRef.current;
    const panel = body?.closest<HTMLElement>('[role="dialog"]');
    if (!body || !panel) return;
    const before = document.activeElement as HTMLElement | null;
    body.focus();
    const keepFocusInside = (e: FocusEvent): void => {
      if (!panel.contains(e.target as Node)) body.focus();
    };
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("focusin", keepFocusInside);
      before?.focus();
    };
  }, []);

  return (
    <DialogShell
      title={time ? `Entry at ${time}` : "Entry"}
      subtitle={project ?? "no project"}
      onClose={onClose}
    >
      <p
        ref={textRef}
        // Focusable, so the arrow and page keys scroll the text.
        tabIndex={-1}
        data-testid="work-journal-entry-full-text"
        className="whitespace-pre-wrap break-words text-xs text-maestro-text outline-none"
      >
        {text}
      </p>
    </DialogShell>
  );
}
