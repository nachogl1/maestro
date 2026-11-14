import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFeatureSettingsStore } from "@/stores/useFeatureSettingsStore";
import {
  PANEL_MAX_WIDTH,
  type PanelId,
  panelWidthOf,
  usePanelStripStore,
} from "@/stores/usePanelStripStore";
import {
  useWorkJournalEnabled,
  useWorkJournalSettingsLoaded,
} from "@/stores/useWorkJournalSettingsStore";
import { GitPanelHeaderExtra } from "./GitPanel";
import { IconStrip } from "./IconStrip";
import { PanelBody, type PanelContentProps } from "./PanelBody";
import { PanelFrame } from "./PanelFrame";
import { panelRoom, togglePanelInWindow } from "./panelLayout";
import { PANELS, panelDefinition } from "./panels";

/** How long the refusal / auto-close message stays on screen. */
const MESSAGE_DURATION_MS = 3000;
/** Matches the length of the `panel-icon-shake` animation. */
const SHAKE_DURATION_MS = 400;

/** Panels Settings → Features can switch off; the rest always show. */
function useEnabledPanels(): ReadonlySet<PanelId> {
  const secondBrain = useFeatureSettingsStore((s) => s.secondBrainEnabled);
  const workJournal = useWorkJournalEnabled();
  return useMemo(() => {
    const disabled = new Set<PanelId>();
    if (!secondBrain) disabled.add("secondbrain");
    if (!workJournal) disabled.add("workjournal");
    return new Set(PANELS.map((p) => p.id).filter((id) => !disabled.has(id)));
  }, [secondBrain, workJournal]);
}

function titlesOf(ids: readonly PanelId[]): string {
  return ids.map((id) => panelDefinition(id).title).join(", ");
}

/**
 * The icon strip on the far left and the panels it opens, side by side in strip
 * order (PRD §4.4). The terminals always keep at least TERMINALS_MIN_WIDTH.
 */
export function LeftPanels({ content }: { content: PanelContentProps }) {
  const openPanels = usePanelStripStore((s) => s.openPanels);
  const widths = usePanelStripStore((s) => s.widths);
  const refusal = usePanelStripStore((s) => s.refusal);
  const closePanel = usePanelStripStore((s) => s.closePanel);
  const setPanelWidth = usePanelStripStore((s) => s.setPanelWidth);
  const enabled = useEnabledPanels();
  const workJournalLoaded = useWorkJournalSettingsLoaded();
  const [message, setMessage] = useState<string | null>(null);
  const [shakingId, setShakingId] = useState<PanelId | null>(null);
  const [room, setRoom] = useState(panelRoom);
  const messageTimer = useRef<ReturnType<typeof setTimeout>>();

  const showMessage = useCallback((text: string) => {
    setMessage(text);
    clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(null), MESSAGE_DURATION_MS);
  }, []);
  useEffect(() => () => clearTimeout(messageTimer.current), []);

  // A refused panel (from a click or a shortcut) shakes its icon and says why.
  useEffect(() => {
    if (!refusal) return;
    setShakingId(refusal.id);
    showMessage(
      `No room for ${panelDefinition(refusal.id).title}. Close a panel or make one narrower.`,
    );
    const timer = setTimeout(() => setShakingId(null), SHAKE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [refusal, showMessage]);

  // A narrower window (or restored panels wider than this one) closes the most
  // recently opened panels first.
  useEffect(() => {
    const fitPanels = () => {
      const nextRoom = panelRoom();
      setRoom(nextRoom);
      const closed = usePanelStripStore.getState().closeToFit(nextRoom);
      if (closed.length > 0) showMessage(`Window got narrower: closed ${titlesOf(closed)}.`);
    };
    fitPanels();
    window.addEventListener("resize", fitPanels);
    return () => window.removeEventListener("resize", fitPanels);
  }, [showMessage]);

  // A panel switched off in Settings → Features loses its icon and closes. The
  // Work Journal's choice loads from disk after start-up: until it has, a Work
  // Journal panel restored as open stays open (it shows once the choice is in).
  useEffect(() => {
    for (const id of openPanels) {
      if (id === "workjournal" && !workJournalLoaded) continue;
      if (!enabled.has(id)) closePanel(id);
    }
  }, [enabled, openPanels, closePanel, workJournalLoaded]);

  const strip = PANELS.filter((p) => enabled.has(p.id));
  const openWidth = openPanels.reduce((sum, id) => sum + panelWidthOf(widths, id), 0);

  return (
    <>
      <IconStrip
        panels={strip}
        openPanels={openPanels}
        shakingId={shakingId}
        onToggle={togglePanelInWindow}
      />
      {strip.map((definition) => {
        const isOpen = openPanels.includes(definition.id);
        if (!isOpen && !definition.keepMounted) return null;
        const width = panelWidthOf(widths, definition.id);
        return (
          <PanelFrame
            key={definition.id}
            definition={definition}
            width={width}
            maxWidth={Math.min(PANEL_MAX_WIDTH, room - (openWidth - width))}
            hidden={!isOpen}
            onResize={(w) => setPanelWidth(definition.id, w)}
            onClose={() => closePanel(definition.id)}
            headerExtra={
              definition.id === "git" ? <GitPanelHeaderExtra {...content.git} /> : undefined
            }
          >
            <PanelBody id={definition.id} open={isOpen} content={content} />
          </PanelFrame>
        );
      })}
      {message && (
        <output className="pointer-events-none fixed left-1/2 top-12 z-50 -translate-x-1/2 rounded-md border border-maestro-accent bg-maestro-card px-3.5 py-1.5 text-xs text-maestro-text shadow-lg">
          {message}
        </output>
      )}
    </>
  );
}
