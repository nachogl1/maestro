import { DialogToggle } from "@/components/shared/DialogShell";

interface PrivacySwitchRowProps {
  name: string;
  /** One line on what the feature sends, and where. */
  what: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}

/** One privacy switch: the feature's name, what it sends, and its toggle. */
export function PrivacySwitchRow({ name, what, checked, onChange }: PrivacySwitchRowProps) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-maestro-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-maestro-text">{name}</div>
        <p className="mt-0.5 text-[11px] text-maestro-muted">{what}</p>
      </div>
      <DialogToggle checked={checked} onChange={onChange} aria-label={name} />
    </div>
  );
}
