import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Edit2,
  FileText,
  FolderGit2,
  GitBranch,
  Home,
  Info,
  Keyboard,
  Loader2,
  Moon,
  Package,
  Plus,
  PlusCircle,
  RefreshCw,
  Server,
  Settings,
  Square,
  Store,
  Sun,
  Trash2,
  User,
  Wrench,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useGitStore } from "@/stores/useGitStore";
import { useMcpStore } from "@/stores/useMcpStore";
import { usePluginStore } from "@/stores/usePluginStore";
import { useMarketplaceStore } from "@/stores/useMarketplaceStore";
import { useWorkspaceStore } from "@/stores/useWorkspaceStore";
import { GitSettingsModal, RemoteStatusIndicator } from "@/components/git";
import { MarketplaceBrowser } from "@/components/marketplace";
import { McpServerEditorModal } from "@/components/mcp";
import { ContextDocEditorModal } from "@/components/claudemd";
import { CliSettingsModal } from "@/components/terminal/CliSettingsModal";
import { TerminalSettingsModal } from "@/components/terminal/TerminalSettingsModal";
import { MaestroSettingsModal, ShortcutsModal } from "@/components/settings";
import type { McpCustomServer, McpServerConfig } from "@/lib/mcp";
import { listContextDocs, readContextDoc, type ContextDoc } from "@/lib/claudemd";

interface SidebarProps {
  collapsed?: boolean;
  onCollapse?: () => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  /** Number of running sessions in the active project (drives Stop All visibility). */
  launchedCount?: number;
  /** Whether Stop All is currently running. */
  isStoppingAll?: boolean;
  /** Stop all running sessions in the active project. */
  onStopAll?: () => void;
}

/* ── Shared card class ── */
const cardClass =
  "sidebar-card-link rounded-lg border border-maestro-border/60 bg-maestro-card p-3 overflow-hidden shadow-[0_1px_4px_rgb(0_0_0/0.15),0_0_0_1px_rgb(255_255_255/0.03)_inset] transition-shadow hover:shadow-[0_2px_8px_rgb(0_0_0/0.25),0_0_0_1px_rgb(255_255_255/0.05)_inset]";

const divider = <div className="h-px bg-maestro-border/30 my-1" />;

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 320;
const SIDEBAR_COLLAPSE_THRESHOLD = 60;
const SIDEBAR_WIDTH_STEP = 4;

/* ================================================================ */
/*  SIDEBAR ROOT                                                     */
/* ================================================================ */

export function Sidebar({
  collapsed,
  onCollapse,
  theme,
  onToggleTheme,
  launchedCount = 0,
  isStoppingAll = false,
  onStopAll,
}: SidebarProps) {
  const [width, setWidth] = useState(240);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; w: number } | null>(null);
  const sidebarWidthClass = collapsed ? "w-0" : `sidebar-w-${width}`;

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, w: width };
    },
    [width],
  );

  const clampWidth = useCallback((value: number) => {
    const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
    const snapped = Math.round(clamped / SIDEBAR_WIDTH_STEP) * SIDEBAR_WIDTH_STEP;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, snapped));
  }, []);

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let next = width;
      const smallStep = 8;
      const largeStep = 24;

      switch (e.key) {
        case "ArrowLeft":
          next = width - smallStep;
          break;
        case "ArrowRight":
          next = width + smallStep;
          break;
        case "PageDown":
          next = width - largeStep;
          break;
        case "PageUp":
          next = width + largeStep;
          break;
        case "Home":
          next = SIDEBAR_MIN_WIDTH;
          break;
        case "End":
          next = SIDEBAR_MAX_WIDTH;
          break;
        default:
          return;
      }

      e.preventDefault();
      if (next < SIDEBAR_COLLAPSE_THRESHOLD) {
        onCollapse?.();
        return;
      }
      setWidth(clampWidth(next));
    },
    [width, onCollapse, clampWidth],
  );

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const raw = dragStartRef.current.w + (e.clientX - dragStartRef.current.x);
      if (raw < SIDEBAR_COLLAPSE_THRESHOLD) {
        setIsDragging(false);
        onCollapse?.();
        return;
      }
      setWidth(clampWidth(raw));
    };

    const onUp = () => setIsDragging(false);

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [isDragging, onCollapse, clampWidth]);

  return (
    // Use a class-based width to avoid inline styles (CSP-friendly).
    <aside
      className={`theme-transition no-select relative flex h-full flex-col border-r border-maestro-border bg-maestro-surface ${sidebarWidthClass} ${
        isDragging ? "" : "transition-all duration-200 ease-out"
      } ${collapsed ? "overflow-hidden border-r-0 opacity-0" : "opacity-100"}`}
    >
      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-2.5 py-3">
        <ConfigTab
          theme={theme}
          onToggleTheme={onToggleTheme}
          launchedCount={launchedCount}
          isStoppingAll={isStoppingAll}
          onStopAll={onStopAll}
        />
      </div>

      {/* Drag handle */}
      {!collapsed && (
        // biome-ignore lint/a11y/useSemanticElements: Vertical resizer requires interactive div for pointer/keyboard handling.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={Math.round(width)}
          aria-valuetext={`${Math.round(width)} pixels`}
          tabIndex={0}
          aria-label="Resize sidebar"
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-maestro-accent/30 active:bg-maestro-accent/40"
          onMouseDown={handleDragStart}
          onKeyDown={handleResizeKeyDown}
        />
      )}
    </aside>
  );
}

/* ================================================================ */
/*  SECTION HEADER (reusable)                                        */
/* ================================================================ */

function SectionHeader({
  icon: Icon,
  label,
  breathe = false,
  iconColor,
  badge,
  right,
}: {
  icon: React.ElementType;
  label: string;
  breathe?: boolean;
  iconColor?: string;
  badge?: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
      <Icon
        size={13}
        className={`${iconColor ?? "text-maestro-muted/80"} ${breathe ? "animate-breathe" : ""}`}
      />
      <span className="flex-1">{label}</span>
      {badge}
      {right}
    </div>
  );
}

/* ================================================================ */
/*  CONFIG TAB                                                       */
/* ================================================================ */

function ConfigTab({
  theme,
  onToggleTheme,
  launchedCount = 0,
  isStoppingAll = false,
  onStopAll,
}: {
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  launchedCount?: number;
  isStoppingAll?: boolean;
  onStopAll?: () => void;
}) {
  return (
    <>
      <GitRepositorySection />
      {divider}
      <ProjectContextSection />
      {divider}
      <ExtensionsSection />
      {divider}
      <AppearanceSection
        theme={theme}
        onToggle={onToggleTheme}
        launchedCount={launchedCount}
        isStoppingAll={isStoppingAll}
        onStopAll={onStopAll}
      />
    </>
  );
}

/* ── 1. Git Repository ── */

/** Shortens a filesystem path for display by keeping the last 2-3 segments. */
function shortenPath(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  if (segments.length <= 3) return path;
  return `.../${segments.slice(-3).join("/")}`;
}

function GitRepositorySection() {
  const [showSettings, setShowSettings] = useState(false);
  const [defaultWorktreeBase, setDefaultWorktreeBase] = useState<string | null>(null);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const repoPath = activeTab?.projectPath ?? "";
  const worktreeBasePath = activeTab?.worktreeBasePath ?? null;

  const { userConfig, remotes, remoteStatuses, fetchUserConfig, fetchRemotes, testAllRemotes } =
    useGitStore();

  // Fetch default worktree base dir on mount
  useEffect(() => {
    invoke<string>("get_default_worktree_base_dir").then(setDefaultWorktreeBase).catch(() => {});
  }, []);

  // Fetch data on mount and when repoPath changes
  useEffect(() => {
    if (!repoPath) return;
    fetchUserConfig(repoPath);
    fetchRemotes(repoPath);
  }, [repoPath, fetchUserConfig, fetchRemotes]);

  // Test remotes after fetching them
  useEffect(() => {
    if (!repoPath || remotes.length === 0) return;
    // Only test if we don't have statuses yet
    const hasStatuses = remotes.some((r) => remoteStatuses[r.name] !== undefined);
    if (!hasStatuses) {
      testAllRemotes(repoPath);
    }
  }, [repoPath, remotes, remoteStatuses, testAllRemotes]);

  const hasUser = userConfig?.name || userConfig?.email;
  const displayName = userConfig?.name || "Not configured";
  const displayEmail = userConfig?.email || "No email set";

  // Format remote URL for display (shorten GitHub URLs)
  const formatRemoteUrl = (url: string) => {
    // git@github.com:user/repo.git -> github.com/user/repo
    // https://github.com/user/repo.git -> github.com/user/repo
    const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (match) {
      return `github.com/${match[1]}`;
    }
    // For other URLs, just show the host/path
    try {
      const parsed = new URL(url.replace(/^git@/, "https://").replace(/:(?!\/\/)/, "/"));
      return `${parsed.host}${parsed.pathname.replace(/\.git$/, "")}`;
    } catch {
      return url;
    }
  };

  if (!repoPath) {
    return (
      <div className={cardClass}>
        <SectionHeader
          icon={GitBranch}
          label="Git Repository"
          iconColor="text-maestro-muted"
        />
        <div className="px-1 py-1 text-xs text-maestro-muted">No project selected</div>
      </div>
    );
  }

  return (
    <>
      <div className={cardClass}>
        <SectionHeader
          icon={GitBranch}
          label="Git Repository"
          iconColor="text-maestro-green"
          right={
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="rounded p-0.5 hover:bg-maestro-border/40"
              title="Git settings"
            >
              <Settings size={12} className="text-maestro-muted" />
            </button>
          }
        />
        {/* User */}
        <div className="flex items-center gap-2 px-1 py-1">
          <User size={12} className={hasUser ? "text-maestro-green" : "text-maestro-muted"} />
          <span className="text-xs font-semibold text-maestro-text truncate">{displayName}</span>
        </div>
        <div className="pl-5 text-[11px] text-maestro-muted truncate">{displayEmail}</div>

        {/* Remotes */}
        {remotes.length === 0 ? (
          <div className="mt-2 px-1 py-1 text-xs text-maestro-muted">No remotes configured</div>
        ) : (
          remotes.map((remote) => (
            <div key={remote.name} className="mt-1">
              <div className="flex items-center gap-2 px-1 py-1">
                <RemoteStatusIndicator status={remoteStatuses[remote.name] ?? "unknown"} />
                <span className="text-xs font-semibold text-maestro-text truncate">
                  {remote.name}
                </span>
              </div>
              <div className="pl-5 text-[11px] text-maestro-muted truncate">
                {formatRemoteUrl(remote.url)}
              </div>
            </div>
          ))
        )}

        {/* Worktree base path */}
        {(worktreeBasePath || defaultWorktreeBase) && (
          <div className="mt-2 border-t border-maestro-border/30 pt-2 min-w-0 overflow-hidden">
            <div className="flex items-center gap-2 px-1 py-1 min-w-0">
              <FolderGit2 size={12} className="text-maestro-accent shrink-0" />
              <span className="text-xs font-semibold text-maestro-text truncate min-w-0">Worktrees</span>
              {!worktreeBasePath && (
                <span className="text-[10px] text-maestro-muted/60 shrink-0">(default)</span>
              )}
            </div>
            <div
              className="pl-5 text-[11px] text-maestro-muted truncate min-w-0 overflow-hidden"
              title={worktreeBasePath ?? defaultWorktreeBase ?? ""}
            >
              {shortenPath(worktreeBasePath ?? defaultWorktreeBase ?? "")}
            </div>
          </div>
        )}
      </div>

      {showSettings && (
        <GitSettingsModal repoPath={repoPath} tabId={activeTab?.id ?? ""} onClose={() => setShowSettings(false)} />
      )}
    </>
  );
}

/* ── 2. Project Context ── */

const TIER_LABEL: Record<ContextDoc["tier"], string> = {
  user: "User",
  project: "Project",
};

const TIER_ORDER: ContextDoc["tier"][] = ["user", "project"];

function ProjectContextSection() {
  const [docs, setDocs] = useState<ContextDoc[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editing, setEditing] = useState<{ doc: ContextDoc; content: string } | null>(null);

  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await listContextDocs(projectPath);
      setDocs(result);
    } catch (err) {
      console.error("Failed to list context docs:", err);
      setDocs([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleOpen = async (doc: ContextDoc) => {
    try {
      const content = doc.exists ? await readContextDoc(doc.path) : "";
      setEditing({ doc, content });
    } catch (err) {
      console.error(`Failed to read ${doc.path}:`, err);
      setEditing({ doc, content: "" });
    }
  };

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await refresh();
  };

  const grouped = TIER_ORDER.map((tier) => ({
    tier,
    items: docs.filter((d) => d.tier === tier),
  })).filter((g) => g.items.length > 0);

  const anyExists = docs.some((d) => d.exists);

  return (
    <>
      <div className={cardClass}>
        <SectionHeader
          icon={FileText}
          label="Project Context"
          iconColor={anyExists ? "text-maestro-green" : "text-maestro-muted"}
          right={
            <button
              type="button"
              onClick={handleRefresh}
              className="rounded p-0.5 hover:bg-maestro-border/40"
              disabled={isLoading}
            >
              <RefreshCw
                size={12}
                className={`text-maestro-muted ${isLoading ? "animate-spin" : ""}`}
              />
            </button>
          }
        />

        {isLoading && docs.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-1">
            <Loader2 size={13} className="text-maestro-muted shrink-0 animate-spin" />
            <span className="text-xs text-maestro-muted">Checking...</span>
          </div>
        ) : grouped.length === 0 ? (
          <div className="px-1 py-1 text-xs text-maestro-muted">No context docs</div>
        ) : (
          <div className="space-y-1.5">
            {grouped.map(({ tier, items }) => (
              <div key={tier}>
                <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-maestro-muted/70">
                  {TIER_LABEL[tier]}
                </div>
                <div className="space-y-0.5">
                  {items.map((doc) => (
                    <button
                      key={doc.path}
                      type="button"
                      title={doc.path}
                      onClick={() => handleOpen(doc)}
                      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-maestro-border/40"
                    >
                      {doc.exists ? (
                        <Check size={13} className="text-maestro-green shrink-0" />
                      ) : (
                        <AlertTriangle size={13} className="text-maestro-orange/70 shrink-0" />
                      )}
                      <span
                        className={`flex-1 truncate text-xs ${
                          doc.exists ? "text-maestro-text" : "text-maestro-muted"
                        }`}
                      >
                        {doc.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ContextDocEditorModal
          path={editing.doc.path}
          label={editing.doc.label}
          tier={editing.doc.tier}
          kind={editing.doc.kind}
          exists={editing.doc.exists}
          initialContent={editing.content}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refresh();
          }}
        />
      )}
    </>
  );
}

/* ── 3. Extensions (MCP, Plugins & Skills) ── */

/**
 * Single sidebar panel that combines MCP servers, plugins and skills into one
 * mini-pane. Each concern keeps its own collapsible sub-group + actions, but
 * they share a single card container so the sidebar reads as one panel.
 */
function ExtensionsSection() {
  return (
    <div className={cardClass}>
      <SectionHeader icon={Package} label="MCP, Plugins & Skills" iconColor="text-maestro-purple" />
      <MCPServersSection />
      <div className="my-1.5 h-px bg-maestro-border/30" />
      <PluginsSection />
    </div>
  );
}

/**
 * Renders a labelled group of MCP servers for one scope (project / local / user).
 * Shows nothing when the group is empty so the section stays compact.
 *
 * Status dot: green = configured (Claude will load it on session launch).
 * No live "running" check exists yet — the indicator reflects configured state.
 */
function McpScopeGroup({
  label,
  servers,
}: {
  label: string;
  servers: McpServerConfig[];
}) {
  if (servers.length === 0) return null;
  return (
    <>
      <div className="px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-maestro-muted/60">
        {label} ({servers.length})
      </div>
      {servers.map((server) => {
        const isHttp = server.type === "http";
        return (
          <div
            key={`${server.source ?? "project"}:${server.name}`}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-maestro-text hover:bg-maestro-border/40"
          >
            <span
              title="Configured — loaded into sessions on launch"
              className="h-2 w-2 shrink-0 rounded-full bg-maestro-green"
            />
            <span className="flex-1 truncate font-medium">{server.name}</span>
            <span className="text-[10px] text-maestro-muted">
              {isHttp ? "HTTP" : "stdio"}
            </span>
          </div>
        );
      })}
    </>
  );
}

function MCPServersSection() {
  const [expanded, setExpanded] = useState(false);
  const [showEditorModal, setShowEditorModal] = useState(false);
  const [editingServer, setEditingServer] = useState<McpCustomServer | undefined>(undefined);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  const {
    projectServers,
    customServers,
    customServersLoaded,
    fetchProjectServers,
    refreshProjectServers,
    fetchCustomServers,
    deleteCustomServer,
    isLoading,
  } = useMcpStore();

  // Filter out the internal "maestro" server - it's shown in the dedicated Maestro MCP section
  const discoveredServers = projectPath
    ? (projectServers[projectPath] ?? []).filter((s) => s.name !== "maestro")
    : [];
  const loading = projectPath ? (isLoading[projectPath] ?? false) : false;

  // Total count includes discovered + custom servers
  const totalCount = discoveredServers.length + customServers.length;

  // Fetch servers when project changes
  useEffect(() => {
    if (projectPath) {
      fetchProjectServers(projectPath);
    }
  }, [projectPath, fetchProjectServers]);

  // Fetch custom servers on mount
  useEffect(() => {
    if (!customServersLoaded) {
      fetchCustomServers();
    }
  }, [customServersLoaded, fetchCustomServers]);

  const handleRefresh = useCallback(() => {
    if (projectPath) {
      refreshProjectServers(projectPath);
    }
    fetchCustomServers();
  }, [projectPath, refreshProjectServers, fetchCustomServers]);

  const handleAddServer = () => {
    setEditingServer(undefined);
    setShowEditorModal(true);
  };

  const handleEditServer = (server: McpCustomServer) => {
    setEditingServer(server);
    setShowEditorModal(true);
  };

  const handleDeleteServer = async (serverId: string) => {
    try {
      await deleteCustomServer(serverId);
    } catch (err) {
      console.error("Failed to delete custom MCP server:", err);
    }
  };

  return (
    <>
      <div>
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 hover:text-maestro-text"
          >
            {expanded ? (
              <ChevronDown size={13} className="text-maestro-muted/80" />
            ) : (
              <ChevronRight size={13} className="text-maestro-muted/80" />
            )}
          </button>
          <Server size={13} className={totalCount > 0 ? "text-maestro-green" : "text-maestro-muted/80"} />
          <span className="flex-1">MCP Servers</span>
          {totalCount > 0 && (
            <span className="bg-maestro-green/20 text-maestro-green text-[10px] px-1.5 rounded-full font-bold">
              {totalCount}
            </span>
          )}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleRefresh}
              className="rounded p-0.5 hover:bg-maestro-border/40"
              title="Refresh MCP servers"
            >
              <RefreshCw size={12} className={`text-maestro-muted ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={handleAddServer}
              className="rounded p-0.5 hover:bg-maestro-border/40"
              title="Add custom MCP server"
            >
              <Plus size={12} className="text-maestro-accent" />
            </button>
          </div>
        </div>

        {expanded && (
          <div className="space-y-0.5">
            {/* Discovered servers grouped by scope. Project = repo's .mcp.json,
                Local = ~/.claude.json projects[path] (per-machine), User = top-level
                ~/.claude.json (user-global). */}
            <McpScopeGroup
              label="Project (.mcp.json)"
              servers={discoveredServers.filter((s) => (s.source ?? "project") === "project")}
            />
            <McpScopeGroup
              label="Local (this machine)"
              servers={discoveredServers.filter((s) => s.source === "local")}
            />
            <McpScopeGroup
              label="User (global)"
              servers={discoveredServers.filter((s) => s.source === "user")}
            />

            {/* Custom servers */}
            {customServers.length > 0 && (
              <>
                <div className="px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-maestro-muted/60">
                  Custom ({customServers.length})
                </div>
                {customServers.map((server) => (
                  <div
                    key={server.id}
                    className="group flex items-center gap-2 rounded-md px-2 py-1 text-xs text-maestro-text hover:bg-maestro-border/40"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        server.isEnabled ? "bg-maestro-green" : "bg-maestro-muted"
                      }`}
                    />
                    <span className="flex-1 truncate font-medium">{server.name}</span>
                    <span className="text-[10px] text-maestro-muted">custom</span>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={() => handleEditServer(server)}
                        className="rounded p-0.5 hover:bg-maestro-border/40"
                        title="Edit server"
                      >
                        <Edit2 size={10} className="text-maestro-muted" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteServer(server.id)}
                        className="rounded p-0.5 hover:bg-maestro-red/10"
                        title="Delete server"
                      >
                        <Trash2 size={10} className="text-maestro-red" />
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Empty state */}
            {totalCount === 0 && (
              <div className="px-2 py-1 text-[11px] text-maestro-muted/60">
                No MCP servers configured
              </div>
            )}
          </div>
        )}
      </div>

      {/* Editor Modal */}
      {showEditorModal && (
        <McpServerEditorModal
          server={editingServer}
          onClose={() => setShowEditorModal(false)}
          onSaved={() => fetchCustomServers()}
        />
      )}
    </>
  );
}

/* ── 6. Plugins & Skills ── */

import type { PluginConfig, SkillConfig, SkillSource } from "@/lib/plugins";

/** Maps a plugin source to a coarse Project/User/Global scope. */
type PluginScope = "project" | "user" | "global";
function pluginScope(p: PluginConfig): PluginScope {
  switch (p.plugin_source) {
    case "project":
      return "project";
    case "builtin":
      return "global";
    case "installed":
    case "marketplace":
    case "cli_installed":
      return "user";
  }
}

/** Maps a skill source to a coarse Project/User scope (plugin-owned skills are grouped under their plugin). */
function skillScope(s: SkillConfig): "project" | "user" {
  return s.source.type === "project" ? "project" : "user";
}

/** Returns badge styling and text for a skill source. */
function getSkillSourceBadge(source: SkillSource): { text: string; className: string; icon: React.ElementType } {
  switch (source.type) {
    case "project":
      return {
        text: "Project",
        className: "bg-maestro-accent/20 text-maestro-accent",
        icon: FileText,
      };
    case "personal":
      return {
        text: "Personal",
        className: "bg-maestro-green/20 text-maestro-green",
        icon: Home,
      };
    case "plugin":
      return {
        text: source.name,
        className: "bg-maestro-purple/20 text-maestro-purple",
        icon: Package,
      };
    case "legacy":
      return {
        text: "Legacy",
        className: "bg-maestro-muted/20 text-maestro-muted",
        icon: FileText,
      };
  }
}

function PluginsSection() {
  const [expanded, setExpanded] = useState(false);
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());
  const [showMarketplace, setShowMarketplace] = useState(false);
  const tabs = useWorkspaceStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.active);
  const projectPath = activeTab?.projectPath ?? "";

  const { projectSkills, projectPlugins, fetchProjectPlugins, refreshProjectPlugins, isLoading, deleteSkill, deletingSkillId, deletePlugin, deletingPluginId } =
    usePluginStore();
  const { uninstallPluginById, uninstallingPluginId, installedPlugins, fetchAll: fetchMarketplace, isLoading: marketplaceLoading } = useMarketplaceStore();
  const [marketplaceFetched, setMarketplaceFetched] = useState(false);
  const skills = projectPath ? (projectSkills[projectPath] ?? []) : [];
  const plugins = projectPath ? (projectPlugins[projectPath] ?? []) : [];
  const loading = projectPath ? (isLoading[projectPath] ?? false) : false;

  // Helper to extract base name from skill ID (strip prefix like "plugin:", "project:", "personal:")
  const getSkillBaseName = (skillId: string): string => {
    const colonIndex = skillId.indexOf(":");
    return colonIndex >= 0 ? skillId.slice(colonIndex + 1) : skillId;
  };

  // Build a map of skill base name -> skill for quick lookup
  const skillByBaseName = new Map(skills.map((s) => [getSkillBaseName(s.id), s]));

  // Group skills by plugin using the plugin's skills array (matching by base name)
  const pluginSkillsMap = new Map<string, typeof skills>();
  const skillsInPlugins = new Set<string>();

  for (const plugin of plugins) {
    const pluginSkills: typeof skills = [];
    for (const skillId of plugin.skills) {
      const baseName = getSkillBaseName(skillId);
      const skill = skillByBaseName.get(baseName);
      if (skill) {
        pluginSkills.push(skill);
        skillsInPlugins.add(skill.id);
      }
    }
    if (pluginSkills.length > 0) {
      pluginSkillsMap.set(plugin.name, pluginSkills);
    }
  }

  // Standalone skills are those not claimed by any plugin
  const standaloneSkills = skills.filter((s) => !skillsInPlugins.has(s.id));

  // Total count = plugins + standalone skills
  const totalCount = plugins.length + standaloneSkills.length;

  const togglePlugin = (pluginId: string) => {
    setExpandedPlugins((prev) => {
      const next = new Set(prev);
      if (next.has(pluginId)) {
        next.delete(pluginId);
      } else {
        next.add(pluginId);
      }
      return next;
    });
  };

  // Fetch plugins when project changes
  useEffect(() => {
    if (projectPath) {
      fetchProjectPlugins(projectPath);
    }
  }, [projectPath, fetchProjectPlugins]);

  // Ensure marketplace data is loaded for uninstall functionality
  useEffect(() => {
    if (!marketplaceFetched && !marketplaceLoading) {
      setMarketplaceFetched(true);
      fetchMarketplace();
    }
  }, [marketplaceFetched, marketplaceLoading, fetchMarketplace]);

  const handleRefresh = useCallback(() => {
    if (projectPath) {
      refreshProjectPlugins(projectPath);
    }
  }, [projectPath, refreshProjectPlugins]);

  // Handle uninstalling a plugin (installed or marketplace)
  const handleUninstallPlugin = useCallback(async (e: React.MouseEvent, pluginId: string, pluginPath: string | null, pluginSource: string) => {
    e.stopPropagation();

    // For "installed" plugins (manually installed to ~/.claude/plugins/), delete directly
    if (pluginSource === "installed" && pluginPath && projectPath) {
      await deletePlugin(pluginId, pluginPath, projectPath);
      return;
    }

    // For "marketplace" plugins, use the marketplace uninstall
    const installedPlugin = installedPlugins.find(
      (p) => p.path === pluginPath || p.plugin_id === pluginId || p.id === pluginId
    );
    if (installedPlugin) {
      await uninstallPluginById(installedPlugin.id);
      // Refresh both marketplace and plugins lists
      await fetchMarketplace();
      if (projectPath) {
        await refreshProjectPlugins(projectPath);
      }
    } else {
      console.warn("Could not find installed plugin to uninstall:", { pluginId, pluginPath, pluginSource, installedPlugins });
    }
  }, [installedPlugins, uninstallPluginById, fetchMarketplace, projectPath, refreshProjectPlugins, deletePlugin]);

  // Handle deleting a standalone skill
  const handleDeleteSkill = useCallback(async (e: React.MouseEvent, skillId: string, skillPath: string | null) => {
    e.stopPropagation();
    if (!skillPath || !projectPath) return;
    // skill.path points to SKILL.md file, we need the parent directory
    const skillDir = skillPath.replace(/\/[^/]+$/, ""); // Remove filename to get directory
    await deleteSkill(skillId, skillDir, projectPath);
  }, [deleteSkill, projectPath]);

  // Check if a plugin can be uninstalled (installed or marketplace, not builtin)
  const canUninstallPlugin = (plugin: typeof plugins[0]) => {
    return plugin.plugin_source === "installed" || plugin.plugin_source === "marketplace";
  };

  // Check if a skill can be deleted (project or personal, not plugin-owned or legacy)
  const canDeleteSkill = (skill: typeof skills[0]) => {
    return (skill.source.type === "project" || skill.source.type === "personal") && skill.path;
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 hover:text-maestro-text"
        >
          {expanded ? (
            <ChevronDown size={13} className="text-maestro-muted/80" />
          ) : (
            <ChevronRight size={13} className="text-maestro-muted/80" />
          )}
        </button>
        <Store size={13} className={totalCount > 0 ? "text-maestro-purple" : "text-maestro-muted/80"} />
        <span className="flex-1">Plugins & Skills</span>
        {totalCount > 0 && (
          <span className="bg-maestro-purple/20 text-maestro-purple text-[10px] px-1.5 rounded-full font-bold">
            {totalCount}
          </span>
        )}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleRefresh}
            className="rounded p-0.5 hover:bg-maestro-border/40"
            title="Refresh plugins"
          >
            <RefreshCw size={12} className={`text-maestro-muted ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => setShowMarketplace(true)}
            className="rounded p-0.5 hover:bg-maestro-border/40"
            title="Add plugin"
          >
            <PlusCircle size={12} className="text-maestro-accent" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-0.5">
          {!projectPath ? (
            <div className="px-2 py-1 text-[11px] text-maestro-muted/60">No project selected</div>
          ) : totalCount === 0 ? (
            <>
              <div className="px-2 py-1 text-[11px] text-maestro-muted/60">
                No skills found
              </div>
              <div className="px-2 text-[10px] text-maestro-muted/40">
                Add skills to .claude/skills/ or ~/.claude/skills/
              </div>
            </>
          ) : (
            <>
              {/* Plugins grouped by scope (Project / User / Global). */}
              {plugins.length > 0 && (() => {
                const buckets: Record<PluginScope, PluginConfig[]> = {
                  project: [],
                  user: [],
                  global: [],
                };
                for (const p of plugins) buckets[pluginScope(p)].push(p);
                const scopeLabel: Record<PluginScope, string> = {
                  project: "Project Plugins",
                  user: "User Plugins",
                  global: "Global Plugins",
                };
                const order: PluginScope[] = ["project", "user", "global"];
                const renderPluginRow = (plugin: PluginConfig) => {
                    const pluginSkills = pluginSkillsMap.get(plugin.name) ?? [];
                    const isPluginExpanded = expandedPlugins.has(plugin.id);
                    // Check if plugin is being uninstalled/deleted
                    const matchingInstalled = installedPlugins.find(
                      (p) => p.path === plugin.path || p.plugin_id === plugin.id || p.id === plugin.id
                    );
                    const isUninstalling =
                      deletingPluginId === plugin.id ||
                      (matchingInstalled && uninstallingPluginId === matchingInstalled.id);

                    return (
                      <div key={plugin.id}>
                        {/* Plugin row - clickable to expand */}
                        <div
                          className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-maestro-text hover:bg-maestro-border/40"
                          title={plugin.description || plugin.path || undefined}
                        >
                          <button
                            type="button"
                            onClick={() => togglePlugin(plugin.id)}
                            className="flex items-center gap-2 flex-1 min-w-0"
                          >
                            {pluginSkills.length > 0 ? (
                              isPluginExpanded ? (
                                <ChevronDown size={10} className="shrink-0 text-maestro-muted" />
                              ) : (
                                <ChevronRight size={10} className="shrink-0 text-maestro-muted" />
                              )
                            ) : (
                              <span className="w-[10px]" />
                            )}
                            <Package size={12} className="shrink-0 text-maestro-purple" />
                            <span className="flex-1 truncate font-medium text-left">{plugin.name}</span>
                          </button>
                          {pluginSkills.length > 0 && (
                            <span className="text-[10px] text-maestro-muted">{pluginSkills.length}</span>
                          )}
                          <span className="text-[10px] text-maestro-muted">v{plugin.version}</span>
                          {canUninstallPlugin(plugin) && (
                            <button
                              type="button"
                              onClick={(e) => handleUninstallPlugin(e, plugin.id, plugin.path, plugin.plugin_source)}
                              disabled={isUninstalling}
                              className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-maestro-red/10 transition-opacity"
                              title="Uninstall plugin"
                            >
                              <Trash2
                                size={10}
                                className={isUninstalling ? "text-maestro-muted animate-pulse" : "text-maestro-red"}
                              />
                            </button>
                          )}
                        </div>

                        {/* Expanded skills */}
                        {isPluginExpanded && pluginSkills.length > 0 && (
                          <div className="ml-4 border-l border-maestro-border/40 pl-2">
                            {pluginSkills.map((skill) => (
                              <div
                                key={skill.id}
                                className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-maestro-text hover:bg-maestro-border/40"
                                title={skill.description || skill.path || undefined}
                              >
                                <Zap size={11} className="shrink-0 text-maestro-orange" />
                                <span className="flex-1 truncate">{skill.name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                };
                return order
                  .filter((scope) => buckets[scope].length > 0)
                  .map((scope) => (
                    <div key={`plugin-scope-${scope}`}>
                      <div className="px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-maestro-muted/60">
                        {scopeLabel[scope]} ({buckets[scope].length})
                      </div>
                      {buckets[scope].map(renderPluginRow)}
                    </div>
                  ));
              })()}

              {/* Standalone Skills grouped by scope (Project / User). */}
              {standaloneSkills.length > 0 && (() => {
                const skillBuckets: Record<"project" | "user", SkillConfig[]> = {
                  project: [],
                  user: [],
                };
                for (const s of standaloneSkills) skillBuckets[skillScope(s)].push(s);
                const skillOrder: Array<"project" | "user"> = ["project", "user"];
                const skillLabel: Record<"project" | "user", string> = {
                  project: "Project Skills",
                  user: "User Skills",
                };
                const renderSkillRow = (skill: SkillConfig) => {
                  const badge = getSkillSourceBadge(skill.source);
                  const isDeleting = deletingSkillId === skill.id;
                  return (
                    <div
                      key={skill.id}
                      className="group flex items-center gap-2 rounded-md px-2 py-1 text-xs text-maestro-text hover:bg-maestro-border/40"
                      title={skill.description || skill.path || undefined}
                    >
                      <Zap size={12} className="shrink-0 text-maestro-orange" />
                      <span className="flex-1 truncate font-medium">{skill.name}</span>
                      <span className={`shrink-0 rounded px-1 text-[9px] ${badge.className}`}>
                        {badge.text}
                      </span>
                      {canDeleteSkill(skill) && (
                        <button
                          type="button"
                          onClick={(e) => handleDeleteSkill(e, skill.id, skill.path)}
                          disabled={isDeleting}
                          className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-maestro-red/10 transition-opacity"
                          title="Delete skill"
                        >
                          <Trash2
                            size={10}
                            className={isDeleting ? "text-maestro-muted animate-pulse" : "text-maestro-red"}
                          />
                        </button>
                      )}
                    </div>
                  );
                };
                return skillOrder
                  .filter((scope) => skillBuckets[scope].length > 0)
                  .map((scope) => (
                    <div key={`skill-scope-${scope}`}>
                      <div className="px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-maestro-muted/60">
                        {skillLabel[scope]} ({skillBuckets[scope].length})
                      </div>
                      {skillBuckets[scope].map(renderSkillRow)}
                    </div>
                  ));
              })()}
            </>
          )}
        </div>
      )}

      {/* Marketplace Browser Modal */}
      {showMarketplace && (
        <MarketplaceBrowser
          onClose={() => setShowMarketplace(false)}
          currentProjectPath={projectPath}
        />
      )}
    </div>
  );
}

/* ── 7. Settings ── */

function AppearanceSection({
  theme,
  onToggle,
  launchedCount = 0,
  isStoppingAll = false,
  onStopAll,
}: {
  theme?: "dark" | "light";
  onToggle?: () => void;
  launchedCount?: number;
  isStoppingAll?: boolean;
  onStopAll?: () => void;
}) {
  const isDark = theme !== "light";
  const [showTerminalSettings, setShowTerminalSettings] = useState(false);
  const [showCliSettings, setShowCliSettings] = useState(false);
  const [showMaestroSettings, setShowMaestroSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const hasRunningSessions = launchedCount > 0;

  return (
    <>
      <div className={cardClass}>
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-maestro-muted">
          <Settings size={13} />
          Settings
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          {isDark ? (
            <Sun size={14} className="text-maestro-orange" />
          ) : (
            <Moon size={14} className="text-maestro-accent" />
          )}
          <span>{isDark ? "Switch to Light" : "Switch to Dark"}</span>
        </button>
        <button
          type="button"
          onClick={() => setShowTerminalSettings(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <Wrench size={14} className="text-maestro-muted" />
          <span>Terminal Settings</span>
        </button>
        <button
          type="button"
          onClick={() => setShowCliSettings(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <Zap size={14} className="text-maestro-accent" />
          <span>CLI Settings</span>
        </button>
        <button
          type="button"
          onClick={() => setShowMaestroSettings(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <Info size={14} className="text-maestro-accent" />
          <span>Maestro Settings</span>
        </button>
        <button
          type="button"
          onClick={() => setShowShortcuts(true)}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-xs text-maestro-text transition-colors hover:bg-maestro-border/40"
        >
          <Keyboard size={14} className="text-maestro-muted" />
          <span>Keyboard Shortcuts</span>
        </button>
        {hasRunningSessions && onStopAll && (
          <button
            type="button"
            onClick={isStoppingAll ? undefined : onStopAll}
            disabled={isStoppingAll}
            className="mt-1 flex w-full items-center gap-2.5 rounded-md border border-maestro-red/40 bg-maestro-red/10 px-2 py-1.5 text-xs font-medium text-maestro-red transition-colors hover:bg-maestro-red/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Square size={14} />
            <span>{isStoppingAll ? "Stopping..." : `Stop All (${launchedCount})`}</span>
          </button>
        )}
      </div>

      {showTerminalSettings && (
        <TerminalSettingsModal onClose={() => setShowTerminalSettings(false)} />
      )}
      {showCliSettings && (
        <CliSettingsModal onClose={() => setShowCliSettings(false)} />
      )}
      {showMaestroSettings && (
        <MaestroSettingsModal onClose={() => setShowMaestroSettings(false)} />
      )}
      {showShortcuts && (
        <ShortcutsModal onClose={() => setShowShortcuts(false)} />
      )}
    </>
  );
}
