import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  Folder,
  FolderOpen,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { FileEntry } from "./filesApi";

/** Indent per tree level, in pixels. */
const INDENT_PX = 12;
const BASE_PADDING_PX = 6;

/** What a row can ask the panel to do with its entry. */
export interface FileActions {
  preview: (path: string) => void;
  open: (path: string) => void;
  copy: (path: string) => void;
  menu: (entry: FileEntry, x: number, y: number) => void;
}

interface FileTreeRowProps {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  onToggle: (entry: FileEntry) => void;
  actions: FileActions;
}

export function rowIndent(depth: number): number {
  return BASE_PADDING_PX + depth * INDENT_PX;
}

/** One tree entry: a folder opens on click, a file previews on click and opens on double-click. */
export function FileTreeRow({
  entry,
  depth,
  expanded,
  selected,
  onToggle,
  actions,
}: FileTreeRowProps) {
  const activate = () => (entry.isDir ? onToggle(entry) : actions.preview(entry.path));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    actions.menu(entry, e.clientX, e.clientY);
  };
  const FolderIcon = expanded ? FolderOpen : Folder;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-level={depth + 1}
      aria-expanded={entry.isDir ? expanded : undefined}
      aria-selected={selected}
      title={entry.path}
      onClick={activate}
      onDoubleClick={entry.isDir ? undefined : () => actions.open(entry.path)}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      data-ignored={entry.ignored || undefined}
      className={`group flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-sm py-px pr-1.5 text-xs hover:bg-maestro-border/60 ${
        selected ? "bg-maestro-accent/10" : ""
      }`}
      style={{ paddingLeft: rowIndent(depth) }}
    >
      <span className="flex w-2.5 shrink-0 justify-center text-maestro-muted">
        {entry.isDir && <Chevron size={10} />}
      </span>
      {entry.isDir ? (
        <FolderIcon size={12} className="shrink-0 text-maestro-muted" />
      ) : (
        <File size={12} className="shrink-0 text-maestro-muted" />
      )}
      <span
        className={`min-w-0 flex-1 truncate ${entry.ignored ? "text-maestro-muted" : "text-maestro-text"}`}
      >
        {entry.name}
      </span>
      {!entry.isDir && (
        <span className="hidden shrink-0 gap-0.5 group-hover:flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.copy(entry.path);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="rounded p-0.5 text-maestro-muted hover:bg-maestro-muted/25 hover:text-maestro-text"
            aria-label={`Copy full path of ${entry.name}`}
            title="Copy full path"
          >
            <Copy size={11} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              actions.open(entry.path);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="rounded p-0.5 text-maestro-muted hover:bg-maestro-muted/25 hover:text-maestro-text"
            aria-label={`Open ${entry.name} in default app`}
            title="Open in default app"
          >
            <ExternalLink size={11} />
          </button>
        </span>
      )}
    </div>
  );
}
