import { X } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useDismissable } from "@/hooks/useDismissable";
import { CHANGELOG } from "@/lib/changelog";

interface ChangelogModalProps {
  onClose: () => void;
}

export function ChangelogModal({ onClose }: ChangelogModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useDismissable(onClose, { ref: modalRef });

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-lg max-h-[80vh] overflow-hidden rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl flex flex-col"
      >
        <div className="flex items-center justify-between border-b border-maestro-border px-4 py-3">
          <h2 className="text-sm font-semibold text-maestro-text">Changelog</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close changelog"
            className="rounded p-1 hover:bg-maestro-border/40"
          >
            <X size={16} className="text-maestro-muted" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {CHANGELOG.map((entry) => (
            <section key={`${entry.date}-${entry.title}`}>
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
        </div>
      </div>
    </div>,
    document.body,
  );
}
