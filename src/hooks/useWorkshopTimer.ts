import { useEffect } from "react";
import { useWorkshopStore } from "@/stores/useWorkshopStore";

/** Delay before the start-up check, so it does not compete with first paint. */
export const WORKSHOP_CATCH_UP_DELAY_MS = 30_000;

/** How often a due run is looked for while the app is open. */
export const WORKSHOP_CHECK_EVERY_MS = 60 * 60 * 1000;

/** One run if one is due; the backend decides (weekly, or a retry after a failure). */
function runIfDue(): void {
  void useWorkshopStore.getState().run(false);
}

/**
 * Workshop timer (issue #415), mounted once via `useBackgroundPollers`: looks
 * for a due `/insights` run shortly after start and then every hour. In-app
 * only; no OS scheduler.
 */
export function useWorkshopTimer(): void {
  useEffect(() => {
    const catchUp = setTimeout(runIfDue, WORKSHOP_CATCH_UP_DELAY_MS);
    const interval = setInterval(runIfDue, WORKSHOP_CHECK_EVERY_MS);
    return () => {
      clearTimeout(catchUp);
      clearInterval(interval);
    };
  }, []);
}
