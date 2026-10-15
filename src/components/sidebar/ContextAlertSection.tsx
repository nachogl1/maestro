import { Gauge } from "lucide-react";
import { CONTEXT_ALERT_THRESHOLDS, useContextAlertStore } from "@/stores/useContextAlertStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/** Option value for "alert off" — a native select cannot hold null. */
const OFF = "off";

/**
 * Sidebar settings card for the context-usage alert: pick the context-window
 * percentage at which a Claude terminal's frame starts blinking red, or turn
 * the alert off. Follows the NotificationsSettingsSection pattern.
 */
export function ContextAlertSection() {
  const threshold = useContextAlertStore((s) => s.threshold);
  const setThreshold = useContextAlertStore((s) => s.setThreshold);

  return (
    <div className={cardClass}>
      <SectionHeader icon={Gauge} label="Context alert" iconColor="text-maestro-accent" />

      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-maestro-text hover:bg-maestro-border/40">
        <span className="flex-1">Blink red frame at</span>
        <select
          value={threshold === null ? OFF : String(threshold)}
          onChange={(e) => setThreshold(e.target.value === OFF ? null : Number(e.target.value))}
          aria-label="Context alert threshold"
          className="shrink-0 rounded border border-maestro-border/60 bg-maestro-surface px-1 py-1 text-[11px] text-maestro-text focus:border-maestro-accent focus:outline-none"
        >
          <option value={OFF}>Off</option>
          {CONTEXT_ALERT_THRESHOLDS.map((pct) => (
            <option key={pct} value={String(pct)}>
              {pct}% context
            </option>
          ))}
        </select>
      </div>

      <p className="px-2 pt-1 text-[10px] text-maestro-muted">
        A terminal whose Claude conversation fills its context window past this level gets a
        blinking red frame, so you can hand off or compact before it runs out.
      </p>
    </div>
  );
}
