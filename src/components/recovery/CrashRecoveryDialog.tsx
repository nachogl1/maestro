import { RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DialogShell, dialogButtonClass } from "@/components/shared/DialogShell";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import {
  canBringBack,
  type OfferedTerminal,
  type OpenTerminalsOffer,
  useOpenTerminalsSnapshotStore,
} from "@/stores/useOpenTerminalsSnapshotStore";
import { formatStopTime, groupByProject, samuraiLine, whatComesBack } from "./recovery";

/**
 * Crash recovery (issue #608): after Maestro stopped unexpectedly, the first
 * start lists the terminals that were open and brings the ticked ones back.
 * Mounted once by the app; it reads the saved list on mount and renders
 * nothing when there is nothing to offer (a first start, or after a normal
 * close). Layout: `docs/ux/prototypes/crash-recovery/`, scene 1.
 */
export function CrashRecoveryDialog(): JSX.Element | null {
  const offer = useOpenTerminalsSnapshotStore((s) => s.offer);
  const begin = useOpenTerminalsSnapshotStore((s) => s.begin);

  useEffect(() => {
    void begin();
  }, [begin]);

  return offer ? <OfferDialog offer={offer} /> : null;
}

interface OfferDialogProps {
  offer: OpenTerminalsOffer;
}

function OfferDialog({ offer }: OfferDialogProps): JSX.Element {
  const decline = useOpenTerminalsSnapshotStore((s) => s.decline);
  const bringBack = useOpenTerminalsSnapshotStore((s) => s.bringBack);
  const projectColors = useProjectColors();
  const groups = useMemo(() => groupByProject(offer.terminals), [offer.terminals]);
  const possible = useMemo(
    () => offer.terminals.flatMap((t, i) => (canBringBack(t) ? [i] : [])),
    [offer.terminals],
  );
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(possible));
  const allRef = useRef<HTMLInputElement>(null);
  const samurai = samuraiLine(offer.terminals);

  const allTicked = ticked.size === possible.length;
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = ticked.size > 0 && !allTicked;
  }, [ticked, allTicked]);

  const toggle = (index: number): void =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const toggleAll = (): void => setTicked(allTicked ? new Set() : new Set(possible));

  const accept = (): void => {
    const chosen: OfferedTerminal[] = offer.terminals.filter((_, i) => ticked.has(i));
    void bringBack(chosen);
  };

  return (
    <DialogShell
      title="Maestro stopped unexpectedly"
      icon={<RotateCcw size={14} />}
      subtitle={`${formatStopTime(offer.savedAt)} · these terminals were open`}
      onClose={() => void decline()}
      closeOnOutsideClick={false}
      footer={
        <>
          <button
            type="button"
            onClick={() => void decline()}
            className={dialogButtonClass("ghost")}
          >
            Don&apos;t bring back
          </button>
          <button
            type="button"
            onClick={accept}
            disabled={ticked.size === 0}
            className={dialogButtonClass("primary")}
          >
            Bring back {ticked.size}
          </button>
        </>
      }
    >
      <label className="flex items-center gap-2 border-b border-maestro-border pb-1.5 text-xs text-maestro-muted">
        <input
          ref={allRef}
          type="checkbox"
          className="h-3 w-3 accent-maestro-accent"
          checked={allTicked && possible.length > 0}
          disabled={possible.length === 0}
          onChange={toggleAll}
          aria-label="Tick all terminals"
        />
        <span>
          {ticked.size} of {possible.length} selected
        </span>
      </label>

      {groups.map((group) => {
        const color = projectColors.get(group.name) ?? projectColorFor(group.name);
        return (
          <div key={group.projectPath}>
            <div
              className="mb-0.5 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color }}
            >
              {group.name}
            </div>
            {group.rows.map(({ index, terminal }) => {
              const gone = !terminal.folderExists;
              const name = terminal.name ?? "Unnamed terminal";
              return (
                <label
                  key={index}
                  className={`flex items-center gap-2 py-1 text-xs ${gone ? "opacity-45" : "cursor-pointer"}`}
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-maestro-accent"
                    checked={ticked.has(index)}
                    disabled={gone}
                    onChange={() => toggle(index)}
                    aria-label={name}
                  />
                  <span className="truncate font-medium text-maestro-text">{name}</span>
                  <span className="shrink-0 rounded border border-maestro-border px-1 text-[10px] text-maestro-muted">
                    {terminal.kind === "Claude" ? "Claude" : "Shell"}
                  </span>
                  {terminal.parked && (
                    <span className="shrink-0 rounded border border-maestro-purple/50 px-1 text-[10px] text-maestro-purple">
                      was parked
                    </span>
                  )}
                  <span
                    className={`ml-auto shrink-0 text-right text-[11px] ${gone ? "text-maestro-orange" : "text-maestro-muted"}`}
                  >
                    {whatComesBack(terminal)}
                  </span>
                </label>
              );
            })}
          </div>
        );
      })}

      {samurai && (
        <p className="border-t border-maestro-border pt-1.5 text-xs text-maestro-muted">
          {samurai}
        </p>
      )}
    </DialogShell>
  );
}
