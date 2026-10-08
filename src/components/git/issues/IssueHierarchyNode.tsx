import { Handle, type NodeProps, Position } from "@xyflow/react";
import { UserPlus } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { ISSUE_NODE_H, ISSUE_NODE_W, type IssueGraphNode } from "@/lib/issueGraph";
import type { RepoAssignee } from "./useIssueHierarchy";

/** What an issue node needs from the modal (kept out of node data on purpose). */
export interface IssueHierarchyActions {
  /** Every user who can be assigned in the repo. */
  repoAssignees: RepoAssignee[];
  /** Issue whose assign popover is open, if any. */
  assignOpenFor: number | null;
  setAssignOpenFor: (number: number | null) => void;
  setAssignees: (number: number, add: string[], remove: string[]) => Promise<void>;
}

const noop = () => {};

const IssueHierarchyActionsContext = createContext<IssueHierarchyActions>({
  repoAssignees: [],
  assignOpenFor: null,
  setAssignOpenFor: noop,
  setAssignees: async () => {},
});

export const IssueHierarchyActionsProvider = IssueHierarchyActionsContext.Provider;

// Mapped copy of the interface: a type literal satisfies React Flow's
// `Record<string, unknown>` node-data constraint, an interface does not.
export type IssueNodeData = { [K in keyof IssueGraphNode]: IssueGraphNode[K] };

function stateDotClass(node: IssueGraphNode): string {
  if (node.stub) return "bg-maestro-muted/60";
  return node.state.toUpperCase() === "OPEN" ? "bg-green-400" : "bg-purple-400";
}

function initials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

interface AssigneeAvatarProps {
  login: string;
  avatarUrl: string | undefined;
}

function AssigneeAvatar({ login, avatarUrl }: AssigneeAvatarProps) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={login} className="h-4 w-4 shrink-0 rounded-full" />;
  }
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-maestro-border text-[7px] font-semibold text-maestro-text">
      {initials(login)}
    </span>
  );
}

interface AssignPopoverProps {
  node: IssueGraphNode;
}

/** Checkbox list of every repo assignee; toggling assigns/unassigns at once. */
function AssignPopover({ node }: AssignPopoverProps) {
  const { repoAssignees, setAssignees } = useContext(IssueHierarchyActionsContext);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assigned = new Set(node.assignees.map((a) => a.login));
  // Current assignees missing from the repo list must stay un-assignable.
  const logins = [
    ...repoAssignees.map((a) => a.login),
    ...node.assignees.map((a) => a.login).filter((l) => !repoAssignees.some((r) => r.login === l)),
  ];

  const toggle = async (login: string): Promise<void> => {
    const isAssigned = assigned.has(login);
    setPending(login);
    setError(null);
    try {
      await setAssignees(node.number, isAssigned ? [] : [login], isAssigned ? [login] : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  return (
    // nodrag/nopan/nowheel: React Flow must leave clicks and scrolls in here alone.
    // biome-ignore lint/a11y/useKeyWithClickEvents: only swallows clicks so the node isn't selected
    <div
      role="dialog"
      aria-label={`Assignees for #${node.number}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="nodrag nopan nowheel absolute left-0 top-full z-10 mt-1 max-h-56 w-56 overflow-auto rounded-md border border-maestro-border bg-maestro-surface p-1 shadow-xl"
    >
      {logins.length === 0 && (
        <p className="px-2 py-1 text-[10px] text-maestro-muted">No assignable users</p>
      )}
      {logins.map((login) => (
        <label
          key={login}
          className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-maestro-text hover:bg-maestro-card"
        >
          <input
            type="checkbox"
            checked={assigned.has(login)}
            disabled={pending !== null}
            onChange={() => void toggle(login)}
            aria-label={login}
          />
          <AssigneeAvatar
            login={login}
            avatarUrl={repoAssignees.find((a) => a.login === login)?.avatarUrl}
          />
          <span className="truncate">{login}</span>
        </label>
      ))}
      {error && <p className="px-1.5 py-1 text-[10px] text-maestro-red">{error}</p>}
    </div>
  );
}

/** One issue on the hierarchy canvas. */
export function IssueNode({ data, selected }: NodeProps) {
  const node = data as IssueNodeData;
  const { repoAssignees, assignOpenFor, setAssignOpenFor } = useContext(
    IssueHierarchyActionsContext,
  );
  const popoverOpen = assignOpenFor === node.number;

  return (
    <div
      style={{ width: ISSUE_NODE_W, minHeight: ISSUE_NODE_H }}
      data-testid={`issue-node-${node.number}`}
      className={`relative flex flex-col gap-1 rounded-md border px-2 py-1.5 text-left ${
        node.stub
          ? "border-dashed border-maestro-border bg-maestro-card/40 opacity-60"
          : "cursor-pointer border-maestro-border bg-maestro-card"
      } ${selected ? "ring-1 ring-maestro-accent" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${stateDotClass(node)}`} />
        <span className="font-mono text-[10px] text-maestro-muted">#{node.number}</span>
        {!node.stub && (
          <button
            type="button"
            title="Assign"
            aria-label={`Assign #${node.number}`}
            onClick={(e) => {
              e.stopPropagation();
              setAssignOpenFor(popoverOpen ? null : node.number);
            }}
            className="nodrag ml-auto rounded p-0.5 text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
          >
            <UserPlus size={11} />
          </button>
        )}
      </div>

      {node.stub ? (
        <p className="text-[10px] italic text-maestro-muted">not in current filter</p>
      ) : (
        <p className="line-clamp-2 text-[11px] leading-tight text-maestro-text">{node.title}</p>
      )}

      {node.labels.length > 0 && (
        <div className="flex items-center gap-1 overflow-hidden">
          {node.labels.slice(0, 3).map((label) => (
            <span
              key={label.name}
              className="shrink-0 rounded px-1 py-0.5 text-[9px]"
              style={{ backgroundColor: `#${label.color}20`, color: `#${label.color}` }}
            >
              {label.name}
            </span>
          ))}
          {node.labels.length > 3 && (
            <span className="text-[9px] text-maestro-muted/60">+{node.labels.length - 3}</span>
          )}
        </div>
      )}

      {node.assignees.length > 0 && (
        <div className="flex items-center gap-1 overflow-hidden text-[10px] text-maestro-muted">
          {node.assignees.map((a) => (
            <span key={a.login} className="flex shrink-0 items-center gap-0.5">
              <AssigneeAvatar
                login={a.login}
                avatarUrl={repoAssignees.find((r) => r.login === a.login)?.avatarUrl}
              />
              {a.login}
            </span>
          ))}
        </div>
      )}

      {popoverOpen && !node.stub && <AssignPopover node={node} />}

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
    </div>
  );
}

/** Node type registry handed to React Flow. */
export const issueHierarchyNodeTypes = { issue: IssueNode };
