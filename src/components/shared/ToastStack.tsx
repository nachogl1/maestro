import { AlertTriangle, CheckCircle2, GitPullRequest, Info, X } from "lucide-react";
import { useToastStore, type ToastTone } from "@/stores/useToastStore";

const TONE_ICON: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertTriangle,
};

const TONE_COLOR: Record<ToastTone, string> = {
  info: "text-maestro-accent",
  success: "text-maestro-green",
  warning: "text-maestro-orange",
  error: "text-maestro-red",
};

export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-50 flex max-h-[calc(100vh-7rem)] w-80 flex-col gap-2 overflow-y-auto pr-1">
      {toasts.map((t) => {
        const Icon = t.title.toLowerCase().includes("pr ") || t.title.toLowerCase().startsWith("pr")
          ? GitPullRequest
          : TONE_ICON[t.tone];
        const isClickable = !!t.href;
        return (
          <div
            key={t.id}
            className="pointer-events-auto rounded-lg border border-maestro-border bg-maestro-card shadow-[0_4px_24px_rgb(0_0_0/0.4)] animate-in slide-in-from-bottom-4"
          >
            <div className="flex items-start gap-2 px-3 py-2.5">
              <Icon size={14} className={`mt-0.5 shrink-0 ${TONE_COLOR[t.tone]}`} />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={
                    isClickable
                      ? () => {
                          window.open(t.href!, "_blank", "noopener,noreferrer");
                          dismissToast(t.id);
                        }
                      : undefined
                  }
                  disabled={!isClickable}
                  className={`block w-full text-left text-xs font-semibold text-maestro-text ${
                    isClickable ? "hover:underline" : ""
                  }`}
                >
                  {t.title}
                </button>
                {t.body && (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-maestro-muted">
                    {t.body}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="shrink-0 rounded p-0.5 text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
                aria-label="Dismiss"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
