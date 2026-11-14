//! The list of terminals open right now (issue #608, crash recovery), kept in
//! Maestro's own app data (`<data dir>/open-terminals/open-terminals.json`),
//! never in a project.
//!
//! The front end saves the list whenever a terminal opens, closes, is renamed,
//! pinned, parked, or starts a new Claude conversation. Every normal close of
//! the main window removes the file, so a file found on the next start means
//! Maestro stopped without one: a crash, running out of memory, a power cut,
//! the computer shutting down or a kill from Task Manager. The start-up offer
//! reads it back from here.
//!
//! Closing to install an update (issue #609) marks the list "after update"
//! instead of removing it: the next start brings every terminal back with no
//! dialog. Reading a marked list removes the mark at once, so the terminals
//! come back unasked only once; a mark that is not exactly `true` is no mark,
//! and that list is offered with the dialog as usual.
//!
//! The file is read back as untrusted: a missing, damaged or oversized file is
//! "no list" (never a start-up failure), an entry that does not have the
//! expected shape is skipped, a terminal on a conversation an earlier entry
//! already has is skipped (one conversation never comes back twice), and every
//! text is cut to a short length. Writes go through a temp file, an fsync and
//! a rename, so a crash or power cut never leaves a half-written list.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::ai_runner::artifact_base_dir;
use crate::commands::claude_sessions::claude_projects_root;
use crate::core::atomic_write::atomic_write_durable;
use crate::core::session_manager::AiMode;

/// File name inside the app-data folder.
const FILE_NAME: &str = "open-terminals.json";
/// Version written into the file, for a later change of shape.
const FILE_VERSION: u32 = 1;
/// A file larger than this is not read at all (it cannot be ours).
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// The most terminals kept; more than this cannot be a real list.
const MAX_TERMINALS: usize = 200;
/// Longest path kept, in characters.
const MAX_PATH_CHARS: usize = 4096;
/// Longest terminal name or branch kept, in characters.
const MAX_NAME_CHARS: usize = 200;
/// Longest Claude conversation id kept (a UUID is 36).
const MAX_CONVERSATION_ID_CHARS: usize = 64;

/// One open terminal, as the front end describes it. The array order is the
/// order the terminals had in their project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTerminal {
    /// The project (workspace tab) the terminal belongs to.
    pub project_path: String,
    /// The terminal's title; `None` when it never had one.
    #[serde(default)]
    pub name: Option<String>,
    /// Claude or a plain shell.
    pub kind: AiMode,
    /// The folder the terminal ran in (the project, or a worktree).
    pub working_directory: String,
    /// The branch shown in its header, when it ran in a worktree.
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub parked: bool,
    /// Whether a Samurai run owns it (never offered; counted only).
    #[serde(default)]
    pub samurai: bool,
    /// The Claude conversation it was on, from the SessionStart hook.
    #[serde(default)]
    pub conversation_id: Option<String>,
}

/// A terminal from the list found at start-up, with what is still on disk.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferedTerminal {
    #[serde(flatten)]
    pub terminal: OpenTerminal,
    /// Whether the folder it ran in still exists.
    pub folder_exists: bool,
    /// Whether its Claude conversation can still be resumed.
    pub conversation_found: bool,
}

/// The list found at start-up: when it was last saved and what it held.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTerminalsOffer {
    /// Epoch milliseconds of the last save, the closest record of the stop.
    pub saved_at: i64,
    /// Maestro closed to install an update: bring everything back unasked.
    pub after_update: bool,
    pub terminals: Vec<OfferedTerminal>,
}

/// What the file holds.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListFile<'a> {
    version: u32,
    saved_at: i64,
    /// Written by the update install; see the module notes.
    after_update: bool,
    terminals: &'a [OpenTerminal],
}

/// The list as read back from the file.
struct ParsedList {
    saved_at: i64,
    after_update: bool,
    terminals: Vec<OpenTerminal>,
}

/// `text` cut to at most `max` characters, on a character boundary.
fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// A trimmed, cut optional text; empty becomes `None`.
fn cut_optional(text: Option<String>, max: usize) -> Option<String> {
    text.map(|t| cut(t.trim(), max)).filter(|t| !t.is_empty())
}

/// Whether `id` can be handed to `claude --resume`: hex digits and dashes
/// only, the same rule the front end applies before it builds the command.
fn is_safe_conversation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CONVERSATION_ID_CHARS
        && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

impl OpenTerminal {
    /// Cuts every text to its limit and drops an unsafe conversation id;
    /// `None` when the entry names no project or folder.
    fn sanitized(mut self) -> Option<Self> {
        self.project_path = cut(self.project_path.trim(), MAX_PATH_CHARS);
        self.working_directory = cut(self.working_directory.trim(), MAX_PATH_CHARS);
        if self.project_path.is_empty() || self.working_directory.is_empty() {
            return None;
        }
        self.name = cut_optional(self.name, MAX_NAME_CHARS);
        self.branch = cut_optional(self.branch, MAX_NAME_CHARS);
        self.conversation_id = self
            .conversation_id
            .map(|id| id.trim().to_string())
            .filter(|id| is_safe_conversation_id(id));
        Some(self)
    }
}

/// Reads the terminals out of the file's text, skipping anything that is not
/// a usable entry and every terminal on an already-listed conversation.
/// `None` when the text is not a list file at all.
fn parse_list(text: &str) -> Option<ParsedList> {
    let value = serde_json::from_str::<Value>(text).ok()?;
    let Some(Value::Array(raw)) = value.get("terminals") else {
        return None;
    };
    let saved_at = value.get("savedAt").and_then(Value::as_i64).unwrap_or(0);
    let after_update = value.get("afterUpdate") == Some(&Value::Bool(true));
    let mut seen_conversations = HashSet::new();
    let terminals = raw
        .iter()
        .filter_map(|v| serde_json::from_value::<OpenTerminal>(v.clone()).ok())
        .filter_map(OpenTerminal::sanitized)
        .filter(|t| match &t.conversation_id {
            Some(id) => seen_conversations.insert(id.to_ascii_lowercase()),
            None => true,
        })
        .take(MAX_TERMINALS)
        .collect();
    Some(ParsedList {
        saved_at,
        after_update,
        terminals,
    })
}

/// Whether `terminal`'s Claude conversation can still be resumed: Claude
/// Code keeps each one as `<claude_root>/<encoded folder>/<id>.jsonl`, so
/// the transcript is looked for in every folder under the root.
fn conversation_found(terminal: &OpenTerminal, claude_root: Option<&Path>) -> bool {
    if !matches!(terminal.kind, AiMode::Claude) {
        return false;
    }
    let (Some(id), Some(root)) = (&terminal.conversation_id, claude_root) else {
        return false;
    };
    let Ok(folders) = std::fs::read_dir(root) else {
        return false;
    };
    let file_name = format!("{id}.jsonl");
    folders
        .flatten()
        .any(|folder| folder.path().join(&file_name).is_file())
}

/// The saved list of open terminals at one path. The app uses one instance
/// over its app-data file ([`STORE`]); tests use their own over a temp dir.
pub struct OpenTerminalsStore {
    path: PathBuf,
    /// Also serialises saves against removals.
    state: Mutex<StoreState>,
}

#[derive(Default)]
struct StoreState {
    /// True once a normal close has started: the list is gone and every later
    /// save is ignored, so a terminal closing during the quit cannot write the
    /// list back.
    closed: bool,
    /// True once this run has saved its own list. The file then describes
    /// the terminals open now, not a stop, so a reload of the window must not
    /// offer them.
    saved_this_run: bool,
    /// True once the list is marked for an update: a normal close keeps it.
    marked_for_update: bool,
}

impl OpenTerminalsStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(StoreState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StoreState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replaces the saved list with `terminals` (sanitised), stamped
    /// `now_ms`. Does nothing once a normal close has started. Blocking.
    pub fn save(&self, terminals: Vec<OpenTerminal>, now_ms: i64) -> Result<(), String> {
        let mut state = self.lock();
        if state.closed {
            return Ok(());
        }
        state.saved_this_run = true;
        let terminals: Vec<OpenTerminal> = terminals
            .into_iter()
            .filter_map(OpenTerminal::sanitized)
            .take(MAX_TERMINALS)
            .collect();
        self.write(now_ms, false, &terminals)
    }

    /// Writes the file. The caller holds the lock.
    fn write(
        &self,
        saved_at: i64,
        after_update: bool,
        terminals: &[OpenTerminal],
    ) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("failed to create {dir:?}: {e}"))?;
        }
        let file = ListFile {
            version: FILE_VERSION,
            saved_at,
            after_update,
            terminals,
        };
        let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
        atomic_write_durable(&self.path, &json)
    }

    /// Maestro is about to close to install an update: marks this run's list
    /// "after update" and ignores every later save, so the terminals being
    /// shut down cannot shrink it. A list this run never saved (one still
    /// waiting for its start-up answer) is left unmarked. Blocking.
    pub fn mark_for_update(&self) -> Result<(), String> {
        let mut state = self.lock();
        state.closed = true;
        if !state.saved_this_run {
            return Ok(());
        }
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                return Err(format!(
                    "could not read open-terminals list {:?}: {e}",
                    self.path
                ))
            }
        };
        let list = parse_list(&text)
            .ok_or_else(|| format!("open-terminals list {:?} is damaged", self.path))?;
        self.write(list.saved_at, true, &list.terminals)?;
        state.marked_for_update = true;
        Ok(())
    }

    /// The list a previous run left behind, or `None` when there is none,
    /// it cannot be read, or this run has already saved its own. Conversations
    /// are looked up under `claude_root` (Claude Code's projects folder).
    /// Changes the file only to remove an "after update" mark; when that
    /// fails the list comes back unmarked, so it is asked about rather than
    /// restored unasked a second time. Blocking.
    pub fn load_offer(&self, claude_root: Option<&Path>) -> Option<OpenTerminalsOffer> {
        let state = self.lock();
        if state.saved_this_run {
            return None;
        }
        match std::fs::metadata(&self.path) {
            Ok(meta) if meta.len() > MAX_FILE_BYTES => {
                log::warn!(
                    "open-terminals list {:?} is too large; ignoring it",
                    self.path
                );
                return None;
            }
            Ok(_) => {}
            Err(_) => return None,
        }
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) => {
                log::warn!("could not read open-terminals list {:?}: {e}", self.path);
                return None;
            }
        };
        let Some(list) = parse_list(&text) else {
            log::warn!(
                "open-terminals list {:?} is damaged; ignoring it",
                self.path
            );
            return None;
        };
        let after_update = list.after_update && self.remove_update_mark(&list);
        drop(state);
        let terminals = list
            .terminals
            .into_iter()
            .map(|terminal| OfferedTerminal {
                folder_exists: Path::new(&terminal.working_directory).is_dir(),
                conversation_found: conversation_found(&terminal, claude_root),
                terminal,
            })
            .collect();
        Some(OpenTerminalsOffer {
            saved_at: list.saved_at,
            after_update,
            terminals,
        })
    }

    /// Writes `list` back without its "after update" mark; false when that
    /// fails. The caller holds the lock.
    fn remove_update_mark(&self, list: &ParsedList) -> bool {
        match self.write(list.saved_at, false, &list.terminals) {
            Ok(()) => true,
            Err(e) => {
                log::warn!("could not remove the update mark from the open-terminals list: {e}");
                false
            }
        }
    }

    /// Removes the saved list (the offer was answered). Blocking.
    pub fn clear(&self) -> Result<(), String> {
        let _state = self.lock();
        self.remove_file()
    }

    /// A normal close has started: remove the list and ignore later saves.
    /// A list marked for an update is kept for the start after it.
    pub fn forget_on_normal_close(&self) {
        let mut state = self.lock();
        state.closed = true;
        if state.marked_for_update {
            return;
        }
        if let Err(e) = self.remove_file() {
            log::warn!("{e}");
        }
    }

    /// The close did not happen after all: saves are accepted again, and
    /// the front end's next save writes the list back.
    pub fn reopen_after_failed_close(&self) {
        self.lock().closed = false;
    }

    fn remove_file(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!(
                "could not remove open-terminals list {:?}: {e}",
                self.path
            )),
        }
    }
}

/// The app's one list, in its app data.
static STORE: LazyLock<OpenTerminalsStore> =
    LazyLock::new(|| OpenTerminalsStore::new(artifact_base_dir("open-terminals").join(FILE_NAME)));

/// Called by every normal close of the main window (see `lib.rs`).
pub fn forget_on_normal_close() {
    STORE.forget_on_normal_close();
}

/// Called by the update install right before Maestro closes for it.
pub fn mark_for_update() {
    if let Err(e) = STORE.mark_for_update() {
        log::warn!("could not mark the open-terminals list for the update: {e}");
    }
}

/// Called when a committed close failed and the app keeps running.
pub fn reopen_after_failed_close() {
    STORE.reopen_after_failed_close();
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Runs blocking file work off the async runtime.
async fn blocking<T: Send + 'static>(
    op: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(op)
        .await
        .map_err(|e| format!("open-terminals task failed: {e}"))?
}

/// Saves the list of terminals open right now.
#[tauri::command]
pub async fn open_terminals_save(terminals: Vec<OpenTerminal>) -> Result<(), String> {
    blocking(move || STORE.save(terminals, now_ms())).await
}

/// The list a previous run left behind (an unexpected stop), or `None`.
#[tauri::command]
pub async fn open_terminals_load() -> Result<Option<OpenTerminalsOffer>, String> {
    blocking(|| Ok(STORE.load_offer(claude_projects_root().as_deref()))).await
}

/// Removes the saved list once the start-up offer is answered.
#[tauri::command]
pub async fn open_terminals_clear() -> Result<(), String> {
    blocking(|| STORE.clear()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;
    const CONVERSATION: &str = "0b5e6a4c-1d2f-4e3a-9b8c-7d6e5f4a3b2c";

    fn terminal(project: &str, name: &str, kind: AiMode, dir: &Path) -> OpenTerminal {
        OpenTerminal {
            project_path: project.to_string(),
            name: Some(name.to_string()),
            kind,
            working_directory: dir.to_string_lossy().to_string(),
            branch: None,
            pinned: false,
            parked: false,
            samurai: false,
            conversation_id: None,
        }
    }

    fn temp_store() -> (tempfile::TempDir, OpenTerminalsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = OpenTerminalsStore::new(dir.path().join("nested").join(FILE_NAME));
        (dir, store)
    }

    /// The made-up Claude projects folder inside a test's temp dir.
    fn claude_root(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("claude-projects")
    }

    /// Puts a transcript for `id` under the test's Claude projects folder.
    fn write_transcript(dir: &tempfile::TempDir, id: &str) {
        let folder = claude_root(dir).join("C--work-shop");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(format!("{id}.jsonl")), "{}\n").unwrap();
    }

    /// What the next start finds: a new store (a new run) over the same file.
    fn load(store: &OpenTerminalsStore, dir: &tempfile::TempDir) -> Option<OpenTerminalsOffer> {
        OpenTerminalsStore::new(store.path.clone()).load_offer(Some(&claude_root(dir)))
    }

    fn offered(store: &OpenTerminalsStore, dir: &tempfile::TempDir) -> Vec<OfferedTerminal> {
        load(store, dir).expect("a list").terminals
    }

    #[test]
    fn a_saved_list_comes_back_in_order_with_every_field_and_what_is_on_disk() {
        let (dir, store) = temp_store();
        write_transcript(&dir, CONVERSATION);
        let mut claude = terminal("/p/shop", "checkout-fix", AiMode::Claude, dir.path());
        claude.pinned = true;
        claude.branch = Some("feat/checkout".to_string());
        claude.conversation_id = Some(CONVERSATION.to_string());
        let mut shell = terminal("/p/shop", "dev server", AiMode::Plain, dir.path());
        shell.parked = true;
        let gone = terminal(
            "/p/docs",
            "old",
            AiMode::Claude,
            &dir.path().join("deleted"),
        );

        store
            .save(vec![claude.clone(), shell.clone(), gone.clone()], NOW)
            .unwrap();
        let offer = load(&store, &dir).unwrap();

        assert_eq!(offer.saved_at, NOW);
        assert_eq!(
            offer.terminals,
            vec![
                OfferedTerminal {
                    terminal: claude,
                    folder_exists: true,
                    conversation_found: true
                },
                OfferedTerminal {
                    terminal: shell,
                    folder_exists: true,
                    conversation_found: false
                },
                OfferedTerminal {
                    terminal: gone,
                    folder_exists: false,
                    conversation_found: false
                },
            ]
        );
    }

    #[test]
    fn writes_the_shape_the_front_end_reads() {
        let (dir, store) = temp_store();
        let mut shell = terminal("/p/shop", "dev server", AiMode::Plain, dir.path());
        shell.samurai = true;
        store.save(vec![shell], NOW).unwrap();
        let saved: Value =
            serde_json::from_str(&std::fs::read_to_string(&store.path).unwrap()).unwrap();

        assert_eq!(saved["version"], json!(1));
        assert_eq!(saved["savedAt"], json!(NOW));
        assert_eq!(saved["afterUpdate"], json!(false));
        assert_eq!(
            saved["terminals"][0],
            json!({
                "projectPath": "/p/shop",
                "name": "dev server",
                "kind": "Plain",
                "workingDirectory": dir.path().to_string_lossy(),
                "branch": null,
                "pinned": false,
                "parked": false,
                "samurai": true,
                "conversationId": null
            })
        );
    }

    #[test]
    fn a_conversation_is_not_found_without_an_id_or_a_transcript() {
        let (dir, store) = temp_store();
        let other = "11111111-2222-3333-4444-555555555555";
        write_transcript(&dir, other);
        for id in [None, Some(CONVERSATION)] {
            let mut claude = terminal("/p/shop", "a", AiMode::Claude, dir.path());
            claude.conversation_id = id.map(str::to_string);
            store.save(vec![claude], NOW).unwrap();
            assert!(!offered(&store, &dir)[0].conversation_found, "{id:?}");
        }
        // No Claude folder at all: nothing is found.
        let mut claude = terminal("/p/shop", "a", AiMode::Claude, dir.path());
        claude.conversation_id = Some(other.to_string());
        store.save(vec![claude], NOW).unwrap();
        let next_run = OpenTerminalsStore::new(store.path.clone());
        assert!(!next_run.load_offer(None).unwrap().terminals[0].conversation_found);
        // A plain shell never has a conversation, whatever the list says.
        let mut shell = terminal("/p/shop", "s", AiMode::Plain, dir.path());
        shell.conversation_id = Some(other.to_string());
        store.save(vec![shell], NOW).unwrap();
        assert!(!offered(&store, &dir)[0].conversation_found);
    }

    #[test]
    fn no_list_on_a_first_start_or_after_a_damaged_file() {
        let (dir, store) = temp_store();
        assert_eq!(load(&store, &dir), None, "first start");

        std::fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        for damaged in ["", "not json", "{\"terminals\": 3}", "[1, 2]", "null"] {
            std::fs::write(&store.path, damaged).unwrap();
            assert_eq!(load(&store, &dir), None, "{damaged:?}");
        }
    }

    #[test]
    fn an_oversized_file_is_not_read() {
        let (dir, store) = temp_store();
        std::fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        let padding = " ".repeat(MAX_FILE_BYTES as usize + 1);
        std::fs::write(&store.path, format!("{{\"terminals\": []}}{padding}")).unwrap();
        assert_eq!(load(&store, &dir), None);
    }

    #[test]
    fn malformed_entries_are_skipped_and_the_rest_kept() {
        let (dir, store) = temp_store();
        let good = json!({
            "projectPath": "/p/shop",
            "kind": "Claude",
            "workingDirectory": dir.path().to_string_lossy(),
        });
        std::fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        let file = json!({
            "version": 1,
            "savedAt": NOW,
            "terminals": [
                null,
                3,
                {"projectPath": "/p/shop"},
                {"projectPath": "/p/shop", "kind": "Gemini", "workingDirectory": "/x"},
                {"projectPath": "  ", "kind": "Plain", "workingDirectory": "/x"},
                {"projectPath": null, "kind": "Plain", "workingDirectory": "/x"},
                good,
            ]
        });
        std::fs::write(&store.path, file.to_string()).unwrap();

        let terminals = offered(&store, &dir);
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0].terminal.project_path, "/p/shop");
        assert_eq!(terminals[0].terminal.name, None);
        assert!(!terminals[0].terminal.pinned);
    }

    #[test]
    fn an_unsafe_conversation_id_is_dropped_and_a_repeated_one_keeps_its_first_terminal() {
        let (dir, store) = temp_store();
        let mut first = terminal("/p/shop", "first", AiMode::Claude, dir.path());
        first.conversation_id = Some(CONVERSATION.to_string());
        let mut repeat = terminal("/p/shop", "repeat", AiMode::Claude, dir.path());
        repeat.conversation_id = Some(CONVERSATION.to_uppercase());
        let mut unsafe_ids = Vec::new();
        let bad_ids = [
            "abc; rm -rf /".to_string(),
            "a b".to_string(),
            "x".repeat(10),
            "f".repeat(65),
            String::new(),
        ];
        for bad in bad_ids {
            let mut t = terminal("/p/shop", "unsafe", AiMode::Claude, dir.path());
            t.conversation_id = Some(bad);
            unsafe_ids.push(t);
        }
        let mut list = vec![first, repeat];
        list.extend(unsafe_ids);
        store.save(list, NOW).unwrap();

        let terminals = offered(&store, &dir);
        let names: Vec<_> = terminals
            .iter()
            .map(|t| t.terminal.name.clone().unwrap())
            .collect();
        assert_eq!(
            names,
            ["first", "unsafe", "unsafe", "unsafe", "unsafe", "unsafe"]
        );
        for t in &terminals[1..] {
            assert_eq!(t.terminal.conversation_id, None);
        }
    }

    #[test]
    fn long_texts_are_cut_and_the_list_is_capped() {
        let (dir, store) = temp_store();
        let mut long = terminal("/p/shop", &"n".repeat(500), AiMode::Plain, dir.path());
        long.branch = Some("b".repeat(500));
        let list = vec![long; MAX_TERMINALS + 5];
        store.save(list, NOW).unwrap();

        let terminals = offered(&store, &dir);
        assert_eq!(terminals.len(), MAX_TERMINALS);
        assert_eq!(
            terminals[0].terminal.name.as_ref().unwrap().chars().count(),
            MAX_NAME_CHARS
        );
        assert_eq!(
            terminals[0]
                .terminal
                .branch
                .as_ref()
                .unwrap()
                .chars()
                .count(),
            MAX_NAME_CHARS
        );
    }

    #[test]
    fn clearing_removes_the_list_and_a_later_save_writes_a_new_one() {
        let (dir, store) = temp_store();
        store
            .save(
                vec![terminal("/p/shop", "a", AiMode::Plain, dir.path())],
                NOW,
            )
            .unwrap();
        store.clear().unwrap();
        assert_eq!(load(&store, &dir), None);
        store.clear().unwrap(); // clearing twice is fine

        store
            .save(
                vec![terminal("/p/shop", "b", AiMode::Plain, dir.path())],
                NOW,
            )
            .unwrap();
        assert_eq!(offered(&store, &dir).len(), 1);
    }

    /// The close button, Alt+F4 and taskbar close all reach the main window's
    /// CloseRequested handler, and the macOS Quit menu item is routed to it
    /// too; every one of them commits the quit through this one step.
    #[test]
    fn a_normal_close_removes_the_list_and_ignores_saves_made_during_the_quit() {
        let (dir, store) = temp_store();
        let open = vec![terminal("/p/shop", "a", AiMode::Plain, dir.path())];
        store.save(open.clone(), NOW).unwrap();

        store.forget_on_normal_close();
        assert_eq!(load(&store, &dir), None);
        // A terminal closing while the app quits re-saves the shrinking list.
        store.save(open.clone(), NOW + 1).unwrap();
        assert_eq!(load(&store, &dir), None, "the next start offers nothing");

        store.reopen_after_failed_close();
        store.save(open, NOW + 2).unwrap();
        assert_eq!(
            offered(&store, &dir).len(),
            1,
            "a failed close keeps saving"
        );
    }

    #[test]
    fn once_this_run_has_saved_a_reload_of_the_window_offers_nothing() {
        let (dir, store) = temp_store();
        store
            .save(
                vec![terminal("/p/shop", "a", AiMode::Plain, dir.path())],
                NOW,
            )
            .unwrap();
        let next_run = OpenTerminalsStore::new(store.path.clone());

        let first_load = next_run.load_offer(Some(&claude_root(&dir)));
        let reload_before_answer = next_run.load_offer(Some(&claude_root(&dir)));
        next_run.save(Vec::new(), NOW + 1).unwrap();
        let reload_after_saving = next_run.load_offer(Some(&claude_root(&dir)));

        assert!(first_load.is_some());
        assert_eq!(
            reload_before_answer, first_load,
            "still unanswered: offered again"
        );
        assert_eq!(reload_after_saving, None);
    }

    /// Issue #609: "Update and restart" closes Maestro through the update
    /// install, which marks the list instead of removing it.
    #[test]
    fn a_list_marked_for_the_update_comes_back_unasked_once_then_is_asked_about() {
        let (dir, store) = temp_store();
        let open = vec![
            terminal("/p/shop", "a", AiMode::Claude, dir.path()),
            terminal("/p/shop", "b", AiMode::Plain, dir.path()),
        ];
        store.save(open.clone(), NOW).unwrap();

        store.mark_for_update().unwrap();
        // The terminals are shut down for the install; the shrinking list
        // they save, and the close itself, leave the marked list alone.
        store.save(Vec::new(), NOW + 1).unwrap();
        store.forget_on_normal_close();

        let after_update = load(&store, &dir).expect("the marked list");
        assert!(after_update.after_update);
        assert_eq!(after_update.saved_at, NOW);
        let names: Vec<_> = after_update
            .terminals
            .iter()
            .map(|t| t.terminal.name.clone().unwrap())
            .collect();
        assert_eq!(names, ["a", "b"]);
        // Reading it removed the mark: a stop before the restore finished is
        // an ordinary unexpected stop, never a second unasked restore.
        let next = load(&store, &dir).expect("still a list");
        assert!(!next.after_update);
    }

    #[test]
    fn only_this_runs_own_list_is_marked() {
        let (dir, store) = temp_store();
        store
            .save(
                vec![terminal("/p/shop", "a", AiMode::Plain, dir.path())],
                NOW,
            )
            .unwrap();
        // A new run still showing the start-up offer for that list updates.
        let next_run = OpenTerminalsStore::new(store.path.clone());
        next_run.mark_for_update().unwrap();
        assert!(!load(&store, &dir).expect("the old list").after_update);

        // Nothing saved and nothing on disk: nothing to mark, no error.
        let (dir, store) = temp_store();
        store.mark_for_update().unwrap();
        assert_eq!(load(&store, &dir), None);
    }

    #[test]
    fn a_mark_that_is_not_exactly_true_is_no_mark() {
        let (dir, store) = temp_store();
        std::fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        let entry = json!({
            "projectPath": "/p/shop",
            "kind": "Plain",
            "workingDirectory": dir.path().to_string_lossy(),
        });
        for mark in [
            json!(false),
            json!("true"),
            json!(1),
            json!(null),
            json!({}),
            json!([true]),
        ] {
            let file =
                json!({"version": 1, "savedAt": NOW, "afterUpdate": mark, "terminals": [entry]});
            std::fs::write(&store.path, file.to_string()).unwrap();
            let offer = load(&store, &dir).expect("a list");
            assert!(!offer.after_update, "{mark}");
            assert_eq!(offer.terminals.len(), 1, "{mark}");
        }
        // A list written before the mark existed has no field at all.
        let file = json!({"version": 1, "savedAt": NOW, "terminals": [entry]});
        std::fs::write(&store.path, file.to_string()).unwrap();
        assert!(!load(&store, &dir).expect("a list").after_update);
    }
}
