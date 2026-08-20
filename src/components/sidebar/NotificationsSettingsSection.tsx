import { Bell } from "lucide-react";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { useHealthStore } from "@/stores/useHealthStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { cardClass, SectionHeader } from "./sectionChrome";

function formatTimeAgo(timestamp: number | null): string {
  if (!timestamp) return "never";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Sidebar settings card for every background notification Maestro raises
 * (follows the UpdateSettingsSection pattern).
 *
 * One toggle covers every notifying watcher — the GitHub watchdog, the
 * memory/process/Samurai-file health checker, and the run-fatal Samurai
 * alerts (issue #174). It mutes toasts only: all keep watching, and their
 * badges (top-bar totals, panel attention counts, session attention
 * highlights) stay on either way, so nothing is ever silently missed.
 */
export function NotificationsSettingsSection() {
  const notificationsEnabled = useGitHubWatchdogStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useGitHubWatchdogStore((s) => s.setNotificationsEnabled);
  const status = useGitHubWatchdogStore((s) => s.status);
  const lastPolledAt = useGitHubWatchdogStore((s) => s.lastPolledAt);
  const lastCheckedAt = useHealthStore((s) => s.lastCheckedAt);
  const dismissHealthToasts = useHealthStore((s) => s.dismissAllToasts);
  const dismissSamuraiToasts = useSessionStore((s) => s.dismissAllSamuraiToasts);

  const handleToggle = () => {
    const next = !notificationsEnabled;
    setNotificationsEnabled(next);
    // Muting clears what is already on screen, for every queue.
    if (!next) {
      dismissHealthToasts();
      dismissSamuraiToasts();
    }
  };

  return (
    <div className={cardClass}>
      <SectionHeader icon={Bell} label="Notifications" iconColor="text-maestro-accent" />

      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-maestro-text hover:bg-maestro-border/40">
        <span className="flex-1">Show notifications</span>
        <button
          type="button"
          onClick={handleToggle}
          className={`relative h-4 w-7 rounded-full transition-colors ${
            notificationsEnabled ? "bg-maestro-accent" : "bg-maestro-border"
          }`}
          aria-label="Toggle notifications"
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
              notificationsEnabled ? "left-3.5" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <p className="px-2 pt-0.5 text-[10px] text-maestro-muted/70">
        Toasts for new review requests, assigned issues, health flags (memory, processes, Samurai
        files), and run-fatal Samurai alerts. Badges stay on either way.
      </p>

      <p className="px-2 pt-1 text-[10px] text-maestro-muted">
        GitHub checked {formatTimeAgo(lastPolledAt)} · health checked {formatTimeAgo(lastCheckedAt)}
      </p>

      {status === "gh-missing" && (
        <p className="px-2 pt-1 text-[10px] text-maestro-muted">
          GitHub CLI (gh) not found — watchdog is paused.
        </p>
      )}
      {status === "not-authenticated" && (
        <p className="px-2 pt-1 text-[10px] text-maestro-muted">
          Not authenticated — run{" "}
          <code className="rounded bg-maestro-border/40 px-1">gh auth login</code>.
        </p>
      )}
    </div>
  );
}
