import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";
import { WorkJournalEditor } from "../WorkJournalEditor";
import {
  normalizeLinkHref,
  WORK_JOURNAL_HIGHLIGHT_COLORS,
  WORK_JOURNAL_TEXT_COLORS,
} from "../WorkJournalToolbar";

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

  it("removes a link when the address is emptied and applied", () => {
    const editor = renderSelected("Docs");
    act(() => {
      editor.chain().setLink({ href: "https://example.com" }).run();
    });

    fireEvent.click(tool("Link"));
    const input = screen.getByLabelText("Link address");
    expect(input).toHaveValue("https://example.com");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(firstTextMarks(editor)).toBeUndefined();
    expect(screen.queryByLabelText("Link address")).toBeNull();
  });

  it("keeps the address box open with the typed value when the link is rejected", () => {
    const editor = renderSelected("Bad");

    fireEvent.click(tool("Link"));
    const input = screen.getByLabelText("Link address");
    fireEvent.change(input, { target: { value: "javascript://alert(1)" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(firstTextMarks(editor)).toBeUndefined();
    expect(screen.getByLabelText("Link address")).toHaveValue("javascript://alert(1)");
    expect(screen.getByText("That address cannot be a link.")).toBeInTheDocument();
  });

  it("disables Apply when there is no text to link", () => {
    render(<WorkJournalEditor date="2026-10-15" initialBody={textBody("Caret only")} />);
    act(() => {
      pageEditor().commands.setTextSelection(3);
    });

    fireEvent.click(tool("Link"));
    fireEvent.change(screen.getByLabelText("Link address"), { target: { value: "example.com" } });

    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByText("Select some text to link.")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Enter" });
    expect(screen.getByLabelText("Link address")).toHaveValue("example.com");
    expect(JSON.stringify(pageEditor().getJSON())).not.toContain("link");
  });

  it("closes the address box and the swatch rows on Escape", () => {
    renderSelected("Esc");

    fireEvent.click(tool("Link"));
    fireEvent.keyDown(screen.getByLabelText("Link address"), { key: "Escape" });
    expect(screen.queryByLabelText("Link address")).toBeNull();

    fireEvent.click(tool("Text colour"));
    expect(tool("Text colour")).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("button", { name: "Text colour Red" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Text colour options" })).toBeNull();
    expect(tool("Text colour")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(tool("Highlight"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Highlight none" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Highlight options" })).toBeNull();
  });

  it("reports the row buttons as expanded and the None swatch as pressed", () => {
    renderSelected("Aria");

    expect(tool("Highlight")).toHaveAttribute("aria-expanded", "false");
    expect(tool("Highlight")).not.toHaveAttribute("aria-pressed");
    fireEvent.click(tool("Highlight"));
    expect(screen.getByRole("button", { name: "Highlight none" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Highlight Yellow" }));
    fireEvent.click(tool("Highlight"));
    expect(screen.getByRole("button", { name: "Highlight none" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
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

describe("normalizeLinkHref", () => {
  it("adds https:// unless the address has a scheme with // or is mailto:", () => {
    expect(normalizeLinkHref("example.com")).toBe("https://example.com");
    expect(normalizeLinkHref("localhost:3000")).toBe("https://localhost:3000");
    expect(normalizeLinkHref("example.com:8080/x")).toBe("https://example.com:8080/x");
    expect(normalizeLinkHref(" http://example.com ")).toBe("http://example.com");
    expect(normalizeLinkHref("mailto:me@example.com")).toBe("mailto:me@example.com");
  });
});

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("text colour palette", () => {
  // Page and pane backgrounds of the dark and light themes (globals.css).
  const BACKGROUNDS = ["#0d0d10", "#121316", "#f6f6f8", "#ffffff"];

  it("keeps at least 3:1 contrast on both themes, since colours are stored as fixed values", () => {
    for (const { name, value } of WORK_JOURNAL_TEXT_COLORS) {
      for (const bg of BACKGROUNDS) {
        expect(contrast(value, bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
