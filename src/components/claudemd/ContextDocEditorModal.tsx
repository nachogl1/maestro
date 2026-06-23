import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ContextDocKind, type ContextDocTier, writeContextDoc } from "@/lib/claudemd";

interface ContextDocEditorModalProps {
  /** Absolute path to the doc on disk. */
  path: string;
  /** Filename (used in the title and as a hint for the default template). */
  label: string;
  tier: ContextDocTier;
  kind: ContextDocKind;
  exists: boolean;
  initialContent?: string;
  onClose: () => void;
  onSaved?: () => void;
}

const CLAUDE_TEMPLATE = `# Project Context

<!-- Add project-specific instructions for Claude here -->

## Overview
[Describe your project briefly]

## Coding Standards
[Any specific coding standards or patterns to follow]

## Important Notes
[Any important context Claude should know]
`;

const CLAUDE_USER_TEMPLATE = `# Personal Claude Memory

<!-- Instructions Claude should apply across every project for this user. -->

## Preferences
-

## Conventions
-
`;

const AGENTS_TEMPLATE = `# Agents

<!-- See https://agents.md for the format -->
`;

const README_TEMPLATE = `# Project

`;

const GITIGNORE_TEMPLATE = `# Ignore build artifacts, dependencies, and local files

node_modules/
dist/
target/
.env
`;

const SETTINGS_TEMPLATE = `{
}
`;

const MCP_TEMPLATE = `{
  "mcpServers": {}
}
`;

function defaultTemplate(kind: ContextDocKind, tier: ContextDocTier): string {
  if (kind === "agents") return AGENTS_TEMPLATE;
  if (kind === "readme") return README_TEMPLATE;
  if (kind === "gitignore") return GITIGNORE_TEMPLATE;
  if (kind === "settings") return SETTINGS_TEMPLATE;
  if (kind === "mcp") return MCP_TEMPLATE;
  if (tier === "user") return CLAUDE_USER_TEMPLATE;
  return CLAUDE_TEMPLATE;
}

export function ContextDocEditorModal({
  path,
  label,
  tier,
  kind,
  exists,
  initialContent,
  onClose,
  onSaved,
}: ContextDocEditorModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [content, setContent] = useState(
    exists && initialContent !== undefined ? initialContent : defaultTemplate(kind, tier),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSave = async () => {
    setError(null);
    setSaving(true);

    try {
      await writeContextDoc(path, content);
      onSaved?.();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const tierLabel = tier === "user" ? "User" : "Project";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={modalRef}
        className="w-full max-w-2xl rounded-lg border border-maestro-border bg-maestro-bg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-maestro-border px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-maestro-text">
              {exists ? `Edit ${label}` : `Create ${label}`}
            </h2>
            <span className="text-[10px] uppercase tracking-wider text-maestro-muted">
              {tierLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-maestro-border/40"
          >
            <X size={16} className="text-maestro-muted" />
          </button>
        </div>

        <div className="p-4">
          <p className="mb-1 truncate text-[11px] text-maestro-muted" title={path}>
            {path}
          </p>

          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`Enter ${label} content...`}
            className="h-80 w-full resize-none rounded border border-maestro-border bg-maestro-surface p-3 font-mono text-xs text-maestro-text placeholder:text-maestro-muted focus:border-maestro-accent focus:outline-none"
            spellCheck={false}
          />

          {error && <p className="mt-2 text-xs text-maestro-red">{error}</p>}
        </div>

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
            ) : exists ? (
              "Save Changes"
            ) : (
              "Create File"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
