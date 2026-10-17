import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Edit2,
  FileText,
  Home,
  Loader2,
  Package,
  Plus,
  PlusCircle,
  Power,
  RefreshCw,
  Server,
  Store,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ContextDocEditorModal } from "@/components/claudemd";
import { MarketplaceBrowser } from "@/components/marketplace";
import { McpServerEditorModal } from "@/components/mcp";
import { type ContextDoc, listContextDocs, readContextDoc } from "@/lib/claudemd";
import type { McpConnector, McpCustomServer, McpManagedServer } from "@/lib/mcp";
import { normalizePath, samePath } from "@/lib/path";
import type { PluginConfig, SkillConfig, SkillSource } from "@/lib/plugins";
import { projectColorFor } from "@/lib/projectColor";
import { useProjectColors } from "@/lib/useProjectColors";
import { useMarketplaceStore } from "@/stores/useMarketplaceStore";
import { useMcpStore } from "@/stores/useMcpStore";
import { usePluginStore } from "@/stores/usePluginStore";
import { useWorkspaceStore, type WorkspaceTab } from "@/stores/useWorkspaceStore";
import { cardClass, divider, SectionHeader } from "./sectionChrome";

/* ================================================================ */
/*  INFRA TAB                                                        */
/* ================================================================ */

/** One Infra group: the first tab opened on a project folder, active when any of its tabs is. */
interface InfraProject {
  tab: WorkspaceTab;
  active: boolean;
}

/** Collapses tabs that open the same folder into one project, keeping tab order. */
function dedupeProjects(tabs: WorkspaceTab[]): InfraProject[] {
  const projects: InfraProject[] = [];
  for (const tab of tabs) {
    if (!tab.projectPath) continue;
    const existing = projects.find((p) => samePath(p.tab.projectPath, tab.projectPath));
    if (existing) {
      existing.active = existing.active || tab.active;
    } else {
      projects.push({ tab, active: tab.active });
    }
  }
  return projects;
}

/**
 * Infra tab: one collapsible group per open project, so every project's MCP
 * servers, plugins & skills and context docs can be managed from one place
 * without switching tabs. A group the user has not toggled follows the active
 * tab (expanded for the active project, collapsed for the others).
 */
export function InfraTab() {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const projectColors = useProjectColors();
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const fetchMarketplace = useMarketplaceStore((s) => s.fetchAll);

  const projects = useMemo(() => dedupeProjects(tabs), [tabs]);

  // A toggle lives as long as its project is open: a project closed and
  // opened again starts like any untouched group (expanded when active).
  useEffect(() => {
    setToggled((prev) => {
      const open = new Set(projects.map((p) => normalizePath(p.tab.projectPath)));
      const kept = Object.entries(prev).filter(([key]) => open.has(key));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [projects]);

  // Marketplace data backs the uninstall buttons in every group's Plugins &
  // Skills list: load it once for the tab, not once per project section (two
  // sections racing the same fetch re-triggered each other without end).
  useEffect(() => {
    void fetchMarketplace();
  }, [fetchMarketplace]);

  // No open project: the sections fall back to the user-level config alone.
  if (projects.length === 0) return <InfraSections projectPath="" />;

  return (
    <div className="space-y-2">
      {projects.map(({ tab, active }) => {
        const key = normalizePath(tab.projectPath);
        const expanded = toggled[key] ?? active;
        const color = projectColors.get(tab.name) ?? projectColorFor(tab.name);
        return (
          <div key={key}>
            <button
              type="button"
              onClick={() => setToggled((prev) => ({ ...prev, [key]: !expanded }))}
              aria-expanded={expanded}
              className="mb-1 flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] font-semibold hover:bg-maestro-border/30"
              title={tab.projectPath}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="flex-1 truncate" style={{ color }}>
                {tab.name}
              </span>
              {expanded ? (
                <ChevronDown size={12} className="text-maestro-muted" />
              ) : (
                <ChevronRight size={12} className="text-maestro-muted" />
              )}
            </button>
            {expanded && <InfraSections projectPath={tab.projectPath} />}
          </div>
        );
      })}
    </div>
  );
}

/** The per-project infra cards: MCP + plugins & skills, then the context docs. */
function InfraSections({ projectPath }: { projectPath: string }) {
  return (
    <>
      <ExtensionsSection projectPath={projectPath} />
      {divider}
      <ProjectContextSection projectPath={projectPath} />
    </>
  );
}

/* ── 2. Project Context ── */

const TIER_LABEL: Record<ContextDoc["tier"], string> = {
  user: "User",
  project: "Project",
};

const TIER_ORDER: ContextDoc["tier"][] = ["user", "project"];

function ProjectContextSection({ projectPath }: { projectPath: string }) {
  const [docs, setDocs] = useState<ContextDoc[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [editing, setEditing] = useState<{ doc: ContextDoc; content: string } | null>(null);

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
function ExtensionsSection({ projectPath }: { projectPath: string }) {
  return (
    <div className={cardClass}>
      <SectionHeader icon={Package} label="MCP, Plugins & Skills" iconColor="text-maestro-purple" />
      <MCPServersSection projectPath={projectPath} />
      <div className="my-1.5 h-px bg-maestro-border/30" />
      <PluginsSection projectPath={projectPath} />
    </div>
  );
}

/**
 * Renders a labelled group of managed MCP servers for one scope
 * (project / local / user), with per-server toggle / edit / delete actions
 * that write to Claude Code's real config files.
 *
 * Status dot: green = enabled for this project, gray = disabled via
 * Claude Code's per-project disable lists in ~/.claude.json.
 */
function McpScopeGroup({
  label,
  servers,
  onToggle,
  onEdit,
  onDelete,
}: {
  label: string;
  servers: McpManagedServer[];
  onToggle: (server: McpManagedServer) => void;
  onEdit: (server: McpManagedServer) => void;
  onDelete: (server: McpManagedServer) => void;
}) {
  if (servers.length === 0) return null;
  return (
    <>
      <div className="px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-maestro-muted/60">
        {label} ({servers.length})
      </div>
      {servers.map((server) => (
        <div
          key={`${server.scope}:${server.name}`}
          className="group flex items-center gap-2 rounded-md px-2 py-1 text-xs text-maestro-text hover:bg-maestro-border/40"
        >
          <span
            title={
              server.pending
                ? "Awaiting approval — Claude won't load it until enabled"
                : server.enabled
                  ? "Enabled — loaded into sessions on launch"
                  : "Disabled for this project"
            }
            className={`h-2 w-2 shrink-0 rounded-full ${
              server.pending
                ? "bg-yellow-500"
                : server.enabled
                  ? "bg-maestro-green"
                  : "bg-maestro-muted"
            }`}
          />
          <span
            className={`flex-1 truncate font-medium ${
              server.enabled || server.pending ? "" : "text-maestro-muted line-through"
            }`}
          >
            {server.name}
          </span>
          <span className="text-[10px] text-maestro-muted group-hover:hidden">
            {server.transport === "http" ? "HTTP" : server.transport}
          </span>
          <div className="hidden items-center gap-0.5 group-hover:flex">
            <button
              type="button"
              onClick={() => onToggle(server)}
              className="rounded p-0.5 hover:bg-maestro-border/40"
              title={
                server.pending
                  ? "Approve for this project"
                  : server.enabled
                    ? "Disable for this project"
                    : "Enable for this project"
              }
            >
              <Power
                size={10}
                className={
                  server.pending
                    ? "text-yellow-500"
                    : server.enabled
                      ? "text-maestro-green"
                      : "text-maestro-muted"
                }
              />
            </button>
            <button
              type="button"
              onClick={() => onEdit(server)}
              className="rounded p-0.5 hover:bg-maestro-border/40"
              title="Edit server"
            >
              <Edit2 size={10} className="text-maestro-muted" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(server)}
              className="rounded p-0.5 hover:bg-maestro-red/10"
              title="Remove from config file"
            >
              <Trash2 size={10} className="text-maestro-red" />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * claude.ai account connectors. They are defined in the user's claude.ai
 * account (not in any local file), so they can only be enabled/disabled per
 * project — Claude Code's `disabledMcpServers` list — never edited or removed.
 */
function McpConnectorGroup({
  connectors,
  onToggle,
}: {
  connectors: McpConnector[];
  onToggle: (connector: McpConnector) => void;
}) {
  if (connectors.length === 0) return null;
  return (
    <>
      <div
        className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-maestro-muted/60"
        title="Managed in your claude.ai account — Maestro can only enable/disable them per project"
      >
        <Cloud size={9} />
        claude.ai account ({connectors.length})
      </div>
      {connectors.map((connector) => (
        <div
          key={connector.name}
          className="group flex items-center gap-2 rounded-md px-2 py-1 text-xs text-maestro-text hover:bg-maestro-border/40"
        >
          <span
            title={connector.enabled ? "Enabled for this project" : "Disabled for this project"}
            className={`h-2 w-2 shrink-0 rounded-full ${
              connector.enabled ? "bg-maestro-green" : "bg-maestro-muted"
            }`}
          />
          <span
            className={`flex-1 truncate font-medium ${
              connector.enabled ? "" : "text-maestro-muted line-through"
            }`}
          >
            {connector.name}
          </span>
          <span className="text-[10px] text-maestro-muted group-hover:hidden">remote</span>
          <div className="hidden items-center gap-0.5 group-hover:flex">
            <button
              type="button"
              onClick={() => onToggle(connector)}
              className="rounded p-0.5 hover:bg-maestro-border/40"
              title={connector.enabled ? "Disable for this project" : "Enable for this project"}
            >
              <Power
                size={10}
                className={connector.enabled ? "text-maestro-green" : "text-maestro-muted"}
              />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function MCPServersSection({ projectPath }: { projectPath: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showEditorModal, setShowEditorModal] = useState(false);
  const [editingServer, setEditingServer] = useState<McpCustomServer | undefined>(undefined);
  const [editingManaged, setEditingManaged] = useState<McpManagedServer | undefined>(undefined);

  const {
    customServers,
    customServersLoaded,
    fetchProjectServers,
    refreshProjectServers,
    fetchCustomServers,
    deleteCustomServer,
    mcpStatus,
    fetchMcpStatus,
    setManagedServerEnabled,
    removeManagedServer,
    isLoading,
    errors,
  } = useMcpStore();

  const status = projectPath ? mcpStatus[projectPath] : undefined;
  const managedServers = status?.servers ?? [];
  const connectors = status?.connectors ?? [];
  const loading = projectPath ? (isLoading[projectPath] ?? false) : false;
  const writeError = projectPath ? (errors[projectPath] ?? null) : null;

  const totalCount = managedServers.length + connectors.length + customServers.length;

  // Fetch the management view and launch-time discovery when project changes
  useEffect(() => {
    if (projectPath) {
      fetchMcpStatus(projectPath);
      fetchProjectServers(projectPath);
    }
  }, [projectPath, fetchMcpStatus, fetchProjectServers]);

  // Fetch custom servers on mount
  useEffect(() => {
    if (!customServersLoaded) {
      fetchCustomServers();
    }
  }, [customServersLoaded, fetchCustomServers]);

  const handleRefresh = useCallback(() => {
    if (projectPath) {
      fetchMcpStatus(projectPath);
      refreshProjectServers(projectPath);
    }
    fetchCustomServers();
  }, [projectPath, fetchMcpStatus, refreshProjectServers, fetchCustomServers]);

  const handleAddServer = () => {
    setEditingServer(undefined);
    setEditingManaged(undefined);
    setShowEditorModal(true);
  };

  const handleEditServer = (server: McpCustomServer) => {
    setEditingServer(server);
    setEditingManaged(undefined);
    setShowEditorModal(true);
  };

  const handleEditManaged = (server: McpManagedServer) => {
    setEditingManaged(server);
    setEditingServer(undefined);
    setShowEditorModal(true);
  };

  const handleToggleManaged = async (server: McpManagedServer) => {
    if (!projectPath) return;
    try {
      await setManagedServerEnabled(projectPath, server.scope, server.name, !server.enabled);
    } catch (err) {
      console.error("Failed to toggle MCP server:", err);
    }
  };

  const handleToggleConnector = async (connector: McpConnector) => {
    if (!projectPath) return;
    try {
      await setManagedServerEnabled(projectPath, "connector", connector.name, !connector.enabled);
    } catch (err) {
      console.error("Failed to toggle claude.ai connector:", err);
    }
  };

  const handleDeleteManaged = async (server: McpManagedServer) => {
    if (!projectPath) return;
    try {
      await removeManagedServer(projectPath, server.scope, server.name);
    } catch (err) {
      console.error("Failed to remove MCP server:", err);
    }
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
          <Server
            size={13}
            className={totalCount > 0 ? "text-maestro-green" : "text-maestro-muted/80"}
          />
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
              <RefreshCw
                size={12}
                className={`text-maestro-muted ${loading ? "animate-spin" : ""}`}
              />
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
            {/* Config write failures (toggle/delete have no modal to show them) */}
            {writeError && (
              <div className="px-2 py-1 text-[10px] text-maestro-red break-words">{writeError}</div>
            )}

            {/* Managed servers grouped by scope. Project = repo's .mcp.json,
                Local = ~/.claude.json projects[path] (per-machine), User = top-level
                ~/.claude.json (user-global). All editable in place. */}
            <McpScopeGroup
              label="Project (.mcp.json)"
              servers={managedServers.filter((s) => s.scope === "project")}
              onToggle={handleToggleManaged}
              onEdit={handleEditManaged}
              onDelete={handleDeleteManaged}
            />
            <McpScopeGroup
              label="Local (this machine)"
              servers={managedServers.filter((s) => s.scope === "local")}
              onToggle={handleToggleManaged}
              onEdit={handleEditManaged}
              onDelete={handleDeleteManaged}
            />
            <McpScopeGroup
              label="User (global)"
              servers={managedServers.filter((s) => s.scope === "user")}
              onToggle={handleToggleManaged}
              onEdit={handleEditManaged}
              onDelete={handleDeleteManaged}
            />

            {/* claude.ai account connectors (toggle only) */}
            <McpConnectorGroup connectors={connectors} onToggle={handleToggleConnector} />

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
          managedServer={editingManaged}
          projectPath={projectPath}
          onClose={() => setShowEditorModal(false)}
          onSaved={() => {
            fetchCustomServers();
            if (projectPath) fetchMcpStatus(projectPath);
          }}
        />
      )}
    </>
  );
}

/* ── 6. Plugins & Skills ── */

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
function getSkillSourceBadge(source: SkillSource): {
  text: string;
  className: string;
  icon: React.ElementType;
} {
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

function PluginsSection({ projectPath }: { projectPath: string }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(new Set());
  const [showMarketplace, setShowMarketplace] = useState(false);

  const {
    projectSkills,
    projectPlugins,
    fetchProjectPlugins,
    refreshProjectPlugins,
    isLoading,
    deleteSkill,
    deletingSkillId,
    deletePlugin,
    deletingPluginId,
  } = usePluginStore();
  const {
    uninstallPluginById,
    uninstallingPluginId,
    installedPlugins,
    fetchAll: fetchMarketplace,
  } = useMarketplaceStore();
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

  const handleRefresh = useCallback(() => {
    if (projectPath) {
      refreshProjectPlugins(projectPath);
    }
  }, [projectPath, refreshProjectPlugins]);

  // Handle uninstalling a plugin (installed or marketplace)
  const handleUninstallPlugin = useCallback(
    async (
      e: React.MouseEvent,
      pluginId: string,
      pluginPath: string | null,
      pluginSource: string,
    ) => {
      e.stopPropagation();

      // For "installed" plugins (manually installed to ~/.claude/plugins/), delete directly
      if (pluginSource === "installed" && pluginPath && projectPath) {
        await deletePlugin(pluginId, pluginPath, projectPath);
        return;
      }

      // For "marketplace" plugins, use the marketplace uninstall
      const installedPlugin = installedPlugins.find(
        (p) => p.path === pluginPath || p.plugin_id === pluginId || p.id === pluginId,
      );
      if (installedPlugin) {
        await uninstallPluginById(installedPlugin.id);
        // Refresh both marketplace and plugins lists
        await fetchMarketplace();
        if (projectPath) {
          await refreshProjectPlugins(projectPath);
        }
      } else {
        console.warn("Could not find installed plugin to uninstall:", {
          pluginId,
          pluginPath,
          pluginSource,
          installedPlugins,
        });
      }
    },
    [
      installedPlugins,
      uninstallPluginById,
      fetchMarketplace,
      projectPath,
      refreshProjectPlugins,
      deletePlugin,
    ],
  );

  // Handle deleting a standalone skill
  const handleDeleteSkill = useCallback(
    async (e: React.MouseEvent, skillId: string, skillPath: string | null) => {
      e.stopPropagation();
      if (!skillPath || !projectPath) return;
      // skill.path points to SKILL.md file, we need the parent directory
      const skillDir = skillPath.replace(/\/[^/]+$/, ""); // Remove filename to get directory
      await deleteSkill(skillId, skillDir, projectPath);
    },
    [deleteSkill, projectPath],
  );

  // Check if a plugin can be uninstalled (installed or marketplace, not builtin)
  const canUninstallPlugin = (plugin: (typeof plugins)[0]) => {
    return plugin.plugin_source === "installed" || plugin.plugin_source === "marketplace";
  };

  // Check if a skill can be deleted (project or personal, not plugin-owned or legacy)
  const canDeleteSkill = (skill: (typeof skills)[0]) => {
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
        <Store
          size={13}
          className={totalCount > 0 ? "text-maestro-purple" : "text-maestro-muted/80"}
        />
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
            <RefreshCw
              size={12}
              className={`text-maestro-muted ${loading ? "animate-spin" : ""}`}
            />
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
              <div className="px-2 py-1 text-[11px] text-maestro-muted/60">No skills found</div>
              <div className="px-2 text-[10px] text-maestro-muted/40">
                Add skills to .claude/skills/ or ~/.claude/skills/
              </div>
            </>
          ) : (
            <>
              {/* Plugins grouped by scope (Project / User / Global). */}
              {plugins.length > 0 &&
                (() => {
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
                      (p) =>
                        p.path === plugin.path || p.plugin_id === plugin.id || p.id === plugin.id,
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
                            <span className="flex-1 truncate font-medium text-left">
                              {plugin.name}
                            </span>
                          </button>
                          {pluginSkills.length > 0 && (
                            <span className="text-[10px] text-maestro-muted">
                              {pluginSkills.length}
                            </span>
                          )}
                          <span className="text-[10px] text-maestro-muted">v{plugin.version}</span>
                          {canUninstallPlugin(plugin) && (
                            <button
                              type="button"
                              onClick={(e) =>
                                handleUninstallPlugin(
                                  e,
                                  plugin.id,
                                  plugin.path,
                                  plugin.plugin_source,
                                )
                              }
                              disabled={isUninstalling}
                              className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-maestro-red/10 transition-opacity"
                              title="Uninstall plugin"
                            >
                              <Trash2
                                size={10}
                                className={
                                  isUninstalling
                                    ? "text-maestro-muted animate-pulse"
                                    : "text-maestro-red"
                                }
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
              {standaloneSkills.length > 0 &&
                (() => {
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
                              className={
                                isDeleting ? "text-maestro-muted animate-pulse" : "text-maestro-red"
                              }
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
