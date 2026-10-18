import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useMemo } from "react";
import type { MarkdownStorage } from "tiptap-markdown";
import { Markdown } from "tiptap-markdown";
import { NotesListKeymap } from "./notesListKeymap";

interface NotesEditorProps {
  /**
   * Markdown loaded when the editor mounts. The parent remounts the editor
   * per note (React key), so this is deliberately not a controlled value —
   * the editor owns the text while it is mounted.
   */
  initialContent: string;
  /** Fires with the serialized markdown on every edit. */
  onChange: (markdown: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Detects markdown constructs the configured extension set (StarterKit +
 * Markdown with html:false) cannot represent. Parsing them is destructive —
 * tables collapse to run-together text, images vanish, task-list boxes get
 * escaped, raw HTML is entity-escaped — and the first keystroke would persist
 * that mangled version over the note. Code fences/spans are stripped before
 * scanning because TipTap keeps their text verbatim.
 */
function hasUnsupportedMarkdown(markdown: string): boolean {
  const withoutCode = markdown.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "");
  return (
    // GFM table delimiter row, e.g. `| --- | :-: |`
    /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/m.test(withoutCode) ||
    // Image
    /!\[[^\]]*\]\(/.test(withoutCode) ||
    // Task-list item
    /^\s*[-*+]\s+\[[ xX]\]\s/m.test(withoutCode) ||
    // Footnote definition or reference
    /^\[\^[^\]]+\]:/m.test(withoutCode) ||
    /\[\^[^\]]+\]/.test(withoutCode) ||
    // Raw HTML tag
    /<\/?[a-zA-Z][^>\n]*>/.test(withoutCode)
  );
}

/**
 * In-place WYSIWYG markdown editor for the Notes panel: what you type is
 * formatted where you type it — no separate preview pane. Markdown stays the
 * storage format (tiptap-markdown parses it on load and serializes it back on
 * every change).
 *
 * Notes containing markdown the rich editor cannot round-trip losslessly
 * (tables, images, task lists, footnotes, raw HTML) are edited as plain
 * markdown instead, so their content is never silently rewritten.
 *
 * Markdown input rules work live: `# `, `- `, `1. `, `> `, `**bold**`,
 * `` `code` ``, ``` for code blocks, `---` for a rule, etc.
 */
export function NotesEditor(props: NotesEditorProps) {
  const unsupported = useMemo(
    () => hasUnsupportedMarkdown(props.initialContent),
    [props.initialContent],
  );
  return unsupported ? <PlainMarkdownFallback {...props} /> : <RichNotesEditor {...props} />;
}

function RichNotesEditor({
  initialContent,
  onChange,
  placeholder = "",
  className = "",
}: NotesEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        html: false,
        linkify: true,
        // Serialize soft line breaks as real breaks so plain jotted lines
        // don't collapse into one paragraph on reload.
        breaks: true,
      }),
      NotesListKeymap,
    ],
    content: initialContent,
    onUpdate: ({ editor }) => {
      // tiptap-markdown's typings don't augment TipTap v3's Storage type, so
      // the markdown storage has to be asserted explicitly.
      const storage = editor.storage as unknown as { markdown: MarkdownStorage };
      onChange(storage.markdown.getMarkdown());
    },
    editorProps: {
      attributes: {
        class: "focus:outline-none",
        "aria-label": "Note content",
      },
    },
  });

  return (
    <EditorContent
      editor={editor}
      className={`notes-editor ${className}`}
      // Clicking the empty area below the last line moves the caret there.
      onClick={() => editor?.chain().focus().run()}
    />
  );
}

/**
 * Verbatim markdown editing for notes the rich editor would corrupt. Same
 * uncontrolled contract as the rich editor: initialContent on mount, raw
 * markdown out through onChange.
 */
function PlainMarkdownFallback({
  initialContent,
  onChange,
  placeholder = "",
  className = "",
}: NotesEditorProps) {
  return (
    <div className={`flex flex-col ${className}`}>
      <p className="mb-1 shrink-0 text-[10px] italic text-maestro-muted">
        This note uses formatting the rich editor can't preserve (table, image, task list, footnote,
        or HTML) — editing as plain markdown.
      </p>
      <textarea
        defaultValue={initialContent}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Note content"
        spellCheck={false}
        className="min-h-0 w-full flex-1 resize-none bg-transparent font-mono text-xs leading-relaxed text-maestro-text focus:outline-none"
      />
    </div>
  );
}
