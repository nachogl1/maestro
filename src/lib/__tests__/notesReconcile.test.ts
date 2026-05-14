import { describe, expect, it } from "vitest";
import { defaultTitleForSession, reconcileNotesWithSessions } from "@/lib/notesReconcile";
import type { Note } from "@/types/note";

const FIXED_NOW = 1_700_000_000_000;

function note(partial: Partial<Note> & Pick<Note, "id">): Note {
  return {
    title: partial.title ?? "Note",
    content: partial.content ?? "",
    createdAt: partial.createdAt ?? 1,
    updatedAt: partial.updatedAt ?? 1,
    ...partial,
  };
}

describe("defaultTitleForSession", () => {
  it("uses the session name when set", () => {
    expect(defaultTitleForSession({ id: 1, name: "build" })).toBe("build");
  });

  it("falls back to #id when name is null", () => {
    expect(defaultTitleForSession({ id: 7, name: null })).toBe("#7");
  });

  it("falls back to #id when name is empty/whitespace", () => {
    expect(defaultTitleForSession({ id: 9, name: "   " })).toBe("#9");
    expect(defaultTitleForSession({ id: 9, name: "" })).toBe("#9");
  });
});

describe("reconcileNotesWithSessions", () => {
  it("returns null when nothing changed", () => {
    const notes: Note[] = [note({ id: "a", title: "build", boundSessionId: 1, content: "x" })];
    const result = reconcileNotesWithSessions(notes, [{ id: 1, name: "build" }], FIXED_NOW);
    expect(result).toBeNull();
  });

  it("auto-creates a note for a brand-new session", () => {
    const result = reconcileNotesWithSessions([], [{ id: 42, name: "deploy" }], FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({
      title: "deploy",
      boundSessionId: 42,
      content: "",
      manuallyRenamed: false,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    });
    expect(typeof result![0].id).toBe("string");
    expect(result![0].id.length).toBeGreaterThan(0);
  });

  it("does not create duplicate notes when a session already has one", () => {
    const existing: Note[] = [note({ id: "a", title: "deploy", boundSessionId: 42 })];
    const result = reconcileNotesWithSessions(existing, [{ id: 42, name: "deploy" }], FIXED_NOW);
    expect(result).toBeNull();
  });

  it("updates the title when a bound session is renamed (and not manually renamed)", () => {
    const existing: Note[] = [
      note({ id: "a", title: "deploy", boundSessionId: 42, manuallyRenamed: false }),
    ];
    const result = reconcileNotesWithSessions(existing, [{ id: 42, name: "ship-it" }], FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result![0].title).toBe("ship-it");
    expect(result![0].updatedAt).toBe(FIXED_NOW);
    expect(result![0].boundSessionId).toBe(42);
  });

  it("does NOT update the title when the user manually renamed the note", () => {
    const existing: Note[] = [
      note({
        id: "a",
        title: "my custom name",
        boundSessionId: 42,
        manuallyRenamed: true,
      }),
    ];
    const result = reconcileNotesWithSessions(existing, [{ id: 42, name: "ship-it" }], FIXED_NOW);
    // Nothing should change.
    expect(result).toBeNull();
  });

  it("unbinds a note when its bound session disappears (keeps content)", () => {
    const existing: Note[] = [
      note({
        id: "a",
        title: "deploy",
        boundSessionId: 42,
        content: "important notes",
      }),
    ];
    const result = reconcileNotesWithSessions(existing, [], FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].boundSessionId).toBeUndefined();
    expect(result![0].content).toBe("important notes");
    expect(result![0].title).toBe("deploy"); // title preserved
    expect(result![0].updatedAt).toBe(FIXED_NOW);
  });

  it("does NOT re-bind an unbound note to a new session with the same id", () => {
    // Note was previously bound to session 42, which disappeared and got
    // unbound. A new session #42 (different terminal) appearing should get a
    // fresh note, not steal the orphaned one.
    const existing: Note[] = [
      note({ id: "a", title: "deploy", content: "old data" }), // no boundSessionId
    ];
    const result = reconcileNotesWithSessions(
      existing,
      [{ id: 42, name: "fresh-task" }],
      FIXED_NOW,
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result!.find((n) => n.id === "a")?.boundSessionId).toBeUndefined();
    const fresh = result!.find((n) => n.id !== "a");
    expect(fresh).toBeDefined();
    expect(fresh!.boundSessionId).toBe(42);
    expect(fresh!.title).toBe("fresh-task");
  });

  it("does not touch manual (never-bound) notes", () => {
    const existing: Note[] = [note({ id: "scratchpad", title: "Scratchpad", content: "todos..." })];
    const result = reconcileNotesWithSessions(existing, [], FIXED_NOW);
    expect(result).toBeNull();
  });

  it("handles multiple simultaneous changes", () => {
    const existing: Note[] = [
      note({
        id: "a",
        title: "old",
        boundSessionId: 1,
        manuallyRenamed: false,
      }), // bound + will be renamed
      note({ id: "b", title: "gone", boundSessionId: 99 }), // bound + session removed
      note({ id: "c", title: "manual", content: "stays" }), // pure manual
    ];
    const result = reconcileNotesWithSessions(
      existing,
      [
        { id: 1, name: "renamed" }, // existing session renamed
        { id: 2, name: "new-one" }, // fresh session → should auto-create
      ],
      FIXED_NOW,
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(4);

    const a = result!.find((n) => n.id === "a")!;
    expect(a.title).toBe("renamed");
    expect(a.boundSessionId).toBe(1);

    const b = result!.find((n) => n.id === "b")!;
    expect(b.boundSessionId).toBeUndefined();
    expect(b.title).toBe("gone");

    const c = result!.find((n) => n.id === "c")!;
    expect(c).toEqual(existing[2]); // untouched

    const fresh = result!.find((n) => n.boundSessionId === 2 && n.title === "new-one");
    expect(fresh).toBeDefined();
  });

  it("uses #id fallback when auto-creating a note for an unnamed session", () => {
    const result = reconcileNotesWithSessions([], [{ id: 5, name: null }], FIXED_NOW);
    expect(result).not.toBeNull();
    expect(result![0].title).toBe("#5");
  });
});
