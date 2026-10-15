import { TaskItem, TaskList } from "@tiptap/extension-list";
import { BackgroundColor, Color, TextStyle } from "@tiptap/extension-text-style";
import { Fragment, type Node as PmNode, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { EditorContent, getSchema, type JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef } from "react";
import {
  WORK_JOURNAL_HIGHLIGHT_COLORS,
  WORK_JOURNAL_TEXT_COLORS,
  WorkJournalToolbar,
} from "@/components/workjournal/WorkJournalToolbar";
import {
  registerWorkJournalEditorAppend,
  registerWorkJournalEditorFlush,
  useWorkJournalStore,
} from "@/stores/useWorkJournalStore";

/** How long typing must pause before the page body is saved. */
export const WORK_JOURNAL_SAVE_DEBOUNCE_MS = 400;

/** The editor's extension set; the body guard checks pages against the same schema. */
const WORK_JOURNAL_EXTENSIONS = [
  StarterKit.configure({
    // A click must never navigate the app window; links are edited here.
    link: { openOnClick: false },
  }),
  // Text colour and highlight live on the textStyle mark; no font controls.
  TextStyle,
  Color,
  BackgroundColor,
  TaskList,
  TaskItem.configure({ nested: true }),
];

const WORK_JOURNAL_SCHEMA = getSchema(WORK_JOURNAL_EXTENSIONS);

/** A CSS value without spaces or case, so `rgba(1, 2, 3)` matches `RGBA(1,2,3)`. */
function cssValueKey(value: string): string {
  return value
    .replace(/!important/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

const PALETTE_TEXT_COLORS = new Set(WORK_JOURNAL_TEXT_COLORS.map((c) => cssValueKey(c.value)));
const PALETTE_HIGHLIGHTS = new Set(WORK_JOURNAL_HIGHLIGHT_COLORS.map((c) => cssValueKey(c.value)));

/**
 * Drops pasted or dropped text and background colours that are not the
 * toolbar's own: text copied from a web page or document carries inline
 * colours (often near-black text or a white box) that would be stored for
 * good. Palette colours stay, so copying between Work Journal pages keeps
 * them. The style text is edited as written, not re-serialised, because the
 * colour extensions read the value exactly as written.
 */
export function stripForeignPastedColors(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of Array.from(doc.body.querySelectorAll("[style]"))) {
    const kept = (el.getAttribute("style") ?? "").split(";").filter((decl) => {
      const colon = decl.indexOf(":");
      if (colon === -1) return false;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = cssValueKey(decl.slice(colon + 1));
      if (prop === "color") return PALETTE_TEXT_COLORS.has(value);
      if (prop === "background-color") return PALETTE_HIGHLIGHTS.has(value);
      // The shorthand also sets a background colour; the toolbar never writes it.
      return prop !== "background";
    });
    if (kept.length > 0) el.setAttribute("style", kept.join(";"));
    else el.removeAttribute("style");
  }
  return doc.body.innerHTML;
}

/**
 * Removes `textStyle` marks left with no value: any pasted span with a style
 * (say `font-weight`) becomes one, with empty colour attributes once the
 * colours are stripped.
 */
function dropEmptyTextStyles(fragment: Fragment): Fragment {
  const nodes: PmNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const marks = node.marks.filter(
        (m) =>
          m.type.name !== "textStyle" || Object.values(m.attrs).some((v) => v != null && v !== ""),
      );
      nodes.push(node.mark(marks));
    } else {
      nodes.push(node.copy(dropEmptyTextStyles(node.content)));
    }
  });
  return Fragment.from(nodes);
}

/**
 * Whether this build's editor can load `body` exactly. TipTap silently swaps
 * a body it cannot parse (for example marks a newer build added) for an empty
 * document, and the first keystroke would then save that over the stored page.
 */
export function canReadWorkJournalBody(body: JSONContent): boolean {
  try {
    WORK_JOURNAL_SCHEMA.nodeFromJSON(body).check();
    return true;
  } catch {
    return false;
  }
}

interface WorkJournalEditorProps {
  /** The page being edited. The parent remounts the editor per date (React key). */
  date: string;
  /**
   * The page body loaded when the editor mounts. Not a controlled value: the
   * editor owns the text while it is mounted.
   */
  initialBody: JSONContent;
  className?: string;
}

/**
 * Rich-text editor for one Work Journal page: TipTap with its own setup (not
 * the Notes markdown pipeline). Bold, italic, underline, headings, bullet,
 * numbered and tick-box lists, links, and text colour and highlight, through
 * the toolbar above the page, keyboard shortcuts and markdown-style input
 * rules. The body is saved as TipTap JSON (`editor.getJSON()`) after a
 * short pause in typing, and any unsaved change is flushed when the date
 * changes, the editor closes or the window is closed.
 *
 * A body this build cannot read is shown read-only and never saved, so the
 * stored page is not overwritten.
 */
export function WorkJournalEditor(props: WorkJournalEditorProps) {
  const readable = useMemo(() => canReadWorkJournalBody(props.initialBody), [props.initialBody]);
  return readable ? <RichWorkJournalEditor {...props} /> : <UnreadableBody {...props} />;
}

function RichWorkJournalEditor({ date, initialBody, className = "" }: WorkJournalEditorProps) {
  const pendingRef = useRef<JSONContent | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dateRef = useRef(date);
  // The journal revision this editor was mounted for; see `revision`.
  const revisionRef = useRef(useWorkJournalStore.getState().revision);

  // Sends unsaved text now; resolves true once the backend saved it.
  const saveNow = (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const body = pendingRef.current;
    if (!body) return Promise.resolve(false);
    pendingRef.current = null;
    // The journal was replaced (restore or undo) since this editor mounted:
    // its text belongs to the old journal and must not be saved over the new.
    if (useWorkJournalStore.getState().revision !== revisionRef.current) {
      return Promise.resolve(false);
    }
    return useWorkJournalStore.getState().updatePage(dateRef.current, { body });
  };
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;
  const flush = (): void => {
    void saveNowRef.current();
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const editor = useEditor({
    extensions: WORK_JOURNAL_EXTENSIONS,
    content: initialBody,
    onUpdate: ({ editor }) => {
      pendingRef.current = editor.getJSON();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => flushRef.current(), WORK_JOURNAL_SAVE_DEBOUNCE_MS);
    },
    editorProps: {
      // Also runs for HTML dropped onto the page.
      transformPastedHTML: stripForeignPastedColors,
      transformPasted: (slice) =>
        new Slice(dropEmptyTextStyles(slice.content), slice.openStart, slice.openEnd),
      attributes: {
        class: "focus:outline-none",
        "aria-label": "Work Journal page",
      },
    },
  });

  // Flush the previous date's unsaved text before switching, and on unmount.
  useEffect(() => {
    dateRef.current = date;
    return () => flushRef.current();
  }, [date]);

  // A restore sends unsaved text through this before it replaces the journal.
  useEffect(() => registerWorkJournalEditorFlush(() => flushRef.current()), []);

  // An accepted suggestion lands here: a new paragraph at the end of the
  // body, saved right away. A trailing empty paragraph (a fresh page's only
  // line, or an empty last line) is filled instead of leaving a blank line.
  // When the save fails, the line is taken back out, so a retry cannot add
  // a second copy.
  useEffect(() => {
    if (!editor) return;
    return registerWorkJournalEditorAppend(date, async (line) => {
      const { replacing, revision } = useWorkJournalStore.getState();
      if (editor.isDestroyed || !editor.isEditable || replacing) return "refused";
      if (revision !== revisionRef.current) return "refused";
      const doc = editor.state.doc;
      const last = doc.lastChild;
      const fill = last?.type.name === "paragraph" && last.content.size === 0;
      const end = doc.content.size;
      // Where the line's paragraph starts, kept current while the save runs.
      let start = fill && last ? end - last.nodeSize : end;
      const paragraph = { type: "paragraph", content: [{ type: "text", text: line }] };
      const at = fill ? { from: start, to: end } : end;
      const inserted = editor
        .chain()
        .insertContentAt(at, paragraph, { updateSelection: false })
        .run();
      if (!inserted) return "refused";
      const track = ({ transaction }: { transaction: Transaction }): void => {
        start = transaction.mapping.map(start, 1);
      };
      editor.on("transaction", track);
      let saved: boolean;
      try {
        saved = await saveNowRef.current();
      } finally {
        editor.off("transaction", track);
      }
      if (saved) return "saved";
      if (!editor.isDestroyed) {
        const node = editor.state.doc.nodeAt(start);
        // Left alone if the user already edited the line meanwhile.
        if (node?.type.name === "paragraph" && node.textContent === line) {
          const range = { from: start, to: start + node.nodeSize };
          const tr = editor.state.tr;
          if (fill) tr.replaceWith(range.from, range.to, editor.schema.nodes.paragraph.create());
          else tr.delete(range.from, range.to);
          editor.view.dispatch(tr);
          // Puts the page without the line in the store (and on disk) now.
          void saveNowRef.current();
        }
      }
      return "save_failed";
    });
  }, [editor, date]);

  // The other window (pane or pop-out) changed this page: show its text. The
  // stored body only differs from the editor's when it came from elsewhere,
  // since this editor's own saves put its text in the store. Skipped while
  // typing here waits to be saved; that save is newer and wins. No update
  // event and no undo step, so nothing is saved back.
  const storedBody = useWorkJournalStore((s) => s.pages[date]?.body);
  useEffect(() => {
    if (!editor || editor.isDestroyed || !storedBody || pendingRef.current) return;
    if (!canReadWorkJournalBody(storedBody)) return;
    if (JSON.stringify(storedBody) === JSON.stringify(editor.getJSON())) return;
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(storedBody, { emitUpdate: false })
      .run();
  }, [editor, storedBody]);

  // Read-only while a restore or undo replaces the journal. No update event:
  // the text did not change, so nothing must be saved.
  const replacing = useWorkJournalStore((s) => s.replacing);
  useEffect(() => {
    if (editor && editor.isEditable === replacing) editor.setEditable(!replacing, false);
  }, [editor, replacing]);

  // Best effort when the window closes: send the save right away. The OS may
  // still end the process before the backend writes it.
  useEffect(() => {
    const onLeave = (): void => flushRef.current();
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("pagehide", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("pagehide", onLeave);
    };
  }, []);

  return (
    <>
      {editor && <WorkJournalToolbar editor={editor} disabled={replacing} />}
      <EditorContent
        editor={editor}
        // Reuses the Notes editor's typography (headings, lists, links) so the
        // two editors read the same; only the CSS is shared, not the pipeline.
        // `work-journal-editor` scopes the checklist styles to this editor.
        className={`notes-editor work-journal-editor ${className}`}
        // Clicking the empty area below the last line moves the caret there.
        onClick={() => editor?.chain().focus().run()}
      />
    </>
  );
}

/** Read-only view of a body the editor cannot load; nothing here saves. */
function UnreadableBody({ initialBody, className = "" }: WorkJournalEditorProps) {
  return (
    <section aria-label="Unreadable Work Journal page" className={`flex flex-col ${className}`}>
      <p className="mb-1 shrink-0 text-[10px] italic text-maestro-muted">
        This page uses formatting this version of Maestro cannot show, so it is read-only here to
        keep it safe. Open it in a newer version to edit it.
      </p>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-maestro-muted">
        {JSON.stringify(initialBody, null, 2)}
      </pre>
    </section>
  );
}
