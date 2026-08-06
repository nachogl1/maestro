//! Samurai instruction text builders (Phase 2, issues #53/#54/#55; PRD §5.3,
//! §5.4, §5.6, §6).
//!
//! Injected instructions travel through `ProcessManager::write_stdin`
//! straight into a live terminal, so every builder returns ONE paste-able
//! line — no embedded newlines, which the terminal would treat as an early
//! submit. The injector appends the final `\r` itself. Multi-part briefs use
//! numbered clauses instead of line breaks.
//!
//! Issue #54 ships the full handoff brief (write the §6 file, commit WIP,
//! reply with the written marker) plus the one corrective re-instruction the
//! injector sends when validation fails. The epic slug and handoff file path
//! live here too, next to the text that dictates them, so the injector's
//! validator and P2.4's successor reader resolve exactly the path the
//! orchestrator was told to write.
//!
//! Issue #55 adds the successor's verify ritual (PRD §5.6): the one-line
//! brief every gen-N+1 receives on its first `SessionStarted`, plus the
//! tolerant HEAD-SHA parser for the handoff's "Repo state" section. The
//! HEAD gate itself (does the repo HEAD equal that SHA?) is computed by
//! Maestro in `samurai_replicator` — never trusted to the model.
//!
//! Issue #56 adds recovery mode (PRD §5.6/§5.7): the ritual a successor gets
//! when its predecessor died — or its handoff file vanished — without a valid
//! handoff to read, plus the path of the pre-digested transcript summary that
//! prompt references (written by `samurai_replicator`, never inlined).

/// The exact acknowledgement value generation `generation` must echo inside
/// `<samurai-ack>…</samurai-ack>`. The injector's ACK scanner expects this
/// same string — built here so instruction and scanner can never drift.
pub fn handoff_ack_value(generation: u32) -> String {
    format!("handoff gen-{generation}")
}

/// The CORRECTIVE round's ACK value. Round-scoped on purpose: after a failed
/// first round the injector resets `acked` and waits again — if the corrective
/// expected the same value as round 1, a transcript replay (`claude --resume`
/// copies history into a new transcript, which the watcher reads from byte 0)
/// would re-surface the round-1 ACK and consume the corrective round before
/// the corrective instruction was ever injected.
pub fn handoff_ack_retry_value(generation: u32) -> String {
    format!("handoff gen-{generation} retry")
}

/// The exact value generation `generation` must echo inside
/// `<samurai-handoff-written>…</samurai-handoff-written>` once the handoff
/// file is written and WIP is committed. Same drift-proofing as
/// [`handoff_ack_value`].
pub fn handoff_written_value(generation: u32) -> String {
    format!("gen-{generation}")
}

/// The CORRECTIVE round's written-marker value — round-scoped for the same
/// replay reason as [`handoff_ack_retry_value`].
pub fn handoff_written_retry_value(generation: u32) -> String {
    format!("gen-{generation} retry")
}

/// The park instruction's ACK value (issue #60). Kind-scoped (`park …`, never
/// the handoff spelling): a transcript replay of an earlier handoff ACK for
/// the same generation must not acknowledge a park instruction.
pub fn park_ack_value(generation: u32) -> String {
    format!("park gen-{generation}")
}

/// The park CORRECTIVE round's ACK value — round-scoped for the same replay
/// reason as [`handoff_ack_retry_value`].
pub fn park_ack_retry_value(generation: u32) -> String {
    format!("park gen-{generation} retry")
}

/// The park instruction's written-marker value. Kind-scoped (`… park`): the
/// park reuses the handoff written TAG and file, so only the value keeps a
/// replayed handoff marker (`gen-N`) from validating a park.
pub fn park_written_value(generation: u32) -> String {
    format!("gen-{generation} park")
}

/// The park CORRECTIVE round's written-marker value.
pub fn park_written_retry_value(generation: u32) -> String {
    format!("gen-{generation} park retry")
}

/// The soft wind-down instruction's ACK value (issue #60). Generation-scoped
/// like every other marker value; there is no written stage — the ACK alone
/// completes the instruction.
pub fn soft_winddown_ack_value(generation: u32) -> String {
    format!("winddown gen-{generation}")
}

/// Filesystem-safe slug of an epic ref for the handoff filename: `#37` →
/// `37`, `https://github.com/o/r/issues/9` → `https-github-com-o-r-issues-9`.
/// ASCII alphanumerics are kept (lowercased); every other run of characters
/// collapses to one `-`; a ref with nothing usable falls back to `epic`.
/// P2.4's successor reader must use this same function to find the file.
/// Distinct refs can collide (`#37` and `37` both slug to `37`); accepted —
/// worktrees are one-per-epic (PRD §5.9), so colliding refs would already be
/// sharing a working directory, which is the real isolation boundary.
pub fn epic_slug(epic: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for c in epic.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(c.to_ascii_lowercase());
            pending_dash = false;
        } else {
            pending_dash = true;
        }
    }
    if slug.is_empty() {
        "epic".to_string()
    } else {
        slug
    }
}

/// Repo-relative path of the gen-`generation` handoff file (PRD §6:
/// `.maestro/handoffs/<epic>-gen<N>.md`, epic sanitized via [`epic_slug`]).
/// Forward slashes on purpose: they appear verbatim in the instruction text
/// and `Path::join` accepts them on every platform.
pub fn handoff_file_relpath(epic: &str, generation: u32) -> String {
    format!(".maestro/handoffs/{}-gen{generation}.md", epic_slug(epic))
}

/// Parses the generation number out of a handoff FILENAME shaped by
/// [`handoff_file_relpath`] — `<slug>-gen<N>.md` → `Some(N)`. The resume path
/// (issue #61) scans `.maestro/handoffs/` with this to find the latest
/// generation on disk. Anything else returns `None` — including the
/// `-recovery` digests ([`recovery_digest_relpath`]), whose tail after
/// `-gen<N>` is not all digits. `rsplit_once` takes the LAST `-gen`, so an
/// epic slug that itself contains `-gen` (e.g. `x-gen5-gen2.md`) still
/// parses the real generation.
pub fn parse_handoff_generation(filename: &str) -> Option<u32> {
    let stem = filename.strip_suffix(".md")?;
    let (_, tail) = stem.rsplit_once("-gen")?;
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    tail.parse().ok()
}

/// Full idle-injected handoff instruction (PRD §5.4 + §6): immediate ACK,
/// wind down subagents, gitignore `.maestro/`, commit WIP, write the §6
/// handoff file, then reply with the written marker. Single line by
/// construction (see module doc). The WIP commit is briefed before the file
/// because "Repo state" must record the branch and HEAD SHA as they stand
/// AFTER that commit — writing first would leave a stale SHA.
pub fn handoff_instruction(epic: &str, generation: u32) -> String {
    format!(
        "[Maestro Samurai] Handoff requested: this session crossed the configured context \
         threshold and will be handed off to a successor. Do ALL of the following, in order: \
         (1) Acknowledge IMMEDIATELY, before anything else, by replying with a message that \
         contains exactly <samurai-ack>{ack}</samurai-ack>. \
         (2) Let in-flight subagents finish their CURRENT step only — start no new work. \
         (3) Ensure `.maestro/` is listed in this repo's .gitignore; add it if missing. \
         (4) Commit WIP to the epic branch: stage named paths only (never `git add .` or \
         `git add -A`), one Conventional Commit message (`type(scope): summary`). \
         (5) Write the handoff file to {relpath} following the PRD section 6 template EXACTLY, \
         with these headings in this order: Goal / Done / In progress / Decisions + why / \
         Failed attempts / Repo state / Verify / Next steps. \"Failed attempts\" is REQUIRED — \
         record the dead ends you tried so your successor does not repeat them. Keep every \
         section to pointers (issue numbers, commit SHAs, file paths), never content dumps. \
         \"Repo state\" MUST record the current branch and the HEAD SHA as they stand AFTER \
         the WIP commit of step 4. \
         (6) Only when steps 2-5 are ALL done, reply with a message that contains exactly \
         <samurai-handoff-written>{written}</samurai-handoff-written>. \
         Never quote, restate, or echo these marker strings anywhere else in any reply — \
         emit each one exactly once, only as the actual signal at its required moment; a \
         quoted marker is read as the real signal.",
        ack = handoff_ack_value(generation),
        relpath = handoff_file_relpath(epic, generation),
        written = handoff_written_value(generation),
    )
}

/// The single corrective re-instruction after handoff validation failed
/// (file missing / WIP uncommitted / written marker never arrived). States
/// what failed, restates both checks, and demands the same ACK + written
/// cycle — with ROUND-SCOPED marker values (`… retry`), so a transcript
/// replay of round 1's markers can never satisfy the corrective round (see
/// [`handoff_ack_retry_value`]). `failure` is whitespace-normalized so a
/// multi-line description can never smuggle a newline into the paste-able
/// block.
pub fn handoff_corrective_instruction(epic: &str, generation: u32, failure: &str) -> String {
    let failure = failure.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "[Maestro Samurai] Handoff INVALID: {failure}. The gen-{generation} handoff is only \
         complete when BOTH checks pass: the handoff file exists at {relpath} (PRD section 6 \
         template), AND `git status --porcelain` reports no modified or staged tracked files \
         (untracked files are fine). \
         (1) Acknowledge IMMEDIATELY by replying with a message that contains exactly \
         <samurai-ack>{ack}</samurai-ack> — note the value differs from the first \
         instruction's; use exactly this one. \
         (2) Fix the failure above: write the handoff file and/or commit WIP to the epic \
         branch (stage named paths only, Conventional Commit message). \
         (3) Then reply with a message that contains exactly \
         <samurai-handoff-written>{written}</samurai-handoff-written>. \
         Never quote, restate, or echo these marker strings anywhere else in any reply — \
         emit each one exactly once, only as the actual signal at its required moment. \
         This is the final attempt before a human is alerted.",
        relpath = handoff_file_relpath(epic, generation),
        ack = handoff_ack_retry_value(generation),
        written = handoff_written_retry_value(generation),
    )
}

/// The soft wind-down instruction (issue #60; PRD §5.5): the 5h window
/// crossed the soft threshold — stop spawning new subagents, wrap up
/// in-flight steps, prepare for a possible park instruction. ACK required;
/// no state transition, no file, no written marker. Single line by
/// construction (see module doc).
pub fn soft_winddown_instruction(generation: u32) -> String {
    format!(
        "[Maestro Samurai] Allowance wind-down: the token allowance for this account is \
         approaching its limit. Do the following: \
         (1) Acknowledge IMMEDIATELY, before anything else, by replying with a message that \
         contains exactly <samurai-ack>{ack}</samurai-ack>. \
         (2) From now on spawn NO new subagents; let in-flight subagents finish their CURRENT \
         step only, then wrap up. \
         (3) Prefer finishing and committing small complete units of work — a park instruction \
         may follow shortly, and anything uncommitted at that point is at risk. \
         No file needs to be written for this instruction. Never quote, restate, or echo the \
         marker string anywhere else in any reply — emit it exactly once, only as the actual \
         signal.",
        ack = soft_winddown_ack_value(generation),
    )
}

/// The park instruction (issue #60; PRD §5.5): a hard allowance threshold
/// crossed, so this session is being parked. Finish the current atomic step
/// ONLY, write/update the standard handoff file (it doubles as park state —
/// PRD §5.2), commit ALL WIP, then emit the written tag. Mirrors
/// [`handoff_instruction`] step for step: the injector validates with the
/// same two checks against the same [`handoff_file_relpath`]. Single line by
/// construction (see module doc).
pub fn park_instruction(epic: &str, generation: u32) -> String {
    format!(
        "[Maestro Samurai] PARK requested: the token allowance is nearly spent, so this \
         session is being parked; work resumes automatically after the allowance window \
         resets. Do ALL of the following, in order: \
         (1) Acknowledge IMMEDIATELY, before anything else, by replying with a message that \
         contains exactly <samurai-ack>{ack}</samurai-ack>. \
         (2) Finish the CURRENT atomic step ONLY — let in-flight subagents finish their \
         current step, start NOTHING new. \
         (3) Ensure `.maestro/` is listed in this repo's .gitignore; add it if missing. \
         (4) Commit ALL WIP to the epic branch: stage named paths only (never `git add .` or \
         `git add -A`), one Conventional Commit message (`type(scope): summary`). \
         (5) Write or update the handoff file at {relpath} following the PRD section 6 \
         template EXACTLY, with these headings in this order: Goal / Done / In progress / \
         Decisions + why / Failed attempts / Repo state / Verify / Next steps. It doubles as \
         the park state your successor resumes from, so keep every section to pointers \
         (issue numbers, commit SHAs, file paths), never content dumps. \"Repo state\" MUST \
         record the current branch and the HEAD SHA as they stand AFTER the WIP commit of \
         step 4. \
         (6) Only when steps 2-5 are ALL done, reply with a message that contains exactly \
         <samurai-handoff-written>{written}</samurai-handoff-written>. \
         Never quote, restate, or echo these marker strings anywhere else in any reply — \
         emit each one exactly once, only as the actual signal at its required moment; a \
         quoted marker is read as the real signal.",
        ack = park_ack_value(generation),
        relpath = handoff_file_relpath(epic, generation),
        written = park_written_value(generation),
    )
}

/// The single corrective re-instruction after park validation failed —
/// mirrors [`handoff_corrective_instruction`] with the park's round-scoped
/// marker values. `failure` is whitespace-normalized for the same
/// paste-safety reason.
pub fn park_corrective_instruction(epic: &str, generation: u32, failure: &str) -> String {
    let failure = failure.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "[Maestro Samurai] Park INVALID: {failure}. The gen-{generation} park is only \
         complete when BOTH checks pass: the handoff file exists at {relpath} (PRD section 6 \
         template), AND `git status --porcelain` reports no modified or staged tracked files \
         (untracked files are fine). \
         (1) Acknowledge IMMEDIATELY by replying with a message that contains exactly \
         <samurai-ack>{ack}</samurai-ack> — note the value differs from the first \
         instruction's; use exactly this one. \
         (2) Fix the failure above: write/update the handoff file and/or commit ALL WIP to \
         the epic branch (stage named paths only, Conventional Commit message). \
         (3) Then reply with a message that contains exactly \
         <samurai-handoff-written>{written}</samurai-handoff-written>. \
         Never quote, restate, or echo these marker strings anywhere else in any reply — \
         emit each one exactly once, only as the actual signal at its required moment. \
         This is the final attempt before a human is alerted.",
        relpath = handoff_file_relpath(epic, generation),
        ack = park_ack_retry_value(generation),
        written = park_written_retry_value(generation),
    )
}

/// Display name for a successor terminal session (issue #55), e.g.
/// `samurai gen-3 37`. Built here so the backend event payload and any
/// future surface naming successors can never drift.
pub fn successor_session_name(epic: &str, generation: u32) -> String {
    format!("samurai gen-{generation} {}", epic_slug(epic))
}

/// Pulls the predecessor's HEAD SHA out of a §6 handoff file: the first
/// 40-character hex token found in the "Repo state" section. Deliberately
/// tolerant (PRD decision #5 forbids template validation, so the section is
/// model-written prose): the section starts at the first line that mentions
/// "repo state" (case-insensitive, heading or not) and ends at the next
/// markdown heading; within it, any standalone 40-hex run counts. Runs
/// embedded in a longer alphanumeric word are rejected — that is not a SHA,
/// that is a substring. `None` when the section or the SHA is missing; the
/// replicator treats that as a HEAD mismatch (verify required).
pub fn handoff_head_sha(content: &str) -> Option<String> {
    let mut section = String::new();
    let mut in_section = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        let is_heading = trimmed.starts_with('#');
        if in_section && is_heading {
            break; // next section begins
        }
        if !in_section {
            if trimmed.to_ascii_lowercase().contains("repo state") {
                in_section = true;
                // The SHA may sit on the marker line itself
                // ("Repo state: main @ <sha>").
                section.push_str(trimmed);
                section.push('\n');
            }
            continue;
        }
        section.push_str(line);
        section.push('\n');
    }
    find_forty_hex(&section)
}

/// First maximal run of exactly 40 ASCII hex digits with non-alphanumeric
/// boundaries. Returned as found (git compares SHAs case-insensitively; so
/// does the replicator's gate).
fn find_forty_hex(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_hexdigit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
            i += 1;
        }
        let bounded_left = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let bounded_right = i == bytes.len() || !bytes[i].is_ascii_alphanumeric();
        if i - start == 40 && bounded_left && bounded_right {
            return Some(text[start..i].to_string());
        }
    }
    None
}

/// The successor's first instruction (PRD §5.6 — one recovery path): read
/// the predecessor's handoff in full, then either skip or run its Verify
/// commands depending on the HEAD gate MAESTRO computed. Single line by
/// construction (see module doc); the epic ref is whitespace-normalized so
/// a pathological ref can never smuggle a newline into the paste.
pub fn successor_ritual_instruction(
    epic: &str,
    predecessor_generation: u32,
    head_matched: bool,
) -> String {
    let epic_text = epic.split_whitespace().collect::<Vec<_>>().join(" ");
    let generation = predecessor_generation + 1;
    let relpath = handoff_file_relpath(epic, predecessor_generation);
    let opening = format!(
        "[Maestro Samurai] You are generation {generation} for epic {epic_text}, successor to \
         generation {predecessor_generation}. Read the handoff file at {relpath} IN FULL before \
         doing anything else — it and GitHub are your only sources of truth."
    );
    if head_matched {
        format!(
            "{opening} Maestro verified that this repository's current HEAD equals the SHA \
             recorded in the handoff's \"Repo state\" section, so the verify step is already \
             satisfied: SKIP the commands in the handoff's Verify section and continue directly \
             with its Next steps."
        )
    } else {
        format!(
            "{opening} Maestro could NOT confirm that this repository's current HEAD matches the \
             SHA recorded in the handoff's \"Repo state\" section. You MUST run every command in \
             the handoff's Verify section FIRST, and trust NOTHING the handoff claims that those \
             commands do not confirm — investigate and fix any failure before moving on. Only \
             then continue with the handoff's Next steps."
        )
    }
}

/// Repo-relative path of the pre-digested transcript summary Maestro writes
/// for a gen-`successor_generation` RECOVERY successor (issue #56). Lives
/// next to the handoffs so the Second Brain panel's file listing picks it up;
/// the `-recovery` suffix keeps it from ever colliding with a real handoff.
pub fn recovery_digest_relpath(epic: &str, successor_generation: u32) -> String {
    format!(
        ".maestro/handoffs/{}-gen{successor_generation}-recovery.md",
        epic_slug(epic)
    )
}

/// The successor's first instruction when there is NO handoff to read
/// (issue #56, PRD §5.6 recovery mode): the predecessor died — or its
/// validated handoff file vanished before successor prep. Reconstruction
/// sources in priority order: git history, the epic's GitHub issue, and the
/// pre-digested transcript summary (hints, not truth) — then the project's
/// standard verification BEFORE trusting anything. Single line by
/// construction (see module doc); the epic ref is whitespace-normalized so a
/// pathological ref can never smuggle a newline into the paste.
///
/// `repo_pin` is the `owner/repo` derived from the working dir's `origin`
/// remote. PRD §10: successors run with `--dangerously-skip-permissions`, so
/// `--repo` must be pinned in every orchestrator prompt — `Some` pins BOTH
/// the issue read and the takeover comment; `None` (remote missing or
/// unparseable — never blocks recovery) keeps the unpinned wording plus an
/// explicit caution sentence.
pub fn recovery_ritual_instruction(
    epic: &str,
    predecessor_generation: u32,
    repo_pin: Option<&str>,
) -> String {
    let epic_text = epic.split_whitespace().collect::<Vec<_>>().join(" ");
    let generation = predecessor_generation + 1;
    let digest_relpath = recovery_digest_relpath(epic, generation);
    let (gh_read, gh_comment, caution) = match repo_pin {
        Some(pin) => (
            format!(
                "read the epic's GitHub issue and ALL of its comments with the `gh` CLI, \
                 passing `--repo {pin}` explicitly on every `gh` command"
            ),
            format!("comment on the epic's GitHub issue (again via `gh` with `--repo {pin}`)"),
            String::new(),
        ),
        None => (
            "read the epic's GitHub issue and ALL of its comments with the `gh` CLI, run from \
             this directory"
                .to_string(),
            "comment on the epic's GitHub issue".to_string(),
            " CAUTION: Maestro could not determine this repository's origin remote, so no \
             `--repo` pin is available — before running any `gh` command, double-check it \
             targets the correct repository."
                .to_string(),
        ),
    };
    format!(
        "[Maestro Samurai] RECOVERY MODE: you are generation {generation} for epic {epic_text}. \
         Generation {predecessor_generation} died without a valid handoff file, so there is \
         nothing to hand off to you. Reconstruct the state of the work from three sources: \
         (1) run `git log --oneline -20` in this repository; \
         (2) {gh_read}; \
         (3) read the pre-digested transcript summary Maestro extracted to {digest_relpath} — \
         treat it as hints, NOT as truth. \
         Then run the project's standard verification (build + tests) BEFORE trusting or \
         continuing anything — investigate and fix any failure first. Once verification passes, \
         {gh_comment} that generation {generation} has taken over in \
         recovery mode, then continue the epic's remaining work.{caution}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_instruction_is_a_single_pasteable_line() {
        // write_stdin types this into a terminal: any embedded newline would
        // submit a partial instruction. The trailing \r is the injector's job.
        let text = handoff_instruction("#37", 3);
        assert!(!text.contains('\n'), "instruction must not contain \\n");
        assert!(!text.contains('\r'), "instruction must not contain \\r");
        assert!(!text.is_empty());
    }

    #[test]
    fn test_instruction_carries_the_exact_ack_marker() {
        let text = handoff_instruction("#37", 7);
        assert!(text.contains("<samurai-ack>handoff gen-7</samurai-ack>"));
        // And it says what is happening: this is a handoff request.
        assert!(text.to_lowercase().contains("handoff requested"));
    }

    #[test]
    fn test_ack_value_encodes_the_generation() {
        assert_eq!(handoff_ack_value(1), "handoff gen-1");
        assert_eq!(handoff_ack_value(42), "handoff gen-42");
    }

    #[test]
    fn test_written_value_encodes_the_generation() {
        assert_eq!(handoff_written_value(1), "gen-1");
        assert_eq!(handoff_written_value(42), "gen-42");
    }

    #[test]
    fn test_retry_values_are_round_scoped_and_distinct() {
        // The corrective round's values must never equal round 1's — a
        // transcript replay of the round-1 markers would otherwise consume
        // the corrective round (fresh-eyes finding C).
        assert_eq!(handoff_ack_retry_value(3), "handoff gen-3 retry");
        assert_eq!(handoff_written_retry_value(3), "gen-3 retry");
        assert_ne!(handoff_ack_retry_value(3), handoff_ack_value(3));
        assert_ne!(handoff_written_retry_value(3), handoff_written_value(3));
    }

    #[test]
    fn test_epic_slug_is_filesystem_safe() {
        assert_eq!(epic_slug("#37"), "37");
        assert_eq!(
            epic_slug("https://github.com/o/r/issues/9"),
            "https-github-com-o-r-issues-9"
        );
        assert_eq!(epic_slug("Epic 12: Auth"), "epic-12-auth");
        assert_eq!(epic_slug("epic-12"), "epic-12");
        // Nothing usable falls back rather than producing an empty filename.
        assert_eq!(epic_slug(""), "epic");
        assert_eq!(epic_slug("###"), "epic");
        // No leading/trailing separators, no runs.
        assert_eq!(epic_slug("--a//b--"), "a-b");
    }

    #[test]
    fn test_handoff_file_relpath_shape() {
        assert_eq!(
            handoff_file_relpath("#37", 2),
            ".maestro/handoffs/37-gen2.md"
        );
        assert_eq!(
            handoff_file_relpath("Epic 12", 10),
            ".maestro/handoffs/epic-12-gen10.md"
        );
    }

    #[test]
    fn test_parse_handoff_generation_roundtrips_the_relpath() {
        // The parser must accept exactly what handoff_file_relpath produces.
        for (epic, generation) in [("#37", 1), ("#37", 42), ("Epic 12: Auth", 10), ("", 3)] {
            let relpath = handoff_file_relpath(epic, generation);
            let filename = relpath.rsplit('/').next().unwrap();
            assert_eq!(
                parse_handoff_generation(filename),
                Some(generation),
                "roundtrip failed for {relpath}"
            );
        }
        // A slug that itself contains `-gen<digits>`: the LAST -gen wins.
        assert_eq!(parse_handoff_generation("x-gen5-gen2.md"), Some(2));
    }

    #[test]
    fn test_parse_handoff_generation_rejects_non_handoffs() {
        // Recovery digests are not handoffs.
        assert_eq!(parse_handoff_generation("37-gen3-recovery.md"), None);
        // Missing/garbled pieces.
        assert_eq!(parse_handoff_generation("37-gen.md"), None);
        assert_eq!(parse_handoff_generation("37-gen2"), None); // no .md
        assert_eq!(parse_handoff_generation("37-gen2x.md"), None);
        assert_eq!(parse_handoff_generation("37.md"), None);
        assert_eq!(parse_handoff_generation(""), None);
        // Overflow parses as None rather than panicking.
        assert_eq!(parse_handoff_generation("37-gen99999999999999999999.md"), None);
    }

    #[test]
    fn test_instruction_carries_the_full_handoff_brief() {
        let text = handoff_instruction("#37", 2);
        // The written marker with its exact value.
        assert!(text.contains("<samurai-handoff-written>gen-2</samurai-handoff-written>"));
        // The exact file location the validator will check.
        assert!(text.contains(".maestro/handoffs/37-gen2.md"));
        // Every §6 heading, the required one called out, pointers-not-dumps,
        // branch + HEAD SHA after the WIP commit.
        for heading in [
            "Goal",
            "Done",
            "In progress",
            "Decisions + why",
            "Failed attempts",
            "Repo state",
            "Verify",
            "Next steps",
        ] {
            assert!(text.contains(heading), "missing heading {heading}");
        }
        assert!(text.contains("REQUIRED"));
        assert!(text.contains("never content dumps"));
        assert!(text.contains("HEAD SHA"));
        assert!(text.contains("AFTER"));
        // Wind-down and gitignore clauses.
        assert!(text.contains("CURRENT step only"));
        assert!(text.contains(".gitignore"));
        // WIP commit discipline.
        assert!(text.contains("stage named paths only"));
        assert!(text.contains("Conventional Commit"));
        // Marker hygiene (fresh-eyes finding J): quoting/restating a marker
        // string would be scanned as the real signal.
        assert!(text.contains("Never quote, restate, or echo"));
    }

    #[test]
    fn test_corrective_instruction_is_single_line_with_failure_and_markers() {
        let text = handoff_corrective_instruction("#37", 4, "handoff file missing\nat some path");
        assert!(!text.contains('\n'), "corrective must not contain \\n");
        assert!(!text.contains('\r'), "corrective must not contain \\r");
        // The failure is stated, newline collapsed away.
        assert!(text.contains("handoff file missing at some path"));
        // The full ACK + written cycle is demanded again — with the
        // ROUND-SCOPED retry values, never round 1's (finding C).
        assert!(text.contains("<samurai-ack>handoff gen-4 retry</samurai-ack>"));
        assert!(text.contains("<samurai-handoff-written>gen-4 retry</samurai-handoff-written>"));
        assert!(!text.contains("<samurai-ack>handoff gen-4</samurai-ack>"));
        assert!(!text.contains("<samurai-handoff-written>gen-4</samurai-handoff-written>"));
        assert!(text.contains(".maestro/handoffs/37-gen4.md"));
        // Marker hygiene rides on the corrective too (finding J).
        assert!(text.contains("Never quote, restate, or echo"));
    }

    // --- issue #60: park + soft wind-down ---

    #[test]
    fn test_park_marker_values_are_kind_and_round_scoped() {
        // Kind-scoped: a replayed handoff marker for the same generation must
        // never satisfy a park (same tag, distinct value), and vice versa.
        assert_eq!(park_ack_value(3), "park gen-3");
        assert_eq!(park_written_value(3), "gen-3 park");
        assert_ne!(park_ack_value(3), handoff_ack_value(3));
        assert_ne!(park_written_value(3), handoff_written_value(3));
        // Round-scoped, same replay reasoning as the handoff retry values.
        assert_eq!(park_ack_retry_value(3), "park gen-3 retry");
        assert_eq!(park_written_retry_value(3), "gen-3 park retry");
        assert_ne!(park_ack_retry_value(3), park_ack_value(3));
        assert_ne!(park_written_retry_value(3), park_written_value(3));
        // And the park retry values never collide with the handoff ones.
        assert_ne!(park_written_retry_value(3), handoff_written_retry_value(3));
        assert_eq!(soft_winddown_ack_value(4), "winddown gen-4");
        assert_ne!(soft_winddown_ack_value(4), handoff_ack_value(4));
        assert_ne!(soft_winddown_ack_value(4), park_ack_value(4));
    }

    #[test]
    fn test_park_instruction_is_single_line_with_full_brief() {
        let text = park_instruction("#37", 2);
        assert!(!text.contains('\n'), "park must not contain \\n");
        assert!(!text.contains('\r'), "park must not contain \\r");
        // The exact markers the injector's scanners expect.
        assert!(text.contains("<samurai-ack>park gen-2</samurai-ack>"));
        assert!(text.contains("<samurai-handoff-written>gen-2 park</samurai-handoff-written>"));
        // The standard handoff relpath — the file doubles as park state.
        assert!(text.contains(".maestro/handoffs/37-gen2.md"));
        // Finish the atomic step only, commit ALL WIP, template headings.
        assert!(text.contains("atomic step ONLY"));
        assert!(text.contains("start NOTHING new"));
        assert!(text.contains("Commit ALL WIP"));
        assert!(text.contains("stage named paths only"));
        for heading in [
            "Goal",
            "Done",
            "In progress",
            "Decisions + why",
            "Failed attempts",
            "Repo state",
            "Verify",
            "Next steps",
        ] {
            assert!(text.contains(heading), "missing heading {heading}");
        }
        assert!(text.contains("HEAD SHA"));
        // Marker hygiene (finding J) rides on the park too.
        assert!(text.contains("Never quote, restate, or echo"));
    }

    #[test]
    fn test_park_corrective_is_single_line_with_retry_markers() {
        let text = park_corrective_instruction("#37", 4, "WIP is not\ncommitted");
        assert!(!text.contains('\n'));
        assert!(!text.contains('\r'));
        assert!(text.contains("Park INVALID"));
        assert!(text.contains("WIP is not committed"));
        assert!(text.contains("<samurai-ack>park gen-4 retry</samurai-ack>"));
        assert!(text.contains("<samurai-handoff-written>gen-4 park retry</samurai-handoff-written>"));
        assert!(!text.contains("<samurai-ack>park gen-4</samurai-ack>"));
        assert!(text.contains(".maestro/handoffs/37-gen4.md"));
        assert!(text.contains("final attempt"));
    }

    #[test]
    fn test_soft_winddown_instruction_shape() {
        let text = soft_winddown_instruction(3);
        assert!(!text.contains('\n'));
        assert!(!text.contains('\r'));
        assert!(text.contains("<samurai-ack>winddown gen-3</samurai-ack>"));
        // Wind down: no new subagents, wrap up, park may follow.
        assert!(text.contains("NO new subagents"));
        assert!(text.contains("CURRENT step only"));
        assert!(text.contains("park instruction"));
        // No file and no written marker are involved.
        assert!(text.contains("No file needs to be written"));
        assert!(!text.contains("<samurai-handoff-written>"));
        assert!(text.contains("Never quote, restate, or echo"));
    }

    // --- issue #55: successor ritual + HEAD-SHA extraction ---

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn test_head_sha_from_template_shaped_handoff() {
        let content = format!(
            "# Handoff — epic #37 — gen 2\n\
             ## Goal            #37 auth epic\n\
             ## Done            closed #40, #41\n\
             ## Repo state      branch feat/auth, HEAD SHA: {SHA}, no dirty files\n\
             ## Verify          cargo test --workspace\n\
             ## Next steps      1. issue #42\n"
        );
        assert_eq!(handoff_head_sha(&content), Some(SHA.to_string()));
    }

    #[test]
    fn test_head_sha_from_sloppy_variants() {
        // Bare SHA on its own line under a lowercase heading.
        let content = format!("## repo state\nbranch: main\n{SHA}\n## Verify\nnpm test\n");
        assert_eq!(handoff_head_sha(&content), Some(SHA.to_string()));

        // No markdown heading at all — a prose "Repo state:" line.
        let content = format!("Goal: ship it\nRepo state: main @ {SHA} (clean)\nVerify: npm test\n");
        assert_eq!(handoff_head_sha(&content), Some(SHA.to_string()));

        // Uppercase hex is a valid SHA spelling.
        let upper = SHA.to_ascii_uppercase();
        let content = format!("## Repo state\nHEAD {upper}\n");
        assert_eq!(handoff_head_sha(&content), Some(upper));

        // First 40-hex in the section wins when several appear.
        let other = "f".repeat(40);
        let content = format!("## Repo state\nHEAD {SHA} (previous {other})\n");
        assert_eq!(handoff_head_sha(&content), Some(SHA.to_string()));
    }

    #[test]
    fn test_head_sha_rejects_missing_or_malformed() {
        // No Repo state section at all.
        assert_eq!(handoff_head_sha(&format!("## Done\n{SHA}\n")), None);
        // SHA only in ANOTHER section: the parser is section-scoped.
        let content = format!("## Repo state\nbranch main, forgot the SHA\n## Verify\ngit reset --hard {SHA}\n");
        assert_eq!(handoff_head_sha(&content), None);
        // Too short / too long / embedded in a longer word.
        assert_eq!(handoff_head_sha(&format!("## Repo state\n{}\n", &SHA[..39])), None);
        assert_eq!(handoff_head_sha(&format!("## Repo state\n{SHA}0\n")), None);
        assert_eq!(handoff_head_sha(&format!("## Repo state\nx{SHA}\n")), None);
        assert_eq!(handoff_head_sha(&format!("## Repo state\n{SHA}g\n")), None);
        // Empty input.
        assert_eq!(handoff_head_sha(""), None);
    }

    #[test]
    fn test_successor_session_name_shape() {
        assert_eq!(successor_session_name("#37", 3), "samurai gen-3 37");
        assert_eq!(successor_session_name("Epic 12: Auth", 2), "samurai gen-2 epic-12-auth");
    }

    #[test]
    fn test_ritual_instruction_is_single_line_both_branches() {
        for head_matched in [true, false] {
            let text = successor_ritual_instruction("#37", 2, head_matched);
            assert!(!text.contains('\n'), "ritual must not contain \\n");
            assert!(!text.contains('\r'), "ritual must not contain \\r");
        }
        // A pathological epic ref cannot smuggle a newline into the paste.
        let text = successor_ritual_instruction("epic\nwith newline", 2, true);
        assert!(!text.contains('\n'));
        assert!(text.contains("epic with newline"));
    }

    #[test]
    fn test_ritual_instruction_head_match_branch_skips_verify() {
        let text = successor_ritual_instruction("#37", 2, true);
        // Identity: generation, epic, predecessor.
        assert!(text.contains("generation 3"));
        assert!(text.contains("epic #37"));
        assert!(text.contains("successor to generation 2"));
        // The predecessor's handoff file, via the same path function the
        // validator used.
        assert!(text.contains(".maestro/handoffs/37-gen2.md"));
        assert!(text.contains("IN FULL"));
        // The gate outcome: verify satisfied, skip it, continue.
        assert!(text.contains("already satisfied"));
        assert!(text.contains("SKIP"));
        assert!(text.contains("Next steps"));
        // And no verify-required language.
        assert!(!text.contains("MUST run"));
    }

    #[test]
    fn test_ritual_instruction_mismatch_branch_requires_verify() {
        let text = successor_ritual_instruction("#37", 2, false);
        assert!(text.contains("generation 3"));
        assert!(text.contains("successor to generation 2"));
        assert!(text.contains(".maestro/handoffs/37-gen2.md"));
        // Verify is mandatory and nothing unverified is trusted.
        assert!(text.contains("could NOT confirm"));
        assert!(text.contains("MUST run every command"));
        assert!(text.contains("trust NOTHING"));
        assert!(text.contains("Next steps"));
        // And no skip language.
        assert!(!text.contains("SKIP"));
    }

    // --- issue #56: recovery mode ---

    #[test]
    fn test_recovery_digest_relpath_shape() {
        assert_eq!(
            recovery_digest_relpath("#37", 3),
            ".maestro/handoffs/37-gen3-recovery.md"
        );
        assert_eq!(
            recovery_digest_relpath("Epic 12", 10),
            ".maestro/handoffs/epic-12-gen10-recovery.md"
        );
    }

    #[test]
    fn test_recovery_instruction_is_single_line() {
        for pin in [None, Some("owner/repo")] {
            let text = recovery_ritual_instruction("#37", 2, pin);
            assert!(!text.contains('\n'), "recovery must not contain \\n");
            assert!(!text.contains('\r'), "recovery must not contain \\r");
        }
        // A pathological epic ref cannot smuggle a newline into the paste.
        let text = recovery_ritual_instruction("epic\nwith newline", 2, None);
        assert!(!text.contains('\n'));
        assert!(text.contains("epic with newline"));
    }

    #[test]
    fn test_recovery_instruction_content() {
        let text = recovery_ritual_instruction("#37", 2, None);
        // Identity: what happened and who the successor is.
        assert!(text.contains("RECOVERY MODE"));
        assert!(text.contains("generation 3"));
        assert!(text.contains("epic #37"));
        assert!(text.contains("Generation 2 died without a valid handoff file"));
        // The three reconstruction sources.
        assert!(text.contains("`git log --oneline -20`"));
        assert!(text.contains("`gh` CLI"));
        assert!(text.contains("ALL of its comments"));
        assert!(text.contains(".maestro/handoffs/37-gen3-recovery.md"));
        // The digest is hints, not truth.
        assert!(text.contains("hints, NOT as truth"));
        // Verify before trusting anything, then announce and continue.
        assert!(text.contains("standard verification (build + tests) BEFORE trusting"));
        assert!(text.contains("comment on the epic's GitHub issue"));
        assert!(text.contains("continue the epic's remaining work"));
        // No normal-ritual language: there is no handoff to read.
        assert!(!text.contains("Read the handoff file"));
        assert!(!text.contains("SKIP"));
    }

    #[test]
    fn test_recovery_instruction_pins_the_repo_when_known() {
        // Fresh-eyes finding D (PRD §10): with the origin remote parsed, BOTH
        // the issue read and the takeover comment carry --repo explicitly.
        let text = recovery_ritual_instruction("#37", 2, Some("nachogl1/maestro"));
        assert_eq!(
            text.matches("--repo nachogl1/maestro").count(),
            2,
            "read AND comment must be pinned: {text}"
        );
        assert!(text.contains("passing `--repo nachogl1/maestro` explicitly"));
        assert!(text.contains("(again via `gh` with `--repo nachogl1/maestro`)"));
        // No caution when the pin is known.
        assert!(!text.contains("CAUTION"));
        // The rest of the ritual is unchanged.
        assert!(text.contains("RECOVERY MODE"));
        assert!(text.contains("hints, NOT as truth"));
    }

    #[test]
    fn test_recovery_instruction_without_pin_carries_a_caution() {
        let text = recovery_ritual_instruction("#37", 2, None);
        // No pinned `gh` usage (the caution itself mentions the missing pin).
        assert!(!text.contains("passing `--repo"));
        assert!(!text.contains("again via `gh`"));
        assert!(text.contains("CAUTION"));
        assert!(text.contains("double-check it targets the correct repository"));
    }
}
