import { useEffect, useRef, useState } from "react";
import { loadAndRemember, type PillProject } from "./projectsPillLoad";

/** How long after Maestro starts the pill fetches every open project tab in the background. */
export const WARMUP_DELAY_MS = 15_000;

/**
 * Fetch the pill's data in the background so its first open shows counts at
 * once: every project tab open when the startup delay ends, then each tab
 * opened later (or whose folder changes) right away. Once per tab and folder;
 * nothing is fetched again while the pill stays closed.
 */
export function useProjectsPillWarmup(projects: PillProject[]): void {
  const [started, setStarted] = useState(false);
  // The folder each tab was last fetched for.
  const fetchedFolder = useRef(new Map<string, string>());

  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), WARMUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!started) return;
    for (const project of projects) {
      if (fetchedFolder.current.get(project.id) === project.repoPath) continue;
      fetchedFolder.current.set(project.id, project.repoPath);
      void loadAndRemember(project);
    }
  }, [started, projects]);
}
