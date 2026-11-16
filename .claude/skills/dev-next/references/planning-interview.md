# The planning interview

The interview both planning skills hold before they file stories: `/prd-to-tickets` (its phase 4, before the plan
check) and `/wayfinder` (*Filing the stories*, before any story of a TICKETS map is filed). It lives here, beside
`new-issue.md`, so a change to it lands in both at once. Where the project's `CLAUDE.md` says otherwise, it wins.

A story filed `agent-ready` with a question left becomes a guess the dev agent bakes in and the reviewer cannot judge.

**What the interview reads against.** Below, *the source* is what decides the product and *the cut* is what is about
to be filed:

| Skill | The source | The cut |
|---|---|---|
| `/prd-to-tickets` | the PRD | the plan of its phase 3 |
| `/wayfinder` | the map (Destination, Notes, Settled), the answers on its closed tickets, and every PRD under `docs/PRDs/` | the epic and the stories the map is about to file |

## The rules

- **Ask every question the source leaves open**, grouped per story or per contract, through the clickable-options
  tool (`AskUserQuestion`): distinct options, your recommended answer **first and marked**, so a whole batch can be
  accepted in seconds. No cap on the number of questions. Plain language, as to a junior developer with no context.
- **Never ask what is already decided**: the PRD's build decisions, the map's *Settled* decisions (`/wayfinder`), the
  project's `CLAUDE.md` (worktree root, merge method, data rules, language, deploy target), the standing decisions.
  The PRD wins on product; the rules win on process; a contradiction between them is reported as a bug, not resolved
  by a question.
- **Rounds.** After a batch, re-read the answers against the source and the cut: a question that only now arises goes
  into the next batch. Stop when a round produces no new question.
- **"I don't know, ask <someone>"** → that story is `needs-human`, with the open question and the person's name as
  its last comment. Nothing is guessed on anyone's behalf. The rest of the plan is unaffected.
- **A reversible decision the person could take now but did not** → recommend the simplest option that meets the
  acceptance bar, say it is reversible, record the answer under that story's `## Decisions (agent-ready)`.
- **Every answer is written down** under the `## Decisions (agent-ready)` of each story it shapes, so `/dev-next`
  asks nothing.
- **A hard-to-reverse decision the source leaves open:**
  - `/prd-to-tickets` → ask it like any other question, recommended answer first; the answer goes under the
    `## Decisions (agent-ready)` of every story it shapes and is one of the lines of its phase 6 PRD question (the
    PRD's build-decisions section). No ADR, no story for it, no blocker on it.
  - `/wayfinder` → the map has not taken it yet, so the interview does not settle it: it becomes a grilling ticket on
    the map (Mode B step 5), and nothing is filed until that ticket is settled. Before the session stops, each answer
    the interview has given so far goes as one line under the map's *Settled*, so the next session reads it as
    decided and does not ask it again.
- **Work the PRD gives no tier** (`/prd-to-tickets` only; a `/wayfinder` story always takes `tier:wayfinder`) → one
  question per epic: which tier its stories take (`mvp` recommended, the PRD's other tiers as the other options). The
  answer is a PRD fact, so it is one of the lines of phase 6's PRD question.
