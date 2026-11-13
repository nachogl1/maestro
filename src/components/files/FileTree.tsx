import { Fragment, useCallback, useEffect, useState } from "react";
import { type FileActions, FileTreeRow, rowIndent } from "./FileTreeRow";
import { errorText, type FileEntry, listDir } from "./filesApi";

/** A note under a folder lines up with its entries' names, past the chevron and icon. */
const NOTE_OFFSET_PX = 14;

/** A folder's children: still loading, loaded, or the reason they could not be listed. */
type FolderListing =
  | { state: "loading" }
  | { state: "loaded"; entries: FileEntry[] }
  | { state: "error"; message: string };

interface FileTreeProps {
  root: string;
  selectedPath: string | null;
  actions: FileActions;
}

/** The folder tree: each folder lists its entries only when, and each time, it is opened. */
export function FileTree({ root, selectedPath, actions }: FileTreeProps) {
  const [listings, setListings] = useState<Record<string, FolderListing>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(
    (dir: string) => {
      // A folder read before keeps its entries on screen while it is read again.
      setListings((prev) =>
        prev[dir]?.state === "loaded" ? prev : { ...prev, [dir]: { state: "loading" } },
      );
      listDir(root, dir)
        .then((entries) =>
          setListings((prev) => ({ ...prev, [dir]: { state: "loaded", entries } })),
        )
        .catch((error: unknown) =>
          setListings((prev) => ({
            ...prev,
            [dir]: { state: "error", message: errorText(error) },
          })),
        );
    },
    [root],
  );

  useEffect(() => load(root), [load, root]);

  const toggle = useCallback(
    (entry: FileEntry) => {
      const opening = !expanded.has(entry.path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (opening) next.add(entry.path);
        else next.delete(entry.path);
        return next;
      });
      // Read on every opening: an agent may have changed the folder since.
      if (opening) load(entry.path);
    },
    [expanded, load],
  );

  const renderLevel = (dir: string, depth: number) => {
    const listing = listings[dir];
    if (!listing || listing.state === "loading") {
      return <TreeNote depth={depth} text="Loading…" />;
    }
    if (listing.state === "error") {
      return <TreeNote depth={depth} text={`Can't open this folder. ${listing.message}`} />;
    }
    if (listing.entries.length === 0) return <TreeNote depth={depth} text="Empty folder" />;
    return listing.entries.map((entry) => {
      const isOpen = entry.isDir && expanded.has(entry.path);
      return (
        <Fragment key={entry.path}>
          <FileTreeRow
            entry={entry}
            depth={depth}
            expanded={isOpen}
            selected={selectedPath === entry.path}
            onToggle={toggle}
            actions={actions}
          />
          {isOpen && (
            // biome-ignore lint/a11y/useSemanticElements: a nested tree level has no native element.
            <div role="group">{renderLevel(entry.path, depth + 1)}</div>
          )}
        </Fragment>
      );
    });
  };

  return (
    <div
      role="tree"
      aria-label="Files"
      className="min-h-[120px] flex-1 overflow-auto rounded-lg border border-maestro-border/60 bg-maestro-card px-0.5 py-1"
    >
      {renderLevel(root, 0)}
    </div>
  );
}

function TreeNote({ depth, text }: { depth: number; text: string }) {
  return (
    <div
      className="py-px text-[11px] italic text-maestro-muted"
      style={{ paddingLeft: rowIndent(depth) + NOTE_OFFSET_PX }}
    >
      {text}
    </div>
  );
}
