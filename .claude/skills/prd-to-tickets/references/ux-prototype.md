# The UX prototype — brief for `ux-prototype-<slug>`

Spawned by `/prd-to-tickets` phase 1 when the PRD names screens that the prototype on `main` under
`docs/ux/prototypes/` does not have: no prototype at all, or one missing some of the PRD's screens. The split stops
after this pull request opens and runs again once it is merged. The prototype is **the design front-end stories
implement**: a story that adds or changes a screen builds the prototype's screen, never a layout of its own (the
mandatory rules, *Standing decisions*). So it must show every screen the PRD names, and nothing the PRD does not.

## What it produces

Under `docs/ux/prototypes/<slug>/` (the slug is the PRD's file name without `PRD` and `.md`, lower-case, hyphenated),
or in the prototype folder that already exists for this PRD:

| File | Content |
|---|---|
| `index.html` | **One self-contained page** — inline CSS and JavaScript, no build step, no external fonts, libraries or images — that opens from disk in any browser. A left-hand or top navigation lists every screen; clicking one shows it. Each screen is a `<section id="screen-<screen-slug>">` with: a heading (the screen's name as the PRD calls it), one line saying what the user does there, the PRD section it comes from, the controls and content the PRD describes, and the **states** the PRD implies (empty, loading, error, success) as toggles or stacked variants. Fake data only, visibly synthetic (`Sample item 1`, never a real-looking name, address or number). |
| `README.md` | A table, one row per screen: `screen id` (the `section` id), name, PRD section, what the user does there, which states it shows. Then one line on how to open the file, and the line *"Front-end stories reference a screen by its id."* |

**Only the missing screens.** When a prototype already exists, add the screens the PRD names that it lacks, each as
a new `section` and a new `README.md` row, and leave every existing screen, id and row as it is: stories already cut
reference those ids.

**The PRD's one line.** When the PRD does not point at the prototype folder yet, add one line to it (under
`docs/PRDs/`, beside its screens or UX section, else at the end of its overview) naming the folder:
*"UX prototype: `docs/ux/prototypes/<slug>/`."* One line for the folder, never one link per screen, since those go
stale on every rename. Nothing else in the PRD changes.

**Fidelity:** wireframe to mid-fidelity — layout, hierarchy, labels, flows and states matter; colours and polish do
not. Follow a design system only if the project's `CLAUDE.md` or `docs/ux/` already names one, or the existing
prototype already uses one; otherwise plain, neutral, readable, and usable at a phone width as well as a desktop width.

**Never include:** personal data, production data, a real organisation's name or branding, a screen the PRD does
not describe (a gap in the PRD is reported back, not filled in), or anything a story would have to undo.

## How it works

1. Read the PRD in full, its pending ADRs (the `docs/ADRs/*.md` whose status line says `pending`), the project's
   `CLAUDE.md` (the worktree root, the working language, any named design system) and the existing prototype if
   there is one. List the missing screens and the PRD section of each **before** writing any HTML; that list becomes
   the new `README.md` rows.
2. Create a worktree outside the project at `<worktree root>/ux-prototype-<slug>` on branch
   `feat/ux-prototype-<slug>` (or the project's own branch pattern) from `origin/main`. Never work in the main
   checkout; never stash; never switch branches.
3. Write the screens and, when needed, the PRD's one line. Open `index.html` once (a headless browser if one is
   available, else read it back) and check every navigation link lands on a section and every section has the
   fields the README promises.
4. Add the pull request's own changelog file, `docs/changelog/<YYYY-MM-DD>-<branch>.md` (one line; every pull request
   carries one; create the folder with a `README.md` explaining the format if it does not exist). **Run the gate**
   (the gate commands the project's `CLAUDE.md` lists: build → lint → typecheck → full suite) in the worktree; red →
   report the failing command and stop, no pull request. On green, commit only the prototype files, the PRD (when
   its line was added) and the changelog file: `docs(ux): add the UX prototype screens for <PRD name>`, with the
   attribution trailer the session requires. Push the branch.
5. Open the pull request: title `docs(ux): UX prototype screens for <PRD name>`, body = the new screens table, the
   PRD line added (if any), what the PRD left unspecified (one line each), and *"Merged by a person (it touches
   `docs/ux/prototypes/` and `docs/PRDs/`); run `/prd-to-tickets` again once it is on `main`."* **Never merge it.**
6. Return a bounded result: the pull request link, the screen list (id and name, one line each), and every PRD gap
   found, five lines at most. On any failure: report what failed and stop; no recovery attempts.
