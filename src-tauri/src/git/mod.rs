pub mod error;
pub mod ops;
pub mod runner;

pub use error::GitError;
pub use ops::{
    BranchInfo, CommitInfo, FileChange, FileChangeStatus, FileStatusEntry, FileStatusKind,
    GitUserConfig, RemoteInfo, StashEntry, UnpushedCommit, WorktreeInfo, WorktreeStatus,
};
pub use runner::Git;
