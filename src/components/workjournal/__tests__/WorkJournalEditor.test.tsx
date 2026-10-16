import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_PAGE_BODY, useWorkJournalStore } from "@/stores/useWorkJournalStore";
import {
  canReadWorkJournalBody,
  stripForeignPastedColors,
  WORK_JOURNAL_SAVE_DEBOUNCE_MS,
  WorkJournalEditor,
} from "../WorkJournalEditor";

const updatePage = vi.fn(async () => {});

/** A page with one paragraph of plain text. */
function textBody(text: string): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

/** The TipTap editor behind the page body (TipTap puts it on its DOM node). */
function pageEditor(): Editor {
  const dom = screen.getByLabelText("Work Journal page") as HTMLElement & { editor: Editor };
  return dom.editor;
}

/** The tick box of the first checklist item (TipTap renders one per item). */
function firstCheckbox(): HTMLInputElement {
  const box = screen
    .getByLabelText("Work Journal page")
    .querySelector<HTMLInputElement>('ul[data-type="taskList"] input[type="checkbox"]');
  if (!box) throw new Error("no checklist tick box rendered");
  return box;
}

/** Waits out the save debounce and returns the last body sent to the store. */
async function lastSavedBody(): Promise<JSONContent> {
  await act(async () => {
    vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
  });
  const calls = updatePage.mock.calls as unknown as Array<[string, { body: JSONContent }]>;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1].body;
}

describe("WorkJournalEditor and the other window's changes", () => {
  afterEach(() => {
    useWorkJournalStore.setState({ pages: {} });
  });

  it("keeps the caret where it was when the other window changes the body", () => {
    const date = "2026-10-21";
    const page = { date, title: "Wed", body: textBody("Hello world"), origin: "auto" as const };
    useWorkJournalStore.setState({ pages: { [date]: { ...page, rev: 1 } } });
    render(<WorkJournalEditor date={date} initialBody={page.body} />);
    act(() => {
      pageEditor().commands.setTextSelection(3);
    });

    act(() => {
      useWorkJournalStore.setState({
        pages: { [date]: { ...page, body: textBody("Hello world, and more"), rev: 2 } },
      });
    });

    expect(pageEditor().getText()).toBe("Hello world, and more");
    expect(pageEditor().state.selection.from).toBe(3);
    expect(pageEditor().state.selection.to).toBe(3);

    // Shorter text: the caret moves back to its end (after "Hi"), never past it.
    act(() => {
      pageEditor().commands.setTextSelection(20);
      useWorkJournalStore.setState({
        pages: { [date]: { ...page, body: textBody("Hi"), rev: 3 } },
      });
    });
    expect(pageEditor().state.selection.from).toBe(3);
  });

  it("sends the rev of the copy its text was made on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const date = "2026-10-21";
      const page = { date, title: "Wed", body: textBody("Hello"), origin: "auto" as const };
      const save = vi.fn(async () => true);
      useWorkJournalStore.setState({ pages: { [date]: { ...page, rev: 4 } }, updatePage: save });
      render(<WorkJournalEditor date={date} initialBody={page.body} />);
      act(() => {
        useWorkJournalStore.setState({
          pages: { [date]: { ...page, body: textBody("Hello there"), rev: 5 } },
        });
      });

      act(() => {
        pageEditor().commands.insertContent("!");
      });
      await act(async () => {
        vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
      });
      expect(save).toHaveBeenCalledWith(date, { body: expect.anything() }, 5);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WorkJournalEditor formatting", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    updatePage.mockClear();
    useWorkJournalStore.setState({ updatePage });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves a text colour as a textStyle mark with a color attribute", async () => {
    render(<WorkJournalEditor date="2026-10-15" initialBody={textBody("Shipped")} />);

    act(() => {
      pageEditor().chain().selectAll().setColor("#ef4444").run();
    });

    expect(await lastSavedBody()).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Shipped",
              marks: [{ type: "textStyle", attrs: expect.objectContaining({ color: "#ef4444" }) }],
            },
          ],
        },
      ],
    });
  });

  it("saves a highlight as a textStyle mark with a backgroundColor attribute", async () => {
    render(<WorkJournalEditor date="2026-10-15" initialBody={textBody("Blocked")} />);

    act(() => {
      pageEditor().chain().selectAll().setBackgroundColor("rgba(234, 179, 8, 0.35)").run();
    });

    const text = (await lastSavedBody()).content?.[0].content?.[0];
    expect(text?.marks).toEqual([
      {
        type: "textStyle",
        attrs: expect.objectContaining({ backgroundColor: "rgba(234, 179, 8, 0.35)" }),
      },
    ]);
  });

  it("saves a tick in a checklist as a taskItem with checked true", async () => {
    render(<WorkJournalEditor date="2026-10-15" initialBody={textBody("Write tests")} />);

    act(() => {
      pageEditor().chain().selectAll().toggleTaskList().run();
    });
    const unticked = await lastSavedBody();
    expect(unticked.content?.[0]).toMatchObject({
      type: "taskList",
      content: [{ type: "taskItem", attrs: { checked: false } }],
    });
    updatePage.mockClear();

    const checkbox = firstCheckbox();
    expect(checkbox.checked).toBe(false);
    act(() => {
      checkbox.checked = true;
      fireEvent.change(checkbox);
    });

    // The editor keeps an empty paragraph after a trailing list; only the list matters here.
    expect((await lastSavedBody()).content?.[0]).toEqual({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Write tests" }] }],
        },
      ],
    });
  });

  it("loads a saved page with colour, highlight and a ticked checklist for editing", () => {
    const body: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Red on yellow",
              marks: [
                {
                  type: "textStyle",
                  attrs: { color: "#ef4444", backgroundColor: "rgba(234, 179, 8, 0.35)" },
                },
              ],
            },
          ],
        },
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }],
            },
          ],
        },
      ],
    };
    render(<WorkJournalEditor date="2026-10-15" initialBody={body} />);

    expect(screen.queryByLabelText("Unreadable Work Journal page")).toBeNull();
    expect(firstCheckbox().checked).toBe(true);
    const styled = screen.getByText("Red on yellow");
    expect(styled.style.color).not.toBe("");
    expect(styled.style.backgroundColor).not.toBe("");
  });
});

describe("WorkJournalEditor paste", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    updatePage.mockClear();
    useWorkJournalStore.setState({ updatePage });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops text and background colours copied from elsewhere, keeping other formatting", async () => {
    render(<WorkJournalEditor date="2026-10-15" initialBody={EMPTY_PAGE_BODY} />);

    act(() => {
      pageEditor().view.pasteHTML(
        '<p><span style="color: rgb(31, 35, 40); background-color: rgb(255, 255, 255); ' +
          'font-weight: 700">Copied</span> <span style="background: white">boxed</span></p>',
      );
    });

    const saved = JSON.stringify(await lastSavedBody());
    expect(saved).toContain("Copied");
    expect(saved).toContain("boxed");
    expect(saved).not.toContain("textStyle");
    expect(saved).not.toContain("rgb(");
    expect(saved).not.toContain("white");
    expect(saved).toContain('"type":"bold"');
  });

  it("keeps the toolbar's own colours when pasting between pages", async () => {
    render(<WorkJournalEditor date="2026-10-15" initialBody={EMPTY_PAGE_BODY} />);

    act(() => {
      pageEditor().view.pasteHTML(
        '<p><span style="color: #dc2626; background-color: rgba(234, 179, 8, 0.35)">Ours</span></p>',
      );
    });

    const text = (await lastSavedBody()).content?.[0].content?.[0];
    expect(text?.marks).toEqual([
      {
        type: "textStyle",
        attrs: expect.objectContaining({
          color: "#dc2626",
          backgroundColor: "rgba(234, 179, 8, 0.35)",
        }),
      },
    ]);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
  ])("drops a pasted link to %s, keeping its text", async (href) => {
    render(<WorkJournalEditor date="2026-10-15" initialBody={EMPTY_PAGE_BODY} />);

    act(() => {
      pageEditor().view.pasteHTML(`<p>Before <a href="${href}">x</a> after</p>`);
    });

    const saved = JSON.stringify(await lastSavedBody());
    expect(saved).toContain("Before x after");
    expect(saved).not.toContain('"type":"link"');
    expect(saved).not.toContain(href.slice(0, href.indexOf(":") + 1));
    expect(screen.getByLabelText("Work Journal page").querySelector("a")).toBeNull();
  });

  it("keeps a pasted https link", async () => {
    render(<WorkJournalEditor date="2026-10-15" initialBody={EMPTY_PAGE_BODY} />);

    act(() => {
      pageEditor().view.pasteHTML('<p><a href="https://example.com/">safe</a></p>');
    });

    const saved = JSON.stringify(await lastSavedBody());
    expect(saved).toContain('"type":"link"');
    expect(saved).toContain("https://example.com/");
  });

  it("strips only the colour declarations from a style attribute", () => {
    expect(
      stripForeignPastedColors(
        '<span style="color: red; font-style: italic; background-color: #fff">x</span>',
      ),
    ).toBe('<span style=" font-style: italic">x</span>');
    expect(stripForeignPastedColors('<span style="color: red">x</span>')).toBe("<span>x</span>");
  });
});

describe("canReadWorkJournalBody", () => {
  it("accepts colour and highlight marks and nested checklists", () => {
    expect(
      canReadWorkJournalBody({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Styled",
                marks: [{ type: "textStyle", attrs: { color: "#3b82f6" } }, { type: "bold" }],
              },
            ],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
                  {
                    type: "taskList",
                    content: [
                      {
                        type: "taskItem",
                        attrs: { checked: true },
                        content: [
                          { type: "paragraph", content: [{ type: "text", text: "Child" }] },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("still rejects marks this build does not know", () => {
    expect(
      canReadWorkJournalBody({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Newer", marks: [{ type: "highlight" }] }],
          },
        ],
      }),
    ).toBe(false);
  });
});
