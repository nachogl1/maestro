import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  DialogRow,
  DialogSection,
  DialogToggle,
  dialogButtonClass,
  dialogCardClass,
  dialogInputClass,
  dialogSectionHeadingClass,
} from "@/components/shared/DialogShell";
import { formatTimeAgo } from "@/lib/format";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { LicenceNoticesRow } from "./LicenceNoticesRow";

/** Hover help for the settings, in plain language. */
const HINTS = {
  version: "The version of Maestro you are running.",
  checkNow: "Look for a newer version of Maestro right now.",
  autoCheck:
    "When on, Maestro looks for newer versions by itself in the background and tells you " +
    "when one is ready to install.",
  interval: "How often Maestro looks for a newer version while Auto-check is on.",
  installOnLaunch:
    "When on, an update found when you open Maestro downloads and installs by itself, then " +
    "Maestro restarts. Updates found later still ask first.",
  advanced: "Settings most people never need to change.",
  endpoint:
    "The web address where Maestro looks for updates. Leave it empty to use the normal " +
    "location. Only fill it in if someone gave you a specific address for a different " +
    "update source.",
  resetEndpoint: "Go back to the normal update location.",
};

const INTERVAL_OPTIONS = [
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 120 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
];

/** Settings section for Maestro updates and the update source. */
export function UpdatesSettingsPanel() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [endpointInput, setEndpointInput] = useState("");

  const status = useUpdateStore((s) => s.status);
  const lastCheckedAt = useUpdateStore((s) => s.lastCheckedAt);
  const autoCheckEnabled = useUpdateStore((s) => s.autoCheckEnabled);
  const checkIntervalMinutes = useUpdateStore((s) => s.checkIntervalMinutes);
  const customEndpoint = useUpdateStore((s) => s.customEndpoint);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const setAutoCheckEnabled = useUpdateStore((s) => s.setAutoCheckEnabled);
  const setCheckInterval = useUpdateStore((s) => s.setCheckInterval);
  const setCustomEndpoint = useUpdateStore((s) => s.setCustomEndpoint);
  const autoInstallOnLaunch = useUpdateStore((s) => s.autoInstallOnLaunch);
  const setAutoInstallOnLaunch = useUpdateStore((s) => s.setAutoInstallOnLaunch);

  useEffect(() => {
    invoke<string>("get_app_version")
      .then(setAppVersion)
      .catch((err) => console.error("Failed to get app version:", err));
  }, []);

  useEffect(() => {
    setEndpointInput(customEndpoint ?? "");
  }, [customEndpoint]);

  const handleCheckNow = useCallback(() => {
    checkForUpdates({ manual: true });
  }, [checkForUpdates]);

  const handleEndpointBlur = () => {
    const trimmed = endpointInput.trim();
    setCustomEndpoint(trimmed || null);
  };

  const isChecking = status === "checking";

  return (
    <>
      <DialogSection title="Updates" icon={<ArrowDownCircle size={13} />}>
        <DialogRow label="Version" hint={HINTS.version}>
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-maestro-text">
            <Check size={12} className="shrink-0 text-maestro-green" />v{appVersion ?? "..."}
          </span>
        </DialogRow>
        <LicenceNoticesRow />
        <DialogRow label="Last checked">
          {status === "checking" && (
            <span className="flex items-center gap-1.5 text-[11px] text-maestro-muted">
              <Loader2 size={11} className="animate-spin" />
              Checking...
            </span>
          )}
          <span className="text-[11px] text-maestro-muted">
            {formatTimeAgo(lastCheckedAt, { capitalize: true })}
          </span>
          <button
            type="button"
            onClick={handleCheckNow}
            disabled={isChecking}
            className={dialogButtonClass("ghost")}
            title={HINTS.checkNow}
          >
            <RefreshCw size={12} className={isChecking ? "animate-spin" : ""} />
            Check now
          </button>
        </DialogRow>
        <DialogRow label="Auto-check" hint={HINTS.autoCheck}>
          <DialogToggle
            checked={autoCheckEnabled}
            onChange={setAutoCheckEnabled}
            aria-label="Toggle auto-check"
          />
        </DialogRow>
        {autoCheckEnabled && (
          <DialogRow label="Interval" hint={HINTS.interval}>
            <select
              value={checkIntervalMinutes}
              onChange={(e) => setCheckInterval(Number(e.target.value))}
              className={dialogInputClass}
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </DialogRow>
        )}
        <DialogRow label="Install on launch" hint={HINTS.installOnLaunch}>
          <DialogToggle
            checked={autoInstallOnLaunch === true}
            onChange={setAutoInstallOnLaunch}
            aria-label="Toggle install on launch"
          />
        </DialogRow>
      </DialogSection>

      {/* Advanced */}
      <section className={dialogCardClass}>
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          aria-expanded={advancedOpen}
          className={`${dialogSectionHeadingClass} w-full rounded hover:text-maestro-text`}
          title={HINTS.advanced}
        >
          {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Advanced
        </button>

        {advancedOpen && (
          <div className="mt-2 space-y-1.5">
            <DialogRow
              label="Custom endpoint"
              hint={HINTS.endpoint}
              htmlFor="maestro-custom-endpoint"
            >
              <input
                id="maestro-custom-endpoint"
                type="text"
                value={endpointInput}
                onChange={(e) => setEndpointInput(e.target.value)}
                onBlur={handleEndpointBlur}
                placeholder="https://..."
                className={`w-56 ${dialogInputClass}`}
              />
            </DialogRow>
            {customEndpoint && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setCustomEndpoint(null);
                    setEndpointInput("");
                  }}
                  className={dialogButtonClass("danger")}
                  title={HINTS.resetEndpoint}
                >
                  Reset to default
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}
