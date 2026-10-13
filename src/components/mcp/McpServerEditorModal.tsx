import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2, Plus, Terminal, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import { useDismissable } from "@/hooks/useDismissable";
import type { McpCustomServer, McpManagedScope, McpManagedServer } from "@/lib/mcp";
import { useMcpStore } from "@/stores/useMcpStore";

/** Where a new/edited server definition is written. */
type EditorScope = Exclude<McpManagedScope, "connector"> | "custom";

const SCOPE_OPTIONS: Array<{ value: EditorScope; label: string; hint: string }> = [
  {
    value: "project",
    label: "Project",
    hint: ".mcp.json in the repo — shared with everyone who clones it",
  },
  {
    value: "user",
    label: "User",
    hint: "~/.claude.json — available in all your projects",
  },
  {
    value: "local",
    label: "Local",
    hint: "~/.claude.json — this project on this machine only",
  },
  {
    value: "custom",
    label: "Maestro custom",
    hint: "Maestro-only store — injected into Maestro sessions, invisible to plain Claude CLI",
  },
];

interface McpServerEditorModalProps {
  /** Existing Maestro custom server to edit. */
  server?: McpCustomServer;
  /** Existing managed server (real config file) to edit. */
  managedServer?: McpManagedServer;
  /** Active project — required for project/local scope writes. */
  projectPath: string;
  onClose: () => void;
  onSaved?: () => void;
}

/**
 * Modal for adding or editing MCP servers.
 *
 * Supports two backends:
 * - Managed scopes (project/user/local) write to Claude Code's real config
 *   files (`.mcp.json`, `~/.claude.json`) via `upsertManagedServer`.
 * - The Maestro custom scope keeps servers in Maestro's own store.
 *
 * When editing an existing server, the scope (and for managed servers the
 * name — it's the JSON key) is fixed; delete and re-add to move or rename.
 */
export function McpServerEditorModal({
  server,
  managedServer,
  projectPath,
  onClose,
  onSaved,
}: McpServerEditorModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const { addCustomServer, updateCustomServer, upsertManagedServer } = useMcpStore();

  const isEditing = !!server || !!managedServer;

  const managedConfig = managedServer?.config ?? {};
  const managedIsUrl =
    managedServer !== undefined &&
    (managedServer.transport === "http" || managedServer.transport === "sse");

  // Form state. New servers default to "local": that matches `claude mcp add`
  // and keeps pasted credentials out of the repo-tracked .mcp.json unless the
  // user explicitly chooses to share them.
  const [scope, setScope] = useState<EditorScope>(
    server ? "custom" : ((managedServer?.scope as EditorScope) ?? "local"),
  );
  const [transport, setTransport] = useState<"stdio" | "http">(managedIsUrl ? "http" : "stdio");
  const [name, setName] = useState(server?.name ?? managedServer?.name ?? "");
  const [command, setCommand] = useState(
    server?.command ?? (typeof managedConfig.command === "string" ? managedConfig.command : ""),
  );
  const [argsString, setArgsString] = useState(
    server?.args.join(" ") ??
      (Array.isArray(managedConfig.args) ? (managedConfig.args as string[]).join(" ") : ""),
  );
  const [url, setUrl] = useState(typeof managedConfig.url === "string" ? managedConfig.url : "");
  const [workingDirectory, setWorkingDirectory] = useState(server?.workingDirectory ?? "");
  const [envVars, setEnvVars] = useState<Array<{ id: string; key: string; value: string }>>(
    Object.entries(server?.env ?? ((managedConfig.env ?? {}) as Record<string, string>)).map(
      ([key, value]) => ({ id: crypto.randomUUID(), key, value: String(value) }),
    ),
  );
  const [isEnabled, setIsEnabled] = useState(server?.isEnabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCustom = scope === "custom";
  const showUrl = !isCustom && transport === "http";

  // Close on outside click or Escape
  useDismissable(onClose, { ref: modalRef });

  const handleBrowseWorkingDir = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        title: "Select Working Directory",
      });
      if (selected) {
        setWorkingDirectory(selected);
      }
    } catch (err) {
      console.error("Failed to open directory picker:", err);
    }
  };

  const addEnvVar = () => {
    setEnvVars([...envVars, { id: crypto.randomUUID(), key: "", value: "" }]);
  };

  const updateEnvVar = (index: number, field: "key" | "value", value: string) => {
    setEnvVars(envVars.map((ev, i) => (i === index ? { ...ev, [field]: value } : ev)));
  };

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  // Parse arguments from space-separated string
  const parseArgs = (argsStr: string): string[] => {
    if (!argsStr.trim()) return [];
    // Simple split by space, but handle quoted strings
    const args: string[] = [];
    let current = "";
    let inQuotes = false;
    let quoteChar = "";

    for (const char of argsStr) {
      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = "";
      } else if (char === " " && !inQuotes) {
        if (current) {
          args.push(current);
          current = "";
        }
      } else {
        current += char;
      }
    }
    if (current) args.push(current);
    return args;
  };

  // Build command preview
  const buildCommandPreview = (): string => {
    if (showUrl) return url || "<url>";
    const args = parseArgs(argsString);
    const envPrefix = envVars
      .filter((ev) => ev.key.trim())
      .map((ev) => `${ev.key}=${ev.value}`)
      .join(" ");

    let preview = "";
    if (envPrefix) preview += `${envPrefix} `;
    preview += command || "<command>";
    if (args.length > 0) preview += ` ${args.join(" ")}`;
    return preview;
  };

  const collectEnv = (): Record<string, string> =>
    Object.fromEntries(
      envVars.filter((ev) => ev.key.trim()).map((ev) => [ev.key.trim(), ev.value]),
    );

  /** Builds the raw JSON entry written into the config file. */
  const buildManagedConfig = (): Record<string, unknown> => {
    // Start from the original entry so fields this form doesn't know about
    // (e.g. headers on http servers) survive an edit.
    const base: Record<string, unknown> = managedServer ? { ...managedServer.config } : {};

    if (transport === "http") {
      // Preserve an original "sse" type; default new URL servers to "http".
      base.type = managedIsUrl ? (managedConfig.type ?? "http") : "http";
      base.url = url.trim();
      delete base.command;
      delete base.args;
      delete base.env;
    } else {
      base.type = "stdio";
      base.command = command.trim();
      const args = parseArgs(argsString);
      if (args.length > 0) base.args = args;
      else delete base.args;
      const env = collectEnv();
      if (Object.keys(env).length > 0) base.env = env;
      else delete base.env;
      delete base.url;
    }
    return base;
  };

  const handleSave = async () => {
    setError(null);

    // Validation
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (showUrl) {
      if (!url.trim()) {
        setError("URL is required for HTTP servers");
        return;
      }
    } else if (!command.trim()) {
      setError("Command is required");
      return;
    }
    if (!isCustom && (scope === "project" || scope === "local") && !projectPath) {
      setError("Open a project first to use project/local scope");
      return;
    }

    setSaving(true);
    try {
      if (isCustom) {
        const serverData: McpCustomServer = {
          id: server?.id ?? crypto.randomUUID(),
          name: name.trim(),
          command: command.trim(),
          args: parseArgs(argsString),
          env: collectEnv(),
          workingDirectory: workingDirectory.trim() || undefined,
          isEnabled,
          createdAt: server?.createdAt ?? new Date().toISOString(),
        };

        if (server) {
          await updateCustomServer(serverData);
        } else {
          await addCustomServer(serverData);
        }
      } else {
        await upsertManagedServer(
          projectPath,
          scope as McpManagedScope,
          name.trim(),
          buildManagedConfig(),
          // Only an explicit edit may replace an existing entry; the Add
          // flow errors on a name collision instead of clobbering it.
          !!managedServer,
        );
      }

      onSaved?.();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const scopeHint = SCOPE_OPTIONS.find((o) => o.value === scope)?.hint;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-lg rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-maestro-border px-4 py-3">
          <h2 className="text-sm font-semibold text-maestro-text">
            {isEditing ? "Edit MCP Server" : "Add MCP Server"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-maestro-border/40"
          >
            <X size={16} className="text-maestro-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
          {/* Scope */}
          <section>
            <span className="mb-1.5 block text-xs font-medium text-maestro-text">Scope</span>
            <div className="flex gap-1">
              {SCOPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={isEditing}
                  onClick={() => setScope(option.value)}
                  className={`rounded border px-2.5 py-1.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    scope === option.value
                      ? "border-maestro-accent bg-maestro-accent/15 text-maestro-text"
                      : "border-maestro-border bg-maestro-surface text-maestro-muted hover:text-maestro-text"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {scopeHint && <p className="mt-1 text-[10px] text-maestro-muted">{scopeHint}</p>}
          </section>

          {/* Transport (managed scopes only — custom servers are always stdio) */}
          {!isCustom && (
            <section>
              <span className="mb-1.5 block text-xs font-medium text-maestro-text">Transport</span>
              <div className="flex gap-1">
                {(["stdio", "http"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTransport(t)}
                    className={`rounded border px-2.5 py-1.5 text-[11px] transition-colors ${
                      transport === t
                        ? "border-maestro-accent bg-maestro-accent/15 text-maestro-text"
                        : "border-maestro-border bg-maestro-surface text-maestro-muted hover:text-maestro-text"
                    }`}
                  >
                    {t === "stdio" ? "stdio (command)" : "HTTP (url)"}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Name */}
          <section>
            <label
              htmlFor="mcp-server-name"
              className="mb-1.5 block text-xs font-medium text-maestro-text"
            >
              Name
            </label>
            <input
              id="mcp-server-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My MCP Server"
              disabled={!!managedServer}
              title={
                managedServer
                  ? "The name is the entry's key in the config file — delete and re-add to rename"
                  : undefined
              }
              className="w-full rounded border border-maestro-border bg-maestro-surface px-3 py-2 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none disabled:opacity-60"
              // biome-ignore lint/a11y/noAutofocus: modal opened via an explicit "Add server" action — autofocusing the first field is the expected UX here.
              autoFocus={!managedServer}
            />
          </section>

          {/* URL (HTTP transport) */}
          {showUrl && (
            <section>
              <label
                htmlFor="mcp-server-url"
                className="mb-1.5 block text-xs font-medium text-maestro-text"
              >
                URL
              </label>
              <input
                id="mcp-server-url"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                className="w-full rounded border border-maestro-border bg-maestro-surface px-3 py-2 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
              />
            </section>
          )}

          {/* Command + args + env (stdio transport) */}
          {!showUrl && (
            <>
              <section>
                <label
                  htmlFor="mcp-server-command"
                  className="mb-1.5 block text-xs font-medium text-maestro-text"
                >
                  Command
                </label>
                <input
                  id="mcp-server-command"
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx, node, python, etc."
                  className="w-full rounded border border-maestro-border bg-maestro-surface px-3 py-2 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
                />
              </section>

              <section>
                <label
                  htmlFor="mcp-server-args"
                  className="mb-1.5 block text-xs font-medium text-maestro-text"
                >
                  Arguments
                </label>
                <input
                  id="mcp-server-args"
                  type="text"
                  value={argsString}
                  onChange={(e) => setArgsString(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem"
                  className="w-full rounded border border-maestro-border bg-maestro-surface px-3 py-2 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
                />
                <p className="mt-1 text-[10px] text-maestro-muted">
                  Space-separated arguments. Use quotes for values with spaces.
                </p>
              </section>

              {/* Working Directory (custom servers only — not a standard MCP field) */}
              {isCustom && (
                <section>
                  <label
                    htmlFor="mcp-server-working-dir"
                    className="mb-1.5 block text-xs font-medium text-maestro-text"
                  >
                    Working Directory
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="mcp-server-working-dir"
                      type="text"
                      value={workingDirectory}
                      onChange={(e) => setWorkingDirectory(e.target.value)}
                      placeholder="(Optional) /path/to/directory"
                      className="flex-1 rounded border border-maestro-border bg-maestro-surface px-3 py-2 text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleBrowseWorkingDir}
                      className="rounded border border-maestro-border bg-maestro-card px-3 py-2 text-xs text-maestro-text hover:bg-maestro-surface"
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>
                </section>
              )}

              {/* Environment Variables */}
              <section>
                <div className="mb-1.5 flex items-center justify-between">
                  {/* Group heading for the env var rows below — not a control label. */}
                  <span className="text-xs font-medium text-maestro-text">
                    Environment Variables
                  </span>
                  <button
                    type="button"
                    onClick={addEnvVar}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-maestro-accent hover:bg-maestro-accent/10"
                  >
                    <Plus size={10} />
                    Add
                  </button>
                </div>
                <div className="space-y-2 rounded-lg border border-maestro-border bg-maestro-card p-2">
                  {envVars.length === 0 ? (
                    <p className="py-1 text-center text-[10px] text-maestro-muted">
                      No environment variables
                    </p>
                  ) : (
                    envVars.map((ev, index) => (
                      <div key={ev.id} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={ev.key}
                          onChange={(e) => updateEnvVar(index, "key", e.target.value)}
                          placeholder="KEY"
                          className="w-28 rounded border border-maestro-border bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
                        />
                        <span className="text-maestro-muted">=</span>
                        <input
                          type="text"
                          value={ev.value}
                          onChange={(e) => updateEnvVar(index, "value", e.target.value)}
                          placeholder="value"
                          className="flex-1 rounded border border-maestro-border bg-maestro-surface px-2 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => removeEnvVar(index)}
                          className="rounded p-1 hover:bg-maestro-red/10"
                        >
                          <Trash2 size={12} className="text-maestro-red" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </>
          )}

          {/* Enabled (custom servers only — managed servers toggle from the sidebar) */}
          {isCustom && (
            <section>
              <label className="flex items-center gap-2 text-xs text-maestro-text">
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={(e) => setIsEnabled(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-maestro-border"
                />
                Enable by default
              </label>
              <p className="mt-1 pl-5 text-[10px] text-maestro-muted">
                Enabled servers are included in new sessions automatically.
              </p>
            </section>
          )}

          {/* Command Preview */}
          <section>
            {/* Caption for the readonly preview below — not a control label. */}
            <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-maestro-text">
              <Terminal size={12} />
              {showUrl ? "Endpoint Preview" : "Command Preview"}
            </span>
            <div className="rounded-lg border border-maestro-border bg-maestro-surface p-2">
              <code className="text-[11px] text-maestro-accent break-all">
                {buildCommandPreview()}
              </code>
            </div>
          </section>

          {/* Error */}
          {error && <p className="text-xs text-maestro-red">{error}</p>}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 border-t border-maestro-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-4 py-2 text-xs text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 rounded bg-maestro-accent px-4 py-2 text-xs text-white hover:bg-maestro-accent/80 disabled:opacity-50"
          >
            {saving ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Saving...
              </>
            ) : isEditing ? (
              "Save Changes"
            ) : (
              "Add Server"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
