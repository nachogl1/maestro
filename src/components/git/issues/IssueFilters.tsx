import { Search, Waypoints, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type IssueFilterState, useGitHubStore } from "../../../stores/useGitHubStore";

const STATE_FILTERS: Array<{ value: IssueFilterState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const QUICK_CHIPS: Array<{ key: string; label: string; clause: string }> = [
  { key: "mine", label: "Mine", clause: "author:@me" },
  { key: "assigned", label: "Assigned", clause: "assignee:@me" },
  { key: "mentions", label: "Mentions", clause: "mentions:@me" },
];

interface IssueFiltersProps {
  repoPath: string;
  /** Open the full-screen issue hierarchy graph. */
  onOpenHierarchy: () => void;
}

export function IssueFilters({ repoPath, onOpenHierarchy }: IssueFiltersProps) {
  const { issueFilter, issueSearch, fetchIssues } = useGitHubStore();
  const [searchInput, setSearchInput] = useState(issueSearch);

  useEffect(() => {
    setSearchInput(issueSearch);
  }, [issueSearch]);

  const applySearch = (next: string) => {
    fetchIssues(repoPath, issueFilter, next);
  };

  const handleStateChange = (filter: IssueFilterState) => {
    fetchIssues(repoPath, filter, searchInput);
  };

  const isChipActive = (clause: string) => searchInput.toLowerCase().includes(clause.toLowerCase());

  const toggleChip = (clause: string) => {
    let next: string;
    if (isChipActive(clause)) {
      next = searchInput
        .replace(new RegExp(`\\s*${escapeRegex(clause)}\\s*`, "i"), " ")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      next = `${searchInput.trim()} ${clause}`.trim();
    }
    setSearchInput(next);
    applySearch(next);
  };

  const onSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    applySearch(searchInput);
  };

  const clearSearch = () => {
    setSearchInput("");
    applySearch("");
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-maestro-border px-3 py-2">
      <div className="flex items-center gap-1">
        {STATE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => handleStateChange(f.value)}
            className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
              issueFilter === f.value
                ? "bg-maestro-accent text-white"
                : "bg-maestro-card text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
            }`}
          >
            {f.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onOpenHierarchy}
          title="Show issue hierarchy"
          aria-label="Show issue hierarchy"
          className="ml-auto rounded p-1 text-maestro-muted transition-colors hover:bg-maestro-card hover:text-maestro-text"
        >
          <Waypoints size={13} />
        </button>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => toggleChip(chip.clause)}
            className={`rounded-full px-2 py-0.5 text-[10px] transition-colors ${
              isChipActive(chip.clause)
                ? "bg-maestro-purple/20 text-maestro-purple"
                : "bg-maestro-card/60 text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <form onSubmit={onSearchSubmit} className="relative">
        <Search
          size={11}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-maestro-muted/60"
        />
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="assignee:user label:bug ..."
          className="w-full rounded-md border border-maestro-border bg-maestro-card pl-6 pr-6 py-1 text-[11px] text-maestro-text placeholder:text-maestro-muted/50 focus:border-maestro-accent focus:outline-none"
        />
        {searchInput && (
          <button
            type="button"
            onClick={clearSearch}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-maestro-muted hover:bg-maestro-border/40 hover:text-maestro-text"
            aria-label="Clear"
          >
            <X size={11} />
          </button>
        )}
      </form>
    </div>
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
