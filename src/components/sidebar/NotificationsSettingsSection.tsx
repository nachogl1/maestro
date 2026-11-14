import { Bell } from "lucide-react";
import { DialogToggle } from "@/components/shared/DialogShell";
import { useAttentionSoundStore } from "@/stores/useAttentionSoundStore";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/**
 * Settings card (Settings → Notifications) for every background notification Maestro raises
 * (follows the UpdateSettingsSection pattern).
 *
 * One toggle covers the GitHub watchdog. It mutes toasts only: the watchdog
 * keeps watching, and its badges stay on either way, so nothing is ever
 * silently missed.
 *
 * A second switch, off by default, plays a short tone when a terminal needs
 * the user: a parked one comes back by itself, or one starts waiting for
 * input (issue #496).
 */
export function NotificationsSettingsSection() {
  const notificationsEnabled = useGitHubWatchdogStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useGitHubWatchdogStore((s) => s.setNotificationsEnabled);
  const status = useGitHubWatchdogStore((s) => s.status);
  const soundEnabled = useAttentionSoundStore((s) => s.enabled);
  const setSoundEnabled = useAttentionSoundStore((s) => s.setEnabled);

  // Muting also clears the toasts already on screen (the store does that).
  const handleToggle = () => {
    setNotificationsEnabled(!notificationsEnabled);
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

      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-maestro-text hover:bg-maestro-border/40">
        <span className="flex-1">Play a sound when a terminal needs you</span>
        <DialogToggle
          checked={soundEnabled}
          onChange={setSoundEnabled}
          aria-label="Toggle attention sound"
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
