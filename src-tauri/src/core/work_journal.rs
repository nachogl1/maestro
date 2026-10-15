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
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use chrono::{Datelike, NaiveDate, Weekday};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::commands::ai_runner::artifact_base_dir;
use crate::core::atomic_write::atomic_write_via;

/// Environment variable that overrides the journal's folder.
pub const DIR_ENV_VAR: &str = "MAESTRO_WORK_JOURNAL_DIR";

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
    #[error("The work journal file is valid JSON but not in the expected layout: {0}")]
    Shape(#[source] serde_json::Error),
    #[error("Invalid work journal settings: {0}")]
    InvalidSettings(#[source] serde_json::Error),
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
    /// The page title; defaults from the date but the user may edit it.
    pub title: String,
    /// TipTap editor JSON, stored as-is (opaque to the backend).
    pub body: Value,
    /// Whether Maestro or the user created the page.
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
    /// The file's layout version, checked on every load (upgrade or refuse).
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
    /// Journal settings (see [`WorkJournalSettings`]).
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

/// The journal's folder: `$MAESTRO_WORK_JOURNAL_DIR` when set and non-empty,
/// else `<app data>/work-journal/`.
///
/// The override exists for devtest copies of Maestro: `artifact_base_dir`
/// ignores the Tauri identifier, so a devtest build would otherwise read and
/// write the installed Maestro's real journal.
pub fn work_journal_dir() -> PathBuf {
    dir_from_override(std::env::var_os(DIR_ENV_VAR))
}

/// [`work_journal_dir`] with the environment value passed in, so tests never
/// mutate the process environment.
fn dir_from_override(value: Option<OsString>) -> PathBuf {
    match value {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => artifact_base_dir("work-journal"),
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
    parse_journal(&text)
}

/// Loads a journal file that must exist: a missing file is an error, never
/// an empty journal. For callers like restore, where "no file" must not
/// become "wipe the journal". Never modifies the file.
#[allow(dead_code)] // first caller: restore from backup (#312)
pub fn load_existing(path: &Path) -> WorkJournalResult<WorkJournal> {
    let text = std::fs::read_to_string(path).map_err(WorkJournalError::Read)?;
    parse_journal(&text)
}

/// Parses journal file text, refusing a newer layout and upgrading an older
/// one in memory.
pub fn parse_journal(text: &str) -> WorkJournalResult<WorkJournal> {
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
    serde_json::from_value(upgraded).map_err(WorkJournalError::Shape)
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
    parse_date(date).map(|_| ())
}

/// Parses a real calendar date written exactly as `YYYY-MM-DD`.
fn parse_date(date: &str) -> WorkJournalResult<NaiveDate> {
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| WorkJournalError::InvalidDate(date.to_string()))?;
    // parse_from_str accepts "2026-1-5"; keep the key canonical.
    if parsed.format("%Y-%m-%d").to_string() != date {
        return Err(WorkJournalError::InvalidDate(date.to_string()));
    }
    Ok(parsed)
}

/// Earliest and latest years a day-page lifecycle date may have. A wider
/// range would let one bad date (e.g. `9999-12-31`, or a damaged epoch anchor
/// `1970-01-01`) build tens of thousands of pages under the journal lock.
const DAY_PAGE_YEARS: std::ops::RangeInclusive<i32> = 2000..=2100;

/// Parses a day-page lifecycle date (`today` or the stored anchor): exactly
/// `YYYY-MM-DD` with a four-digit year inside [`DAY_PAGE_YEARS`].
fn parse_day_page_date(date: &str) -> WorkJournalResult<NaiveDate> {
    let invalid = || WorkJournalError::InvalidDate(date.to_string());
    // chrono's `%Y` also accepts signed years like `+262142-12-31`.
    if date.len() != 10 || !date.as_bytes()[..4].iter().all(u8::is_ascii_digit) {
        return Err(invalid());
    }
    let parsed = parse_date(date)?;
    if !DAY_PAGE_YEARS.contains(&parsed.year()) {
        return Err(invalid());
    }
    Ok(parsed)
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

/// Shallow-merges `patch` into the journal settings: each top-level key sent
/// overwrites or adds that key; keys not sent are kept. So a frontend holding
/// a stale copy cannot roll back keys the backend wrote since.
pub fn merge_settings(
    journal: &mut WorkJournal,
    patch: Map<String, Value>,
) -> WorkJournalResult<()> {
    let mut merged = match serde_json::to_value(&journal.settings) {
        Ok(Value::Object(map)) => map,
        Ok(_) => Map::new(),
        Err(e) => return Err(WorkJournalError::Serialize(e)),
    };
    merged.extend(patch);
    journal.settings =
        serde_json::from_value(Value::Object(merged)).map_err(WorkJournalError::InvalidSettings)?;
    Ok(())
}

/// The default page title, e.g. `Wed 14 Oct 2026`: short weekday, day without
/// a leading zero, short month, year. Always English: chrono's plain
/// `format` never uses the system locale.
pub fn default_title(date: NaiveDate) -> String {
    date.format("%a %-d %b %Y").to_string()
}

/// The body of a new weekday page: what TipTap's `editor.getJSON()` returns
/// for an empty editor.
pub fn empty_page_body() -> Value {
    serde_json::json!({"type": "doc", "content": [{"type": "paragraph"}]})
}

/// The body of a new Saturday or Sunday page: one paragraph saying `Weekend`.
pub fn weekend_page_body() -> Value {
    serde_json::json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Weekend"}]}]
    })
}

/// Makes sure every day has its page, up to `today` (`YYYY-MM-DD`).
///
/// - No `last_auto_created_date` yet (first run): only today's page.
/// - Otherwise every date from the day after `last_auto_created_date` up to
///   today inclusive.
/// - Dates in `deleted_dates` and dates that already have a page (manual or
///   auto) are skipped; gap-filling still moves past them.
/// - New pages are auto pages with the [`default_title`]; Saturday and Sunday
///   get [`weekend_page_body`], other days [`empty_page_body`].
/// - `last_auto_created_date` moves forward to today, never backwards (a
///   clock set back creates nothing).
/// - `today` must be `YYYY-MM-DD` with a year in 2000..=2100; a stored anchor
///   outside that is treated as damaged (first-run behaviour).
///
/// Returns whether the journal changed.
pub fn ensure_pages(journal: &mut WorkJournal, today: &str) -> WorkJournalResult<bool> {
    let today = parse_day_page_date(today)?;
    let anchor = match journal
        .last_auto_created_date
        .as_deref()
        .map(parse_day_page_date)
    {
        Some(Ok(anchor)) => Some(anchor),
        Some(Err(_)) => {
            log::warn!("Ignoring an invalid last auto-created date in the work journal");
            None
        }
        None => None,
    };
    let first = match anchor {
        Some(anchor) if anchor >= today => return Ok(false),
        Some(anchor) => anchor.succ_opt().unwrap_or(today),
        None => today,
    };

    for date in first.iter_days().take_while(|d| *d <= today) {
        let key = date.format("%Y-%m-%d").to_string();
        if journal.pages.contains_key(&key) || journal.deleted_dates.contains(&key) {
            continue;
        }
        let body = match date.weekday() {
            Weekday::Sat | Weekday::Sun => weekend_page_body(),
            _ => empty_page_body(),
        };
        create_page(journal, &key, default_title(date), body, PageOrigin::Auto)?;
    }
    journal.last_auto_created_date = Some(today.format("%Y-%m-%d").to_string());
    Ok(true)
}

/// Loads the journal at `path`, runs [`ensure_pages`] for `today`, and saves
/// only when something changed. Returns the (saved) journal. An invalid
/// `today` is refused before the file is read.
pub fn ensure_pages_in_file(path: &Path, today: &str) -> WorkJournalResult<WorkJournal> {
    parse_day_page_date(today)?;
    let mut journal = load(path)?;
    if ensure_pages(&mut journal, today)? {
        save(path, &journal)?;
    }
    Ok(journal)
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
        let folder = dir.path().join("app-data").join("work-journal");
        let path = journal_path(&folder);

        let journal = load(&path).unwrap();

        assert_eq!(journal, WorkJournal::default());
        assert_eq!(journal.layout_version, 1);
        assert!(journal.pages.is_empty());
        assert!(!path.exists(), "loading must not create the file");
        assert!(!folder.exists(), "loading must not create folders");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn test_load_existing_refuses_a_missing_file() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());

        let err = load_existing(&path).unwrap_err();

        assert!(
            matches!(&err, WorkJournalError::Read(e) if e.kind() == std::io::ErrorKind::NotFound),
            "got: {err}"
        );
        assert!(!path.exists());
    }

    #[test]
    fn test_work_journal_dir_uses_non_empty_override() {
        let custom = std::env::temp_dir().join("devtest-journal");
        assert_eq!(dir_from_override(Some(custom.clone().into())), custom);
        let default = artifact_base_dir("work-journal");
        assert_eq!(dir_from_override(Some(OsString::new())), default);
        assert_eq!(dir_from_override(None), default);
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
            parse_journal(r#"{"pages": {}}"#).unwrap_err(),
            WorkJournalError::MissingLayoutVersion
        ));
        let bad_json = parse_journal("{not json").unwrap_err();
        assert!(matches!(bad_json, WorkJournalError::Parse(_)));
        assert!(
            bad_json.to_string().contains("not valid JSON"),
            "got: {bad_json}"
        );
    }

    #[test]
    fn test_wrong_shape_file_has_its_own_message() {
        let err = parse_journal(r#"{"layout_version": 1, "pages": "oops"}"#).unwrap_err();

        assert!(matches!(err, WorkJournalError::Shape(_)), "got: {err}");
        let message = err.to_string();
        assert!(
            message.contains("not in the expected layout"),
            "got: {message}"
        );
        assert!(!message.contains("not valid JSON"), "got: {message}");
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
        let patch = json!({"from_a_newer_build": {"x": 1}});

        modify(&path, |j| {
            merge_settings(j, patch.as_object().unwrap().clone())
        })
        .unwrap();

        let reloaded = load(&path).unwrap();
        assert_eq!(reloaded.settings.extra.len(), 1);
        assert_eq!(
            reloaded.settings.extra["from_a_newer_build"],
            json!({"x": 1})
        );
    }

    #[test]
    fn test_merge_settings_keeps_keys_not_sent() {
        let mut journal = WorkJournal::default();
        let backend = json!({"last_backup_at": "2026-10-15T09:00:00Z", "mode": "a"});
        merge_settings(&mut journal, backend.as_object().unwrap().clone()).unwrap();

        // A stale frontend copy sends only the key it changed.
        let patch = json!({"mode": "b", "added": true});
        merge_settings(&mut journal, patch.as_object().unwrap().clone()).unwrap();

        let extra = &journal.settings.extra;
        assert_eq!(extra["last_backup_at"], json!("2026-10-15T09:00:00Z"));
        assert_eq!(extra["mode"], json!("b"), "a sent key overwrites");
        assert_eq!(extra["added"], json!(true), "a new key is added");
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

    fn day(date: &str) -> NaiveDate {
        NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap()
    }

    fn journal_anchored_at(date: &str) -> WorkJournal {
        WorkJournal {
            last_auto_created_date: Some(date.to_string()),
            ..WorkJournal::default()
        }
    }

    #[test]
    fn test_ensure_first_run_creates_only_today() {
        let mut journal = WorkJournal::default();

        let changed = ensure_pages(&mut journal, "2026-10-14").unwrap();

        assert!(changed);
        assert_eq!(journal.pages.len(), 1, "no back-fill on the first run");
        let page = &journal.pages["2026-10-14"];
        assert_eq!(page.date, "2026-10-14");
        assert_eq!(page.title, "Wed 14 Oct 2026");
        assert_eq!(page.body, empty_page_body());
        assert_eq!(page.origin, PageOrigin::Auto);
        assert_eq!(
            journal.last_auto_created_date.as_deref(),
            Some("2026-10-14")
        );
    }

    #[test]
    fn test_ensure_gap_fills_three_days_with_weekend_bodies() {
        // Last auto-created on Friday; today is Monday.
        let mut journal = journal_anchored_at("2026-10-16");

        ensure_pages(&mut journal, "2026-10-19").unwrap();

        let dates: Vec<&str> = journal.pages.keys().map(String::as_str).collect();
        assert_eq!(dates, ["2026-10-17", "2026-10-18", "2026-10-19"]);
        let sat = &journal.pages["2026-10-17"];
        assert_eq!(sat.title, "Sat 17 Oct 2026");
        assert_eq!(sat.body, weekend_page_body());
        let sun = &journal.pages["2026-10-18"];
        assert_eq!(sun.title, "Sun 18 Oct 2026");
        assert_eq!(sun.body, weekend_page_body());
        let mon = &journal.pages["2026-10-19"];
        assert_eq!(mon.title, "Mon 19 Oct 2026");
        assert_eq!(mon.body, empty_page_body());
        assert!(journal.pages.values().all(|p| p.origin == PageOrigin::Auto));
        assert_eq!(
            journal.last_auto_created_date.as_deref(),
            Some("2026-10-19")
        );
    }

    #[test]
    fn test_ensure_gap_fills_weekdays_with_empty_bodies() {
        let mut journal = journal_anchored_at("2026-10-12");

        ensure_pages(&mut journal, "2026-10-15").unwrap();

        let dates: Vec<&str> = journal.pages.keys().map(String::as_str).collect();
        assert_eq!(dates, ["2026-10-13", "2026-10-14", "2026-10-15"]);
        assert!(journal.pages.values().all(|p| p.body == empty_page_body()));
    }

    #[test]
    fn test_ensure_never_recreates_a_deleted_date_and_still_advances() {
        let mut journal = journal_anchored_at("2026-10-12");
        journal.deleted_dates.insert("2026-10-13".to_string());

        ensure_pages(&mut journal, "2026-10-14").unwrap();

        assert!(!journal.pages.contains_key("2026-10-13"));
        assert!(journal.pages.contains_key("2026-10-14"));
        assert_eq!(
            journal.last_auto_created_date.as_deref(),
            Some("2026-10-14")
        );

        // The next day's run starts after the anchor, so the deleted day stays gone.
        ensure_pages(&mut journal, "2026-10-15").unwrap();
        let dates: Vec<&str> = journal.pages.keys().map(String::as_str).collect();
        assert_eq!(dates, ["2026-10-14", "2026-10-15"]);
        assert!(journal.deleted_dates.contains("2026-10-13"));
    }

    #[test]
    fn test_ensure_anchors_on_last_auto_date_not_newest_page() {
        // Yesterday's auto page was deleted; the newest remaining page is older.
        let mut journal = journal_anchored_at("2026-10-13");
        create_page(
            &mut journal,
            "2026-10-12",
            "Mon 12 Oct 2026".into(),
            empty_page_body(),
            PageOrigin::Auto,
        )
        .unwrap();
        journal.deleted_dates.insert("2026-10-13".to_string());

        ensure_pages(&mut journal, "2026-10-14").unwrap();

        assert!(!journal.pages.contains_key("2026-10-13"));
        assert!(journal.pages.contains_key("2026-10-14"));
    }

    #[test]
    fn test_ensure_deleted_today_on_first_run_is_skipped_but_anchored() {
        let mut journal = WorkJournal::default();
        journal.deleted_dates.insert("2026-10-14".to_string());

        assert!(ensure_pages(&mut journal, "2026-10-14").unwrap());

        assert!(journal.pages.is_empty());
        assert_eq!(
            journal.last_auto_created_date.as_deref(),
            Some("2026-10-14")
        );
    }

    #[test]
    fn test_ensure_leaves_existing_manual_and_auto_pages_untouched() {
        let mut journal = journal_anchored_at("2026-10-12");
        let manual_body = json!({"type": "doc", "content": [{"type": "paragraph",
            "content": [{"type": "text", "text": "My notes"}]}]});
        create_page(
            &mut journal,
            "2026-10-13",
            "My own title".into(),
            manual_body.clone(),
            PageOrigin::Manual,
        )
        .unwrap();
        create_page(
            &mut journal,
            "2026-10-14",
            "Edited auto title".into(),
            json!({"v": 1}),
            PageOrigin::Auto,
        )
        .unwrap();

        ensure_pages(&mut journal, "2026-10-15").unwrap();

        let manual = &journal.pages["2026-10-13"];
        assert_eq!(manual.title, "My own title");
        assert_eq!(manual.body, manual_body);
        assert_eq!(manual.origin, PageOrigin::Manual);
        let auto = &journal.pages["2026-10-14"];
        assert_eq!(auto.title, "Edited auto title");
        assert_eq!(auto.body, json!({"v": 1}));
        assert!(journal.pages.contains_key("2026-10-15"));
        assert_eq!(journal.pages.len(), 3);
    }

    #[test]
    fn test_ensure_midnight_rollover_creates_only_the_new_day() {
        let mut journal = WorkJournal::default();
        ensure_pages(&mut journal, "2026-10-14").unwrap();

        assert!(ensure_pages(&mut journal, "2026-10-15").unwrap());

        let dates: Vec<&str> = journal.pages.keys().map(String::as_str).collect();
        assert_eq!(dates, ["2026-10-14", "2026-10-15"]);
        assert_eq!(
            journal.last_auto_created_date.as_deref(),
            Some("2026-10-15")
        );
    }

    #[test]
    fn test_ensure_same_day_or_clock_set_back_changes_nothing() {
        let mut journal = journal_anchored_at("2026-10-14");
        let before = journal.clone();

        assert!(!ensure_pages(&mut journal, "2026-10-14").unwrap());
        assert!(!ensure_pages(&mut journal, "2026-10-10").unwrap());

        assert_eq!(journal, before, "the anchor never moves backwards");
    }

    #[test]
    fn test_ensure_gap_fill_crosses_month_and_year() {
        let mut journal = journal_anchored_at("2026-12-30");

        ensure_pages(&mut journal, "2027-01-02").unwrap();

        let titles: Vec<&str> = journal.pages.values().map(|p| p.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Thu 31 Dec 2026", "Fri 1 Jan 2027", "Sat 2 Jan 2027"]
        );
        assert_eq!(journal.pages["2027-01-02"].body, weekend_page_body());
    }

    #[test]
    fn test_ensure_rejects_invalid_today() {
        let mut journal = journal_anchored_at("2026-10-12");
        let before = journal.clone();
        for bad in [
            "2026-10-5",
            "2026-02-30",
            "15/10/2026",
            "",
            "today",
            "+262142-12-31",
            "9999-12-31",
            "1999-12-31",
            "2101-01-01",
        ] {
            let err = ensure_pages(&mut journal, bad).unwrap_err();
            assert!(matches!(err, WorkJournalError::InvalidDate(_)), "{bad}");
        }
        assert_eq!(journal, before);
    }

    #[test]
    fn test_ensure_treats_an_invalid_anchor_as_first_run() {
        let mut journal = journal_anchored_at("not-a-date");

        ensure_pages(&mut journal, "2026-10-14").unwrap();

        assert_eq!(journal.pages.len(), 1);
        assert!(journal.pages.contains_key("2026-10-14"));
        assert_eq!(
            journal.last_auto_created_date.as_deref(),
            Some("2026-10-14")
        );
    }

    #[test]
    fn test_ensure_treats_an_out_of_range_anchor_as_first_run() {
        for damaged in ["1970-01-01", "+262142-12-31", "9999-12-31"] {
            let mut journal = journal_anchored_at(damaged);

            ensure_pages(&mut journal, "2026-10-14").unwrap();

            let dates: Vec<&str> = journal.pages.keys().map(String::as_str).collect();
            assert_eq!(dates, ["2026-10-14"], "{damaged}");
            assert_eq!(
                journal.last_auto_created_date.as_deref(),
                Some("2026-10-14")
            );
        }
    }

    #[test]
    fn test_ensure_ignores_a_future_manual_page_when_gap_filling() {
        // The wrong rule "start after max(anchor, newest page)" would create nothing.
        let mut journal = journal_anchored_at("2026-10-12");
        create_page(
            &mut journal,
            "2026-10-20",
            "Planned".into(),
            json!({"v": 1}),
            PageOrigin::Manual,
        )
        .unwrap();

        ensure_pages(&mut journal, "2026-10-14").unwrap();

        let dates: Vec<&str> = journal.pages.keys().map(String::as_str).collect();
        assert_eq!(dates, ["2026-10-13", "2026-10-14", "2026-10-20"]);
        assert_eq!(journal.pages["2026-10-20"].title, "Planned");
        assert_eq!(
            journal.last_auto_created_date.as_deref(),
            Some("2026-10-14")
        );
    }

    #[test]
    fn test_default_title_single_digit_day_has_no_leading_zero() {
        assert_eq!(default_title(day("2026-10-05")), "Mon 5 Oct 2026");
        assert_eq!(default_title(day("2026-03-01")), "Sun 1 Mar 2026");
    }

    #[test]
    fn test_default_title_for_each_weekday() {
        let expected = [
            ("2026-10-12", "Mon 12 Oct 2026"),
            ("2026-10-13", "Tue 13 Oct 2026"),
            ("2026-10-14", "Wed 14 Oct 2026"),
            ("2026-10-15", "Thu 15 Oct 2026"),
            ("2026-10-16", "Fri 16 Oct 2026"),
            ("2026-10-17", "Sat 17 Oct 2026"),
            ("2026-10-18", "Sun 18 Oct 2026"),
        ];
        for (date, title) in expected {
            assert_eq!(default_title(day(date)), title);
        }
    }

    #[test]
    fn test_page_bodies_match_tiptap_json() {
        assert_eq!(
            empty_page_body(),
            json!({"type": "doc", "content": [{"type": "paragraph"}]})
        );
        assert_eq!(
            weekend_page_body(),
            json!({"type": "doc", "content": [{"type": "paragraph",
                "content": [{"type": "text", "text": "Weekend"}]}]})
        );
    }

    #[test]
    fn test_ensure_in_file_saves_and_returns_the_journal() {
        let dir = tempdir().unwrap();
        let path = journal_path(&dir.path().join("work-journal"));

        let journal = ensure_pages_in_file(&path, "2026-10-14").unwrap();

        assert!(journal.pages.contains_key("2026-10-14"));
        assert_eq!(
            load(&path).unwrap(),
            journal,
            "the returned journal is the saved one"
        );
    }

    #[test]
    fn test_ensure_in_file_does_not_save_when_nothing_changed() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());
        // Compact JSON: any save would rewrite it pretty-printed.
        let text = r#"{"layout_version":1,"last_auto_created_date":"2026-10-14"}"#;
        std::fs::write(&path, text).unwrap();

        let journal = ensure_pages_in_file(&path, "2026-10-14").unwrap();

        assert!(journal.pages.is_empty());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn test_ensure_in_file_rejects_invalid_today_without_writing() {
        let dir = tempdir().unwrap();
        let path = journal_path(dir.path());

        let err = ensure_pages_in_file(&path, "2026-13-01").unwrap_err();

        assert!(matches!(err, WorkJournalError::InvalidDate(_)));
        assert!(!path.exists());
    }
}
