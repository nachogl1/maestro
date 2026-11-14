import { openUrl } from "@tauri-apps/plugin-opener";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { Toast, ToastStack } from "./Toast";

/**
 * Hard cap on cards on screen at once.
 *
 * The store keeps up to 6; stacked, they would be taller than the space above
 * the status bar on a small laptop, so the oldest would render off-screen with
 * no way to reach them. Newest win; the rest stay queued and appear as these
 * are dismissed.
 */
const MAX_VISIBLE_TOASTS = 5;

/**
 * Every background notification Maestro raises, in one bottom-right stack:
 * the GitHub watchdog's cards, one per newly-appeared review request /
 * assigned issue, tinted with the project's color, kicker "<Project> — <Type>".
 * Clicking opens it in the browser (simpler than driving the git panel to the
 * right project + tab).
 *
 * The queue only ever holds transitions, and only while notifications are
 * enabled; see the store for the diffing rules.
 */
export function NotificationToasts() {
  const watchdogToasts = useGitHubWatchdogStore((s) => s.toasts);
  const dismissWatchdogToast = useGitHubWatchdogStore((s) => s.dismissToast);
  const projectColors = useProjectColors();

  if (watchdogToasts.length === 0) {
    return null;
  }

  // The queue is oldest-first, so trimming from the front keeps the newest.
  const watchdogShown = watchdogToasts.slice(-MAX_VISIBLE_TOASTS);

  return (
    <ToastStack>
      {/*
       * Every kicker reads "<what raised it> — <what happened>" so a glance
       * answers "which project, what kind of event" before the title (the
       * subject) is even read.
       */}
      {watchdogShown.map((toast) => (
        <Toast
          key={toast.id}
          accentColor={projectColors.get(toast.projectName) ?? projectColorFor(toast.projectName)}
          kicker={`${toast.projectName} — ${toast.kind === "pr" ? "Review requested" : "Issue assigned"}`}
          title={`#${toast.number} ${toast.title}`}
          onClick={() => {
            openUrl(toast.url).catch((err) => console.error("Failed to open URL:", err));
            dismissWatchdogToast(toast.id);
          }}
          onDismiss={() => dismissWatchdogToast(toast.id)}
        />
      ))}
    </ToastStack>
  );
}
