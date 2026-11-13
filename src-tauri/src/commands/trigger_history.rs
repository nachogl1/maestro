//! The Triggers panel's History: one app-wide file in Maestro's app data
//! (`<data dir>/trigger-history/trigger-history.json`) that records every
//! trigger firing and the follow-up line written when a recipient's context
//! drops again. Never written inside a project or Claude Code's own
//! configuration.
//!
//! The file is read back as untrusted: a missing, damaged or oversized file
//! is an empty history, an entry that does not have the expected shape is
//! skipped, a repeated id keeps its first entry, and every text is cut to a
//! short length. Entries older than one week (or dated more than a day in
//! the future, so they could never age out) are dropped on every load and
//! save. Writes go through a temp file and a rename, so a crash never leaves
//! a half-written file.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::commands::ai_runner::artifact_base_dir;
use crate::core::atomic_write::atomic_write_durable;

/// File name inside the history folder.
const FILE_NAME: &str = "trigger-history.json";
/// Version written into the file, for a later change of shape.
const FILE_VERSION: u32 = 1;
/// How long an entry is kept: one week, in milliseconds.
pub const KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// An entry dated further ahead than this is treated as damaged.
const FUTURE_SLACK_MS: i64 = 24 * 60 * 60 * 1000;
/// A file larger than this is not read at all (it cannot be ours).
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// The newest entries kept when a week holds more than this.
const MAX_ENTRIES: usize = 2000;
/// Recipients kept per firing.
const MAX_RECIPIENTS: usize = 100;
/// Longest id, trigger name or terminal name kept, in characters.
const MAX_NAME_CHARS: usize = 120;
/// Longest message excerpt kept, in characters (the issue asks only for a
/// short excerpt, never the whole message).
pub const MAX_EXCERPT_CHARS: usize = 80;
/// Longest delivery error kept, in characters.
const MAX_ERROR_CHARS: usize = 300;
/// Highest percent kept.
const MAX_PERCENT: u32 = 100;

/// Serialises load-change-save cycles so two writes never lose each other.
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

/// One recipient of a firing and whether the text reached its terminal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerRecipient {
    pub name: String,
    pub delivered: bool,
    /// Why the send failed; only kept when `delivered` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One trigger firing, as it was at firing time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerFiringEntry {
    pub id: String,
    /// Epoch milliseconds.
    pub at: i64,
    pub trigger_id: String,
    pub trigger_name: String,
    /// The terminal that reached the threshold.
    pub terminal: String,
    /// The project that terminal belongs to.
    pub project: String,
    /// That terminal's context percent when it fired.
    pub percent: u32,
    /// The first words of the message.
    pub excerpt: String,
    pub recipients: Vec<TriggerRecipient>,
}

/// A recipient's context dropped below the threshold after a firing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerFollowUpEntry {
    pub id: String,
    /// Epoch milliseconds.
    pub at: i64,
    pub trigger_id: String,
    pub trigger_name: String,
    /// The recipient whose context dropped.
    pub terminal: String,
    pub project: String,
    /// Its context percent after the drop.
    pub percent: u32,
    /// The firing this follows.
    pub firing_id: String,
    pub firing_at: i64,
    /// The terminal that reached the threshold in that firing.
    pub fired_by: String,
}

/// One line of the history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TriggerHistoryEntry {
    Firing(TriggerFiringEntry),
    FollowUp(TriggerFollowUpEntry),
}

impl TriggerHistoryEntry {
    fn id(&self) -> &str {
        match self {
            TriggerHistoryEntry::Firing(e) => &e.id,
            TriggerHistoryEntry::FollowUp(e) => &e.id,
        }
    }

    fn at(&self) -> i64 {
        match self {
            TriggerHistoryEntry::Firing(e) => e.at,
            TriggerHistoryEntry::FollowUp(e) => e.at,
        }
    }

    /// Cuts every text to its limit and the percent to 100; `None` when the
    /// entry has no usable id or trigger id.
    fn sanitized(self) -> Option<Self> {
        let entry = match self {
            TriggerHistoryEntry::Firing(mut e) => {
                e.id = cut(&e.id, MAX_NAME_CHARS);
                e.trigger_id = cut(&e.trigger_id, MAX_NAME_CHARS);
                e.trigger_name = cut(&e.trigger_name, MAX_NAME_CHARS);
                e.terminal = cut(&e.terminal, MAX_NAME_CHARS);
                e.project = cut(&e.project, MAX_NAME_CHARS);
                e.percent = e.percent.min(MAX_PERCENT);
                e.excerpt = cut(&e.excerpt, MAX_EXCERPT_CHARS);
                e.recipients.truncate(MAX_RECIPIENTS);
                for r in &mut e.recipients {
                    r.name = cut(&r.name, MAX_NAME_CHARS);
                    r.error = if r.delivered {
                        None
                    } else {
                        r.error.as_deref().map(|err| cut(err, MAX_ERROR_CHARS))
                    };
                }
                if e.trigger_id.is_empty() {
                    return None;
                }
                TriggerHistoryEntry::Firing(e)
            }
            TriggerHistoryEntry::FollowUp(mut e) => {
                e.id = cut(&e.id, MAX_NAME_CHARS);
                e.trigger_id = cut(&e.trigger_id, MAX_NAME_CHARS);
                e.trigger_name = cut(&e.trigger_name, MAX_NAME_CHARS);
                e.terminal = cut(&e.terminal, MAX_NAME_CHARS);
                e.project = cut(&e.project, MAX_NAME_CHARS);
                e.percent = e.percent.min(MAX_PERCENT);
                e.firing_id = cut(&e.firing_id, MAX_NAME_CHARS);
                e.fired_by = cut(&e.fired_by, MAX_NAME_CHARS);
                if e.trigger_id.is_empty() {
                    return None;
                }
                TriggerHistoryEntry::FollowUp(e)
            }
        };
        (!entry.id().is_empty()).then_some(entry)
    }
}

/// What the file holds.
#[derive(Serialize)]
struct HistoryFile<'a> {
    version: u32,
    entries: &'a [TriggerHistoryEntry],
}

/// `text` cut to at most `max` characters, on a character boundary.
fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// `<data dir>/trigger-history/trigger-history.json`.
fn history_path() -> PathBuf {
    artifact_base_dir("trigger-history").join(FILE_NAME)
}

/// Whether `entry` is still inside the week before `now_ms`.
fn is_kept(entry: &TriggerHistoryEntry, now_ms: i64) -> bool {
    let at = entry.at();
    at >= now_ms - KEEP_MS && at <= now_ms + FUTURE_SLACK_MS
}

/// Drops entries outside the week and keeps the newest [`MAX_ENTRIES`],
/// oldest first.
fn prune(mut entries: Vec<TriggerHistoryEntry>, now_ms: i64) -> Vec<TriggerHistoryEntry> {
    entries.retain(|e| is_kept(e, now_ms));
    entries.sort_by_key(TriggerHistoryEntry::at);
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    entries
}

/// Reads the history entries out of the file's text, skipping anything that
/// is not a usable entry and every repeated id.
fn parse_history(text: &str) -> Vec<TriggerHistoryEntry> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(Value::Array(raw)) = value.get("entries") else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    raw.iter()
        .filter_map(|v| serde_json::from_value::<TriggerHistoryEntry>(v.clone()).ok())
        .filter_map(TriggerHistoryEntry::sanitized)
        .filter(|e| seen.insert(e.id().to_string()))
        .collect()
}

/// Loads the history at `path`, pruned against `now_ms`. Anything that
/// cannot be read is an empty history; the file is never changed here.
fn load_from(path: &Path, now_ms: i64) -> Vec<TriggerHistoryEntry> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_FILE_BYTES => {
            log::warn!("trigger history {path:?} is too large to read; ignoring it");
            return Vec::new();
        }
        Ok(_) => {}
        Err(_) => return Vec::new(),
    }
    match std::fs::read_to_string(path) {
        Ok(text) => prune(parse_history(&text), now_ms),
        Err(e) => {
            log::warn!("could not read trigger history {path:?}: {e}");
            Vec::new()
        }
    }
}

/// Writes `entries` to `path` atomically, creating its folder.
fn save_to(path: &Path, entries: &[TriggerHistoryEntry]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("failed to create {dir:?}: {e}"))?;
    }
    let file = HistoryFile {
        version: FILE_VERSION,
        entries,
    };
    let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    atomic_write_durable(path, &json)
}

/// Adds `entry` to the history at `path` (unless its id is already there),
/// pruning against `now_ms`. Blocking.
fn append_to(path: &Path, entry: TriggerHistoryEntry, now_ms: i64) -> Result<(), String> {
    let Some(entry) = entry.sanitized() else {
        return Err("Trigger history entry has no id".to_string());
    };
    let _guard = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_from(path, now_ms);
    if !entries.iter().any(|e| e.id() == entry.id()) {
        entries.push(entry);
    }
    save_to(path, &prune(entries, now_ms))
}

/// Empties the history at `path`. Blocking.
fn clear_at(path: &Path) -> Result<(), String> {
    let _guard = HISTORY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    save_to(path, &[])
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
        .map_err(|e| format!("trigger history task failed: {e}"))?
}

/// The last week of trigger history, oldest first.
#[tauri::command]
pub async fn load_trigger_history() -> Result<Vec<TriggerHistoryEntry>, String> {
    blocking(|| Ok(load_from(&history_path(), now_ms()))).await
}

/// Adds one firing or follow-up line to the history.
#[tauri::command]
pub async fn append_trigger_history(entry: TriggerHistoryEntry) -> Result<(), String> {
    blocking(move || append_to(&history_path(), entry, now_ms())).await
}

/// Empties the history (the panel's "Clear history" button).
#[tauri::command]
pub async fn clear_trigger_history() -> Result<(), String> {
    blocking(|| clear_at(&history_path())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_800_000_000_000;

    fn firing(id: &str, at: i64) -> TriggerHistoryEntry {
        TriggerHistoryEntry::Firing(TriggerFiringEntry {
            id: id.to_string(),
            at,
            trigger_id: "trigger-1".to_string(),
            trigger_name: "Compact reminder".to_string(),
            terminal: "api".to_string(),
            project: "shop".to_string(),
            percent: 81,
            excerpt: "Run /compact before you continue".to_string(),
            recipients: vec![
                TriggerRecipient {
                    name: "api".to_string(),
                    delivered: true,
                    error: None,
                },
                TriggerRecipient {
                    name: "docs".to_string(),
                    delivered: false,
                    error: Some("terminal closed".to_string()),
                },
            ],
        })
    }

    fn follow_up(id: &str, at: i64) -> TriggerHistoryEntry {
        TriggerHistoryEntry::FollowUp(TriggerFollowUpEntry {
            id: id.to_string(),
            at,
            trigger_id: "trigger-1".to_string(),
            trigger_name: "Compact reminder".to_string(),
            terminal: "api".to_string(),
            project: "shop".to_string(),
            percent: 22,
            firing_id: "f1".to_string(),
            firing_at: at - 1000,
            fired_by: "api".to_string(),
        })
    }

    fn temp_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);
        (dir, path)
    }

    #[test]
    fn a_firing_and_its_follow_up_survive_a_reload_with_every_field() {
        let (_dir, path) = temp_path();
        append_to(&path, firing("f1", NOW - 5000), NOW).unwrap();
        append_to(&path, follow_up("u1", NOW - 1000), NOW).unwrap();

        assert_eq!(
            load_from(&path, NOW),
            vec![firing("f1", NOW - 5000), follow_up("u1", NOW - 1000)]
        );
    }

    #[test]
    fn writes_the_shape_the_front_end_reads() {
        let (_dir, path) = temp_path();
        append_to(&path, firing("f1", NOW), NOW).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(saved["version"], json!(1));
        assert_eq!(
            saved["entries"][0],
            json!({
                "kind": "firing",
                "id": "f1",
                "at": NOW,
                "triggerId": "trigger-1",
                "triggerName": "Compact reminder",
                "terminal": "api",
                "project": "shop",
                "percent": 81,
                "excerpt": "Run /compact before you continue",
                "recipients": [
                    { "name": "api", "delivered": true },
                    { "name": "docs", "delivered": false, "error": "terminal closed" }
                ]
            })
        );
    }

    #[test]
    fn drops_entries_older_than_seven_days_or_dated_far_ahead() {
        let (_dir, path) = temp_path();
        let week_old = NOW - KEEP_MS;
        save_to(
            &path,
            &[
                firing("too-old", week_old - 1),
                firing("just-kept", week_old),
                firing("far-ahead", NOW + FUTURE_SLACK_MS + 1),
            ],
        )
        .unwrap();

        assert_eq!(load_from(&path, NOW), vec![firing("just-kept", week_old)]);

        // A save prunes the file itself too.
        append_to(&path, firing("new", NOW), NOW).unwrap();
        let ids: Vec<String> = load_from(&path, NOW)
            .iter()
            .map(|e| e.id().to_string())
            .collect();
        assert_eq!(ids, vec!["just-kept", "new"]);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("too-old") && !text.contains("far-ahead"));
    }

    #[test]
    fn a_missing_damaged_or_oversized_file_is_an_empty_history() {
        let (dir, path) = temp_path();
        assert!(load_from(&path, NOW).is_empty());

        for text in [
            "",
            "not json",
            "[]",
            "null",
            r#"{"entries": 5}"#,
            r#"{"version":1}"#,
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            assert!(load_from(&path, NOW).is_empty(), "{text:?}");
        }

        let big = dir.path().join("big.json");
        let padding = " ".repeat(MAX_FILE_BYTES as usize + 1);
        let entries = serde_json::to_string(&[firing("f1", NOW)]).unwrap();
        std::fs::write(&big, format!("{{\"entries\":{entries}{padding}}}")).unwrap();
        assert!(load_from(&big, NOW).is_empty());
    }

    #[test]
    fn skips_malformed_entries_and_keeps_the_first_of_a_repeated_id() {
        let (_dir, path) = temp_path();
        let good = serde_json::to_value(firing("f1", NOW)).unwrap();
        let mut repeat = serde_json::to_value(firing("f1", NOW - 10)).unwrap();
        repeat["terminal"] = json!("other");
        let mut no_id = serde_json::to_value(firing("", NOW)).unwrap();
        no_id["id"] = json!("");
        let mut no_trigger = serde_json::to_value(follow_up("u2", NOW)).unwrap();
        no_trigger["triggerId"] = json!("");
        let mut bad_percent = serde_json::to_value(firing("f3", NOW)).unwrap();
        bad_percent["percent"] = json!(-4);
        let mut null_recipient = serde_json::to_value(firing("f4", NOW)).unwrap();
        null_recipient["recipients"] = json!([null]);
        let file = json!({
            "version": 1,
            "entries": [
                null, 7, "text", [], {}, { "kind": "unknown", "id": "x", "at": NOW },
                good, repeat, no_id, no_trigger, bad_percent, null_recipient,
                serde_json::to_value(follow_up("u1", NOW)).unwrap()
            ]
        });
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, file.to_string()).unwrap();

        assert_eq!(
            load_from(&path, NOW),
            vec![firing("f1", NOW), follow_up("u1", NOW)]
        );
    }

    #[test]
    fn cuts_long_texts_keeps_errors_only_for_failed_sends_and_caps_percent() {
        let (_dir, path) = temp_path();
        let TriggerHistoryEntry::Firing(mut e) = firing("f1", NOW) else {
            unreachable!()
        };
        e.excerpt = "é".repeat(MAX_EXCERPT_CHARS + 50);
        e.percent = 250;
        e.recipients[0].error = Some("should not be kept".to_string());
        e.recipients[1].error = Some("x".repeat(MAX_ERROR_CHARS + 1));
        append_to(&path, TriggerHistoryEntry::Firing(e), NOW).unwrap();

        let TriggerHistoryEntry::Firing(saved) = &load_from(&path, NOW)[0] else {
            panic!("expected a firing");
        };
        assert_eq!(saved.excerpt.chars().count(), MAX_EXCERPT_CHARS);
        assert_eq!(saved.percent, 100);
        assert_eq!(saved.recipients[0].error, None);
        assert_eq!(
            saved.recipients[1]
                .error
                .as_deref()
                .map(|e| e.chars().count()),
            Some(MAX_ERROR_CHARS)
        );
    }

    #[test]
    fn appending_an_id_already_saved_changes_nothing_and_an_empty_id_is_refused() {
        let (_dir, path) = temp_path();
        append_to(&path, firing("f1", NOW), NOW).unwrap();
        append_to(&path, firing("f1", NOW - 99), NOW).unwrap();
        assert_eq!(load_from(&path, NOW), vec![firing("f1", NOW)]);

        assert!(append_to(&path, firing("", NOW), NOW).is_err());
    }

    #[test]
    fn keeps_only_the_newest_entries_past_the_cap() {
        let (_dir, path) = temp_path();
        let many: Vec<TriggerHistoryEntry> = (0..MAX_ENTRIES as i64 + 5)
            .map(|i| firing(&format!("f{i}"), NOW - 10_000 + i))
            .collect();
        save_to(&path, &many).unwrap();
        append_to(&path, firing("newest", NOW), NOW).unwrap();

        let loaded = load_from(&path, NOW);
        assert_eq!(loaded.len(), MAX_ENTRIES);
        assert_eq!(loaded.last().map(|e| e.id()), Some("newest"));
        assert_eq!(loaded.first().map(|e| e.id()), Some("f6"));
    }

    #[test]
    fn clear_empties_the_history() {
        let (_dir, path) = temp_path();
        append_to(&path, firing("f1", NOW), NOW).unwrap();
        clear_at(&path).unwrap();
        assert!(load_from(&path, NOW).is_empty());
    }

    #[test]
    fn the_file_lives_in_maestros_app_data() {
        let path = history_path();
        assert!(path.ends_with(Path::new("trigger-history").join(FILE_NAME)));
        assert_eq!(
            path.parent(),
            Some(artifact_base_dir("trigger-history").as_path())
        );
    }
}
