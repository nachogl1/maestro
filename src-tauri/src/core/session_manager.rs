use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};

/// Which AI backend a session is configured to use.
///
/// `Plain` is a raw terminal with no AI agent attached, useful for
/// manual shell work within a worktree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AiMode {
    Claude,
    Plain,
}

/// Frontend-visible configuration and state for a single session.
///
/// `branch` and `worktree_path` are `None` until `assign_branch` is called,
/// allowing sessions to be created before their worktree is ready.
///
/// Deliberately carries no lifecycle status (issue #134): this registry lives
/// only in memory, so it cannot outlive a reload and has nothing authoritative
/// to say about what a session is doing. Status is owned by the frontend
/// store, fed by the MCP `session-status-changed` stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub id: u32,
    pub mode: AiMode,
    pub name: Option<String>,
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// The project directory this session belongs to.
    /// Canonicalized absolute path for reliable comparison.
    pub project_path: String,
    /// The directory the shell was spawned in. For multi-repo workspaces this
    /// is the selected repo, which may differ from `project_path` (the
    /// workspace root). `None` means "same as project_path".
    #[serde(default)]
    pub working_directory: Option<String>,
}

/// Thread-safe session registry backed by `DashMap` for lock-free concurrent reads.
///
/// Designed to be placed in Tauri managed state. All methods take `&self` so
/// no exclusive access is needed, enabling safe concurrent access from
/// multiple async command handlers.
pub struct SessionManager {
    sessions: DashMap<u32, SessionConfig>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    /// Creates an empty session registry.
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    /// Inserts a new session with no branch assigned.
    /// Returns `Err` with the existing config if a session with this ID already exists.
    // `Err` is the session that already occupies this id, so both variants are
    // a `SessionConfig` — boxing the error would not shrink the `Result`.
    #[allow(clippy::result_large_err)]
    pub fn create_session(
        &self,
        id: u32,
        mode: AiMode,
        project_path: String,
        working_directory: Option<String>,
    ) -> Result<SessionConfig, SessionConfig> {
        let config = SessionConfig {
            id,
            mode,
            name: None,
            branch: None,
            worktree_path: None,
            project_path,
            working_directory,
        };
        match self.sessions.entry(id) {
            Entry::Occupied(e) => Err(e.get().clone()),
            Entry::Vacant(e) => {
                e.insert(config.clone());
                Ok(config)
            }
        }
    }

    /// Returns a snapshot of the session config, or `None` if not found.
    pub fn get_session(&self, id: u32) -> Option<SessionConfig> {
        self.sessions.get(&id).map(|s| s.clone())
    }

    /// Updates the session's display name. Pass `None` to reset to the default.
    /// Returns the updated config, or `None` if the session does not exist.
    pub fn rename_session(&self, id: u32, name: Option<String>) -> Option<SessionConfig> {
        if let Some(mut session) = self.sessions.get_mut(&id) {
            session.name = name;
            Some(session.clone())
        } else {
            None
        }
    }

    /// Associates a branch (and optional worktree path) with an existing session.
    /// Returns the updated config, or `None` if the session does not exist.
    pub fn assign_branch(
        &self,
        id: u32,
        branch: String,
        worktree_path: Option<String>,
    ) -> Option<SessionConfig> {
        if let Some(mut session) = self.sessions.get_mut(&id) {
            session.branch = Some(branch);
            session.worktree_path = worktree_path;
            Some(session.clone())
        } else {
            None
        }
    }

    /// Returns a snapshot of all active sessions. Order is not guaranteed.
    pub fn all_sessions(&self) -> Vec<SessionConfig> {
        self.sessions.iter().map(|e| e.value().clone()).collect()
    }

    /// Removes and returns a session. Returns `None` if not found.
    pub fn remove_session(&self, id: u32) -> Option<SessionConfig> {
        self.sessions.remove(&id).map(|(_, v)| v)
    }

    /// Returns all sessions for a specific project path.
    /// Performs an exact match on project paths.
    pub fn get_sessions_for_project(&self, project_path: &str) -> Vec<SessionConfig> {
        self.sessions
            .iter()
            .filter(|entry| entry.value().project_path == project_path)
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Removes all sessions. Returns the number of sessions that were cleared.
    /// Used to clean up stale session entries when the frontend reloads.
    pub fn clear_all(&self) -> usize {
        let count = self.sessions.len();
        self.sessions.clear();
        count
    }

    /// Removes all sessions for a project. Returns the removed configs.
    /// Useful when closing a project tab.
    pub fn remove_sessions_for_project(&self, project_path: &str) -> Vec<SessionConfig> {
        let ids_to_remove: Vec<u32> = self
            .sessions
            .iter()
            .filter(|entry| entry.value().project_path == project_path)
            .map(|entry| *entry.key())
            .collect();

        ids_to_remove
            .into_iter()
            .filter_map(|id| self.sessions.remove(&id).map(|(_, v)| v))
            .collect()
    }
}
