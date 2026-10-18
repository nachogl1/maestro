import { AlertTriangle, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  DialogSection,
  dialogButtonClass,
  dialogInputClass,
} from "@/components/shared/DialogShell";
import { AI_CLI_CONFIG, buildCliCommand, type CliAiMode } from "@/lib/terminal";
import { useCliSettingsStore } from "@/stores/useCliSettingsStore";

/** The AI modes that support CLI flags. */
const CLI_MODES: CliAiMode[] = ["Claude", "Gemini", "Codex", "OpenCode"];

/** Mode display configuration */
const MODE_CONFIG: Record<CliAiMode, { color: string; bgColor: string; skipFlagName: string }> = {
  Claude: {
    color: "text-maestro-orange",
    bgColor: "bg-maestro-orange/20",
    skipFlagName: "--dangerously-skip-permissions",
  },
  Gemini: {
    color: "text-maestro-accent",
    bgColor: "bg-maestro-accent/20",
    skipFlagName: "--yolo",
  },
  Codex: {
    color: "text-maestro-green",
    bgColor: "bg-maestro-green/20",
    skipFlagName: "--dangerously-bypass-approvals-and-sandbox",
  },
  OpenCode: {
    color: "text-purple-500",
    bgColor: "bg-purple-500/20",
    skipFlagName: "--dangerously-skip-permissions",
  },
};

/**
 * Settings section for the CLI flags of each AI mode.
 * Allows configuring flags like --dangerously-skip-permissions and custom flags.
 */
export function CliSettingsPanel() {
  const [activeMode, setActiveMode] = useState<CliAiMode>("Claude");

  const { flags, setSkipPermissions, setCustomFlags, resetModeToDefaults, resetAllToDefaults } =
    useCliSettingsStore();

  const currentFlags = flags[activeMode];
  const previewCommand = buildCliCommand(activeMode, currentFlags);

  return (
    <>
      {/* Mode Tabs */}
      <div className="flex rounded-lg border border-maestro-border/60 bg-maestro-card p-0.5">
        {CLI_MODES.map((mode) => {
          const config = MODE_CONFIG[mode];
          const isActive = activeMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => setActiveMode(mode)}
              className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? `${config.bgColor} ${config.color}`
                  : "text-maestro-muted hover:bg-maestro-border/20 hover:text-maestro-text"
              }`}
            >
              {mode}
            </button>
          );
        })}
      </div>

      <DialogSection
        title="Permissions"
        right={
          <span className="rounded bg-maestro-red/20 px-1.5 py-0.5 text-[10px] font-medium text-maestro-red">
            Security
          </span>
        }
      >
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={currentFlags.skipPermissions}
            onChange={(e) => setSkipPermissions(activeMode, e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-maestro-border accent-maestro-accent"
          />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-maestro-text">Skip Permission Prompts</span>
              {currentFlags.skipPermissions && (
                <span className="flex items-center gap-1 rounded bg-maestro-red/20 px-1.5 py-0.5 text-[10px] font-medium text-maestro-red">
                  <AlertTriangle size={10} />
                  Risk
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-maestro-muted">
              Adds{" "}
              <code className="rounded bg-maestro-border/40 px-1">
                {MODE_CONFIG[activeMode].skipFlagName}
              </code>{" "}
              flag. The CLI will not ask for confirmation before running commands.
            </p>
          </div>
        </label>
      </DialogSection>

      <DialogSection
        title="Custom Flags"
        description={`Additional flags to pass to the ${activeMode} CLI. Separate multiple flags with spaces.`}
      >
        <input
          type="text"
          value={currentFlags.customFlags}
          onChange={(e) => setCustomFlags(activeMode, e.target.value)}
          placeholder="e.g., --verbose --model opus"
          className={`w-full ${dialogInputClass}`}
        />
      </DialogSection>

      <DialogSection title="Command Preview">
        <div className="flex items-center gap-2 rounded border border-maestro-border bg-maestro-bg px-2 py-1.5">
          <span className="text-xs text-maestro-muted">$</span>
          <code className="flex-1 font-mono text-xs text-maestro-text">
            {previewCommand ?? AI_CLI_CONFIG[activeMode].command}
          </code>
        </div>
      </DialogSection>

      <div className="flex items-center">
        <button
          type="button"
          onClick={resetAllToDefaults}
          className={`${dialogButtonClass("ghost")} mr-auto`}
        >
          <RotateCcw size={12} />
          Reset All
        </button>
        <button
          type="button"
          onClick={() => resetModeToDefaults(activeMode)}
          className={dialogButtonClass("ghost")}
        >
          <RotateCcw size={12} />
          Reset {activeMode}
        </button>
      </div>
    </>
  );
}
