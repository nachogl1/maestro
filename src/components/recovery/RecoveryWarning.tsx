import { AlertTriangle, X } from "lucide-react";
import { useOpenTerminalsSnapshotStore } from "@/stores/useOpenTerminalsSnapshotStore";
import { RECOVERY_WARNING_TEXT } from "./recovery";

export interface RecoveryWarningProps {
  sessionId: number;
}

/**
 * The amber line under the header of a terminal brought back after Maestro
 * stopped without its earlier content — a plain shell, or a Claude terminal
 * whose conversation was not found (issue #608, prototype scene 2). It stays
 * until its × is clicked; renders nothing for every other terminal.
 */
export function RecoveryWarning({ sessionId }: RecoveryWarningProps): JSX.Element | null {
  const warned = useOpenTerminalsSnapshotStore((s) => s.warnedSessionIds.includes(sessionId));
  const dismiss = useOpenTerminalsSnapshotStore((s) => s.dismissWarning);
  if (!warned) return null;
  return (
    <output className="flex shrink-0 items-start gap-1.5 border-b border-maestro-orange/40 bg-maestro-orange/10 px-2 py-1 text-[11px] text-maestro-orange">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span className="flex-1">{RECOVERY_WARNING_TEXT}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          dismiss(sessionId);
        }}
        aria-label="Close this warning"
        title="Close this warning"
        className="shrink-0 leading-none hover:text-maestro-text"
      >
        <X size={12} />
      </button>
    </output>
  );
}
