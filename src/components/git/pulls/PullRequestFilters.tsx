import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  useGitHubStore,
  type PrFilterState,
} from "../../../stores/useGitHubStore";

const STATE_FILTERS: Array<{ value: PrFilterState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All" },
];

const QUICK_CHIPS: Array<{ key: string; label: string; clause: string }> = [
  { key: "mine", label: "Mine", clause: "author:@me" },
  { key: "assigned", label: "Assigned", clause: "assignee:@me" },
  { key: "review", label: "Review", clause: "review-requested:@me" },
  { key: "mentions", label: "Mentions", clause: "mentions:@me" },
];

interface PullRequestFiltersProps {
  repoPath: string;
}

export function PullRequestFilters({ repoPath }: PullRequestFiltersProps) {
  const { prFilter, prSearch, fetchPullRequests } = useGitHubStore();
  const [searchInput, setSearchInput] = useState(prSearch);

  // Keep input in sync if store search changes externally (e.g. on tab switch).
  useEffect(() => {
    setSearchInput(prSearch);
  }, [prSearch]);

  const applySearch = (next: string) => {
    fetchPullRequests(repoPath, prFilter, next);
  };

  const handleStateChange = (filter: PrFilterState) => {
    fetchPullRequests(repoPath, filter, searchInput);
  };

  const isChipActive = (clause: string) =>
    searchInput.toLowerCase().includes(clause.toLowerCase());

  const toggleChip = (clause: string) => {
    let next: string;
    if (isChipActive(clause)) {
      next = searchInput
        .replace(new RegExp(`\\s*${escapeRegex(clause)}\\s*`, "i"), " ")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      next = (searchInput.trim() + " " + clause).trim();
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
              prFilter === f.value
                ? "bg-maestro-accent text-white"
                : "bg-maestro-card text-maestro-muted hover:bg-maestro-surface hover:text-maestro-text"
            }`}
          >
            {f.label}
          </button>
        ))}
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
