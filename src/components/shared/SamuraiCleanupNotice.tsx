import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

/** A Samurai run worktree the one-time cleanup kept, and why. */
interface SamuraiCleanupNoticeWorktree {
  path: string;
  reasons: string[];
}

/**
 * One closeable notice, shown once after the first start without Samurai, that
 * lists the run worktrees the cleanup kept because they still hold work (issue
 * #615). Nothing kept, no notice. It never closes on its own: the paths are
 * the only place the person learns where that work is.
 */
export function SamuraiCleanupNotice() {
  const [kept, setKept] = useState<SamuraiCleanupNoticeWorktree[]>([]);

  useEffect(() => {
    let mounted = true;
    invoke<SamuraiCleanupNoticeWorktree[]>("samurai_cleanup_kept_worktrees")
      .then((list) => {
        if (mounted && Array.isArray(list)) setKept(list);
      })
      .catch((error) => console.error("Could not read the Samurai cleanup result:", error));
    return () => {
      mounted = false;
    };
  }, []);

  if (kept.length === 0) {
    return null;
  }

  return (
    <output className="fixed bottom-10 left-3 z-50 flex w-96 max-w-[calc(100vw-1.5rem)] items-start gap-2 rounded-lg border border-maestro-border bg-maestro-surface p-3 shadow-lg">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
          Samurai cleanup
        </span>
        <span className="text-xs font-medium leading-snug text-maestro-text">
          Samurai's old files were removed. These run worktrees still hold work, so they were kept:
        </span>
        <ul className="mt-1 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
          {kept.map((worktree) => (
            <li key={worktree.path} className="flex min-w-0 flex-col">
              <span className="break-all font-mono text-[11px] text-maestro-text">
                {worktree.path}
              </span>
              <span className="text-[11px] text-maestro-muted">{worktree.reasons.join(", ")}</span>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => setKept([])}
        className="shrink-0 rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-border/40 hover:text-maestro-text"
        aria-label="Close notice"
      >
        <X size={12} />
      </button>
    </output>
  );
}
