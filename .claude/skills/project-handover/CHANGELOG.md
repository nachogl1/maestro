# Changelog — project-handover

Record notable changes here.

## Product discovery is now self-contained

- **Step 2b no longer depends on a companion onboarding skill** (that skill was removed
  from the repo). The handover runs its own product discovery pass — README, product/PRD/
  architecture docs, user-facing routes/screens/commands, domain models, backlog epic
  titles — and distils it under the same no-paths / no-code / impersonal rules as before.
  The optional-companion prerequisite and the "companion unavailable" failure mode are gone.

## Renamed to `project-handover`

- The `-orion` suffix is dropped and the description now starts with `ORION -` so the
  origin stays visible in skill listings.

## Diagrams are HTML/CSS, not ASCII

- **§4's conceptual diagrams are now built as styled HTML/CSS** — boxes (flexbox/grid
  `<div>`s themed with the document palette) connected by labelled arrows (CSS connectors or
  small inline SVG) — **never as ASCII art in `<pre><code>` blocks**. ASCII breaks at narrow
  widths, looks unpolished to a client audience, and can't use the theme. Everything stays
  inline so the file remains self-contained. Updated Step 4, the Step 5 visual conventions,
  the frontmatter description, and added a failure mode.

## Deepen product & domain via the onboarding skill

- **§Product & domain (plus the TL;DR and glossary) now lean on the companion
  `create-up-to-speed-report-orion` skill's exhaustive product discovery** for real depth —
  the problem solved, who uses it, the domain vocabulary, the core end-to-end user journeys,
  and what the repository is responsible for. Added **Step 2b** describing the
  run → distill → re-filter flow, and pointed §3 at that deepened discovery.
- **The borrowed depth is re-filtered through the handover's own rules.** Every file path,
  class name, and code internal is translated into product / behaviour language; the deck's
  ownership / personal framing (mine/team/pending colour-coding, "MINE" tags,
  single-junior-reader voice) is dropped so the handover stays **neutral — by nobody, to
  nobody** — and client-facing.
- **Still one handover file, still read-only.** The companion skill is itself read-only; any
  onboarding deck it emits while enriching is a **separate by-product**, not part of the
  handover output. Added an optional-companion input note and two failure modes (companion
  unavailable → fall back to native Step 2; onboarding-deck framing must not leak in).

## Component diagram names the real services/tools

- **§4 top-level component diagram now names the actual technologies, services, and tools**
  the project uses beside each block (detected from manifests/config/compose/CI at run time)
  — e.g. "Sign-in / identity (Keycloak)", "Data store (PostgreSQL)", "Cache (Redis)" — so a
  reader can attach each abstract role to something concrete and recognisable. **Avoids
  super-generic, association-free diagrams** (bare "Frontend → Backend → Database").
- **Clarified the boundary:** naming **real third-party services, infrastructure, and
  frameworks** is wanted; it is *not* a code internal. The prohibition still stands on the
  project's **own class names, file paths, and internal code wiring**. The **data-flow
  diagram stays in product terms**. Updated Step 4, the Step 5 visual conventions, the
  "What to NOT include" code-internals note, and added a failure mode for generic diagrams.

## Reframe — neutral public/client handover, badged epics & stories

- **Audience widened to a broad public including clients and stakeholders** (not just a new
  joiner). Same zero-stack / zero-domain, plain-language baseline.
- **Tone made neutral and impersonal** — the document is addressed to **nobody, by nobody**.
  Removed the **offboarding / departing-engineer** framing entirely: no author identity,
  no successor name, no "areas I owned," no first-/second-person voice. Dropped the
  former **"My footprint & ownership"** section and the git-history footprint step, and
  removed the author/successor inputs.
- **No stale-prone content.** Removed open PRs, open branches, work-in-progress, stashes,
  and the "open threads / next steps / what to pick up" section — anything that flips within
  a day. The **only** status the doc now carries is a **dated epics-and-stories snapshot**.
- **No code internals.** Architecture, diagrams, glossary, and the build/run section now
  describe the system at **general product-behaviour / module / feature** level — **no class
  names, no file paths, no internal code wiring** (the code is often agent-generated, so that
  detail is neither known, stable, nor useful to the reader). Diagrams use **generic
  component/module names only**; dropped the "where files live" key-files map.
- **New heart section — Epics & Stories.** Lists **every epic and every story** with a short
  plain description and a **done/not-done badge** (green = done, red = not done; optional
  amber = in progress when the tracker distinguishes it) plus a per-epic roll-up. Status read
  from the project's actual **backlog source — BMAD story docs / GitHub Issues / Jira,
  detected at run time.**
- **Dropped** the "known issues / gotchas / traps" and "open questions / decisions pending"
  sections (code-specific and stale-prone) and the "resources & contacts" section (personal).
- Sections are now: cover, TL;DR/overview, product & domain context, architecture & mental
  model (conceptual diagrams), how it's built & run, epics & stories, glossary.

## Initial

- New skill: generate a single self-contained dark-themed **HTML project-handover** document
  into the user's Downloads folder (`~/Downloads/<repo-name>-handover-<YYYY-MM-DD>.html`).
- Tuned for **offboarding**, written for a **brand-new junior developer who just joined** —
  assumes **zero tech-stack and zero domain knowledge**, plain language, every term defined on
  first use with a concrete example from the actual repo, **summarised and clear** (fast
  comprehension over exhaustiveness). Scrolling reference page with a sticky table-of-contents
  and scroll-spy (not a slide deck).
- Twelve sections: cover, TL;DR, product & domain context, architecture & mental model, repo &
  dev environment (auto-detected build/test/run), current state, **git-history footprint &
  ownership** (areas owned, open branches/PRs, WIP — the "in my head" context), prioritized
  open threads & next steps, known issues/gotchas/traps, open questions/decisions pending,
  resources & contacts, glossary.
- **General-level architecture diagrams**: §4 leads with a top-level **component / inter­connection
  diagram** (the major pieces and how they connect) and a **request/data-flow diagram** tracing one
  real user action end to end — ASCII art drawn from the actual repo, each with a legend and a
  plain-English caption.
- **Local + GitHub-if-available** data mode: uses `gh` for live issue/PR/CI data when a remote
  and authenticated `gh` are present; degrades gracefully to local-git-only and badges the mode
  on the cover.
- **Strictly read-only**: reads git + repo files + GitHub, writes one HTML file to Downloads —
  never edits the repo, never commits.
- Stack, build/test/run commands, and conventions detected from the target repo at run time —
  assumes no stack. Dark-theme palette shared with the other orion report skills.
