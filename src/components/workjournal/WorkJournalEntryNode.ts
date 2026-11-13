import type { Node as PmNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { mergeAttributes, Node, ReactNodeViewRenderer } from "@tiptap/react";
import { TYPED_ENTRY_SOURCE, type WorkJournalEntryDraft } from "@/lib/workJournalEntry";
import { WorkJournalEntryCard } from "./WorkJournalEntryCard";

/**
 * The node type of an entry card in the page JSON. The backend's `page_text`
 * reads the same name; change both together.
 */
export const WORK_JOURNAL_ENTRY_NODE = "journalEntry";

/** The class on the bold lead of a card's text (up to the first colon). */
export const ENTRY_LEAD_CLASS = "work-journal-entry-lead font-bold";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    workJournalEntry: {
      /**
       * Adds an entry card at the end of the page. A trailing empty
       * paragraph (a fresh page's only line) is filled instead of leaving a
       * blank line above the card. With `focus`, the cursor goes to the end
       * of the card's text.
       */
      appendWorkJournalEntry: (
        entry: WorkJournalEntryDraft,
        options?: { focus?: boolean },
      ) => ReturnType;
    };
  }
}

/** A card node holding `entry`: its attributes and one paragraph of text. */
export function createWorkJournalEntryNode(schema: Schema, entry: WorkJournalEntryDraft): PmNode {
  const text = entry.text === "" ? null : schema.text(entry.text);
  return schema.nodes[WORK_JOURNAL_ENTRY_NODE].create(
    { time: entry.time, project: entry.project, source: entry.source },
    schema.nodes.paragraph.create(null, text),
  );
}

/**
 * Where an entry card added at the end of `doc` starts, and whether it
 * replaces the page's trailing empty paragraph.
 */
export function entryAppendStart(doc: PmNode): { start: number; fill: boolean } {
  const last = doc.lastChild;
  const fill = last?.type.name === "paragraph" && last.content.size === 0;
  const end = doc.content.size;
  return { start: fill && last ? end - last.nodeSize : end, fill };
}

/**
 * The doc range of a card's bold lead: its text up to and including the
 * first colon, or all of it when there is no colon. Null for an empty card.
 */
function leadRange(card: PmNode, cardPos: number): { from: number; to: number } | null {
  let from: number | null = null;
  let to: number | null = null;
  let done = false;
  card.descendants((child, childPos) => {
    if (done) return false;
    if (!child.isText || !child.text) return true;
    const at = cardPos + 1 + childPos;
    if (from === null) from = at;
    const colon = child.text.indexOf(":");
    done = colon !== -1;
    to = at + (done ? colon + 1 : child.text.length);
    return false;
  });
  return from !== null && to !== null ? { from, to } : null;
}

/**
 * Bold decorations over every card's lead, and the `is-empty` class (for the
 * hint) on an empty card's text box; display only, never stored.
 */
function leadDecorations(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== WORK_JOURNAL_ENTRY_NODE) return true;
    const range = leadRange(node, pos);
    if (range) {
      decorations.push(Decoration.inline(range.from, range.to, { class: ENTRY_LEAD_CLASS }));
    } else if (node.firstChild) {
      const from = pos + 1;
      decorations.push(
        Decoration.node(from, from + node.firstChild.nodeSize, { class: "is-empty" }),
      );
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** The depth of the card around the selection's start, or null outside a card. */
function cardDepth(selection: Selection): number | null {
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === WORK_JOURNAL_ENTRY_NODE) return depth;
  }
  return null;
}

/**
 * A Work Journal entry card: a block among the page's free notes with its
 * time, project and source as attributes and one paragraph of text that keeps
 * the page's formatting. Shown by {@link WorkJournalEntryCard}; dragged by its
 * handle; the text up to the first colon shows bold.
 */
export const WorkJournalEntry = Node.create({
  name: WORK_JOURNAL_ENTRY_NODE,
  group: "block",
  content: "paragraph",
  draggable: true,
  // Typing, Backspace and lifts never cross the card's edge.
  isolating: true,
  defining: true,

  addAttributes() {
    return {
      time: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-time") || null,
        renderHTML: (attrs: { time: string | null }) =>
          attrs.time ? { "data-time": attrs.time } : {},
      },
      project: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-project") || null,
        renderHTML: (attrs: { project: string | null }) =>
          attrs.project ? { "data-project": attrs.project } : {},
      },
      source: {
        default: TYPED_ENTRY_SOURCE,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-source") || TYPED_ENTRY_SOURCE,
        renderHTML: (attrs: { source: string }) => ({ "data-source": attrs.source }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="journal-entry"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "journal-entry" }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WorkJournalEntryCard);
  },

  addCommands() {
    return {
      appendWorkJournalEntry:
        (entry, options = {}) =>
        ({ tr, dispatch }) => {
          const { start } = entryAppendStart(tr.doc);
          const card = createWorkJournalEntryNode(tr.doc.type.schema, entry);
          if (dispatch) {
            tr.replaceWith(start, tr.doc.content.size, card);
            if (options.focus) {
              // The end of the text: before the paragraph's and the card's close.
              tr.setSelection(TextSelection.create(tr.doc, start + card.nodeSize - 2));
            }
            tr.scrollIntoView();
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      // A card has one text box: Enter starts a free note right after it.
      Enter: ({ editor }) => {
        const depth = cardDepth(editor.state.selection);
        if (depth === null) return false;
        const after = editor.state.selection.$from.after(depth);
        return editor
          .chain()
          .insertContentAt(after, { type: "paragraph" })
          .setTextSelection(after + 1)
          .scrollIntoView()
          .run();
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("workJournalEntryLead"),
        props: { decorations: (state) => leadDecorations(state.doc) },
      }),
    ];
  },
});
