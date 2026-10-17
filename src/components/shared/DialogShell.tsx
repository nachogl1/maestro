import { X } from "lucide-react";
import { type ReactNode, type RefObject, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDismissable } from "@/hooks/useDismissable";

/**
 * The one look for every dialog opened from the Settings tab (Maestro, Terminal
 * and CLI settings, Shortcuts, Changelog): the same backdrop, panel, header,
 * scrollable body and optional footer, with the maestro-* palette so dark and
 * light themes both apply.
 *
 * Rendered in a portal on `document.body` at `z-[100]`, above the terminals
 * and the project tab bar (which sit at z-50).
 */

/** Panel widths. */
export type DialogSize = "sm" | "md" | "lg";

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
};

export interface DialogShellProps {
  title: string;
  /** Small icon shown before the title. */
  icon?: ReactNode;
  /** One muted line under the title. */
  subtitle?: ReactNode;
  onClose: () => void;
  size?: DialogSize;
  /** Close when the user clicks outside the panel. Default true. */
  closeOnOutsideClick?: boolean;
  /** Close on the Escape key. Default true. */
  closeOnEscape?: boolean;
  /** The scrollable body element, for callers that scroll a section into view. */
  bodyRef?: RefObject<HTMLDivElement>;
  /** Content pinned under the body, outside the scroll area. */
  footer?: ReactNode;
  children: ReactNode;
}

export function DialogShell({
  title,
  icon,
  subtitle,
  onClose,
  size = "md",
  closeOnOutsideClick = true,
  closeOnEscape = true,
  bodyRef,
  footer,
  children,
}: DialogShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useDismissable(onClose, {
    ref: closeOnOutsideClick ? panelRef : undefined,
    escape: closeOnEscape,
  });

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border border-maestro-border bg-maestro-surface shadow-2xl ${SIZE_CLASS[size]}`}
      >
        <div className="flex items-center gap-2.5 border-b border-maestro-border px-4 py-3">
          {icon && <span className="flex shrink-0 text-maestro-accent">{icon}</span>}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-sm font-semibold text-maestro-text">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-[11px] text-maestro-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-border/40 hover:text-maestro-text"
          >
            <X size={16} />
          </button>
        </div>

        <div ref={bodyRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {children}
        </div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-maestro-border px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ── Content primitives ── */

/** The card every dialog section sits in. */
export const dialogCardClass = "rounded-lg border border-maestro-border/60 bg-maestro-card p-3";

/** Section heading typography, shared with collapsible section headers. */
export const dialogSectionHeadingClass =
  "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted";

export interface DialogSectionProps {
  title: string;
  /** Small icon before the heading. */
  icon?: ReactNode;
  /** Hover help on the heading. */
  hint?: string;
  /** One muted sentence under the heading. */
  description?: ReactNode;
  /** Controls at the right end of the heading row. */
  right?: ReactNode;
  children: ReactNode;
}

/** A section card: heading row (icon, title, optional hint and controls), then its rows. */
export function DialogSection({
  title,
  icon,
  hint,
  description,
  right,
  children,
}: DialogSectionProps) {
  return (
    <section className={dialogCardClass}>
      <div className={`mb-2 ${dialogSectionHeadingClass}`}>
        {icon && <span className="flex shrink-0 text-maestro-accent">{icon}</span>}
        <span className={`flex-1 ${hint ? "cursor-help" : ""}`} title={hint}>
          {title}
        </span>
        {right}
      </div>
      {description && <p className="mb-2 text-[11px] text-maestro-muted">{description}</p>}
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

export interface DialogRowProps {
  label: ReactNode;
  /** Hover help for the whole row. */
  hint?: string;
  /** Renders the label as a `<label>` for this control id. */
  htmlFor?: string;
  children: ReactNode;
}

/** One label + control row: the label fills the left, the control hugs the right. */
export function DialogRow({ label, hint, htmlFor, children }: DialogRowProps) {
  const labelClass = `min-w-0 flex-1 text-maestro-text ${hint ? "cursor-help" : ""}`;
  return (
    <div className="flex min-h-7 items-center gap-3 text-xs" title={hint}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelClass}>
          {label}
        </label>
      ) : (
        <span className={labelClass}>{label}</span>
      )}
      {children}
    </div>
  );
}

export interface DialogToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  "aria-label": string;
}

/** The same switch the sidebar settings cards use. */
export function DialogToggle({ checked, onChange, "aria-label": ariaLabel }: DialogToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
        checked ? "bg-maestro-accent" : "bg-maestro-border"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
          checked ? "left-3.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** Text, number and select controls inside a dialog. */
export const dialogInputClass =
  "rounded border border-maestro-border bg-maestro-bg px-2 py-1 text-[11px] text-maestro-text " +
  "placeholder-maestro-muted/50 outline-none focus:border-maestro-accent disabled:opacity-50";

export type DialogButtonVariant = "primary" | "ghost" | "accent" | "danger";

const BUTTON_VARIANT_CLASS: Record<DialogButtonVariant, string> = {
  primary:
    "border border-maestro-accent/50 bg-maestro-accent/10 px-3 py-1 font-medium text-maestro-accent " +
    "hover:bg-maestro-accent/20",
  ghost:
    "px-2 py-1 font-medium text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text",
  accent: "px-2 py-1 text-maestro-accent hover:bg-maestro-border/40",
  danger: "px-2 py-1 text-maestro-red hover:bg-maestro-border/40",
};

/** Button classes: `primary` for the main action, `ghost` for quiet ones, `danger` for removals. */
export function dialogButtonClass(variant: DialogButtonVariant = "ghost"): string {
  return `inline-flex shrink-0 items-center gap-1 rounded text-[11px] transition-colors disabled:opacity-50 ${BUTTON_VARIANT_CLASS[variant]}`;
}
