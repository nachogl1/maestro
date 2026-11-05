import { type Editor, Extension } from "@tiptap/core";
import { joinTextblockBackward, joinTextblockForward } from "@tiptap/pm/commands";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import { sinkListItem } from "@tiptap/pm/schema-list";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";

const LIST_ITEM = "listItem";
const LISTS = new Set(["bulletList", "orderedList"]);

/** Runs before TipTap's own list keymap (priority 100), so these keys are handled here first. */
const BEFORE_LIST_KEYMAP_PRIORITY = 1000;

/** The bullet whose own line holds the collapsed caret. */
interface CaretBullet {
  item: ProseMirrorNode;
  /** The bullet sits inside another bullet. */
  indented: boolean;
  atLineStart: boolean;
  atLineEnd: boolean;
}

/**
 * The bullet whose first line holds the collapsed caret, or null when the
 * caret is anywhere else (a selection, plain text, a bullet's later paragraph).
 */
function caretBullet(editor: Editor): CaretBullet | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const itemDepth = $from.depth - 1;
  if (itemDepth < 1 || $from.node(itemDepth).type.name !== LIST_ITEM) return null;
  if ($from.index(itemDepth) !== 0) return null;
  return {
    item: $from.node(itemDepth),
    indented: itemDepth >= 3 && $from.node(itemDepth - 2).type.name === LIST_ITEM,
    atLineStart: $from.parentOffset === 0,
    atLineEnd: $from.parentOffset === $from.parent.content.size,
  };
}

/** The bullet's line is followed directly by bullets nested under it. */
function hasNestedBullets(item: ProseMirrorNode): boolean {
  const next = item.maybeChild(1);
  return next !== null && LISTS.has(next.type.name);
}

function isEmptyLine(item: ProseMirrorNode): boolean {
  return item.firstChild?.content.size === 0;
}

/**
 * Backspace at the start of a bullet. An empty indented bullet is removed, and
 * a top-level bullet with nested bullets joins the line above, so the bullets
 * around it keep their level. TipTap instead lifts the bullet out, which
 * re-nests the bullets below an empty one and drops a top-level bullet's
 * nested bullets to the top level. Every other case keeps TipTap's behaviour
 * (outdent an indented bullet, turn a top-level one into text).
 */
function handleBackspace(editor: Editor): boolean {
  const bullet = caretBullet(editor);
  if (!bullet?.atLineStart) return false;
  const nested = hasNestedBullets(bullet.item);
  const removesEmptyIndented = bullet.indented && isEmptyLine(bullet.item) && !nested;
  const joinsLineAbove = !bullet.indented && nested;
  if (!removesEmptyIndented && !joinsLineAbove) return false;
  return joinTextblockBackward(editor.state, editor.view.dispatch);
}

/**
 * Delete at the end of a bullet whose next line is a bullet nested under it:
 * that line's text joins this one and every bullet keeps its level. TipTap
 * instead strips the next line's bullet, or shifts the following bullets.
 */
function handleDelete(editor: Editor): boolean {
  const bullet = caretBullet(editor);
  if (!bullet?.atLineEnd || !hasNestedBullets(bullet.item)) return false;
  return joinTextblockForward(editor.state, editor.view.dispatch);
}

/** The start positions of the bullets each selected line belongs to, in document order. */
function selectedBullets(state: EditorState): number[] {
  const { from, to } = state.selection;
  const bullets = new Set<number>();
  const addBulletAround = (inside: number): void => {
    const $pos = state.doc.resolve(inside);
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).type.name === LIST_ITEM) {
        bullets.add($pos.before(depth));
        return;
      }
    }
  };
  if (state.selection.empty) addBulletAround(from);
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    addBulletAround(pos + 1);
    return false;
  });
  return [...bullets].sort((a, b) => a - b);
}

/** Some bullet enclosing the bullet at `$bullet` is one of the `selected` bullets. */
function isInsideSelectedBullet($bullet: ResolvedPos, selected: Set<number>): boolean {
  for (let depth = $bullet.depth - 1; depth > 0; depth--) {
    if ($bullet.node(depth).type.name === LIST_ITEM && selected.has($bullet.before(depth))) {
      return true;
    }
  }
  return false;
}

/**
 * The selected bullets none of whose enclosing bullets is selected, as runs of
 * consecutive bullets in one list. Moving a run moves every selected bullet,
 * since the others sit inside a run's bullets.
 */
function selectedRuns(state: EditorState): number[][] {
  const bullets = selectedBullets(state);
  const selected = new Set(bullets);
  const runs: number[][] = [];
  let runList = -1;
  for (const bullet of bullets) {
    const $bullet = state.doc.resolve(bullet);
    if (isInsideSelectedBullet($bullet, selected)) continue;
    const list = $bullet.before($bullet.depth);
    if (list === runList) runs[runs.length - 1].push(bullet);
    else runs.push([bullet]);
    runList = list;
  }
  return runs;
}

/** The run's list sits inside another bullet, so the run can move out one level. */
function isNestedRun(doc: ProseMirrorNode, run: number[]): boolean {
  const $bullet = doc.resolve(run[0]);
  return $bullet.depth >= 2 && $bullet.node($bullet.depth - 1).type.name === LIST_ITEM;
}

/** The caret's two ends, kept by hand because moving a run deletes and re-inserts it. */
interface SelectionEnds {
  anchor: number;
  head: number;
}

/** Sinks the run into the bullet before it, as TipTap's own Tab does for one list. */
function indentRun(tr: Transaction, run: number[]): void {
  const itemType = tr.doc.type.schema.nodes[LIST_ITEM];
  const lastBullet = run[run.length - 1];
  const runSelection = TextSelection.create(tr.doc, run[0] + 2, lastBullet + 2);
  const runState = EditorState.create({ doc: tr.doc, selection: runSelection });
  sinkListItem(itemType)(runState, (runTr) => {
    for (const step of runTr.steps) tr.step(step);
  });
}

/**
 * Outdents a nested run by moving it, with its own nested bullets, to just
 * after the bullet that held it. The bullets that followed the run stay in
 * that bullet at their level. (TipTap instead nests them under the run, so a
 * later Tab on the run carries them one level deeper.)
 */
function outdentRun(tr: Transaction, run: number[], ends: SelectionEnds): void {
  const $first = tr.doc.resolve(run[0]);
  const listDepth = $first.depth;
  const lastBullet = run[run.length - 1];
  const runStart = run[0];
  const runEnd = tr.doc.resolve(lastBullet + 1).after();
  const bullets = tr.doc.slice(runStart, runEnd).content;
  const wholeList = runStart === $first.start(listDepth) && runEnd === $first.end(listDepth);
  const removeFrom = wholeList ? $first.before(listDepth) : runStart;
  const removeTo = wholeList ? $first.after(listDepth) : runEnd;
  const afterHolder = $first.after(listDepth - 1);
  const stepsBefore = tr.steps.length;
  tr.delete(removeFrom, removeTo);
  const insertAt = tr.mapping.slice(stepsBefore).map(afterHolder);
  tr.insert(insertAt, bullets);
  const follow = (pos: number): number =>
    pos >= runStart && pos <= runEnd
      ? insertAt + (pos - runStart)
      : tr.mapping.slice(stepsBefore).map(pos);
  ends.anchor = follow(ends.anchor);
  ends.head = follow(ends.head);
}

/**
 * Indents (Tab) or outdents (Shift+Tab) exactly the selected bullets, each
 * with its own nested bullets, one level. Bullets after them keep their level.
 * TipTap instead moves every bullet in the deepest list holding the whole
 * selection, so a selection across levels also moves or un-bullets the bullet
 * that holds its first line, and a Tab nothing can indent moves focus out of
 * the editor. A run that cannot move (its first bullet is the first of its
 * list, or it is already at the top level) stays where it is. Tab on bullets
 * is always handled; Shift+Tab with nothing to outdent keeps TipTap's
 * behaviour (turn a top-level bullet into text).
 */
function moveSelectedBullets(editor: Editor, direction: "in" | "out"): boolean {
  const { state } = editor;
  const runs = selectedRuns(state);
  if (runs.length === 0) return false;
  const tr = state.tr;
  const ends: SelectionEnds = { anchor: state.selection.anchor, head: state.selection.head };
  // Last run first, so a move never shifts the bullets of a run still to come.
  for (const run of [...runs].reverse()) {
    if (direction === "in") indentRun(tr, run);
    else if (isNestedRun(tr.doc, run)) outdentRun(tr, run, ends);
  }
  if (!tr.docChanged) return direction === "in";
  if (direction === "out") {
    tr.setSelection(TextSelection.between(tr.doc.resolve(ends.anchor), tr.doc.resolve(ends.head)));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Bullet-list keys for the Notes editor so that editing one bullet leaves
 * every other bullet at its level.
 */
export const NotesListKeymap = Extension.create({
  name: "notesListKeymap",
  priority: BEFORE_LIST_KEYMAP_PRIORITY,

  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => handleBackspace(editor),
      Delete: ({ editor }) => handleDelete(editor),
      Tab: ({ editor }) => moveSelectedBullets(editor, "in"),
      "Shift-Tab": ({ editor }) => moveSelectedBullets(editor, "out"),
    };
  },
});
