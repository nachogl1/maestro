import { altLabel, modLabel, titleWithShortcut } from "@/lib/shortcuts";
import type { PanelId } from "@/stores/usePanelStripStore";
import type { PanelDefinition } from "./panels";

/** "History (Alt+1)" for a panel with a shortcut, else the bare action. */
export function shortcutTitle(action: string, definition: PanelDefinition): string {
  const { shortcut } = definition;
  if (!shortcut) return action;
  return titleWithShortcut(
    action,
    shortcut.modifier === "alt" ? altLabel() : modLabel(),
    shortcut.digit,
  );
}

/** For icons whose name is just their title. */
function useNoExtraLabel(): string | undefined {
  return undefined;
}

function StripIcon({
  definition,
  open,
  shaking,
  onClick,
}: {
  definition: PanelDefinition;
  open: boolean;
  shaking: boolean;
  onClick: () => void;
}) {
  // A definition is fixed for the icon's lifetime, so the hook choice never changes.
  const useLabel = definition.useLabel ?? useNoExtraLabel;
  const label = useLabel() ?? definition.title;
  const { icon: Icon, Badge } = definition;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={open}
      data-shaking={shaking || undefined}
      title={shortcutTitle(definition.title, definition)}
      className={`relative flex h-8 w-[34px] items-center justify-center rounded-md transition-colors ${
        open
          ? "text-maestro-accent hover:bg-maestro-accent/10"
          : "text-maestro-muted hover:bg-maestro-card hover:text-maestro-text"
      } ${shaking ? "animate-panel-icon-shake" : ""}`}
    >
      {open && (
        <span
          data-testid="open-marker"
          className="absolute -left-[5px] bottom-1.5 top-1.5 w-0.5 rounded-sm bg-maestro-accent"
        />
      )}
      <Icon size={15} />
      {Badge && <Badge />}
    </button>
  );
}

interface IconStripProps {
  panels: readonly PanelDefinition[];
  openPanels: readonly PanelId[];
  shakingId: PanelId | null;
  onToggle: (id: PanelId) => void;
}

/** The thin column of panel icons on the far left; open panels' icons are marked red. */
export function IconStrip({ panels, openPanels, shakingId, onToggle }: IconStripProps) {
  return (
    <nav
      aria-label="Panels"
      className="no-select flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-maestro-border bg-maestro-surface py-1.5"
    >
      {panels.map((definition, index) => (
        <div key={definition.id} className="flex flex-col items-center">
          {index > 0 && panels[index - 1].group !== definition.group && (
            <hr className="my-1.5 h-px w-[22px] border-0 bg-maestro-border" />
          )}
          <StripIcon
            definition={definition}
            open={openPanels.includes(definition.id)}
            shaking={shakingId === definition.id}
            onClick={() => onToggle(definition.id)}
          />
        </div>
      ))}
    </nav>
  );
}
