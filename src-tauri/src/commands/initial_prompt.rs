//! Generic "launch a terminal with an initial prompt" delivery.
//!
//! Any caller can open a terminal through the pending-launch flow and have a
//! prompt of its own typed into the session once claude is actually up. The
//! frontend arms the just-launched session via
//! [`terminal_arm_initial_prompt`] right before the CLI command is typed, and
//! the session's FIRST `SessionStarted` hook signal — claude at its prompt —
//! triggers [`InitialPromptInjector::on_session_started`] (tapped from the
//! setup's `hook_emit_fn`).
//!
//! Delivery goes through [`DeliverFn`], which production wires to
//! `core::pty_submit::submit_instruction_confirmed` (body write confirmed on
//! the calling thread, then the scaled gap and the lone Enter — issue #103).
//! The session is disarmed BEFORE delivery, so a later `SessionStarted` in the
//! same terminal (e.g. `/clear`) can never double-inject.
//!
//! **PTY safety is enforced here, not at the call site.** A newline inside an
//! injected prompt submits a partial message, so [`normalize_prompt`] collapses every whitespace run — newlines
//! included — to a single space before the text is ever handed to the PTY. A
//! caller cannot get this wrong from TypeScript.
//!
//! Flattening keeps the PTY safe but destroys a long prompt's structure, and
//! a multi-KB payload is not reliably delivered even flattened (issue #137).
//! So a caller may also name a brief target ([`BriefTarget`]): an over-budget
//! prompt is then written UNFLATTENED through `core::brief_files` and what
//! is typed is the one-line pointer at that file. Normalization still runs on
//! whatever is actually typed, so the invariant above is unchanged.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use tauri::State;

use crate::core::brief_files::{self, StagedBrief};

/// Delivery of the injected prompt into a session's PTY. `Ok` means the
/// prompt BODY reached the PTY. Production wires
/// `core::pty_submit::submit_instruction_confirmed` (the two-frame
/// paste-then-Enter submit with the issue-#103 scaled delay, body write
/// confirmed on the calling thread); tests capture the call.
pub type DeliverFn = Arc<dyn Fn(u32, String) -> Result<(), String> + Send + Sync>;

/// The all-whitespace refusal — pinned by test, surfaced to the caller.
const EMPTY_PROMPT: &str = "Cannot launch with an empty initial prompt.";

/// Flattens a caller-supplied prompt into ONE PTY-safe line: every run of
/// whitespace (`\n`, `\r\n`, tabs, runs of spaces) becomes a single space and
/// leading/trailing whitespace is dropped. `split_whitespace` splits on the
/// Unicode `White_Space` property, so a stray non-breaking space or form feed
/// flattens too — a UI text area produces exactly the sort of multi-line
/// input that would otherwise submit itself half-typed.
pub fn normalize_prompt(prompt: &str) -> String {
    prompt.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Where a long prompt is staged as a brief FILE instead of being typed
/// (issue #138): `dir` is the checkout whose `.maestro/briefs/` receives it —
/// the layout `core::brief_files` writes — and `stem`
/// names the file within it. A caller that supplies no target keeps the
/// inline delivery, whatever the prompt's size.
pub struct BriefTarget {
    pub dir: PathBuf,
    pub stem: String,
}

/// The command's two optional params folded into one target. Both halves are
/// required and neither may be blank: a directory without a stem (or the
/// reverse) names no file, and treating it as one would write `.md` at the
/// brief root.
fn brief_target(dir: Option<String>, stem: Option<String>) -> Option<BriefTarget> {
    let (dir, stem) = (dir?, stem?);
    if dir.trim().is_empty() || stem.trim().is_empty() {
        return None;
    }
    Some(BriefTarget {
        dir: PathBuf::from(dir),
        stem,
    })
}

/// The initial-prompt state machine: [`InitialPromptInjector::arm`] stages a
/// just-launched session's prompt, the session's first `SessionStarted` hook
/// signal types it in. Managed as `Arc<InitialPromptInjector>`; the
/// `SessionStarted` tap lives in lib.rs's `hook_emit_fn`.
pub struct InitialPromptInjector {
    deliver: DeliverFn,
    /// Session id → the normalized prompt staged for it, until injected. A
    /// session killed before its `SessionStarted` leaves a stale entry here —
    /// harmless, session ids are never reused within a run.
    armed: Mutex<HashMap<u32, String>>,
}

impl InitialPromptInjector {
    pub fn new(deliver: DeliverFn) -> Self {
        Self {
            deliver,
            armed: Mutex::new(HashMap::new()),
        }
    }

    /// Stages `prompt` for injection on `session_id`'s first
    /// `SessionStarted`. What is stored is always the exact single line that
    /// will be typed. Refuses (pinned message) a prompt that is empty once
    /// normalized — arming it would submit a blank turn. Re-arming the same
    /// session before it starts REPLACES the staged prompt: one session gets
    /// one initial prompt.
    ///
    /// With a `brief` target, a prompt too long to type safely
    /// (`brief_files::INLINE_MAX_BYTES`, measured on the flattened text —
    /// that is what would have gone to the PTY) is written to a brief file
    /// UNFLATTENED, and the one-line pointer at it is armed instead. So the
    /// agent reads the prompt's real structure while the PTY still only ever
    /// sees a single short line. Without a target — or when the write fails —
    /// the flattened prompt is armed exactly as before.
    ///
    /// Returns the brief it staged — BOTH the directory it landed under and
    /// the relative path inside it ([`StagedBrief`]) — or `None` when the
    /// prompt was typed inline. Its one reader, the PR-review record, went
    /// with the PR actions menu (issue #692); the command ignores it.
    ///
    /// Does a blocking file write when it stages a brief, which is why the
    /// command below is `#[tauri::command(async)]` — Tauri then runs it off
    /// the main thread instead of blocking the UI on the write.
    pub fn arm(
        &self,
        session_id: u32,
        prompt: &str,
        brief: Option<BriefTarget>,
    ) -> Result<Option<StagedBrief>, String> {
        let normalized = normalize_prompt(prompt);
        if normalized.is_empty() {
            return Err(EMPTY_PROMPT.to_string());
        }
        let mut staged: Option<StagedBrief> = None;
        let armed = brief
            .filter(|_| normalized.len() > brief_files::INLINE_MAX_BYTES)
            .and_then(
                |target| match brief_files::write_brief(&target.dir, &target.stem, prompt) {
                    Ok(relpath) => {
                        let pointer = normalize_prompt(&brief_files::pointer_instruction(&relpath));
                        staged = Some(StagedBrief {
                            root: target.dir,
                            relpath,
                        });
                        Some(pointer)
                    }
                    Err(e) => {
                        log::warn!(
                            "initial prompt: {e} — arming the flattened prompt inline instead"
                        );
                        None
                    }
                },
            )
            .unwrap_or(normalized);
        self.armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session_id, armed);
        Ok(staged)
    }

    /// Injection gate: called with a session's `SessionStarted` signal. An
    /// armed session gets its staged prompt handed to the PTY; anything else
    /// is a no-op. Disarms FIRST, so a later `SessionStarted` in the same
    /// terminal (e.g. `/clear`) can never re-type the prompt. A failed write
    /// is logged and NOT retried — the terminal is open and usable, the user
    /// simply types the prompt themselves.
    ///
    /// Does a blocking PTY write; lib.rs invokes it via `spawn_blocking` so
    /// the hook chain is never parked on it.
    pub fn on_session_started(&self, session_id: u32) {
        let Some(prompt) = self
            .armed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&session_id)
        else {
            return;
        };
        let chars = prompt.chars().count();
        if let Err(e) = (self.deliver)(session_id, prompt) {
            log::error!(
                "initial prompt: injection into session {session_id} failed: {e} — the terminal is open, the prompt was not typed"
            );
        } else {
            log::info!("initial prompt: injected {chars} chars into session {session_id}");
        }
    }
}

/// Arms a one-shot initial prompt for a just-launched session. TerminalGrid
/// calls this right before it types the CLI command, so the injection gate is
/// set strictly ahead of claude's SessionStart hook. The prompt is
/// whitespace-normalized backend-side; callers may pass multi-line text.
///
/// `brief_dir` + `brief_stem` are optional: supplying both lets a long prompt
/// be staged as `<brief_dir>/.maestro/briefs/<brief_stem>.md` and delivered as
/// a pointer (issue #138). Callers that omit them keep the inline delivery.
///
/// `(async)` because the body does real blocking I/O — a brief write of
/// several KB — and a plain `#[tauri::command]` on a
/// sync function runs on the MAIN thread, freezing the UI for the duration.
/// The frontend still awaits the call, so the arm stays strictly ordered ahead
/// of the CLI command TerminalGrid types next.
#[tauri::command(async)]
pub fn terminal_arm_initial_prompt(
    injector: State<'_, Arc<InitialPromptInjector>>,
    session_id: u32,
    prompt: String,
    brief_dir: Option<String>,
    brief_stem: Option<String>,
) -> Result<(), String> {
    injector.arm(session_id, &prompt, brief_target(brief_dir, brief_stem))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Captured `(session_id, prompt)` pairs handed to a stubbed [`DeliverFn`].
    type DeliveredPrompts = Arc<Mutex<Vec<(u32, String)>>>;

    /// A multi-line prompt whose FLATTENED form is over the inline budget —
    /// the shape a PR action launch produces once several steps are ticked.
    fn long_prompt() -> String {
        format!(
            "You are monitoring one GitHub pull request.\n\n{}\nStep 1: check the status.\n",
            "RULE: read every existing comment on the PR before you write one.\n".repeat(12)
        )
    }

    /// The brief target a PR action launch passes: the project checkout plus
    /// the run's stem.
    fn target(dir: &std::path::Path, stem: &str) -> BriefTarget {
        BriefTarget {
            dir: dir.to_path_buf(),
            stem: stem.to_string(),
        }
    }

    /// An injector whose deliveries are captured, plus the capture handle.
    fn injector() -> (InitialPromptInjector, DeliveredPrompts) {
        let delivered: Arc<Mutex<Vec<(u32, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = delivered.clone();
        let deliver: DeliverFn = Arc::new(move |session_id, prompt| {
            sink.lock().unwrap().push((session_id, prompt));
            Ok(())
        });
        (InitialPromptInjector::new(deliver), delivered)
    }

    #[test]
    fn test_normalize_collapses_every_whitespace_run_to_one_space() {
        // THE PTY rule: a newline inside an injected prompt submits a partial
        // message, so nothing but single spaces may survive.
        let normalized = normalize_prompt("  first line\r\nsecond\tline\n\n  third   line \n");
        assert_eq!(normalized, "first line second line third line");
        assert!(!normalized.contains('\n'));
        assert!(!normalized.contains('\r'));
        assert!(!normalized.contains('\t'));
        assert!(!normalized.contains("  "));
        // Already-flat text is untouched.
        assert_eq!(normalize_prompt("review the diff"), "review the diff");
        // Whitespace-only normalizes to nothing (the arm refusal below).
        assert_eq!(normalize_prompt(" \r\n\t "), "");
    }

    #[test]
    fn test_arm_refuses_an_empty_prompt_with_the_pinned_message() {
        let (injector, delivered) = injector();
        assert_eq!(
            injector.arm(7, "   \n\t  ", None).unwrap_err(),
            "Cannot launch with an empty initial prompt."
        );
        assert_eq!(injector.arm(7, "", None).unwrap_err(), EMPTY_PROMPT);
        // Nothing armed: a SessionStarted delivers nothing.
        injector.on_session_started(7);
        assert!(delivered.lock().unwrap().is_empty());
    }

    #[test]
    fn test_injection_happens_once_on_the_armed_session_only() {
        let (injector, delivered) = injector();
        injector
            .arm(42, "read CLAUDE.md\nthen summarise it", None)
            .unwrap();

        // An unrelated session's start delivers nothing.
        injector.on_session_started(99);
        assert!(delivered.lock().unwrap().is_empty());

        // The armed session's start IS the injection — normalized to one line.
        injector.on_session_started(42);
        {
            let d = delivered.lock().unwrap();
            assert_eq!(d.len(), 1);
            assert_eq!(d[0].0, 42);
            assert_eq!(d[0].1, "read CLAUDE.md then summarise it");
        }

        // Disarmed on delivery: a later SessionStarted (e.g. `/clear`) in the
        // same terminal never re-types the prompt.
        injector.on_session_started(42);
        assert_eq!(delivered.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_sessions_keep_their_own_prompts_and_rearm_replaces() {
        let (injector, delivered) = injector();
        injector.arm(1, "prompt one", None).unwrap();
        injector.arm(2, "prompt two", None).unwrap();
        // One session gets ONE initial prompt: a re-arm before the session
        // starts replaces, never queues.
        injector.arm(1, "prompt one revised", None).unwrap();

        injector.on_session_started(2);
        injector.on_session_started(1);
        assert_eq!(
            *delivered.lock().unwrap(),
            vec![
                (2, "prompt two".to_string()),
                (1, "prompt one revised".to_string()),
            ]
        );
    }

    #[test]
    fn test_a_long_prompt_with_a_brief_target_arms_the_pointer_at_a_verbatim_brief() {
        // The #138 fix: a multi-KB PR action prompt is no longer typed at all.
        // What is typed is a one-line pointer; what the agent reads is the
        // ORIGINAL prompt, newlines and all.
        let dir = tempdir().unwrap();
        let (injector, delivered) = injector();
        let prompt = long_prompt();
        assert!(normalize_prompt(&prompt).len() > brief_files::INLINE_MAX_BYTES);

        injector
            .arm(5, &prompt, Some(target(dir.path(), "pr-138-check-review")))
            .unwrap();
        injector.on_session_started(5);

        let d = delivered.lock().unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(
            d[0].1,
            brief_files::pointer_instruction(".maestro/briefs/pr-138-check-review.md")
        );
        // Still PTY-safe: the typed text is one line, well under the payload
        // size that was observed arriving spliced.
        assert!(!d[0].1.contains('\n'), "{}", d[0].1);
        assert!(!d[0].1.contains('\r'), "{}", d[0].1);

        assert_eq!(
            std::fs::read_to_string(dir.path().join(".maestro/briefs/pr-138-check-review.md"))
                .unwrap(),
            prompt,
            "the brief holds the original prompt byte for byte"
        );
        assert!(prompt.contains('\n'), "its structure survived");
    }

    #[test]
    fn test_a_long_prompt_without_a_brief_target_is_armed_flattened_inline() {
        // Regression pin: a caller that stages no brief gets EXACTLY today's
        // behaviour — the whole prompt, flattened onto one line.
        let (injector, delivered) = injector();
        let prompt = long_prompt();

        injector.arm(5, &prompt, None).unwrap();
        injector.on_session_started(5);

        let d = delivered.lock().unwrap();
        assert_eq!(d[0].1, normalize_prompt(&prompt));
        assert!(d[0].1.len() > brief_files::INLINE_MAX_BYTES);
        assert!(!d[0].1.contains('\n'));
    }

    #[test]
    fn test_a_short_prompt_with_a_brief_target_stays_inline_and_writes_no_file() {
        // Short prompts keep the delivery that already works — routing them
        // through a file would add an unread-file failure mode for nothing.
        let dir = tempdir().unwrap();
        let (injector, delivered) = injector();

        injector
            .arm(
                5,
                "review the diff\nand summarise it",
                Some(target(dir.path(), "pr-138-check")),
            )
            .unwrap();
        injector.on_session_started(5);

        assert_eq!(
            delivered.lock().unwrap()[0].1,
            "review the diff and summarise it"
        );
        assert!(
            !dir.path().join(brief_files::BRIEF_DIR).exists(),
            "no brief written"
        );
    }

    #[test]
    fn test_a_hostile_brief_stem_cannot_escape_the_brief_directory() {
        // `brief_stem` is frontend text crossing the IPC boundary, so the
        // sanitising has to happen backend-side: a traversal must resolve
        // INSIDE `.maestro/briefs/`, never above it.
        let dir = tempdir().unwrap();
        let worktree = dir.path().join("checkout");
        std::fs::create_dir_all(&worktree).unwrap();
        let (injector, delivered) = injector();
        let prompt = long_prompt();

        injector
            .arm(5, &prompt, Some(target(&worktree, "../../escaped")))
            .unwrap();
        injector.on_session_started(5);

        assert_eq!(
            delivered.lock().unwrap()[0].1,
            brief_files::pointer_instruction(".maestro/briefs/escaped.md")
        );
        assert!(worktree.join(".maestro/briefs/escaped.md").is_file());
        assert!(!dir.path().join("escaped.md").exists(), "nothing escaped");
    }

    #[test]
    fn test_a_failed_brief_write_falls_back_to_the_flattened_prompt() {
        // No new failure mode: an unwritable brief (here `.maestro` occupied
        // by a file) arms exactly what pre-#138 armed.
        //
        // #138 c4 also asks for a logged warning. That half is pinned by code
        // review only — `arm` emits `log::warn!` and nothing here asserts it,
        // because capturing `log` output needs a process-global logger that
        // would race every other test.
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".maestro"), "not a directory").unwrap();
        let (injector, delivered) = injector();
        let prompt = long_prompt();

        injector
            .arm(5, &prompt, Some(target(dir.path(), "pr-138-check")))
            .unwrap();
        injector.on_session_started(5);

        assert_eq!(delivered.lock().unwrap()[0].1, normalize_prompt(&prompt));
    }

    #[test]
    fn test_a_brief_target_does_not_soften_the_empty_prompt_refusal() {
        let dir = tempdir().unwrap();
        let (injector, delivered) = injector();

        assert_eq!(
            injector
                .arm(7, "  \r\n\t ", Some(target(dir.path(), "pr-138-check")))
                .unwrap_err(),
            EMPTY_PROMPT
        );

        injector.on_session_started(7);
        assert!(delivered.lock().unwrap().is_empty());
        assert!(
            !dir.path().join(brief_files::BRIEF_DIR).exists(),
            "a refused prompt writes nothing"
        );
    }

    #[test]
    fn test_a_brief_armed_session_still_injects_exactly_once() {
        // Disarm-BEFORE-deliver is unchanged by the brief route: a later
        // SessionStarted in the same terminal (e.g. `/clear`) re-types
        // nothing, and a re-arm before the session starts replaces.
        let dir = tempdir().unwrap();
        let (injector, delivered) = injector();
        let prompt = long_prompt();
        injector
            .arm(5, &prompt, Some(target(dir.path(), "pr-138-check")))
            .unwrap();
        injector
            .arm(5, &prompt, Some(target(dir.path(), "pr-138-check-review")))
            .unwrap();

        injector.on_session_started(5);
        injector.on_session_started(5);

        let d = delivered.lock().unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(
            d[0].1,
            brief_files::pointer_instruction(".maestro/briefs/pr-138-check-review.md")
        );
    }

    #[test]
    fn test_a_brief_target_needs_both_halves_to_be_present() {
        // The command's optional params: anything short of a directory AND a
        // stem is "no brief target", which is today's inline behaviour.
        assert!(brief_target(None, None).is_none());
        assert!(brief_target(Some("C:/proj".into()), None).is_none());
        assert!(brief_target(None, Some("pr-138-check".into())).is_none());
        assert!(brief_target(Some("  ".into()), Some("pr-138-check".into())).is_none());
        assert!(brief_target(Some("C:/proj".into()), Some("  ".into())).is_none());

        let staged = brief_target(Some("C:/proj".into()), Some("pr-138-check".into())).unwrap();
        assert_eq!(staged.dir, PathBuf::from("C:/proj"));
        assert_eq!(staged.stem, "pr-138-check");
    }

    #[test]
    fn test_failed_write_leaves_the_session_disarmed_and_rearmable() {
        // The session is disarmed before delivery,
        // so a failed write injects nothing further, and a fresh arm retries
        // cleanly. Nothing to roll back — no side effect rides on the write.
        let attempts = Arc::new(Mutex::new(0u32));
        let sink = attempts.clone();
        let deliver: DeliverFn = Arc::new(move |_, _| {
            *sink.lock().unwrap() += 1;
            Err("writing instruction to session 7 failed: session not found".to_string())
        });
        let injector = InitialPromptInjector::new(deliver);

        injector.arm(7, "do the thing", None).unwrap();
        injector.on_session_started(7);
        assert_eq!(*attempts.lock().unwrap(), 1, "one delivery attempt");

        injector.on_session_started(7);
        assert_eq!(*attempts.lock().unwrap(), 1, "disarmed by the attempt");

        injector.arm(7, "do the thing", None).unwrap();
        injector.on_session_started(7);
        assert_eq!(*attempts.lock().unwrap(), 2, "a fresh arm retries cleanly");
    }
}
