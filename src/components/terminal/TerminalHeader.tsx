import {
  AlertTriangle,
  BrainCircuit,
  ChevronDown,
  Code2,
  Expand,
  GitBranch,
  Mail,
  Minimize,
  MoreHorizontal,
  ParkingSquare,
  Pin,
  PinOff,
  Sparkles,
  Terminal,
  X,
  ZoomIn,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type IconComponent, OpenCodeIcon } from "@/components/icons";
import { SamuraiBadge } from "@/components/terminal/SamuraiBadge";
import { useDismissable } from "@/hooks/useDismissable";
import { sessionDisplayName } from "@/lib/sessionDisplayName";
import { altLabel, comboLabel, modLabel, shiftLabel, titleWithShortcut } from "@/lib/shortcuts";
import { type InjectedMessage, useInjectedMessageStore } from "@/stores/useInjectedMessageStore";

export type SessionStatus =
  | "idle"
  | "starting"
  | "working"
  | "needs-input"
  | "done"
  | "error"
  | "timeout";

export type AIProvider = "claude" | "gemini" | "codex" | "opencode" | "plain";

interface TerminalHeaderProps {
  sessionId: number;
  sessionName?: string | null;
  /** Session status — colors the header underline (working vs needs-input). */
  status?: SessionStatus;
  provider?: AIProvider;
  branchName?: string;
  showLaunch?: boolean;
  isWorktree?: boolean;
  onKill: (sessionId: number) => void;
  onRename?: (sessionId: number, name: string | null) => void;
  onLaunch?: () => void;
  terminalCount?: number;
  isZoomed?: boolean;
  onToggleZoom?: () => void;
  /** Park this terminal: hide its pane without stopping the session. */
  onPark?: () => void;
  /**
   * Pin this terminal so it keeps showing from every project. Undefined hides
   * the control entirely — it is only offered where the terminal is big enough
   * to act on: zoomed in, in eagle view, or already pinned.
   */
  onTogglePin?: () => void;
  /** This terminal is pinned — the button unpins instead. */
  isPinned?: boolean;
  zoomLevel?: number;
  onSetZoomLevel?: (level: number) => void;
  /** Project name shown in bold before the session label (eagle view). */
  projectLabel?: string;
  /** Color for the project label — matches the tile border color. */
  projectColor?: string;
  /** Reserve space at the left for the pane's drag handle overlay. */
  hasMoveHandle?: boolean;
  /** Warning flag: renders the header yellow (toggled by clicking it). */
  isFlagged?: boolean;
  /**
   * Attention highlight: the session was auto-unparked because its agent
   * asked for input. Same yellow chrome as the warning flag; cleared when
   * the user selects the session (the first header click clears it instead
   * of toggling the warning flag).
   */
  hasAttention?: boolean;
  /** Toggle the warning flag — fired on clicks outside interactive controls. */
  onToggleFlag?: () => void;
  /**
   * Whether tooltips advertise the park/zoom keyboard shortcuts. Off for a
   * pinned terminal shown over another project, where no shortcut handler
   * owns it (the buttons themselves still work).
   */
  showShortcutHints?: boolean;
  /**
   * Context alert is active for this terminal: a small red warning icon
   * blinks right after the terminal name, in step with the frame.
   */
  contextAlert?: boolean;
  /**
   * Detail in the alert icon's hover text ("Context 87% >= 80% alert"). Derived by the
   * parent so this memoised header does not re-render on every usage tick.
   */
  contextAlertTitle?: string;
}

/** One row of the header's ⋯ menu, standing in for a folded button. */
interface TerminalHeaderMenuItem {
  key: string;
  icon?: React.ReactNode;
  text: string;
  /** Shortcut shown on the right, as the button's tooltip spells it. */
  shortcut?: string;
  title: string;
  ariaLabel: string;
  onSelect: () => void;
  selected?: boolean;
  /** Marks the item for the header shortcuts (see lib/headerShortcuts). */
  headerAction?: "pin";
}

const providerConfig: Record<AIProvider, { icon: IconComponent; label: string }> = {
  claude: { icon: BrainCircuit, label: "Claude Code" },
  gemini: { icon: Sparkles, label: "Gemini CLI" },
  codex: { icon: Code2, label: "Codex" },
  opencode: { icon: OpenCodeIcon, label: "OpenCode" },
  plain: { icon: Terminal, label: "Terminal" },
};

/**
 * Header widths (px) at which the header gives way as its column narrows
 * (issue #552). Below the first, park, pin, zoom and font size fold into the
 * ⋯ menu; below the second the branch hides; below the third the project
 * name hides. The terminal name is only ever cut with … as a last resort.
 */
const FOLD_BUTTONS_BELOW_PX = 480;
const HIDE_BRANCH_BELOW_PX = 360;
const HIDE_PROJECT_BELOW_PX = 260;

/**
 * How far a header of this width has given way: 0 full layout, 1 buttons
 * folded, 2 also the branch hidden, 3 also the project hidden. Width 0 means
 * not laid out yet, so the full layout. Kept as a step, not a width, so a
 * column drag re-renders the header only when it crosses a breakpoint.
 */
function narrowStep(width: number): number {
  if (width === 0 || width >= FOLD_BUTTONS_BELOW_PX) return 0;
  if (width >= HIDE_BRANCH_BELOW_PX) return 1;
  if (width >= HIDE_PROJECT_BELOW_PX) return 2;
  return 3;
}
/** Largest AI provider icon in a folded header, so it stays but takes little room. */
const FOLDED_PROVIDER_ICON_SIZE = 14;
const FONT_ZOOM_PRESETS = [50, 75, 100, 125, 150, 200];
const CONTEXT_ALERT_TEXT = "Context threshold reached";
const NO_INJECTED_MESSAGES: InjectedMessage[] = [];

/** Local 24-hour clock time of a notice, e.g. "14:20". */
function clockTime(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Hover text of the injected-message icon: one line per notice, newest first. */
function injectedMessagesHover(messages: InjectedMessage[]): string {
  const lines = messages.map(
    (m) => `${m.sender} · ${clockTime(m.at)} · ${m.text.trim().split(/\r?\n/)[0]}`,
  );
  return [...lines, "Click to dismiss"].join("\n");
}

export const TerminalHeader = memo(function TerminalHeader({
  sessionId,
  sessionName,
  status,
  provider = "claude",
  branchName = "...",
  showLaunch = false,
  isWorktree = false,
  onKill,
  onRename,
  onLaunch,
  terminalCount = 1,
  isZoomed = false,
  onToggleZoom,
  onPark,
  onTogglePin,
  isPinned = false,
  zoomLevel = 100,
  onSetZoomLevel,
  projectLabel,
  projectColor,
  hasMoveHandle = false,
  isFlagged = false,
  hasAttention = false,
  onToggleFlag,
  showShortcutHints = true,
  contextAlert = false,
  contextAlertTitle,
}: TerminalHeaderProps) {
  const { icon: ProviderIcon, label: providerLabel } = providerConfig[provider];
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const zoomMenuRef = useRef<HTMLDivElement>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const editNameRef = useRef<HTMLInputElement>(null);
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState(0);
  const [isNameCut, setIsNameCut] = useState(false);
  const injectedMessages = useInjectedMessageStore(
    (s) => s.bySession[sessionId] ?? NO_INJECTED_MESSAGES,
  );

  // The header follows its own column width, not the terminal count: a
  // narrow column in a split layout folds the same way a dense grid does.
  // The name is observed too, so a badge appearing beside it still updates
  // whether it is cut. Re-armed when the rename field swaps the name out.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isEditingName re-runs the effect so the observer follows the name button that replaces the rename field.
  useEffect(() => {
    const header = headerRef.current;
    if (!header || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === header) setStep(narrowStep(entry.contentRect.width));
      }
      const name = nameRef.current;
      setIsNameCut(name !== null && name.scrollWidth > name.clientWidth);
    });
    observer.observe(header);
    if (nameRef.current) observer.observe(nameRef.current);
    return () => observer.disconnect();
  }, [isEditingName]);

  const foldButtons = step >= 1;
  const hideBranch = step >= 2;
  const hideProject = step >= 3;

  const defaultLabel = sessionDisplayName({ id: sessionId });

  const startEditingName = () => {
    if (!onRename) return;
    setEditNameValue(sessionName || defaultLabel);
    setIsEditingName(true);
    setTimeout(() => editNameRef.current?.select(), 0);
  };

  const commitName = () => {
    const trimmed = editNameValue.trim();
    const newName = trimmed && trimmed !== defaultLabel ? trimmed : null;
    onRename?.(sessionId, newName);
    setIsEditingName(false);
  };

  const cancelEditName = () => {
    setIsEditingName(false);
  };

  const handleZoomPreset = useCallback(
    (level: number) => {
      onSetZoomLevel?.(level);
      setShowZoomMenu(false);
    },
    [onSetZoomLevel],
  );

  // Close zoom menu on outside click
  useDismissable(() => setShowZoomMenu(false), {
    ref: zoomMenuRef,
    enabled: showZoomMenu,
    escape: false,
  });

  // Close the ⋯ menu on outside click, like the font zoom menu.
  useDismissable(() => setShowActionsMenu(false), {
    ref: actionsMenuRef,
    enabled: showActionsMenu,
    escape: false,
  });

  // Each folded control runs its button's action, then closes the menu.
  const fromMenu = (action: () => void) => () => {
    action();
    setShowActionsMenu(false);
  };

  // One row of the ⋯ menu: the button's icon and name, its shortcut on the
  // right, and the button's own tooltip and accessible name.
  const menuItem = (item: TerminalHeaderMenuItem) => (
    <button
      key={item.key}
      type="button"
      role="menuitem"
      onClick={item.onSelect}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-maestro-card ${
        item.selected ? "font-semibold text-maestro-accent" : "text-maestro-text"
      }`}
      title={item.title}
      aria-label={item.ariaLabel}
      data-header-action={item.headerAction}
    >
      {item.icon && <span className="text-maestro-muted">{item.icon}</span>}
      <span className="flex-1 text-left">{item.text}</span>
      {item.shortcut && <span className="text-[10px] text-maestro-muted">{item.shortcut}</span>}
    </button>
  );

  // Calculate adaptive styling based on terminal count
  const getAdaptiveClasses = () => {
    if (isZoomed) {
      // When zoomed, match the 1-2 terminal tier for consistency
      return {
        headerHeight: "h-10",
        providerIconSize: 20,
        sessionLabelSize: "text-sm",
        badgeSize: "text-xs",
        badgePadding: "px-2 py-0.5",
        branchMaxWidth: "max-w-[200px]",
        statusSize: "text-xs",
        showAllElements: true,
        gapSize: "gap-2",
      };
    }

    if (terminalCount <= 2) {
      // 1-2 terminals: large size
      return {
        headerHeight: "h-12",
        providerIconSize: 28,
        sessionLabelSize: "text-base",
        badgeSize: "text-xs",
        badgePadding: "px-2.5 py-1",
        branchMaxWidth: "max-w-[140px]",
        statusSize: "text-sm",
        showAllElements: true,
        gapSize: "gap-2",
      };
    } else if (terminalCount <= 3) {
      // 3 terminals: comfortable
      return {
        headerHeight: "h-10",
        providerIconSize: 24,
        sessionLabelSize: "text-sm",
        badgeSize: "text-xs",
        badgePadding: "px-2 py-0.5",
        branchMaxWidth: "max-w-[120px]",
        statusSize: "text-xs",
        showAllElements: true,
        gapSize: "gap-2",
      };
    } else if (terminalCount === 4) {
      // 4 terminals: moderate
      return {
        headerHeight: "h-9",
        providerIconSize: 20,
        sessionLabelSize: "text-[13px]",
        badgeSize: "text-[11px]",
        badgePadding: "px-2 py-0.5",
        branchMaxWidth: "max-w-[100px]",
        statusSize: "text-xs",
        showAllElements: true,
        gapSize: "gap-1.5",
      };
    } else if (terminalCount <= 6) {
      // 5-6 terminals: compact
      return {
        headerHeight: "h-8",
        providerIconSize: 18,
        sessionLabelSize: "text-xs",
        badgeSize: "text-[10px]",
        badgePadding: "px-1.5 py-0.5",
        branchMaxWidth: "max-w-[80px]",
        statusSize: "text-[11px]",
        showAllElements: true,
        gapSize: "gap-1",
      };
    } else {
      // 7+ terminals: moderately compact
      return {
        headerHeight: "h-7",
        providerIconSize: 16,
        sessionLabelSize: "text-[11px]",
        badgeSize: "text-[9px]",
        badgePadding: "px-1.5 py-px",
        branchMaxWidth: "max-w-[60px]",
        statusSize: "text-[10px]",
        showAllElements: false,
        gapSize: "gap-1",
      };
    }
  };

  const adaptive = getAdaptiveClasses();

  // Tooltip with the control's keyboard shortcut, when shortcuts reach this
  // terminal (see showShortcutHints).
  const hint = (action: string, ...keys: string[]) =>
    showShortcutHints ? titleWithShortcut(action, ...keys) : action;

  // Shared by each button and its ⋯ menu item, so both read the same.
  const parkTitle = hint("Park terminal — hide without stopping", altLabel(), "P");
  const parkLabel = `Park session ${sessionId}`;
  const pinTitle = hint(
    isPinned
      ? "Unpin — stop showing this terminal while other projects are open"
      : "Pin — keep this terminal visible while other projects are open",
    altLabel(),
    shiftLabel(),
    "P",
  );
  const pinLabel = `${isPinned ? "Unpin" : "Pin"} session ${sessionId}`;
  const zoomLabel = isZoomed ? "Restore grid view" : "Zoom terminal";
  const zoomTitle = hint(zoomLabel, modLabel(), "1");
  const showFontZoom = zoomLevel !== 100 && onSetZoomLevel !== undefined;
  const branchTitle = isWorktree
    ? `Isolated worktree branch: ${branchName}`
    : `Checked-out branch: ${branchName} (updates live)`;
  const displayName = sessionName || defaultLabel;
  const renameHint = onRename
    ? hint("Rename terminal — click to edit the name", altLabel(), "R")
    : undefined;
  // Whatever the column has no room for is spelt out on the name's hover.
  const nameTitle =
    isNameCut || hideBranch || (hideProject && projectLabel)
      ? [
          displayName,
          hideProject && projectLabel ? `Project: ${projectLabel}` : null,
          hideBranch ? branchTitle : null,
          renameHint,
        ]
          .filter(Boolean)
          .join("\n")
      : renameHint;
  const contextAlertHover = contextAlertTitle
    ? `${CONTEXT_ALERT_TEXT} — ${contextAlertTitle}`
    : CONTEXT_ALERT_TEXT;

  // Status-colored underline: blue while the agent works, red when it
  // waits for the user's input (same palette as the tab status dot).
  const statusBorder =
    status === "working"
      ? "border-maestro-blue/70"
      : status === "needs-input"
        ? "border-maestro-accent"
        : "border-maestro-border";

  // Toggle the warning flag on plain header clicks; clicks on buttons/inputs
  // (park, zoom, kill, rename field, …) and anywhere in the open ⋯ menu
  // (its labels and padding) keep their own actions.
  const handleHeaderClick = (e: React.MouseEvent) => {
    if (!onToggleFlag) return;
    if ((e.target as HTMLElement).closest("button, input, [role='menu']")) return;
    onToggleFlag();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: background click-to-flag on a row full of nested interactive controls (buttons/inputs excluded via handleHeaderClick) — not a discrete focusable widget, so there's no sensible single keyboard equivalent.
    // biome-ignore lint/a11y/useKeyWithClickEvents: see noStaticElementInteractions above.
    <div
      ref={headerRef}
      className={`no-select terminal-header relative flex ${adaptive.headerHeight} shrink-0 items-center ${adaptive.gapSize} border-b ${statusBorder} ${isFlagged || hasAttention ? "warning-flag" : "bg-maestro-surface"} ${hasMoveHandle ? "pl-6 pr-2" : "px-2"} ${onToggleFlag ? "cursor-pointer" : ""}`}
      // The whole title bar is the pane's drag handle (see DraggablePane in
      // TerminalGrid): press and move to pick the terminal up; a plain click
      // still toggles the flag.
      data-pane-drag-handle=""
      // Alt+Shift+F clicks the header itself (see lib/headerShortcuts).
      data-header-action={onToggleFlag ? "flag" : undefined}
      onClick={handleHeaderClick}
      title={
        onToggleFlag
          ? hint(
              hasAttention
                ? "Needs input — click to clear the attention highlight"
                : isFlagged
                  ? "Click to clear warning flag"
                  : "Click to flag as warning",
              altLabel(),
              shiftLabel(),
              "F",
            )
          : undefined
      }
    >
      {/* Left cluster */}
      <div className={`flex min-w-0 flex-1 items-center ${adaptive.gapSize}`}>
        {/* AI provider icon + dropdown */}
        <button
          type="button"
          aria-label="Select AI provider"
          aria-disabled="true"
          title={`${providerLabel} — provider selection not yet available`}
          className="flex shrink-0 items-center gap-0.5 text-maestro-muted hover:text-maestro-text"
        >
          <ProviderIcon
            size={
              foldButtons
                ? Math.min(adaptive.providerIconSize, FOLDED_PROVIDER_ICON_SIZE)
                : adaptive.providerIconSize
            }
            strokeWidth={1.5}
            className="text-maestro-accent drop-shadow-[0_0_4px_rgb(var(--maestro-accent)/0.5)]"
          />
          {!isZoomed && !foldButtons && terminalCount <= 4 && (
            <ChevronDown size={9} className="text-maestro-muted/60" />
          )}
        </button>

        {/* Project label (eagle view) — bold, in the project's assigned color.
            Shrinks far faster than the terminal name, so it gives way first. */}
        {projectLabel && !hideProject && (
          <span
            className={`min-w-0 shrink-[100] truncate font-bold ${adaptive.sessionLabelSize}`}
            style={projectColor ? { color: projectColor } : undefined}
            title={`Project: ${projectLabel}`}
          >
            {projectLabel}
          </span>
        )}

        {/* Session label */}
        {isEditingName ? (
          <input
            ref={editNameRef}
            type="text"
            value={editNameValue}
            onChange={(e) => setEditNameValue(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== "Escape") return;
              if (e.key === "Enter") commitName();
              else cancelEditName();
              // Hand the keyboard back to this terminal so renaming stays
              // mouse-free. After the field unmounts: focusing now would blur
              // it and commit the name a second time (or commit a cancel).
              const textarea = e.currentTarget
                .closest(".terminal-cell")
                ?.querySelector<HTMLElement>(".xterm-helper-textarea");
              requestAnimationFrame(() => textarea?.focus());
            }}
            className={`shrink-0 rounded border border-maestro-accent bg-maestro-card px-1 py-0 font-medium text-maestro-text outline-none ${adaptive.sessionLabelSize}`}
            // biome-ignore lint/a11y/noAutofocus: rename field revealed by an explicit user action (click-to-rename) — autofocus is the expected UX here.
            autoFocus
          />
        ) : (
          <button
            ref={nameRef}
            type="button"
            className={`min-w-0 cursor-text truncate font-medium text-maestro-text ${adaptive.sessionLabelSize}`}
            title={nameTitle}
            data-header-action={onRename ? "rename" : undefined}
            onClick={(e) => {
              // Renaming, not flag-toggling — keep the click off the header.
              e.stopPropagation();
              startEditingName();
            }}
          >
            {displayName}
          </button>
        )}

        {/* Context alert: a small red icon in the row right after the name,
            blinking with the frame; the full text is on hover. In the row,
            not over it, so it never covers the name or the controls. */}
        {contextAlert && (
          <output
            className="context-alert-pill flex shrink-0 items-center text-maestro-red"
            title={contextAlertHover}
            aria-label={contextAlertHover}
          >
            <AlertTriangle size={terminalCount <= 4 ? 12 : 10} aria-hidden="true" />
          </output>
        )}

        {/* Injected messages (issue #554): an amber icon after the name (and
            after the context icon) while the Injector or a trigger has sent
            this terminal anything; a count from two on. Only its own click
            clears it. */}
        {injectedMessages.length > 0 && (
          <button
            type="button"
            onClick={() => useInjectedMessageStore.getState().clear(sessionId)}
            className="flex shrink-0 items-center gap-0.5 text-amber-500 hover:text-amber-400"
            title={injectedMessagesHover(injectedMessages)}
            aria-label={`Injected messages: ${injectedMessages.length}, click to dismiss`}
          >
            <Mail size={terminalCount <= 4 ? 12 : 10} aria-hidden="true" />
            {injectedMessages.length >= 2 && (
              <span className={`${adaptive.badgeSize} font-semibold`}>
                {injectedMessages.length}
              </span>
            )}
          </button>
        )}

        {/* Samurai supervision (issue #46): gen-N · state · context %.
            Renders nothing for non-supervised sessions. */}
        <SamuraiBadge sessionId={sessionId} />
      </div>

      {/* Right cluster */}
      <div className="flex shrink-0 items-center gap-0.5">
        {/* Branch display - more compact in dense mode; first to hide */}
        {!hideBranch && (
          <span
            className={`flex items-center gap-0.5 px-1 py-0.5 text-maestro-muted ${adaptive.badgeSize}`}
            title={branchTitle}
          >
            <GitBranch size={terminalCount <= 4 ? 10 : 8} />
            <span className={`truncate ${adaptive.branchMaxWidth}`}>{branchName}</span>
          </span>
        )}

        {/* Launch button (pre-launch only) */}
        {showLaunch && (
          <button
            type="button"
            onClick={() => onLaunch?.()}
            className="rounded bg-maestro-green px-1.5 py-0.5 font-medium text-white transition-colors hover:bg-maestro-green/80 text-[9px]"
          >
            Launch
          </button>
        )}

        {foldButtons ? (
          /* Narrow column: park, pin, zoom and font size fold into one ⋯
             menu. The menu stays mounted (hidden) while closed, so the pin
             shortcut still finds and clicks its item (lib/headerShortcuts). */
          <div className="relative" ref={actionsMenuRef}>
            <button
              type="button"
              onClick={() => setShowActionsMenu((v) => !v)}
              className="rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-accent"
              title="More terminal actions"
              aria-label="More terminal actions"
              aria-haspopup="menu"
              aria-expanded={showActionsMenu}
            >
              <MoreHorizontal size={terminalCount <= 4 ? 14 : 12} />
            </button>
            <div
              role="menu"
              hidden={!showActionsMenu}
              // The header is the pane's drag handle; a press on the menu's
              // labels or padding must not pick the terminal up.
              onPointerDown={(e) => e.stopPropagation()}
              className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-lg border border-maestro-border bg-maestro-surface py-1 shadow-lg"
            >
              {onPark &&
                menuItem({
                  key: "park",
                  icon: <ParkingSquare size={12} />,
                  text: "Park",
                  shortcut: showShortcutHints ? comboLabel(altLabel(), "P") : undefined,
                  title: parkTitle,
                  ariaLabel: parkLabel,
                  onSelect: fromMenu(onPark),
                })}
              {onTogglePin &&
                menuItem({
                  key: "pin",
                  icon: isPinned ? <PinOff size={12} /> : <Pin size={12} />,
                  text: isPinned ? "Unpin" : "Pin",
                  shortcut: showShortcutHints
                    ? comboLabel(altLabel(), shiftLabel(), "P")
                    : undefined,
                  title: pinTitle,
                  ariaLabel: pinLabel,
                  onSelect: fromMenu(onTogglePin),
                  headerAction: "pin",
                })}
              {onToggleZoom &&
                menuItem({
                  key: "zoom",
                  icon: isZoomed ? <Minimize size={12} /> : <Expand size={12} />,
                  text: isZoomed ? "Restore grid" : "Zoom",
                  shortcut: showShortcutHints ? comboLabel(modLabel(), "1") : undefined,
                  title: zoomTitle,
                  ariaLabel: zoomLabel,
                  onSelect: fromMenu(onToggleZoom),
                })}
              {showFontZoom && (
                <>
                  <div className="flex items-center gap-1.5 border-t border-maestro-border px-3 pt-1.5 pb-0.5 text-[10px] text-maestro-muted">
                    <ZoomIn size={10} aria-hidden="true" />
                    {`Font zoom: ${zoomLevel}%`}
                  </div>
                  {FONT_ZOOM_PRESETS.map((preset) =>
                    menuItem({
                      key: `font-${preset}`,
                      text: `${preset}%`,
                      shortcut: preset === 100 ? comboLabel(modLabel(), "0") : undefined,
                      title: `Font zoom ${preset}%`,
                      ariaLabel: `Font zoom ${preset}%`,
                      selected: zoomLevel === preset,
                      onSelect: fromMenu(() => handleZoomPreset(preset)),
                    }),
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Park button — hide the pane without stopping the session */}
            {onPark && (
              <button
                type="button"
                onClick={() => onPark()}
                className="rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-accent"
                title={parkTitle}
                aria-label={parkLabel}
              >
                <ParkingSquare size={terminalCount <= 4 ? 14 : 12} />
              </button>
            )}

            {/* Pin toggle — keeps this terminal visible from other projects */}
            {onTogglePin && (
              <button
                type="button"
                onClick={() => onTogglePin()}
                className={`rounded p-0.5 transition-colors hover:bg-maestro-card hover:text-maestro-accent ${
                  isPinned ? "text-maestro-accent" : "text-maestro-muted"
                }`}
                title={pinTitle}
                aria-label={pinLabel}
                data-header-action="pin"
              >
                {isPinned ? (
                  <PinOff size={terminalCount <= 4 ? 14 : 12} />
                ) : (
                  <Pin size={terminalCount <= 4 ? 14 : 12} />
                )}
              </button>
            )}

            {/* Zoom toggle button */}
            {onToggleZoom && (
              <button
                type="button"
                onClick={() => onToggleZoom()}
                className="rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-accent"
                title={zoomTitle}
                aria-label={zoomLabel}
              >
                {isZoomed ? (
                  <Minimize size={terminalCount <= 4 ? 14 : 12} />
                ) : (
                  <Expand size={terminalCount <= 4 ? 14 : 12} />
                )}
              </button>
            )}

            {/* Font zoom indicator + dropdown (hidden at 100%) */}
            {showFontZoom && (
              <div className="relative" ref={zoomMenuRef}>
                <button
                  type="button"
                  onClick={() => setShowZoomMenu((v) => !v)}
                  className="flex items-center gap-0.5 rounded px-1 py-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-accent"
                  title={`Font zoom: ${zoomLevel}%`}
                  aria-label={`Font zoom: ${zoomLevel}%`}
                >
                  <ZoomIn size={terminalCount <= 4 ? 12 : 10} />
                  <span className={`${adaptive.badgeSize} font-medium`}>{zoomLevel}%</span>
                </button>
                {showZoomMenu && (
                  <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] rounded-lg border border-maestro-border bg-maestro-surface shadow-lg">
                    {FONT_ZOOM_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => handleZoomPreset(preset)}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-maestro-card ${
                          zoomLevel === preset
                            ? "font-semibold text-maestro-accent"
                            : "text-maestro-text"
                        }`}
                      >
                        <span>{preset}%</span>
                        <span className="text-[10px] text-maestro-muted">
                          {preset === 100 ? comboLabel(modLabel(), "0") : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Close button */}
        <button
          type="button"
          onClick={() => onKill(sessionId)}
          className="rounded p-0.5 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-red"
          title={hint("Kill session — stop this terminal", altLabel(), "W")}
          aria-label={`Kill session ${sessionId}`}
          data-header-action="close"
        >
          <X size={terminalCount <= 4 ? 11 : 9} />
        </button>
      </div>
    </div>
  );
});
