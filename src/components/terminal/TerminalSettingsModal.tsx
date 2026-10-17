import { Loader2, Monitor, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DialogSection,
  DialogShell,
  dialogButtonClass,
  dialogInputClass,
} from "@/components/shared/DialogShell";
import { clearFontCache, EMBEDDED_FONT } from "@/lib/fonts";
import { useTerminalSettingsStore } from "@/stores/useTerminalSettingsStore";

interface TerminalSettingsModalProps {
  onClose: () => void;
}

/** The zoom presets offered as buttons, in percent. */
const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200];

/**
 * Modal for managing terminal display settings:
 * - Font family selection (with detected system fonts)
 * - Font size adjustment
 * - Line height adjustment
 */
export function TerminalSettingsModal({ onClose }: TerminalSettingsModalProps) {
  const {
    settings,
    availableFonts,
    isLoading,
    isInitialized,
    initialize,
    setSetting,
    resetToDefaults,
    setZoomLevel,
    getEffectiveFontSize,
  } = useTerminalSettingsStore();

  const [isRefreshing, setIsRefreshing] = useState(false);

  // Initialize settings store on mount
  useEffect(() => {
    if (!isInitialized) {
      initialize();
    }
  }, [isInitialized, initialize]);

  const handleRefreshFonts = async () => {
    setIsRefreshing(true);
    clearFontCache();
    await initialize();
    setIsRefreshing(false);
  };

  return (
    <DialogShell
      title="Terminal Settings"
      subtitle="Font, size and spacing of every terminal."
      icon={<Monitor size={16} />}
      onClose={onClose}
      footer={
        <button type="button" onClick={resetToDefaults} className={dialogButtonClass("ghost")}>
          <RotateCcw size={12} />
          Reset to Defaults
        </button>
      }
    >
      {isLoading && !isInitialized ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-maestro-muted" />
        </div>
      ) : (
        <>
          <FontFamilySection
            availableFonts={availableFonts}
            selectedFont={settings.fontFamily}
            onSelect={(font) => setSetting("fontFamily", font)}
            onRefresh={handleRefreshFonts}
            isRefreshing={isRefreshing}
          />

          <DialogSection title="Font Size">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={10}
                max={20}
                step={1}
                value={settings.fontSize}
                onChange={(e) => setSetting("fontSize", Number(e.target.value))}
                className="flex-1 accent-maestro-accent"
              />
              <span className="w-16 text-right text-xs font-medium text-maestro-text">
                {settings.zoomLevel !== 100
                  ? `${settings.fontSize}px @ ${settings.zoomLevel}% = ${getEffectiveFontSize()}px`
                  : `${settings.fontSize}px`}
              </span>
            </div>
          </DialogSection>

          <DialogSection title="Zoom Level">
            <div className="flex flex-wrap gap-1.5">
              {ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setZoomLevel(preset)}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    settings.zoomLevel === preset
                      ? "bg-maestro-accent text-white"
                      : "bg-maestro-bg text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
                  }`}
                >
                  {preset}%
                </button>
              ))}
            </div>
            {settings.zoomLevel !== 100 && (
              <p className="text-[11px] text-maestro-muted">
                Effective font size: {getEffectiveFontSize()}px
              </p>
            )}
          </DialogSection>

          <DialogSection title="Line Height">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={1.0}
                max={2.0}
                step={0.1}
                value={settings.lineHeight}
                onChange={(e) => setSetting("lineHeight", Number(e.target.value))}
                className="flex-1 accent-maestro-accent"
              />
              <span className="w-8 text-right text-xs font-medium text-maestro-text">
                {settings.lineHeight.toFixed(1)}
              </span>
            </div>
          </DialogSection>
        </>
      )}
    </DialogShell>
  );
}

/* ── Font Family Section ── */

interface FontFamilySectionProps {
  availableFonts: { family: string; is_nerd_font: boolean; is_monospace: boolean }[];
  selectedFont: string;
  onSelect: (font: string) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

function FontFamilySection({
  availableFonts,
  selectedFont,
  onSelect,
  onRefresh,
  isRefreshing,
}: FontFamilySectionProps) {
  return (
    <DialogSection
      title="Font Family"
      right={
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="rounded p-0.5 hover:bg-maestro-border/40 disabled:opacity-50"
          title="Refresh font list"
        >
          {isRefreshing ? (
            <Loader2 size={12} className="animate-spin text-maestro-muted" />
          ) : (
            <RefreshCw size={12} className="text-maestro-muted" />
          )}
        </button>
      }
    >
      <select
        value={selectedFont}
        onChange={(e) => onSelect(e.target.value)}
        className={`w-full ${dialogInputClass} text-sm`}
        style={{ fontFamily: selectedFont }}
        size={8}
      >
        {/* Always show embedded font first */}
        <option value={EMBEDDED_FONT}>{EMBEDDED_FONT} (Embedded)</option>

        {/* Nerd Fonts group */}
        {availableFonts.some((f) => f.is_nerd_font) && (
          <optgroup label="Nerd Fonts">
            {availableFonts
              .filter((f) => f.is_nerd_font && f.family !== EMBEDDED_FONT)
              .map((font) => (
                <option key={font.family} value={font.family}>
                  {font.family}
                </option>
              ))}
          </optgroup>
        )}

        {/* Other monospace fonts group */}
        {availableFonts.some((f) => !f.is_nerd_font) && (
          <optgroup label="Monospace Fonts">
            {availableFonts
              .filter((f) => !f.is_nerd_font && f.family !== EMBEDDED_FONT)
              .map((font) => (
                <option key={font.family} value={font.family}>
                  {font.family}
                </option>
              ))}
          </optgroup>
        )}
      </select>

      {/* Font preview */}
      <div
        className="rounded border border-maestro-border bg-maestro-bg p-2 text-xs text-maestro-text"
        style={{ fontFamily: selectedFont }}
      >
        The quick brown fox jumps over the lazy dog
        <br />
        <span className="text-maestro-muted">0123456789 !@#$%^&*()</span>
      </div>

      {/* Selected font badges */}
      <div className="flex flex-wrap gap-1">
        {availableFonts.find((f) => f.family === selectedFont)?.is_nerd_font && (
          <span className="rounded bg-maestro-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-maestro-accent">
            Nerd Font
          </span>
        )}
        {selectedFont === EMBEDDED_FONT && (
          <span className="rounded bg-maestro-green/20 px-1.5 py-0.5 text-[10px] font-medium text-maestro-green">
            Embedded
          </span>
        )}
      </div>
    </DialogSection>
  );
}
