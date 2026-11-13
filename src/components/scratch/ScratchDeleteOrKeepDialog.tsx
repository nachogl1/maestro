import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { DialogShell, dialogButtonClass } from "@/components/shared/DialogShell";
import { type ScratchAnswer, useScratchStore } from "@/stores/useScratchStore";

/**
 * Asks "Delete the scratch project's files, or keep them?" after a scratch
 * project's last terminal closes, or when its project tab is being closed.
 * Keep leaves the folder (closing the tab when that is what was asked);
 * Delete removes the folder and closes the tab. Escape or a click outside
 * answers neither: the tab stays as it is.
 */
export function ScratchDeleteOrKeepDialog(): JSX.Element | null {
  const question = useScratchStore((s) => s.question);
  const error = useScratchStore((s) => s.error);
  const answer = useScratchStore((s) => s.answer);
  const [busy, setBusy] = useState(false);

  if (!question) return null;

  const reply = async (choice: ScratchAnswer): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await answer(choice);
    } finally {
      setBusy(false);
    }
  };

  const stops =
    question.reason === "close-tab" && question.runningCount > 0
      ? ` Closing the tab stops its ${question.runningCount} running terminal${
          question.runningCount === 1 ? "" : "s"
        }.`
      : "";

  return (
    <DialogShell
      title={`Scratch project ${question.name}`}
      icon={<FlaskConical size={16} />}
      size="sm"
      onClose={() => void reply("cancel")}
      footer={
        <>
          <button
            type="button"
            onClick={() => void reply("keep")}
            disabled={busy}
            className={dialogButtonClass("primary")}
          >
            Keep
          </button>
          <button
            type="button"
            onClick={() => void reply("delete")}
            disabled={busy}
            className={dialogButtonClass("danger")}
          >
            Delete
          </button>
        </>
      }
    >
      <p className="text-xs text-maestro-text">
        Delete the scratch project's files, or keep them?{stops}
      </p>
      {error && (
        <p role="alert" className="text-[11px] text-maestro-red">
          {error}
        </p>
      )}
    </DialogShell>
  );
}
