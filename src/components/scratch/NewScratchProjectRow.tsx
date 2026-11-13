import { Plus } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { defaultScratchName } from "@/lib/scratch";
import { useScratchStore } from "@/stores/useScratchStore";

interface NewScratchProjectRowProps {
  /** The scratch project was made: open it and add a terminal to it. */
  onCreated: (path: string) => void;
}

/**
 * The "+ New scratch project" row of eagle view's new-terminal list. A click
 * swaps it for a name box with a ready default; Enter makes the folder,
 * Escape goes back. A refused name shows its reason in the box and nothing
 * is made.
 */
export function NewScratchProjectRow({ onCreated }: NewScratchProjectRowProps): JSX.Element {
  const create = useScratchStore((s) => s.create);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = (): void => {
    setName(defaultScratchName(new Date()));
    setError(null);
    setNaming(true);
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const path = await create(name);
      setNaming(false);
      onCreated(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // The box owns its keys: the list around it must not pick a project on
  // Enter or close on Escape while a name is being typed.
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setNaming(false);
    }
  };

  if (!naming) {
    return (
      <button
        type="button"
        onClick={start}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-maestro-text transition-colors hover:bg-maestro-card"
        title="Make a throwaway project folder and open a terminal in it"
      >
        <Plus size={12} className="shrink-0 text-maestro-accent" />
        New scratch project
      </button>
    );
  }

  return (
    <div className="px-4 py-2">
      <input
        type="text"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onFocus={(e) => e.target.select()}
        aria-label="Scratch project name"
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        disabled={busy}
        // biome-ignore lint/a11y/noAutofocus: the box opens from a click on its row — typing goes straight into the name.
        autoFocus
        className="w-full rounded border border-maestro-border bg-maestro-surface px-2 py-1.5 text-xs text-maestro-text focus:border-maestro-accent focus:outline-none"
      />
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-maestro-red">
          {error}
        </p>
      ) : (
        <p className="mt-1 text-[10px] text-maestro-muted">Enter create · Esc cancel</p>
      )}
    </div>
  );
}
