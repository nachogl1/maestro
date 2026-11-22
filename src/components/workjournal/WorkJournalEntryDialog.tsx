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
 * Esc, Close or a click outside closes it.
 */
export function WorkJournalEntryDialog({
  time,
  project,
  text,
  onClose,
}: WorkJournalEntryDialogProps) {
  return (
    <DialogShell
      title={time ? `Entry at ${time}` : "Entry"}
      subtitle={project ?? "no project"}
      onClose={onClose}
    >
      <p
        data-testid="work-journal-entry-full-text"
        className="whitespace-pre-wrap break-words text-xs text-maestro-text"
      >
        {text}
      </p>
    </DialogShell>
  );
}
