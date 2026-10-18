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
 * wrongly, so it cannot stand in for a real key press here.)
 */
function press(target: Editor, key: string): void {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.view.someProp("handleKeyDown", (handler) => handler(target.view, event));
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
});
