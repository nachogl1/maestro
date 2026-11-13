import { Copy, ExternalLink, File, X } from "lucide-react";
import { useEffect, useState } from "react";
import { errorText, readPreview, relativePath } from "./filesApi";

type PreviewState =
  | { state: "loading" }
  | { state: "text"; text: string }
  | { state: "cant"; reason: string };

interface FilePreviewProps {
  root: string;
  path: string;
  onCopy: (path: string) => void;
  onOpen: (path: string) => void;
  onClose: () => void;
}

/** A file's text below the tree, read-only; a file it can't show says why and offers to open it. */
export function FilePreview({ root, path, onCopy, onOpen, onClose }: FilePreviewProps) {
  const [preview, setPreview] = useState<PreviewState>({ state: "loading" });

  useEffect(() => {
    let current = true;
    setPreview({ state: "loading" });
    readPreview(root, path)
      .then((text) => current && setPreview({ state: "text", text }))
      .catch(
        (error: unknown) => current && setPreview({ state: "cant", reason: errorText(error) }),
      );
    return () => {
      current = false;
    };
  }, [root, path]);

  return (
    <section
      aria-label="File preview"
      className="flex h-[230px] shrink-0 flex-col overflow-hidden rounded-lg border border-maestro-border/60 bg-maestro-card"
    >
      <div className="flex items-center gap-1.5 border-b border-maestro-border/60 px-2 py-1 text-[11px]">
        <File size={11} className="shrink-0 text-maestro-muted" />
        <span className="min-w-0 flex-1 truncate font-semibold text-maestro-text" title={path}>
          {relativePath(root, path)}
        </span>
        <span className="shrink-0 rounded-sm border border-maestro-border px-1 text-[9px] font-bold uppercase text-maestro-muted">
          Read-only
        </span>
        <PreviewButton label="Copy full path" onClick={() => onCopy(path)} icon={Copy} />
        <PreviewButton
          label="Open in default app"
          onClick={() => onOpen(path)}
          icon={ExternalLink}
        />
        <PreviewButton label="Close preview" onClick={onClose} icon={X} />
      </div>
      {preview.state === "loading" && (
        <div className="p-2 text-[11px] italic text-maestro-muted">Loading…</div>
      )}
      {preview.state === "text" && (
        <pre className="m-0 flex-1 overflow-auto px-2 py-1.5 font-mono text-[10.5px] leading-[1.45] text-maestro-text/85">
          {preview.text}
        </pre>
      )}
      {preview.state === "cant" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-2.5 text-center text-xs text-maestro-muted">
          <b className="text-maestro-text">Can't preview</b>
          <span>{preview.reason}</span>
          <button
            type="button"
            onClick={() => onOpen(path)}
            className="rounded border border-maestro-accent/60 px-2.5 py-1 text-[11px] font-semibold text-maestro-accent hover:bg-maestro-accent/10"
          >
            Open in default app
          </button>
        </div>
      )}
    </section>
  );
}

function PreviewButton({
  label,
  onClick,
  icon: Icon,
}: {
  label: string;
  onClick: () => void;
  icon: typeof Copy;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded p-0.5 text-maestro-muted hover:bg-maestro-muted/25 hover:text-maestro-text"
      aria-label={label}
      title={label}
    >
      <Icon size={11} />
    </button>
  );
}
