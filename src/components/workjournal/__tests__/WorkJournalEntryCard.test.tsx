import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectColorFor, resolveProjectColors } from "@/lib/projectColor";
import { useWorkJournalStore } from "@/stores/useWorkJournalStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { WORK_JOURNAL_SAVE_DEBOUNCE_MS, WorkJournalEditor } from "../WorkJournalEditor";

// The workspace store (the open projects) persists through the Tauri store
// plugin; happy-dom has no Tauri backend, so stub it out.
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

const DATE = "2026-10-15";
const updatePage = vi.fn(async () => true);

function paragraph(text: string): JSONContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

/** A card as the page JSON stores it. */
function card(
  text: string,
  attrs: { time?: string | null; project?: string | null; source?: string } = {},
): JSONContent {
  return {
    type: "journalEntry",
    attrs: { time: "13:10", project: null, source: "typed", ...attrs },
    content: [text ? paragraph(text) : { type: "paragraph" }],
  };
}

function doc(...content: JSONContent[]): JSONContent {
  return { type: "doc", content };
}

/** The empty last line the editor keeps after a final card (TipTap's trailing node). */
const TRAILING: JSONContent = { type: "paragraph" };

/** Lets TipTap render card changes (its React node views mount through portals). */
async function settle(): Promise<void> {
  await act(async () => {});
}

function pageEditor(): Editor {
  const dom = screen.getByLabelText("Work Journal page") as HTMLElement & { editor: Editor };
  return dom.editor;
}

function cards(): HTMLElement[] {
  return Array.from(
    screen
      .getByLabelText("Work Journal page")
      .querySelectorAll<HTMLElement>('[data-type="journal-entry"]'),
  );
}

/** The bold lead of each card: the text the colon rule shows bold. */
function boldLeads(): string[] {
  return cards().map((el) =>
    Array.from(el.querySelectorAll(".work-journal-entry-lead"))
      .map((span) => span.textContent ?? "")
      .join(""),
  );
}

async function lastSavedBody(): Promise<JSONContent> {
  await act(async () => {
    vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
  });
  const calls = updatePage.mock.calls as unknown as Array<[string, { body: JSONContent }]>;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1].body;
}

/** Renders the page and lets TipTap mount the cards (React portals). */
async function renderPage(body: JSONContent): Promise<void> {
  render(<WorkJournalEditor date={DATE} initialBody={body} />);
  await settle();
}

describe("Work Journal entry cards", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 9, 15, 16, 7, 0));
    updatePage.mockClear();
    useWorkJournalStore.setState({ pages: {}, replacing: false, updatePage });
    useWorkspaceStore.setState({ tabs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the time bold, the project chip, the source tag and the text of each card", async () => {
    useWorkspaceStore.setState({ tabs: [{ name: "demo-shop" } as WorkspaceTab] });
    await renderPage(
      doc(
        paragraph("A free note"),
        card("Fixed the cart", { time: "13:10", project: "demo-shop", source: "pr" }),
        card("Planning call", { time: null, project: null, source: "granola" }),
      ),
    );

    const [first, second] = cards();
    const time = within(first).getByLabelText("Entry time");
    expect(time).toHaveValue("13:10");
    expect(time).toHaveClass("font-bold");
    const chip = within(first).getByRole("button", { name: /^Project demo-shop/ });
    expect(chip).toHaveStyle({ color: resolveProjectColors(["demo-shop"]).get("demo-shop") });
    expect(within(first).getByText("Git · PR")).toBeInTheDocument();
    expect(first).toHaveTextContent("Fixed the cart");

    expect(within(second).getByLabelText("Entry time")).toHaveValue("");
    const none = within(second).getByRole("button", { name: /^No project/ });
    expect(none).toHaveTextContent("no project");
    expect(none).toHaveClass("border-dashed");
    expect(within(second).getByText("Granola")).toBeInTheDocument();
  });

  it("shows bold exactly up to and including the first colon, or all the text without one", async () => {
    const texts = [
      ["Login fix: new rules and the PR merged", "Login fix:"],
      ["Call: notes: more", "Call:"],
      ["No colon at all", "No colon at all"],
      [": leading colon", ":"],
      ["Ends with a colon:", "Ends with a colon:"],
    ];
    await renderPage(doc(...texts.map(([text]) => card(text))));
    expect(boldLeads()).toEqual(texts.map(([, lead]) => lead));
  });

  it("moves the bold as the text changes and stores no bold mark", async () => {
    await renderPage(doc(card("Standup")));
    expect(boldLeads()).toEqual(["Standup"]);

    act(() => {
      // Inside the card (+1) and its paragraph (+1), after "Standup".
      pageEditor().chain().setTextSelection(9).insertContent(": agreed the date").run();
    });
    expect(boldLeads()).toEqual(["Standup:"]);
    expect(await lastSavedBody()).toEqual(doc(card("Standup: agreed the date"), TRAILING));
  });

  it("changes the time on Enter, pads it, and puts back a time that is not one", async () => {
    await renderPage(doc(card("Fixed the cart", { time: "13:10" })));
    const time = within(cards()[0]).getByLabelText("Entry time");

    fireEvent.change(time, { target: { value: "9:05" } });
    fireEvent.keyDown(time, { key: "Enter" });
    fireEvent.blur(time);
    expect(await lastSavedBody()).toEqual(doc(card("Fixed the cart", { time: "09:05" }), TRAILING));
    expect(time).toHaveValue("09:05");

    updatePage.mockClear();
    fireEvent.change(time, { target: { value: "25:99" } });
    fireEvent.blur(time);
    expect(time).toHaveValue("09:05");
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
    });
    expect(updatePage).not.toHaveBeenCalled();
  });

  it("picks another open project or none from the chip", async () => {
    const names = ["demo-shop", "demo-blog"];
    useWorkspaceStore.setState({ tabs: names.map((name) => ({ name }) as WorkspaceTab) });
    await renderPage(doc(card("Wrote notes", { project: "demo-notes" })));

    const chip = within(cards()[0]).getByRole("button", { name: /^Project demo-notes/ });
    // A project with no open tab keeps its stable colour.
    expect(chip).toHaveStyle({ color: projectColorFor("demo-notes") });
    fireEvent.click(chip);
    const menu = within(cards()[0]).getByRole("menu", { name: "Pick a project" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((b) => b.textContent),
    ).toEqual(["demo-shop", "demo-blog", "No project"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "demo-blog" }));
    expect(await lastSavedBody()).toEqual(
      doc(card("Wrote notes", { project: "demo-blog" }), TRAILING),
    );
    expect(within(cards()[0]).queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(within(cards()[0]).getByRole("button", { name: /^Project demo-blog/ }));
    fireEvent.click(within(cards()[0]).getByRole("menuitem", { name: "No project" }));
    expect(await lastSavedBody()).toEqual(doc(card("Wrote notes", { project: null }), TRAILING));
    expect(within(cards()[0]).getByRole("button", { name: /^No project/ })).toBeInTheDocument();
  });

  it("deletes a card with no question, and Ctrl+Z brings it back", async () => {
    const body = doc(paragraph("Note"), card("Fixed the cart"), paragraph("After"));
    await renderPage(body);

    fireEvent.click(within(cards()[0]).getByRole("button", { name: "Delete this entry" }));
    await settle();
    expect(cards()).toHaveLength(0);
    expect(await lastSavedBody()).toEqual(doc(paragraph("Note"), paragraph("After")));

    fireEvent.keyDown(pageEditor().view.dom, { key: "z", ctrlKey: true });
    await settle();
    expect(cards()).toHaveLength(1);
    expect(await lastSavedBody()).toEqual(body);
  });

  it("drags a card by its handle to between two free notes", async () => {
    await renderPage(doc(paragraph("First"), paragraph("Second"), card("Moved card")));
    const view = pageEditor().view;
    // Between "First" (positions 0-7) and "Second": happy-dom has no layout.
    vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 7, inside: -1 });

    const handle = within(cards()[0]).getByTitle("Drag to move this entry");
    expect(handle).toHaveAttribute("draggable", "true");
    expect(handle).toHaveAttribute("data-drag-handle");
    const dataTransfer = new DataTransfer();
    // happy-dom does not implement drag images.
    dataTransfer.setDragImage = vi.fn();
    // A real drag starts with a press on the handle.
    fireEvent.mouseDown(handle);
    fireEvent.dragStart(handle, { dataTransfer });
    fireEvent.drop(view.dom, { dataTransfer, clientX: 1, clientY: 1 });

    expect(await lastSavedBody()).toEqual(
      doc(paragraph("First"), card("Moved card"), paragraph("Second"), TRAILING),
    );
  });

  it("+ Add entry adds an empty Typed card stamped now, with the cursor in it", async () => {
    await renderPage(doc(paragraph("Standup"), { type: "paragraph" }));

    fireEvent.click(screen.getByRole("button", { name: "+ Add entry" }));

    // The trailing empty line is filled, not left blank above the card.
    expect(await lastSavedBody()).toEqual(
      doc(
        paragraph("Standup"),
        card("", { time: "16:07", project: null, source: "typed" }),
        TRAILING,
      ),
    );
    const { $from } = pageEditor().state.selection;
    expect($from.parent.type.name).toBe("paragraph");
    expect($from.node($from.depth - 1).type.name).toBe("journalEntry");
    expect(within(cards()[0]).getByText("Typed")).toBeInTheDocument();

    act(() => {
      pageEditor().commands.insertContent("Reviewed: the PR");
    });
    expect(await lastSavedBody()).toEqual(
      doc(paragraph("Standup"), card("Reviewed: the PR", { time: "16:07" }), TRAILING),
    );
  });

  it("Enter in a card's text starts a free note after the card", async () => {
    await renderPage(doc(card("Fixed the cart"), paragraph("Later")));
    act(() => {
      pageEditor().commands.setTextSelection(5);
    });
    fireEvent.keyDown(pageEditor().view.dom, { key: "Enter" });
    act(() => {
      pageEditor().commands.insertContent("A note");
    });
    expect(await lastSavedBody()).toEqual(
      doc(card("Fixed the cart"), paragraph("A note"), paragraph("Later")),
    );
  });

  it("the heading and list buttons leave a card whole", async () => {
    const body = doc(card("Fixed the cart"));
    await renderPage(body);
    act(() => {
      pageEditor().commands.setTextSelection(5);
    });
    for (const name of ["Heading 1", "Bullet list", "Checklist"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(cards()).toHaveLength(1);
      expect(pageEditor().getJSON().content?.[0].type).toBe("journalEntry");
    }
  });

  it("a page saved with cards reloads with the same cards, and nothing is saved", async () => {
    const body = doc(
      paragraph("08:55 - Standup: an old plain line"),
      card("Login fix: merged", { time: "13:10", project: "demo-shop", source: "pr" }),
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Afternoon" }] },
      card("Planning call", { time: null, project: null, source: "granola" }),
    );
    await renderPage(body);

    expect(pageEditor().getJSON()).toEqual(body);
    expect(cards()).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
    });
    expect(updatePage).not.toHaveBeenCalled();
  });

  it("an old page of plain lines stays plain lines, word for word", async () => {
    const body = doc(
      paragraph("08:55 - Standup: agreed the release goes out on Tuesday"),
      paragraph("09:40 - Reviewed the checkout PR and left two comments"),
    );
    await renderPage(body);

    expect(cards()).toHaveLength(0);
    expect(pageEditor().getJSON()).toEqual(body);
    expect(
      screen.getByLabelText("Work Journal page").querySelector(".work-journal-entry-lead"),
    ).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(WORK_JOURNAL_SAVE_DEBOUNCE_MS);
    });
    expect(updatePage).not.toHaveBeenCalled();
  });
});
