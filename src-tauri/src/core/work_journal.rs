//! The Work Journal file (`work-journal.json`): one crash-safe JSON file that
//! holds every day page, the deleted-dates list and the journal settings.
//!
//! Not the Samurai journal (`samurai_journal.rs`); the two never share code
//! or files.
//!
//! - Loading a missing file yields an empty journal and writes nothing.
//! - Every save goes through the temp-then-rename helper in
//!   [`crate::core::atomic_write`], so a crash leaves the old or the new file.
//! - The file records a layout version. A newer one is refused ("update
//!   Maestro first") without touching the file; an older one is upgraded in
//!   memory by [`upgrade`] and written back only on the next change.
//!
//! Every function takes the file path, so tests run against temp dirs; the
//! Tauri commands pass the app-data path.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::core::atomic_write::atomic_write_via;

/// The layout version this build reads and writes.
pub const LAYOUT_VERSION: u32 = 1;

/// The journal's file name inside its app-data folder.
pub const FILE_NAME: &str = "work-journal.json";

/// Errors from loading, changing or saving the Work Journal.
#[derive(Debug, thiserror::Error)]
pub enum WorkJournalError {
    #[error("Failed to read the work journal: {0}")]
    Read(#[source] std::io::Error),
    #[error("The work journal file is not valid JSON: {0}")]
    Parse(#[source] serde_json::Error),
    #[error("The work journal file has no layout version")]
    MissingLayoutVersion,
    #[error(
        "The work journal was saved by a newer Maestro (layout version {found}, this \
         version reads up to {supported}). Update Maestro first."
    )]
    NewerLayout { found: u64, supported: u32 },
    #[error("Not a valid date (expected YYYY-MM-DD): {0}")]
    InvalidDate(String),
    #[error("A work journal page for {0} already exists")]
    PageExists(String),
    #[error("No work journal page for {0}")]
    PageNotFound(String),
    #[error("Failed to create the work journal folder: {0}")]
    CreateDir(#[source] std::io::Error),
    #[error("Failed to serialize the work journal: {0}")]
    Serialize(#[source] serde_json::Error),
    /// Message from the shared `atomic_write` helper, which reports `String`.
    #[error("{0}")]
    Write(String),
}

/// Result type for Work Journal operations.
pub type WorkJournalResult<T> = Result<T, WorkJournalError>;

/// How a page came to exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageOrigin {
    /// Created by Maestro's day-page lifecycle.
    Auto,
    /// Created by the user.
    Manual,
}

/// The journal entry for one calendar date.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkJournalPage {
    /// ISO date (`YYYY-MM-DD`), the page's unique key.
    pub date: String,
    pub title: String,
    /// TipTap editor JSON, stored as-is (opaque to the backend).
    pub body: Value,
    pub origin: PageOrigin,
}

/// Journal settings. Later features add named fields with `#[serde(default)]`;
/// keys this build does not know are kept in `extra` and written back, so an
/// older build never drops a newer build's settings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkJournalSettings {
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// The whole `work-journal.json` file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkJournal {
    pub layout_version: u32,
    /// Pages keyed by their ISO date.
    #[serde(default)]
    pub pages: BTreeMap<String, WorkJournalPage>,
    /// Dates whose page the user deleted; they block auto-creation only.
    #[serde(default)]
    pub deleted_dates: BTreeSet<String>,
    /// Where gap-filling starts on the next launch.
    #[serde(default)]
    pub last_auto_created_date: Option<String>,
    #[serde(default)]
    pub settings: WorkJournalSettings,
}

impl Default for WorkJournal {
    fn default() -> Self {
        Self {
            layout_version: LAYOUT_VERSION,
            pages: BTreeMap::new(),
            deleted_dates: BTreeSet::new(),
            last_auto_created_date: None,
            settings: WorkJournalSettings::default(),
        }
    }
}

/// `<base_dir>/work-journal.json`.
pub fn journal_path(base_dir: &Path) -> PathBuf {
    base_dir.join(FILE_NAME)
}

/// The temp file a save writes before renaming it over `path`.
fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Loads the journal. A missing file is an empty journal (nothing written).
/// Never modifies the file, whatever its content.
pub fn load(path: &Path) -> WorkJournalResult<WorkJournal> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkJournal::default());
        }
        Err(e) => return Err(WorkJournalError::Read(e)),
    };
    parse(&text)
}

/// Parses file text, refusing a newer layout and upgrading an older one.
fn parse(text: &str) -> WorkJournalResult<WorkJournal> {
    let value: Value = serde_json::from_str(text).map_err(WorkJournalError::Parse)?;
    let found = value
        .get("layout_version")
        .and_then(Value::as_u64)
        .ok_or(WorkJournalError::MissingLayoutVersion)?;
    if found > u64::from(LAYOUT_VERSION) {
        return Err(WorkJournalError::NewerLayout {
            found,
            supported: LAYOUT_VERSION,
        });
    }
    // `found` <= LAYOUT_VERSION, so it fits in u32.
    let upgraded = upgrade(value, found as u32);
    serde_json::from_value(upgraded).map_err(WorkJournalError::Parse)
}

/// Upgrades raw file JSON from layout `from` to [`LAYOUT_VERSION`], one step
/// at a time. Each future layout change adds a step for the version it
/// replaces; today no older layout exists, so every step is the identity.
fn upgrade(mut value: Value, from: u32) -> Value {
    for version in from..LAYOUT_VERSION {
        value = upgrade_step(value, version);
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert("layout_version".to_string(), Value::from(LAYOUT_VERSION));
    }
    value
}

/// Moves raw file JSON from layout `version` to `version + 1`.
fn upgrade_step(value: Value, version: u32) -> Value {
    log::info!(
        "Upgrading the work journal from layout {version} to {}",
        version + 1
    );
    // Identity for now; a future layout adds `match version { … }` here.
    value
}

/// Saves the whole journal crash-safely (temp file, then rename).
pub fn save(path: &Path, journal: &WorkJournal) -> WorkJournalResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(WorkJournalError::CreateDir)?;
    }
    let bytes = serde_json::to_vec_pretty(journal).map_err(WorkJournalError::Serialize)?;
    atomic_write_via(path, &tmp_path(path), &bytes).map_err(WorkJournalError::Write)
}

/// Loads the journal, applies `change`, and saves it only if `change`
/// succeeds. Returns the saved journal.
pub fn modify(
    path: &Path,
    change: impl FnOnce(&mut WorkJournal) -> WorkJournalResult<()>,
) -> WorkJournalResult<WorkJournal> {
    let mut journal = load(path)?;
    change(&mut journal)?;
    save(path, &journal)?;
    Ok(journal)
}

/// Accepts only a real calendar date written as `YYYY-MM-DD`.
fn validate_date(date: &str) -> WorkJournalResult<()> {
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| WorkJournalError::InvalidDate(date.to_string()))?;
    // parse_from_str accepts "2026-1-5"; keep the key canonical.
    if parsed.format("%Y-%m-%d").to_string() != date {
        return Err(WorkJournalError::InvalidDate(date.to_string()));
    }
    Ok(())
}

/// Adds a page for `date`. Refused when that date already has a page.
pub fn create_page(
    journal: &mut WorkJournal,
    date: &str,
    title: String,
    body: Value,
    origin: PageOrigin,
) -> WorkJournalResult<()> {
    validate_date(date)?;
    if journal.pages.contains_key(date) {
        return Err(WorkJournalError::PageExists(date.to_string()));
    }
    journal.pages.insert(
        date.to_string(),
        WorkJournalPage {
            date: date.to_string(),
            title,
            body,
            origin,
        },
    );
    Ok(())
}

/// Changes the title and/or body of an existing page.
pub fn update_page(
    journal: &mut WorkJournal,
    date: &str,
    title: Option<String>,
    body: Option<Value>,
) -> WorkJournalResult<()> {
    let page = journal
        .pages
        .get_mut(date)
        .ok_or_else(|| WorkJournalError::PageNotFound(date.to_string()))?;
    if let Some(title) = title {
        page.title = title;
    }
    if let Some(body) = body {
        page.body = body;
    }
    Ok(())
}

/// Removes a page and records its date in `deleted_dates`.
pub fn delete_page(journal: &mut WorkJournal, date: &str) -> WorkJournalResult<()> {
    if journal.pages.remove(date).is_none() {
        return Err(WorkJournalError::PageNotFound(date.to_string()));
    }
    journal.deleted_dates.insert(date.to_string());
    Ok(())
}

/// Replaces the journal settings.
pub fn set_settings(journal: &mut WorkJournal, settings: WorkJournalSettings) {
    journal.settings = settings;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn tiptap_body() -> Value {
        json!({
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text",
                            "text": "Shipped the parser \u{2713}",
                            "marks": [
                                { "type": "textStyle", "attrs": { "color": "#ff0000" } },
                                { "type": "highlight", "attrs": { "color": null } }
                            ]
                        }
                    ]
                },
                {
                    "type": "taskList",
                    "content": [
                        { "type": "taskItem", "attrs": { "checked": true }, "content": [] }
                    ]
                }
            ],
            "zLast": 1.5,
            "aFirst": [1, 2, 3]
        })
    }

    #[test]
    fn test_load_missing_file_returns_empty_journal_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());

        let journal = load(&path).unwrap();

        assert_eq!(journal, WorkJournal::default());
        assert_eq!(journal.layout_version, 1);
        assert!(journal.pages.is_empty());
        assert!(!path.exists(), "loading must not create the file");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn test_saved_page_round_trips_after_restart() {
        let dir = tempdir().unwrap();
        let path = journal_path(&dir.path().join("work-journal"));
        let body = tiptap_body();

        modify(&path, |j| {
            create_page(
                j,
                "2026-10-14",
                "Wed 14 Oct 2026".into(),
                body.clone(),
                PageOrigin::Manual,
            )
        })
        .unwrap();

        // A "restart": a fresh load from disk.
        let reloaded = load(&path).unwrap();
        let page = &reloaded.pages["2026-10-14"];
        assert_eq!(page.date, "2026-10-14");
        assert_eq!(page.title, "Wed 14 Oct 2026");
        assert_eq!(page.origin, PageOrigin::Manual);
        assert_eq!(page.body, body);
        assert_eq!(
            serde_json::to_string(&page.body).unwrap(),
            serde_json::to_string(&body).unwrap(),
            "body keeps key order and values exactly"
        );
    }

    #[test]
    fn test_newer_layout_is_refused_and_file_untouched() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());
        let text = r#"{"layout_version": 2, "pages": {}, "future_field": true}"#;
        std::fs::write(&path, text).unwrap();

        let err = load(&path).unwrap_err();
        assert!(matches!(
            err,
            WorkJournalError::NewerLayout {
                found: 2,
                supported: 1
            }
        ));
        assert!(
            err.to_string().contains("Update Maestro first"),
            "got: {err}"
        );

        let err = modify(&path, |j| delete_page(j, "2026-10-14")).unwrap_err();
        assert!(matches!(err, WorkJournalError::NewerLayout { .. }));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn test_older_layout_is_upgraded_in_memory_only() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());
        let text = r#"{"layout_version": 0, "pages": {"2026-10-13": {"date": "2026-10-13",
            "title": "Tue 13 Oct 2026", "body": {"type": "doc"}, "origin": "auto"}},
            "deleted_dates": ["2026-10-12"]}"#;
        std::fs::write(&path, text).unwrap();

        let journal = load(&path).unwrap();

        assert_eq!(journal.layout_version, LAYOUT_VERSION);
        assert_eq!(journal.pages["2026-10-13"].origin, PageOrigin::Auto);
        assert!(journal.deleted_dates.contains("2026-10-12"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            text,
            "an upgrade is written only with the next change"
        );
    }

    #[test]
    fn test_upgrade_hook_sets_current_version() {
        let upgraded = upgrade(json!({"layout_version": 0, "pages": {}}), 0);
        assert_eq!(upgraded["layout_version"], json!(LAYOUT_VERSION));
        assert_eq!(upgraded["pages"], json!({}));
    }

    #[test]
    fn test_missing_layout_version_and_bad_json_are_refused() {
        assert!(matches!(
            parse(r#"{"pages": {}}"#).unwrap_err(),
            WorkJournalError::MissingLayoutVersion
        ));
        assert!(matches!(
            parse("{not json").unwrap_err(),
            WorkJournalError::Parse(_)
        ));
    }

    #[test]
    fn test_delete_page_records_deleted_date() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());
        modify(&path, |j| {
            create_page(j, "2026-10-14", "t".into(), json!({}), PageOrigin::Auto)
        })
        .unwrap();

        let journal = modify(&path, |j| delete_page(j, "2026-10-14")).unwrap();

        assert!(!journal.pages.contains_key("2026-10-14"));
        assert!(journal.deleted_dates.contains("2026-10-14"));
        let reloaded = load(&path).unwrap();
        assert!(reloaded.deleted_dates.contains("2026-10-14"));
        assert!(reloaded.pages.is_empty());
    }

    #[test]
    fn test_delete_missing_page_is_refused() {
        let mut journal = WorkJournal::default();
        let err = delete_page(&mut journal, "2026-10-14").unwrap_err();
        assert!(matches!(err, WorkJournalError::PageNotFound(_)));
        assert!(journal.deleted_dates.is_empty());
    }

    #[test]
    fn test_create_page_for_existing_date_is_refused_and_file_unchanged() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());
        modify(&path, |j| {
            create_page(
                j,
                "2026-10-14",
                "first".into(),
                json!({"a": 1}),
                PageOrigin::Auto,
            )
        })
        .unwrap();
        let before = std::fs::read_to_string(&path).unwrap();

        let err = modify(&path, |j| {
            create_page(
                j,
                "2026-10-14",
                "second".into(),
                json!({}),
                PageOrigin::Manual,
            )
        })
        .unwrap_err();

        assert!(matches!(err, WorkJournalError::PageExists(_)));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn test_deleted_date_can_be_created_again_by_hand() {
        let mut journal = WorkJournal::default();
        create_page(
            &mut journal,
            "2026-10-14",
            "t".into(),
            json!({}),
            PageOrigin::Auto,
        )
        .unwrap();
        delete_page(&mut journal, "2026-10-14").unwrap();

        create_page(
            &mut journal,
            "2026-10-14",
            "again".into(),
            json!({}),
            PageOrigin::Manual,
        )
        .unwrap();

        assert_eq!(journal.pages["2026-10-14"].origin, PageOrigin::Manual);
    }

    #[test]
    fn test_create_page_rejects_invalid_dates() {
        let mut journal = WorkJournal::default();
        for bad in ["2026-1-5", "2026-02-30", "14/10/2026", "", "../x"] {
            let err = create_page(&mut journal, bad, "t".into(), json!({}), PageOrigin::Manual)
                .unwrap_err();
            assert!(matches!(err, WorkJournalError::InvalidDate(_)), "{bad}");
        }
        assert!(journal.pages.is_empty());
    }

    #[test]
    fn test_update_page_changes_only_given_fields() {
        let mut journal = WorkJournal::default();
        create_page(
            &mut journal,
            "2026-10-14",
            "old".into(),
            json!({"v": 1}),
            PageOrigin::Auto,
        )
        .unwrap();

        update_page(&mut journal, "2026-10-14", Some("new".into()), None).unwrap();
        assert_eq!(journal.pages["2026-10-14"].title, "new");
        assert_eq!(journal.pages["2026-10-14"].body, json!({"v": 1}));

        update_page(&mut journal, "2026-10-14", None, Some(json!({"v": 2}))).unwrap();
        assert_eq!(journal.pages["2026-10-14"].title, "new");
        assert_eq!(journal.pages["2026-10-14"].body, json!({"v": 2}));
        assert_eq!(journal.pages["2026-10-14"].origin, PageOrigin::Auto);

        let err = update_page(&mut journal, "2026-10-15", None, None).unwrap_err();
        assert!(matches!(err, WorkJournalError::PageNotFound(_)));
    }

    #[test]
    fn test_settings_round_trip_and_keep_unknown_keys() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());
        let settings: WorkJournalSettings =
            serde_json::from_value(json!({"from_a_newer_build": {"x": 1}})).unwrap();

        modify(&path, |j| {
            set_settings(j, settings.clone());
            Ok(())
        })
        .unwrap();

        let reloaded = load(&path).unwrap();
        assert_eq!(reloaded.settings, settings);
        assert_eq!(
            reloaded.settings.extra["from_a_newer_build"],
            json!({"x": 1})
        );
    }

    #[test]
    fn test_save_writes_through_temp_then_rename() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());
        let tmp = tmp_path(&path);
        assert_eq!(tmp.parent(), path.parent(), "temp sits next to the target");
        std::fs::write(&path, r#"{"layout_version": 1}"#).unwrap();

        // Block the temp path: a save that writes the temp first must fail
        // before it ever touches the real file.
        std::fs::create_dir(&tmp).unwrap();
        let mut journal = WorkJournal::default();
        create_page(
            &mut journal,
            "2026-10-14",
            "t".into(),
            json!({}),
            PageOrigin::Manual,
        )
        .unwrap();
        let err = save(&path, &journal).unwrap_err();
        assert!(matches!(err, WorkJournalError::Write(_)), "got: {err}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"layout_version": 1}"#
        );

        // Unblocked, the save lands and the temp file is consumed.
        std::fs::remove_dir(&tmp).unwrap();
        save(&path, &journal).unwrap();
        assert!(!tmp.exists(), "the rename consumes the temp file");
        assert!(load(&path).unwrap().pages.contains_key("2026-10-14"));
    }

    #[test]
    fn test_newer_layout_error_says_update_maestro_first() {
        let err = WorkJournalError::NewerLayout {
            found: 3,
            supported: 1,
        };
        assert_eq!(
            err.to_string(),
            "The work journal was saved by a newer Maestro (layout version 3, this version \
             reads up to 1). Update Maestro first."
        );
    }
}
