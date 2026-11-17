import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PmNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Selection, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { mergeAttributes, Node, ReactNodeViewRenderer } from "@tiptap/react";
import {
  normalizeEntryTime,
  oneLine,
  TYPED_ENTRY_SOURCE,
  type WorkJournalEntryDraft,
  type WorkJournalEntryTarget,
} from "@/lib/workJournalEntry";
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
      /**
       * Swaps the card starting at `pos` (the card around the cursor when
       * left out) with the block right above or below it, as one editor step.
       * A cursor in the card stays in it.
       */
      moveWorkJournalEntry: (direction: EntryMoveDirection, pos?: number) => ReturnType;
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
 * The card `target` names, and where it starts: the first card on the page
 * not typed by hand whose project, time and text (each on one line, the way
 * the backend read them) are the target's. Null when no card reads so any
 * more: it was edited, retimed, moved to another project or deleted.
 */
export function findEntryCard(
  doc: PmNode,
  target: WorkJournalEntryTarget,
): { node: PmNode; pos: number } | null {
  let found: { node: PmNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name !== WORK_JOURNAL_ENTRY_NODE) return true;
    const { time, project, source } = node.attrs;
    const matches =
      source !== TYPED_ENTRY_SOURCE &&
      oneLine(String(project ?? "")) === oneLine(target.project) &&
      (normalizeEntryTime(String(time ?? "")) ?? null) === target.time &&
      oneLine(node.textBetween(0, node.content.size, " ", " ")) === oneLine(target.text);
    if (matches) found = { node, pos };
    return false;
  });
  return found;
}

/** `card` with its text replaced by `text`, its time, project and source kept. */
export function entryWithText(card: PmNode, text: string): PmNode {
  const { schema } = card.type;
  return card.type.create(card.attrs, schema.nodes.paragraph.create(null, schema.text(text)));
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

/** Which way a card moves: past the block above it or the block below it. */
export type EntryMoveDirection = "up" | "down";

/** How a card move rewrites the page: the range swapped and where the card then starts. */
interface EntryMove {
  from: number;
  to: number;
  swapped: Fragment;
  cardStart: number;
}

/**
 * The move of the card starting at `pos` past its neighbouring block, or null
 * when there is none that way. The empty line the editor keeps after a last
 * card is not a block to move past: the card is already last.
 */
function entryMove(doc: PmNode, pos: number, direction: EntryMoveDirection): EntryMove | null {
  const card = doc.nodeAt(pos);
  if (card?.type.name !== WORK_JOURNAL_ENTRY_NODE) return null;
  const $pos = doc.resolve(pos);
  const index = $pos.index();
  const end = pos + card.nodeSize;
  if (direction === "up") {
    if (index === 0) return null;
    const above = $pos.parent.child(index - 1);
    const from = pos - above.nodeSize;
    return { from, to: end, swapped: Fragment.from([card, above]), cardStart: from };
  }
  if (index + 1 >= $pos.parent.childCount) return null;
  const below = $pos.parent.child(index + 1);
  const isTrailingLine =
    below === doc.lastChild && below.type.name === "paragraph" && below.content.size === 0;
  if (isTrailingLine) return null;
  return {
    from: pos,
    to: end + below.nodeSize,
    swapped: Fragment.from([below, card]),
    cardStart: pos + below.nodeSize,
  };
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

/** Where the card around the selection's start begins, or null outside a card. */
function cardStart(selection: Selection): number | null {
  const depth = cardDepth(selection);
  return depth === null ? null : selection.$from.before(depth);
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
      moveWorkJournalEntry:
        (direction, pos) =>
        ({ editor, tr, dispatch }) => {
          if (!editor.isEditable) return false;
          const start = pos ?? cardStart(tr.selection);
          if (start === null) return false;
          const move = entryMove(tr.doc, start, direction);
          if (!move) return false;
          if (dispatch) {
            const { from, to } = tr.selection;
            const cardEnd = start + (tr.doc.nodeAt(start)?.nodeSize ?? 0);
            const cursorInCard = from > start && to < cardEnd;
            tr.replaceWith(move.from, move.to, move.swapped);
            if (cursorInCard) {
              const shift = move.cardStart - start;
              tr.setSelection(TextSelection.create(tr.doc, from + shift, to + shift));
            }
            // Its own undo step, even right after another move or typing.
            closeHistory(tr).scrollIntoView();
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
      "Alt-ArrowUp": ({ editor }) => editor.commands.moveWorkJournalEntry("up"),
      "Alt-ArrowDown": ({ editor }) => editor.commands.moveWorkJournalEntry("down"),
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
