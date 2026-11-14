import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";
import { SPELLING_NOTE_MS, WorkJournalEditor } from "../WorkJournalEditor";
import { FIX_SPELLING_TITLE } from "../WorkJournalToolbar";

// The card's project chip reads the open projects from the workspace store,
// which persists through the Tauri store plugin; happy-dom has no backend.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return undefined;
    }
    async set() {}
    async save() {}
    async delete() {}
  },
}));

const invokeMock = vi.mocked(invoke);
const DATE = "2026-11-14";

function text(value: string, marks?: JSONContent["marks"]): JSONContent {
  return marks ? { type: "text", text: value, marks } : { type: "text", text: value };
}

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: "paragraph", content };
}

function card(value: string, attrs: { time: string | null; project: string | null }): JSONContent {
  return {
    type: "journalEntry",
    attrs: { ...attrs, source: "typed" },
    content: [paragraph(text(value))],
  };
}

function doc(...content: JSONContent[]): JSONContent {
  return { type: "doc", content };
}

function pageEditor(): Editor {
  const dom = screen.getByLabelText("Work Journal page") as HTMLElement & { editor: Editor };
  return dom.editor;
}

/** The empty last line the editor keeps after a final card (TipTap's trailing node). */
const TRAILING: JSONContent = { type: "paragraph" };

/** The text of each top-level block, a card's included. */
function blockTexts(): string[] {
  const texts: string[] = [];
  pageEditor().state.doc.forEach((block) => {
    texts.push(block.textContent);
  });
  return texts;
}

function fixButton(): HTMLElement {
  return within(screen.getByRole("toolbar", { name: "Formatting" })).getByRole("button", {
    name: "Fix spelling and grammar",
  });
}

/** The texts the last fix sent to Claude. */
function sentTexts(): string[] {
  const call = invokeMock.mock.calls.find(([command]) => command === "work_journal_fix_spelling");
  if (!call) throw new Error("no spelling fix was asked for");
  return (call[1] as { texts: string[] }).texts;
}

/** Answers the fix with `reply(texts)`. */
function answerWith(reply: (texts: string[]) => string[]): void {
  invokeMock.mockImplementation(async (command, args) =>
    command === "work_journal_fix_spelling"
      ? reply((args as { texts: string[] }).texts)
      : undefined,
  );
}

/** Each text with its typos fixed, the way a well-behaved model answers. */
function fixTypos(texts: string[]): string[] {
  return texts.map((t) =>
    t
      .replace("fixd", "fixed")
      .replace("teh", "the")
      .replace("Fixd", "Fixed")
      .replace("wiht", "with"),
  );
}

async function clickFix(): Promise<void> {
  await act(async () => {
    fireEvent.click(fixButton());
  });
}

describe("Work Journal spelling fixer", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useWorkJournalStore.setState({
      updatePage: vi.fn(async () => true),
      replacing: false,
      revision: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    useWorkJournalStore.setState({ pages: {} });
  });

  it("sits just left of + Add entry with its tooltip and shortcut", () => {
    render(<WorkJournalEditor date={DATE} initialBody={doc(paragraph(text("Hi")))} />);
    const button = fixButton();
    expect(button).toHaveAttribute("title", FIX_SPELLING_TITLE);
    expect(FIX_SPELLING_TITLE).toBe(
      "Fix spelling and grammar (selection, or the whole page)  Ctrl+Shift+F",
    );
    expect(button.nextElementSibling).toHaveTextContent("+ Add entry");
  });

  it("fixes the whole page, cards and free notes, when nothing is selected", async () => {
    answerWith(fixTypos);
    render(
      <WorkJournalEditor
        date={DATE}
        initialBody={doc(
          paragraph(text("I fixd teh login")),
          card("Release wiht notes", { time: "09:15", project: null }),
        )}
      />,
    );

    await clickFix();

    expect(sentTexts()).toEqual(["I fixd teh login", "Release wiht notes"]);
    expect(blockTexts()).toEqual(["I fixed the login", "Release with notes", ""]);
    expect(screen.getByRole("status")).toHaveTextContent("3 fixes made");
  });

  it("with a selection, sends and changes only the selected text", async () => {
    answerWith(fixTypos);
    render(
      <WorkJournalEditor
        date={DATE}
        initialBody={doc(paragraph(text("teh start")), paragraph(text("I fixd teh bug")))}
      />,
    );
    // "I fixd" in the second line: the paragraph starts at 11, its text at 12.
    act(() => {
      pageEditor().commands.setTextSelection({ from: 12, to: 18 });
    });

    await clickFix();

    expect(sentTexts()).toEqual(["I fixd"]);
    expect(blockTexts()).toEqual(["teh start", "I fixed teh bug"]);
    expect(screen.getByRole("status")).toHaveTextContent("1 fix made");
  });

  it("widens a selection that cuts a word to the whole word", async () => {
    answerWith(fixTypos);
    render(<WorkJournalEditor date={DATE} initialBody={doc(paragraph(text("I fixd the bug")))} />);
    // "I fixd th": the selection ends inside "the".
    act(() => {
      pageEditor().commands.setTextSelection({ from: 1, to: 10 });
    });

    await clickFix();

    expect(sentTexts()).toEqual(["I fixd the"]);
    expect(pageEditor().getText()).toBe("I fixed the bug");
    expect(screen.getByRole("status")).toHaveTextContent("1 fix made");
  });

  it("never rewrites a stretch of differently formatted text as one run", async () => {
    // Long enough that the word diff falls back to one change from the first
    // fix to the last, which would span the bold word.
    const filler = "work ".repeat(400);
    answerWith(fixTypos);
    render(
      <WorkJournalEditor
        date={DATE}
        initialBody={doc(
          paragraph(
            text(`I fixd ${filler}`),
            text("important", [{ type: "bold" }]),
            text(` ${filler}teh end`),
          ),
        )}
      />,
    );
    const before = pageEditor().getJSON();

    await clickFix();

    expect(sentTexts()).toHaveLength(1);
    expect(pageEditor().getJSON()).toEqual(before);
    expect(screen.getByRole("status")).toHaveTextContent("0 fixes made");
  });

  it("keeps times, links, the project and the card's bold split as they were", async () => {
    // A model that also rewrites what it must not touch.
    answerWith((texts) =>
      texts.map((t) =>
        t
          .replace("Fixd", "Fixed: the")
          .replace("10:30", "10.30")
          .replace("maestro", "Maestro")
          .replace("teh lnk", "the link")
          .replace("wiht", "with"),
      ),
    );
    const link = [{ type: "link", attrs: { href: "https://example.com" } }];
    render(
      <WorkJournalEditor
        date={DATE}
        initialBody={doc(
          card("Fixd login: deploy maestro at 10:30 wiht care", {
            time: "10:30",
            project: "maestro",
          }),
          paragraph(text("See "), text("teh lnk", link), text(" wiht notes")),
        )}
      />,
    );

    await clickFix();

    const [entry, note] = pageEditor().getJSON().content ?? [];
    // The colon is never sent, and a colon added before it is refused.
    expect(sentTexts()).toEqual([
      "Fixd login",
      "deploy maestro at 10:30 wiht care",
      "See teh lnk wiht notes",
    ]);
    expect(entry.attrs).toMatchObject({ time: "10:30", project: "maestro" });
    expect(entry.content?.[0].content?.[0].text).toBe(
      "Fixd login: deploy maestro at 10:30 with care",
    );
    expect(note.content).toEqual([
      text("See "),
      text("teh lnk", [
        { type: "link", attrs: expect.objectContaining({ href: "https://example.com" }) },
      ]),
      text(" with notes"),
    ]);
  });

  it("one undo puts the page back as it was", async () => {
    answerWith(fixTypos);
    const body = doc(
      paragraph(text("I fixd teh bug")),
      card("Fixd it", { time: "11:00", project: null }),
      TRAILING,
    );
    render(<WorkJournalEditor date={DATE} initialBody={body} />);
    const before = pageEditor().getJSON();

    await clickFix();
    expect(pageEditor().getJSON()).not.toEqual(before);

    act(() => {
      pageEditor().commands.undo();
    });
    expect(pageEditor().getJSON()).toEqual(before);
  });

  it("locks the page and spins the icon while it runs", async () => {
    let answer: (texts: string[]) => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve as (texts: string[]) => void;
        }),
    );
    render(<WorkJournalEditor date={DATE} initialBody={doc(paragraph(text("I fixd it")))} />);

    await clickFix();

    expect(pageEditor().isEditable).toBe(false);
    expect(fixButton()).toBeDisabled();
    expect(fixButton()).toHaveAttribute("aria-busy", "true");
    expect(fixButton().querySelector("svg")).toHaveClass("animate-spin");
    expect(screen.getByRole("button", { name: "Bold" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add entry/ })).toBeDisabled();
    expect(document.querySelector(".work-journal-editor")).toHaveAttribute("inert");

    await act(async () => {
      answer(["I fixed it"]);
    });

    expect(pageEditor().isEditable).toBe(true);
    expect(fixButton()).not.toBeDisabled();
    expect(document.querySelector(".work-journal-editor")).not.toHaveAttribute("inert");
    expect(pageEditor().getText()).toBe("I fixed it");
  });

  it("changes nothing and says why when the fix fails, then the line fades", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reasons = [
      "Claude Code is not installed or could not be started.",
      "Claude could not reach the network. Check your connection and try again.",
      "Claude could not fix the text: claude exited with exit code: 1: Invalid API key",
    ];
    const body = doc(paragraph(text("I fixd it")));
    render(<WorkJournalEditor date={DATE} initialBody={body} />);
    const before = pageEditor().getJSON();

    for (const reason of reasons) {
      invokeMock.mockRejectedValueOnce(reason);
      await clickFix();
      expect(pageEditor().getJSON()).toEqual(before);
      expect(pageEditor().isEditable).toBe(true);
      expect(screen.getByRole("status")).toHaveTextContent(`Not fixed: ${reason}`);
    }

    act(() => {
      vi.advanceTimersByTime(SPELLING_NOTE_MS);
    });
    expect(screen.getByRole("status")).toHaveClass("opacity-0");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("changes nothing on a reply of the wrong shape", async () => {
    const replies: unknown[] = [[], ["one", "two"], null, "I fixed it"];
    const body = doc(paragraph(text("I fixd it")));
    render(<WorkJournalEditor date={DATE} initialBody={body} />);
    const before = pageEditor().getJSON();

    for (const reply of replies) {
      invokeMock.mockResolvedValueOnce(reply);
      await clickFix();
      expect(pageEditor().getJSON()).toEqual(before);
      expect(screen.getByRole("status")).toHaveTextContent("Not fixed");
    }
  });

  it("refuses the whole reply when a text is rewritten rather than fixed", async () => {
    // Right length, wrong content: duplicated, swapped, rewritten or emptied.
    const replies = [
      ["I fixed the login", "I fixed the login"],
      ["Release with notes for the team", "I fixed the login"],
      ["I fixed the login", "Shipped the whole new billing system today"],
      ["I fixed the login", ""],
    ];
    const body = doc(
      paragraph(text("I fixd teh login")),
      paragraph(text("Release wiht notes for the team")),
    );
    render(<WorkJournalEditor date={DATE} initialBody={body} />);
    const before = pageEditor().getJSON();

    for (const reply of replies) {
      invokeMock.mockResolvedValueOnce(reply);
      await clickFix();
      expect(pageEditor().getJSON()).toEqual(before);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Not fixed: Claude's reply could not be read. Try again.",
      );
    }

    // Small fixes, a one-word typo and an added article still go through.
    invokeMock.mockResolvedValueOnce(["I fixed the login", "Release with the notes for the team"]);
    await clickFix();
    expect(blockTexts()).toEqual(["I fixed the login", "Release with the notes for the team"]);
  });

  it("changes nothing when the page changed while Claude was working", async () => {
    let answer: (texts: string[]) => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve as (texts: string[]) => void;
        }),
    );
    render(<WorkJournalEditor date={DATE} initialBody={doc(paragraph(text("I fixd it")))} />);
    await clickFix();

    // The other window's copy of the page lands meanwhile.
    act(() => {
      useWorkJournalStore.setState({
        pages: {
          [DATE]: {
            date: DATE,
            title: "Sat",
            body: doc(paragraph(text("New text"))),
            origin: "auto",
            rev: 2,
          },
        },
      });
    });
    await act(async () => {
      answer(["I fixed it"]);
    });

    expect(pageEditor().getText()).toBe("New text");
    expect(screen.getByRole("status")).toHaveTextContent("Not fixed: the page changed");
  });

  it("Ctrl+Shift+F in the page starts a fix", async () => {
    answerWith(fixTypos);
    render(<WorkJournalEditor date={DATE} initialBody={doc(paragraph(text("I fixd it")))} />);

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Work Journal page"), {
        key: "F",
        code: "KeyF",
        ctrlKey: true,
        shiftKey: true,
      });
    });

    expect(pageEditor().getText()).toBe("I fixed it");
  });

  it("asks nothing for a page with no words", async () => {
    render(<WorkJournalEditor date={DATE} initialBody={doc(paragraph(text("10:30 - 11:00")))} />);

    await clickFix();

    expect(invokeMock).not.toHaveBeenCalledWith("work_journal_fix_spelling", expect.anything());
    expect(screen.getByRole("status")).toHaveTextContent("0 fixes made");
  });
});
