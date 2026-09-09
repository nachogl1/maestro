import { describe, expect, it } from "vitest";
import {
  type SamuraiAuditEvent,
  samuraiBriefPresentation,
  samuraiBriefSignal,
  samuraiRunAttentionLabel,
  samuraiRunFatalLabel,
} from "@/lib/samurai";

function row(overrides: Partial<SamuraiAuditEvent>): SamuraiAuditEvent {
  return {
    ts: "2026-09-09T10:00:00Z",
    epic: "epic-9",
    event: "ALERT",
    generation: 3,
    session_id: 7,
    details: {},
    ...overrides,
  };
}

/** The `ALERT` issue #205 writes at either rung — ONE kind, `escalated` splits them. */
function briefUnread(escalated: boolean, respawned?: boolean): SamuraiAuditEvent {
  return row({
    event: "ALERT",
    details: {
      kind: "brief_unread",
      instruction: "successor_ritual",
      gate: "session_started",
      brief: "epic-9-gen-3-ritual.md",
      escalated,
      ...(respawned === undefined ? {} : { respawned }),
    },
  });
}

describe("brief_unread tiering (issue #206)", () => {
  /**
   * The issue body claimed the escalated rung already had a fatal label via
   * #174/#190. It did not — `samuraiRunFatalLabel` had no `brief_unread`
   * case at all, so the run-fatal rung reached NOTHING: no toast, no OS
   * notification, no badge. Both branches are asserted here so the split can
   * never be collapsed back into one.
   */
  it("labels only the escalated rung run-fatal", () => {
    expect(samuraiRunFatalLabel(briefUnread(true, true))).toBe(
      "Brief was never read — the run was respawned",
    );
    // The respawn is bounded by the spawn ladder, so it can fail — and a
    // stranded run must not be described as one that restarted.
    expect(samuraiRunFatalLabel(briefUnread(true, false))).toBe(
      "Brief was never read — the run is stranded",
    );
    // The FIRST expiry is not fatal: a corrective is on its way.
    expect(samuraiRunFatalLabel(briefUnread(false))).toBeNull();
  });

  it("labels only the first expiry attention", () => {
    expect(samuraiRunAttentionLabel(briefUnread(false))).toBe(
      "Has not read its brief yet — nudging it",
    );
    expect(samuraiRunAttentionLabel(briefUnread(true, true))).toBeNull();
    // The two tiers are disjoint: no row ever gets both labels.
    expect(samuraiRunAttentionLabel(row({ details: { kind: "circuit_breaker" } }))).toBeNull();
    expect(samuraiRunAttentionLabel(row({ event: "INJECT", details: { phase: "receipt" } }))).toBe(
      null,
    );
  });
});

describe("samuraiBriefSignal (issue #206)", () => {
  it("reads the three rows that say something about a brief", () => {
    expect(
      samuraiBriefSignal(
        row({ event: "INJECT", details: { phase: "delivered", instruction: "launch_brief" } }),
      ),
    ).toEqual({ generation: 3, session_id: 7, status: "delivered" });
    expect(
      samuraiBriefSignal(
        row({ event: "INJECT", details: { phase: "receipt", brief: "epic-9-gen-3-ritual.md" } }),
      ),
    ).toEqual({ generation: 3, session_id: 7, status: "read" });
    expect(samuraiBriefSignal(briefUnread(false))).toEqual({
      generation: 3,
      session_id: 7,
      status: "unread",
    });
  });

  it("ignores rows that are about something else", () => {
    // The injector's deliveries go to a RUNNING agent — they are not briefs
    // and have no receipt, so they must not put a run into "unread".
    for (const instruction of ["handoff", "park", "soft_winddown", "winddown_allclear"]) {
      expect(
        samuraiBriefSignal(row({ event: "INJECT", details: { phase: "delivered", instruction } })),
      ).toBeNull();
    }
    // The corrective re-points at a brief that is STILL unread: treating it
    // as a fresh delivery would quietly downgrade the amber chip to grey.
    expect(
      samuraiBriefSignal(
        row({ event: "INJECT", details: { phase: "corrective", instruction: "successor_ritual" } }),
      ),
    ).toBeNull();
    expect(samuraiBriefSignal(row({ event: "SPAWN", details: {} }))).toBeNull();
    expect(samuraiBriefSignal(row({ details: { kind: "circuit_breaker" } }))).toBeNull();
  });
});

describe("samuraiBriefPresentation (issue #206)", () => {
  it("reads as ✓ only once the receipt exists", () => {
    expect(samuraiBriefPresentation("read").label).toBe("brief ✓");
    expect(samuraiBriefPresentation("delivered").label).toBe("brief ⚠ unread");
    expect(samuraiBriefPresentation("unread").label).toBe("brief ⚠ unread");
    // Same words, different urgency: a just-delivered brief is not a problem
    // yet, an expired window is. Never red — red means a human is needed.
    expect(samuraiBriefPresentation("delivered").cls).toContain("muted");
    expect(samuraiBriefPresentation("unread").cls).toContain("orange");
    expect(samuraiBriefPresentation("read").cls).toContain("green");
  });
});
