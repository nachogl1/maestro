---
layout: default
title: Features
nav_order: 3
---

# Features
{: .no_toc }

What Maestro does today. **Mod** means Ctrl on Windows and Linux, Cmd on a Mac.
{: .fs-5 .fw-300 }

1. TOC
{:toc}

---

## Projects and terminals

- **Projects as tabs.** Open a folder with **+** in the tab bar (or pass a folder to the `maestro` command line).
  **Ctrl+Tab** and **Ctrl+Shift+Tab** cycle the tabs; **Mod+Shift+Left/Right** moves one. A hidden project keeps its
  terminals running. A multi-repository workspace asks for the repository and branch when you add a terminal.
- **Two kinds of terminal.** **Mod+T** adds a terminal card with the cursor in its name box; pick **Claude Code** or a
  **plain shell** and press **Enter**. A terminal can run in its own git worktree, so agents never edit the same
  checkout.
- **Terminal shortcuts.** **Alt+R** renames, **Alt+W** closes (after asking), **Alt+Shift+P** pins a terminal so it
  stays in view while you look at another project, **Alt+Shift+F** flags it yellow.
- **Quick actions.** Buttons under each terminal (Run App, Commit & Push, Fix Errors, Lint & Format, or your own)
  send a ready-made prompt to its agent.
- **Scratch projects.** From eagle view's new-terminal list you can create a throwaway project folder, see every
  scratch project with its age, and delete one when you are done.

## Views

- **Eagle view (Mod+G)** shows the terminals of every open project as tiles. Tiles can be moved and resized.
- **Zoom (Mod+1)** maximises the focused terminal with a tab strip of the others; **Alt+Left/Right** switch.
- **Tidy up (Alt+T)** puts every terminal in one row of full-height columns.
- **Moving around.** **Mod+Alt+arrows** move focus between terminals in every view; **Alt+Shift+arrows** swap the
  focused terminal with its neighbour. Terminals, project tabs, the zoom strip and parked pills can be dragged;
  dropping one on another swaps just those two.
- **Narrow columns.** With many terminals, a header folds its buttons into one **⋯** menu and hides the branch and
  project before the terminal's name.
- **Text size.** Font size has a setting, and the View menu zooms from 25 to 500 %.

## Status and attention

- **Live status.** Maestro adds its own Claude Code hooks to each project (leaving yours alone) and bundles a small
  status server, so every terminal shows whether its agent is starting, working, waiting for you, done or failed.
- **Attention cues.** A waiting terminal and its pill glow red. An optional beep (off by default) sounds when a
  terminal needs you.
- **Context alert.** When a Claude terminal's context use passes the alert percent (35 % by default, set in
  Settings), its header shows a red "Context threshold reached" pill and its frame and project tab blink red. The
  alert stops after `/clear` or when Claude compacts the conversation.
- **Usage bar.** The bottom of the window shows your Claude account's usage limits, read with the Claude Code
  sign-in already on your computer.

## Parking

- **Alt+P** parks a terminal: it disappears into the **Parked** strip without stopping. Click its pill to bring it
  back, or press **Alt+U** and use the arrows and **Enter**.
- A parked terminal **comes back by itself** when it finishes, fails or needs an answer (a permission prompt, a
  question, a quota wait). Notifications that need nobody leave it parked. A terminal that came back blinks yellow
  on its tabs until you select it.

## Talking to several agents

- **Injector (Alt+4)** sends one message to every running terminal you tick, across projects, and tells you which
  sends failed. A terminal that received a message shows an amber message icon on its header until you click it.
- **Triggers** send a message when a terminal's context reaches a percent you choose, to that terminal or to every
  terminal the trigger watches. They can watch every terminal, including new ones, keep working with the panel
  closed, and come back after a restart. A **History** list shows every firing of the last week and whether it
  arrived.
- **Conclave (Alt+C)** asks the Claude agents you tick to talk to each other, say which files, worktrees and ports
  they use, and agree who uses what.

## Panels

Every panel opens from the icon strip on the far left. Several can sit side by side, each resizable, and they come
back after a restart.

- **History (Alt+1)**: your Claude conversations per project and worktree, newest first, each with an AI-written
  name and summary. Search them and resume any one in its own folder.
- **Files**: the focused terminal's folder as a tree; text files preview read-only, and any file can be opened or
  its path copied.
- **Git (Mod+2)**: a commit graph with changed files; branches and worktrees (create, rename, delete, check out,
  with a warning before unsaved work is lost); changed files with side-by-side diffs; and, with the GitHub CLI
  signed in, pull requests, issues and discussions.
- **Notes (Mod+5)**: tabs of rich markdown notes, kept across restarts.
- **Work Journal**: see below.
- **Injector (Alt+4)**: messages and triggers, see above.
- **Workshop**: a weekly Claude Code `/insights` report with its run history.
- **Infra (Alt+2)**: Claude Code plugins, skills, a plugin marketplace, `CLAUDE.md` files and MCP servers per
  project. Edits go to Claude Code's own configuration files; only the entry you change is touched, and the first
  write makes a backup copy.
- **Settings (Alt+3)**: opens the Settings dialog and lists the running agents.

## GitHub and the issue map

- A badge in the top bar counts the review requests and issues assigned to you.
- The **PROJECTS** pill shows, per open project, how many open issues carry each label, and lists them.
- The **issue map (Alt+M)** opens in its own window: a project's GitHub issues in columns by level, so you see what
  blocks what. Filter by label, progress or assignee, search by number or words, click an issue to trace its chain
  and see its details, and save a standalone HTML copy.

## Work Journal

Turn it on at first start or in **Settings → Work Journal**.

- **One page per day**, with formatting, task lists and links. Pop it out into its own window if you like.
- **Suggestions.** A Claude CLI run reads the day's Claude conversations, your commits, your GitHub pull requests and
  issues, your terminal sessions and, optionally, your Granola meetings, and proposes one short summary per
  project. Accept or reject each one, or several at once; later work arrives as an update to the same summary.
- **Entry cards.** Accepted entries are cards with a time, a project chip and a source tag; edit, drag or delete
  them, or add your own with **+ Add entry**.
- **Spelling fixer (Ctrl+Shift+F)** fixes the spelling, grammar and punctuation of the selection or the whole page;
  one **Ctrl+Z** undoes it.
- **Report.** A first-person report for a date range, one heading per project.
- **Backup.** A copy in a folder you choose, daily and when Maestro closes, plus a readable `work-journal.md`.

## Safety nets

- **Crash recovery.** If Maestro stops unexpectedly, the next start offers to bring back the terminals that were
  open. Claude terminals continue their conversation; plain shells reopen empty.
- **Updates.** Maestro checks the latest release and offers **Download and Install**. Open terminals come back on
  their own after the update.

## Settings

Appearance (dark or light theme), Features, Notifications, Updates, Terminal, AI command lines, Scratch projects,
Work Journal, Keyboard shortcuts (every shortcut in one list) and Changelog (what changed, newest first).
