import { beforeEach, describe, expect, it, vi } from "vitest";

// Tauri plugin-store must be mocked before importing the store module.
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { useNotesStore } from "../useNotesStore";

function reset() {
  useNotesStore.setState({ notes: [], activeNoteId: null });
}

describe("useNotesStore", () => {
  beforeEach(() => {
    reset();
  });

  it("addManualNote creates a note and selects it", () => {
    const id = useNotesStore.getState().addManualNote();
    const state = useNotesStore.getState();
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].id).toBe(id);
    expect(state.notes[0].title).toBe("Note");
    expect(state.activeNoteId).toBe(id);
  });

  it("addManualNote picks a unique fallback title", () => {
    useNotesStore.getState().addManualNote();
    useNotesStore.getState().addManualNote();
    useNotesStore.getState().addManualNote();
    const titles = useNotesStore.getState().notes.map((n) => n.title);
    expect(titles).toEqual(["Note", "Note 2", "Note 3"]);
  });

  it("addManualNote with a custom title uses it", () => {
    const id = useNotesStore.getState().addManualNote("Shopping list");
    expect(useNotesStore.getState().notes.find((n) => n.id === id)?.title).toBe("Shopping list");
  });

  it("renameNote updates the title", () => {
    const id = useNotesStore.getState().addManualNote();
    useNotesStore.getState().renameNote(id, "Renamed");
    expect(useNotesStore.getState().notes.find((n) => n.id === id)?.title).toBe("Renamed");
  });

  it("renameNote refuses empty titles", () => {
    const id = useNotesStore.getState().addManualNote("keep");
    useNotesStore.getState().renameNote(id, "   ");
    expect(useNotesStore.getState().notes.find((n) => n.id === id)?.title).toBe("keep");
  });

  it("setContent updates body and timestamp", () => {
    const id = useNotesStore.getState().addManualNote();
    const before = useNotesStore.getState().notes[0].updatedAt;
    // tick the clock to ensure timestamp inequality
    vi.spyOn(Date, "now").mockReturnValue(before + 1000);
    try {
      useNotesStore.getState().setContent(id, "hello");
    } finally {
      vi.restoreAllMocks();
    }
    const note = useNotesStore.getState().notes.find((n) => n.id === id)!;
    expect(note.content).toBe("hello");
    expect(note.updatedAt).toBe(before + 1000);
  });

  it("deleteNote drops the note and advances active selection", () => {
    const a = useNotesStore.getState().addManualNote();
    const b = useNotesStore.getState().addManualNote();
    useNotesStore.getState().setActiveNote(a);
    useNotesStore.getState().deleteNote(a);
    const state = useNotesStore.getState();
    expect(state.notes.map((n) => n.id)).toEqual([b]);
    expect(state.activeNoteId).toBe(b);
  });

  it("deleteNote clears active when no notes remain", () => {
    const a = useNotesStore.getState().addManualNote();
    useNotesStore.getState().deleteNote(a);
    expect(useNotesStore.getState().activeNoteId).toBeNull();
  });

  it("deleted notes stay deleted (no auto-recreation)", () => {
    const a = useNotesStore.getState().addManualNote("ephemeral");
    useNotesStore.getState().deleteNote(a);
    expect(useNotesStore.getState().notes).toHaveLength(0);
    // The store exposes no session-sync API anymore — nothing can bring
    // a deleted note back except the user creating a new one.
    expect(
      (useNotesStore.getState() as Record<string, unknown>).syncWithSessions,
    ).toBeUndefined();
  });

  describe("moveNote", () => {
    function makeThree(): [string, string, string] {
      const a = useNotesStore.getState().addManualNote("A");
      const b = useNotesStore.getState().addManualNote("B");
      const c = useNotesStore.getState().addManualNote("C");
      return [a, b, c];
    }

    it("moves a note forward", () => {
      const [a] = makeThree();
      useNotesStore.getState().moveNote(a, 2);
      expect(useNotesStore.getState().notes.map((n) => n.title)).toEqual(["B", "C", "A"]);
    });

    it("moves a note backward", () => {
      const [, , c] = makeThree();
      useNotesStore.getState().moveNote(c, 0);
      expect(useNotesStore.getState().notes.map((n) => n.title)).toEqual(["C", "A", "B"]);
    });

    it("clamps out-of-range targets", () => {
      const [a] = makeThree();
      useNotesStore.getState().moveNote(a, 99);
      expect(useNotesStore.getState().notes.map((n) => n.title)).toEqual(["B", "C", "A"]);
      useNotesStore.getState().moveNote(a, -5);
      expect(useNotesStore.getState().notes.map((n) => n.title)).toEqual(["A", "B", "C"]);
    });

    it("is a no-op for unknown ids or same index", () => {
      makeThree();
      const before = useNotesStore.getState().notes;
      useNotesStore.getState().moveNote("nope", 1);
      expect(useNotesStore.getState().notes).toBe(before);
      useNotesStore.getState().moveNote(before[1].id, 1);
      expect(useNotesStore.getState().notes).toBe(before);
    });

    it("does not change which note is active", () => {
      const [a, b] = makeThree();
      useNotesStore.getState().setActiveNote(b);
      useNotesStore.getState().moveNote(a, 2);
      expect(useNotesStore.getState().activeNoteId).toBe(b);
    });
  });
});
