import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDownCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Swords,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDismissable } from "@/hooks/useDismissable";
import { formatTimeAgo } from "@/lib/format";
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
  cli:
    "The maestro command lets you type 'maestro' in any terminal window to open that folder " +
    "as a project in Maestro.",
  installCli:
    "Adds the maestro command to your computer so you can open projects from a terminal " +
    "window. Windows may ask for permission.",
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

const INTERVAL_OPTIONS = [
  { label: "30 minutes", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 120 },
  { label: "6 hours", value: 360 },
  { label: "24 hours", value: 1440 },
];

export function MaestroSettingsModal({ onClose, focusSection }: MaestroSettingsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const workJournalRef = useRef<HTMLDivElement>(null);
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

  // Close on outside click or Escape
  useDismissable(onClose, { ref: modalRef });

  useEffect(() => {
    if (focusSection === "work-journal") {
      workJournalRef.current?.scrollIntoView?.({ block: "start" });
    }
  }, [focusSection]);

  const handleCheckNow = useCallback(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  const handleEndpointBlur = () => {
    const trimmed = endpointInput.trim();
    setCustomEndpoint(trimmed || null);
  };

  const isChecking = status === "checking";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-md rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-maestro-border px-4 py-3">
          <h2 className="text-sm font-semibold text-maestro-text">Maestro Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-maestro-border/40"
          >
            <X size={16} className="text-maestro-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="max-h-[calc(100vh-6rem)] space-y-4 overflow-y-auto p-4">
          {/* Version */}
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
              Version
            </div>
            <div className="flex items-center gap-2 px-1 text-xs" title={HINTS.version}>
              <Check size={12} className="shrink-0 text-maestro-green" />
              <span className="text-maestro-text font-medium">v{appVersion ?? "..."}</span>
            </div>
          </div>

          {/* Updates */}
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
              <ArrowDownCircle size={13} className="text-maestro-green" />
              <span className="flex-1">Updates</span>
              <button
                type="button"
                onClick={handleCheckNow}
                disabled={isChecking}
                className="rounded p-0.5 hover:bg-maestro-border/40"
                title={HINTS.checkNow}
              >
                <RefreshCw
                  size={12}
                  className={`text-maestro-muted ${isChecking ? "animate-spin" : ""}`}
                />
              </button>
            </div>

            <div className="space-y-1">
              {status === "checking" && (
                <div className="flex items-center gap-2 px-1 text-[11px] text-maestro-muted">
                  <Loader2 size={11} className="animate-spin" />
                  Checking...
                </div>
              )}
              <div className="flex items-center gap-2 px-1 text-[10px] text-maestro-muted">
                Last checked: {formatTimeAgo(lastCheckedAt, { capitalize: true })}
              </div>
            </div>

            {/* Auto-check toggle */}
            <div
              className="mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-maestro-text hover:bg-maestro-border/40"
              title={HINTS.autoCheck}
            >
              <span className="flex-1 cursor-help">Auto-check</span>
              <button
                type="button"
                onClick={() => setAutoCheckEnabled(!autoCheckEnabled)}
                className={`relative h-4 w-7 rounded-full transition-colors ${
                  autoCheckEnabled ? "bg-maestro-accent" : "bg-maestro-border"
                }`}
                aria-label="Toggle auto-check"
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                    autoCheckEnabled ? "left-3.5" : "left-0.5"
                  }`}
                />
              </button>
            </div>

            {/* Interval dropdown */}
            {autoCheckEnabled && (
              <div
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-maestro-text"
                title={HINTS.interval}
              >
                <span className="flex-1 cursor-help text-maestro-muted">Interval</span>
                <select
                  value={checkIntervalMinutes}
                  onChange={(e) => setCheckInterval(Number(e.target.value))}
                  className="rounded border border-maestro-border bg-maestro-surface px-1.5 py-0.5 text-[11px] text-maestro-text outline-none"
                >
                  {INTERVAL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* CLI Command */}
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
              <Terminal size={13} className="text-maestro-accent" />
              <span className="cursor-help" title={HINTS.cli}>
                CLI Command
              </span>
            </div>
            <div className="space-y-1.5 px-1">
              <p className="text-[11px] text-maestro-muted">
                Install the{" "}
                <code className="rounded bg-maestro-border/40 px-1 py-0.5 text-maestro-text">
                  maestro
                </code>{" "}
                command to open projects from your terminal.
              </p>
              {cliStatus && (
                <div
                  className={`text-[11px] ${cliStatus.kind === "error" ? "text-maestro-red" : "text-maestro-green"}`}
                >
                  {cliStatus.message}
                </div>
              )}
              <div className="flex items-center gap-2">
                {cliInstalled ? (
                  <>
                    <div className="flex items-center gap-1.5 text-[11px] text-maestro-green">
                      <Check size={11} />
                      Installed
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setCliStatus(null);
                        invoke("uninstall_cli")
                          .then(() => {
                            setCliInstalled(false);
                            setCliStatus({ kind: "ok", message: "CLI command removed" });
                          })
                          .catch((err) => {
                            const msg = String(err);
                            if (msg === CLI_CANCEL_SENTINEL) {
                              setCliStatus(null);
                              return;
                            }
                            setCliStatus({ kind: "error", message: `Error: ${msg}` });
                          });
                      }}
                      className="rounded px-2 py-0.5 text-[11px] text-maestro-red hover:bg-maestro-border/40"
                      title={HINTS.uninstallCli}
                    >
                      Uninstall
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setCliStatus(null);
                      invoke<string>("install_cli")
                        .then((path) => {
                          setCliInstalled(true);
                          setCliStatus({ kind: "ok", message: `Installed to ${path}` });
                        })
                        .catch((err) => {
                          const msg = String(err);
                          if (msg === CLI_CANCEL_SENTINEL) {
                            setCliStatus(null);
                            return;
                          }
                          setCliStatus({ kind: "error", message: `Error: ${msg}` });
                        });
                    }}
                    className="rounded border border-maestro-accent/50 bg-maestro-accent/10 px-3 py-1 text-[11px] font-medium text-maestro-accent hover:bg-maestro-accent/20"
                    title={HINTS.installCli}
                  >
                    Install &apos;maestro&apos; command in PATH
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Samurai supervisor thresholds (PRD §7) */}
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
              <Swords size={13} className="text-maestro-accent" />
              <span className="cursor-help" title={SAMURAI_HINT}>
                Samurai Thresholds
              </span>
            </div>
            <div className="space-y-1 px-1">
              <p className="text-[11px] text-maestro-muted">
                Low values are the test mode: set a park threshold below current usage and watch the
                crossing land in the audit log.
              </p>
              {samuraiError && <div className="text-[11px] text-maestro-red">{samuraiError}</div>}
              {samuraiConfig
                ? SAMURAI_FIELDS.map(({ key, label, hint }) => (
                    <div
                      key={key}
                      className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-maestro-text"
                      title={hint}
                    >
                      <span className="flex-1 cursor-help text-maestro-muted">{label}</span>
                      <input
                        type="number"
                        value={samuraiConfig[key]}
                        onChange={(e) => handleSamuraiChange(key, e.target.value)}
                        onBlur={handleSamuraiBlur}
                        className="w-20 rounded border border-maestro-border bg-maestro-surface px-1.5 py-0.5 text-right text-[11px] text-maestro-text outline-none focus:border-maestro-accent"
                      />
                    </div>
                  ))
                : !samuraiError && (
                    <div className="flex items-center gap-2 px-1 text-[11px] text-maestro-muted">
                      <Loader2 size={11} className="animate-spin" />
                      Loading...
                    </div>
                  )}
            </div>
          </div>

          <div ref={workJournalRef}>
            <WorkJournalSettingsSection />
          </div>

          {/* Advanced */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
              title={HINTS.advanced}
            >
              {advancedOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Advanced
            </button>

            {advancedOpen && (
              <div className="px-2 py-1.5 space-y-1.5">
                <label
                  htmlFor="maestro-custom-endpoint"
                  className="block cursor-help text-[10px] text-maestro-muted uppercase tracking-wide"
                  title={HINTS.endpoint}
                >
                  Custom endpoint
                </label>
                <input
                  id="maestro-custom-endpoint"
                  type="text"
                  value={endpointInput}
                  onChange={(e) => setEndpointInput(e.target.value)}
                  onBlur={handleEndpointBlur}
                  placeholder="https://..."
                  title={HINTS.endpoint}
                  className="w-full rounded border border-maestro-border bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder-maestro-muted/50 outline-none focus:border-maestro-accent"
                />
                {customEndpoint && (
                  <button
                    type="button"
                    onClick={() => {
                      setCustomEndpoint(null);
                      setEndpointInput("");
                    }}
                    className="text-[10px] text-maestro-red hover:underline"
                    title={HINTS.resetEndpoint}
                  >
                    Reset to default
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
