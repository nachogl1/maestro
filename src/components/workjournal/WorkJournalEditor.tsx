import { EditorContent, getSchema, type JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef } from "react";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";

/** How long typing must pause before the page body is saved. */
export const WORK_JOURNAL_SAVE_DEBOUNCE_MS = 400;

/** The editor's extension set; the body guard checks pages against the same schema. */
const WORK_JOURNAL_EXTENSIONS = [
  StarterKit.configure({
    // A click must never navigate the app window; links are edited here.
    link: { openOnClick: false },
  }),
];

const WORK_JOURNAL_SCHEMA = getSchema(WORK_JOURNAL_EXTENSIONS);

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
 * the Notes markdown pipeline). Bold, italic, underline, headings, bullet and
 * numbered lists and links, through keyboard shortcuts and markdown-style
 * input rules. The body is saved as TipTap JSON (`editor.getJSON()`) after a
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

  const flush = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const body = pendingRef.current;
    if (!body) return;
    pendingRef.current = null;
    void useWorkJournalStore.getState().updatePage(dateRef.current, { body });
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
    <EditorContent
      editor={editor}
      // Reuses the Notes editor's typography (headings, lists, links) so the
      // two editors read the same; only the CSS is shared, not the pipeline.
      className={`notes-editor ${className}`}
      // Clicking the empty area below the last line moves the caret there.
      onClick={() => editor?.chain().focus().run()}
    />
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
