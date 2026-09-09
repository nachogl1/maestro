//! Brief FILES for long Samurai instructions (issue #137).
//!
//! Every Samurai instruction is typed into a live `claude` session's PTY, and
//! that write is BLIND: `ProcessManager` exposes no read side, so nothing can
//! confirm a frame landed. `samurai_pty` already types the payload in
//! [`CHUNK_BYTES`](super::samurai_pty::CHUNK_BYTES)-sized frames, yet a
//! multi-KB gen-1 launch brief was still observed arriving as two spliced
//! fragments cut mid-word (2026-08-17) — the middle of the payload never
//! landed and the run started on a headless fragment. No chunk/delay tuning
//! can close that: the only payload size that is genuinely safe is one that
//! fits in a SINGLE frame.
//!
//! So a long instruction stops being typed at all. It is written to a file in
//! the run's worktree and the agent is handed a one-line POINTER at it
//! ([`pointer_instruction`]) — short enough for one frame, and strictly
//! easier for the agent to act on than a paste it may only half receive.
//!
//! The brief lives INSIDE the worktree, under [`BRIEF_DIR`], for three
//! reasons: `.maestro/` is already exempt from the handoff WIP check
//! (`samurai_injector::porcelain_line_blocks`), so a brief file can never
//! block handoff validation; a worktree-relative path needs no Windows
//! quoting and no out-of-project read permission; and it sits next to
//! `.maestro/handoffs/`, which the Second Brain already inventories.
//!
//! The brief file carries the instruction VERBATIM, so any ACK or written
//! marker the instruction demands is inside the file exactly as it would have
//! been typed. A brief the agent never reads simply fails to ACK and walks
//! the existing retry ladder — no new recovery machinery.
//!
//! **Two callers, two size gates.** The samurai path
//! ([`deliverable_instruction`]) measures the RAW instruction and falls back
//! to typing that raw text; the initial-prompt path
//! (`commands::initial_prompt::InitialPromptInjector::arm`, issue #138)
//! measures the WHITESPACE-FLATTENED prompt — that is what its PTY write
//! would carry — and falls back to the flattened text. Same threshold, two
//! measurements, on purpose: each gate weighs exactly the payload its own
//! fallback would type. Neither is the other's bug.
//!
//! Only instructions over [`INLINE_MAX_BYTES`] take this route: short ones
//! (handoff request, park, wind-down, corrective) keep today's inline
//! delivery, which works and is well tested. And if the file write fails, the
//! full text is typed exactly as it is today — a warning, never a new failure
//! mode.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Brief files live beside handoffs, inside the run worktree. Forward slashes
/// on purpose: the path appears verbatim in the pointer instruction, and
/// `Path::join` accepts them on every platform (same rule as
/// `samurai_prompts::handoff_file_relpath`).
pub const BRIEF_DIR: &str = ".maestro/briefs";

/// Instructions at or under this size keep the existing inline delivery — a
/// payload this small is comfortably delivered by the existing chunked
/// transport, and routing it through a file would add an unread-file failure
/// mode to paths that never had one.
pub const INLINE_MAX_BYTES: usize = 500;

/// Longest brief file stem [`write_brief`] will ever write. The pointer's
/// fixed text is 189 bytes and `.maestro/briefs/` + `.md` adds 19, so a stem
/// this long yields a 248-byte pointer — inside
/// [`CHUNK_BYTES`](super::samurai_pty::CHUNK_BYTES) with room to spare, which
/// is the whole point of the file (a spliced POINTER would be the #137 bug
/// with extra steps). Longer names are truncated and hashed, never rejected.
const MAX_STEM_CHARS: usize = 40;

/// Hex characters of the name hash appended when a stem is truncated.
const STEM_HASH_CHARS: usize = 8;

/// What [`ensure_maestro_ignored`] adds to a checkout's `.git/info/exclude`:
/// the whole Maestro tree, not just the one brief — briefs, handoffs and
/// anything else the run drops there are equally not the user's work.
const MAESTRO_EXCLUDE_LINE: &str = ".maestro/";

/// A brief that actually landed on disk: the directory it was staged UNDER
/// (the `worktree` argument to [`write_brief`]) plus the worktree-relative
/// path inside it that the agent was pointed at.
///
/// The two halves travel together on purpose. The relative path alone is what
/// the pointer instruction carries, and it is the only half worth showing a
/// human — but it is meaningless without the root it resolves against. For a
/// PR review those are genuinely different directories: the brief is staged in
/// the TAB's project (the terminal's working directory, so the pointer
/// resolves), while the review's record groups under the PR's OWN checkout
/// (`PrActionsMenu`, review finding C10). Anything that has to find the file
/// again later — the #145 retention sweep above all — needs both halves, and
/// guessing the root from the other one deletes the wrong tree's file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedBrief {
    /// The directory [`BRIEF_DIR`] was created under.
    pub root: PathBuf,
    /// Path of the brief RELATIVE to [`Self::root`], forward-slashed, exactly
    /// as [`write_brief`] returned it.
    pub relpath: String,
}

/// Writes `body` to `<worktree>/.maestro/briefs/<name>.md`, creating the
/// directory. Returns the WORKTREE-RELATIVE path — that is what the agent is
/// pointed at, and it needs no quoting.
///
/// An existing brief of the same name is overwritten: a re-staged generation
/// (a dropped spawn event re-emitted, a `--repo` pin swapped in) must leave
/// exactly one brief on disk, the current one.
///
/// The worktree itself is never created — only the brief directory inside it.
/// A path that is not a directory is a caller error (an unresolved or
/// mistyped worktree), and materializing a tree there would leave stray
/// `.maestro/briefs` directories on disk pointing at nothing.
///
/// `name` is slugged and bounded by [`safe_stem`] before it touches the
/// filesystem, and the write itself is temp-then-rename: an agent already
/// reading a brief of the same name sees the old file or the new one, never a
/// truncated one.
pub fn write_brief(worktree: &Path, name: &str, body: &str) -> Result<String, String> {
    if !worktree.is_dir() {
        return Err(format!(
            "the run worktree {} does not exist — no brief written",
            worktree.display()
        ));
    }
    let stem = safe_stem(name)?;
    let dir = worktree.join(BRIEF_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "could not create the brief directory {}: {e}",
            dir.display()
        )
    })?;
    ensure_maestro_ignored(worktree);
    let relpath = format!("{BRIEF_DIR}/{stem}.md");
    let path = worktree.join(&relpath);
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, body)
        .map_err(|e| format!("could not write the brief at {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!(
            "could not move the brief into place at {}: {e}",
            path.display()
        )
    })?;
    Ok(relpath)
}

/// The file stem a brief is actually written under: `name` lowercased and
/// slugged to `[a-z0-9._-]`, then bounded to [`MAX_STEM_CHARS`].
///
/// `name` is caller-controlled text, not a constant — it crosses the Tauri IPC
/// boundary as `terminal_arm_initial_prompt`'s `brief_stem`, so a `..`, a `/`,
/// a `\` or a `:` in it would escape `<worktree>/.maestro/briefs/` and write
/// anywhere the app can reach. Every character outside the allowed set becomes
/// `-`, so no separator, drive letter or NTFS stream name survives; a name
/// that slugs to nothing (`""`, `"."`, `".."`, `"///"`) is refused outright
/// rather than silently renamed, and the caller falls back to typing the text
/// inline — a delivery that works.
fn safe_stem(name: &str) -> Result<String, String> {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'a'..='z' | '0'..='9' | '.' | '_' | '-' => c,
            _ => '-',
        })
        .collect();
    // Trimming the ends of `.` is what kills `.`, `..` and a leading-dot
    // hidden file; interior dots are harmless once no separator can survive.
    let slug = slug.trim_matches(|c| c == '-' || c == '.');
    if slug.is_empty() {
        return Err(format!(
            "the brief name {name:?} has no usable characters — no brief written"
        ));
    }
    if slug.len() <= MAX_STEM_CHARS {
        return Ok(slug.to_string());
    }
    // Truncate, then re-attach identity: the hash is taken over the WHOLE
    // slug, so two long names sharing a prefix (two PR reviews differing only
    // in their last ticked step) cannot land on one brief. ASCII by
    // construction, so byte and character counts agree.
    let hash = hex::encode(&Sha256::digest(slug.as_bytes())[..STEM_HASH_CHARS / 2]);
    let head = &slug[..MAX_STEM_CHARS - STEM_HASH_CHARS - 1];
    Ok(format!("{head}-{hash}"))
}

/// Keeps a brief file out of `git status` in the checkout it is written into.
///
/// The PR-review path (issue #138) writes its brief into the USER's own
/// checkout, not a throwaway run worktree, so without this every review drops
/// an untracked `.maestro/briefs/pr-N-*.md` into their working tree: noise at
/// best, and swept into a commit by any agent running `git add -A` at worst —
/// which the PR review prompt's own rules forbid.
///
/// The entry goes in `<repo>/.git/info/exclude`: repo-local, never committed,
/// and it leaves the tracked `.gitignore` the user owns alone. Idempotent —
/// appended only when no line already spells it. Anything that is not a plain
/// git checkout is skipped: no `.git`, or a `.git` FILE (what `git worktree
/// add` leaves, whose exclude belongs to the parent repo). Every failure is
/// logged and swallowed; an exclude that cannot be updated must never cost the
/// run its brief.
fn ensure_maestro_ignored(worktree: &Path) {
    let git_dir = worktree.join(".git");
    if !git_dir.is_dir() {
        return;
    }
    let exclude = git_dir.join("info").join("exclude");
    let current = match std::fs::read_to_string(&exclude) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            log::warn!(
                "samurai brief: cannot read {} ({e}) — leaving the exclude alone",
                exclude.display()
            );
            return;
        }
    };
    if current
        .lines()
        .any(|line| line.trim() == MAESTRO_EXCLUDE_LINE)
    {
        return;
    }
    let mut updated = current;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str("# Maestro-managed files (briefs, handoffs) — added by Maestro\n");
    updated.push_str(MAESTRO_EXCLUDE_LINE);
    updated.push('\n');
    if let Some(parent) = exclude.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!(
                "samurai brief: cannot create {} ({e}) — the brief stays untracked-visible",
                parent.display()
            );
            return;
        }
    }
    if let Err(e) = std::fs::write(&exclude, updated) {
        log::warn!(
            "samurai brief: cannot update {} ({e}) — the brief stays untracked-visible",
            exclude.display()
        );
    }
}

/// The single-line instruction that points an agent at a brief file.
///
/// Single line by construction, like every other instruction text: a newline
/// inside the payload submits the prompt half-typed. `relpath` is
/// whitespace-normalized for that reason.
pub fn pointer_instruction(relpath: &str) -> String {
    let relpath = relpath.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "[Maestro Samurai] Read `{relpath}` in FULL with the Read tool before doing anything \
         else, then follow it verbatim as your operating instructions for this run. Do not \
         skim it and do not summarise it."
    )
}

/// The last segment of [`BRIEF_DIR`] — the directory name that sits directly
/// above every brief file.
///
/// Issue #204's receipt matcher checks it, so that a same-named file
/// elsewhere cannot pass for a brief. Derived rather than spelled again, so
/// moving the brief directory can never leave the check behind.
pub fn brief_dir_name() -> &'static str {
    BRIEF_DIR.rsplit('/').next().unwrap_or(BRIEF_DIR)
}

/// The brief FILE NAME (`<stem>.md`) that `instruction` points an agent at,
/// or `None` when `instruction` is not a pointer at all — an inline
/// instruction under [`INLINE_MAX_BYTES`], or a full ritual text the file
/// route never got to write.
///
/// The NAME, not the path, because the name is the only spelling every later
/// sighting of the file shares (issue #204): the pointer carries the
/// worktree-relative path, but an agent Reads it back as relative, absolute,
/// forward- or back-slashed, or `\\?\`-prefixed, and a `cat` of it is quoted
/// however the shell wanted it.
///
/// Recognises exactly what [`pointer_instruction`] emits: the first
/// backquoted span, required to be a `<stem>.md` directly under
/// [`BRIEF_DIR`]. Anything else — prose that merely contains backquotes, a
/// pointer at some other file — is not a brief pointer.
pub fn pointer_brief_file_name(instruction: &str) -> Option<String> {
    let quoted = instruction.split('`').nth(1)?;
    let file_name = quoted.strip_prefix(&format!("{BRIEF_DIR}/"))?;
    if !file_name.ends_with(".md") || file_name.contains('/') {
        return None;
    }
    Some(file_name.to_string())
}

/// Whether `instruction` is delivered as-is, small enough that
/// [`deliverable_instruction`] makes no filesystem call for it at all.
///
/// The single definition of that rule. Callers who decide something else
/// from it — the injector's issue-#153 gate, which only pays for a
/// blocking-pool hop when a file might actually be written — ask here
/// instead of re-comparing against [`INLINE_MAX_BYTES`], so the decision and
/// the delivery can never drift apart.
pub fn is_inline(instruction: &str) -> bool {
    instruction.len() <= INLINE_MAX_BYTES
}

/// Longest payload allowed onto a `claude` LAUNCH LINE (issue #158).
///
/// Deliberately its own constant rather than a reuse of [`INLINE_MAX_BYTES`],
/// which it happens to equal: the two gates measure different things. The
/// inline gate is about ONE PTY FRAME (`samurai_pty::CHUNK_BYTES`, 256 bytes,
/// chunked); a launch line bypasses that transport entirely — it is one
/// argument on a command line the shell parses, so the real ceiling is the
/// shell's (cmd.exe's is 8191 characters, and quoting only adds two). 500 is a
/// deliberately conservative fraction of that: comfortably above the ~250-byte
/// pointer this exists for, and far below anything that could crowd a command
/// line, so a FULL brief (multi-KB, staged only when the file write failed)
/// can never take this route by accident.
pub const LAUNCH_LINE_MAX_BYTES: usize = 500;

/// Whether `instruction` may ride the `claude` LAUNCH LINE as a positional
/// initial-prompt argument instead of being typed into the running REPL
/// (issue #158).
///
/// Two conditions, both about the SHELL the launch command is typed into:
/// - Single line. A CR or LF inside a command line submits it half-written —
///   the very failure #137 exists to stop, and the reason
///   [`pointer_instruction`] normalizes whitespace.
/// - No bigger than [`LAUNCH_LINE_MAX_BYTES`].
///
/// Refusal is not a failure — the caller keeps the typed delivery it already
/// had.
pub fn launch_line_safe(instruction: &str) -> bool {
    instruction.len() <= LAUNCH_LINE_MAX_BYTES && !instruction.contains(['\n', '\r'])
}

/// What is actually typed into the PTY for `instruction`: the instruction
/// itself when it fits the inline budget, otherwise a pointer at a brief file
/// written into `worktree` under `name`.
///
/// A failed write falls back to the full text — the pre-#137 behaviour — so
/// the brief file can only ever improve delivery, never break it.
pub fn deliverable_instruction(worktree: &Path, name: &str, instruction: String) -> String {
    match try_deliverable_instruction(worktree, name, &instruction) {
        Ok(Some(pointer)) => pointer,
        Ok(None) => instruction,
        Err(e) => {
            log::warn!("samurai brief: {e} — typing the full instruction inline instead");
            instruction
        }
    }
}

/// [`deliverable_instruction`] without the swallowed failure: the same
/// routing — the instruction inline under [`INLINE_MAX_BYTES`], a pointer at
/// a written brief over it — but a failed write comes back as `Err` instead
/// of silently becoming "type the whole thing".
///
/// `Ok(None)` means keep `instruction` exactly as it is, nothing was
/// written; `Ok(Some(pointer))` means the brief is on disk and `pointer` is
/// what to type; `Err` means the file route was taken and FAILED.
///
/// Added for issue #154. `commands::harvest` sizes the payload it assembles
/// to the route it is about to take, so its file-route payload is far too
/// large to blind-type as a fallback — it has to learn the write failed,
/// re-render smaller, and type that instead. Callers with nothing to
/// re-render keep using [`deliverable_instruction`], whose infallible
/// fallback is the right answer when the alternative is delivering nothing.
pub fn try_deliverable_instruction(
    worktree: &Path,
    name: &str,
    instruction: &str,
) -> Result<Option<String>, String> {
    if is_inline(instruction) {
        return Ok(None);
    }
    write_brief(worktree, name, instruction).map(|relpath| Some(pointer_instruction(&relpath)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::samurai_pty::{chunk_frames, CHUNK_BYTES};
    use tempfile::tempdir;

    /// An instruction long enough to take the file route, with recognizable
    /// ends so a spliced or truncated delivery is visible.
    fn long_instruction() -> String {
        format!(
            "[Maestro Samurai] START {} END",
            "you are generation 1, follow the workflow. ".repeat(40)
        )
    }

    #[test]
    fn test_write_brief_creates_the_directory_and_returns_a_relative_path() {
        let dir = tempdir().unwrap();
        let worktree = dir.path();
        assert!(!worktree.join(BRIEF_DIR).exists());

        let relpath = write_brief(worktree, "gen-1-launch", "# Brief\nbody\n").unwrap();

        assert_eq!(relpath, ".maestro/briefs/gen-1-launch.md");
        assert!(!Path::new(&relpath).is_absolute(), "worktree-relative");
        assert_eq!(
            std::fs::read_to_string(worktree.join(&relpath)).unwrap(),
            "# Brief\nbody\n",
            "the body is written byte for byte"
        );
    }

    #[test]
    fn test_write_brief_overwrites_a_same_named_brief() {
        // A re-staged generation must leave exactly one brief on disk — the
        // current one, not an append of both.
        let dir = tempdir().unwrap();
        let worktree = dir.path();
        write_brief(worktree, "gen-2-ritual", "first").unwrap();
        let relpath = write_brief(worktree, "gen-2-ritual", "second").unwrap();
        assert_eq!(
            std::fs::read_to_string(worktree.join(&relpath)).unwrap(),
            "second"
        );
    }

    #[test]
    fn test_write_brief_reports_a_failed_write() {
        // `.maestro` occupied by a FILE: the directory cannot be created, and
        // the error must name the problem instead of panicking.
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".maestro"), "not a directory").unwrap();
        let err = write_brief(dir.path(), "gen-1-launch", "body").unwrap_err();
        assert!(err.contains("brief"), "unexpected: {err}");
    }

    #[test]
    fn test_write_brief_never_creates_the_worktree() {
        // A mistyped or unresolved worktree must fail loudly, not leave a
        // stray `.maestro/briefs` tree behind at a path nothing runs in.
        let dir = tempdir().unwrap();
        let missing = dir.path().join("no-such-worktree");
        let err = write_brief(&missing, "gen-1-launch", "body").unwrap_err();
        assert!(err.contains("does not exist"), "unexpected: {err}");
        assert!(!missing.exists(), "nothing was created");
    }

    #[test]
    fn test_write_brief_never_escapes_the_brief_directory() {
        // `name` crosses the Tauri IPC boundary (`terminal_arm_initial_prompt`
        // takes it as `brief_stem`), so a traversal, a separator, a drive
        // letter or an NTFS stream name must never reach the filesystem.
        let dir = tempdir().unwrap();
        let worktree = dir.path().join("checkout");
        std::fs::create_dir_all(&worktree).unwrap();
        let briefs = worktree.join(BRIEF_DIR);

        for name in [
            "../escaped",
            r"..\escaped",
            "../../escaped",
            "sub/dir",
            r"sub\dir",
            "C:/escaped",
            "stream:name",
            "PR-142-Check",
        ] {
            let relpath = write_brief(&worktree, name, "body").unwrap();
            assert!(
                relpath.starts_with(&format!("{BRIEF_DIR}/")),
                "{name} -> {relpath}"
            );
            assert!(!relpath.contains(".."), "{name} -> {relpath}");
            let written = worktree.join(&relpath);
            assert!(
                written.starts_with(&briefs),
                "{name} -> {}",
                written.display()
            );
            assert!(written.is_file(), "{name} -> {}", written.display());
        }
        // Uppercase is slugged, not passed through.
        assert!(briefs.join("pr-142-check.md").is_file());
        // Nothing landed beside or above the brief directory.
        assert!(!dir.path().join("escaped.md").exists());
        assert!(!worktree.join("escaped.md").exists());
        assert!(!worktree.join(".maestro/escaped.md").exists());
    }

    #[test]
    fn test_write_brief_refuses_a_name_with_no_usable_characters() {
        // Refused outright rather than silently renamed: a caller that names
        // no file has a bug, and the fallback (typing the text inline) is a
        // working delivery.
        let dir = tempdir().unwrap();
        for name in ["", ".", "..", "   ", "///", "./..", "..."] {
            let err = write_brief(dir.path(), name, "body").unwrap_err();
            assert!(err.contains("brief name"), "{name:?}: {err}");
        }
        assert!(
            !dir.path().join(BRIEF_DIR).exists(),
            "a refused name creates nothing"
        );
    }

    #[test]
    fn test_a_long_name_is_bounded_so_the_pointer_still_fits_one_frame() {
        // THE #137 invariant: whatever the caller names the brief, what gets
        // typed is one frame. A PR stem grows with every ticked step, so an
        // unbounded name would splice the pointer itself.
        let dir = tempdir().unwrap();
        let names = [
            "x".repeat(MAX_STEM_CHARS + 1),
            format!("pr-142-{}", "check-the-review-comments-".repeat(20)),
            "y".repeat(4000),
        ];
        for name in names {
            let relpath = write_brief(dir.path(), &name, "body").unwrap();
            let pointer = pointer_instruction(&relpath);
            assert_eq!(
                chunk_frames(&pointer).len(),
                1,
                "{} bytes: {pointer}",
                pointer.len()
            );
            assert!(dir.path().join(&relpath).is_file(), "{relpath}");
        }
        // And the bound itself is pinned against a reworded pointer: the
        // longest stem write_brief will ever emit must still fit one frame.
        let longest =
            pointer_instruction(&format!("{BRIEF_DIR}/{}.md", "x".repeat(MAX_STEM_CHARS)));
        assert!(longest.len() < CHUNK_BYTES, "{} bytes", longest.len());
    }

    #[test]
    fn test_bounded_names_stay_distinct_and_stable() {
        // Truncation carries a hash of the FULL name, so two long stems that
        // share a prefix cannot overwrite each other's brief, and the same
        // name always resolves to the same file.
        let dir = tempdir().unwrap();
        let prefix = "pr-142-".to_string() + &"check-review-".repeat(10);
        let alpha = write_brief(dir.path(), &format!("{prefix}alpha"), "a").unwrap();
        let beta = write_brief(dir.path(), &format!("{prefix}beta"), "b").unwrap();
        assert_ne!(alpha, beta);
        assert_eq!(
            write_brief(dir.path(), &format!("{prefix}alpha"), "again").unwrap(),
            alpha,
            "the same name resolves to the same brief"
        );
    }

    #[test]
    fn test_a_brief_in_a_git_checkout_is_excluded_repo_locally() {
        // The PR-review path writes into the USER's own checkout, so without
        // this every review leaves untracked noise in `git status` — sweepable
        // into a commit by any agent running `git add -A`.
        let dir = tempdir().unwrap();
        let repo = dir.path();
        std::fs::create_dir_all(repo.join(".git")).unwrap();

        write_brief(repo, "pr-142-check", "body").unwrap();

        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert!(
            exclude.lines().any(|l| l.trim() == ".maestro/"),
            "unexpected exclude: {exclude}"
        );
        // The tracked `.gitignore` the user owns is never touched.
        assert!(!repo.join(".gitignore").exists());
    }

    #[test]
    fn test_the_exclude_entry_is_appended_once_and_keeps_the_users_rules() {
        let dir = tempdir().unwrap();
        let repo = dir.path();
        std::fs::create_dir_all(repo.join(".git/info")).unwrap();
        std::fs::write(repo.join(".git/info/exclude"), "# user rules\n*.local").unwrap();

        write_brief(repo, "pr-142-check", "body").unwrap();
        write_brief(repo, "pr-142-check-review", "body").unwrap();

        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert_eq!(
            exclude.lines().filter(|l| l.trim() == ".maestro/").count(),
            1,
            "appended twice: {exclude}"
        );
        assert!(exclude.contains("*.local"), "user rules survive: {exclude}");
    }

    #[test]
    fn test_a_brief_outside_a_plain_git_checkout_touches_no_exclude() {
        // No `.git` at all: nothing to exclude, and the brief still lands.
        let dir = tempdir().unwrap();
        write_brief(dir.path(), "gen-1-launch", "body").unwrap();
        assert!(!dir.path().join(".git").exists());
        assert!(dir.path().join(".maestro/briefs/gen-1-launch.md").is_file());

        // A `git worktree` checkout has `.git` as a FILE pointing at the parent
        // repo — the exclude is not ours to edit from here, so it is left
        // exactly as it was.
        let worktree = dir.path().join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        let gitfile = "gitdir: ../.git/worktrees/wt\n";
        std::fs::write(worktree.join(".git"), gitfile).unwrap();

        write_brief(&worktree, "gen-1-launch", "body").unwrap();

        assert_eq!(
            std::fs::read_to_string(worktree.join(".git")).unwrap(),
            gitfile,
            "the .git file is untouched"
        );
        assert!(worktree.join(".maestro/briefs/gen-1-launch.md").is_file());
    }

    #[test]
    fn test_the_brief_is_moved_into_place_leaving_no_temp_file() {
        // Written to a temp name and renamed over, so an agent reading the
        // brief never sees a truncated file — and no `.tmp` litters the
        // Second Brain's inventory.
        let dir = tempdir().unwrap();
        write_brief(dir.path(), "gen-1-launch", "first").unwrap();
        write_brief(dir.path(), "gen-1-launch", "second").unwrap();

        let mut names: Vec<String> = std::fs::read_dir(dir.path().join(BRIEF_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["gen-1-launch.md".to_string()]);
    }

    #[test]
    fn test_pointer_is_one_frame_of_plain_text() {
        // The whole point of the file: what gets typed must fit in a SINGLE
        // PTY frame, so no chunk boundary can splice it.
        let pointer = pointer_instruction(".maestro/briefs/gen-11-recovery.md");
        assert!(!pointer.contains('\r'), "a \\r submits it half-typed");
        assert!(!pointer.contains('\n'), "still a single pasteable line");
        assert!(
            pointer.len() < CHUNK_BYTES,
            "pointer must fit one frame, got {} bytes: {pointer}",
            pointer.len()
        );
        assert_eq!(chunk_frames(&pointer), [pointer.as_str()]);
        assert!(pointer.contains(".maestro/briefs/gen-11-recovery.md"));
        // It must send the agent to READ the file, in full, first.
        assert!(pointer.contains("Read"), "{pointer}");
        assert!(pointer.contains("FULL"), "{pointer}");
    }

    /// Issue #204: the receipt is matched on the brief's file NAME, so a
    /// pointer has to give it back — and nothing else may claim to be one.
    #[test]
    fn test_the_brief_file_name_comes_back_out_of_its_own_pointer() {
        assert_eq!(
            pointer_brief_file_name(&pointer_instruction(
                ".maestro/briefs/epic-9-gen-3-ritual.md"
            )),
            Some("epic-9-gen-3-ritual.md".to_string())
        );
        // A real staged brief, so the round trip is against what is on disk.
        let dir = tempdir().unwrap();
        let pointer =
            deliverable_instruction(dir.path(), "epic-9-gen-1-launch", long_instruction());
        assert_eq!(
            pointer_brief_file_name(&pointer),
            Some("epic-9-gen-1-launch.md".to_string())
        );
        // Not pointers: an inline instruction, prose with backquotes, a
        // pointer at something that is not a brief, a nested path.
        for other in [
            long_instruction(),
            "[Maestro Samurai] run `npm test` and report back".to_string(),
            pointer_instruction("docs/samurai/prd.md"),
            pointer_instruction(&format!("{BRIEF_DIR}/old/epic-9-gen-3-ritual.md")),
            pointer_instruction(&format!("{BRIEF_DIR}/epic-9-gen-3-ritual")),
        ] {
            assert_eq!(pointer_brief_file_name(&other), None, "{other}");
        }
    }

    #[test]
    fn test_short_instructions_stay_inline_and_write_no_file() {
        // The handoff/park/wind-down path is untouched: today's delivery
        // works and must not grow an unread-file failure mode.
        let dir = tempdir().unwrap();
        let short = "[Maestro Samurai] ".to_string() + &"x".repeat(INLINE_MAX_BYTES - 18);
        assert_eq!(short.len(), INLINE_MAX_BYTES);
        // The predicate callers gate on is the same rule this function
        // applies — the boundary byte is inline for both or for neither.
        assert!(is_inline(&short));

        let staged = deliverable_instruction(dir.path(), "gen-1-launch", short.clone());

        assert_eq!(staged, short);
        assert!(!dir.path().join(BRIEF_DIR).exists(), "no brief written");
    }

    #[test]
    fn test_long_instructions_become_a_pointer_at_a_verbatim_brief() {
        let dir = tempdir().unwrap();
        let instruction = long_instruction();
        assert!(instruction.len() > INLINE_MAX_BYTES);
        assert!(!is_inline(&instruction));

        let staged = deliverable_instruction(dir.path(), "gen-1-launch", instruction.clone());

        assert_eq!(
            staged,
            pointer_instruction(".maestro/briefs/gen-1-launch.md")
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".maestro/briefs/gen-1-launch.md")).unwrap(),
            instruction,
            "the brief on disk is the instruction, byte for byte"
        );
    }

    #[test]
    fn test_try_deliverable_instruction_reports_each_route_distinctly() {
        // Issue #154: a caller that sized its payload for the FILE route
        // must be able to tell "written, here is the pointer" from "the
        // write failed" — the infallible wrapper collapses both into a
        // string it would then type.
        let short_dir = tempdir().unwrap();
        let short = "[Maestro Samurai] ".to_string() + &"x".repeat(INLINE_MAX_BYTES - 18);
        assert_eq!(short.len(), INLINE_MAX_BYTES);
        assert_eq!(
            try_deliverable_instruction(short_dir.path(), "gen-1-launch", &short).unwrap(),
            None,
            "under the budget: nothing to write, keep the instruction"
        );
        assert!(
            !short_dir.path().join(BRIEF_DIR).exists(),
            "no brief written"
        );

        let written_dir = tempdir().unwrap();
        let instruction = long_instruction();
        assert_eq!(
            try_deliverable_instruction(written_dir.path(), "gen-1-launch", &instruction).unwrap(),
            Some(pointer_instruction(".maestro/briefs/gen-1-launch.md"))
        );

        let failing_dir = tempdir().unwrap();
        std::fs::write(failing_dir.path().join(".maestro"), "not a directory").unwrap();
        assert!(
            try_deliverable_instruction(failing_dir.path(), "gen-1-launch", &instruction).is_err(),
            "a failed write is an Err here, never the full text"
        );
    }

    #[test]
    fn test_a_failed_brief_write_falls_back_to_the_full_text() {
        // No new failure mode: if the file cannot be written, the agent gets
        // exactly what it got before this module existed.
        //
        // #137 c6 also asks for a logged warning. That half is pinned by code
        // review only — `deliverable_instruction` emits `log::warn!` and
        // nothing here asserts it, because capturing `log` output needs a
        // process-global logger that would race every other test.
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join(".maestro"), "not a directory").unwrap();
        let instruction = long_instruction();

        let staged = deliverable_instruction(dir.path(), "gen-1-launch", instruction.clone());

        assert_eq!(staged, instruction);
    }

    #[test]
    fn test_launch_line_safe_accepts_a_pointer_and_refuses_what_must_stay_typed() {
        // Issue #158: only a payload that fits one shell command line may
        // ride the `claude` launch line.
        let dir = tempdir().unwrap();
        let relpath = write_brief(dir.path(), "epic-38-gen-1-launch", "body").unwrap();
        let pointer = pointer_instruction(&relpath);
        assert!(
            launch_line_safe(&pointer),
            "the pointer is what this is for"
        );

        // A brief-write failure falls back to the FULL instruction — multi-KB
        // and exactly the payload #137 took off the wire. It must not silently
        // become a launch-line argument.
        assert!(!launch_line_safe(&long_instruction()));
        // A newline would submit the command half-typed.
        assert!(!launch_line_safe("[Maestro Samurai] Read this\nand that"));
        assert!(!launch_line_safe("[Maestro Samurai] Read this\rand that"));
        // A short single-line instruction is fine — it is one frame either way.
        assert!(launch_line_safe("[Maestro Samurai] Hand off now."));
    }
}
