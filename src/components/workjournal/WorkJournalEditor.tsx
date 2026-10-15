import { EditorContent, type JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";

/** How long typing must pause before the page body is saved. */
export const WORK_JOURNAL_SAVE_DEBOUNCE_MS = 400;

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
 * changes or the editor closes.
 */
export function WorkJournalEditor({ date, initialBody, className = "" }: WorkJournalEditorProps) {
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
    extensions: [
      StarterKit.configure({
        // A click must never navigate the app window; links are edited here.
        link: { openOnClick: false },
      }),
    ],
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
