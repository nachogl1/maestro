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

/** Text colours: mid tones that read on the dark theme (and hold on the light one). */
export const WORK_JOURNAL_TEXT_COLORS: WorkJournalSwatch[] = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Yellow", value: "#eab308" },
  { name: "Green", value: "#22c55e" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Purple", value: "#a855f7" },
  { name: "Pink", value: "#ec4899" },
  { name: "Grey", value: "#9ca3af" },
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

/** Adds `https://` to a bare address such as `example.com`; keeps any given scheme. */
function normalizeLinkHref(raw: string): string {
  const href = raw.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
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
      color: (e.getAttributes("textStyle").color as string | undefined) ?? null,
      backgroundColor: (e.getAttributes("textStyle").backgroundColor as string | undefined) ?? null,
    }),
  });

  const [row, setRow] = useState<WorkJournalToolbarRow | null>(null);
  const [linkDraft, setLinkDraft] = useState("");

  const toggleRow = (next: WorkJournalToolbarRow): void => {
    if (next === "link") {
      setLinkDraft((editor.getAttributes("link").href as string | undefined) ?? "");
    }
    setRow((prev) => (prev === next ? null : next));
  };

  const applyLink = (): void => {
    const href = linkDraft.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href) chain.setLink({ href: normalizeLinkHref(href) }).run();
    else chain.unsetLink().run();
    setRow(null);
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
      setRow(null);
      editor.commands.focus();
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
        <ToolButton label="Text colour" active={row === "color"} onClick={() => toggleRow("color")}>
          <Baseline size={14} style={state.color ? { color: state.color } : undefined} />
        </ToolButton>
        <ToolButton
          label="Highlight"
          active={row === "highlight"}
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
        />
      )}

      {row === "link" && (
        <div className="flex items-center gap-2 px-3 pb-1.5 text-xs text-maestro-muted">
          <input
            type="text"
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={handleLinkKey}
            // biome-ignore lint/a11y/noAutofocus: the row opens on a click to type the address.
            autoFocus
            aria-label="Link address"
            placeholder="https://…"
            className="min-w-0 flex-1 rounded border border-maestro-border bg-maestro-card px-1.5 py-0.5 text-xs text-maestro-text outline-none focus:border-maestro-accent"
          />
          <button type="button" onClick={applyLink} className={ROW_BUTTON}>
            Apply
          </button>
          {state.link && (
            <button type="button" onClick={removeLink} className={ROW_BUTTON}>
              Remove link
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ToolButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** An icon button that keeps the editor's selection (no focus steal on press). */
function ToolButton({ label, active, onClick, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
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
}

/** A row of colour swatches plus "None", applied to the current selection. */
function SwatchRow({ kind, swatches, current, renderSwatch, onPick }: SwatchRowProps) {
  return (
    <fieldset
      aria-label={`${kind} options`}
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
        title="None"
        className="rounded border border-maestro-border px-1.5 py-0.5 text-xs text-maestro-muted transition-colors hover:border-maestro-text hover:text-maestro-text"
      >
        None
      </button>
    </fieldset>
  );
}
