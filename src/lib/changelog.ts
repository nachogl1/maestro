/** One dated release-note entry shown in the Changelog modal. */
export interface ChangelogEntry {
  date: string;
  title: string;
  items: string[];
}

/** Newest first. Keep each item to one short line. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-10-19",
    title: "Easier terminal resizing, Tidy up in eagle view, safer Stop All",
    items: [
      "Terminals: grab the edge of a terminal (not just the thin line between two) to resize it, and the top-bar Tidy up button (or Alt+T) now also works in eagle view, putting every tile back to an even size.",
      "Sidebar Settings: the Stop All button now sits at the bottom of the tab, below Agents, so it is no longer clicked by mistake instead of Open Settings.",
    ],
  },
  {
    date: "2026-10-18",
    title:
      "Maestro for Mac, automatic updates when Maestro opens, opt-in Work Journal, one Settings window, Workshop, Tidy up button",
    items: [
      "Mac users can download Maestro from the Releases page (Apple Silicon and Intel) and get updates inside the app, like on Windows.",
      "Updates: turn on Install on launch (Maestro asks once, or in Settings → Updates) and an update found when you open Maestro installs by itself and restarts the app. A background check that can't reach the server retries quietly instead of showing an error, and update errors are short and fit their popup.",
      "Work Journal is off until you turn it on: Maestro asks once on first launch, remembers your answer across updates, and Settings → Work Journal has a switch to change it any time.",
      "Settings: every setting now lives in one Settings window with a menu on the left (Appearance, Features, Notifications, Updates, Terminal, AI command lines, Samurai, Work Journal, Keyboard shortcuts and Changelog), with cleaner, rounder fields and switches. Open it with Open Settings in the sidebar's Settings tab. Settings → Features switches Samurai launch, Second Brain and the Work Journal on or off; a tool that is off leaves the top bar.",
      "Notes: removing or changing one bullet no longer moves the bullets around it to a different level.",
      "Workshop: a new top-bar panel runs Claude Code's /insights once a week while Maestro is open and keeps the report there, showing when it ran, when the next run is and every past run. A Summary tab gives a short, easy-to-read version and a Real Transcript tab shows the full report exactly as /insights wrote it.",
      "Terminals: a new Tidy up button in the top bar gives every terminal of the project an even share of the screen after you resize them, and the unused Graph tab is gone from each terminal.",
    ],
  },
  {
    date: "2026-10-17",
    title: "Eagle view columns, tidier settings, Infra for every project, shorter changelog",
    items: [
      "Work Journal: suggestions now give one line per project that sums up the features worked on that day, instead of a line for every commit, pull request or session. Each suggestion's tag has its own colour per source, and git and GitHub work shows as one Git tag that says whether it came from a commit, a PR or an issue.",
      "Eagle view: drag a terminal onto the outer edge of the grid to give it its own full column or row, or onto the edge of another terminal to sit beside it. The Sort terminals by project button is gone, and the new-terminal project picker is bigger, scrolls with the arrow keys and hides its scrollbar.",
      "Maestro Settings and the Terminal, CLI, Shortcuts and Changelog dialogs share one look: same frame, headers, section cards, inputs and switches.",
      "Sidebar Settings: the Notifications and Context alert cards lost their explanatory text (the hint shows when you hover the percentage), and the Git Repository card is gone (the Git panel covers it).",
      "The Infra sidebar tab shows every open project as its own collapsible group, so you can manage each project's MCP servers, plugins, skills and context docs without switching tabs.",
      "Context alert: a changed percentage applies as soon as you stop typing, terminals showing the threshold percentage blink reliably, and every alerting terminal (parked ones too) gets a blinking red Context threshold reached banner in its header.",
      "This changelog now keeps a few lines per day instead of one per change.",
      "Terminals: a Tidy up button next to the Terminal n/m label (or Alt+T) gives every terminal an even share of the space, keeping where each one sits.",
      "Window: the minimize, maximize and close buttons stay visible however narrow the window gets, project tabs scroll sideways with the mouse wheel when there are too many to fit, and the window can be made as small as you like.",
    ],
  },
  {
    date: "2026-10-16",
    title: "Eagle view resizing, dialogs on top, Work Journal reliability",
    items: [
      "Eagle view: drag a terminal's edge to resize just that terminal, drop it on empty space to move it or on another terminal to swap; Sort terminals by project restores the automatic layout.",
      "Settings dialogs now sit above the terminals, the update toast shows again when you re-check, and the context alert level is a number you type (1-100%) or turn off.",
      "The + button is back for every project, and the new-terminal card is easier to tab through.",
      "Work Journal: more reliable and quicker, with safer backups across computers, correct meeting times, shorter non-repeating suggestions and no lost edits when quitting or using two windows.",
      "Pull requests and Issues, Samurai alerts, Claude conversation compaction, terminal naming and the settings editors got many smaller fixes.",
    ],
  },
  {
    date: "2026-10-15",
    title: "Move terminals anywhere, self-updating Maestro, Work Journal, Injector",
    items: [
      "Work Journal: a new right-side pane with one page per day, a formatting toolbar, a pop-out window and an HTML report for any date range.",
      "Work Journal: suggestions from your Claude activity (and Granola meetings if you allow it) that you accept or reject, with backup, restore and undo in Settings, and no lost edits between windows.",
      "Injector: type one message and send it to several running terminals at once (syringe icon, Alt+4).",
      "Drag terminals by the title bar to move or swap them, mix projects in eagle view, and use Alt+Shift+Arrow to nudge one.",
      "Maestro checks for new releases and installs them in one click; every merge to main publishes a signed Windows installer.",
      "Calmer parked terminals, a Context alert setting, hover explanations in Maestro Settings, a read-only pull request view, and no more pinning of project tabs.",
    ],
  },
  {
    date: "2026-10-14",
    title: "Readable History, keyboard terminals, richer issue map, agent names",
    items: [
      "History rows show the agent name, session name and a short AI summary, and search finds rows by agent name.",
      "A Claude terminal's title is its agent name; renaming the title renames the agent.",
      "Eagle view: drag gaps to resize columns and rows, Ctrl+1 zooms and Alt+P parks the focused terminal.",
      "Ctrl+T focuses the new terminal's name box; Tab then Enter launches it.",
      "Issue map opens in its own window, with an epics column, zoom, drag, and closed issues and epics hidden by default.",
      "The Git pane's Issues list shows all issues by default.",
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
