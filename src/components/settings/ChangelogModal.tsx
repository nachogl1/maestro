import { ScrollText } from "lucide-react";
import { DialogShell, dialogCardClass } from "@/components/shared/DialogShell";
import { CHANGELOG } from "@/lib/changelog";

interface ChangelogModalProps {
  onClose: () => void;
}

export function ChangelogModal({ onClose }: ChangelogModalProps) {
  return (
    <DialogShell
      title="Changelog"
      subtitle="What changed in Maestro, newest first."
      icon={<ScrollText size={16} />}
      size="lg"
      onClose={onClose}
    >
      {CHANGELOG.map((entry) => (
        <section key={`${entry.date}-${entry.title}`} className={dialogCardClass}>
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="font-mono text-[11px] text-maestro-muted">{entry.date}</span>
            <span className="text-xs font-semibold text-maestro-text">{entry.title}</span>
          </div>
          <ul className="list-disc space-y-1 pl-5">
            {entry.items.map((item) => (
              <li key={item} className="text-xs text-maestro-text">
                {item}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </DialogShell>
  );
}
