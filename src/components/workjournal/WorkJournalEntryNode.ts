import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PmNode, type Schema, Slice } from "@tiptap/pm/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  type Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
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

/** The class that hides a collapsed card's text after its first sentence. */
const ENTRY_REST_CLASS = "work-journal-entry-rest hidden";

/** A line break in a card's text read as a string: each hard break. */
const LINE_BREAK = "\n";

/** Where a first sentence ends: a `.`, `!` or `?` before a blank or the end, or a line break. */
const FIRST_SENTENCE_END = /[.!?](?=\s|$)|\n/;

/** Whether the editor has keyboard focus, read from the focus and blur steps TipTap sends. */
const EDITOR_FOCUS = new PluginKey<boolean>("workJournalEntryFocus");

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
 * when there is none that way or its parent cannot hold the swapped order (a
 * list item must start with its own text). The empty line the editor keeps
 * after a last card is not a block to move past: the card is already last.
 */
function entryMove(doc: PmNode, pos: number, direction: EntryMoveDirection): EntryMove | null {
  const card = doc.nodeAt(pos);
  if (card?.type.name !== WORK_JOURNAL_ENTRY_NODE) return null;
  const $pos = doc.resolve(pos);
  const { parent } = $pos;
  const index = $pos.index();
  const end = pos + card.nodeSize;
  if (direction === "up") {
    if (index === 0) return null;
    const above = parent.child(index - 1);
    const swapped = Fragment.from([card, above]);
    if (!parent.canReplace(index - 1, index + 1, swapped)) return null;
    const from = pos - above.nodeSize;
    return { from, to: end, swapped, cardStart: from };
  }
  if (index + 1 >= parent.childCount) return null;
  const below = parent.child(index + 1);
  const isTrailingLine =
    below === doc.lastChild && below.type.name === "paragraph" && below.content.size === 0;
  const swapped = Fragment.from([below, card]);
  if (isTrailingLine || !parent.canReplace(index, index + 2, swapped)) return null;
  return { from: pos, to: end + below.nodeSize, swapped, cardStart: pos + below.nodeSize };
}

/**
 * Whether the card starting at `pos` can move that way, read from the page
 * alone: the editor being read-only for a moment does not change it.
 */
export function canMoveEntry(doc: PmNode, pos: number, direction: EntryMoveDirection): boolean {
  return entryMove(doc, pos, direction) !== null;
}

/**
 * A card's whole text, each hard break as a line break. One character per
 * position, so an index in it is an offset into the card's paragraph.
 */
export function entryText(card: PmNode): string {
  const paragraph = card.firstChild;
  return paragraph ? paragraph.textBetween(0, paragraph.content.size, undefined, LINE_BREAK) : "";
}

/**
 * How long the first sentence of `text` is: up to the first `.`, `!` or `?`
 * followed by a blank or the end, or up to the first line break, whichever
 * comes first. Null when only blanks follow it: the text is one sentence.
 */
function firstSentenceLength(text: string): number | null {
  const end = FIRST_SENTENCE_END.exec(text);
  if (!end) return null;
  const length = end[0] === LINE_BREAK ? end.index : end.index + 1;
  return text.slice(length).trim() === "" ? null : length;
}

/** Whether the editor has focus after `tr`: TipTap tags its focus and blur steps. */
function focusAfter(tr: Transaction, focused: boolean): boolean {
  if (tr.getMeta("focus")) return true;
  if (tr.getMeta("blur")) return false;
  return focused;
}

/**
 * Whether the card starting at `pos` is being edited: the editor has focus and
 * a text cursor or selection is in the card. The cursor a page opens with, or
 * one left behind when the person clicks outside the editor, is not editing.
 */
function isEditingEntry(card: PmNode, pos: number, state: EditorState): boolean {
  const { selection } = state;
  return (
    EDITOR_FOCUS.getState(state) === true &&
    selection instanceof TextSelection &&
    selection.from < pos + card.nodeSize &&
    selection.to > pos
  );
}

/**
 * The doc range the card starting at `pos` hides while collapsed: its text
 * after the first sentence. Null when the card is one sentence or is being
 * edited, so its whole text shows.
 */
function collapsedRange(
  card: PmNode,
  pos: number,
  state: EditorState,
): { from: number; to: number } | null {
  const editing = isEditingEntry(card, pos, state);
  const length = editing ? null : firstSentenceLength(entryText(card));
  if (length === null || !card.firstChild) return null;
  // Past the card's and its paragraph's opening.
  const textStart = pos + 2;
  return { from: textStart + length, to: textStart + card.firstChild.content.size };
}

/** Whether the card starting at `pos` shows only its first sentence. */
export function isEntryCollapsed(state: EditorState, pos: number): boolean {
  const card = state.doc.nodeAt(pos);
  return card?.type.name === WORK_JOURNAL_ENTRY_NODE && collapsedRange(card, pos, state) !== null;
}

/**
 * Pasted blocks as one card text: each paragraph, heading or list item on its
 * own line, joined by hard breaks, with its inline formatting kept. Bullets
 * and heading levels go; an empty block gives no line.
 */
function cardLines(content: Fragment, schema: Schema): Fragment {
  const parts: PmNode[] = [];
  content.descendants((node) => {
    if (!node.isTextblock) return true;
    if (node.content.size === 0) return false;
    if (parts.length > 0) parts.push(schema.nodes.hardBreak.create());
    node.content.forEach((inline) => {
      parts.push(inline);
    });
    return false;
  });
  return Fragment.from(parts);
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
 * Bold decorations over every card's lead, the hidden rest of every collapsed
 * card, and the `is-empty` class (for the hint) on an empty card's text box;
 * display only, never stored.
 */
function entryDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== WORK_JOURNAL_ENTRY_NODE) return true;
    const rest = collapsedRange(node, pos, state);
    if (rest) decorations.push(Decoration.inline(rest.from, rest.to, { class: ENTRY_REST_CLASS }));
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
  return DecorationSet.create(state.doc, decorations);
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
        props: { decorations: (state) => entryDecorations(state) },
      }),
      new Plugin<boolean>({
        key: EDITOR_FOCUS,
        state: { init: () => false, apply: focusAfter },
      }),
      new Plugin({
        key: new PluginKey("workJournalEntryPaste"),
        props: {
          // A card holds one paragraph: pasted blocks become its lines instead
          // of spilling out of the card. Inline text pastes as it always did.
          handlePaste: (view, _event, slice) => {
            const { content } = slice;
            // Nothing to paste (an image alone): the selected text stays.
            if (content.size === 0 || content.firstChild?.isInline) return false;
            if (cardDepth(view.state.selection) === null) return false;
            const lines = new Slice(cardLines(slice.content, view.state.schema), 0, 0);
            view.dispatch(
              view.state.tr
                .replaceSelection(lines)
                .scrollIntoView()
                .setMeta("paste", true)
                .setMeta("uiEvent", "paste"),
            );
            return true;
          },
        },
      }),
    ];
  },
});
