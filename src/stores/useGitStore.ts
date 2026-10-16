import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { invalidateCurrentBranchCache } from "@/lib/git";

/** Branch info returned from the backend. */
export interface BranchInfo {
  name: string;
  is_remote: boolean;
  is_current: boolean;
}

/** Commit info returned from the backend. */
export interface CommitInfo {
  hash: string;
  short_hash: string;
  parent_hashes: string[];
  author_name: string;
  author_email: string;
  timestamp: number;
  summary: string;
}

/** File change status enum. */
export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";

/** File changed in a commit. */
export interface FileChange {
  path: string;
  status: FileChangeStatus;
  old_path?: string;
}

/** Git user configuration. */
export interface GitUserConfig {
  name: string | null;
  email: string | null;
}

/** Remote repository info. */
export interface RemoteInfo {
  name: string;
  url: string;
}

/** Remote connection status. */
export type RemoteStatus = "unknown" | "checking" | "connected" | "disconnected";

/**
 * Zustand store for centralized git state management.
 *
 * Handles branches, commits, user config, and remotes for the active repository.
 */
interface GitState {
  // Branch state
  currentBranch: string | null;
  branches: BranchInfo[];

  // Commit state
  commits: CommitInfo[];
  hasMoreCommits: boolean;

  // Config state
  userConfig: GitUserConfig | null;
  remotes: RemoteInfo[];
  remoteStatuses: Record<string, RemoteStatus>;
  defaultBranch: string | null;

  // Fetch state
  isFetching: boolean;
  fetchingRemotes: Record<string, boolean>;

  // Loading/error state
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;

  /**
   * Repo the display data (branches/commits/currentBranch) belongs to.
   * Fetches stamp it synchronously and drop their response if a fetch for
   * another repo superseded them — a slow response for the previous repo
   * must not overwrite the current repo's panel.
   */
  activeRepoPath: string | null;

  // Actions
  fetchBranches: (repoPath: string) => Promise<void>;
  fetchCurrentBranch: (repoPath: string) => Promise<void>;
  fetchCommits: (repoPath: string, maxCount?: number, allBranches?: boolean) => Promise<void>;
  loadMoreCommits: (repoPath: string, allBranches?: boolean) => Promise<void>;
  checkoutBranch: (repoPath: string, branchName: string) => Promise<void>;
  createBranch: (repoPath: string, branchName: string, startPoint?: string) => Promise<void>;
  deleteBranch: (repoPath: string, branchName: string, force?: boolean) => Promise<void>;
  renameBranch: (repoPath: string, oldName: string, newName: string) => Promise<void>;
  deleteRemoteBranch: (repoPath: string, remoteName: string, branchName: string) => Promise<void>;
  fetchUserConfig: (repoPath: string) => Promise<void>;
  setUserConfig: (
    repoPath: string,
    name: string | null,
    email: string | null,
    global?: boolean,
  ) => Promise<void>;
  fetchRemotes: (repoPath: string) => Promise<void>;
  addRemote: (repoPath: string, name: string, url: string) => Promise<void>;
  removeRemote: (repoPath: string, name: string) => Promise<void>;
  setRemoteUrl: (repoPath: string, name: string, url: string) => Promise<void>;
  testRemote: (repoPath: string, remoteName: string) => Promise<void>;
  testAllRemotes: (repoPath: string) => Promise<void>;
  fetchRemoteRefs: (repoPath: string, remoteName: string) => Promise<void>;
  fetchAllRemoteRefs: (repoPath: string) => Promise<void>;
  fetchDefaultBranch: (repoPath: string) => Promise<void>;
  setDefaultBranch: (repoPath: string, branch: string, global?: boolean) => Promise<void>;
  getCommitFiles: (repoPath: string, commitHash: string) => Promise<FileChange[]>;
  getRefsForCommit: (repoPath: string, commitHash: string) => Promise<string[]>;
  reset: () => void;
}

const INITIAL_COMMIT_COUNT = 50;
const LOAD_MORE_COUNT = 50;

/**
 * Per-fetch request counters for the settings-panel reads.
 *
 * These fire on every repo change (tab switch, eagle git carousel swipe) and
 * run as real concurrent git subprocesses, so a slow response for the previous
 * repo can land after the new repo's and stick — nothing refetches afterwards.
 * They deliberately do NOT use `activeRepoPath`: that stamp belongs to the
 * branch/commit display data, and writing it here would make these reads
 * supersede an in-flight branch fetch for a different repo.
 */
let remotesSeq = 0;
let userConfigSeq = 0;
let defaultBranchSeq = 0;

export const useGitStore = create<GitState>()((set, get) => ({
  // Initial state
  currentBranch: null,
  branches: [],
  commits: [],
  hasMoreCommits: true,
  userConfig: null,
  remotes: [],
  remoteStatuses: {},
  defaultBranch: null,
  isFetching: false,
  fetchingRemotes: {},
  isLoading: false,
  isLoadingMore: false,
  error: null,
  activeRepoPath: null,

  fetchBranches: async (repoPath: string) => {
    set({ activeRepoPath: repoPath, isLoading: true, error: null });
    try {
      const branches = await invoke<BranchInfo[]>("git_branches", { repoPath });
      if (get().activeRepoPath !== repoPath) return; // superseded by another repo
      set({ branches, isLoading: false });
    } catch (err) {
      if (get().activeRepoPath !== repoPath) return;
      console.error("Failed to fetch branches:", err);
      set({ error: String(err), isLoading: false, branches: [] });
    }
  },

  fetchCurrentBranch: async (repoPath: string) => {
    set({ activeRepoPath: repoPath });
    try {
      const currentBranch = await invoke<string>("git_current_branch", { repoPath });
      if (get().activeRepoPath !== repoPath) return; // superseded by another repo
      set({ currentBranch });
    } catch (err) {
      if (get().activeRepoPath !== repoPath) return;
      console.error("Failed to fetch current branch:", err);
      set({ currentBranch: null });
    }
  },

  fetchCommits: async (repoPath: string, maxCount = INITIAL_COMMIT_COUNT, allBranches = true) => {
    set({ activeRepoPath: repoPath, isLoading: true, error: null });
    try {
      const commits = await invoke<CommitInfo[]>("git_commit_log", {
        repoPath,
        maxCount,
        allBranches,
      });
      if (get().activeRepoPath !== repoPath) return; // superseded by another repo
      set({
        commits,
        isLoading: false,
        hasMoreCommits: commits.length >= maxCount,
      });
    } catch (err) {
      if (get().activeRepoPath !== repoPath) return;
      console.error("Failed to fetch commits:", err);
      set({ error: String(err), isLoading: false, commits: [] });
    }
  },

  loadMoreCommits: async (repoPath: string, allBranches = true) => {
    const { commits, hasMoreCommits, isLoadingMore } = get();
    if (!hasMoreCommits || isLoadingMore) return;

    set({ activeRepoPath: repoPath, isLoadingMore: true });
    try {
      const newCount = commits.length + LOAD_MORE_COUNT;
      const allCommits = await invoke<CommitInfo[]>("git_commit_log", {
        repoPath,
        maxCount: newCount,
        allBranches,
      });
      if (get().activeRepoPath !== repoPath) return; // superseded by another repo
      set({
        commits: allCommits,
        isLoadingMore: false,
        hasMoreCommits: allCommits.length >= newCount,
      });
    } catch (err) {
      if (get().activeRepoPath !== repoPath) return;
      console.error("Failed to load more commits:", err);
      set({ isLoadingMore: false });
    }
  },

  checkoutBranch: async (repoPath: string, branchName: string) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("git_checkout_branch", { repoPath, branchName });
      // The branch just changed, so the shared TTL cache is now wrong. Drop it
      // before anything re-reads, or every terminal header on this repo shows
      // the old branch until the TTL expires.
      invalidateCurrentBranchCache(repoPath);
      // Refresh current branch and commits after checkout
      const currentBranch = await invoke<string>("git_current_branch", { repoPath });
      set({ currentBranch, isLoading: false });
      // Refresh commits
      get().fetchCommits(repoPath);
    } catch (err) {
      console.error("Failed to checkout branch:", err);
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },

  createBranch: async (repoPath: string, branchName: string, startPoint?: string) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("git_create_branch", {
        repoPath,
        branchName,
        startPoint: startPoint ?? null,
      });
      // Refresh branches after creation
      await get().fetchBranches(repoPath);
      set({ isLoading: false });
    } catch (err) {
      console.error("Failed to create branch:", err);
      set({ error: String(err), isLoading: false });
      throw err;
    }
  },

  deleteBranch: async (repoPath: string, branchName: string, force = false) => {
    set({ error: null });
    try {
      await invoke("git_delete_branch", { repoPath, branchName, force });
      await get().fetchBranches(repoPath);
    } catch (err) {
      console.error("Failed to delete branch:", err);
      set({ error: String(err) });
      throw err;
    }
  },

  renameBranch: async (repoPath: string, oldName: string, newName: string) => {
    set({ error: null });
    try {
      await invoke("git_rename_branch", { repoPath, oldName, newName });
      // Renaming the checked-out branch changes the current branch name too.
      await get().fetchCurrentBranch(repoPath);
      await get().fetchBranches(repoPath);
    } catch (err) {
      console.error("Failed to rename branch:", err);
      set({ error: String(err) });
      throw err;
    }
  },

  deleteRemoteBranch: async (repoPath: string, remoteName: string, branchName: string) => {
    set({ error: null });
    try {
      await invoke("git_delete_remote_branch", { repoPath, remoteName, branchName });
      // `git push --delete` also drops the local remote-tracking ref, so a
      // plain branch refetch is enough for the row to disappear.
      await get().fetchBranches(repoPath);
    } catch (err) {
      console.error("Failed to delete remote branch:", err);
      set({ error: String(err) });
      throw err;
    }
  },

  fetchUserConfig: async (repoPath: string) => {
    const seq = ++userConfigSeq;
    try {
      const userConfig = await invoke<GitUserConfig>("git_user_config", { repoPath });
      if (seq !== userConfigSeq) return; // superseded by a later repo
      set({ userConfig });
    } catch (err) {
      if (seq !== userConfigSeq) return;
      console.error("Failed to fetch user config:", err);
      set({ userConfig: null });
    }
  },

  setUserConfig: async (
    repoPath: string,
    name: string | null,
    email: string | null,
    global = false,
  ) => {
    try {
      await invoke("git_set_user_config", {
        repoPath,
        name,
        email,
        global,
      });
      // Refresh config
      await get().fetchUserConfig(repoPath);
    } catch (err) {
      console.error("Failed to set user config:", err);
      throw err;
    }
  },

  fetchRemotes: async (repoPath: string) => {
    const seq = ++remotesSeq;
    try {
      const remotes = await invoke<RemoteInfo[]>("git_list_remotes", { repoPath });
      if (seq !== remotesSeq) return; // superseded by a later repo
      set({ remotes });
    } catch (err) {
      if (seq !== remotesSeq) return;
      console.error("Failed to fetch remotes:", err);
      set({ remotes: [] });
    }
  },

  addRemote: async (repoPath: string, name: string, url: string) => {
    try {
      await invoke("git_add_remote", { repoPath, name, url });
      await get().fetchRemotes(repoPath);
    } catch (err) {
      console.error("Failed to add remote:", err);
      throw err;
    }
  },

  removeRemote: async (repoPath: string, name: string) => {
    try {
      await invoke("git_remove_remote", { repoPath, name });
      // Also remove from remoteStatuses
      const { remoteStatuses } = get();
      const newStatuses = { ...remoteStatuses };
      delete newStatuses[name];
      set({ remoteStatuses: newStatuses });
      await get().fetchRemotes(repoPath);
    } catch (err) {
      console.error("Failed to remove remote:", err);
      throw err;
    }
  },

  setRemoteUrl: async (repoPath: string, name: string, url: string) => {
    try {
      await invoke("git_set_remote_url", { repoPath, name, url });
      await get().fetchRemotes(repoPath);
    } catch (err) {
      console.error("Failed to set remote URL:", err);
      throw err;
    }
  },

  testRemote: async (repoPath: string, remoteName: string) => {
    // Set status to checking
    set((state) => ({
      remoteStatuses: { ...state.remoteStatuses, [remoteName]: "checking" },
    }));
    try {
      const connected = await invoke<boolean>("git_test_remote", { repoPath, remoteName });
      set((state) => ({
        remoteStatuses: {
          ...state.remoteStatuses,
          [remoteName]: connected ? "connected" : "disconnected",
        },
      }));
    } catch (err) {
      console.error("Failed to test remote:", err);
      set((state) => ({
        remoteStatuses: { ...state.remoteStatuses, [remoteName]: "disconnected" },
      }));
    }
  },

  testAllRemotes: async (repoPath: string) => {
    const { remotes } = get();
    // Set all to checking
    const checkingStatuses: Record<string, RemoteStatus> = {};
    for (const remote of remotes) {
      checkingStatuses[remote.name] = "checking";
    }
    set({ remoteStatuses: checkingStatuses });

    // Test all in parallel
    await Promise.all(remotes.map((remote) => get().testRemote(repoPath, remote.name)));
  },

  fetchRemoteRefs: async (repoPath: string, remoteName: string) => {
    set((state) => ({
      fetchingRemotes: { ...state.fetchingRemotes, [remoteName]: true },
    }));
    try {
      await invoke("git_fetch", { repoPath, remoteName });
    } catch (err) {
      console.error(`Failed to fetch remote '${remoteName}':`, err);
      throw err;
    } finally {
      set((state) => ({
        fetchingRemotes: { ...state.fetchingRemotes, [remoteName]: false },
      }));
    }
  },

  fetchAllRemoteRefs: async (repoPath: string) => {
    set({ isFetching: true, error: null });
    try {
      await invoke("git_fetch_all", { repoPath });
    } catch (err) {
      console.error("Failed to fetch all remotes:", err);
      set({ error: String(err) });
      throw err;
    } finally {
      set({ isFetching: false });
    }
  },

  fetchDefaultBranch: async (repoPath: string) => {
    const seq = ++defaultBranchSeq;
    try {
      const defaultBranch = await invoke<string | null>("git_get_default_branch", { repoPath });
      if (seq !== defaultBranchSeq) return; // superseded by a later repo
      set({ defaultBranch });
    } catch (err) {
      if (seq !== defaultBranchSeq) return;
      console.error("Failed to fetch default branch:", err);
      set({ defaultBranch: null });
    }
  },

  setDefaultBranch: async (repoPath: string, branch: string, global = false) => {
    try {
      await invoke("git_set_default_branch", { repoPath, branch, global });
      await get().fetchDefaultBranch(repoPath);
    } catch (err) {
      console.error("Failed to set default branch:", err);
      throw err;
    }
  },

  getCommitFiles: async (repoPath: string, commitHash: string): Promise<FileChange[]> => {
    try {
      return await invoke<FileChange[]>("git_commit_files", { repoPath, commitHash });
    } catch (err) {
      console.error("Failed to get commit files:", err);
      return [];
    }
  },

  getRefsForCommit: async (repoPath: string, commitHash: string): Promise<string[]> => {
    try {
      return await invoke<string[]>("git_refs_for_commit", { repoPath, commitHash });
    } catch (err) {
      console.error("Failed to get refs for commit:", err);
      return [];
    }
  },

  reset: () => {
    set({
      currentBranch: null,
      branches: [],
      commits: [],
      hasMoreCommits: true,
      userConfig: null,
      remotes: [],
      remoteStatuses: {},
      defaultBranch: null,
      isFetching: false,
      fetchingRemotes: {},
      isLoading: false,
      isLoadingMore: false,
      error: null,
      activeRepoPath: null,
    });
  },
}));
