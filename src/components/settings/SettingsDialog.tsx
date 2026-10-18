import {
  ArrowDownCircle,
  Bell,
  BookOpen,
  Keyboard,
  Monitor,
  Palette,
  ScrollText,
  Settings,
  Swords,
  Zap,
} from "lucide-react";
import { type ElementType, type ReactNode, useEffect, useRef, useState } from "react";
import { DialogShell } from "@/components/shared/DialogShell";
import { ContextAlertSection } from "@/components/sidebar/ContextAlertSection";
import { NotificationsSettingsSection } from "@/components/sidebar/NotificationsSettingsSection";
import { CliSettingsPanel } from "@/components/terminal/CliSettingsPanel";
import { TerminalSettingsPanel } from "@/components/terminal/TerminalSettingsPanel";
import { AppearanceSettingsPanel, type Theme } from "./AppearanceSettingsPanel";
import { ChangelogPanel } from "./ChangelogPanel";
import { SamuraiSettingsPanel } from "./SamuraiSettingsPanel";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { UpdatesSettingsPanel } from "./UpdatesSettingsPanel";
import { WorkJournalSettingsSection } from "./WorkJournalSettingsSection";

export type SettingsSectionId =
  | "appearance"
  | "notifications"
  | "updates"
  | "terminal"
  | "ai-cli"
  | "samurai"
  | "work-journal"
  | "shortcuts"
  | "changelog";

interface SettingsDialogProps {
  onClose: () => void;
  /** The section shown on open; Appearance otherwise. */
  initialSection?: SettingsSectionId;
  theme?: Theme;
  onToggleTheme?: () => void;
}

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: ElementType;
  /** One line under the dialog title while the section is open. */
  description: string;
}

interface SettingsSectionGroup {
  title: string;
  sections: SettingsSection[];
}

const SECTION_GROUPS: SettingsSectionGroup[] = [
  {
    title: "General",
    sections: [
      {
        id: "appearance",
        label: "Appearance",
        icon: Palette,
        description: "How Maestro looks.",
      },
      {
        id: "notifications",
        label: "Notifications",
        icon: Bell,
        description: "Pop-up notifications and the context alert on Claude terminals.",
      },
      {
        id: "updates",
        label: "Updates",
        icon: ArrowDownCircle,
        description: "Maestro's version, updates and the maestro terminal command.",
      },
    ],
  },
  {
    title: "Terminals & agents",
    sections: [
      {
        id: "terminal",
        label: "Terminal",
        icon: Monitor,
        description: "Font, size and spacing of every terminal.",
      },
      {
        id: "ai-cli",
        label: "AI command lines",
        icon: Zap,
        description: "Flags Maestro adds when it starts each AI command line.",
      },
      {
        id: "samurai",
        label: "Samurai",
        icon: Swords,
        description: "When the Samurai supervisor hands off, pauses or flags your agents.",
      },
    ],
  },
  {
    title: "Tools",
    sections: [
      {
        id: "work-journal",
        label: "Work Journal",
        icon: BookOpen,
        description: "Suggestions, backups and reports for the Work Journal.",
      },
    ],
  },
  {
    title: "Help",
    sections: [
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        icon: Keyboard,
        description: "Every keyboard shortcut in Maestro.",
      },
      {
        id: "changelog",
        label: "Changelog",
        icon: ScrollText,
        description: "What changed in Maestro, newest first.",
      },
    ],
  },
];

const SECTIONS = SECTION_GROUPS.flatMap((group) => group.sections);

/**
 * The one place for every Maestro setting: a menu of sections on the left and
 * the chosen section's settings on the right.
 */
export function SettingsDialog({
  onClose,
  initialSection = "appearance",
  theme,
  onToggleTheme,
}: SettingsDialogProps) {
  const [activeId, setActiveId] = useState<SettingsSectionId>(initialSection);
  const bodyRef = useRef<HTMLDivElement>(null);
  const active = SECTIONS.find((section) => section.id === activeId) ?? SECTIONS[0];

  // Each section starts at its top, not where the previous one was scrolled to.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on section change only
  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, [activeId]);

  const renderSection = (id: SettingsSectionId): ReactNode => {
    switch (id) {
      case "appearance":
        return <AppearanceSettingsPanel theme={theme} onToggleTheme={onToggleTheme} />;
      case "notifications":
        return (
          <>
            <NotificationsSettingsSection />
            <ContextAlertSection />
          </>
        );
      case "updates":
        return <UpdatesSettingsPanel />;
      case "terminal":
        return <TerminalSettingsPanel />;
      case "ai-cli":
        return <CliSettingsPanel />;
      case "samurai":
        return <SamuraiSettingsPanel />;
      case "work-journal":
        return <WorkJournalSettingsSection />;
      case "shortcuts":
        return <ShortcutsPanel />;
      case "changelog":
        return <ChangelogPanel />;
    }
  };

  return (
    <DialogShell
      title="Settings"
      subtitle={active.description}
      icon={<Settings size={16} />}
      size="xl"
      onClose={onClose}
      bodyRef={bodyRef}
      nav={
        <nav
          aria-label="Settings sections"
          className="w-48 shrink-0 space-y-3 overflow-y-auto border-r border-maestro-border bg-maestro-bg/40 p-2"
        >
          {SECTION_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted">
                {group.title}
              </div>
              {group.sections.map(({ id, label, icon: Icon }) => {
                const selected = id === active.id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveId(id)}
                    aria-current={selected ? "page" : undefined}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                      selected
                        ? "bg-maestro-accent/15 font-medium text-maestro-text"
                        : "text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
                    }`}
                  >
                    <Icon
                      size={14}
                      className={`shrink-0 ${selected ? "text-maestro-accent" : ""}`}
                    />
                    {label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      }
    >
      <section aria-label={active.label} className="space-y-3">
        {renderSection(active.id)}
      </section>
    </DialogShell>
  );
}
