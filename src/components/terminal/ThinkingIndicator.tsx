import { memo } from "react";
import { type BackendSessionStatus, useSessionStore } from "@/stores/useSessionStore";

/**
 * Derived "thinking" state for a session.
 *
 * Reuses the existing backend SessionStatus signal (driven by Claude MCP
 * status hooks + StatusUpdate events) rather than introducing a new
 * subscription. The toast-notifications agent listens to the same field
 * via useSessionStore, so we share the source of truth.
 *
 *  - "thinking"   → backend reports the model is actively processing.
 *  - "needs-input"→ model is waiting on the user.
 *  - "idle"       → everything else (Idle/Done/Starting/Error/Timeout).
 *
 * Note: we treat "Starting" as idle (not thinking) — the dots would be
 * misleading before the CLI is even ready.
 */
function deriveActivity(status: BackendSessionStatus | undefined): "thinking" | "needs-input" | "idle" {
  if (status === "Working") return "thinking";
  if (status === "NeedsInput") return "needs-input";
  return "idle";
}

interface ThinkingIndicatorProps {
  sessionId: number;
  /** Approximate dot diameter in px. Defaults to 3.5px. */
  size?: number;
  /** Optional extra wrapper classes (e.g. spacing tweaks for headers vs tabs). */
  className?: string;
}

/**
 * Tiny three-dot CSS-only "is the model thinking?" pulse.
 *
 * Animation: dots fade in/out with a staggered delay while `Working`.
 * Idle:      dots stay subtle and static (no animation cost).
 * NeedsInput: dots tint yellow to flag user action required.
 *
 * Performance: pure CSS keyframes — no React render loop. Respects
 * `prefers-reduced-motion` via the global rule in globals.css.
 */
export const ThinkingIndicator = memo(function ThinkingIndicator({
  sessionId,
  size = 3.5,
  className = "",
}: ThinkingIndicatorProps) {
  // Subscribe to the minimum scalar needed so unrelated session updates
  // don't re-render this component.
  const status = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.status);
  const activity = deriveActivity(status);

  const label =
    activity === "thinking"
      ? "Model is thinking"
      : activity === "needs-input"
        ? "Awaiting user input"
        : "Idle";

  const dotColor =
    activity === "thinking"
      ? "bg-maestro-accent"
      : activity === "needs-input"
        ? "bg-maestro-yellow"
        : "bg-maestro-muted/40";

  const animate = activity === "thinking";

  const dotStyle = {
    width: `${size}px`,
    height: `${size}px`,
  } as const;

  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center gap-0.5 ${className}`}
    >
      <span
        style={{ ...dotStyle, animationDelay: "0ms" }}
        className={`rounded-full ${dotColor} ${animate ? "motion-safe:animate-thinking-dot motion-reduce:opacity-70" : "opacity-60"}`}
      />
      <span
        style={{ ...dotStyle, animationDelay: "180ms" }}
        className={`rounded-full ${dotColor} ${animate ? "motion-safe:animate-thinking-dot motion-reduce:opacity-70" : "opacity-60"}`}
      />
      <span
        style={{ ...dotStyle, animationDelay: "360ms" }}
        className={`rounded-full ${dotColor} ${animate ? "motion-safe:animate-thinking-dot motion-reduce:opacity-70" : "opacity-60"}`}
      />
    </span>
  );
});
