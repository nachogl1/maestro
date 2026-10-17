import { Gauge } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_CONTEXT_ALERT_THRESHOLD,
  MAX_CONTEXT_ALERT_THRESHOLD,
  MIN_CONTEXT_ALERT_THRESHOLD,
  parseContextAlertThreshold,
  useContextAlertStore,
} from "@/stores/useContextAlertStore";
import { cardClass, SectionHeader } from "./sectionChrome";

/**
 * How long the user has to stop typing before the number in the field is
 * applied on its own. Long enough that "9" on the way to "95" never makes
 * every terminal blink, short enough to feel immediate.
 */
export const CONTEXT_ALERT_APPLY_DELAY_MS = 500;

/**
 * Sidebar settings card for the context-usage alert: type the context-window
 * percentage at which a Claude terminal's frame starts blinking red, or switch
 * the alert off. A valid number is applied once the user pauses typing (see
 * {@link CONTEXT_ALERT_APPLY_DELAY_MS}), and at once on blur or Enter — never
 * per keystroke. It is clamped to the allowed range; on blur, text that is not
 * a number is dropped.
 */
export function ContextAlertSection() {
  const threshold = useContextAlertStore((s) => s.threshold);
  const setThreshold = useContextAlertStore((s) => s.setThreshold);
  const enabled = threshold !== null;

  // The percent kept while the alert is off, so switching it back on restores it.
  const [lastPercent, setLastPercent] = useState(threshold ?? DEFAULT_CONTEXT_ALERT_THRESHOLD);
  const [draft, setDraft] = useState(String(threshold ?? DEFAULT_CONTEXT_ALERT_THRESHOLD));
  const pendingApply = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cancelPendingApply = useCallback(() => {
    if (pendingApply.current === null) return;
    clearTimeout(pendingApply.current);
    pendingApply.current = null;
  }, []);

  useEffect(() => cancelPendingApply, [cancelPendingApply]);

  // Mirror the stored percent into the field, except while the user is typing
  // in it, so a pause-apply never rewrites the text under their cursor (blur
  // or Enter normalises it).
  useEffect(() => {
    if (threshold === null) return;
    setLastPercent(threshold);
    if (document.activeElement !== inputRef.current) setDraft(String(threshold));
  }, [threshold]);

  const applyPercent = (parsed: number) => {
    setLastPercent(parsed);
    setThreshold(parsed);
  };

  // Blur / Enter: apply now, dropping unusable text.
  const commit = () => {
    cancelPendingApply();
    const parsed = parseContextAlertThreshold(draft);
    if (parsed === null) {
      setDraft(String(lastPercent));
      return;
    }
    setDraft(String(parsed));
    applyPercent(parsed);
  };

  // Typing: apply the number once the user pauses. Unusable text (an emptied
  // field mid-edit) is left alone so they can finish the number.
  const handleDraftChange = (value: string) => {
    setDraft(value);
    cancelPendingApply();
    pendingApply.current = setTimeout(() => {
      pendingApply.current = null;
      const parsed = parseContextAlertThreshold(value);
      if (parsed !== null) applyPercent(parsed);
    }, CONTEXT_ALERT_APPLY_DELAY_MS);
  };

  return (
    <div className={cardClass}>
      <SectionHeader icon={Gauge} label="Context alert" iconColor="text-maestro-accent" />

      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-maestro-text hover:bg-maestro-border/40">
        <span className="flex-1">Blink red frame at</span>
        <input
          ref={inputRef}
          type="number"
          inputMode="numeric"
          min={MIN_CONTEXT_ALERT_THRESHOLD}
          max={MAX_CONTEXT_ALERT_THRESHOLD}
          step={1}
          value={draft}
          disabled={!enabled}
          onChange={(e) => handleDraftChange(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          aria-label="Context alert threshold"
          title={`Context window percentage (${MIN_CONTEXT_ALERT_THRESHOLD}-${MAX_CONTEXT_ALERT_THRESHOLD}) at which a Claude terminal's frame blinks red.`}
          className="w-16 shrink-0 rounded border border-maestro-border/60 bg-maestro-surface px-1.5 py-1 text-right text-[11px] text-maestro-text focus:border-maestro-accent focus:outline-none disabled:opacity-50"
        />
        <span className="text-maestro-muted">%</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle context alert"
          onClick={() => {
            // Switching off must win over a number still waiting to apply.
            cancelPendingApply();
            setThreshold(enabled ? null : lastPercent);
          }}
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
            enabled ? "bg-maestro-accent" : "bg-maestro-border"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
              enabled ? "left-3.5" : "left-0.5"
            }`}
          />
        </button>
      </div>
    </div>
  );
}
