import { openUrl } from "@tauri-apps/plugin-opener";
import type { HealthArea } from "@/lib/healthRules";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { useHealthStore } from "@/stores/useHealthStore";
import { Toast, ToastStack } from "./Toast";

/** Attention tint for health toasts — the same orange the badges use. */
const HEALTH_ACCENT = "rgb(var(--maestro-orange))";

/** Toast title per health area — names the panel whose badge has the detail. */
const HEALTH_AREA_TITLES: Record<HealthArea, string> = {
  memory: "Memory",
  processes: "Processes",
  secondbrain: "Second Brain",
};

/**
 * Hard cap on cards on screen at once, across both queues.
 *
 * The stores each keep up to 6, and a burst on both at the same moment would
 * stack 12 cards ~870px tall — taller than the space above the status bar on
 * a laptop, so the oldest would render off-screen with no way to reach them.
 * Newest win; the rest stay queued and appear as these are dismissed.
 */
const MAX_VISIBLE_TOASTS = 5;

/**
 * Every background notification Maestro raises, in one bottom-right stack:
 *
 * - GitHub watchdog: one card per newly-appeared review request / assigned
 *   issue, tinted with the project's color. Clicking opens it in the browser
 *   (simpler than driving the git panel to the right project + tab).
 * - Health checker: one card per newly-raised memory/process/Second Brain
 *   flag. These have no destination — the badge and the section highlight
 *   carry the detail — so they are dismiss-only.
 *
 * Both queues only ever hold transitions, and only while notifications are
 * enabled; see the stores for the diffing rules.
 */
export function NotificationToasts() {
  const watchdogToasts = useGitHubWatchdogStore((s) => s.toasts);
  const dismissWatchdogToast = useGitHubWatchdogStore((s) => s.dismissToast);
  const healthToasts = useHealthStore((s) => s.toasts);
  const dismissHealthToast = useHealthStore((s) => s.dismissToast);
  const projectColors = useProjectColors();

  if (watchdogToasts.length === 0 && healthToasts.length === 0) return null;

  // Both queues are oldest-first, so trimming from the front keeps the newest.
  // Split proportionally rather than letting one queue crowd the other out.
  const healthShown = healthToasts.slice(-Math.ceil(MAX_VISIBLE_TOASTS / 2));
  const watchdogShown = watchdogToasts.slice(-(MAX_VISIBLE_TOASTS - healthShown.length));

  return (
    <ToastStack>
      {watchdogShown.map((toast) => (
        <Toast
          key={toast.id}
          accentColor={projectColors.get(toast.projectName) ?? projectColorFor(toast.projectName)}
          title={toast.projectName}
          subtitle={`${toast.kind === "pr" ? "Review requested" : "Issue assigned"} — #${toast.number} ${toast.title}`}
          onClick={() => {
            openUrl(toast.url).catch((err) => console.error("Failed to open URL:", err));
            dismissWatchdogToast(toast.id);
          }}
          onDismiss={() => dismissWatchdogToast(toast.id)}
        />
      ))}
      {healthShown.map((toast) => (
        <Toast
          key={toast.id}
          accentColor={HEALTH_ACCENT}
          title={HEALTH_AREA_TITLES[toast.area]}
          subtitle={`${toast.target} — ${toast.reason}`}
          onDismiss={() => dismissHealthToast(toast.id)}
        />
      ))}
    </ToastStack>
  );
}
