import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 2_000;

export interface SystemMetrics {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  memPercent: number;
}

/**
 * Polls `get_system_metrics` every 2 seconds and returns the latest snapshot.
 *
 * - Skips polling while the window is blurred (`!document.hasFocus()`) to save
 *   resources.
 * - Cleans up the interval on unmount.
 * - Returns `null` until the first successful fetch.
 */
export function useSystemMetrics(): SystemMetrics | null {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const fetchMetrics = () => {
      // Skip when the window is in the background — nobody's looking.
      if (!document.hasFocus()) return;

      invoke<SystemMetrics>("get_system_metrics")
        .then((m) => {
          if (mountedRef.current) setMetrics(m);
        })
        .catch(() => {
          /* transient errors are ignored; next tick retries */
        });
    };

    fetchMetrics();
    const id = setInterval(fetchMetrics, POLL_INTERVAL_MS);

    return () => {
      clearInterval(id);
      mountedRef.current = false;
    };
  }, []);

  return metrics;
}
