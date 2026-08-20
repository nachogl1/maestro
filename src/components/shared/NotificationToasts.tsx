import { openUrl } from "@tauri-apps/plugin-opener";
import type { HealthArea } from "@/lib/healthRules";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import { useHealthStore } from "@/stores/useHealthStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { Toast, ToastStack } from "./Toast";

/** Attention tint for health toasts — the same orange the badges use. */
const HEALTH_ACCENT = "rgb(var(--maestro-orange))";

/** Tint for run-fatal samurai toasts (issue #174) — the error red. */
const SAMURAI_FATAL_ACCENT = "rgb(var(--maestro-red))";

/** Last path segment — the toast names the project like the tab strip does. */
function projectName(projectPath: string): string {
  const segments = projectPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? projectPath;
}

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
 *   issue, tinted with the project's color, kicker "<Project> — <Type>".
 *   Clicking opens it in the browser (simpler than driving the git panel to
 *   the right project + tab).
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
  const samuraiToasts = useSessionStore((s) => s.samuraiToasts);
  const dismissSamuraiToast = useSessionStore((s) => s.dismissSamuraiToast);
  const projectColors = useProjectColors();

  if (watchdogToasts.length === 0 && healthToasts.length === 0 && samuraiToasts.length === 0) {
    return null;
  }

  // All queues are oldest-first, so trimming from the front keeps the newest.
  // Run-fatal samurai toasts (issue #174) take priority — a dead run beats a
  // review request — then the remainder splits between the other two queues.
  const samuraiShown = samuraiToasts.slice(-MAX_VISIBLE_TOASTS);
  const remaining = MAX_VISIBLE_TOASTS - samuraiShown.length;
  const healthShown = remaining > 0 ? healthToasts.slice(-Math.ceil(remaining / 2)) : [];
  const watchdogBudget = remaining - healthShown.length;
  const watchdogShown = watchdogBudget > 0 ? watchdogToasts.slice(-watchdogBudget) : [];

  return (
    <ToastStack>
      {/*
       * Every kicker reads "<what raised it> — <what happened>" so a glance
       * answers "which project, what kind of event" before the title (the
       * subject) is even read. Health toasts have no project, so "Health"
       * stands in for it.
       */}
      {samuraiShown.map((toast) => (
        <Toast
          key={toast.id}
          accentColor={SAMURAI_FATAL_ACCENT}
          kicker={`${projectName(toast.project)} — Samurai run needs you`}
          title={toast.label}
          detail={`${toast.epic} · gen-${toast.generation}`}
          onDismiss={() => dismissSamuraiToast(toast.id)}
        />
      ))}
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
      {healthShown.map((toast) => (
        <Toast
          key={toast.id}
          accentColor={HEALTH_ACCENT}
          kicker={`Health — ${HEALTH_AREA_TITLES[toast.area]}`}
          title={toast.target}
          detail={toast.reason}
          onDismiss={() => dismissHealthToast(toast.id)}
        />
      ))}
    </ToastStack>
  );
}
