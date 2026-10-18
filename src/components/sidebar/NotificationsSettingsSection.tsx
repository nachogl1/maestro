import { Bell } from "lucide-react";
import { DialogToggle } from "@/components/shared/DialogShell";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { useHealthStore } from "@/stores/useHealthStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/**
 * Settings card (Settings → Notifications) for every background notification Maestro raises
 * (follows the UpdateSettingsSection pattern).
 *
 * One toggle covers every notifying watcher — the GitHub watchdog, the
 * Samurai-file health checker, and the run-fatal Samurai alerts
 * (issue #174). It mutes toasts only: all keep watching, and their
 * badges (top-bar totals, panel attention counts, session attention
 * highlights) stay on either way, so nothing is ever silently missed.
 */
export function NotificationsSettingsSection() {
  const notificationsEnabled = useGitHubWatchdogStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useGitHubWatchdogStore((s) => s.setNotificationsEnabled);
  const status = useGitHubWatchdogStore((s) => s.status);
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
        <DialogToggle
          checked={notificationsEnabled}
          onChange={handleToggle}
          aria-label="Toggle notifications"
        />
      </div>

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
