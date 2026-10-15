import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";
import {
  canReadWorkJournalBody,
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
