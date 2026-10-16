import { X } from "lucide-react";

interface DetailLoadErrorProps {
  /** What failed to load, e.g. "pull request". */
  itemLabel: string;
  /** The fetch error, when one was recorded. */
  error: string | null;
  onClose: () => void;
}

/**
 * Shown by a PR/issue/discussion detail panel when its item failed to load,
 * so the user still sees why and has a Back button to the list.
 */
export function DetailLoadError({ itemLabel, error, onClose }: DetailLoadErrorProps) {
  return (
    <div className="flex h-full flex-col bg-maestro-card">
      <div className="flex shrink-0 items-center border-b border-maestro-border p-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1.5 text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
          title="Back to list"
        >
          <X size={16} />
        </button>
      </div>
      <div className="break-words p-3 text-xs">
        <p className="text-maestro-red">Could not load this {itemLabel}.</p>
        {error && <p className="mt-1 text-maestro-muted">{error}</p>}
      </div>
    </div>
  );
}
