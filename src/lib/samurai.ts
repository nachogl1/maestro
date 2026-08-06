import { invoke } from "@tauri-apps/api/core";

/**
 * Thin wrappers over the Samurai supervisor / audit tauri commands
 * (`src-tauri/src/commands/samurai.rs`), following the per-domain lib module
 * convention (`lib/processes.ts`, `lib/memory.ts`, …).
 *
 * Phase 1 (issue #46) consumes read-only surfaces: the supervised-session
 * snapshots and the per-project audit log. Registration/transitions stay
 * backend-driven (or manual via devtools) until Phases 2–3.
 */

/** Wire names of the supervisor states (SCREAMING serde names, PRD §5.2). */
export type SamuraiSupervisorState =
  | "WORKING"
  | "HANDOFF_REQUESTED"
  | "HANDOFF_WRITTEN"
  | "KILLED"
  | "PARK_REQUESTED"
  | "PARKED"
  | "DEAD";

/**
 * Mirrors the Rust `SessionSnapshot` — also the exact payload of every
 * `samurai-supervisor-event`.
 */
export interface SamuraiSessionSnapshot {
  session_id: number;
  /** Canonical project path (Windows `\\?\` prefix already stripped). */
  project: string;
  epic: string;
  generation: number;
  state: SamuraiSupervisorState;
  previous_state: SamuraiSupervisorState | null;
  in_flight: "HANDOFF" | "PARK" | null;
  /** RFC 3339 UTC timestamp of the change. */
  ts: string;
}

/** Audit row kinds (PRD §5.10). Sub-kinds live in `details.kind`. */
export type SamuraiAuditEventKind =
  | "SPAWN"
  | "HANDOFF"
  | "PARK"
  | "RESUME"
  | "COMPLETE"
  | "ALERT";

/** One audit JSONL row — mirrors the Rust `AuditEvent`. */
export interface SamuraiAuditEvent {
  /** RFC 3339 UTC timestamp. */
  ts: string;
  /** Epic reference; empty when unknown (e.g. account-wide ALERTs). */
  epic: string;
  event: SamuraiAuditEventKind;
  /** Orchestrator generation number (gen-N); 0 for account-wide rows. */
  generation: number;
  session_id: number;
  /** Free-form detail object for sub-kinds and context. */
  details: unknown;
}

/** Payload of the live `samurai-audit-event` channel. */
export interface SamuraiAuditEventPayload {
  project: string;
  event: SamuraiAuditEvent;
}

/** Mirrors the Rust `AuditReadResult`. */
export interface SamuraiAuditReadResult {
  events: SamuraiAuditEvent[];
  file_size_bytes: number;
}

/** Snapshots of every supervised session, ordered by session id. */
export function samuraiListSessions(): Promise<SamuraiSessionSnapshot[]> {
  return invoke("samurai_list_sessions");
}

/**
 * Reads a project's audit rows (optionally only the last `tail`, optionally
 * only rows strictly after `sinceTs`) plus the current file size in bytes.
 */
export function samuraiAuditRead(
  projectPath: string,
  tail?: number,
  sinceTs?: string,
): Promise<SamuraiAuditReadResult> {
  return invoke("samurai_audit_read", { projectPath, tail, sinceTs });
}

/** Deletes a project's audit log. User-initiated only (PRD decision #15). */
export function samuraiAuditClear(projectPath: string): Promise<void> {
  return invoke("samurai_audit_clear", { projectPath });
}
