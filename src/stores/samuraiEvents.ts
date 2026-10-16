/**
 * Samurai supervisor listener and its event appliers, split out of
 * `useSessionStore` (pure move, no behaviour change). Every applier reads and
 * writes the session store through `useSessionStore.getState/setState`.
 *
 * Events: samurai-supervisor-event + samurai-allowance-event -> badge map,
 * DEAD => error chrome, allowance => attention; samurai-schedule-event ->
 * pending resume timers for the countdown chip; samurai-audit-event ->
 * run-fatal / attention toasts and brief read state.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { notifyOs } from "@/lib/osNotification";
import { formatResumeAt } from "@/lib/parkTime";
import { normalizePath, samePath } from "@/lib/path";
import {
  isBreakerParked,
  isParkEntry,
  type SamuraiAuditEvent,
  type SamuraiAuditEventPayload,
  type SamuraiRunListEntry,
  type SamuraiScheduleEntry,
  type SamuraiSupervisorState,
  samuraiAuditRead,
  samuraiBriefSignal,
  samuraiListRuns,
  samuraiListSessions,
  samuraiRunAttentionLabel,
  samuraiRunFatalLabel,
  samuraiScheduleList,
} from "@/lib/samurai";
import { useGitHubWatchdogStore } from "@/stores/useGitHubWatchdogStore";
import {
  type BackendSessionStatus,
  type SamuraiParkAlert,
  type SamuraiSessionInfo,
  type SamuraiToast,
  samuraiBriefKey,
  useSessionStore,
} from "@/stores/useSessionStore";

/** Keep at most this many queued samurai toasts; oldest are dropped first. */
const MAX_SAMURAI_TOASTS = 6;

/** What the startup seed calls an already-interrupted run — the same wording
 *  `samuraiRunFatalLabel` gives the live `reconcile_interrupted` row, so the
 *  two paths never describe the same state two ways. */
const INTERRUPTED_RUN_LABEL = "Run was interrupted — resume or abandon it";

/** What the startup seed calls a breaker-parked run (issue #209). Distinct
 *  wording from the interrupted one because the cause is different: nothing
 *  crashed, supervision stopped it on purpose and only a human restarts it. */
const BREAKER_PARK_LABEL = "Circuit breaker parked this run — resume or abandon it";

let samuraiToastSeq = 0;

/** Identity of a park across schedule events (the list re-emits in full).
 *  The backend keeps one timer per (project, epic), so the fire time is NOT
 *  part of it: a deferral re-arm moves the same park (audit 2026-10-15 #7). */
function parkAlertKey(entry: SamuraiScheduleEntry): string {
  return `${normalizePath(entry.project_path)}|${entry.epic}`;
}

/** Last path segment — the name the tab strip and the toast kicker use. */
function projectLabel(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
}

/**
 * Subset of the backend's `SessionSnapshot` payload (emitted on every Samurai
 * supervisor state change) that the listener uses.
 */
interface SamuraiSupervisorEvent {
  session_id: number;
  /** Canonical project path, `\\?\` prefix already stripped by the backend. */
  project: string;
  epic: string;
  generation: number;
  state: string;
}

/**
 * Terminal supervisor states — the run is over, one way or another: KILLED
 * (replication, issue #55), PARKED (allowance park, issue #60), DEAD (the
 * watchdog declared the process gone, issue #44). No allowance attention
 * (see {@link applySamuraiAllowanceEvent}), and — per issue #122's decided
 * policy — every one of them moves its terminal into the existing footer
 * parking tray (TerminalGrid's samurai-park effect) instead of leaving it in
 * the grid: resuming is always a fresh spawn, so the old terminal has
 * nothing left to do live, but its transcript stays one unpark away.
 */
export const SAMURAI_TERMINAL_STATES: ReadonlySet<string> = new Set(["KILLED", "PARKED", "DEAD"]);

/**
 * Tracks every supervisor state change into `samuraiBySessionId` (the badge
 * data for issue #46), and surfaces a watchdog-declared death (issue #44):
 * a crashed claude fires no hook, so without this the session would sit on
 * its last MCP status — usually "Working" — forever. On a DEAD supervisor
 * event the session flips to Error chrome (the parked-shelf chip picks that
 * up as its attention border, issue #122) — moving the tile to the parking
 * tray is TerminalGrid's samurai-park effect's job, keyed off
 * `SAMURAI_TERMINAL_STATES`, same as KILLED/PARKED.
 */
function applySamuraiSupervisorEvent(payload: SamuraiSupervisorEvent): void {
  useSessionStore.setState((state) => {
    const samuraiBySessionId: Record<number, SamuraiSessionInfo> = {
      ...state.samuraiBySessionId,
      [payload.session_id]: {
        project: payload.project,
        epic: payload.epic,
        generation: payload.generation,
        state: payload.state as SamuraiSupervisorState,
      },
    };
    if (payload.state !== "DEAD") return { samuraiBySessionId };
    const session = state.sessions.find(
      (s) => s.id === payload.session_id && samePath(s.project_path, payload.project),
    );
    if (!session) return { samuraiBySessionId };
    return {
      samuraiBySessionId,
      sessions: state.sessions.map((s) =>
        s === session
          ? {
              ...s,
              status: "Error" as BackendSessionStatus,
              statusMessage: "claude process died (Samurai watchdog)",
            }
          : s,
      ),
    };
  });
}

/**
 * The `samurai-allowance-event` payload — the TS mirror of the backend's
 * `AllowanceEvent` (`core/allowance_watcher.rs`), which is serialized tagged
 * by `kind`. Every field is optional here: only `allowance_threshold` carries
 * the reading, and `allowance_recovered` / `no_governing_window` carry none.
 */
interface SamuraiAllowanceEventPayload {
  kind?: string;
  window?: string;
  threshold_kind?: string;
  value?: number;
  threshold?: number;
}

/**
 * The pseudo-project the backend writes account-wide ALERT rows to when
 * nothing is supervised — the TS mirror of `allowance_watcher::ACCOUNT_PROJECT`.
 * It is a real key for `samurai_audit_read`, not a path: the Second Brain's
 * "Account-wide" card and the audit stream both read it with this exact
 * string, and an account-wide toast names it so the user knows which card
 * holds the rows.
 */
export const SAMURAI_ACCOUNT_PROJECT = "samurai-account";

/**
 * The run id those account-wide rows carry — the TS mirror of
 * `allowance_watcher::ACCOUNT_RUN`, the pseudo-run paired with
 * {@link SAMURAI_ACCOUNT_PROJECT}. `AuditSection` re-exports it, which is
 * where audit-row grouping consumes it.
 */
export const SAMURAI_ACCOUNT_RUN = "account";

/** One plain-language line for a crossing, for the toast title / OS body. */
function allowanceCrossingLabel(payload: SamuraiAllowanceEventPayload): string {
  const subject = typeof payload.window === "string" ? `${payload.window} usage` : "Usage";
  const reading =
    typeof payload.value === "number" ? `hit ${payload.value}%` : "crossed a threshold";
  const threshold =
    payload.threshold_kind === "hard"
      ? " — hard (park) threshold"
      : payload.threshold_kind === "soft"
        ? " — soft (wind-down) threshold"
        : "";
  return `${subject} ${reading}${threshold}`;
}

/**
 * Allowance threshold crossed (issue #45, edge-triggered ~once per window):
 * flag every live supervised session with the existing attention highlight —
 * those are the runs the crossing is about (issue #46: existing attention
 * mechanism, no new alert UI). Details land as ALERT rows in the audit
 * stream; non-supervised sessions stay untouched.
 *
 * With NOTHING supervised the badge has nowhere to land — the state the last
 * real crossing happened in (the run had already died), where the whole event
 * used to vanish: no toast, no OS notification, and its ALERT rows filed under
 * the account-wide pseudo-project. So a crossing with no live run raises the
 * loud surfaces itself — the same toast + OS pair the run-fatal path uses, on
 * the same notifications toggle — naming {@link SAMURAI_ACCOUNT_PROJECT}, the
 * card whose audit rows carry the detail. Only an `allowance_threshold`
 * crossing announces: a recovery or a missing window is not news.
 */
function applySamuraiAllowanceEvent(payload: SamuraiAllowanceEventPayload): void {
  const crossing = payload?.kind === "allowance_threshold";
  const notify = crossing && useGitHubWatchdogStore.getState().notificationsEnabled;
  const label = crossing ? allowanceCrossingLabel(payload) : "";
  let announced = false;
  useSessionStore.setState((state) => {
    const supervised = state.sessions
      .filter((s) => {
        const info = state.samuraiBySessionId[s.id];
        return (
          info !== undefined &&
          !SAMURAI_TERMINAL_STATES.has(info.state) &&
          samePath(s.project_path, info.project)
        );
      })
      .map((s) => s.id);
    const flagged = supervised.filter((id) => !state.attentionSessionIds.includes(id));
    if (flagged.length > 0) {
      return { attentionSessionIds: [...state.attentionSessionIds, ...flagged] };
    }
    // Audit 2026-10-15 #53: every live supervised session is ALREADY badged
    // (the soft crossing, then the hard one minutes later). The badges are
    // the surface and the ALERT rows sit under those runs — announcing the
    // account-wide card here pointed the user at an empty one.
    if (supervised.length > 0) return state;
    // No-op guard: nothing supervised — don't replace the array and
    // re-render subscribers. The account-wide announcement below is the one
    // thing that still has to happen.
    if (!notify) return state;
    announced = true;
    samuraiToastSeq += 1;
    return {
      samuraiToasts: [
        ...state.samuraiToasts,
        {
          id: `samurai-${samuraiToastSeq}`,
          kind: "allowance" as const,
          project: SAMURAI_ACCOUNT_PROJECT,
          epic: SAMURAI_ACCOUNT_RUN,
          generation: 0,
          label,
        },
      ].slice(-MAX_SAMURAI_TOASTS),
    };
  });
  if (announced) {
    void notifyOs("Samurai — token allowance", label);
  }
}

/**
 * Run-fatal audit rows (issue #174): a supervised, autonomous run can die
 * silently — the whole point of supervision is that the human does not watch
 * the terminal, so these events must come TO the human instead of waiting in
 * the sidebar audit list.
 *
 * Three surfaces, deliberately independent:
 * - a persistent attention badge (the existing yellow highlight, cleared
 *   when the user focuses the session) on the session the row names — set
 *   REGARDLESS of the notifications toggle, so nothing is silently missed;
 * - a toast, queued only while notifications are enabled (the same toggle
 *   the GitHub watchdog and health checker honour);
 * - a native OS notification (same toggle), which is the one surface that
 *   reaches the user while Maestro is minimized — the situation the Nido
 *   run actually died in. Best effort (`notifyOs` swallows failures).
 *
 * One notification per event by construction: each audit row is appended
 * (and therefore emitted on `samurai-audit-event`) exactly once — the
 * backend's give-up/trip paths already fire their ALERT once, not per tick.
 */
function applySamuraiFatalAuditEvent(payload: SamuraiAuditEventPayload): void {
  const label = samuraiRunFatalLabel(payload.event);
  if (label === null) return;
  const { session_id, epic, generation } = payload.event;
  // Lazy require would be overkill: the watchdog store has no dependency
  // back on this module, so the import is safe (see the module imports).
  const notify = useGitHubWatchdogStore.getState().notificationsEnabled;
  useSessionStore.setState((state) => {
    // The badge: only when the row names a real, known session (a
    // successor_no_start for a never-registered spawn carries the 0
    // sentinel — the toast still says which epic stranded).
    const knownSession =
      session_id > 0 &&
      state.sessions.some((s) => s.id === session_id && samePath(s.project_path, payload.project));
    // A fatal event must UPGRADE an existing non-fatal attention flag. The
    // guard used to skip the whole branch whenever the session already
    // carried attention — an allowance crossing flags exactly that way — so
    // a genuinely fatal row on such a session never reached
    // `runFatalSessionIds`, and `parkSession` wiped its badge on the auto-park
    // that follows: a dead run looked like an ordinary parked terminal.
    const needsAttention = knownSession && !state.attentionSessionIds.includes(session_id);
    const needsFatal = knownSession && !state.runFatalSessionIds.includes(session_id);
    if (!needsAttention && !needsFatal && !notify) return state;
    samuraiToastSeq += 1;
    return {
      ...(knownSession
        ? {
            attentionSessionIds: needsAttention
              ? [...state.attentionSessionIds, session_id]
              : state.attentionSessionIds,
            // Marks this badge as run-fatal (issue #174) so `parkSession`
            // preserves it instead of wiping it when the auto-park effect
            // parks the session moments later.
            runFatalSessionIds: needsFatal
              ? [...state.runFatalSessionIds, session_id]
              : state.runFatalSessionIds,
          }
        : {}),
      ...(notify
        ? {
            samuraiToasts: [
              ...state.samuraiToasts,
              {
                id: `samurai-${samuraiToastSeq}`,
                kind: "fatal" as const,
                project: payload.project,
                epic,
                generation,
                label,
              },
            ].slice(-MAX_SAMURAI_TOASTS),
          }
        : {}),
    };
  });
  if (notify) {
    const project = projectLabel(payload.project);
    void notifyOs(`Samurai run needs you — ${project}`, `${label} (${epic} · gen-${generation})`);
  }
}

/**
 * Issue #206: the ATTENTION tier — a run that is going wrong while
 * supervision is still correcting it (today: a brief that has not been read,
 * with one corrective on its way).
 *
 * Same three surfaces as the fatal tier and for the same reason — the human
 * is not watching the terminal — with one deliberate difference: the session
 * is flagged for attention but NOT recorded in `runFatalSessionIds`, so
 * nothing here claims the run is dead and `parkSession` may still clear the
 * highlight normally. The toast carries its own amber `attention` chrome.
 */
function applySamuraiAttentionAuditEvent(payload: SamuraiAuditEventPayload): void {
  const label = samuraiRunAttentionLabel(payload.event);
  if (label === null) return;
  const { session_id, epic, generation } = payload.event;
  const notify = useGitHubWatchdogStore.getState().notificationsEnabled;
  useSessionStore.setState((state) => {
    const knownSession =
      session_id > 0 &&
      state.sessions.some((s) => s.id === session_id && samePath(s.project_path, payload.project));
    const needsAttention = knownSession && !state.attentionSessionIds.includes(session_id);
    if (!needsAttention && !notify) return state;
    samuraiToastSeq += 1;
    return {
      ...(needsAttention
        ? { attentionSessionIds: [...state.attentionSessionIds, session_id] }
        : {}),
      ...(notify
        ? {
            samuraiToasts: [
              ...state.samuraiToasts,
              {
                id: `samurai-${samuraiToastSeq}`,
                kind: "attention" as const,
                project: payload.project,
                epic,
                generation,
                label,
              },
            ].slice(-MAX_SAMURAI_TOASTS),
          }
        : {}),
    };
  });
  if (notify) {
    void notifyOs(
      `Samurai needs a look — ${projectLabel(payload.project)}`,
      `${label} (${epic} · gen-${generation})`,
    );
  }
}

/**
 * Issue #206: folds one audit row into {@link SessionState.samuraiBriefByRun}.
 *
 * Newest generation wins and an older one is ignored outright — a gen-3 row
 * arriving late (the audit stream is append-ordered, but a seed can race a
 * live event) must not un-read gen-4's brief. Within a generation the state
 * only moves forward through `delivered → unread → read`: `read` is final
 * (the receipt latches backend-side too), and a re-delivery into the same
 * generation is the #171 re-type, not a new brief.
 */
function applySamuraiBriefAuditEvent(project: string, event: SamuraiAuditEvent): void {
  const signal = samuraiBriefSignal(event);
  if (signal === null) return;
  useSessionStore.setState((state) => {
    const key = samuraiBriefKey(project, event.epic);
    const current = state.samuraiBriefByRun[key];
    if (current) {
      if (current.generation > signal.generation) return state;
      if (current.generation === signal.generation) {
        if (current.status === signal.status) return state;
        if (current.status === "read") return state;
        if (current.status === "unread" && signal.status === "delivered") return state;
      }
    }
    return {
      samuraiBriefByRun: {
        ...state.samuraiBriefByRun,
        [key]: {
          generation: signal.generation,
          sessionId: signal.session_id,
          status: signal.status,
        },
      },
    };
  });
}

/**
 * Review F8: whether a live `samurai-schedule-event` has been applied since
 * this listener lifetime started. The seed's IPC round-trip can resolve
 * AFTER a live event already delivered a newer list — applying the stale
 * snapshot then would resurrect a fired timer's countdown chip. Reset on
 * listener init so the restart-seed case still works.
 */
let samuraiScheduleEventApplied = false;

/**
 * Whether a timer list has been folded into `samuraiParkAlerts` yet in this
 * listener lifetime. The FIRST one — the seed, or a live event that beat it —
 * is the startup baseline: those parks already existed when the app opened,
 * so they get their persistent marker (coming back to them is the whole
 * point) but no toast, which would otherwise fire on every launch for a park
 * the user has known about for days.
 */
let samuraiParkBaselineApplied = false;

/**
 * Acknowledged flags of park alerts whose timer left the list (audit
 * 2026-10-15 #7). A fired timer drops out while its resume spawn is in
 * flight; when the spawn is never taken the backend re-arms the SAME park as
 * a `deferred` entry minutes later, and this is what lets it come back with
 * the flag the user already gave it. Reset with the baseline.
 */
const vanishedParkAcks = new Map<string, boolean>();

/**
 * Folds a full timer list into the park alerts: new parks raise the loud
 * surfaces, known ones keep their acknowledged flag, and vanished ones are
 * dropped — a fired or cancelled timer must not leave a "parked" marker.
 *
 * The alerts ride the SCHEDULE rather than the `PARKED` supervisor event
 * because only the timer carries the resume time, and a park announced
 * without one is exactly the unreadable "parked, back at 09:05" the
 * park-time formatters exist to prevent. A park that arms no timer at all —
 * a circuit-breaker trip, or the `gh_auth_lost` sweep that parks every run —
 * is announced by its ALERT row through the run-fatal path instead.
 *
 * `isParkEntry` gates the list: scheduled launches (issue #129) share it and
 * would otherwise announce a park for a run that does not exist yet.
 */
function applySamuraiParkAlerts(entries: SamuraiScheduleEntry[]): void {
  const announce = samuraiParkBaselineApplied;
  samuraiParkBaselineApplied = true;

  const known = new Map(useSessionStore.getState().samuraiParkAlerts.map((a) => [a.key, a]));
  const fresh: SamuraiParkAlert[] = [];
  const samuraiParkAlerts = entries.filter(isParkEntry).map((entry) => {
    const key = parkAlertKey(entry);
    const existing = known.get(key);
    if (existing && existing.fireAt === entry.fire_at) return existing;
    // Audit 2026-10-15 #7: a deferral re-arm is the same park pushed out —
    // move its resume time in place, keep `acknowledged`, announce nothing.
    // Without this every ~10-25 min lap of a deferred resume re-raised the
    // "Samurai parked" toast and OS notification.
    if (entry.deferred === true) {
      return {
        key,
        project: entry.project_path,
        epic: entry.epic,
        fireAt: entry.fire_at,
        acknowledged: existing?.acknowledged ?? vanishedParkAcks.get(key) ?? false,
      };
    }
    const alert: SamuraiParkAlert = {
      key,
      project: entry.project_path,
      epic: entry.epic,
      fireAt: entry.fire_at,
      acknowledged: false,
    };
    fresh.push(alert);
    return alert;
  });
  const kept = new Set(samuraiParkAlerts.map((a) => a.key));
  for (const alert of known.values()) {
    if (!kept.has(alert.key)) vanishedParkAcks.set(alert.key, alert.acknowledged);
  }
  for (const key of kept) vanishedParkAcks.delete(key);

  const notify =
    announce && fresh.length > 0 && useGitHubWatchdogStore.getState().notificationsEnabled;
  useSessionStore.setState((state) => ({
    samuraiParkAlerts,
    samuraiToasts: notify
      ? [
          ...state.samuraiToasts,
          ...fresh.map((alert): SamuraiToast => {
            samuraiToastSeq += 1;
            return {
              id: `samurai-${samuraiToastSeq}`,
              kind: "park",
              project: alert.project,
              epic: alert.epic,
              generation: 0,
              label: `resumes ${formatResumeAt(alert.fireAt) ?? alert.fireAt}`,
            };
          }),
        ].slice(-MAX_SAMURAI_TOASTS)
      : state.samuraiToasts,
  }));

  if (!notify) return;
  for (const alert of fresh) {
    void notifyOs(
      `Samurai parked — ${projectLabel(alert.project)}`,
      `${alert.epic} · resumes ${formatResumeAt(alert.fireAt) ?? alert.fireAt}`,
    );
  }
}

/**
 * Replaces the pending-timer list (issue #61). The backend sends the FULL
 * current list on every arm/cancel/fire, so this is a plain replace — no
 * merging, no ordering assumptions.
 */
function applySamuraiScheduleEvent(payload: SamuraiScheduleEntry[]): void {
  // Defensive: a mocked/failed IPC layer may hand back a non-array.
  if (!Array.isArray(payload)) return;
  samuraiScheduleEventApplied = true;
  useSessionStore.setState({ samuraiSchedule: payload });
  applySamuraiParkAlerts(payload);
}

/**
 * Seeds `samuraiSchedule` from the backend's current timers, so timers armed
 * before this frontend mounted (app restart with parked epics) still show
 * their countdown chip. Live events always carry the full current list, so
 * once one has been applied the seed's snapshot is stale by definition and
 * is dropped (review F8).
 */
async function seedSamuraiSchedule(): Promise<void> {
  try {
    const entries = await samuraiScheduleList();
    if (samuraiScheduleEventApplied) return;
    if (!Array.isArray(entries)) return;
    // Baselined even when empty: otherwise this session's first real park
    // would be mistaken for the startup snapshot and announce nothing.
    applySamuraiParkAlerts(entries);
    if (entries.length === 0) return;
    useSessionStore.setState({ samuraiSchedule: entries });
  } catch (err) {
    console.error("Failed to seed samurai resume timers:", err);
  }
}

/**
 * Raises the loud surfaces for runs that are ALREADY interrupted when this
 * listener starts.
 *
 * Cold-start reconciliation runs in the Tauri setup closure, with no delay,
 * long before App mounts this listener — and Tauri buffers no events. So the
 * `reconcile_interrupted` ALERT it emits is delivered to nobody: the toast
 * that `applySamuraiFatalAuditEvent` would raise for it can never fire on
 * the one path that matters, a cold start. That is not a race to widen; the
 * fix is to stop depending on catching the event at all.
 *
 * The reconciler also LATCHES its verdict onto the run config
 * (`interrupted_at`, PR #185), and that is durable state this seed can just
 * read. Every ACTIVE run carrying the stamp is a run with no owner and no
 * timer, so it gets the same toast + OS notification a live fatal row would
 * have raised — from the run list, whenever the app happens to start.
 *
 * It repeats on every launch, deliberately: an interrupted run stays dead
 * until a human recovers or abandons it, and the alert that fired once and
 * was missed is exactly how the real Nido run went unnoticed for three
 * weeks. Both actions are one click away in Active Runs, and both clear the
 * stamp.
 *
 * No attention badge: an interrupted run has no live session to badge — the
 * red INTERRUPTED row in Active Runs is its persistent surface.
 */
async function seedSamuraiInterruptedRuns(): Promise<void> {
  try {
    const runs = await samuraiListRuns();
    // Defensive: a mocked/failed IPC layer may hand back a non-array.
    if (!Array.isArray(runs)) return;
    // Issue #209: a breaker park is the same shape of problem from a
    // different cause — an ACTIVE run with no owner and nothing that will
    // ever restart it — so it seeds through the same door. Its list is also
    // published, because the park chip has no other source: a breaker trip
    // arms no timer, so `samuraiSchedule` never hears about it.
    const breaker = runs.filter(isBreakerParked);
    useSessionStore.getState().setSamuraiBreakerParks(
      breaker.map((run: SamuraiRunListEntry) => ({
        project: run.project_path,
        epic: run.epic,
        at: run.parked?.at ?? "",
      })),
    );
    const dead = runs.filter(
      (run: SamuraiRunListEntry) =>
        run.status === "ACTIVE" && run.interrupted_at != null && !isBreakerParked(run),
    );
    const needy: [SamuraiRunListEntry, string, number][] = [
      ...dead.map((run: SamuraiRunListEntry): [SamuraiRunListEntry, string, number] => [
        run,
        INTERRUPTED_RUN_LABEL,
        run.interrupted_at?.prior_generation ?? 0,
      ]),
      ...breaker.map((run: SamuraiRunListEntry): [SamuraiRunListEntry, string, number] => [
        run,
        BREAKER_PARK_LABEL,
        run.parked?.generation ?? 0,
      ]),
    ];
    if (needy.length === 0) return;
    const notify = useGitHubWatchdogStore.getState().notificationsEnabled;
    if (!notify) return;
    useSessionStore.setState((state) => {
      const toasts = needy.map(([run, label, generation]) => {
        samuraiToastSeq += 1;
        return {
          id: `samurai-${samuraiToastSeq}`,
          kind: "fatal" as const,
          project: run.project_path,
          epic: run.epic,
          generation,
          label,
        };
      });
      return { samuraiToasts: [...state.samuraiToasts, ...toasts].slice(-MAX_SAMURAI_TOASTS) };
    });
    for (const [run, label] of needy) {
      void notifyOs(
        `Samurai run needs you — ${projectLabel(run.project_path)}`,
        `${label} (${run.epic})`,
      );
    }
  } catch (err) {
    console.error("Failed to seed interrupted samurai runs:", err);
  }
}

/**
 * How many audit rows the brief seed reads per project. A generation's
 * delivery, receipt and unread rows all land within seconds of its SPAWN, so
 * the newest generation's verdict is always near the tail; this is the same
 * bound the audit panel and the reconciler read with.
 */
const BRIEF_SEED_TAIL = 200;

/**
 * Issue #206: seeds brief read/unread for every live run, so a COLD START
 * shows the truth.
 *
 * Same reasoning as {@link seedSamuraiInterruptedRuns}: the rows that carry
 * this fact were emitted long before App mounted the audit listener, and
 * Tauri buffers no events — without a seed a restart shows every run's brief
 * as unknown, which is exactly the "the badge says ACTIVE and tells you
 * nothing" state this issue exists to end. The durable source differs
 * (`interrupted_at` is stamped on the run config; a read receipt is an audit
 * row), so the seed reads the audit log instead of the run list — but the RUN
 * LIST is still what says which projects to read, so an archived run's stale
 * rows never seed a badge.
 *
 * Rows are folded oldest-first, exactly as a live stream would deliver them,
 * so `applySamuraiBriefAuditEvent`'s newest-generation rule does the picking
 * and there is no second definition of "current".
 */
async function seedSamuraiBriefState(): Promise<void> {
  try {
    const runs = await samuraiListRuns();
    if (!Array.isArray(runs)) return;
    const projects = new Map<string, string>();
    for (const run of runs) {
      if (run.status !== "ACTIVE") continue;
      const key = normalizePath(run.project_path);
      if (!projects.has(key)) projects.set(key, run.project_path);
    }
    for (const project of projects.values()) {
      try {
        const result = await samuraiAuditRead(project, BRIEF_SEED_TAIL);
        const events = result?.events;
        if (!Array.isArray(events)) continue;
        for (const event of events) {
          applySamuraiBriefAuditEvent(project, event);
        }
      } catch (err) {
        console.error("Failed to seed samurai brief state for", project, err);
      }
    }
  } catch (err) {
    console.error("Failed to seed samurai brief state:", err);
  }
}

/**
 * Seeds `samuraiBySessionId` from the supervisor's current snapshots, so
 * sessions registered before this frontend mounted (dev reload, late mount)
 * still get badges. Live events won the race for any id already present.
 */
async function seedSamuraiSessions(): Promise<void> {
  try {
    const snapshots = await samuraiListSessions();
    // Defensive: a mocked/failed IPC layer may hand back a non-array.
    if (!Array.isArray(snapshots) || snapshots.length === 0) return;
    useSessionStore.setState((state) => {
      const samuraiBySessionId = { ...state.samuraiBySessionId };
      for (const snapshot of snapshots) {
        if (samuraiBySessionId[snapshot.session_id]) continue;
        samuraiBySessionId[snapshot.session_id] = {
          project: snapshot.project,
          epic: snapshot.epic,
          generation: snapshot.generation,
          state: snapshot.state,
        };
      }
      return { samuraiBySessionId };
    });
  } catch (err) {
    console.error("Failed to seed samurai supervised sessions:", err);
  }
}

// Same StrictMode-safe init/stop shape as the context usage listener above.
let samuraiUnlisten: UnlistenFn | null = null;
let samuraiStarting: Promise<void> | null = null;
let samuraiActive = false;

export async function initSamuraiSupervisorListener(): Promise<void> {
  samuraiActive = true;
  if (samuraiUnlisten || samuraiStarting) return;
  // Review F8: fresh listener lifetime — the seed may apply until the first
  // live schedule event of THIS lifetime lands.
  samuraiScheduleEventApplied = false;
  samuraiParkBaselineApplied = false;
  vanishedParkAcks.clear();
  samuraiStarting = Promise.all([
    listen<SamuraiSupervisorEvent>("samurai-supervisor-event", (event) => {
      applySamuraiSupervisorEvent(event.payload);
    }),
    listen<SamuraiAllowanceEventPayload>("samurai-allowance-event", (event) => {
      applySamuraiAllowanceEvent(event.payload ?? {});
    }),
    listen<SamuraiScheduleEntry[]>("samurai-schedule-event", (event) => {
      applySamuraiScheduleEvent(event.payload);
    }),
    // Issue #174: run-fatal rows raise a toast + persistent attention badge.
    // Issue #206: the attention tier and the brief read/unread state ride the
    // same stream — one row is at most one of the two labels, and the brief
    // fold ignores every row that says nothing about a brief.
    listen<SamuraiAuditEventPayload>("samurai-audit-event", (event) => {
      applySamuraiFatalAuditEvent(event.payload);
      applySamuraiAttentionAuditEvent(event.payload);
      applySamuraiBriefAuditEvent(event.payload.project, event.payload.event);
    }),
  ])
    .then((fns) => {
      const unlistenAll = () =>
        fns.forEach((fn) => {
          fn();
        });
      if (!samuraiActive) {
        unlistenAll();
        return;
      }
      samuraiUnlisten = unlistenAll;
    })
    .finally(() => {
      samuraiStarting = null;
    });
  await samuraiStarting;
  void seedSamuraiSessions();
  void seedSamuraiSchedule();
  void seedSamuraiInterruptedRuns();
  void seedSamuraiBriefState();
}

export function stopSamuraiSupervisorListener(): void {
  samuraiActive = false;
  if (samuraiUnlisten) {
    samuraiUnlisten();
    samuraiUnlisten = null;
  }
}
