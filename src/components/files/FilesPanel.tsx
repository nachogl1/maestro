import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileContextMenu, type FileMenuItem } from "./FileContextMenu";
import { FilePreview } from "./FilePreview";
import { FilesWhereBox } from "./FilesWhereBox";
import { FileTree } from "./FileTree";
import type { FileActions } from "./FileTreeRow";
import { baseName, copyPath, errorText, type FileEntry, openInDefaultApp } from "./filesApi";
import { useFilesTarget } from "./useFilesTarget";

/** How long the "Copied …" line stays under the tree. */
const STATUS_DURATION_MS = 1400;

/**
 * The Files panel (PRD §4.5, prototype `docs/ux/prototypes/files-tab/`): the
 * focused terminal's folder as a tree, a read-only preview and open / copy.
 */
export function FilesPanel() {
  const target = useFilesTarget();
  const [status, setStatus] = useState<string | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout>>();

  const showStatus = useCallback((text: string) => {
    setStatus(text);
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(null), STATUS_DURATION_MS);
  }, []);
  useEffect(() => () => clearTimeout(statusTimer.current), []);

  const copy = useCallback(
    (path: string) => {
      copyPath(path)
        .then(() => showStatus(`Copied ${path}`))
        .catch((error: unknown) => showStatus(`Couldn't copy the path. ${errorText(error)}`));
    },
    [showStatus],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
      <FilesWhereBox target={target} onCopyFolder={() => target && copy(target.folder)} />
      {/* A new folder starts fresh: nothing open, nothing previewed. */}
      {target && (
        <FilesBrowser
          key={target.folder}
          root={target.folder}
          copy={copy}
          showStatus={showStatus}
        />
      )}
      {status && (
        <output className="block shrink-0 truncate text-[11px] text-maestro-muted" title={status}>
          {status}
        </output>
      )}
    </div>
  );
}

interface OpenMenu {
  entry: FileEntry;
  x: number;
  y: number;
}

interface FilesBrowserProps {
  root: string;
  copy: (path: string) => void;
  showStatus: (text: string) => void;
}

function FilesBrowser({ root, copy, showStatus }: FilesBrowserProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  const actions = useMemo<FileActions>(
    () => ({
      preview: setSelectedPath,
      open: (path) => {
        openInDefaultApp(root, path).catch((error: unknown) => {
          console.error("Failed to open file:", error);
          showStatus(`Couldn't open ${baseName(path)}. ${errorText(error)}`);
        });
      },
      copy,
      menu: (entry, x, y) => setMenu({ entry, x, y }),
    }),
    [root, copy, showStatus],
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  const menuItems = (entry: FileEntry): FileMenuItem[] => {
    const copyItem = { label: "Copy full path", run: () => actions.copy(entry.path) };
    const openItem = { label: "Open in default app", run: () => actions.open(entry.path) };
    if (entry.isDir) return [copyItem, openItem];
    return [
      { label: "Preview", hint: "click", run: () => actions.preview(entry.path) },
      { ...openItem, hint: "double-click" },
      copyItem,
    ];
  };

  return (
    <>
      <FileTree root={root} selectedPath={selectedPath} actions={actions} />
      {selectedPath && (
        <FilePreview
          root={root}
          path={selectedPath}
          onCopy={actions.copy}
          onOpen={actions.open}
          onClose={() => setSelectedPath(null)}
        />
      )}
      {menu && (
        <FileContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={closeMenu} />
      )}
    </>
  );
}
