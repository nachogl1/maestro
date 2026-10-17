import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Settings,
  Swords,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DialogRow,
  DialogSection,
  DialogShell,
  DialogToggle,
  dialogButtonClass,
  dialogCardClass,
  dialogInputClass,
  dialogSectionHeadingClass,
} from "@/components/shared/DialogShell";
import { formatTimeAgo } from "@/lib/format";
import { isWindows } from "@/lib/platform";
import type { SamuraiConfig } from "@/lib/samurai";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { WorkJournalSettingsSection } from "./WorkJournalSettingsSection";

/** Hover help for the Samurai section heading: what the supervisor is. */
const SAMURAI_HINT =
  "Samurai is Maestro's automatic supervisor. It watches the Claude agents you launch and " +
  "steps in when one runs low on working memory or when your Claude usage allowance is " +
  "nearly used up, so long tasks keep going without you.";

/** One threshold row: the saved field, its label and a plain-language hover hint. */
const SAMURAI_FIELDS: { key: keyof SamuraiConfig; label: string; hint: string }[] = [
  {
    key: "handoff_context_pct",
    label: "Handoff trigger (context %)",
    hint:
      "Each Claude agent has a limited working memory (its context). When an agent has used " +
      "this much of it, Maestro asks it to write down where it got to and hand the work to a " +
      "fresh agent, so quality does not drop as the memory fills up. Lower means earlier, " +
      "more frequent handoffs.",
  },
  {
    key: "park_soft_5h_pct",
    label: "Park soft, 5h window (%)",
    hint:
      "Your Claude plan allows a certain amount of work every 5 hours. When this much of it is " +
      "used, agents stop starting new helper agents and begin wrapping up, so there is still " +
      "room left to pause cleanly.",
  },
  {
    key: "park_hard_5h_pct",
    label: "Park hard, 5h window (%)",
    hint:
      "When this much of the 5-hour allowance is used, Maestro pauses (parks) the agents one " +
      "by one: each finishes its current step, saves its notes and stops. They resume on " +
      "their own when the allowance resets.",
  },
  {
    key: "park_hard_7d_pct",
    label: "Park hard, 7d window (%)",
    hint:
      "Your plan also has a weekly limit. When this much of the 7-day allowance is used, " +
      "agents are paused the same way and resume when the weekly allowance resets.",
  },
  {
    key: "ack_timeout_secs",
    label: "ACK timeout (seconds)",
    hint:
      "When Maestro sends an agent an instruction (for example to hand off or pause), it " +
      "expects a short confirmation back. If none arrives within this many seconds, Maestro " +
      "sends the instruction once more and then raises an alert.",
  },
  {
    key: "max_turn_wait_secs",
    label: "Max turn wait (seconds)",
    hint:
      "An agent can be busy on one long step for a while. If it has not come back for new " +
      "instructions after this many seconds, Maestro raises an alert that it may be stuck. " +
      "The waiting instruction is kept and delivered when the agent finishes.",
  },
  {
    key: "staleness_window_secs",
    label: "Staleness window (seconds)",
    hint:
      "Maestro treats an agent as possibly dead when it has written nothing for this many " +
      "seconds. If its program has also gone, the agent is reported as dead so a replacement " +
      "can take over.",
  },
  {
    key: "handoff_retention_days",
    label: "Handoff retention (days)",
    hint:
      "Handoff notes (what an agent wrote down for its successor) are kept for this many days " +
      "after the task they belong to is finished, then deleted to save space.",
  },
  {
    key: "breaker_events",
    label: "Circuit breaker events (zero-progress trip)",
    hint:
      "A safety stop. If an agent produces this many actions in a row without committing any " +
      "new code, Maestro assumes it is going in circles, pauses it and raises an alert instead " +
      "of letting it use up your allowance.",
  },
  {
    key: "size_warn_bytes",
    label: "File size warning (bytes)",
    hint:
      "Files that Maestro keeps for you (such as the activity log) grow over time. Any file at " +
      "or above this size, in bytes, gets a warning in the Second Brain panel so you know it is " +
      "time to clear it. 1,000,000 bytes is about 1 MB.",
  },
];

/** Hover help for the other settings, in plain language. */
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

interface MaestroSettingsModalProps {
  onClose: () => void;
  /** A section to scroll into view on open; the top of the settings otherwise. */
  focusSection?: "work-journal";
}

/** Sentinel the backend returns when the user dismisses the admin auth prompt.
 *  Must match `CANCEL_SENTINEL` in `src-tauri/src/commands/cli.rs`. */
const CLI_CANCEL_SENTINEL = "CANCELLED_BY_USER";

type CliStatus = { kind: "ok" | "error"; message: string };

/** How long `focusSection` keeps re-scrolling while late-loading rows settle. */
const FOCUS_SETTLE_MS = 1500;

/** Input that means the user is scrolling themselves, which ends the re-scrolling. */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

const INTERVAL_OPTIONS = [
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 120 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
];

export function MaestroSettingsModal({ onClose, focusSection }: MaestroSettingsModalProps) {
  const workJournalRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [endpointInput, setEndpointInput] = useState("");
  const [cliInstalled, setCliInstalled] = useState<boolean | null>(null);
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
  const [samuraiConfig, setSamuraiConfig] = useState<SamuraiConfig | null>(null);
  const [samuraiError, setSamuraiError] = useState<string | null>(null);

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
    invoke<SamuraiConfig>("samurai_get_config")
      .then(setSamuraiConfig)
      .catch((err) => setSamuraiError(String(err)));
  }, []);

  const handleSamuraiChange = (key: keyof SamuraiConfig, raw: string) => {
    setSamuraiConfig((prev) => (prev ? { ...prev, [key]: Number(raw) } : prev));
  };

  // Persist on blur: the backend validates, saves to the settings store and
  // applies to the running allowance watcher; on rejection the saved config
  // is untouched, so re-fetch to show what is actually in force.
  const handleSamuraiBlur = () => {
    if (!samuraiConfig) return;
    setSamuraiError(null);
    invoke<SamuraiConfig>("samurai_set_config", { config: samuraiConfig })
      .then(setSamuraiConfig)
      .catch((err) => {
        setSamuraiError(String(err));
        invoke<SamuraiConfig>("samurai_get_config")
          .then(setSamuraiConfig)
          .catch(() => {});
      });
  };

  useEffect(() => {
    invoke<string>("get_app_version")
      .then(setAppVersion)
      .catch((err) => console.error("Failed to get app version:", err));
  }, []);

  useEffect(() => {
    setEndpointInput(customEndpoint ?? "");
  }, [customEndpoint]);

  useEffect(() => {
    if (focusSection !== "work-journal") return;
    const scrollToSection = () => workJournalRef.current?.scrollIntoView?.({ block: "start" });
    scrollToSection();
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    // Rows above the section (version, update and Samurai settings) arrive
    // after mount and push it down: keep it pinned while the layout settles,
    // unless the user scrolls on their own first.
    const observer = new ResizeObserver(scrollToSection);
    for (const child of Array.from(content.children)) observer.observe(child);
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(timer);
      for (const type of USER_SCROLL_EVENTS) content.removeEventListener(type, stop);
    };
    const timer = window.setTimeout(stop, FOCUS_SETTLE_MS);
    for (const type of USER_SCROLL_EVENTS) {
      content.addEventListener(type, stop, { passive: true });
    }
    return stop;
  }, [focusSection]);

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
    <DialogShell
      title="Maestro Settings"
      subtitle="Updates, the terminal command, the Samurai supervisor and the Work Journal."
      icon={<Settings size={16} />}
      onClose={onClose}
      bodyRef={contentRef}
    >
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

      {/* Samurai supervisor thresholds (PRD §7) */}
      <DialogSection
        title="Samurai Thresholds"
        icon={<Swords size={13} />}
        hint={SAMURAI_HINT}
        description={
          "Low values are the test mode: set a park threshold below current usage and watch " +
          "the crossing land in the audit log."
        }
      >
        {samuraiError && <div className="text-[11px] text-maestro-red">{samuraiError}</div>}
        {samuraiConfig
          ? SAMURAI_FIELDS.map(({ key, label, hint }) => (
              <DialogRow key={key} label={label} hint={hint}>
                <input
                  type="number"
                  value={samuraiConfig[key]}
                  onChange={(e) => handleSamuraiChange(key, e.target.value)}
                  onBlur={handleSamuraiBlur}
                  className={`w-24 text-right ${dialogInputClass}`}
                />
              </DialogRow>
            ))
          : !samuraiError && (
              <div className="flex items-center gap-2 text-[11px] text-maestro-muted">
                <Loader2 size={11} className="animate-spin" />
                Loading...
              </div>
            )}
      </DialogSection>

      <div ref={workJournalRef}>
        <WorkJournalSettingsSection />
      </div>

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
    </DialogShell>
  );
}
