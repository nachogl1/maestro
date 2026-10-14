/** One dated release-note entry shown in the Changelog modal. */
export interface ChangelogEntry {
  date: string;
  title: string;
  items: string[];
}

/** Newest first. Keep each item to one short line. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-10-14",
    title: "Readable History, keyboard terminals, richer issue map",
    items: [
      "History rows show the session's name and a two-sentence AI summary instead of raw prompts.",
      "History drops the checkout/worktree/gone filter pills; the search box stays.",
      "Ctrl+T focuses the new terminal's name box; Tab then Enter launches, and focus lands in it.",
      "Issue map: epics column with epic-to-story lines, click-only highlight, zoom and drag.",
      'Issue map: the "Ready" status is now "Ready to take", so it is not mixed up with agent-ready.',
      "Issue map hides epics and closed issues by default and packs away empty columns.",
      "Issue map opens in its own window, so it never hides behind views and can sit on a second screen.",
    ],
  },
  {
    date: "2026-10-13",
    title: "Changelog, leaner UI and a sharper issue map",
    items: [
      "New Changelog entry in the Settings tab (this dialog).",
      "Removed the landscape graph, Memory/Processes/AI panels and the General tab (now in Settings).",
      "Issue map shows levels instead of waves, plus labels, descriptions and closed issues.",
      "Issue map boxes are coloured by who takes them; a cross marks closed issues.",
      "Terminals no longer close all sessions when MCP servers, skills or plugins change.",
      "Backend fixes: UNC paths, poisoned locks, file work moved off the UI thread.",
    ],
  },
  {
    date: "2026-10-12",
    title: "Issue map",
    items: [
      "New issue map: what is blocked by what, level by level.",
      "Save the issue map as a standalone HTML file to share.",
    ],
  },
  {
    date: "2026-10-08",
    title: "Issue hierarchy",
    items: ["Issue hierarchy graph with assignees and filters (later replaced by the issue map)."],
  },
  {
    date: "2026-10-02",
    title: "Status fix",
    items: ["The status tool no longer repaints its own report through its hooks."],
  },
  {
    date: "2026-09-09",
    title: "Samurai resume and preflight",
    items: [
      "One Resume-now action for every kind of parked run.",
      "Run badges show whether the agent has read its brief.",
      "Preflight checks allowance headroom and can launch past warnings-only verdicts.",
      "Externally parked runs resume when GitHub auth comes back.",
      "Restored park timers resume the run instead of failing it.",
    ],
  },
  {
    date: "2026-09-08",
    title: "Search, pins and louder parks",
    items: [
      "Search and filter chips for History, Branches, worktree status and the Resume picker.",
      "Pin terminals and project tabs so they follow you across projects and views.",
      "Allowance parks are loud when they happen and highlighted while they last.",
      "Adding a terminal keeps you in eagle view.",
      "Samurai reliability fixes: alerts, audit log rolling, interrupted-run handling.",
    ],
  },
  {
    date: "2026-08-20",
    title: "Samurai alerts",
    items: [
      "Run-fatal events raise a toast, a persistent badge and a native OS notification.",
      "Short default agent names (Samurai-N) that survive handoffs.",
      "Successor briefs are delivered reliably on the claude launch line.",
    ],
  },
  {
    date: "2026-08-17",
    title: "Brief files and Second Brain grouping",
    items: [
      "Long prompts are delivered as brief files instead of typed pastes.",
      "Second Brain artifacts are grouped by run and PR review.",
    ],
  },
  {
    date: "2026-08-14",
    title: "PR monitoring and cleanup",
    items: [
      "PR monitoring tower and a PR review workflow mode.",
      "Branches and worktrees cleanup tab.",
      "Park timestamps on parked agents.",
    ],
  },
  {
    date: "2026-08-07",
    title: "Terminal and notification polish",
    items: [
      "Terminals link the branch's PR and describe each session in one line.",
      "Toasts restructured so they read at a glance.",
      "Parked terminals come back whenever they are ready for you.",
    ],
  },
  {
    date: "2026-08-05",
    title: "Status on the dots",
    items: [
      "Session status moved to the thinking dots; borders now show the project colour.",
      "Status stays working while subagents run.",
    ],
  },
  {
    date: "2026-08-03",
    title: "Bigger grid and safer quitting",
    items: [
      "Up to 12 sessions, with a generalised grid layout.",
      "Quitting asks for confirmation while terminals are running.",
      "History resumes conversations instead of launching fresh agents.",
      "Agent graph shows what the orchestrator and its subagents exchange.",
    ],
  },
];
