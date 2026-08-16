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
//!
//! Issue #91 adds the WORKFLOW section: every orchestrator brief (launch,
//! successor, recovery) embeds the run's compiled workflow — the numbered
//! step list `samurai_workflow::compile` produced from the graph the run
//! config snapshotted at launch — delimited so the model can tell process
//! from contract, composed after the ORDER clause (#93) and before the
//! COMPLETION clause (#96).

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

/// The wind-down all-clear instruction's ACK value (issue #120).
/// Kind-scoped (`allclear …`) so a transcript replay of the wind-down's own
/// ACK can never acknowledge its all-clear; ack-only like the wind-down.
pub fn winddown_allclear_ack_value(generation: u32) -> String {
    format!("allclear gen-{generation}")
}

/// The run-completion declaration tag (issue #96). The orchestrator replies
/// with `<samurai-run-complete>issues #a #b pr #n</samurai-run-complete>`
/// once the run's PR is OPEN with every issue CLOSED or linked for close by
/// it, or the PR was MERGED with every issue CLOSED (review F3 — the run's
/// own process closes issues via `Closes #N` on the HUMAN merge, so the
/// open-PR-with-links state is the normal declarable end); the scanner
/// (`samurai_completion`) verifies exactly those claims via `gh` before the
/// run config flips ACTIVE → COMPLETED. Built here so instruction and
/// scanner can never drift (the `handoff_ack_value` discipline).
pub const RUN_COMPLETE_TAG: &str = "samurai-run-complete";

/// The execution-order deviation alert tag (issue #93). When an orchestrator
/// disagrees with the user's issue order it replies with
/// `<samurai-order-alert>original: …; proposed: …; reasoning: …</samurai-order-alert>`
/// and WAITS in its terminal; the scanner (`samurai_completion`) turns the
/// tag into an `order_deviation` ALERT audit row — the same surfacing path
/// every samurai ALERT takes. Built here so instruction and scanner can
/// never drift (the `handoff_ack_value` discipline).
pub const ORDER_ALERT_TAG: &str = "samurai-order-alert";

/// The completion-declaration clause every orchestrator brief carries
/// (issue #96): gen-1 and every successor must be TOLD to declare completion
/// — nothing else ever finishes a run (the human's cleanup stays a separate
/// manual step, PRD §5.9). The declaration carries the issue numbers and PR
/// number the orchestrator claims, so Maestro's verification checks exactly
/// those claims instead of re-deriving the issue set from the epic ref
/// (which can be an epic issue OR a comma-separated list). Single line by
/// construction (see module doc).
fn completion_declaration_clause() -> String {
    format!(
        " COMPLETION: the run is finished when the run's pull request is OPEN and EVERY issue \
         this run works is either CLOSED on GitHub or linked for close by that PR (a \
         `Closes #N`/`Fixes #N` reference in its body — the human's merge then closes it), or \
         when the PR was already MERGED and every issue is CLOSED. At that moment declare \
         completion by replying with a message that contains exactly \
         <{tag}>issues #<a> #<b> pr #<n></{tag}> with the real numbers — list every issue \
         number this run worked, then the pull request number (for example: issues #77 #78 \
         pr #85, inside the tag). Maestro verifies each claimed issue and the PR against \
         GitHub via `gh` before the run is marked complete, so declare only when it is \
         actually true. Never quote, restate, or echo this marker string anywhere else in any \
         reply — emit it exactly once, only as the actual signal at that moment.",
        tag = RUN_COMPLETE_TAG
    )
}

/// The local-only scheduling prohibition (issue #121) every orchestrator
/// brief and every wait-inducing instruction (park, soft wind-down)
/// carries: all waiting and rescheduling is Maestro's job, handled by its
/// own LOCAL timers (`schedule.json`) — a cloud-scheduled agent or routine
/// (e.g. Claude Code's `/schedule`) would escape Maestro's supervision,
/// audit, and allowance accounting entirely. Single line by construction
/// (see module doc).
fn local_scheduling_clause() -> &'static str {
    " SCHEDULING: all waiting and rescheduling is MAESTRO'S job, handled by its own LOCAL \
     timers. NEVER create cloud-scheduled agents, routines, or jobs (e.g. Claude Code's \
     /schedule) to resume, retry, or \"come back later\" — a cloud reschedule escapes \
     Maestro's supervision, audit, and allowance accounting. When you must wait, stop and \
     wait in this terminal; Maestro resumes the work itself."
}

/// The delimited WORKFLOW section rider (issue #91): wraps the numbered
/// step list `samurai_workflow::compile` produced in explicit WORKFLOW /
/// END-OF-WORKFLOW markers so the process steps read as one block inside
/// the surrounding contract clauses. Empty compiled text (a graph edited
/// down to nothing) yields an empty section — the brief simply carries no
/// workflow, never an empty shell. The compiled text is
/// whitespace-normalized here too (defense in depth — `compile` already
/// collapses node text): a stray newline would submit a partial brief
/// (module doc).
fn workflow_section(compiled_workflow: &str) -> String {
    let compiled = compiled_workflow
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if compiled.is_empty() {
        return String::new();
    }
    format!(
        " WORKFLOW — the process for this run; follow these numbered steps in \
         this exact order: {compiled} — END OF WORKFLOW."
    )
}

/// The execution-order contract for the gen-1 launch brief (issue #93): the
/// order the user gave the issues in IS the execution order, worked strictly
/// sequentially; gen-1's FIRST step — before touching any code — is to
/// validate that order against the real dependencies it reads, and any
/// deviation needs the user's explicit confirmation, requested via the
/// [`ORDER_ALERT_TAG`] marker the `samurai_completion` watcher turns into an
/// ALERT audit row (the user answers in the terminal — no reply plumbing).
/// `is_list` keeps the #87 no-epic-framing contract. Single line by
/// construction (see module doc).
fn order_contract_clause(is_list: bool) -> String {
    let listed = if is_list {
        "the order in which the issues are listed above"
    } else {
        "the order in which the epic lists its child issues"
    };
    format!(
        " ORDER: {listed} is the EXECUTION ORDER — work the issues strictly \
         sequentially, one at a time, in exactly that order by default. Your FIRST step \
         after reading the issues, before touching ANY code, is to validate that order \
         against the real dependencies you find. If you agree with it, proceed in that \
         order without comment. If you believe a different order is required, STOP \
         before any code and raise an attention alert by replying with a message that \
         contains <{tag}>original: <the given order>; proposed: <your order>; \
         reasoning: <why></{tag}> with the real orders and reasoning, then WAIT for the \
         user's answer in this terminal and proceed only in the order the user confirms \
         — NEVER silently reorder. Never quote, restate, or echo this marker string \
         anywhere else in any reply — emit it at most once, only as the actual alert.",
        tag = ORDER_ALERT_TAG
    )
}

/// The execution-order reminder successor and recovery briefs carry (issue
/// #93): the order was fixed at launch (the user's listed order, plus any
/// deviation the user explicitly confirmed since) — successors must NOT
/// re-plan it; a new deviation goes through the same [`ORDER_ALERT_TAG`]
/// alert and the user's confirmation. Deliberately epic-free wording (the
/// #87 contract: a comma-separated list has no epic). Single line by
/// construction (see module doc).
fn order_contract_reminder() -> String {
    format!(
        " ORDER: the execution order for this run was fixed at launch — the order the \
         user originally listed the issues, plus any deviation the user has explicitly \
         confirmed since. Do NOT re-plan it: continue strictly sequentially in that \
         established order. If you believe a deviation is now required, STOP before \
         touching any code and raise an attention alert by replying with a message \
         that contains <{tag}>original: <the established order>; proposed: <your \
         order>; reasoning: <why></{tag}> with the real orders and reasoning, then \
         WAIT for the user's answer in this terminal and proceed only in the order the \
         user confirms — NEVER silently reorder. Never quote, restate, or echo this \
         marker string anywhere else in any reply — emit it at most once, only as the \
         actual alert.",
        tag = ORDER_ALERT_TAG
    )
}

/// The PR-issue-linking + PR-title reminder (issues #95 and #92; audited
/// across every brief that can open or update a pull request): a merged
/// Samurai PR only auto-closes the issues it resolves when its body says
/// so, and its scope stays hidden unless the title names every ref number
/// from the moment it is created — without either, merging leaves fixed
/// issues open and hides the run's real scope behind a free-form title.
/// `launch_instruction` states both rules as a hard step inline (its
/// gh_progress arm already covers PRs); successor and recovery briefs carry
/// them as a standing reminder here since whether either opens a NEW pull
/// request depends on the handoff's Next steps / the run's remaining work,
/// not on this instruction alone. `is_list` keeps the #87 no-epic-framing
/// contract: a comma-separated issue list has no epic number to list, so
/// the wording says "issue number", never "issue/epic number". Single line
/// by construction (see module doc).
fn pr_discipline_reminder(is_list: bool) -> String {
    let refs = if is_list { "issue" } else { "issue/epic" };
    format!(
        "If you open or update a pull request: its body must contain `Closes #N` (or \
         `Fixes #N`) for each issue it resolves, so GitHub auto-closes them on merge, and its \
         title must list every {refs} number this run covers, from the moment it is created \
         (e.g. `feat(samurai): #76 #77 #78 — summary`)."
    )
}

/// The GitHub work ONE run is scoped to (issue #83), split into the two
/// things that are NOT the same: parent EPICS — whose child issues the
/// orchestrator discovers from the epic itself — and standalone ISSUES named
/// directly. Both used to arrive through a single "epic" field, so a run over
/// `77, 78` was briefed as an epic with child issues that do not exist.
///
/// Every ref is normalised to its bare form (`5`, `#5`, ` #5 ` → `5`) and
/// whitespace-collapsed, so no ref can smuggle a newline into a paste-able
/// instruction (module doc); empty refs are dropped.
///
/// [`RunRefs::label`] is the run's IDENTITY string (`epic #5 · issues #7, #9`)
/// — [`epic_slug`] turns it into the combined run slug (`epic-5-issues-7-9`)
/// that branch, worktree and handoff filenames are built from, so identity
/// keeps flowing through the one function it always did.
/// [`RunRefs::prose`] is the same set spelled for prompt text
/// (`GitHub epic #5 and issues #7, #9`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunRefs {
    epics: Vec<String>,
    issues: Vec<String>,
}

impl RunRefs {
    /// From the launcher's two fields (or a run config's two lists).
    pub fn new(
        epics: impl IntoIterator<Item = impl AsRef<str>>,
        issues: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Self {
        Self {
            epics: normalize_refs(epics),
            issues: normalize_refs(issues),
        }
    }

    /// Every ref is an epic, from ONE comma-separated string — the pre-#83
    /// launcher wire. The launch path now sends the two fields separately
    /// (`commands::samurai::run_refs`), so this survives as the shorthand the
    /// prompt suites build their epic-only fixtures with.
    #[cfg(test)]
    pub fn epics_only(epics: &str) -> Self {
        Self::new(epics.split(','), std::iter::empty::<&str>())
    }

    /// The epic refs, bare (`5`), in the order they were given.
    pub fn epics(&self) -> &[String] {
        &self.epics
    }

    /// The standalone issue refs, bare (`7`), in the order they were given.
    pub fn issues(&self) -> &[String] {
        &self.issues
    }

    /// No usable ref on either side — the launch command refuses this before
    /// any prompt is built.
    pub fn is_empty(&self) -> bool {
        self.epics.is_empty() && self.issues.is_empty()
    }

    /// The run's identity/display string: `epic #5 · issues #7, #9`,
    /// `issues #7, #9`, `epic #5`, `epics #5, #12`. Empty when there is
    /// nothing to name — [`epic_slug`] then falls back to `epic`, so the
    /// slug is never empty. The launch path stores this as the run's `epic`
    /// identity field ([`SamuraiRunConfig::epic`](super::samurai_run_config::SamuraiRunConfig::epic)).
    pub fn label(&self) -> String {
        let epics = self.epic_phrase();
        let issues = self.issue_phrase();
        match (epics.is_empty(), issues.is_empty()) {
            (false, false) => format!("{epics} · {issues}"),
            (false, true) => epics,
            (true, false) => issues,
            (true, true) => String::new(),
        }
    }

    /// The same set spelled for prompt prose: `GitHub epic #5`,
    /// `GitHub issues #7, #9`, `GitHub epic #5 and issues #7, #9`.
    pub fn prose(&self) -> String {
        match (self.epics.is_empty(), self.issues.is_empty()) {
            (false, false) => format!("GitHub {} and {}", self.epic_phrase(), self.issue_phrase()),
            (false, true) => format!("GitHub {}", self.epic_phrase()),
            (true, false) => format!("GitHub {}", self.issue_phrase()),
            // Unreachable by construction (the launch command refuses an
            // empty ref); mirrors epic_slug's `epic` fallback rather than
            // emitting a dangling "for .".
            (true, true) => "GitHub epic".to_string(),
        }
    }

    /// `epic #5` / `epics #5, #12` / empty.
    fn epic_phrase(&self) -> String {
        if self.epics.is_empty() {
            return String::new();
        }
        let noun = if self.epics.len() == 1 {
            "epic"
        } else {
            "epics"
        };
        format!("{noun} {}", join_refs(&self.epics))
    }

    /// `issue #7` / `issues #7, #9` / empty.
    fn issue_phrase(&self) -> String {
        if self.issues.is_empty() {
            return String::new();
        }
        let noun = if self.issues.len() == 1 {
            "issue"
        } else {
            "issues"
        };
        format!("{noun} {}", join_refs(&self.issues))
    }
}

/// Normalises every ref and drops the ones that carry nothing.
fn normalize_refs(refs: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<String> {
    refs.into_iter()
        .filter_map(|r| normalize_ref(r.as_ref()))
        .collect()
}

/// One ref, whitespace-collapsed and stripped of its leading `#`: `#5`, `5`
/// and ` #5 ` all become `5`. `None` when nothing usable is left.
fn normalize_ref(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let bare = collapsed.trim_start_matches('#').trim();
    if bare.is_empty() {
        None
    } else {
        Some(bare.to_string())
    }
}

/// Display spelling of one bare ref: a number gets its `#` back (`5` → `#5`);
/// anything else is left exactly as typed.
fn display_ref(r: &str) -> String {
    if r.bytes().all(|b| b.is_ascii_digit()) {
        format!("#{r}")
    } else {
        r.to_string()
    }
}

/// `#7, #9` — the display spelling of a ref list.
fn join_refs(refs: &[String]) -> String {
    refs.iter()
        .map(|r| display_ref(r))
        .collect::<Vec<_>>()
        .join(", ")
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
    ref_slug(epic, "epic")
}

/// Shared collapsing sanitizer behind [`epic_slug`] and the project-name half
/// of the Samurai launch branch (`commands::samurai::epic_branch`): ASCII
/// alphanumerics are kept (lowercased); every other run of characters
/// collapses to one `-`; an input with nothing usable falls back to
/// `fallback` so callers never produce an empty slug segment.
pub(crate) fn ref_slug(input: &str, fallback: &str) -> String {
    let mut slug = String::new();
    let mut pending_dash = false;
    for c in input.chars() {
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
        fallback.to_string()
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
/// generation on disk. Issue #119 (tolerant discovery): the dash spelling a
/// deviating orchestrator actually produced, `<slug>-gen-<N>.md`, parses
/// too. Anything else returns `None` — including the `-recovery` digests
/// ([`recovery_digest_relpath`]), whose tail after `-gen<N>` is not all
/// digits. `rsplit_once` takes the LAST `-gen`, so an epic slug that itself
/// contains `-gen` (e.g. `x-gen5-gen2.md`) still parses the real generation.
pub fn parse_handoff_generation(filename: &str) -> Option<u32> {
    let stem = filename.strip_suffix(".md")?;
    let (_, tail) = stem.rsplit_once("-gen")?;
    let digits = tail.strip_prefix('-').unwrap_or(tail);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
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
         (4) Commit WIP to this run's branch: stage named paths only (never `git add .` or \
         `git add -A`), one Conventional Commit message (`type(scope): summary`). \
         (5) Write the handoff file to {relpath} — EXACTLY this repo-relative path inside this \
         worktree, creating directories as needed; NEVER invent another filename or location \
         (never a HANDOFF-*.md at the repo root) — following the PRD section 6 template EXACTLY, \
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
         (2) Fix the failure above: write the handoff file and/or commit WIP to this run's \
         branch (stage named paths only, Conventional Commit message). If you wrote the \
         handoff under any other filename or directory (e.g. a HANDOFF-*.md at the repo \
         root), MOVE it to exactly {relpath}. \
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
         signal.{scheduling}",
        scheduling = local_scheduling_clause(),
        ack = soft_winddown_ack_value(generation),
    )
}

/// The wind-down all-clear instruction (issue #120): the allowance
/// recovered — the governing window reset or usage fell back below the soft
/// threshold — so a session that received a soft wind-down and was never
/// parked may resume full-throughput work. Ack-only, like the wind-down: no
/// state transition, no file, no written marker. Single line by
/// construction (see module doc).
pub fn winddown_allclear_instruction(generation: u32) -> String {
    format!(
        "[Maestro Samurai] Allowance all-clear: the token allowance has recovered, so the \
         earlier wind-down no longer applies. Do the following: \
         (1) Acknowledge IMMEDIATELY, before anything else, by replying with a message that \
         contains exactly <samurai-ack>{ack}</samurai-ack>. \
         (2) Resume normal operation: you may spawn subagents again and work at your normal \
         pace and parallelism. \
         No file needs to be written for this instruction. Never quote, restate, or echo the \
         marker string anywhere else in any reply — emit it exactly once, only as the actual \
         signal.",
        ack = winddown_allclear_ack_value(generation),
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
         (4) Commit ALL WIP to this run's branch: stage named paths only (never `git add .` or \
         `git add -A`), one Conventional Commit message (`type(scope): summary`). \
         (5) Write or update the handoff file at {relpath} — EXACTLY this repo-relative path \
         inside this worktree, creating directories as needed; NEVER invent another filename \
         or location (never a HANDOFF-*.md at the repo root) — following the PRD section 6 \
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
         quoted marker is read as the real signal.{scheduling}",
        scheduling = local_scheduling_clause(),
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
         this run's branch (stage named paths only, Conventional Commit message). If you \
         wrote the handoff under any other filename or directory (e.g. a HANDOFF-*.md at \
         the repo root), MOVE it to exactly {relpath}. \
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

/// True when `epic` holds a comma-separated ISSUE LIST rather than a single
/// epic reference (issue #87). `normalize_epic_ref` in `commands/samurai.rs`
/// is the producer: `"77, 78"` for a list (issues joined with `, `), `"#37"`
/// / `"Epic 12: Auth"` for one ref — a plain ref never contains a comma.
/// Every builder that phrases wording around "the epic" must branch on this
/// FIRST: a list has no epic issue to reference or child issues to hunt
/// for, so epic/child-issue framing sent an orchestrator hunting for a
/// phantom epic issue (harvest finding from run #76–#84).
fn is_issue_list(epic_text: &str) -> bool {
    epic_text.contains(',')
}

/// The successor's first instruction (PRD §5.6 — one recovery path): read
/// the predecessor's handoff in full, then either skip or run its Verify
/// commands depending on the HEAD gate MAESTRO computed. Single line by
/// construction (see module doc); the run ref is whitespace-normalized so
/// a pathological ref can never smuggle a newline into the paste.
///
/// `compiled_workflow` (issue #91) is the run's numbered workflow — the
/// caller recompiles it from the graph the run config snapshotted at
/// launch (`samurai_workflow::compiled_for_run`), so the workflow survives
/// handoffs unchanged.
///
/// `epic` is the run's IDENTITY string — [`RunRefs::label`] from issue #83
/// onward, so it already spells what the run is (`epic #5`, `issues #7, #9`)
/// and is never prefixed with the word "epic" here.
pub fn successor_ritual_instruction(
    epic: &str,
    predecessor_generation: u32,
    head_matched: bool,
    compiled_workflow: &str,
) -> String {
    let epic_text = epic.split_whitespace().collect::<Vec<_>>().join(" ");
    let generation = predecessor_generation + 1;
    let relpath = handoff_file_relpath(epic, predecessor_generation);
    // Issue #87: a comma-separated issue list must not get epic framing in
    // the reminders. The identity string itself is self-describing from
    // issue #83 onward (`RunRefs::label`), so the opening uses it verbatim.
    let is_list = is_issue_list(&epic_text);
    let opening = format!(
        "[Maestro Samurai] You are generation {generation} for {epic_text}, successor to \
         generation {predecessor_generation}. Read the handoff file at {relpath} IN FULL before \
         doing anything else — it and GitHub are your only sources of truth."
    );
    let order = order_contract_reminder();
    let workflow = workflow_section(compiled_workflow);
    let clause = completion_declaration_clause();
    let scheduling = local_scheduling_clause();
    let pr_reminder = pr_discipline_reminder(is_list);
    if head_matched {
        format!(
            "{opening} Maestro verified that this repository's current HEAD equals the SHA \
             recorded in the handoff's \"Repo state\" section, so the verify step is already \
             satisfied: SKIP the commands in the handoff's Verify section and continue directly \
             with its Next steps.{order}{workflow}{clause}{scheduling} {pr_reminder}"
        )
    } else {
        format!(
            "{opening} Maestro could NOT confirm that this repository's current HEAD matches the \
             SHA recorded in the handoff's \"Repo state\" section. You MUST run every command in \
             the handoff's Verify section FIRST, and trust NOTHING the handoff claims that those \
             commands do not confirm — investigate and fix any failure before moving on. Only \
             then continue with the handoff's Next steps.{order}{workflow}{clause}{scheduling} \
             {pr_reminder}"
        )
    }
}

/// The gen-1 opening brief (issue #63, PRD §5.8 + §12): what the FIRST
/// generation of a freshly launched run receives on its first
/// `SessionStarted` — there is no handoff and no predecessor, so neither
/// ritual applies. The orchestrator reads its work from GitHub, plans, works
/// the issues via small idempotent subagent tasks with per-step commits
/// (PRD §10: tree-kill containment), comments progress, and opens PRs.
/// Single line by construction (see module doc); every ref is
/// whitespace-normalized by [`RunRefs`] so a pathological ref can never
/// smuggle a newline into the paste.
///
/// Issue #83: a run is scoped to EPICS, to standalone ISSUES, or to both, and
/// the brief says which — telling an orchestrator that `77, 78` is an epic
/// sent it hunting for a parent issue that does not exist. Three shapes:
/// epics only (today's wording, unchanged), issues only (each issue read and
/// commented on directly, no epic and no child issues anywhere), and both
/// (the epic with its children PLUS the named standalone issues, progress
/// commented on the epic).
///
/// `repo_pin` is the `owner/repo` derived from the run worktree's `origin`
/// remote — PRD §10: gen-1 runs with `--dangerously-skip-permissions`, so
/// every `gh` command must carry `--repo` explicitly. `None` (remote missing
/// or unparseable — never blocks the launch) keeps the unpinned wording plus
/// the same explicit caution sentence as [`recovery_ritual_instruction`].
///
/// `compiled_workflow` (issue #91) is the run's numbered workflow, compiled
/// by the caller from the graph the launch is snapshotting into the run
/// config (`samurai_workflow::compile`).
pub fn launch_instruction(refs: &RunRefs, repo_pin: Option<&str>, compiled_workflow: &str) -> String {
    let has_epics = !refs.epics().is_empty();
    let has_issues = !refs.issues().is_empty();
    let many_epics = refs.epics().len() > 1;
    let many_issues = refs.issues().len() > 1;
    // Issue #87: a run with no parent epic must never get epic framing —
    // the ORDER clause and the PR-title rule below say "issue", not
    // "issue/epic", when the run is a plain issue list.
    let is_list = !has_epics;

    // What to read, WITHOUT the trailing `gh` clause (which is the same
    // sentence tail in every shape).
    let epic_read = if many_epics {
        "read the epics' GitHub issues, ALL of their comments, and EVERY child issue they \
         reference"
    } else {
        "read the epic's GitHub issue, ALL of its comments, and EVERY child issue it references"
    };
    let read_subject = match (has_epics, has_issues) {
        (true, true) if many_issues => format!(
            "{epic_read}, plus the standalone issues {} and ALL of their comments",
            join_refs(refs.issues())
        ),
        (true, true) => format!(
            "{epic_read}, plus the standalone issue {} and ALL of its comments",
            join_refs(refs.issues())
        ),
        (false, true) if many_issues => {
            "read EACH of this run's GitHub issues and ALL of their comments".to_string()
        }
        (false, true) => "read this run's GitHub issue and ALL of its comments".to_string(),
        // Epics only — and the (refused-upstream) empty run.
        _ => epic_read.to_string(),
    };
    // Progress comments land on the epic whenever there is one (issue #83:
    // "comment progress on the epic"); an issues-only run has no epic to
    // gather them on, so each issue carries its own. Review F6: the run
    // ships ONE batch PR (the workflow's "Open or finalize the run's pull
    // request" step and the COMPLETION clause both assume it), so this step
    // speaks of the singular run PR — never "open pull requests" per issue.
    let progress_subject = match (has_epics, has_issues) {
        (false, true) if many_issues => {
            "comment progress on EACH of those GitHub issues as they complete, and open the \
             run's pull request for finished work and keep it updated"
        }
        (false, true) => {
            "comment progress on that GitHub issue as work completes, and open the run's pull \
             request for finished work and keep it updated"
        }
        _ if many_epics => {
            "comment progress on the epics' GitHub issues as issues complete, and open the \
             run's pull request for finished work and keep it updated"
        }
        _ => {
            "comment progress on the epic's GitHub issue as issues complete, and open the \
             run's pull request for finished work and keep it updated"
        }
    };
    // Same reasoning for where a NOT-ready issue gets reported.
    let unready_note = match (has_epics, has_issues) {
        (false, true) => "say so in that issue's progress comment",
        _ if many_epics => "say so in your progress comment on the epics",
        _ => "say so in your progress comment on the epic",
    };
    // One epic and nothing else keeps the pre-#83 sentence verbatim; every
    // other shape covers work the word "epic" does not describe.
    let worktree_sentence = if has_epics && !has_issues && !many_epics {
        "This directory is the epic's dedicated worktree on its own branch."
    } else {
        "This directory is this run's dedicated worktree on its own branch."
    };

    let (gh_clause, progress_pin, caution) = match repo_pin {
        Some(pin) => (
            format!(" with the `gh` CLI, passing `--repo {pin}` explicitly on every `gh` command"),
            format!(" (again via `gh` with `--repo {pin}` on every command)"),
            String::new(),
        ),
        None => (
            " with the `gh` CLI, run from this directory".to_string(),
            String::new(),
            " CAUTION: Maestro could not determine this repository's origin remote, so no \
             `--repo` pin is available — before running any `gh` command, double-check it \
             targets the correct repository."
                .to_string(),
        ),
    };
    // Issue #95: merging a Samurai PR closes nothing unless its body links
    // the issues it resolves. Issue #92: the title must enumerate every ref
    // number the run covers from the moment the PR is created. `refs_word`
    // mirrors pr_discipline_reminder's #87 no-epic-framing contract: a list
    // has no epic number to list.
    let refs_word = if is_list { "issue" } else { "issue/epic" };
    let pr_discipline = format!(
        "every PR body must contain `Closes #N` (or `Fixes #N`) for each issue it resolves so \
         GitHub auto-closes them on merge, and every PR title must list every {refs_word} number \
         this run covers, from the moment it is created (e.g. `feat(samurai): #76 #77 #78 — \
         summary`)"
    );
    let gh_read = format!("{read_subject}{gh_clause}");
    let gh_progress = format!("{progress_subject} — {pr_discipline}{progress_pin}");
    let order = order_contract_clause(is_list);
    let workflow = workflow_section(compiled_workflow);
    let clause = completion_declaration_clause();
    format!(
        "[Maestro Samurai] You are generation 1, the FIRST orchestrator, for {subject}. \
         {worktree_sentence} \
         Do the following: \
         (1) {gh_read}. \
         (2) Assess whether each issue is AGENT-READY — scope clear enough to implement, \
         acceptance criteria stated, no open product or design decision that needs a human, \
         and every command named in its acceptance criteria exists and is RUNNABLE in this \
         repo. VERIFY runnability before treating an issue as agent-ready — check the \
         repo instead of assuming (e.g. the script is listed in package.json's scripts \
         table, the tool answers a `--version`/`--help` probe, the build target exists); \
         an issue whose acceptance criteria name a command that is missing is NOT \
         agent-ready. \
         Work only the ready ones. For each issue that is NOT ready, comment on it saying \
         exactly what is missing (for a missing command, name exactly which command), \
         exclude it from this run, and {unready_note} instead of guessing at the intent. \
         (3) Plan the work across the agent-ready issues before touching code. \
         (4) Work them via SMALL idempotent subagent tasks, each committing its \
         completed step to THIS branch (stage named paths only, never `git add .` or \
         `git add -A`; Conventional Commit messages `type(scope): summary`). \
         (5) {gh_progress}. \
         (6) NEVER switch to, commit to, or push any other branch, and NEVER touch any \
         repository other than this one.{caution}{order}{workflow}{clause}{scheduling}",
        subject = refs.prose(),
        scheduling = local_scheduling_clause(),
    )
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
/// sources in priority order: git history, this run's GitHub issue(s), and
/// the pre-digested transcript summary (hints, not truth) — then the
/// project's standard verification BEFORE trusting anything. Single line by
/// construction (see module doc); the run ref is whitespace-normalized so a
/// pathological ref can never smuggle a newline into the paste.
///
/// `epic` is the run's IDENTITY string ([`RunRefs::label`] from issue #83
/// onward), so nothing here prefixes it with the word "epic".
///
/// `repo_pin` is the `owner/repo` derived from the working dir's `origin`
/// remote. PRD §10: successors run with `--dangerously-skip-permissions`, so
/// `--repo` must be pinned in every orchestrator prompt — `Some` pins BOTH
/// the issue read and the takeover comment; `None` (remote missing or
/// unparseable — never blocks recovery) keeps the unpinned wording plus an
/// explicit caution sentence.
///
/// `compiled_workflow` (issue #91) is the run's numbered workflow — see
/// [`successor_ritual_instruction`].
pub fn recovery_ritual_instruction(
    epic: &str,
    predecessor_generation: u32,
    repo_pin: Option<&str>,
    compiled_workflow: &str,
) -> String {
    let epic_text = epic.split_whitespace().collect::<Vec<_>>().join(" ");
    // Issue #87: a comma-separated issue list must not get epic framing in
    // the PR-discipline reminder (the run wording itself is neutral —
    // "this run's GitHub issue(s)" — from issue #83 onward).
    let is_list = is_issue_list(&epic_text);
    let generation = predecessor_generation + 1;
    let digest_relpath = recovery_digest_relpath(epic, generation);
    let (gh_read, gh_comment, caution) = match repo_pin {
        Some(pin) => (
            format!(
                "read this run's GitHub issue(s) and ALL of their comments with the `gh` CLI, \
                 passing `--repo {pin}` explicitly on every `gh` command"
            ),
            format!("comment on this run's GitHub issue(s) (again via `gh` with `--repo {pin}`)"),
            String::new(),
        ),
        None => (
            "read this run's GitHub issue(s) and ALL of their comments with the `gh` CLI, run \
             from this directory"
                .to_string(),
            "comment on this run's GitHub issue(s)".to_string(),
            " CAUTION: Maestro could not determine this repository's origin remote, so no \
             `--repo` pin is available — before running any `gh` command, double-check it \
             targets the correct repository."
                .to_string(),
        ),
    };
    let order = order_contract_reminder();
    let workflow = workflow_section(compiled_workflow);
    let clause = completion_declaration_clause();
    let scheduling = local_scheduling_clause();
    let pr_reminder = pr_discipline_reminder(is_list);
    format!(
        "[Maestro Samurai] RECOVERY MODE: you are generation {generation} for {epic_text}. \
         Generation {predecessor_generation} died without a valid handoff file, so there is \
         nothing to hand off to you. Reconstruct the state of the work from three sources: \
         (1) run `git log --oneline -20` in this repository; \
         (2) {gh_read}; \
         (3) read the pre-digested transcript summary Maestro extracted to {digest_relpath} — \
         treat it as hints, NOT as truth. \
         Then run the project's standard verification (build + tests) BEFORE trusting or \
         continuing anything — investigate and fix any failure first. Once verification passes, \
         {gh_comment} that generation {generation} has taken over in \
         recovery mode, then continue this run's remaining \
         work.{caution}{order}{workflow}{clause}{scheduling} \
         {pr_reminder}"
    )
}

/// The journaling rider (issue #72; PRD §5.12 — friction "recorded by
/// agents (instructed in orchestrator prompts)"): appended by callers to
/// every Samurai agent brief (gen-1 launch, successor ritual) so agents
/// record bottlenecks/errors/improvement ideas in the ops journal.
/// `journal_file` is the ACTIVE journal's absolute path, resolved by the
/// caller (`samurai_journal::default_journal_file` — this module stays pure
/// text). The five SCREAMING category spellings are the
/// `samurai_journal::JournalCategory` wire contract. Single line by
/// construction (see module doc); the path is whitespace-normalized so a
/// pathological value can never smuggle a newline into the paste.
pub fn journal_instruction(journal_file: &str) -> String {
    let journal_file = journal_file
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "[Maestro Samurai] Journaling: when you hit friction — a bottleneck, an error, a \
         tooling gap, a process improvement idea, or a concern — append ONE line to \
         {journal_file} in the form {{\"ts\":\"<ISO 8601>\",\"category\":\"BOTTLENECK\"|\"ERROR\"|\"IMPROVEMENT\"|\"SKILL\"|\"CONCERN\",\"text\":\"<short description>\",\"project\":\"<repo path>\",\"agent\":\"<your epic/generation id>\"}}, \
         e.g. via `echo '<json>' >> \"{journal_file}\"`. Malformed lines are skipped by the \
         reader, so a bad line cannot break the journal — but NEVER rewrite or delete \
         existing lines: the journal is append-only."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_workflow;

    /// The DEFAULT compiled workflow (issue #91) — what production callers
    /// pass when the run config carries no custom graph.
    fn wf() -> String {
        samurai_workflow::compile(&samurai_workflow::WorkflowGraph::default())
    }

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
        assert_eq!(
            parse_handoff_generation("37-gen99999999999999999999.md"),
            None
        );
    }

    // --- issue #120: wind-down all-clear ---

    #[test]
    fn test_winddown_allclear_is_ack_only_with_kind_scoped_marker() {
        // Kind-scoped: no other instruction's ACK (nor a replay of the
        // wind-down's own) may satisfy the all-clear.
        assert_eq!(winddown_allclear_ack_value(4), "allclear gen-4");
        assert_ne!(winddown_allclear_ack_value(4), soft_winddown_ack_value(4));
        assert_ne!(winddown_allclear_ack_value(4), handoff_ack_value(4));
        assert_ne!(winddown_allclear_ack_value(4), park_ack_value(4));

        let text = winddown_allclear_instruction(4);
        assert!(!text.contains('\n'), "all-clear must be single-line");
        assert!(text.contains("<samurai-ack>allclear gen-4</samurai-ack>"));
        // Ack-only: it lifts the wind-down (subagents allowed again) and
        // demands no file and no written marker.
        assert!(text.contains("spawn subagents again"));
        assert!(text.contains("No file needs to be written"));
        assert!(!text.contains("<samurai-handoff-written>"));
        assert!(text.contains("Never quote, restate, or echo"));
    }

    // --- issue #121: local-only scheduling prohibition (drift guard) ---

    #[test]
    fn test_every_orchestrator_brief_forbids_cloud_scheduling() {
        // All rescheduling is LOCAL — Maestro's own timers. A cloud-scheduled
        // agent/routine (e.g. Claude Code's /schedule) escapes supervision,
        // audit, and allowance accounting entirely, so every brief that could
        // tempt an agent to "come back later" carries the prohibition.
        let texts = [
            launch_instruction(&RunRefs::epics_only("#37"), Some("o/r"), &wf()),
            successor_ritual_instruction("#37", 2, true, &wf()),
            successor_ritual_instruction("#37", 2, false, &wf()),
            recovery_ritual_instruction("#37", 2, Some("o/r"), &wf()),
            park_instruction("#37", 2),
            soft_winddown_instruction(2),
        ];
        for text in texts {
            assert!(
                text.contains("NEVER create cloud-scheduled agents"),
                "missing cloud-scheduling prohibition: {text}"
            );
            assert!(
                text.contains("/schedule"),
                "prohibition must name the /schedule escape hatch: {text}"
            );
            assert!(
                text.contains("waiting and rescheduling is MAESTRO'S job"),
                "prohibition must say waiting is Maestro's job: {text}"
            );
            assert!(!text.contains('\n'), "brief must stay single-line");
        }
    }

    // --- issue #119: exactly ONE canonical handoff path ---

    #[test]
    fn test_file_writing_instructions_forbid_inventing_another_handoff_path() {
        // A live gen-1 wrote `HANDOFF-…-gen-1.md` at the worktree ROOT —
        // invisible to the Second Brain files panel and unparseable on
        // resume. Both file-writing instructions must pin the canonical
        // path and forbid any other name or location outright.
        for text in [handoff_instruction("#37", 2), park_instruction("#37", 2)] {
            assert!(text.contains(".maestro/handoffs/37-gen2.md"));
            assert!(
                text.contains("EXACTLY this repo-relative path"),
                "missing exact-path pin: {text}"
            );
            assert!(
                text.contains("never a HANDOFF-*.md at the repo root"),
                "missing root-convention prohibition: {text}"
            );
        }
    }

    #[test]
    fn test_correctives_direct_a_move_to_the_exact_expected_path() {
        // The validator is the enforcement point (#119): when the file is
        // missing, the corrective must CORRECT a deviating agent — name the
        // exact expected path and tell it to move a misplaced handoff there
        // — not just restate the checks.
        for text in [
            handoff_corrective_instruction("#37", 4, "the handoff file is missing"),
            park_corrective_instruction("#37", 4, "the handoff file is missing"),
        ] {
            assert!(text.contains(".maestro/handoffs/37-gen4.md"));
            assert!(
                text.contains("MOVE it to exactly .maestro/handoffs/37-gen4.md"),
                "missing move-to-canonical-path correction: {text}"
            );
        }
    }

    #[test]
    fn test_parse_handoff_generation_tolerates_a_gen_dash_variant() {
        // #119 tolerant discovery: the observed deviation spelled the
        // generation `-gen-1`, not `-gen1`.
        assert_eq!(parse_handoff_generation("37-gen-1.md"), Some(1));
        assert_eq!(parse_handoff_generation("37-gen-42.md"), Some(42));
        // Garbled variants still parse as nothing.
        assert_eq!(parse_handoff_generation("37-gen-.md"), None);
        assert_eq!(parse_handoff_generation("37-gen-2x.md"), None);
        // Recovery digests stay excluded in the dash spelling too.
        assert_eq!(parse_handoff_generation("37-gen-3-recovery.md"), None);
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
        assert!(
            text.contains("<samurai-handoff-written>gen-4 park retry</samurai-handoff-written>")
        );
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
        let content =
            format!("Goal: ship it\nRepo state: main @ {SHA} (clean)\nVerify: npm test\n");
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
        let content = format!(
            "## Repo state\nbranch main, forgot the SHA\n## Verify\ngit reset --hard {SHA}\n"
        );
        assert_eq!(handoff_head_sha(&content), None);
        // Too short / too long / embedded in a longer word.
        assert_eq!(
            handoff_head_sha(&format!("## Repo state\n{}\n", &SHA[..39])),
            None
        );
        assert_eq!(handoff_head_sha(&format!("## Repo state\n{SHA}0\n")), None);
        assert_eq!(handoff_head_sha(&format!("## Repo state\nx{SHA}\n")), None);
        assert_eq!(handoff_head_sha(&format!("## Repo state\n{SHA}g\n")), None);
        // Empty input.
        assert_eq!(handoff_head_sha(""), None);
    }

    #[test]
    fn test_successor_session_name_shape() {
        assert_eq!(successor_session_name("#37", 3), "samurai gen-3 37");
        assert_eq!(
            successor_session_name("Epic 12: Auth", 2),
            "samurai gen-2 epic-12-auth"
        );
    }

    #[test]
    fn test_ritual_instruction_is_single_line_both_branches() {
        for head_matched in [true, false] {
            let text = successor_ritual_instruction("#37", 2, head_matched, &wf());
            assert!(!text.contains('\n'), "ritual must not contain \\n");
            assert!(!text.contains('\r'), "ritual must not contain \\r");
        }
        // A pathological epic ref cannot smuggle a newline into the paste.
        let text = successor_ritual_instruction("epic\nwith newline", 2, true, &wf());
        assert!(!text.contains('\n'));
        assert!(text.contains("epic with newline"));
    }

    #[test]
    fn test_ritual_instruction_head_match_branch_skips_verify() {
        let text = successor_ritual_instruction("#37", 2, true, &wf());
        // Identity: generation, the run's own ref, predecessor. Issue #83:
        // the ref is NOT prefixed with "epic" here — the identity string
        // (RunRefs::label) already says what the run is.
        assert!(text.contains("generation 3"));
        assert!(text.contains("generation 3 for #37"));
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
        let text = successor_ritual_instruction("#37", 2, false, &wf());
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
            let text = recovery_ritual_instruction("#37", 2, pin, &wf());
            assert!(!text.contains('\n'), "recovery must not contain \\n");
            assert!(!text.contains('\r'), "recovery must not contain \\r");
        }
        // A pathological epic ref cannot smuggle a newline into the paste.
        let text = recovery_ritual_instruction("epic\nwith newline", 2, None, &wf());
        assert!(!text.contains('\n'));
        assert!(text.contains("epic with newline"));
    }

    #[test]
    fn test_recovery_instruction_content() {
        let text = recovery_ritual_instruction("#37", 2, None, &wf());
        // Identity: what happened and who the successor is.
        assert!(text.contains("RECOVERY MODE"));
        assert!(text.contains("generation 3"));
        assert!(text.contains("generation 3 for #37"));
        assert!(text.contains("Generation 2 died without a valid handoff file"));
        // The three reconstruction sources.
        assert!(text.contains("`git log --oneline -20`"));
        assert!(text.contains("`gh` CLI"));
        assert!(text.contains("ALL of their comments"));
        assert!(text.contains(".maestro/handoffs/37-gen3-recovery.md"));
        // The digest is hints, not truth.
        assert!(text.contains("hints, NOT as truth"));
        // Verify before trusting anything, then announce and continue.
        assert!(text.contains("standard verification (build + tests) BEFORE trusting"));
        assert!(text.contains("comment on this run's GitHub issue(s)"));
        assert!(text.contains("continue this run's remaining work"));
        // No normal-ritual language: there is no handoff to read.
        assert!(!text.contains("Read the handoff file"));
        assert!(!text.contains("SKIP"));
    }

    #[test]
    fn test_recovery_instruction_pins_the_repo_when_known() {
        // Fresh-eyes finding D (PRD §10): with the origin remote parsed, BOTH
        // the issue read and the takeover comment carry --repo explicitly.
        let text = recovery_ritual_instruction("#37", 2, Some("nachogl1/maestro"), &wf());
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
        let text = recovery_ritual_instruction("#37", 2, None, &wf());
        // No pinned `gh` usage (the caution itself mentions the missing pin).
        assert!(!text.contains("passing `--repo"));
        assert!(!text.contains("again via `gh`"));
        assert!(text.contains("CAUTION"));
        assert!(text.contains("double-check it targets the correct repository"));
    }

    // --- issue #63: gen-1 launch brief ---

    /// An empty ref list, spelled so type inference has something to chew on.
    const NO_REFS: [&str; 0] = [];

    #[test]
    fn test_launch_instruction_is_single_line() {
        for pin in [None, Some("owner/repo")] {
            for refs in [
                RunRefs::epics_only("#38"),
                RunRefs::new(NO_REFS, ["7", "9"]),
                RunRefs::new(["5"], ["7"]),
            ] {
                let text = launch_instruction(&refs, pin, &wf());
                assert!(!text.contains('\n'), "launch brief must not contain \\n");
                assert!(!text.contains('\r'), "launch brief must not contain \\r");
            }
        }
        // A pathological ref cannot smuggle a newline into the paste — on
        // EITHER side of the split (issue #83).
        let text = launch_instruction(&RunRefs::epics_only("epic\nwith newline"), None, &wf());
        assert!(!text.contains('\n'));
        assert!(text.contains("epic with newline"));
        let text = launch_instruction(&RunRefs::new(NO_REFS, ["7\n9"]), None, &wf());
        assert!(!text.contains('\n'));
        assert!(text.contains("issue 7 9"));
    }

    #[test]
    fn test_launch_instruction_content() {
        let text = launch_instruction(&RunRefs::epics_only("#38"), None, &wf());
        // Identity: gen-1, the epic, its dedicated worktree.
        assert!(text.contains("generation 1"));
        assert!(text.contains("epic #38"));
        assert!(text.contains("worktree"));
        // Read the epic AND its child issues, plan first.
        assert!(text.contains("`gh` CLI"));
        assert!(text.contains("ALL of its comments"));
        assert!(text.contains("EVERY child issue"));
        // Agent-readiness is the MODEL's call, not a human checkbox: gen-1
        // judges each issue, works the ready ones, and reports the rest.
        assert!(text.contains("AGENT-READY"));
        assert!(text.contains("Work only the ready ones"));
        assert!(text.contains("exactly what is missing"));
        assert!(text.contains("Plan the work"));
        // Small idempotent subagent tasks with per-step commits (PRD §10).
        assert!(text.contains("SMALL idempotent subagent tasks"));
        assert!(text.contains("stage named paths only"));
        assert!(text.contains("Conventional Commit"));
        // Progress comments + the ONE batch PR (review F6 — the workflow
        // and the COMPLETION clause assume a single run PR), and the hard
        // containment rule.
        assert!(text.contains("comment progress"));
        assert!(text.contains("open the run's pull request"));
        assert!(text.contains("keep it updated"));
        assert!(!text.contains("open pull requests"));
        assert!(text.contains("NEVER switch to, commit to, or push any other branch"));
        assert!(text.contains("NEVER touch any repository other than this one"));
        // No successor/recovery language: there is nothing to hand off from.
        assert!(!text.contains("handoff"));
        assert!(!text.contains("RECOVERY"));
    }

    #[test]
    fn test_launch_instruction_pins_the_repo_when_known() {
        // PRD §10: gen-1 runs with --dangerously-skip-permissions, so BOTH
        // the issue reads and the progress/PR clause carry --repo explicitly
        // (mirrors recovery_ritual_instruction's pinning language).
        let text = launch_instruction(&RunRefs::epics_only("#38"), Some("nachogl1/maestro"), &wf());
        assert_eq!(
            text.matches("--repo nachogl1/maestro").count(),
            2,
            "read AND progress clauses must be pinned: {text}"
        );
        assert!(text.contains("passing `--repo nachogl1/maestro` explicitly"));
        assert!(!text.contains("CAUTION"));
        // The pin rides every shape, not just the epic one (issue #83).
        for refs in [
            RunRefs::new(NO_REFS, ["7", "9"]),
            RunRefs::new(["5"], ["7"]),
        ] {
            let text = launch_instruction(&refs, Some("nachogl1/maestro"), &wf());
            assert_eq!(
                text.matches("--repo nachogl1/maestro").count(),
                2,
                "read AND progress clauses must be pinned: {text}"
            );
            assert!(!text.contains("CAUTION"));
        }
    }

    #[test]
    fn test_launch_instruction_without_pin_carries_a_caution() {
        for refs in [
            RunRefs::epics_only("#38"),
            RunRefs::new(NO_REFS, ["7", "9"]),
            RunRefs::new(["5"], ["7"]),
        ] {
            let text = launch_instruction(&refs, None, &wf());
            assert!(!text.contains("passing `--repo"));
            assert!(text.contains("CAUTION"));
            assert!(text.contains("double-check it targets the correct repository"));
        }
    }

    // --- issue #83: epics and issues named separately ---

    #[test]
    fn test_run_refs_normalises_every_ref() {
        // `#5`, `5` and ` #5 ` are one ref; empties are dropped.
        let refs = RunRefs::new(["#5", " 12 ", "", "  ", "#"], [" #7", "9"]);
        assert_eq!(refs.epics().to_vec(), vec!["5", "12"]);
        assert_eq!(refs.issues().to_vec(), vec!["7", "9"]);
        assert!(!refs.is_empty());
        assert!(RunRefs::new(NO_REFS, NO_REFS).is_empty());
        // The pre-#83 wire: ONE comma-separated field, every ref an epic.
        let refs = RunRefs::epics_only("#77, 78,");
        assert_eq!(refs.epics().to_vec(), vec!["77", "78"]);
        assert!(refs.issues().is_empty());
        // No ref can smuggle a newline (the paste-ability invariant).
        let refs = RunRefs::new(["5\n6"], NO_REFS);
        assert_eq!(refs.epics().to_vec(), vec!["5 6"]);
        assert!(!refs.label().contains('\n'));
    }

    #[test]
    fn test_run_refs_label_slugs_to_the_combined_run_slug() {
        // The identity property later steps store as the run's `epic` field:
        // the label IS what epic_slug turns into the run's branch/worktree/
        // handoff-filename slug, so the split never touches epic_slug.
        let both = RunRefs::new(["5"], ["7", "9"]);
        assert_eq!(both.label(), "epic #5 · issues #7, #9");
        assert_eq!(epic_slug(&both.label()), "epic-5-issues-7-9");

        let issues = RunRefs::new(NO_REFS, ["7", "9"]);
        assert_eq!(issues.label(), "issues #7, #9");
        assert_eq!(epic_slug(&issues.label()), "issues-7-9");

        let epic = RunRefs::epics_only("5");
        assert_eq!(epic.label(), "epic #5");
        assert_eq!(epic_slug(&epic.label()), "epic-5");

        // Plurals agree on both sides.
        assert_eq!(RunRefs::epics_only("5, 12").label(), "epics #5, #12");
        assert_eq!(RunRefs::new(NO_REFS, ["7"]).label(), "issue #7");
        assert_eq!(
            RunRefs::new(["5", "12"], ["7"]).label(),
            "epics #5, #12 · issue #7"
        );

        // Pathological: nothing usable on either side still slugs to a
        // legal, non-empty name — epic_slug's existing `epic` fallback.
        let empty = RunRefs::new(NO_REFS, NO_REFS);
        assert_eq!(empty.label(), "");
        assert_eq!(epic_slug(&empty.label()), "epic");
        assert_eq!(epic_slug(&RunRefs::epics_only(" , ").label()), "epic");
    }

    #[test]
    fn test_run_refs_prose_names_each_set() {
        assert_eq!(RunRefs::epics_only("#5").prose(), "GitHub epic #5");
        assert_eq!(RunRefs::epics_only("5, 12").prose(), "GitHub epics #5, #12");
        assert_eq!(
            RunRefs::new(NO_REFS, ["7", "9"]).prose(),
            "GitHub issues #7, #9"
        );
        assert_eq!(RunRefs::new(NO_REFS, ["7"]).prose(), "GitHub issue #7");
        assert_eq!(
            RunRefs::new(["5"], ["7", "9"]).prose(),
            "GitHub epic #5 and issues #7, #9"
        );
        assert_eq!(
            RunRefs::new(["5", "12"], ["7"]).prose(),
            "GitHub epics #5, #12 and issue #7"
        );
    }

    #[test]
    fn test_launch_instruction_epics_only_wording_keeps_epic_framing() {
        // Issue #83 acceptance criterion, adapted after the samurai-epic-106
        // merge: byte-equality with the pre-split brief no longer holds
        // (issues #91/#92/#93/#95/#96 appended the workflow/order/PR/
        // completion riders and #106's runnability check extended step 2),
        // but an epic-only run must keep the pre-split epic framing in every
        // sentence the #83 split could have changed.
        let text = launch_instruction(&RunRefs::epics_only("#38"), None, &wf());
        assert!(text.starts_with(
            "[Maestro Samurai] You are generation 1, the FIRST orchestrator, for GitHub epic \
             #38. This directory is the epic's dedicated worktree on its own branch."
        ));
        assert!(text.contains(
            "read the epic's GitHub issue, ALL of its comments, and EVERY child issue it \
             references with the `gh` CLI, run from this directory"
        ));
        assert!(text.contains("say so in your progress comment on the epic"));
        assert!(text.contains("comment progress on the epic's GitHub issue as issues complete"));
        assert!(text.contains(
            "CAUTION: Maestro could not determine this repository's origin remote"
        ));
    }

    #[test]
    fn test_launch_instruction_issues_only_never_mentions_an_epic() {
        let text = launch_instruction(&RunRefs::new(NO_REFS, ["7", "9"]), None, &wf());
        // Named for what it is, plural agreeing.
        assert!(text.contains("for GitHub issues #7, #9."));
        assert!(text.contains("This directory is this run's dedicated worktree"));
        // Each issue is read, and progress is commented on each issue.
        assert!(text.contains("read EACH of this run's GitHub issues and ALL of their comments"));
        assert!(text.contains("comment progress on EACH of those GitHub issues as they complete"));
        assert!(text.contains("say so in that issue's progress comment"));
        // The whole point: no phantom parent, no phantom children.
        assert!(
            !text.to_lowercase().contains("epic"),
            "still says epic: {text}"
        );
        assert!(
            !text.contains("child issue"),
            "still says child issue: {text}"
        );
        // Singular agrees too.
        let one = launch_instruction(&RunRefs::new(NO_REFS, ["7"]), None, &wf());
        assert!(one.contains("for GitHub issue #7."));
        assert!(one.contains("read this run's GitHub issue and ALL of its comments"));
        assert!(one.contains("comment progress on that GitHub issue as work completes"));
        assert!(!one.to_lowercase().contains("epic"));
    }

    #[test]
    fn test_launch_instruction_both_names_the_epic_and_the_issues_separately() {
        let text = launch_instruction(&RunRefs::new(["5"], ["7", "9"]), None, &wf());
        // The identity sentence names both sets, separately.
        assert!(text.contains("for GitHub epic #5 and issues #7, #9."));
        // Read the epic AND its children AND the named standalone issues.
        assert!(text.contains(
            "read the epic's GitHub issue, ALL of its comments, and EVERY child issue it \
             references, plus the standalone issues #7, #9 and ALL of their comments"
        ));
        // Progress still gathers on the epic.
        assert!(text.contains("comment progress on the epic's GitHub issue as issues complete"));
        // Singular standalone issue agrees.
        let one = launch_instruction(&RunRefs::new(["5"], ["7"]), None, &wf());
        assert!(one.contains("for GitHub epic #5 and issue #7."));
        assert!(one.contains("plus the standalone issue #7 and ALL of its comments"));
    }

    #[test]
    fn test_launch_instruction_epic_plurals_agree() {
        let text = launch_instruction(&RunRefs::epics_only("5, 12"), None, &wf());
        assert!(text.contains("for GitHub epics #5, #12."));
        assert!(text.contains(
            "read the epics' GitHub issues, ALL of their comments, and EVERY child issue they \
             reference"
        ));
        assert!(text.contains("comment progress on the epics' GitHub issues as issues complete"));
        assert!(text.contains("say so in your progress comment on the epics"));
    }

    #[test]
    fn test_sibling_prompts_never_call_a_set_of_issues_an_epic() {
        // From step 1b onward these receive RunRefs::label() — an
        // issues-only run must never be described as an epic anywhere.
        let label = RunRefs::new(NO_REFS, ["7", "9"]).label();
        let successor = successor_ritual_instruction(&label, 2, true, &wf());
        assert!(successor.contains("generation 3 for issues #7, #9"));
        let recovery = recovery_ritual_instruction(&label, 2, Some("nachogl1/maestro"), &wf());
        assert!(recovery.contains("generation 3 for issues #7, #9"));
        for text in [
            successor,
            recovery,
            recovery_ritual_instruction(&label, 2, None, &wf()),
            handoff_instruction(&label, 2),
            handoff_corrective_instruction(&label, 2, "handoff file missing"),
            park_instruction(&label, 2),
            park_corrective_instruction(&label, 2, "WIP is not committed"),
        ] {
            assert!(
                !text.to_lowercase().contains("epic"),
                "still says epic: {text}"
            );
        }
        // And an epic-only run still reads exactly as it did: the label
        // itself supplies the word.
        let label = RunRefs::epics_only("#5").label();
        assert!(successor_ritual_instruction(&label, 2, true, &wf())
            .contains("generation 3 for epic #5"));
        assert!(recovery_ritual_instruction(&label, 2, None, &wf())
            .contains("you are generation 3 for epic #5."));
    }

    // --- issue #87: comma-separated issue list is not an epic ---

    #[test]
    fn test_is_issue_list_detects_comma_separated_refs() {
        assert!(!is_issue_list("#38"));
        assert!(!is_issue_list("Epic 12: Auth"));
        assert!(!is_issue_list("https://github.com/o/r/issues/9"));
        assert!(is_issue_list("77, 78"));
        assert!(is_issue_list("#76, #77, #78"));
    }

    #[test]
    fn test_launch_instruction_list_shape_has_no_epic_framing() {
        // Given a plain issue list, the brief must not send gen-1 hunting
        // for a phantom epic issue that "references" the listed issues.
        // (Post-#83 the list arrives as standalone issues in RunRefs and the
        // wording is main's issues-only shape.)
        let text = launch_instruction(
            &RunRefs::new(NO_REFS, ["76", "77", "78"]),
            Some("nachogl1/maestro"),
            &wf(),
        );
        assert!(text.contains("for GitHub issues #76, #77, #78"));
        assert!(text.contains("read EACH of this run's GitHub issues and ALL of their comments"));
        assert!(text.contains("comment progress on EACH of those GitHub issues as they complete"));
        assert!(!text.to_lowercase().contains("epic"));
        assert!(!text.to_lowercase().contains("child issue"));
        // The rest of the brief is unaffected.
        assert!(text.contains("generation 1"));
        assert!(text.contains("AGENT-READY"));
        assert!(!text.contains('\n'));
    }

    #[test]
    fn test_launch_instruction_single_epic_ref_keeps_todays_wording() {
        // Acceptance: a single epic ref must be untouched by the #87 fix.
        let text = launch_instruction(&RunRefs::epics_only("#38"), None, &wf());
        assert!(text.contains("for GitHub epic #38"));
        assert!(text.contains("the epic's dedicated worktree"));
        assert!(text.contains(
            "the epic's GitHub issue, ALL of its comments, and EVERY child issue it references"
        ));
        assert!(text.contains("comment progress on the epic's GitHub issue as issues complete"));
        assert!(text.contains("your progress comment on the epic"));
    }

    #[test]
    fn test_successor_ritual_instruction_list_shape_has_no_epic_framing() {
        // Pre-#83 configs store the raw comma list as the run's identity;
        // the brief must carry it verbatim, with zero epic framing.
        let text = successor_ritual_instruction("77, 78", 2, true, &wf());
        assert!(text.contains("generation 3 for 77, 78"));
        assert!(!text.to_lowercase().contains("epic"));
        assert!(text.contains("generation 3"));
        assert!(text.contains("successor to generation 2"));
    }

    #[test]
    fn test_recovery_ritual_instruction_list_shape_has_no_epic_framing() {
        let text = recovery_ritual_instruction("77, 78", 2, Some("nachogl1/maestro"), &wf());
        assert!(text.contains("generation 3 for 77, 78"));
        assert!(text.contains("read this run's GitHub issue(s) and ALL of their comments"));
        assert!(text.contains("comment on this run's GitHub issue(s)"));
        assert!(text.contains("this run's remaining work"));
        assert!(!text.to_lowercase().contains("epic"));
        assert!(text.contains("RECOVERY MODE"));
    }

    // --- issue #89: acceptance-criteria commands must be runnable ---

    #[test]
    fn test_launch_instruction_verifies_acceptance_criteria_commands() {
        // Issues #82–#84 gated on `npm run lint` when no lint script existed;
        // agents shipped against unrunnable criteria. The assessment step
        // must demand VERIFIED runnability, not assumption — for the epic
        // shape AND the list shape.
        for text in [
            launch_instruction(&RunRefs::epics_only("#38"), Some("nachogl1/maestro"), &wf()),
            launch_instruction(&RunRefs::new(NO_REFS, ["76", "77", "78"]), None, &wf()),
        ] {
            // Runnability is part of the agent-ready bar…
            assert!(
                text.contains(
                    "every command named in its acceptance criteria exists and is RUNNABLE"
                ),
                "{text}"
            );
            // …and it is VERIFIED against the repo, never assumed.
            assert!(text.contains("VERIFY runnability"), "{text}");
            assert!(
                text.contains("check the repo instead of assuming"),
                "{text}"
            );
            assert!(text.contains("package.json"), "{text}");
            assert!(text.contains("`--version`/`--help` probe"), "{text}");
            // A missing command disqualifies the issue…
            assert!(
                text.contains("name a command that is missing is NOT agent-ready"),
                "{text}"
            );
            // …and the issue is named-and-excluded, never guessed at.
            assert!(
                text.contains("for a missing command, name exactly which command"),
                "{text}"
            );
            assert!(text.contains("exclude it from this run"), "{text}");
            // Still one paste-able line (module doc).
            assert!(!text.contains('\n'));
        }
    }

    // --- issue #95: PR-issue linking (Closes/Fixes) ---

    #[test]
    fn test_launch_instruction_instructs_pr_issue_linking() {
        // Merging a Samurai PR must close the issues it resolves — GitHub
        // only does that when the PR body says so.
        for pin in [None, Some("nachogl1/maestro")] {
            let text = launch_instruction(&RunRefs::epics_only("#38"), pin, &wf());
            assert!(text.contains("Closes #N"), "{text}");
            assert!(text.contains("Fixes #N"), "{text}");
            assert!(text.contains("GitHub auto-closes them on merge"), "{text}");
        }
    }

    #[test]
    fn test_successor_ritual_instruction_instructs_pr_issue_linking() {
        for head_matched in [true, false] {
            let text = successor_ritual_instruction("#37", 2, head_matched, &wf());
            assert!(text.contains("Closes #N"), "{text}");
            assert!(text.contains("Fixes #N"), "{text}");
            assert!(text.contains("GitHub auto-closes them on merge"), "{text}");
        }
    }

    #[test]
    fn test_recovery_ritual_instruction_instructs_pr_issue_linking() {
        // Audited per issue #95: recovery briefs can open PRs too.
        let text = recovery_ritual_instruction("#37", 2, None, &wf());
        assert!(text.contains("Closes #N"));
        assert!(text.contains("Fixes #N"));
        assert!(text.contains("GitHub auto-closes them on merge"));
    }

    // --- issue #92: PR titles enumerate every issue/epic number ---

    #[test]
    fn test_launch_instruction_instructs_pr_title_enumerates_refs() {
        let text = launch_instruction(&RunRefs::epics_only("#38"), None, &wf());
        assert!(
            text.contains(
                "every PR title must list every issue/epic number this run covers, from the \
                 moment it is created"
            ),
            "{text}"
        );
        assert!(
            text.contains("`feat(samurai): #76 #77 #78 — summary`"),
            "{text}"
        );
    }

    #[test]
    fn test_successor_ritual_instruction_instructs_pr_title_enumerates_refs() {
        let text = successor_ritual_instruction("#37", 2, true, &wf());
        assert!(
            text.contains(
                "its title must list every issue/epic number this run covers, from the moment \
                 it is created"
            ),
            "{text}"
        );
        assert!(
            text.contains("`feat(samurai): #76 #77 #78 — summary`"),
            "{text}"
        );
    }

    // --- issue #96: run-completion declaration clause ---

    #[test]
    fn test_every_orchestrator_brief_instructs_the_completion_declaration() {
        // Issue #96: nothing but a verified declaration ever finishes a run,
        // so EVERY orchestrator brief — gen-1 (epic ref or issue list) and
        // both successor rituals — must tell the model how to declare.
        let briefs = [
            launch_instruction(&RunRefs::epics_only("#38"), Some("nachogl1/maestro"), &wf()),
            launch_instruction(&RunRefs::new(NO_REFS, ["77", "78"]), None, &wf()),
            successor_ritual_instruction("#37", 2, true, &wf()),
            successor_ritual_instruction("#37", 2, false, &wf()),
            recovery_ritual_instruction("#37", 2, Some("nachogl1/maestro"), &wf()),
            recovery_ritual_instruction("#37", 2, None, &wf()),
        ];
        for text in &briefs {
            // The exact tag the samurai_completion scanner watches for, in
            // opening AND closing form, plus the claim shape: issues first,
            // then the PR number — what `gh` verification checks.
            assert!(
                text.contains(&format!("<{RUN_COMPLETE_TAG}>issues")),
                "missing declaration template: {text}"
            );
            assert!(text.contains(&format!("</{RUN_COMPLETE_TAG}>")));
            assert!(text.contains("pr #<n>"));
            // The corrected completion matrix (review F3): the open batch
            // PR with close links is declarable — issues need not all be
            // CLOSED while the PR is open — and so is the merged-PR +
            // all-closed state.
            assert!(text.contains("pull request is OPEN"));
            assert!(text.contains("CLOSED on GitHub or linked for close"));
            assert!(text.contains("MERGED and every issue is CLOSED"));
            // Maestro verifies — an unverified declaration never flips.
            assert!(text.contains("verifies"));
            // Marker hygiene rides here too (fresh-eyes finding J).
            assert!(text.contains("Never quote, restate, or echo"));
            // Still one paste-able line (module doc).
            assert!(!text.contains('\n'), "brief must stay a single line");
            assert!(!text.contains('\r'));
        }
    }

    // --- issue #93: user issue order is the execution order ---

    #[test]
    fn test_launch_instruction_carries_the_order_contract() {
        // The user's listed order IS the execution order; gen-1 validates it
        // FIRST — before any code — and never silently reorders. A deviation
        // goes through the order-alert marker + the user's answer in the
        // terminal.
        let epic = launch_instruction(&RunRefs::epics_only("#38"), Some("nachogl1/maestro"), &wf());
        assert!(
            epic.contains("the order in which the epic lists its child issues"),
            "{epic}"
        );
        // List shape stays epic-free (enforced by
        // test_launch_instruction_list_shape_has_no_epic_framing).
        let list = launch_instruction(&RunRefs::new(NO_REFS, ["76", "77", "78"]), None, &wf());
        assert!(
            list.contains("the order in which the issues are listed above"),
            "{list}"
        );
        for text in [epic, list] {
            assert!(text.contains("EXECUTION ORDER"), "{text}");
            assert!(text.contains("strictly sequentially"), "{text}");
            assert!(text.contains("in exactly that order by default"), "{text}");
            assert!(text.contains("FIRST step"), "{text}");
            assert!(text.contains("before touching ANY code"), "{text}");
            assert!(
                text.contains("validate that order against the real dependencies"),
                "{text}"
            );
            // Agreement is silent; deviation STOPs and alerts with BOTH
            // orders + reasoning via the exact tag the watcher scans for.
            assert!(
                text.contains("proceed in that order without comment"),
                "{text}"
            );
            assert!(text.contains("STOP before any code"), "{text}");
            assert!(
                text.contains(&format!("<{ORDER_ALERT_TAG}>original:")),
                "{text}"
            );
            assert!(text.contains(&format!("</{ORDER_ALERT_TAG}>")), "{text}");
            assert!(text.contains("proposed:"), "{text}");
            assert!(text.contains("reasoning:"), "{text}");
            assert!(text.contains("WAIT for the user's answer"), "{text}");
            assert!(text.contains("NEVER silently reorder"), "{text}");
            // Still one paste-able line (module doc).
            assert!(!text.contains('\n'));
        }
    }

    #[test]
    fn test_successor_briefs_restate_the_order_contract() {
        // Successors (normal AND recovery, epic AND list shape) inherit the
        // order fixed at launch — they must not re-plan it, and a new
        // deviation goes through the same alert + confirmation.
        let briefs = [
            successor_ritual_instruction("#37", 2, true, &wf()),
            successor_ritual_instruction("#37", 2, false, &wf()),
            successor_ritual_instruction("77, 78", 2, true, &wf()),
            recovery_ritual_instruction("#37", 2, Some("nachogl1/maestro"), &wf()),
            recovery_ritual_instruction("77, 78", 2, None, &wf()),
        ];
        for text in &briefs {
            assert!(text.contains("fixed at launch"), "{text}");
            assert!(text.contains("Do NOT re-plan it"), "{text}");
            assert!(text.contains("strictly sequentially"), "{text}");
            assert!(
                text.contains(&format!("<{ORDER_ALERT_TAG}>original:")),
                "{text}"
            );
            assert!(text.contains("WAIT for the user's answer"), "{text}");
            assert!(text.contains("NEVER silently reorder"), "{text}");
            assert!(!text.contains('\n'));
        }
    }

    // --- issue #91: the compiled WORKFLOW section ---

    #[test]
    fn test_every_orchestrator_brief_carries_the_delimited_workflow_section() {
        // Launch (epic ref AND issue list), successor (both HEAD-gate
        // branches) and recovery briefs all embed the compiled workflow,
        // clearly delimited, still one paste-able line.
        let briefs = [
            launch_instruction(&RunRefs::epics_only("#38"), Some("nachogl1/maestro"), &wf()),
            launch_instruction(&RunRefs::new(NO_REFS, ["76", "77", "78"]), None, &wf()),
            successor_ritual_instruction("#37", 2, true, &wf()),
            successor_ritual_instruction("#37", 2, false, &wf()),
            recovery_ritual_instruction("#37", 2, Some("nachogl1/maestro"), &wf()),
            recovery_ritual_instruction("#37", 2, None, &wf()),
        ];
        for text in &briefs {
            assert!(
                text.contains("WORKFLOW — the process for this run"),
                "{text}"
            );
            assert!(text.contains("— END OF WORKFLOW."), "{text}");
            // The canonical steps, in canonical order (issue #91: implement
            // → review → committed QA report → push per issue, then batch
            // review → batch QA from the reports → PR for the human).
            let positions: Vec<usize> = [
                "Step 1: Work the run's issues strictly ONE at a time",
                "Step 2: Run a fresh-eyes review",
                "Step 3: Write a QA report",
                "Step 4: Push the branch",
                "Step 5: After ALL issues are done",
                "Step 6: Run a batch QA pass using the committed per-issue QA reports",
                "Step 7: Open or finalize the run's pull request",
            ]
            .iter()
            .map(|marker| {
                text.find(marker)
                    .unwrap_or_else(|| panic!("missing {marker:?}: {text}"))
            })
            .collect();
            assert!(
                positions.windows(2).all(|w| w[0] < w[1]),
                "steps out of order: {text}"
            );
            assert!(text.contains("HUMAN merge decision"), "{text}");
            // Composition contract: the section sits AFTER the #93 ORDER
            // clause and BEFORE the #96 COMPLETION clause — none of which
            // may regress.
            let order = text.find("ORDER:").expect("ORDER clause present");
            let workflow = text.find("WORKFLOW —").unwrap();
            let completion = text.find("COMPLETION:").expect("COMPLETION clause present");
            assert!(
                order < workflow && workflow < completion,
                "clause order broke: {text}"
            );
            // The #92/#95 PR-discipline wording still rides every brief.
            assert!(text.contains("Closes #N"), "{text}");
            // Still one paste-able line (module doc).
            assert!(!text.contains('\n'), "brief must stay a single line");
            assert!(!text.contains('\r'));
        }
    }

    #[test]
    fn test_briefs_embed_the_workflow_they_are_given_not_a_default() {
        // Successors recompile from the graph the run config snapshotted at
        // launch — whatever compiled text arrives is what must ride.
        let custom = "Step 1: custom implement Step 2: custom ship";
        for text in [
            launch_instruction(&RunRefs::epics_only("#38"), None, custom),
            successor_ritual_instruction("#37", 2, true, custom),
            recovery_ritual_instruction("#37", 2, None, custom),
        ] {
            assert!(text.contains("Step 1: custom implement"), "{text}");
            assert!(text.contains("Step 2: custom ship"), "{text}");
            assert!(!text.contains("fresh-eyes review"), "{text}");
        }
    }

    #[test]
    fn test_empty_compiled_workflow_omits_the_section_entirely() {
        // A graph edited down to nothing yields no WORKFLOW shell — and a
        // pathological compiled string cannot smuggle a newline in.
        for text in [
            launch_instruction(&RunRefs::epics_only("#38"), None, ""),
            successor_ritual_instruction("#37", 2, false, "  "),
            recovery_ritual_instruction("#37", 2, None, ""),
        ] {
            assert!(!text.contains("WORKFLOW"), "{text}");
            assert!(!text.contains("END OF"), "{text}");
        }
        let text = launch_instruction(&RunRefs::epics_only("#38"), None, "Step 1: a\nStep 2: b");
        assert!(!text.contains('\n'), "workflow text must be normalized");
        assert!(text.contains("Step 1: a Step 2: b"));
    }

    #[test]
    fn test_workflow_section_keeps_the_list_shape_epic_free() {
        // The #87 contract survives the new section: a comma-separated list
        // brief must stay free of epic framing even WITH the workflow.
        let text = launch_instruction(&RunRefs::new(NO_REFS, ["76", "77", "78"]), None, &wf());
        assert!(!text.to_lowercase().contains("epic"), "{text}");
        let text = successor_ritual_instruction("77, 78", 2, true, &wf());
        assert!(!text.to_lowercase().contains("epic"), "{text}");
        let text = recovery_ritual_instruction("77, 78", 2, None, &wf());
        assert!(!text.to_lowercase().contains("epic"), "{text}");
    }

    // --- issue #72: journaling rider ---

    #[test]
    fn test_journal_instruction_is_single_line() {
        let text = journal_instruction(r"C:\data\maestro\journal\journal.jsonl");
        assert!(!text.contains('\n'), "rider must not contain \\n");
        assert!(!text.contains('\r'), "rider must not contain \\r");
        // A pathological path cannot smuggle a newline into the paste.
        let text = journal_instruction("path\nwith newline");
        assert!(!text.contains('\n'));
        assert!(text.contains("path with newline"));
    }

    #[test]
    fn test_journal_instruction_content() {
        let path = r"C:\data\maestro\journal\journal.jsonl";
        let text = journal_instruction(path);
        // The exact file agents append to — in the rule AND the echo example.
        assert_eq!(text.matches(path).count(), 2, "path missing: {text}");
        assert!(text.contains(&format!("echo '<json>' >> \"{path}\"")));
        // All five SCREAMING category spellings — the JournalCategory wire
        // contract agents hand-write from shell prompts.
        for category in ["BOTTLENECK", "ERROR", "IMPROVEMENT", "SKILL", "CONCERN"] {
            assert!(
                text.contains(&format!("\"{category}\"")),
                "missing category {category}"
            );
        }
        // The full entry shape, timestamp format included.
        for field in [
            "\"ts\"",
            "\"category\"",
            "\"text\"",
            "\"project\"",
            "\"agent\"",
        ] {
            assert!(text.contains(field), "missing field {field}");
        }
        assert!(text.contains("ISO 8601"));
        assert!(text.contains("append ONE line"));
        // The reader is lenient — but the file is append-only: never
        // rewrite or delete what is already there.
        assert!(text.contains("Malformed lines are skipped"));
        assert!(text.contains("NEVER rewrite or delete existing lines"));
        assert!(text.contains("append-only"));
    }
}
