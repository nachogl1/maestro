import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import type { MarkdownStorage } from "tiptap-markdown";
import { Markdown } from "tiptap-markdown";
import { afterEach, describe, expect, it } from "vitest";
import { NotesListKeymap } from "../notesListKeymap";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function notesEditor(markdown: string): Editor {
  editor = new Editor({
    extensions: [StarterKit, Markdown.configure({ html: false }), NotesListKeymap],
    content: markdown,
  });
  return editor;
}

function markdownOf(target: Editor): string {
  return (target.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
}

/**
 * Presses a key the way the browser does, through the editor's keydown
 * handlers. (TipTap's `keyboardShortcut` command replays a multi-step change
 * wrongly, so it cannot stand in for a real key press here.) Returns whether
 * the editor handled the key; an unhandled Tab moves focus out of the editor.
 */
function press(target: Editor, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  return target.view.someProp("handleKeyDown", (handler) => handler(target.view, event)) ?? false;
}

/** Puts the caret at the start (or end) of the line whose whole text is `line`. */
function placeCaret(target: Editor, line: string, at: "start" | "end" = "start"): void {
  let pos = -1;
  target.state.doc.descendants((node, nodePos) => {
    if (pos < 0 && node.isText && node.text === line) {
      pos = at === "start" ? nodePos : nodePos + node.nodeSize;
    }
  });
  if (pos < 0) throw new Error(`No line "${line}" in the note`);
  target.view.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, pos)));
}

/** Selects from the start of line `first` to the end of line `last`. */
function selectLines(target: Editor, first: string, last: string): void {
  placeCaret(target, first);
  const { from } = target.state.selection;
  placeCaret(target, last, "end");
  const { to } = target.state.selection;
  target.view.dispatch(
    target.state.tr.setSelection(TextSelection.create(target.state.doc, from, to)),
  );
}

/** Empties the line whose whole text is `line`, leaving the caret on it. */
function emptyLine(target: Editor, line: string): void {
  placeCaret(target, line);
  const { from } = target.state.selection;
  target.commands.deleteRange({ from, to: from + line.length });
}

describe("NotesListKeymap", () => {
  it("Backspace on an empty indented bullet removes only that bullet", () => {
    const note = notesEditor("- a\n  - b\n  - x\n  - c\n- d");
    emptyLine(note, "x");
    press(note, "Backspace");
    expect(markdownOf(note)).toBe("- a\n  - b\n  - c\n- d");
  });

  it("Backspace on an empty first indented bullet keeps the bullets below it in place", () => {
    const note = notesEditor("- a\n  - x\n  - c\n- d");
    emptyLine(note, "x");
    press(note, "Backspace");
    expect(markdownOf(note)).toBe("- a\n  - c\n- d");
  });

  it("Backspace on an empty indented bullet puts the caret at the end of the line above", () => {
    const note = notesEditor("- a\n  - b\n  - x\n  - c");
    emptyLine(note, "x");
    press(note, "Backspace");
    note.commands.insertContent("!");
    expect(markdownOf(note)).toBe("- a\n  - b!\n  - c");
  });

  it("Backspace at the start of a top-level bullet keeps its nested bullets indented", () => {
    const note = notesEditor("- a\n- b\n  - b1\n- c");
    placeCaret(note, "b");
    press(note, "Backspace");
    expect(markdownOf(note)).toBe("- ab\n  - b1\n- c");
  });

  it("Backspace keeps a numbered list's nested bullets indented", () => {
    const note = notesEditor("1. a\n2. b\n   - b1\n3. c");
    placeCaret(note, "b");
    press(note, "Backspace");
    expect(markdownOf(note)).toBe("1. ab\n   - b1\n2. c");
  });

  it("Backspace at the start of an indented bullet still outdents it", () => {
    const note = notesEditor("- a\n  - b\n  - c\n- d");
    placeCaret(note, "b");
    press(note, "Backspace");
    expect(markdownOf(note)).toBe("- a\n- b\n  - c\n- d");
  });

  it("Backspace at the start of a top-level bullet without nested bullets still turns it into text", () => {
    const note = notesEditor("- a\n- b\n- c");
    placeCaret(note, "b");
    press(note, "Backspace");
    expect(markdownOf(note)).toBe("- a\n\nb\n\n- c");
  });

  it("Delete at the end of a bullet pulls up the indented line below and keeps its siblings", () => {
    const note = notesEditor("- a\n  - b\n  - c\n- d");
    placeCaret(note, "a", "end");
    press(note, "Delete");
    expect(markdownOf(note)).toBe("- ab\n  - c\n- d");
  });

  it("Delete at the end of a bullet keeps the levels of the bullets after the pulled-up line", () => {
    const note = notesEditor("- a\n  - b\n    - b1\n  - c\n- d");
    placeCaret(note, "a", "end");
    press(note, "Delete");
    expect(markdownOf(note)).toMatch(/^- ab\n {2}- *\n {4}- b1\n {2}- c\n- d$/);
  });

  it.each([
    ["- a\n- b\n- c", "- a\n  - b\n- c"],
    ["- a\n- b\n  - b1\n- c", "- a\n  - b\n    - b1\n- c"],
    ["- a\n  - a1\n- b\n- c", "- a\n  - a1\n  - b\n- c"],
  ])("Tab on a middle bullet indents only it and its own nested bullets: %j", (before, after) => {
    const note = notesEditor(before);
    placeCaret(note, "b");
    press(note, "Tab");
    expect(markdownOf(note)).toBe(after);
  });

  it.each([
    ["- a\n  - b\n  - c\n- d", "- a\n  - c\n- b\n- d"],
    ["- a\n  - b\n    - b1\n  - c\n- d", "- a\n  - c\n- b\n  - b1\n- d"],
    ["- a\n  - x\n    - b\n    - c\n  - y", "- a\n  - x\n    - c\n  - b\n  - y"],
    ["- a\n  - b\n- d", "- a\n- b\n- d"],
  ])("Shift+Tab on a nested bullet leaves the bullets below it at their level: %j", (before, after) => {
    const note = notesEditor(before);
    placeCaret(note, "b");
    press(note, "Tab", true);
    expect(markdownOf(note)).toBe(after);
  });

  it.each([
    ["- a\n  - b\n  - c\n- d", "b", "b", "- a\n  - c\n  - b\n- d"],
    ["- a\n  - b\n  - c\n  - d\n- e", "b", "c", "- a\n  - d\n  - b\n  - c\n- e"],
  ])("Shift+Tab then Tab keeps the selection and never indents the bullets that followed: %j", (before, first, last, after) => {
    const note = notesEditor(before);
    selectLines(note, first, last);
    press(note, "Tab", true);
    press(note, "Tab");
    expect(markdownOf(note)).toBe(after);
  });

  it.each([
    ["- a\n- b", "a"],
    ["- a\n  - b\n  - c", "b"],
  ])("Tab on the first bullet of a list keeps the caret in the editor and changes nothing: %j", (before, line) => {
    const note = notesEditor(before);
    placeCaret(note, line);
    expect(press(note, "Tab")).toBe(true);
    expect(markdownOf(note)).toBe(before);
  });

  it.each([
    ["- a\n- b\n- c\n- d", "b", "c", "- a\n  - b\n  - c\n- d"],
    ["- a\n- b\n  - b1\n- c", "b", "b1", "- a\n  - b\n    - b1\n- c"],
    ["- a\n- b\n  - b1\n- c", "b1", "c", "- a\n- b\n  - b1\n  - c"],
    ["- a\n  - b\n- c\n- d", "b", "c", "- a\n  - b\n  - c\n- d"],
    ["- a\n- b", "a", "b", "- a\n- b"],
  ])("Tab on a selection indents exactly the selected bullets: %j", (before, first, last, after) => {
    const note = notesEditor(before);
    selectLines(note, first, last);
    expect(press(note, "Tab")).toBe(true);
    expect(markdownOf(note)).toBe(after);
  });

  it.each([
    ["- a\n  - b\n  - c\n  - d\n- e", "b", "c", "- a\n  - d\n- b\n- c\n- e"],
    ["- a\n- b\n  - b1\n- c", "b1", "c", "- a\n- b\n- b1\n- c"],
    ["- a\n  - b\n- c\n- d", "b", "c", "- a\n- b\n- c\n- d"],
  ])("Shift+Tab on a selection outdents exactly the selected bullets: %j", (before, first, last, after) => {
    const note = notesEditor(before);
    selectLines(note, first, last);
    press(note, "Tab", true);
    expect(markdownOf(note)).toBe(after);
  });

  it("Shift+Tab on a top-level bullet still turns it into text", () => {
    const note = notesEditor("- a\n- b\n- c");
    placeCaret(note, "b");
    press(note, "Tab", true);
    expect(markdownOf(note)).toBe("- a\n\nb\n\n- c");
  });
});
