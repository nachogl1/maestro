import {
  BookOpenCheck,
  BrainCircuit,
  GitFork,
  Hammer,
  History,
  type LucideIcon,
  Package,
  Rocket,
  Settings,
  StickyNote,
  Syringe,
} from "lucide-react";
import type { ComponentType } from "react";
import { useWorkJournalButtonLabel } from "@/components/shared/WorkJournalSuggestionsBadge";
import type { PanelId } from "@/stores/usePanelStripStore";
import { SecondBrainBadge, WorkJournalBadge } from "./panelBadges";

/** A keyboard shortcut that toggles a panel: Alt+key or Mod (Ctrl / Cmd)+key. */
export interface PanelShortcut {
  modifier: "alt" | "mod";
  /** The top-row digit pressed with the modifier. */
  digit: string;
}

export interface PanelDefinition {
  id: PanelId;
  title: string;
  icon: LucideIcon;
  /** Icons sit in groups divided by a thin line in the strip. */
  group: number;
  shortcut?: PanelShortcut;
  /** A count or dot drawn on the icon. */
  Badge?: ComponentType;
  /** The icon's accessible name when it says more than the title (a hook). */
  useLabel?: () => string;
  /** Kept mounted (hidden) while closed so its state survives closing. */
  keepMounted?: boolean;
}

/**
 * The icon strip, top to bottom (PRD §4.4, prototype `docs/ux/prototypes/left-panels/`).
 * Open panels always sit side by side in this order.
 */
export const PANELS: readonly PanelDefinition[] = [
  {
    id: "history",
    title: "History",
    icon: History,
    group: 0,
    shortcut: { modifier: "alt", digit: "1" },
  },
  {
    id: "git",
    title: "Git",
    icon: GitFork,
    group: 0,
    shortcut: { modifier: "mod", digit: "2" },
    keepMounted: true,
  },
  {
    id: "notes",
    title: "Notes",
    icon: StickyNote,
    group: 1,
    shortcut: { modifier: "mod", digit: "5" },
  },
  {
    id: "workjournal",
    title: "Work Journal",
    icon: BookOpenCheck,
    group: 1,
    Badge: WorkJournalBadge,
    useLabel: useWorkJournalButtonLabel,
  },
  {
    id: "inject",
    title: "Injector",
    icon: Syringe,
    group: 1,
    shortcut: { modifier: "alt", digit: "4" },
  },
  { id: "launch", title: "Launch", icon: Rocket, group: 1 },
  {
    id: "secondbrain",
    title: "Second Brain",
    icon: BrainCircuit,
    group: 1,
    Badge: SecondBrainBadge,
  },
  { id: "workshop", title: "Workshop", icon: Hammer, group: 1 },
  {
    id: "infra",
    title: "Infra",
    icon: Package,
    group: 2,
    shortcut: { modifier: "alt", digit: "2" },
  },
  {
    id: "settings",
    title: "Settings",
    icon: Settings,
    group: 2,
    shortcut: { modifier: "alt", digit: "3" },
  },
];

export function panelDefinition(id: PanelId): PanelDefinition {
  const definition = PANELS.find((p) => p.id === id);
  if (!definition) throw new Error(`Unknown panel: ${id}`);
  return definition;
}

/** The panel a shortcut toggles, or undefined when the combination names none. */
export function panelForShortcut(
  modifier: PanelShortcut["modifier"],
  digit: string,
): PanelId | undefined {
  return PANELS.find((p) => p.shortcut?.modifier === modifier && p.shortcut.digit === digit)?.id;
}
