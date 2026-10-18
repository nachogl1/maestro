import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Terminal,
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
import { isWindows } from "@/lib/platform";
import { useUpdateStore } from "@/stores/useUpdateStore";

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
  cli:
    "The maestro command lets you type 'maestro' in any terminal window to open that folder " +
    "as a project in Maestro.",
  installCli:
    "Adds the maestro command to your computer so you can open projects from a terminal " +
    "window.",
  uninstallCli: "Removes the maestro command from your computer. Maestro itself keeps working.",
  advanced: "Settings most people never need to change.",
  endpoint:
    "The web address where Maestro looks for updates. Leave it empty to use the normal " +
    "location. Only fill it in if someone gave you a specific address for a different " +
    "update source.",
  resetEndpoint: "Go back to the normal update location.",
};

/** Sentinel the backend returns when the user dismisses the admin auth prompt.
 *  Must match `CANCEL_SENTINEL` in `src-tauri/src/commands/cli.rs`. */
const CLI_CANCEL_SENTINEL = "CANCELLED_BY_USER";

type CliStatus = { kind: "ok" | "error"; message: string };

const INTERVAL_OPTIONS = [
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 120 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
];

/** Settings section for Maestro updates, the maestro terminal command and the update source. */
export function UpdatesSettingsPanel() {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [endpointInput, setEndpointInput] = useState("");
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null);
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);

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
    invoke<boolean>("is_cli_installed")
      .then(setCliInstalled)
      .catch(() => setCliInstalled(false));
  }, []);

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

  /** Runs an install/uninstall command and shows its outcome; a cancelled prompt shows nothing. */
  const runCliCommand = (
    command: Promise<unknown>,
    installed: boolean,
    okMessage: (value: string) => string,
  ) => {
    setCliStatus(null);
    command
      .then((value) => {
        setCliInstalled(installed);
        setCliStatus({ kind: "ok", message: okMessage(typeof value === "string" ? value : "") });
      })
      .catch((err) => {
        const msg = String(err);
        if (msg === CLI_CANCEL_SENTINEL) {
          setCliStatus(null);
          return;
        }
        setCliStatus({ kind: "error", message: `Error: ${msg}` });
      });
  };

  return (
    <>
      <DialogSection title="Updates" icon={<ArrowDownCircle size={13} />}>
        <DialogRow label="Version" hint={HINTS.version}>
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-maestro-text">
            <Check size={12} className="shrink-0 text-maestro-green" />v{appVersion ?? "..."}
          </span>
        </DialogRow>
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

      <DialogSection
        title="CLI Command"
        icon={<Terminal size={13} />}
        hint={HINTS.cli}
        description={
          <>
            Install the{" "}
            <code className="rounded bg-maestro-border/40 px-1 py-0.5 text-maestro-text">
              maestro
            </code>{" "}
            command to open projects from your terminal.
          </>
        }
      >
        {cliStatus && (
          <div
            className={`text-[11px] ${cliStatus.kind === "error" ? "text-maestro-red" : "text-maestro-green"}`}
          >
            {cliStatus.message}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs">
          {cliInstalled ? (
            <>
              <span className="flex flex-1 items-center gap-1.5 text-[11px] text-maestro-green">
                <Check size={11} />
                Installed
              </span>
              <button
                type="button"
                onClick={() =>
                  runCliCommand(invoke("uninstall_cli"), false, () => "CLI command removed")
                }
                className={dialogButtonClass("danger")}
                title={HINTS.uninstallCli}
              >
                Uninstall
              </button>
            </>
          ) : isWindows() ? (
            // The backend refuses: the command is a POSIX shell script.
            <span className="text-[11px] text-maestro-muted">Not available on Windows.</span>
          ) : (
            <button
              type="button"
              onClick={() =>
                runCliCommand(invoke<string>("install_cli"), true, (path) => `Installed to ${path}`)
              }
              className={dialogButtonClass("primary")}
              title={HINTS.installCli}
            >
              Install &apos;maestro&apos; command in PATH
            </button>
          )}
        </div>
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
