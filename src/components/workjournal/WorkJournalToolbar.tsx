import { type Editor, useEditorState } from "@tiptap/react";
import {
  Baseline,
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Strikethrough,
  Underline,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useState } from "react";

/** One swatch in the text colour or highlight palette. */
interface WorkJournalSwatch {
  name: string;
  value: string;
}

/**
 * Text colours. Stored as fixed values (not theme-aware), so each one keeps
 * at least 3:1 contrast on both the dark and the light page backgrounds.
 */
export const WORK_JOURNAL_TEXT_COLORS: WorkJournalSwatch[] = [
  { name: "Red", value: "#dc2626" },
  { name: "Orange", value: "#ea580c" },
  { name: "Gold", value: "#a16207" },
  { name: "Green", value: "#16a34a" },
  { name: "Blue", value: "#2563eb" },
  { name: "Purple", value: "#9333ea" },
  { name: "Pink", value: "#db2777" },
  { name: "Grey", value: "#6b7280" },
];

/** Highlights: translucent, so the page's own text colour stays readable on top. */
export const WORK_JOURNAL_HIGHLIGHT_COLORS: WorkJournalSwatch[] = [
  { name: "Yellow", value: "rgba(234, 179, 8, 0.35)" },
  { name: "Orange", value: "rgba(249, 115, 22, 0.35)" },
  { name: "Red", value: "rgba(239, 68, 68, 0.35)" },
  { name: "Green", value: "rgba(34, 197, 94, 0.35)" },
  { name: "Blue", value: "rgba(59, 130, 246, 0.35)" },
  { name: "Purple", value: "rgba(168, 85, 247, 0.35)" },
  { name: "Grey", value: "rgba(156, 163, 175, 0.35)" },
];

/** Which option row is open under the toolbar, if any. */
type WorkJournalToolbarRow = "color" | "highlight" | "link";

const TOOL_BUTTON =
  "rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text";
const TOOL_BUTTON_ACTIVE = "bg-maestro-card text-maestro-accent";
const ROW_BUTTON =
  "rounded bg-maestro-card px-2 py-0.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border";

/**
 * Adds `https://` to an address without a scheme, such as `example.com` or
 * `localhost:3000` (a host and port is not a scheme). Keeps `scheme://…` and
 * `mailto:`.
 */
export function normalizeLinkHref(raw: string): string {
  const href = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(href) || /^mailto:/i.test(href) ? href : `https://${href}`;
}

interface WorkJournalToolbarProps {
  editor: Editor;
}

/**
 * Formatting toolbar above a Work Journal page: bold, italic, underline,
 * strike, headings, bullet, numbered and tick-box lists, links, and text
 * colour and highlight on the selection. No font family or size controls.
 * Colour, highlight and link options open in a row under the buttons.
 */
export function WorkJournalToolbar({ editor }: WorkJournalToolbarProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      taskList: e.isActive("taskList"),
      link: e.isActive("link"),
      // A link needs selected text or an existing link under the cursor;
      // otherwise setLink would only arm a stored mark and nothing shows.
      canLink: !e.state.selection.empty || e.isActive("link"),
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      backgroundColor: (e.getAttributes("textStyle").backgroundColor as string | undefined) ?? null,
    }),
  });

  const [row, setRow] = useState<WorkJournalToolbarRow | null>(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [linkRejected, setLinkRejected] = useState(false);

  const toggleRow = (next: WorkJournalToolbarRow): void => {
    if (next === "link") {
      setLinkDraft((editor.getAttributes("link").href as string | undefined) ?? "");
      setLinkRejected(false);
    }
    setRow((prev) => (prev === next ? null : next));
  };

  const closeRow = (): void => {
    setRow(null);
    editor.commands.focus();
  };

  const canApplyLink = linkDraft.trim() === "" || state.canLink;

  // The box stays open, with the typed address, unless the link was applied.
  const applyLink = (): void => {
    const href = linkDraft.trim();
    if (!href) {
      if (state.link) editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setRow(null);
      return;
    }
    if (!state.canLink) return;
    const applied = editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: normalizeLinkHref(href) })
      .run();
    if (applied) setRow(null);
    else setLinkRejected(true);
  };

  const removeLink = (): void => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setRow(null);
  };

  const handleLinkKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyLink();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeRow();
    }
  };

  const setColor = (value: string | null): void => {
    const chain = editor.chain().focus();
    if (value) chain.setColor(value).run();
    else chain.unsetColor().run();
    setRow(null);
  };

  const setHighlight = (value: string | null): void => {
    const chain = editor.chain().focus();
    if (value) chain.setBackgroundColor(value).run();
    else chain.unsetBackgroundColor().run();
    setRow(null);
  };

  return (
    <div className="shrink-0 border-b border-maestro-border/60">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex flex-wrap items-center gap-0.5 px-2 py-1"
      >
        <ToolButton
          label="Bold"
          active={state.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={14} />
        </ToolButton>
        <ToolButton
          label="Italic"
          active={state.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={14} />
        </ToolButton>
        <ToolButton
          label="Underline"
          active={state.underline}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <Underline size={14} />
        </ToolButton>
        <ToolButton
          label="Strikethrough"
          active={state.strike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough size={14} />
        </ToolButton>
        <ToolDivider />
        <ToolButton
          label="Heading 1"
          active={state.h1}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 size={14} />
        </ToolButton>
        <ToolButton
          label="Heading 2"
          active={state.h2}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 size={14} />
        </ToolButton>
        <ToolButton
          label="Heading 3"
          active={state.h3}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 size={14} />
        </ToolButton>
        <ToolDivider />
        <ToolButton
          label="Bullet list"
          active={state.bulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={14} />
        </ToolButton>
        <ToolButton
          label="Numbered list"
          active={state.orderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={14} />
        </ToolButton>
        <ToolButton
          label="Checklist"
          active={state.taskList}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          <ListChecks size={14} />
        </ToolButton>
        <ToolDivider />
        <ToolButton
          label="Link"
          active={state.link || row === "link"}
          onClick={() => toggleRow("link")}
        >
          <Link size={14} />
        </ToolButton>
        <ToolButton
          label="Text colour"
          active={row === "color"}
          expands
          onClick={() => toggleRow("color")}
        >
          <Baseline size={14} style={state.color ? { color: state.color } : undefined} />
        </ToolButton>
        <ToolButton
          label="Highlight"
          active={row === "highlight"}
          expands
          onClick={() => toggleRow("highlight")}
        >
          <Highlighter
            size={14}
            style={state.backgroundColor ? { backgroundColor: state.backgroundColor } : undefined}
          />
        </ToolButton>
      </div>

      {row === "color" && (
        <SwatchRow
          kind="Text colour"
          swatches={WORK_JOURNAL_TEXT_COLORS}
          current={state.color}
          renderSwatch={(s) => (
            <span className="text-sm font-semibold leading-none" style={{ color: s.value }}>
              A
            </span>
          )}
          onPick={setColor}
          onClose={closeRow}
        />
      )}

      {row === "highlight" && (
        <SwatchRow
          kind="Highlight"
          swatches={WORK_JOURNAL_HIGHLIGHT_COLORS}
          current={state.backgroundColor}
          renderSwatch={(s) => (
            <span className="block h-3.5 w-3.5 rounded-sm" style={{ backgroundColor: s.value }} />
          )}
          onPick={setHighlight}
          onClose={closeRow}
        />
      )}

      {row === "link" && (
        <div className="flex items-center gap-2 px-3 pb-1.5 text-xs text-maestro-muted">
          <input
            type="text"
            value={linkDraft}
            onChange={(e) => {
              setLinkDraft(e.target.value);
              setLinkRejected(false);
            }}
            onKeyDown={handleLinkKey}
            // biome-ignore lint/a11y/noAutofocus: the row opens on a click to type the address.
            autoFocus
            aria-label="Link address"
            placeholder="https://…"
            className="min-w-0 flex-1 rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-xs text-maestro-text outline-none focus:border-maestro-accent"
          />
          <button
            type="button"
            onClick={applyLink}
            disabled={!canApplyLink}
            className={`${ROW_BUTTON} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            Apply
          </button>
          {state.link && (
            <button type="button" onClick={removeLink} className={ROW_BUTTON}>
              Remove link
            </button>
          )}
          {!canApplyLink && <span>Select some text to link.</span>}
          {linkRejected && <span className="text-maestro-red">That address cannot be a link.</span>}
        </div>
      )}
    </div>
  );
}

interface ToolButtonProps {
  label: string;
  active: boolean;
  /** The button opens an option row: `active` is reported as expanded, not pressed. */
  expands?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** An icon button that keeps the editor's selection (no focus steal on press). */
function ToolButton({ label, active, expands = false, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      aria-pressed={expands ? undefined : active}
      aria-expanded={expands ? active : undefined}
      title={label}
      className={`${TOOL_BUTTON} ${active ? TOOL_BUTTON_ACTIVE : ""}`}
    >
      {children}
    </button>
  );
}

function ToolDivider() {
  return <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-maestro-border" />;
}

interface SwatchRowProps {
  kind: string;
  swatches: WorkJournalSwatch[];
  current: string | null;
  renderSwatch: (swatch: WorkJournalSwatch) => ReactNode;
  onPick: (value: string | null) => void;
  /** Escape inside the row closes it. */
  onClose: () => void;
}

/** A row of colour swatches plus "None", applied to the current selection. */
function SwatchRow({ kind, swatches, current, renderSwatch, onPick, onClose }: SwatchRowProps) {
  return (
    <fieldset
      aria-label={`${kind} options`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      className="flex flex-wrap items-center gap-1 px-3 pb-1.5"
    >
      {swatches.map((s) => (
        <button
          key={s.value}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(s.value)}
          aria-label={`${kind} ${s.name}`}
          aria-pressed={current === s.value}
          title={s.name}
          className={`flex h-6 w-6 items-center justify-center rounded border transition-colors hover:border-maestro-text ${
            current === s.value ? "border-maestro-accent" : "border-maestro-border"
          }`}
        >
          {renderSwatch(s)}
        </button>
      ))}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(null)}
        aria-label={`${kind} none`}
        aria-pressed={current === null}
        title="None"
        className="rounded border border-maestro-border px-1.5 py-0.5 text-xs text-maestro-muted transition-colors hover:border-maestro-text hover:text-maestro-text"
      >
        None
      </button>
    </fieldset>
  );
}
