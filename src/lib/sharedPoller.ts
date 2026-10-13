/**
 * A per-key poller shared by every subscriber of the same key, so N terminal
 * views on the same repo run one interval and one fetch instead of N.
 *
 * Each key's interval starts with its first subscriber and stops with its last
 * (ref-counted). A fetch runs when an active subscriber joins (forced, like the
 * old per-hook "fetch on mount") and on each tick while the window has focus and
 * at least one subscriber is active. Every result goes to all current
 * subscribers of that key; a fetch already in flight is joined, not repeated.
 */
export interface SharedPoller<T> {
  /**
   * Subscribe to a key. Returns the unsubscribe function.
   *
   * @param key - Identifies what is polled; subscribers with equal keys share one poll
   * @param fetcher - Reads the current value; must not reject (map errors to a value)
   * @param listener - Receives every fetched value until unsubscribed
   * @param isActive - Whether this subscriber wants polling (inactive ones only listen)
   */
  subscribe(
    key: string,
    fetcher: () => Promise<T>,
    listener: (value: T) => void,
    isActive: boolean,
  ): () => void;
}

interface PollSubscriber<T> {
  listener: (value: T) => void;
  isActive: boolean;
}

interface PollEntry<T> {
  fetcher: () => Promise<T>;
  subscribers: Set<PollSubscriber<T>>;
  timer: ReturnType<typeof setInterval>;
  inflight: Promise<void> | null;
}

/**
 * Creates a shared poller ticking every `intervalMs` per subscribed key.
 *
 * @param intervalMs - Delay between polls of each key
 */
export function createSharedPoller<T>(intervalMs: number): SharedPoller<T> {
  const entries = new Map<string, PollEntry<T>>();

  const run = (entry: PollEntry<T>): void => {
    if (entry.inflight) return;
    entry.inflight = entry
      .fetcher()
      .then((value) => {
        for (const sub of entry.subscribers) sub.listener(value);
      })
      .finally(() => {
        entry.inflight = null;
      });
  };

  const hasActiveSubscriber = (entry: PollEntry<T>): boolean => {
    for (const sub of entry.subscribers) if (sub.isActive) return true;
    return false;
  };

  return {
    subscribe(key, fetcher, listener, isActive) {
      let entry = entries.get(key);
      if (!entry) {
        const created: PollEntry<T> = {
          fetcher,
          subscribers: new Set(),
          inflight: null,
          // Skip ticks while the window is blurred or no view is active, to avoid
          // background permission pop-ups and needless process spawns.
          timer: setInterval(() => {
            if (document.hasFocus() && hasActiveSubscriber(created)) run(created);
          }, intervalMs),
        };
        entries.set(key, created);
        entry = created;
      }

      const sub: PollSubscriber<T> = { listener, isActive };
      entry.subscribers.add(sub);
      if (isActive) run(entry);

      const owned = entry;
      return () => {
        owned.subscribers.delete(sub);
        if (owned.subscribers.size === 0) {
          clearInterval(owned.timer);
          if (entries.get(key) === owned) entries.delete(key);
        }
      };
    },
  };
}
