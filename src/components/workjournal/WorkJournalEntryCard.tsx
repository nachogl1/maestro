import { NodeViewContent, type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import { GripVertical, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { normalizeEntryTime } from "@/lib/workJournalEntry";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { WorkJournalSourceTag } from "./WorkJournalSourceTag";

/** The attributes an entry card node stores (see `WorkJournalEntryNode`). */
interface WorkJournalEntryAttrs {
  time: string | null;
  project: string | null;
  source: string;
}

const CONTROL_BUTTON =
  "shrink-0 rounded px-0.5 leading-[18px] text-maestro-muted opacity-60 transition group-hover:opacity-100 disabled:cursor-not-allowed";

/**
 * One Work Journal entry card inside the page: a drag handle, the time (bold,
 * click to edit), the project chip and source tag above the card's text box
 * (the editable part, bold up to the first colon), and a delete button. Every
 * change is an editor step, so Ctrl+Z undoes it.
 */
export function WorkJournalEntryCard({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const attrs = node.attrs as WorkJournalEntryAttrs;
  // A restore or undo is replacing the journal: nothing here may change.
  const locked = useWorkJournalStore((s) => s.replacing);

  return (
    <NodeViewWrapper
      data-type="journal-entry"
      className="work-journal-entry group relative my-1.5 flex items-start gap-1.5 rounded-md border border-maestro-border bg-maestro-card px-1.5 py-1"
    >
      <span
        contentEditable={false}
        data-drag-handle=""
        draggable={!locked}
        title="Drag to move this entry"
        className="shrink-0 cursor-grab select-none py-0.5 text-maestro-muted opacity-60 group-hover:opacity-100"
      >
        <GripVertical size={12} />
      </span>
      <EntryTime
        time={attrs.time}
        disabled={locked}
        onChange={(time) => updateAttributes({ time })}
      />
      <div className="min-w-0 flex-1">
        <div contentEditable={false} className="mb-0.5 flex flex-wrap items-center gap-1">
          <EntryProjectChip
            project={attrs.project}
            disabled={locked}
            onPick={(project) => updateAttributes({ project })}
          />
          <WorkJournalSourceTag source={attrs.source} title="Where this entry came from" />
        </div>
        <NodeViewContent className="work-journal-entry-text min-w-0 break-words" />
      </div>
      <button
        type="button"
        contentEditable={false}
        onClick={deleteNode}
        disabled={locked}
        aria-label="Delete this entry"
        title="Delete this entry (Ctrl+Z brings it back)"
        className={`${CONTROL_BUTTON} hover:bg-maestro-red/10 hover:text-maestro-red`}
      >
        <X size={12} />
      </button>
    </NodeViewWrapper>
  );
}

interface EntryTimeProps {
  time: string | null;
  disabled: boolean;
  onChange: (time: string | null) => void;
}

/**
 * The card's bold time, edited in place. A valid `H:MM` or `HH:MM` is kept on
 * Enter or leaving the box (blank means no time); anything else goes back.
 */
function EntryTime({ time, disabled, onChange }: EntryTimeProps) {
  const [draft, setDraft] = useState(time ?? "");
  useEffect(() => setDraft(time ?? ""), [time]);

  const commit = (): void => {
    const next = normalizeEntryTime(draft);
    if (next === undefined) {
      setDraft(time ?? "");
      return;
    }
    setDraft(next ?? "");
    if (next !== time) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(time ?? "");
      e.currentTarget.blur();
    }
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
      disabled={disabled}
      aria-label="Entry time"
      title="Change the time"
      placeholder="--:--"
      className="w-[42px] shrink-0 rounded-sm border border-transparent bg-transparent px-0.5 font-bold leading-[18px] text-maestro-text hover:border-maestro-border focus:border-maestro-accent focus:outline-none"
    />
  );
}

interface EntryProjectChipProps {
  project: string | null;
  disabled: boolean;
  onPick: (project: string | null) => void;
}

/**
 * The card's project in that project's colour (a dashed grey "no project"
 * without one). A click lists the open projects and "No project" to pick from.
 */
function EntryProjectChip({ project, disabled, onPick }: EntryProjectChipProps) {
  const projectColors = useProjectColors();
  // The open projects in their tab order, each once.
  const openProjects = useWorkspaceStore(
    useShallow((s) => Array.from(new Set(s.tabs.map((t) => t.name)))),
  );
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const colorOf = (name: string): string => projectColors.get(name) ?? projectColorFor(name);
  const pick = (next: string | null): void => {
    setOpen(false);
    if (next !== project) onPick(next);
  };

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={project ? `Project ${project}: change the project` : "No project: pick one"}
        title="Change the project"
        className={`max-w-[10rem] truncate rounded-full border px-1.5 text-[10px] leading-[15px] disabled:cursor-not-allowed ${
          project ? "" : "border-dashed border-maestro-border text-maestro-muted"
        }`}
        style={project ? { color: colorOf(project), borderColor: colorOf(project) } : undefined}
      >
        {project ?? "no project"}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Pick a project"
          className="absolute left-0 top-full z-10 mt-1 flex min-w-[140px] flex-col rounded-md border border-maestro-border bg-maestro-surface p-1 text-[11px] shadow-lg"
        >
          {openProjects.map((name) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              onClick={() => pick(name)}
              className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-maestro-text hover:bg-maestro-card"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: colorOf(name) }}
              />
              <span className="truncate">{name}</span>
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(null)}
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-maestro-text hover:bg-maestro-card"
          >
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 shrink-0 rounded-full border border-dashed border-maestro-muted"
            />
            No project
          </button>
        </div>
      )}
    </span>
  );
}
