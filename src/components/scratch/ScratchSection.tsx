import { NewScratchProjectRow } from "./NewScratchProjectRow";
import { ScratchProjectsPill } from "./ScratchProjectsPill";

interface ScratchSectionProps {
  /** Add a terminal to the scratch project at this path, opening its tab first. */
  onOpen: (path: string) => void;
}

/**
 * The scratch-project part of eagle view's new-terminal list (the Mod+T
 * picker and the top bar's `+` drop-down): the "+ New scratch project" row
 * and the "Scratch projects" pill. `data-scratch-keys` tells the list around
 * it to leave the keys typed in here alone.
 */
export function ScratchSection({ onOpen }: ScratchSectionProps): JSX.Element {
  return (
    <div data-scratch-keys className="border-t border-maestro-border py-1">
      <NewScratchProjectRow onCreated={onOpen} />
      <ScratchProjectsPill onOpen={onOpen} />
    </div>
  );
}
