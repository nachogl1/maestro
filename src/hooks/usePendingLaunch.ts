import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from "react";
import type { SessionSlot } from "@/components/terminal/PreLaunchCard";
import { createEmptySlot, occupiedSlotCount } from "@/components/terminal/slots";
import { buildGridTree, MAX_SESSIONS, type TreeNode } from "@/components/terminal/splitTree";
import type { McpServerConfig } from "@/lib/mcp";
import type { PluginConfig, SkillConfig } from "@/lib/plugins";
import { usePendingLaunchStore } from "@/stores/usePendingLaunchStore";

interface UsePendingLaunchOptions {
  tabId: string | undefined;
  slots: SessionSlot[];
  slotsRef: MutableRefObject<SessionSlot[]>;
  autoLaunchSlotIdsRef: MutableRefObject<string[]>;
  launchingSlotIdsRef: MutableRefObject<Set<string>>;
  mcpServers: McpServerConfig[];
  skills: SkillConfig[];
  plugins: PluginConfig[];
  orderedSlotIds: string[];
  launchSlot: (slotId: string) => Promise<void>;
  setSlots: Dispatch<SetStateAction<SessionSlot[]>>;
  setLayoutTree: Dispatch<SetStateAction<TreeNode>>;
  setFocusedSlotId: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * Consumes this tab's queued launches from `usePendingLaunchStore` (History
 * tab, samurai successor, harvest triage, PR review) and launches each
 * configured slot once it has committed to state.
 */
export function usePendingLaunch({
  tabId,
  slots,
  slotsRef,
  autoLaunchSlotIdsRef,
  launchingSlotIdsRef,
  mcpServers,
  skills,
  plugins,
  orderedSlotIds,
  launchSlot,
  setSlots,
  setLayoutTree,
  setFocusedSlotId,
  setError,
}: UsePendingLaunchOptions): void {
  // ── History-tab / samurai-successor launches ─────────────────────
  // The sidebar History tab (and the samurai successor spawn listener)
  // queues a pre-configured launch (resume id and/or worktree dir) in
  // usePendingLaunchStore because this grid may not even be mounted when
  // the request lands. Consume it here: configure a slot, then let the
  // effect below launch it once the slot has committed to state. One claim
  // per run — a FIFO store (finding B) with several entries for this tab
  // re-triggers this effect (the selector returns the next head entry) and
  // each claim gets its own slot.
  const pendingLaunch = usePendingLaunchStore((s) =>
    tabId ? (s.pending.find((p) => p.tabId === tabId) ?? null) : null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and state setters are passed in from TerminalGrid, where they are stable (useRef/useState); deps are kept identical to the pre-extraction inline version so behaviour does not change
  useEffect(() => {
    if (!pendingLaunch || !tabId) return;
    const launch = usePendingLaunchStore.getState().consume(tabId);
    if (!launch) return;

    // Reuse the pristine initial slot when it's the only one — unless an
    // earlier claim already configured it and is merely waiting for its
    // deferred launch (finding B: two claims must never share one slot);
    // otherwise append.
    const current = slotsRef.current;
    const reusable =
      current.length === 1 &&
      current[0].sessionId === null &&
      !autoLaunchSlotIdsRef.current.includes(current[0].id) &&
      !launchingSlotIdsRef.current.has(current[0].id)
        ? current[0]
        : null;
    // Parked samurai terminal-state tiles do not count — see
    // `occupiedSlotCount`, shared with `addSession`.
    if (!reusable && occupiedSlotCount(current) >= MAX_SESSIONS) {
      // The claim is consumed by now, so the launch is gone: say what did
      // not happen rather than "cannot resume" — this path also carries
      // harvest triage and samurai launches, whose own panels have already
      // reported success.
      setError(
        `Could not open the requested session: maximum of ${MAX_SESSIONS} sessions per project — close one and try again`,
      );
      return;
    }
    const base = reusable ?? createEmptySlot(mcpServers, skills, plugins);
    const slot: SessionSlot = {
      ...base,
      mode: launch.mode,
      branch: launch.branch,
      resumeSessionId: launch.resumeSessionId,
      workingDirOverride: launch.workingDirOverride,
      // Samurai successor launches (issue #55) name their session and carry
      // the registration metadata; History launches leave both unset.
      customName: launch.customName ?? base.customName,
      samurai: launch.samurai ?? null,
      // Harvest triage launches (issue #98) arm the backend's journal
      // prompt injection right before the CLI launches.
      harvest: launch.harvest ?? false,
      // Generic initial prompt (any caller): armed right before the CLI
      // launches, typed into the PTY on the session's first SessionStarted.
      initialPrompt: launch.initialPrompt ?? null,
      // Where a long initial prompt is staged as a brief file (issue #138).
      briefDir: launch.briefDir ?? null,
      briefStem: launch.briefStem ?? null,
      // PR-review launches record themselves at the same hop (issue #139).
      prRun: launch.prRun ?? null,
      // The History tab always names the exact directory to run in. Reusing the
      // pristine slot would otherwise inherit its worktreeMode, and any mode but
      // "project" sends launchSlotInner into prepareSessionWorktree — moving the
      // session into a worktree where `claude --resume` cannot find the session.
      worktreeMode: "project",
    };
    autoLaunchSlotIdsRef.current = [...autoLaunchSlotIdsRef.current, slot.id];
    // Advance slotsRef EAGERLY, before the setSlots below (bug: a samurai
    // launch opened an unsupervised terminal in the main checkout, and the
    // backend re-emitted 180s later). On the grid's MOUNT commit this effect
    // and the auto-launch effect below run in the SAME passive-effect flush:
    // React cannot re-render between them, so the ref sync at line 574 has
    // not run and launchSlot would read the PRISTINE slot — project dir, no
    // samurai payload, no registration. The next commit's sync re-derives
    // the ref from state, so an eager advance is self-healing.
    //
    // The setSlots calls stay FUNCTIONAL updaters on purpose: replacing them
    // with this ref-derived array would clobber a concurrent functional
    // update (launchSlotInner writes sessionId into another in-flight slot).
    slotsRef.current = reusable
      ? slotsRef.current.map((s) => (s.id === reusable.id ? slot : s))
      : slotsRef.current.some((s) => s.id === slot.id)
        ? slotsRef.current
        : [...slotsRef.current, slot];
    if (reusable) {
      setSlots((prev) => prev.map((s) => (s.id === reusable.id ? slot : s)));
    } else {
      // Dedupe by id instead of re-checking MAX_SESSIONS: the cap was already
      // enforced against current state above, and a refusal here would strand
      // the claim registered in autoLaunchSlotIdsRef forever (nothing clears a
      // claim whose slot never appears), permanently latching
      // successorLaunchImminent. A pathological same-batch double-claim now
      // overshoots the cap by one instead — transient and recoverable.
      setSlots((prev) => (prev.some((s) => s.id === slot.id) ? prev : [...prev, slot]));
      setLayoutTree(() => buildGridTree([...orderedSlotIds, slot.id]));
    }
    setFocusedSlotId(slot.id);
  }, [pendingLaunch, tabId, mcpServers, skills, plugins, orderedSlotIds]);

  // Launch queued slots only after they exist in committed state — calling
  // launchSlot in the effect above would race slotsRef against the setSlots.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and state setters are passed in from TerminalGrid, where they are stable (useRef/useState); deps are kept identical to the pre-extraction inline version so behaviour does not change
  useEffect(() => {
    const ids = autoLaunchSlotIdsRef.current;
    if (ids.length === 0) return;
    const ready = ids.filter((id) => slots.some((s) => s.id === id));
    if (ready.length === 0) return;
    autoLaunchSlotIdsRef.current = ids.filter((id) => !ready.includes(id));
    // Hand the claim from the queued marker to the in-flight one in the same
    // statement — a slot must never be unmarked while its launch is running,
    // or the reuse guard treats it as pristine. `launchSlot` always settles
    // (withProjectLock releases in a finally, launchSlotInner swallows its
    // own errors), so the marker cannot latch.
    for (const id of ready) {
      launchingSlotIdsRef.current.add(id);
      void launchSlot(id).finally(() => launchingSlotIdsRef.current.delete(id));
    }
  }, [slots, launchSlot]);
}
