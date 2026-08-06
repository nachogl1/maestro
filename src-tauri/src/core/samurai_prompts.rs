//! Samurai instruction text builders (Phase 2, issues #53/#54; PRD §5.3,
//! §5.4, §6).
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

/// The exact acknowledgement value generation `generation` must echo inside
/// `<samurai-ack>…</samurai-ack>`. The injector's ACK scanner expects this
/// same string — built here so instruction and scanner can never drift.
pub fn handoff_ack_value(generation: u32) -> String {
    format!("handoff gen-{generation}")
}

/// The exact value generation `generation` must echo inside
/// `<samurai-handoff-written>…</samurai-handoff-written>` once the handoff
/// file is written and WIP is committed. Same drift-proofing as
/// [`handoff_ack_value`].
pub fn handoff_written_value(generation: u32) -> String {
    format!("gen-{generation}")
}

/// Filesystem-safe slug of an epic ref for the handoff filename: `#37` →
/// `37`, `https://github.com/o/r/issues/9` → `https-github-com-o-r-issues-9`.
/// ASCII alphanumerics are kept (lowercased); every other run of characters
/// collapses to one `-`; a ref with nothing usable falls back to `epic`.
/// P2.4's successor reader must use this same function to find the file.
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
         <samurai-handoff-written>{written}</samurai-handoff-written>.",
        ack = handoff_ack_value(generation),
        relpath = handoff_file_relpath(epic, generation),
        written = handoff_written_value(generation),
    )
}

/// The single corrective re-instruction after handoff validation failed
/// (file missing / WIP uncommitted / written marker never arrived). States
/// what failed, restates both checks, and demands the same ACK + written
/// cycle. `failure` is whitespace-normalized so a multi-line description can
/// never smuggle a newline into the paste-able block.
pub fn handoff_corrective_instruction(epic: &str, generation: u32, failure: &str) -> String {
    let failure = failure.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "[Maestro Samurai] Handoff INVALID: {failure}. The gen-{generation} handoff is only \
         complete when BOTH checks pass: the handoff file exists at {relpath} (PRD section 6 \
         template), AND `git status --porcelain` reports no modified or staged tracked files \
         (untracked files are fine). \
         (1) Acknowledge IMMEDIATELY by replying with a message that contains exactly \
         <samurai-ack>{ack}</samurai-ack>. \
         (2) Fix the failure above: write the handoff file and/or commit WIP to the epic \
         branch (stage named paths only, Conventional Commit message). \
         (3) Then reply with a message that contains exactly \
         <samurai-handoff-written>{written}</samurai-handoff-written>. \
         This is the final attempt before a human is alerted.",
        relpath = handoff_file_relpath(epic, generation),
        ack = handoff_ack_value(generation),
        written = handoff_written_value(generation),
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
    }

    #[test]
    fn test_corrective_instruction_is_single_line_with_failure_and_markers() {
        let text = handoff_corrective_instruction("#37", 4, "handoff file missing\nat some path");
        assert!(!text.contains('\n'), "corrective must not contain \\n");
        assert!(!text.contains('\r'), "corrective must not contain \\r");
        // The failure is stated, newline collapsed away.
        assert!(text.contains("handoff file missing at some path"));
        // The full ACK + written cycle is demanded again, exact values.
        assert!(text.contains("<samurai-ack>handoff gen-4</samurai-ack>"));
        assert!(text.contains("<samurai-handoff-written>gen-4</samurai-handoff-written>"));
        assert!(text.contains(".maestro/handoffs/37-gen4.md"));
    }
}
