import { TaskItem, TaskList } from "@tiptap/extension-list";
import { BackgroundColor, Color, TextStyle } from "@tiptap/extension-text-style";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PmNode, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { EditorContent, getSchema, type JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  WORK_JOURNAL_HIGHLIGHT_COLORS,
  WORK_JOURNAL_TEXT_COLORS,
  type WorkJournalSpellingState,
  WorkJournalToolbar,
} from "@/components/workjournal/WorkJournalToolbar";
import {
  registerWorkJournalEditorAppend,
  registerWorkJournalEditorFlush,
  registerWorkJournalEditorUpdate,
  useWorkJournalStore,
  workJournalBodyBaseRev,
} from "@/stores/useWorkJournalStore";
import {
  createWorkJournalEntryNode,
  entryAppendStart,
  entryWithText,
  findEntryCard,
  WORK_JOURNAL_ENTRY_NODE,
  WorkJournalEntry,
} from "./WorkJournalEntryNode";
import {
  applySpellingEdits,
  fixesMessage,
  fixWorkJournalSpelling,
  spellingEdits,
  spellingSegments,
} from "./WorkJournalSpelling";

/** How long typing must pause before the page body is saved. */
export const WORK_JOURNAL_SAVE_DEBOUNCE_MS = 400;

/** How long the spelling fixer's result line shows before it fades. */
export const SPELLING_NOTE_MS = 4000;

/** How long the result line takes to fade out (the toolbar's transition). */
const SPELLING_FADE_MS = 700;

/** Ctrl+Shift+F (Cmd+Shift+F on a Mac) starts the spelling fixer. */
function isFixSpellingKey(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === "KeyF"
  );
}

/** The editor's extension set; the body guard checks pages against the same schema. */
const WORK_JOURNAL_EXTENSIONS = [
  StarterKit.configure({
    // A click must never navigate the app window; links are edited here.
    link: { openOnClick: false },
    // The red line where a dragged card lands (styled in globals.css).
    dropcursor: { color: false, width: 2, class: "work-journal-dropcursor" },
  }),
  // Text colour and highlight live on the textStyle mark; no font controls.
  TextStyle,
  Color,
  BackgroundColor,
  TaskList,
  TaskItem.configure({ nested: true }),
  // Entry cards among the free notes.
  WorkJournalEntry,
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
 * rules, with entry cards among the free notes (see `WorkJournalEntry`) and
 * "+ Add entry" at the end of the toolbar. The body is saved as TipTap JSON
 * (`editor.getJSON()`) after a short pause in typing, and any unsaved change
 * is flushed when the date changes, the editor closes or the window is closed.
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
  // The page `rev` the text here is based on: the one loaded at mount, or the
  // other window's last change shown here. A save based on an older copy than
  // the disk's is refused instead of written over it.
  const baseRevRef = useRef(workJournalBodyBaseRev(date));

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
    return useWorkJournalStore.getState().updatePage(dateRef.current, { body }, baseRevRef.current);
  };
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;
  const flush = (): void => {
    void saveNowRef.current();
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  // The spelling fixer: running locks the page; the note is its result line.
  const [fixing, setFixing] = useState(false);
  const [spellingNote, setSpellingNote] = useState<WorkJournalSpellingState["note"]>(null);
  const noteTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const fixSpellingRef = useRef<() => void>(() => {});

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
      handleKeyDown: (_view, event) => {
        if (!isFixSpellingKey(event)) return false;
        event.preventDefault();
        fixSpellingRef.current();
        return true;
      },
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

  // An accepted suggestion lands here: an entry card at the end of the
  // body, saved right away. A trailing empty paragraph (a fresh page's only
  // line, or an empty last line) is filled instead of leaving a blank line.
  // When the save fails, the card is taken back out, so a retry cannot add
  // a second copy.
  useEffect(() => {
    if (!editor) return;
    return registerWorkJournalEditorAppend(date, async (entry) => {
      const { replacing, revision } = useWorkJournalStore.getState();
      if (editor.isDestroyed || !editor.isEditable || replacing) return "refused";
      if (revision !== revisionRef.current) return "refused";
      // Where the card starts, kept current while the save runs.
      const { fill, start: appendStart } = entryAppendStart(editor.state.doc);
      let start = appendStart;
      const card = createWorkJournalEntryNode(editor.schema, entry);
      if (!editor.commands.appendWorkJournalEntry(entry)) return "refused";
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
        // Left alone if the user already edited the card meanwhile.
        if (node?.type.name === WORK_JOURNAL_ENTRY_NODE && node.eq(card)) {
          editor.view.dispatch(
            editor.state.tr.delete(start, appendedEnd(editor.state.doc, start, node, fill)),
          );
          // Puts the page without the card in the store (and on disk) now.
          void saveNowRef.current();
        }
      }
      return "save_failed";
    });
  }, [editor, date]);

  // An accepted update suggestion lands here: the card it names gets the new
  // text (its time, project and source kept), saved right away. A card that
  // no longer reads as the suggestion saw it is never touched. When the save
  // fails, the card's old text is put back.
  useEffect(() => {
    if (!editor) return;
    return registerWorkJournalEditorUpdate(date, async (target, text) => {
      const { replacing, revision } = useWorkJournalStore.getState();
      if (editor.isDestroyed || !editor.isEditable || replacing) return "refused";
      if (revision !== revisionRef.current) return "refused";
      const found = findEntryCard(editor.state.doc, target);
      if (!found) return "card_changed";
      const before = found.node;
      const after = entryWithText(before, text);
      // Where the card starts, kept current while the save runs.
      let start = found.pos;
      editor.view.dispatch(editor.state.tr.replaceWith(start, start + before.nodeSize, after));
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
        // Left alone if the user already edited the card meanwhile.
        if (node?.type.name === WORK_JOURNAL_ENTRY_NODE && node.eq(after)) {
          editor.view.dispatch(editor.state.tr.replaceWith(start, start + node.nodeSize, before));
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
  // event and no undo step, so nothing is saved back. The caret and selection
  // stay where they were (clamped to the new text's length).
  const storedBody = useWorkJournalStore((s) => s.pages[date]?.body);
  useEffect(() => {
    if (!editor || editor.isDestroyed || !storedBody || pendingRef.current) return;
    if (!canReadWorkJournalBody(storedBody)) return;
    if (JSON.stringify(storedBody) === JSON.stringify(editor.getJSON())) return;
    const { from, to } = editor.state.selection;
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(storedBody, { emitUpdate: false })
      .run();
    const size = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
    baseRevRef.current = useWorkJournalStore.getState().pages[date]?.rev;
  }, [editor, storedBody, date]);

  // Read-only while a restore or undo replaces the journal, or the spelling
  // fixer runs. No update event: the text did not change, so nothing must be
  // saved.
  const replacing = useWorkJournalStore((s) => s.replacing);
  const locked = replacing || fixing;
  useEffect(() => {
    if (editor && editor.isEditable === locked) editor.setEditable(!locked, false);
  }, [editor, locked]);

  // The result line shows, then fades, then goes.
  const showSpellingNote = (text: string, failed: boolean): void => {
    for (const timer of noteTimersRef.current) clearTimeout(timer);
    setSpellingNote({ text, failed, fading: false });
    noteTimersRef.current = [
      setTimeout(() => setSpellingNote((n) => n && { ...n, fading: true }), SPELLING_NOTE_MS),
      setTimeout(() => setSpellingNote(null), SPELLING_NOTE_MS + SPELLING_FADE_MS),
    ];
  };
  useEffect(() => () => noteTimersRef.current.forEach(clearTimeout), []);

  // Fixes the selection, or the whole page with none: the texts go to Claude
  // with the page locked, and the fix lands at once as one editor change (one
  // Ctrl+Z). Nothing changes when the call fails or the page changed meanwhile.
  const fixSpelling = async (): Promise<void> => {
    if (!editor || editor.isDestroyed || !editor.isEditable || fixing) return;
    const before = editor.state.doc;
    const { from, to, empty } = editor.state.selection;
    const segments = spellingSegments(before, empty ? undefined : { from, to });
    if (segments.length === 0) {
      showSpellingNote(fixesMessage(0), false);
      return;
    }
    editor.setEditable(false, false);
    setFixing(true);
    const revision = useWorkJournalStore.getState().revision;
    try {
      const fixed = await fixWorkJournalSpelling(segments.map((s) => s.text));
      if (editor.isDestroyed) return;
      const store = useWorkJournalStore.getState();
      if (editor.state.doc !== before || store.replacing || store.revision !== revision) {
        showSpellingNote("Not fixed: the page changed while Claude was working.", true);
        return;
      }
      if (!Array.isArray(fixed) || fixed.length !== segments.length) {
        showSpellingNote("Not fixed: Claude's reply could not be read. Try again.", true);
        return;
      }
      const edits = spellingEdits(segments, fixed);
      if (edits.length > 0) {
        editor.view.dispatch(closeHistory(applySpellingEdits(editor.state.tr, edits)));
        // The next change starts its own undo step, never merged with the fix.
        editor.view.dispatch(closeHistory(editor.state.tr));
      }
      showSpellingNote(fixesMessage(edits.length), false);
    } catch (error) {
      showSpellingNote(
        `Not fixed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      if (!editor.isDestroyed) {
        editor.setEditable(!useWorkJournalStore.getState().replacing, false);
        editor.commands.focus();
      }
      setFixing(false);
    }
  };
  fixSpellingRef.current = () => void fixSpelling();

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
      {editor && (
        <WorkJournalToolbar
          editor={editor}
          disabled={locked}
          spelling={{
            running: fixing,
            note: spellingNote,
            onFix: () => fixSpellingRef.current(),
          }}
        />
      )}
      <EditorContent
        editor={editor}
        // Nothing on the page (card controls included) takes input while a
        // spelling fix runs.
        {...(fixing ? ({ inert: "", "aria-busy": true } as { inert: "" }) : {})}
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

/**
 * Where taking an appended card back out ends: after the card, plus the empty
 * last line the editor adds after a final block (TipTap's trailing node) when
 * the card did not fill one that was already there.
 */
function appendedEnd(doc: PmNode, start: number, card: PmNode, filled: boolean): number {
  const end = start + card.nodeSize;
  const next = doc.nodeAt(end);
  const trailing =
    next?.type.name === "paragraph" &&
    next.content.size === 0 &&
    end + next.nodeSize === doc.content.size;
  return !filled && trailing && next ? end + next.nodeSize : end;
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
