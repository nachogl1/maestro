import { Play, UserRound } from "lucide-react";
import { useEffect } from "react";
import { useClaudeAccountStore } from "@/stores/useClaudeAccountStore";
import { SystemMetrics } from "./SystemMetrics";
import { TerminalNavigator } from "./TerminalNavigator";
import { UsageBar } from "./UsageBar";

interface BottomBarProps {
  /** Number of total slots (pre-launch + launched) */
  slotCount: number;
  /** Number of actually running sessions */
  launchedCount: number;
  onLaunchAll: () => void;
  /** Footer navigator: bring the given session in front of the user. */
  onNavigateToSession: (tabId: string, sessionId: number) => void;
}

export function BottomBar({
  slotCount,
  launchedCount,
  onLaunchAll,
  onNavigateToSession,
}: BottomBarProps) {
  // The Launch button only exists while there is something to launch. With
  // no terminals at all it used to render disabled, sitting on top of the
  // usage bars on the right.
  const unlaunchedCount = Math.max(0, slotCount - launchedCount);
  const account = useClaudeAccountStore((s) => s.account);
  const fetchAccount = useClaudeAccountStore((s) => s.fetch);

  useEffect(() => {
    fetchAccount();
  }, [fetchAccount]);

  return (
    <div className="no-select relative flex h-11 items-center justify-center gap-3 px-4">
      {/* Centered with inset-y-0 + items-center rather than
          top-1/2/-translate-y-1/2: a transform creates a stacking context, and
          that would trap TerminalNavigator's drop-up below the terminal layers
          (project wrapper z-10, zoomed pane z-40) no matter its own z-index. */}
      <div className="absolute inset-y-0 left-4 flex max-w-[40%] items-center gap-2">
        <TerminalNavigator onNavigate={onNavigateToSession} />
        {account?.email && (
          <div
            className="flex min-w-0 items-center gap-1.5 text-[11px] text-maestro-muted/70"
            title={`Claude Code account: ${account.email}`}
          >
            <UserRound size={12} className="shrink-0" />
            <span className="truncate">{account.email}</span>
          </div>
        )}
      </div>
      {unlaunchedCount > 0 && (
        <button
          type="button"
          onClick={onLaunchAll}
          className="relative z-10 flex items-center gap-2 rounded-lg bg-maestro-accent px-4 py-1.5 text-xs font-medium text-white shadow-md shadow-black/20 transition-colors hover:bg-maestro-accent/80"
        >
          <Play size={11} fill="currentColor" />
          {unlaunchedCount === 1 ? "Launch Session" : `Launch All (${unlaunchedCount})`}
        </button>
      )}

      {/* inset-y-0 + items-center for the same stacking-context reason as the
          left cluster. Bounded like the left one: the inline usage bars grow
          with however many windows the API reports, and an unbounded absolute
          cluster would reach past the centre and cover the Launch button. */}
      <div className="absolute inset-y-0 right-4 flex max-w-[55%] items-center justify-end gap-4 overflow-hidden">
        <SystemMetrics />
        <UsageBar />
      </div>
    </div>
  );
}
