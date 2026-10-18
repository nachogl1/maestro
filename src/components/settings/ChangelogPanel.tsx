import { dialogCardClass } from "@/components/shared/DialogShell";
import { CHANGELOG } from "@/lib/changelog";

export function ChangelogPanel() {
  return (
    <>
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
    </>
  );
}
