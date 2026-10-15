import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";
import { WorkJournalEditor } from "../WorkJournalEditor";
import { WORK_JOURNAL_HIGHLIGHT_COLORS, WORK_JOURNAL_TEXT_COLORS } from "../WorkJournalToolbar";

/** A page with one paragraph of plain text. */
function textBody(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function pageEditor(): Editor {
  const dom = screen.getByLabelText("Work Journal page") as HTMLElement & { editor: Editor };
  return dom.editor;
}

/** Renders a page with `text` and selects the text, as a drag over it would. */
function renderSelected(text: string): Editor {
  render(<WorkJournalEditor date="2026-10-15" initialBody={textBody(text)} />);
  const editor = pageEditor();
  act(() => {
    editor.commands.setTextSelection({ from: 1, to: 1 + text.length });
  });
  return editor;
}

/** The tick box of the first checklist item (TipTap renders one per item). */
function firstCheckbox(): HTMLInputElement {
  const box = screen
    .getByLabelText("Work Journal page")
    .querySelector<HTMLInputElement>('ul[data-type="taskList"] input[type="checkbox"]');
  if (!box) throw new Error("no checklist tick box rendered");
  return box;
}

function tool(name: string): HTMLElement {
  return within(screen.getByRole("toolbar", { name: "Formatting" })).getByRole("button", { name });
}

/** The marks on the first text node of the first block. */
function firstTextMarks(editor: Editor): JSONContent["marks"] {
  return editor.getJSON().content?.[0].content?.[0].marks;
}

describe("WorkJournalToolbar", () => {
  beforeEach(() => {
    useWorkJournalStore.setState({ updatePage: vi.fn(async () => {}) });
  });

  it("toggles bold on the selection and shows it as pressed", () => {
    const editor = renderSelected("Important");

    expect(tool("Bold")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(tool("Bold"));

    expect(firstTextMarks(editor)).toEqual([{ type: "bold" }]);
    expect(tool("Bold")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(tool("Bold"));
    expect(firstTextMarks(editor)).toBeUndefined();
  });

  it("turns the selection into a tick-box checklist", () => {
    const editor = renderSelected("Follow up");

    fireEvent.click(tool("Checklist"));

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "taskList",
      content: [{ type: "taskItem", attrs: { checked: false } }],
    });
    expect(firstCheckbox().checked).toBe(false);
    expect(tool("Checklist")).toHaveAttribute("aria-pressed", "true");
  });

  it("applies and clears a text colour from the palette", () => {
    const editor = renderSelected("Red flag");
    const red = WORK_JOURNAL_TEXT_COLORS.find((c) => c.name === "Red");

    fireEvent.click(tool("Text colour"));
    fireEvent.click(screen.getByRole("button", { name: "Text colour Red" }));

    expect(firstTextMarks(editor)).toEqual([
      { type: "textStyle", attrs: expect.objectContaining({ color: red?.value }) },
    ]);
    // The palette closes after a pick.
    expect(screen.queryByRole("group", { name: "Text colour options" })).toBeNull();

    fireEvent.click(tool("Text colour"));
    expect(screen.getByRole("button", { name: "Text colour Red" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Text colour none" }));
    expect(firstTextMarks(editor)).toBeUndefined();
  });

  it("applies and clears a highlight from the palette", () => {
    const editor = renderSelected("Waiting on review");
    const yellow = WORK_JOURNAL_HIGHLIGHT_COLORS.find((c) => c.name === "Yellow");

    fireEvent.click(tool("Highlight"));
    fireEvent.click(screen.getByRole("button", { name: "Highlight Yellow" }));

    expect(firstTextMarks(editor)).toEqual([
      { type: "textStyle", attrs: expect.objectContaining({ backgroundColor: yellow?.value }) },
    ]);

    fireEvent.click(tool("Highlight"));
    fireEvent.click(screen.getByRole("button", { name: "Highlight none" }));
    expect(firstTextMarks(editor)).toBeUndefined();
  });

  it("applies headings and lists", () => {
    const editor = renderSelected("Plan");

    fireEvent.click(tool("Heading 2"));
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    expect(tool("Heading 2")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(tool("Heading 2"));
    fireEvent.click(tool("Numbered list"));
    expect(editor.getJSON().content?.[0].type).toBe("orderedList");
  });

  it("sets a link from the inline address box and removes it", () => {
    const editor = renderSelected("Docs");

    fireEvent.click(tool("Link"));
    const input = screen.getByLabelText("Link address");
    fireEvent.change(input, { target: { value: "example.com/docs" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(firstTextMarks(editor)).toEqual([
      {
        type: "link",
        attrs: expect.objectContaining({ href: "https://example.com/docs" }),
      },
    ]);
    expect(screen.queryByLabelText("Link address")).toBeNull();

    fireEvent.click(tool("Link"));
    expect(screen.getByLabelText("Link address")).toHaveValue("https://example.com/docs");
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
    expect(firstTextMarks(editor)).toBeUndefined();
  });

  it("offers no font family or size controls", () => {
    renderSelected("Plain");

    const labels = within(screen.getByRole("toolbar", { name: "Formatting" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? "");
    expect(labels).toEqual([
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bullet list",
      "Numbered list",
      "Checklist",
      "Link",
      "Text colour",
      "Highlight",
    ]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText(/font/i)).toBeNull();
    // The editor itself cannot store font changes either.
    const commands = pageEditor().commands as unknown as Record<string, unknown>;
    expect(commands.setFontFamily).toBeUndefined();
    expect(commands.setFontSize).toBeUndefined();
  });
});
