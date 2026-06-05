import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Note } from "@/types/note";

// --- Tauri LazyStore-backed StateStorage adapter ---
// Same pattern as useQuickActionStore so notes persist across app restarts even
// when localStorage is cleared (Tauri's plugin-store writes to disk).

const lazyStore = new LazyStore("notes.json");

const tauriStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const value = await lazyStore.get<string>(name);
      return value ?? null;
    } catch (err) {
      console.error(`tauriStorage.getItem("${name}") failed:`, err);
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await lazyStore.set(name, value);
      await lazyStore.save();
    } catch (err) {
      console.error(`tauriStorage.setItem("${name}") failed:`, err);
      throw err;
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await lazyStore.delete(name);
      await lazyStore.save();
    } catch (err) {
      console.error(`tauriStorage.removeItem("${name}") failed:`, err);
      throw err;
    }
  },
};

// --- Store types ---

interface NotesState {
  notes: Note[];
  activeNoteId: string | null;
}

interface NotesActions {
  /** Create a note and select it. Returns the new note's id. */
  addManualNote: (title?: string) => string;
  /** Rename a note. Empty titles are refused. */
  renameNote: (id: string, title: string) => void;
  /** Update a note's body. */
  setContent: (id: string, content: string) => void;
  /** Delete a note (and clear active selection if it was active). */
  deleteNote: (id: string) => void;
  /** Switch the active tab. */
  setActiveNote: (id: string | null) => void;
  /** Move a note to a new position in the tab strip (drag-reorder). */
  moveNote: (id: string, toIndex: number) => void;
}

export type NotesStore = NotesState & NotesActions;

// --- Store ---

export const useNotesStore = create<NotesStore>()(
  persist(
    (set, get) => ({
      notes: [],
      activeNoteId: null,

      addManualNote: (title) => {
        const now = Date.now();
        // Pick a unique fallback title like "Note", "Note 2", ...
        const trimmed = (title ?? "").trim();
        const baseTitle = trimmed.length > 0 ? trimmed : nextManualTitle(get().notes);
        const id = makeId();
        const note: Note = {
          id,
          title: baseTitle,
          content: "",
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({ notes: [...s.notes, note], activeNoteId: id }));
        return id;
      },

      renameNote: (id, title) => {
        const clean = title.trim();
        if (clean.length === 0) return; // refuse empty titles
        set((s) => ({
          notes: s.notes.map((n) =>
            n.id === id ? { ...n, title: clean, updatedAt: Date.now() } : n,
          ),
        }));
      },

      setContent: (id, content) => {
        set((s) => ({
          notes: s.notes.map((n) => (n.id === id ? { ...n, content, updatedAt: Date.now() } : n)),
        }));
      },

      deleteNote: (id) => {
        set((s) => {
          const remaining = s.notes.filter((n) => n.id !== id);
          let nextActive = s.activeNoteId;
          if (s.activeNoteId === id) {
            nextActive = remaining[0]?.id ?? null;
          }
          return { notes: remaining, activeNoteId: nextActive };
        });
      },

      setActiveNote: (id) => set({ activeNoteId: id }),

      moveNote: (id, toIndex) => {
        set((s) => {
          const from = s.notes.findIndex((n) => n.id === id);
          if (from < 0) return s;
          const to = Math.max(0, Math.min(toIndex, s.notes.length - 1));
          if (to === from) return s;
          const next = [...s.notes];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return { ...s, notes: next };
        });
      },
    }),
    {
      name: "maestro-notes",
      storage: createJSONStorage(() => tauriStorage),
      // Persist notes and the active selection; nothing else worth storing.
      partialize: (state) => ({
        notes: state.notes,
        activeNoteId: state.activeNoteId,
      }),
      version: 2,
      // v1 notes carried session-binding fields (boundSessionId,
      // manuallyRenamed) from the era of auto-created per-session notes.
      // Strip them — the notes themselves (title/content) are kept.
      migrate: (persisted) => {
        const state = persisted as {
          notes?: Array<Note & { boundSessionId?: number; manuallyRenamed?: boolean }>;
          activeNoteId?: string | null;
        };
        return {
          notes: (state.notes ?? []).map(
            ({ boundSessionId: _b, manuallyRenamed: _m, ...note }) => note,
          ),
          activeNoteId: state.activeNoteId ?? null,
        };
      },
    },
  ),
);

// --- Helpers ---

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `note-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Returns the next available "Note", "Note 2", "Note 3"... title to avoid
 * collisions in the tab strip. Cheap and good enough for short lists.
 */
function nextManualTitle(notes: Note[]): string {
  const taken = new Set(notes.map((n) => n.title));
  if (!taken.has("Note")) return "Note";
  for (let i = 2; i < 1000; i++) {
    const candidate = `Note ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `Note ${Date.now()}`;
}
