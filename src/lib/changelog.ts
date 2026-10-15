/** One dated release-note entry shown in the Changelog modal. */
export interface ChangelogEntry {
  date: string;
  title: string;
  items: string[];
}

/** Newest first. Keep each item to one short line. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-10-15",
    title: "Move terminals anywhere, Maestro updates itself, Work Journal pane, Injector",
    items: [
      "Work Journal suggestions now cover every project Maestro has seen in a tab or terminal since this update, including closed tabs and every repo of a multi-repo project, not only the tabs open right now.",
      "Issue map: the 'data problems' footer now opens by itself and explains each problem in plain words — which issues and links, what it changes on the map, and how to fix it on GitHub. The saved HTML map says the same.",
      "Maestro Settings: hover over any setting (Updates, CLI command, every Samurai threshold, Work Journal, Advanced) for a plain-language explanation of what it does.",
      "Project tabs can no longer be pinned; the pin button and marker on tabs are gone. Pinning terminals is unchanged.",
      "Terminal title bar: the PR number pill and the checked-out / worktree pill are gone; the branch name stays, and hovering it still says whether it is a worktree.",
      "New terminal opens on a bare shell after Maestro updated itself: the updater relaunched Maestro without your user PATH, so it could not find the claude program. Maestro now restores the PATH from Windows itself at startup; the Work Journal AI runs were failing the same way.",
      "Footer: the disabled red Launch button no longer sits on top of the usage bars when there is nothing to launch.",
      "Injector: a right-side panel (syringe icon in the top bar, Alt+4) lists every running terminal across your projects — tick some, type one message, and it is typed and submitted into all of them at once.",
      "New terminal: the working-directory choice (New Worktree, Original Path, Current Worktree) is now a dropdown between the name box and Launch, reachable with Tab; New Worktree is the default and the three old buttons are gone.",
      "Drag a terminal by its title bar: drop it on another pane's edge to move next to it, on the middle to swap, or on the outer edge of the area for a full column or row.",
      "Eagle view: terminals of any project can be mixed in any order — drop on a tile's side to insert, on its middle to swap; Group by project undoes the mixing.",
      "Eagle view: a tile-size button makes a terminal 2 wide, 2×2 or 2 tall, and the top bar picks how many columns the grid has.",
      "Alt+Shift+Arrow moves the terminal you are typing in one step in that direction, in both views.",
      "Maestro now checks this fork's releases and can download and install a new build in one click.",
      "Installing an update now closes all terminals first, so Windows no longer asks for a reboot to finish it.",
      "Every code change merged to main is published as a signed Windows installer automatically.",
      "Work Journal settings: choose a backup folder, back up daily and on demand, see the last backup time.",
      "Work Journal: a toolbar for bold, italic, headings, lists, links, text colour, highlight and tick-box checklists.",
      "Work Journal settings: restore the journal from a backup file, with a safety copy and an Undo restore button.",
      "Work Journal: restoring a backup (or undoing a restore) keeps this computer's own settings — Granola choice, folders, model and schedule.",
      "Work Journal: a new right-side pane with one page per day — browse days, edit the title and text, add or delete a page.",
      "Work Journal settings: choose how often Claude looks for journal suggestions and which model it uses, and run it now.",
      "Work Journal: suggested lines from your activity appear under the page with a source tag — accept adds the line to the page, reject hides it; the pane icon counts today's suggestions.",
      "Work Journal: if Granola is connected in your Claude setup and you say yes once, suggestions also cover your meetings; change the choice in Settings.",
      "Work Journal: a Report button writes an achievement-focused HTML summary of any date range to a folder you choose once.",
      "Work Journal: the pop-out button opens the journal in its own window with a list of days (weekends dimmed); edits and accepted suggestions show in both the pane and the window.",
      "The Git pane's pull request view is read-only: the Merge, Close and comment controls are gone, and the View on GitHub link now sits above the description.",
      "Parked terminals stop popping back out for nothing: the CLI's 60-second idle reminder, sign-in notices, finished background agents and usage-limit auto-resumes no longer unpark a terminal — only a real question, permission prompt, finished or failed run does.",
      "Settings: a Context alert picks the context usage (50–95%, or Off) at which a Claude terminal's frame blinks red, so you can compact or hand off before it runs out.",
      "Parking a terminal now dissolves it into its shelf chip in a stream of particles, restoring it streams them back, and a terminal that asks for your input flares yellow around its edges; off when your OS asks for reduced motion.",
      "The three rippling status dots are gone from terminal tabs, title bars and the parked shelf; the single colour dot on tabs and the coloured title-bar underline still show the state.",
    ],
  },
  {
    date: "2026-10-14",
    title: "Readable History, keyboard terminals, richer issue map, agent names",
    items: [
      "Eagle view: drag the gaps between terminals to resize columns and rows; double-click resets.",
      "Eagle view: Ctrl+1 zooms and Alt+P parks the terminal you are typing in, as in a project.",
      "The Git pane's Issues list now shows all issues by default, not just ones assigned to you.",
      "A Claude terminal's title is its agent name; renaming the title renames the agent.",
      "History rows show each session's agent name, and the search box finds rows by it.",
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
