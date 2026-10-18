import { type Editor, Extension } from "@tiptap/core";
import { joinTextblockBackward, joinTextblockForward } from "@tiptap/pm/commands";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

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
    };
  },
});
