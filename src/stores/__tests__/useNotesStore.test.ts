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
    expect(state.notes[0].boundSessionId).toBeUndefined();
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

  it("renameNote sets manuallyRenamed by default", () => {
    const id = useNotesStore.getState().addManualNote();
    useNotesStore.getState().renameNote(id, "Renamed");
    const note = useNotesStore.getState().notes.find((n) => n.id === id)!;
    expect(note.title).toBe("Renamed");
    expect(note.manuallyRenamed).toBe(true);
  });

  it("renameNote with manual=false leaves manuallyRenamed alone (sync use)", () => {
    const id = useNotesStore.getState().addManualNote();
    useNotesStore.getState().renameNote(id, "Auto", false);
    const note = useNotesStore.getState().notes.find((n) => n.id === id)!;
    expect(note.title).toBe("Auto");
    expect(note.manuallyRenamed).toBeFalsy();
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

  it("syncWithSessions auto-creates notes for new sessions and selects the first", () => {
    useNotesStore.getState().syncWithSessions([{ id: 1, name: "build" }]);
    const state = useNotesStore.getState();
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].boundSessionId).toBe(1);
    expect(state.notes[0].title).toBe("build");
    expect(state.activeNoteId).toBe(state.notes[0].id);
  });

  it("syncWithSessions renames a bound note when the session is renamed", () => {
    useNotesStore.getState().syncWithSessions([{ id: 1, name: "build" }]);
    useNotesStore.getState().syncWithSessions([{ id: 1, name: "shipping" }]);
    const note = useNotesStore.getState().notes[0];
    expect(note.title).toBe("shipping");
    expect(note.manuallyRenamed).toBe(false);
  });

  it("syncWithSessions does not rename a note that was manually renamed", () => {
    useNotesStore.getState().syncWithSessions([{ id: 1, name: "build" }]);
    const id = useNotesStore.getState().notes[0].id;
    useNotesStore.getState().renameNote(id, "My Custom Tab");
    useNotesStore.getState().syncWithSessions([{ id: 1, name: "shipping" }]);
    expect(useNotesStore.getState().notes[0].title).toBe("My Custom Tab");
  });

  it("syncWithSessions unbinds notes when their session disappears but keeps them", () => {
    useNotesStore.getState().syncWithSessions([{ id: 1, name: "build" }]);
    const id = useNotesStore.getState().notes[0].id;
    useNotesStore.getState().setContent(id, "important");
    useNotesStore.getState().syncWithSessions([]);
    const state = useNotesStore.getState();
    expect(state.notes).toHaveLength(1);
    expect(state.notes[0].boundSessionId).toBeUndefined();
    expect(state.notes[0].content).toBe("important");
  });

  it("syncWithSessions preserves the user's active selection", () => {
    // Two sessions → two notes
    useNotesStore.getState().syncWithSessions([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    const ids = useNotesStore.getState().notes.map((n) => n.id);
    useNotesStore.getState().setActiveNote(ids[1]);
    // Rename session 1 — should not change active selection.
    useNotesStore.getState().syncWithSessions([
      { id: 1, name: "renamed" },
      { id: 2, name: "b" },
    ]);
    expect(useNotesStore.getState().activeNoteId).toBe(ids[1]);
  });

  it("syncWithSessions is a no-op when nothing changes (does not bump state)", () => {
    useNotesStore.getState().syncWithSessions([{ id: 1, name: "build" }]);
    const before = useNotesStore.getState().notes;
    useNotesStore.getState().syncWithSessions([{ id: 1, name: "build" }]);
    const after = useNotesStore.getState().notes;
    // Same array reference — store skipped the write.
    expect(after).toBe(before);
  });
});
