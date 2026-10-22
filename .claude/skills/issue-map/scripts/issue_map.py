"""Build docs/issue_map/issue_map.html: the live blocked-by graph of every GitHub issue, level by level.

Reads the issues of the repository `origin` points at through `gh` (the GitHub CLI) at the moment it runs and
writes one self-contained HTML file to docs/issue_map/ in the MAIN checkout (never a worktree, so every terminal
writes the same file). The file is a transient snapshot: it is excluded from git locally (`.git/info/exclude`),
never committed, and carries a banner saying who built it and when. Rebuild it with `/issue-map`.

    python .claude/skills/issue-map/scripts/issue_map.py            # rebuild the map, print its path
    python .claude/skills/issue-map/scripts/issue_map.py --open     # rebuild, then open it in the default browser
    python .claude/skills/issue-map/scripts/issue_map.py --silent   # rebuild only (what /dev-next calls)

Needs Python 3.9+ and `gh` signed in. No third-party packages. One run is one issue list plus one GraphQL call
per 25 issues for the native links.

Mechanic (the same rules as the work-tracking section of BASE_CLAUDE.md):
- Nodes: every issue, open and closed, of any label. Epics (label `epic`) sit in their own far-left column,
  outside the levels; an epic is tied to its stories by GitHub's native sub-issue link, drawn as a dashed purple
  line. Epics and closed issues start hidden.
- Links: the union of GitHub's native blocked-by relation and the `### Blocked by` body section.
  Nothing else is a link. A link to an epic, to an issue that was not loaded, or one that closes a cycle is
  dropped and listed as a data problem; so is an open issue whose body section and native relation disagree.
- Level: 0 when an issue has no link, else 1 + the highest level among its blockers. Closed blockers
  count; labels never change a level. The columns are the levels.
"""

from __future__ import annotations

import datetime
import html
import json
import os
import re
import subprocess
import sys
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
REL_OUT = Path("docs") / "issue_map" / "issue_map.html"

MAP_ISSUE_LIMIT = 1000  # issues loaded, open and closed (`gh issue list --limit`)
LINKS_PER_QUERY = 25  # issues per GraphQL call for the native links

# The drawing, in SVG units; the page's script re-packs the columns with the same numbers when a filter hides issues.
COL_W, NODE_W, NODE_H, ROW_H = 290, 220, 84, 98
X0, Y0, BAND_Y, LABEL_Y = 30, 70, 40, 60
CHIP_Y, CHIP_H, CHIP_FONT = 62, 16, 10
CHIP_CHAR_W, CHIP_PAD_X, CHIP_GAP, CHIP_TEXT_MAX, CHIP_MAX = 5.6, 10, 4, 10, 3
TITLE_MAX, ASSIGNEE_MAX, DESCRIPTION_MAX = 30, 28, 600
TIP_KEEP = 60  # pixels of a dragged issue card that stay on screen so it can be grabbed again
EPICS_COLUMN = "Epics"

# Icon = progress, in the order the Progress filter lists them. A closed box gets a red cross drawn over it instead.
STATUS = {
    "inprog": ("\U0001F528", "In progress", "somebody has claimed it and is building it now"),
    "ready": ("\U0001F7E2", "Ready to take", "open, nobody on it, every blocker closed"),
    "blocked": ("\U0001F512", "Blocked", "at least one blocker (a red line coming in) is still open"),
    "closed": ("✕", "Closed", "merged and closed, nothing left to do"),
}
# Background = who takes it: the name, the box colour and what it means. The label that decides it is in KIND_LABELS.
KIND = {
    "agent": ("agent-ready", "green", "nothing left to ask, an agent can claim and build it"),
    "human": ("needs-human", "red", "a person must act or decide first (the reason is the issue's last comment)"),
    "outside": ("outside-change", "blue",
                "a repository this team does not own; ends at a pull request for its own reviewer"),
    "decision": ("decision / planning", "yellow",
                 "no readiness label yet: not a story to build until somebody says who takes it"),
    "epic": ("epic", "purple", "an epic, far-left column; click it to see its stories"),
}
KIND_LABELS = (("epic", "epic"), ("outside", "outside-change"), ("human", "needs-human"), ("agent", "agent-ready"))
START_HIDDEN = {"kind": ["epic"], "status": ["closed"]}  # filter options that start unticked: the open work first

ENCODING = ("Background = who takes it (green agent-ready, red needs-human, blue outside-change, yellow anything "
            "else, purple epic). Icon = progress (\U0001F528 in progress, \U0001F7E2 ready, \U0001F512 blocked). "
            "A cross means closed.")
HINT = ("Drag to move around, scroll the wheel to zoom (or use the buttons). Click an issue to see its chain and its "
        "card, click it again to clear. Double-click opens it on GitHub. The filter menus hide or show issues "
        "(hidden issues leave the map and the rest close up); each option shows shown/total.")
LEVELS = ("An issue's level is 1 + the highest level among its blockers; Level 0 has no blockers. Only GitHub's "
          "'blocked by' relation and a '### Blocked by' section count. Epics sit in the far-left column, outside "
          "the levels, joined to their stories by dashed purple lines (GitHub's sub-issue link). Epics and closed "
          "issues start hidden: tick them in the filters. A line always runs from the blocker to the issue that "
          "waits for it; an issue opens the moment every line coming into it is grey.")
LABELS_NOTE = ("Every label on the loaded issues except the ones that decide who takes it, so labels the team adds "
               "later show up here on the next rebuild. An issue stays on the map while any of its labels is ticked.")
PROBLEMS_NOTE = ('Some "blocked by" links could not be drawn, or two sources disagree. Each one says what it changes '
                 "on the map and how to fix it on GitHub.")
LIMIT_WARNING = f"⚠ Showing the first {MAP_ISSUE_LIMIT} issues, links beyond it are dropped."


def find_root() -> Path:
    """The main checkout of the repository the current directory belongs to.

    `git rev-parse --git-common-dir` points at the shared `.git` folder even from a worktree, so the map always lands
    in the main checkout. Outside any repository, fall back to the repository this script was installed into
    (scripts/ -> issue-map/ -> skills/ -> .claude/ -> repository root).
    """
    try:
        common = subprocess.run(["git", "rev-parse", "--git-common-dir"], capture_output=True, text=True,
                                check=True, encoding="utf-8").stdout.strip()
        common_path = Path(common).resolve()
        if common_path.name == ".git":
            return common_path.parent
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return HERE.parents[3]


ROOT = find_root()
OUT = ROOT / REL_OUT


def gh(*args: str) -> str:
    return subprocess.run(["gh", *args], capture_output=True, text=True, check=True, encoding="utf-8",
                          cwd=ROOT).stdout


def ensure_excluded() -> None:
    """Keep the snapshot out of git without touching the project's .gitignore: `.git/info/exclude` is per clone."""
    try:
        ignored = subprocess.run(["git", "check-ignore", "-q", str(REL_OUT.as_posix())], cwd=ROOT,
                                 capture_output=True).returncode == 0
        if ignored:
            return
        common = subprocess.run(["git", "rev-parse", "--git-common-dir"], capture_output=True, text=True,
                                check=True, encoding="utf-8", cwd=ROOT).stdout.strip()
        exclude = (ROOT / common).resolve() / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        existing = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
        line = REL_OUT.as_posix()
        if line not in existing.splitlines():
            with exclude.open("a", encoding="utf-8") as f:
                f.write(("" if existing.endswith("\n") or not existing else "\n")
                        + "# issue map: transient, built locally by /issue-map, never committed\n" + line + "\n")
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        pass  # not a git repository, or git missing: nothing to exclude


LINK_FIELDS = ("number parent { number } blockedBy(first: 100) { nodes { number } } "
               "subIssues(first: 100) { nodes { number } }")


def load_links(owner: str, name: str, numbers: list[int]) -> dict[int, dict]:
    """Native parent, blocked-by and sub-issue links of every issue, LINKS_PER_QUERY issues per GraphQL call."""
    def numbers_of(conn: dict | None) -> list[int]:
        return [x["number"] for x in (conn or {}).get("nodes") or [] if x and "number" in x]

    links: dict[int, dict] = {}
    for start in range(0, len(numbers), LINKS_PER_QUERY):
        aliases = " ".join(f"i{k}: issue(number: {n}) {{ {LINK_FIELDS} }}"
                           for k, n in enumerate(numbers[start:start + LINKS_PER_QUERY]))
        query = f'{{ repository(owner: "{owner}", name: "{name}") {{ {aliases} }} }}'
        # gh exits non-zero when one alias errors (an issue moved away); the rest of the answer still counts
        run = subprocess.run(["gh", "api", "graphql", "-f", f"query={query}"], capture_output=True, text=True,
                             encoding="utf-8", cwd=ROOT)
        try:
            repo = (json.loads(run.stdout or "{}").get("data") or {}).get("repository")
        except json.JSONDecodeError:
            repo = None
        if not repo:
            raise subprocess.CalledProcessError(run.returncode or 1, "gh api graphql", run.stdout, run.stderr)
        for issue in repo.values():
            if issue:
                links[issue["number"]] = {"parent": (issue.get("parent") or {}).get("number"),
                                          "blocked_by": numbers_of(issue.get("blockedBy")),
                                          "sub_issues": numbers_of(issue.get("subIssues"))}
    return links


def body_blockers(body: str | None) -> set[int]:
    """Every `#N` on the lines under the body's `### Blocked by` heading up to the next heading, as /dev-next reads
    them; empty when the body has no such section."""
    m = re.search(r"### Blocked by\s*\n(.*?)(?=\n#{1,6} |\Z)", re.sub(r"\r\n?", "\n", body or ""), re.S)
    return {int(x) for x in re.findall(r"#(\d+)", m.group(1))} if m else set()


def kind_of(labels: list[str]) -> tuple[str, str | None]:
    """Who takes it, and the label that decided it (None when no label did). First match wins."""
    for kind, name in KIND_LABELS:
        hit = next((lab for lab in labels if lab.lower() == name), None)
        if hit:
            return kind, hit
    return "decision", None


def find_back_edges(nodes: list[int], edges: list[tuple[int, int]]) -> set[tuple[int, int]]:
    """The (blocker, blocked) links that close a cycle, found depth first in number order so the same one is
    dropped every time."""
    out: dict[int, list[int]] = {n: [] for n in nodes}
    for source, target in sorted(edges):
        out[source].append(target)
    grey, black = 1, 2
    colour: dict[int, int] = {}
    back: set[tuple[int, int]] = set()
    for root in nodes:
        if root in colour:
            continue
        colour[root] = grey
        stack = [(root, iter(out[root]))]
        while stack:
            n, todo = stack[-1]
            for target in todo:
                if colour.get(target) == grey:
                    back.add((n, target))
                elif target not in colour:
                    colour[target] = grey
                    stack.append((target, iter(out[target])))
                    break
            else:
                colour[n] = black
                stack.pop()
    return back


def build_map(issues: list[dict], links: dict[int, dict]) -> dict:
    """Lay out the loaded issues: columns, boxes, lines and the data problems the page lists."""
    by = {i["number"]: i for i in issues}
    labels = {n: [lab["name"] for lab in i["labels"]] for n, i in by.items()}

    def is_open(n: int) -> bool:
        return by[n]["state"].upper() == "OPEN"

    def is_epic(n: int) -> bool:
        return kind_of(labels[n])[0] == "epic"

    no_links = {"parent": None, "blocked_by": [], "sub_issues": []}
    nodes = sorted(n for n in by if not is_epic(n))
    epics = sorted(n for n in by if is_epic(n))
    edges: list[tuple[int, int]] = []
    problems: list[dict] = []
    for n in nodes:
        native = set(links.get(n, no_links)["blocked_by"])
        section = body_blockers(by[n].get("body"))
        # Every ticket sets both forms, so on an open issue any difference, a missing section included, is a problem.
        if is_open(n) and section != native:
            problems.append({"kind": "disagreement", "number": n, "section_only": sorted(section - native),
                             "native_only": sorted(native - section)})
        for b in sorted(native | section):
            if b not in by:
                problems.append({"kind": "not-loaded", "blocked": n, "blocker": b})
            elif is_epic(b):
                problems.append({"kind": "epic", "blocked": n, "blocker": b})
            else:
                edges.append((b, n))
    back = find_back_edges(nodes, edges)
    problems += [{"kind": "cycle", "blocked": t, "blocker": s} for s, t in edges if (s, t) in back]
    edges = [e for e in edges if e not in back]

    up: dict[int, list[int]] = {n: [] for n in nodes}
    down: dict[int, list[int]] = {n: [] for n in nodes}
    for s, t in sorted(edges):
        up[t].append(s)
        down[s].append(t)

    # Epic -> its stories, from GitHub's sub-issue link (either side of it); a story belongs to the lowest epic.
    kids = {e: sorted({k for k in links.get(e, no_links)["sub_issues"] if k in up}
                      | {n for n in nodes if links.get(n, no_links)["parent"] == e}) for e in epics}
    parent: dict[int, int] = {}
    for e in epics:
        for k in kids[e]:
            parent.setdefault(k, e)

    level: dict[int, int] = {}
    for n in nodes:  # the kept links never close a cycle, so this always ends
        stack = [n]
        while stack:
            m = stack[-1]
            waiting = [b for b in up[m] if b not in level]
            if m in level:
                stack.pop()
            elif waiting:
                stack.extend(waiting)
            else:
                level[m] = max((level[b] + 1 for b in up[m]), default=0)
                stack.pop()

    def ordered(members: list[int]) -> list[int]:  # open issues first by number, closed ones at the bottom
        return sorted(members, key=lambda n: (not is_open(n), n))

    columns = [(EPICS_COLUMN, ordered(epics))] if epics else []
    for lv in range(max(level.values(), default=-1) + 1):
        columns.append((f"Level {lv}", ordered([n for n in nodes if level[n] == lv])))

    def status(n: int) -> str:
        if not is_open(n):
            return "closed"
        if any(is_open(b) for b in up.get(n, [])):
            return "blocked"
        return "inprog" if by[n]["assignees"] else "ready"

    def brief(n: int) -> dict:
        return {"n": n, "title": by[n]["title"], "state": by[n]["state"].upper()}

    meta: dict[int, dict] = {}
    for name, members in columns:
        for n in members:
            kind, kind_label = kind_of(labels[n])
            meta[n] = {"title": by[n]["title"], "state": by[n]["state"].upper(), "url": by[n]["url"],
                       "status": status(n), "kind": kind, "kindLabel": kind_label, "column": name,
                       "labels": labels[n], "body": description_text(by[n].get("body") or ""),
                       "assignees": [a["login"] for a in by[n]["assignees"]], "parent": parent.get(n),
                       "stories": [brief(k) for k in kids.get(n, [])],
                       "blockers": [brief(b) for b in up.get(n, [])], "waiting": down.get(n, [])}
    colours = {lab["name"]: lab.get("color", "") for i in issues for lab in i["labels"]}
    return {"columns": columns, "meta": meta, "up": up, "edges": [(s, t, is_open(s)) for s, t in sorted(edges)],
            "epic_edges": [(e, k) for e in epics for k in kids[e]], "problems": problems,
            "label_colours": {k: v for k, v in colours.items() if re.fullmatch(r"[0-9a-fA-F]{6}", v or "")}}


def truncate(text: str, limit: int) -> str:
    return text[:limit] + "…" if len(text) > limit else text


def description_text(body: str) -> str:
    """The card's description: the body as plain text (markdown lightly stripped), cut at DESCRIPTION_MAX."""
    text = re.sub(r"<!--[\s\S]*?-->", "", body)
    text = re.sub(r"^[ \t]*#{1,6}[ \t]+", "", text, flags=re.M)
    text = re.sub(r"\*\*|__", "", text)
    text = re.sub(r"`+", "", text)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\n{3,}", "\n\n", re.sub(r"\r\n?", "\n", text)).strip()
    return truncate(text, DESCRIPTION_MAX)


def chip_width(text: str) -> int:
    return int(len(text) * CHIP_CHAR_W + 0.5) + CHIP_PAD_X


def label_chips(labels: list[str]) -> list[tuple[str, int, int]]:
    """Up to CHIP_MAX label chips (text, x, width) that fit the box, then a "+N" chip for the rest."""
    chips: list[tuple[str, int, int]] = []
    x = shown = 0
    for label in labels:
        text = truncate(label, CHIP_TEXT_MAX)
        rest = len(labels) - shown - 1
        reserve = CHIP_GAP + chip_width(f"+{rest}") if rest > 0 else 0
        if shown >= CHIP_MAX or x + chip_width(text) + reserve > NODE_W - 20:
            break
        chips.append((text, x, chip_width(text)))
        x += chip_width(text) + CHIP_GAP
        shown += 1
    if len(labels) > shown:
        chips.append((f"+{len(labels) - shown}", x, chip_width(f"+{len(labels) - shown}")))
    return chips


def explain_problem(p: dict, title_of: dict[int, str]) -> tuple[str, str, str]:
    """One data problem in plain words: what was found, what the map did about it, and what fixes it on GitHub."""
    def ref(n: int) -> str:
        return f'#{n} "{title_of[n]}"' if n in title_of else f"#{n}"

    def refs(numbers: list[int]) -> str:
        return ", ".join(ref(n) for n in numbers)

    if p["kind"] == "disagreement":
        issue, s_only, n_only = ref(p["number"]), p["section_only"], p["native_only"]
        section = f'the "### Blocked by" section in the body of {issue}'
        if s_only and n_only:
            found = (f"{section} names {refs(s_only)} but GitHub's own blocked-by relation does not, and the "
                     f"relation names {refs(n_only)} but the section does not")
        elif s_only:
            found = f"{section} names {refs(s_only)} but GitHub's own blocked-by relation does not"
        else:
            found = f"GitHub's own blocked-by relation of {issue} names {refs(n_only)} but {section} does not"
        return (f'{issue}: its two "blocked by" sources disagree',
                f"{found}. The map keeps every blocker from either source, so nothing is missing here, but one of "
                "the two sources is out of date.",
                "On GitHub, make the section and the relation name the same blockers.")
    blocked, blocker = ref(p["blocked"]), ref(p["blocker"])
    if p["kind"] == "epic":
        return (f"{blocked} is blocked by {blocker}, which is an epic: link dropped",
                "Epics are containers, not work, so they sit in their own column and never block anything. "
                f"Without this link {blocked} may sit at a lower level than it should.",
                f"On GitHub, block {blocked} by the concrete issue inside the epic it really waits for, and remove "
                "the link to the epic.")
    if p["kind"] == "not-loaded":
        return (f"{blocked} is blocked by #{p['blocker']}, which is not on the map: link dropped",
                f"#{p['blocker']} is not among the issues the map loaded. It is probably a pull request, an issue "
                f"in another repository, a typo, or an issue beyond the {MAP_ISSUE_LIMIT}-issue load limit. "
                f"Without this link {blocked} may sit at a lower level than it should.",
                f"Open #{p['blocker']} on GitHub. If it is a real issue of this repository, the map hit its load "
                "limit; otherwise point the link at the right issue or remove it.")
    if p["blocked"] == p["blocker"]:
        return (f"{blocked} is blocked by itself: link dropped",
                "An issue that waits for itself could never open, so the map drops this link.",
                f"On GitHub, remove {blocked} from its own blocked-by list.")
    return (f"{blocked} is blocked by {blocker}, which closes a loop: link dropped",
            f"Following the blocked-by links from {blocker} leads back to {blocked}, so neither could ever open. "
            "The map drops this one link to break the loop; the other links in the loop stay.",
            "Decide which of the two really goes first and remove the link that points the wrong way.")


def links_sentence(problems: list[dict]) -> str:
    """The one sentence other skills read: whether the two blocker sources agree, and every dropped link."""
    mism = [p["number"] for p in problems if p["kind"] == "disagreement"]
    out = ("Source: the ### Blocked by body section plus GitHub's native relation; "
           + ("they agree on every open issue." if not mism else
              "they DISAGREE on: " + ", ".join(f"#{n}" for n in mism) + "."))
    dropped = [p for p in problems if p["kind"] in ("epic", "not-loaded")]
    if dropped:
        out += (" Dropped links to an epic or to an issue that does not exist: "
                + ", ".join(f"#{p['blocked']}->#{p['blocker']}" for p in dropped) + ".")
    cycles = [p for p in problems if p["kind"] == "cycle"]
    if cycles:
        out += " Dropped links that close a cycle: " + ", ".join(
            f"#{p['blocked']}->#{p['blocker']}" for p in cycles) + "."
    return out


def edge_path(a: tuple[float, float], b: tuple[float, float]) -> str:
    """Cubic from the blocker's right edge to the waiting issue's left edge."""
    sx, sy, tx, ty = a[0] + NODE_W, a[1] + NODE_H / 2, b[0], b[1] + NODE_H / 2
    mx = (sx + tx) / 2
    return f"M{sx:g},{sy:g} C{mx:g},{sy:g} {mx:g},{ty:g} {tx:g},{ty:g}"


def script_json(value: object) -> str:
    """JSON that is safe inside a <script> block."""
    return json.dumps(value).replace("<", "\\u003c")


def plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def render(m: dict, repo_name: str, user: str, stamp: str, truncated: bool) -> str:
    esc = html.escape
    columns, meta = m["columns"], m["meta"]
    rows = max([1, *(len(members) for _, members in columns)])
    xy: dict[int, tuple[float, float]] = {}
    svg: list[str] = []
    for j, (name, members) in enumerate(columns):
        x = X0 + j * COL_W
        off = (rows - len(members)) * ROW_H / 2
        for i, n in enumerate(members):
            xy[n] = (x, Y0 + off + i * ROW_H)
        closed = sum(meta[n]["state"] != "OPEN" for n in members)
        svg.append(f'<rect class="band b{j % 2}" data-col="{j}" x="{x - (COL_W - NODE_W) / 2:g}" y="{BAND_Y}" '
                   f'width="{COL_W}" height="{Y0 + rows * ROW_H + 30 - BAND_Y}"/>'
                   f'<text class="wl" data-col="{j}" x="{x + NODE_W / 2:g}" y="{LABEL_Y}" text-anchor="middle">'
                   f'{esc(name)} <tspan class="wc">{closed}/{len(members)} closed</tspan></text>')
    for s, t, still_open in m["edges"]:
        svg.append(f'<path class="e {"open" if still_open else "closed"}" data-from="{s}" data-to="{t}" '
                   f'd="{edge_path(xy[s], xy[t])}"/>')
    for e, k in m["epic_edges"]:
        svg.append(f'<path class="e epl" data-from="{e}" data-to="{k}" d="{edge_path(xy[e], xy[k])}"/>')
    for n, d in meta.items():
        x, y = xy[n]
        if d["kind"] == "epic":
            tag = "epic"
            sub = f"{sum(k['state'] == 'CLOSED' for k in d['stories'])}/{len(d['stories'])} stories closed"
        else:
            tag = f"epic #{d['parent']}" if d["parent"] is not None else ""
            sub = "\U0001F464 " + truncate(", ".join(d["assignees"]), ASSIGNEE_MAX) if d["assignees"] else ""
        cross = (f'<line class="x" x1="4" y1="4" x2="{NODE_W - 4}" y2="{NODE_H - 4}"/>'
                 f'<line class="x" x1="{NODE_W - 4}" y1="4" x2="4" y2="{NODE_H - 4}"/>' if d["status"] == "closed"
                 else "")
        icon = "" if d["status"] == "closed" else STATUS[d["status"]][0]
        chips = "".join(f'<g class="lb" transform="translate({10 + cx},{CHIP_Y})"><rect width="{w}" '
                        f'height="{CHIP_H}" rx="8"/><text x="{w / 2:g}" y="{CHIP_H - 4}" text-anchor="middle" '
                        f'font-size="{CHIP_FONT}">{esc(text)}</text></g>' for text, cx, w in label_chips(d["labels"]))
        svg.append(f'<g class="node {d["status"]} k-{d["kind"]}" data-id="{n}" transform="translate({x:g},{y:g})">'
                   f'<rect width="{NODE_W}" height="{NODE_H}" rx="7"/>{cross}'
                   f'<text class="num" x="10" y="18">#{n} <tspan class="ic">{icon}</tspan></text>'
                   f'<text class="ep" x="{NODE_W - 10}" y="18" text-anchor="end">{esc(tag)}</text>'
                   f'<text class="tt" x="10" y="36">{esc(truncate(d["title"], TITLE_MAX))}</text>'
                   f'<text class="as" x="10" y="52">{esc(sub)}</text>{chips}</g>')

    problems = m["problems"]
    title_of = {n: d["title"] for n, d in meta.items()}
    if problems:
        cards = "".join(f'<li><div class="ph">{esc(head)}</div><div class="pe">{esc(effect)}</div>'
                        f'<div class="pe"><b>Fix:</b> {esc(fix)}</div></li>'
                        for head, effect, fix in (explain_problem(p, title_of) for p in problems))
        pane_body = f'<p class="pn">{esc(PROBLEMS_NOTE)}</p><ul class="pl">{cards}</ul>'
        pane_title = "⚠ " + plural(len(problems), "data problem")
    else:
        pane_body = '<p class="pn">Every "blocked by" link was drawn and no two sources disagree.</p>'
        pane_title = "✓ No data problems"
    epic_count = sum(d["kind"] == "epic" for d in meta.values())
    counts = (f"{plural(len(meta) - epic_count, 'issue')} + {plural(epic_count, 'epic')} · "
              f"{plural(len(m['edges']), 'blocked-by link')}")
    title = f"{repo_name} · issue map: what is blocked by what, level by level"
    data = {"META": meta, "UP": m["up"], "LAYOUT": [members for _, members in columns], "STATUS": STATUS,
            "KIND": KIND, "KINDLABELS": [name for _, name in KIND_LABELS], "START": START_HIDDEN, "HINT": HINT,
            "LABELS_NOTE": LABELS_NOTE, "COLOURS": m["label_colours"], "PROBLEMS": len(problems),
            "G": {"COLW": COL_W, "NODEW": NODE_W, "NODEH": NODE_H, "ROWH": ROW_H, "X0": X0, "Y0": Y0,
                  "BANDY": BAND_Y, "TIPKEEP": TIP_KEEP}}
    consts = "".join(f"const {k}={script_json(v)};" for k, v in data.items())
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{esc(title)}</title><style>{CSS}</style></head><body>
<header><div class="bar"><h1>{esc(title)}</h1><span class="sub">{counts}</span>{f'<span class="limit">{esc(LIMIT_WARNING)}</span>' if truncated else ""}<span class="grow"></span><button type="button" id="ptoggle" class="tb{" warn" if problems else ""}" aria-pressed="false" title="Show or hide the data problems">{pane_title} {PANEL_ICON}</button></div>
<div class="top"><div id="banner">⚠ Transient snapshot, not a source of truth. Generated by <b>{esc(user)}</b> on <b>{esc(stamp)}</b> from the GitHub issues as they were at that moment; it goes stale as soon as any issue changes. Rebuild it with <code>/issue-map</code> or ask "show me the issue map". The live state is always the GitHub issues.</div>
<div id="filters"><b class="fb-name">Filters</b><span id="menus"></span><span id="count"></span><a href="#" id="all">show all</a></div>
<div id="enc">{esc(ENCODING)}</div><div id="hint"></div></div></header>
<div id="main"><div id="wrap"><div id="zoom"><button type="button" class="tb" id="zin" title="Zoom in">+</button><button type="button" class="tb" id="zout" title="Zoom out">−</button><button type="button" class="tb" id="zfit" title="Fit the whole map">Fit</button><button type="button" class="tb" id="z100" title="Actual size">100%</button><span id="zpct"></span></div><svg id="map"><g id="vp">{"".join(svg)}</g></svg></div>
<aside id="problems" aria-label="Data problems" hidden><div class="ptitle"><span class="{"warn" if problems else "ok"}">{pane_title}</span><span class="grow"></span><button type="button" id="pclose" class="x-btn" aria-label="Hide data problems" title="Hide">✕</button></div>{pane_body}</aside></div>
<footer>{esc(LEVELS)} {esc(links_sentence(problems)).replace("### Blocked by", "<code>### Blocked by</code>", 1)}</footer>
<div id="tip" role="tooltip"></div>
<script>{consts}
{JS}</script></body></html>"""


def main() -> None:
    try:
        issues = json.loads(gh("issue", "list", "--state", "all", "--limit", str(MAP_ISSUE_LIMIT), "--json",
                               "number,title,state,labels,assignees,body,url"))
        repo = json.loads(gh("repo", "view", "--json", "name,owner"))
        links = load_links(repo["owner"]["login"], repo["name"], sorted(i["number"] for i in issues))
    except FileNotFoundError:
        sys.exit("issue-map: `gh` (the GitHub CLI) is not installed or not on PATH; nothing rebuilt")
    except subprocess.CalledProcessError as e:
        reason = (e.stderr or "").strip().splitlines()
        sys.exit("issue-map: `gh` could not read the issues (not signed in, no network, or no GitHub remote)"
                 + (": " + reason[-1] if reason else ""))
    try:
        user = gh("api", "user", "--jq", ".login").strip()
    except subprocess.CalledProcessError:
        user = subprocess.run(["git", "config", "user.name"], capture_output=True, text=True,
                              cwd=ROOT).stdout.strip() or "unknown"
    stamp = datetime.datetime.now().astimezone().strftime("%d %b %Y %H:%M %Z")
    issue_map = build_map(issues, links)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(issue_map, repo["name"], user, stamp, len(issues) >= MAP_ISSUE_LIMIT), encoding="utf-8")
    ensure_excluded()
    epic_count = sum(d["kind"] == "epic" for d in issue_map["meta"].values())
    print(f"{OUT} - {len(issue_map['meta']) - epic_count} issues + {epic_count} epics - generated by {user} on {stamp}")
    print(links_sentence(issue_map["problems"]))
    if "--open" in sys.argv[1:]:
        if os.name == "nt":
            os.startfile(OUT)  # type: ignore[attr-defined]
        else:
            webbrowser.open(OUT.as_uri())


PANEL_ICON = ('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
              'aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></svg>')

# Box fills: each palette colour at the same light alpha, so the text on top stays readable in both themes.
TONE = {"green": "rgba(63,185,80,.22)", "red": "rgba(220,38,38,.22)", "blue": "rgba(59,130,246,.22)",
        "yellow": "rgba(234,179,8,.22)", "purple": "rgba(188,140,255,.22)"}

CSS = """:root{--bg:#0d0d10;--surface:#121316;--card:#18191c;--border:#26262c;--text:#e8e8ec;--muted:#82828e;--blue:#3b82f6;--green:#3fb950;--red:#dc2626;--yellow:#eab308;--purple:#bc8cff;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#f6f6f8;--surface:#fff;--card:#fafafc;--border:#dcdce2;--text:#101014;--muted:#646470;color-scheme:light}}
[hidden]{display:none!important}
html,body{height:100%}body{display:flex;flex-direction:column;overflow:hidden;margin:0;font:13px/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text)}
header{flex:none;z-index:4;background:var(--bg)}
.bar{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;border-bottom:1px solid var(--border)}
h1{font-size:14px;font-weight:600;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub{font-size:11px;color:var(--muted);white-space:nowrap}.limit{font-size:11px;color:var(--yellow);white-space:nowrap}.grow{flex:1}
.tb{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;font:inherit;font-size:11px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--card);color:var(--muted);cursor:pointer}.tb:hover{color:var(--text)}
#ptoggle.warn{border-color:rgba(234,179,8,.4);color:var(--yellow)}#ptoggle.on{background:rgba(127,127,140,.18)}#ptoggle.warn.on{background:rgba(234,179,8,.1)}
.top{padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px}
#banner{background:rgba(234,179,8,.1);color:var(--yellow);border:1px solid rgba(234,179,8,.4);border-radius:6px;padding:4px 12px;margin-bottom:8px}
#banner code{font-size:11px}
#filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.fb-name{color:var(--muted);margin-right:4px}#menus{display:contents}
#count{font-weight:700;margin-left:4px}#all{font-size:11px;color:var(--blue);text-decoration:none}#all:hover{text-decoration:underline}
#enc,#hint{color:var(--muted);font-size:11px;margin-top:4px}#hint{min-height:2.9em}
.fm{position:relative}
.fb{display:flex;align-items:center;gap:6px;height:26px;padding:0 6px 0 8px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font:inherit;font-size:12px;cursor:pointer}
.fb:hover{border-color:var(--muted)}.fs{font-size:11px;color:var(--muted)}.chev{font-size:10px;color:var(--muted);transition:transform .15s}
.fm.active .fb{border-color:rgba(59,130,246,.55);background:rgba(59,130,246,.1)}.fm.active .fs{color:var(--blue);font-weight:600}
.fm.open .fb{border-color:var(--blue)}.fm.open .chev{transform:rotate(180deg)}
.fp{position:absolute;top:calc(100% + 4px);left:0;z-index:50;width:290px;border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:6px;font-size:12px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.fh{display:flex;justify-content:space-between;align-items:center;padding:2px 6px 6px}.fh span{font-size:11px;color:var(--muted)}.fh a,.only{color:var(--blue);text-decoration:none;cursor:pointer}.fh a:hover,.only:hover{text-decoration:underline}
.fq{box-sizing:border-box;width:calc(100% - 4px);margin:0 2px 6px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font:inherit;font-size:11px}.fq:focus{outline:none;border-color:var(--blue)}
.fr{max-height:300px;overflow:auto}
.fo{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;cursor:pointer;user-select:none}.fo:hover{background:var(--card)}.fo input{margin:0;flex:none}
.fl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fl.offl{color:var(--muted)}
.only{display:none;font:inherit;font-size:11px;background:none;border:0;padding:0}.fo:hover .only{display:inline}
.fc{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.fd{height:1px;background:var(--border);margin:4px 2px}.fe{padding:6px;color:var(--muted)}
.fn{margin:0;padding:6px 6px 2px;border-top:1px solid var(--border);margin-top:4px;font-size:11px;line-height:1.35;color:var(--muted)}
.sw{display:inline-block;flex:none;width:10px;height:10px;border-radius:4px;border:2px solid var(--border)}
.sw.xs{background:linear-gradient(to top right,transparent 44%,var(--red) 44%,var(--red) 56%,transparent 56%),linear-gradient(to top left,transparent 44%,var(--red) 44%,var(--red) 56%,transparent 56%)}
.dot{display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 1px var(--border)}
#main{flex:1;min-height:0;display:flex}
#wrap{flex:1;min-width:0;position:relative;overflow:hidden;cursor:grab;touch-action:none}#wrap.drag{cursor:grabbing}
#map{width:100%;height:100%;display:block;user-select:none}
#zoom{position:absolute;right:16px;top:12px;z-index:3;display:flex;gap:6px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px 8px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
#zpct{color:var(--muted);font-size:11px;min-width:40px;text-align:right}
#problems{width:380px;flex:none;display:flex;flex-direction:column;border-left:1px solid var(--border);background:var(--surface)}
.ptitle{display:flex;align-items:center;gap:6px;height:36px;padding:0 6px 0 12px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600}.ptitle .warn{color:var(--yellow)}.ptitle .ok{color:var(--green)}
.x-btn{border:0;background:none;color:var(--muted);cursor:pointer;font-size:13px;padding:4px;border-radius:4px}.x-btn:hover{background:var(--card);color:var(--text)}
.pn{margin:0;padding:8px 12px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted)}
.pl{list-style:none;margin:0;padding:8px 10px;overflow:auto;flex:1;min-height:0}
.pl li{margin-bottom:8px;padding:8px 10px;border:1px solid var(--border);border-left:3px solid var(--yellow);border-radius:6px;background:var(--card);font-size:12px}
.ph{font-weight:600}.pe{margin-top:3px;color:var(--muted)}.pe b{color:var(--text)}
.band.b0{fill:var(--card);fill-opacity:.45}.band.b1{fill:var(--card)}
.wl{font-size:15px;font-weight:700;fill:var(--text)}.wc{font-weight:500;fill:var(--muted);font-size:12px}
.e{fill:none;stroke-width:1.6;opacity:.6}.e.closed{stroke:var(--muted)}.e.open{stroke:var(--red);stroke-width:2}
.e.epl{stroke:var(--purple);stroke-dasharray:5 4;opacity:.45}
.node rect{stroke:var(--border);stroke-width:4;cursor:pointer}.node text,.node line,.node .lb{pointer-events:none}
.num{font-weight:700;font-size:13px;fill:var(--text)}.ic{font-size:12px;font-family:"Segoe UI Emoji",system-ui}
.ep{font-size:11px;fill:var(--muted)}.tt{font-size:12px;fill:var(--text)}.as{font-size:11px;fill:var(--muted);font-weight:700}
.node .lb rect{fill:var(--card);stroke:var(--border);stroke-width:1}.lb text{fill:var(--muted)}
.node.k-decision .tt{fill:var(--muted);font-style:italic}
.node .x{stroke:var(--red);stroke-width:2;opacity:.55}
.node.off,.e.off,.band.off,.wl.off{display:none}
svg.focus .node,svg.focus .e{opacity:.12}svg.focus .node.hl,svg.focus .e.hl{opacity:1}svg.focus .e.hl{stroke-width:3}svg.focus .node.sel>rect{stroke-width:7}
footer{flex:none;max-height:6em;overflow:auto;border-top:1px solid var(--border);padding:6px 12px;color:var(--muted);font-size:11px}
#tip{position:fixed;z-index:60;display:none;max-width:480px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.4);padding:10px 14px;font-size:13px;color:var(--text)}
#tip .handle{display:flex;align-items:flex-start;gap:6px;margin:0 -4px 4px;padding:0 4px;border-radius:4px;cursor:grab;touch-action:none;user-select:none}#tip .handle:hover{background:var(--card)}#tip .handle:active{cursor:grabbing}#tip .handle svg{flex:none;margin-top:3px;color:var(--muted)}
#tip h3{margin:0;font-size:14px;font-weight:700}
#tip .row{margin:2px 0}#tip .m{color:var(--muted)}
#tip .st{display:inline-block;padding:0 8px;border-radius:999px;border:3px solid var(--border);font-weight:700}
#tip .lbl{display:inline-block;padding:0 6px;border-radius:999px;border:1px solid var(--border);background:var(--card);font-size:11px;margin-left:4px}#tip .lbl.k{font-weight:700;border-color:var(--text)}
#tip .desc{margin-top:2px;max-height:160px;overflow:auto;white-space:pre-wrap;font-size:12px;color:var(--muted);padding:4px 6px;border:1px solid var(--border);border-radius:4px}
#tip ul{margin:4px 0 0;padding-left:16px}#tip .c{text-decoration:line-through;color:var(--muted)}#tip .o{color:var(--red);font-weight:700}
#tip .acts{display:flex;align-items:center;gap:8px;margin-top:8px}#tip .acts .m{font-size:12px}
""" + "".join(f".node.k-{k} > rect,.sw.k-{k},#tip .st.k-{k}{{background:{TONE[tone]};fill:{TONE[tone]}}}"
              for k, (_, tone, _) in KIND.items())

JS = """const down={};for(const n in UP){for(const b of UP[n]){(down[b]=down[b]||[]).push(+n)}}
const svg=document.getElementById('map'),tip=document.getElementById('tip'),wrap=document.getElementById('wrap'),vp=document.getElementById('vp');
const ALL=Object.keys(META).map(Number),NOBODY='\\u0000nobody',NOLABEL='\\u0000nolabel';
let pinned=null,tipSpot=null,tipDrag=null,openMenu=null,VIS=new Set(ALL),GW=1,GH=1,zoomReady=false;
function walk(start,adj){const s=new Set();const q=[start];while(q.length){const n=q.pop();for(const m of (adj[n]||[])){if(!s.has(m)){s.add(m);q.push(m)}}}return s}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
const byName=(a,b)=>a.localeCompare(b);
const own=n=>META[n].labels.filter(l=>!KINDLABELS.includes(l.toLowerCase()));
const logins=[...new Set(ALL.flatMap(n=>META[n].assignees))].sort(byName);
const labelNames=[...new Set(ALL.flatMap(own))].sort(byName);
const OFF={kind:new Set(START.kind),status:new Set(START.status),who:new Set(),label:new Set()};
const FAMILIES=[
{ax:'kind',name:'Who takes it',has:(n,v)=>META[n].kind===v,opts:Object.keys(KIND).map(k=>({v:k,label:KIND[k][0],sw:'<i class="sw k-'+k+'"></i>'}))},
{ax:'status',name:'Progress',has:(n,v)=>META[n].status===v,opts:Object.keys(STATUS).map(s=>({v:s,label:s==='closed'?STATUS[s][1]:STATUS[s][0]+' '+STATUS[s][1],sw:s==='closed'?'<i class="sw xs"></i>':''}))},
{ax:'who',name:'Assignee',has:(n,v)=>v===NOBODY?META[n].assignees.length===0:META[n].assignees.includes(v),opts:[...logins.map(l=>({v:l,label:'\\u{1F464} '+l})),{v:NOBODY,label:'nobody assigned',apart:true}]},
{ax:'label',name:'Labels',search:true,note:LABELS_NOTE,has:(n,v)=>v===NOLABEL?own(n).length===0:own(n).includes(v),opts:[...labelNames.map(l=>({v:l,label:l,sw:'<i class="dot" style="background:#'+(COLOURS[l]||'cfd3d7')+'"></i>'})),{v:NOLABEL,label:'no other label',apart:true}]}];
function visibleSet(){return new Set(ALL.filter(n=>{const m=META[n];if(OFF.status.has(m.status)||OFF.kind.has(m.kind))return false;
const who=m.assignees.length?m.assignees.some(a=>!OFF.who.has(a)):!OFF.who.has(NOBODY);const ls=own(n);
return who&&(ls.length?ls.some(l=>!OFF.label.has(l)):!OFF.label.has(NOLABEL))}))}
function renderButton(f){const on=f.opts.filter(o=>!OFF[f.ax].has(o.v)).length,tot=f.opts.length;
f.el.querySelector('.fs').textContent=on===tot?'all':on===0?'none':on+'/'+tot;f.el.classList.toggle('active',on<tot);f.el.classList.toggle('open',openMenu===f)}
function renderRows(f){const qi=f.el.querySelector('.fq'),q=qi?qi.value.trim().toLowerCase():'';
const rows=f.opts.map((o,i)=>({o,i})).filter(r=>!q||r.o.label.toLowerCase().includes(q));
const row=r=>{const on=!OFF[f.ax].has(r.o.v),tot=ALL.filter(n=>f.has(n,r.o.v)).length,shown=ALL.filter(n=>VIS.has(n)&&f.has(n,r.o.v)).length;
return '<label class="fo"><input type="checkbox" data-i="'+r.i+'"'+(on?' checked':'')+' aria-label="'+esc(r.o.label)+'">'+(r.o.sw||'')+'<span class="fl'+(on?'':' offl')+'" title="'+esc(r.o.label)+'">'+esc(r.o.label)+'</span><button type="button" class="only" data-i="'+r.i+'" aria-label="Only '+esc(r.o.label)+'">only</button><span class="fc">'+shown+'/'+tot+'</span></label>'};
const main=rows.filter(r=>!r.o.apart),apart=rows.filter(r=>r.o.apart);
f.el.querySelector('.fr').innerHTML=(rows.length?'':'<div class="fe">Nothing matches "'+esc(qi.value)+'".</div>')+main.map(row).join('')+(main.length&&apart.length?'<div class="fd"></div>':'')+apart.map(row).join('')}
function setMenu(f){openMenu=f;FAMILIES.forEach(x=>{x.el.querySelector('.fp').hidden=x!==f;x.el.querySelector('.fb').setAttribute('aria-expanded',String(x===f));renderButton(x)});
if(f){const q=f.el.querySelector('.fq');if(q){q.value='';q.focus()}renderRows(f)}}
FAMILIES.forEach(f=>{const el=document.createElement('div');el.className='fm';f.el=el;const low=esc(f.name.toLowerCase());
el.innerHTML='<button type="button" class="fb" aria-haspopup="true" aria-expanded="false">'+esc(f.name)+' <span class="fs"></span><span class="chev">\\u25BE</span></button>'+
'<div class="fp" role="dialog" aria-label="'+esc(f.name)+' filter" hidden><div class="fh"><b>'+esc(f.name)+'</b><span><a href="#" data-act="all">All</a> \\u00b7 <a href="#" data-act="none">None</a></span></div>'+
(f.search?'<input class="fq" type="text" placeholder="Find '+low+'..." aria-label="Find '+low+'">':'')+'<div class="fr"></div>'+(f.note?'<p class="fn">'+esc(f.note)+'</p>':'')+'</div>';
document.getElementById('menus').appendChild(el);
el.querySelector('.fb').addEventListener('click',()=>setMenu(openMenu===f?null:f));
el.querySelector('.fh').addEventListener('click',ev=>{const a=ev.target.closest('a');if(!a)return;ev.preventDefault();OFF[f.ax]=a.dataset.act==='all'?new Set():new Set(f.opts.map(o=>o.v));applyFilter()});
const q=el.querySelector('.fq');if(q)q.addEventListener('input',()=>renderRows(f));
const rows=el.querySelector('.fr');
rows.addEventListener('click',ev=>{const b=ev.target.closest('.only');if(!b)return;ev.preventDefault();const v=f.opts[+b.dataset.i].v;OFF[f.ax]=new Set(f.opts.map(o=>o.v).filter(x=>x!==v));applyFilter()});
rows.addEventListener('change',ev=>{const i=ev.target.dataset.i;if(i===undefined)return;const s=OFF[f.ax],v=f.opts[+i].v;if(s.has(v))s.delete(v);else s.add(v);applyFilter()})});
addEventListener('pointerdown',ev=>{if(openMenu&&!openMenu.el.contains(ev.target))setMenu(null)});
function applyFilter(){VIS=visibleSet();
document.querySelectorAll('.node').forEach(g=>g.classList.toggle('off',!VIS.has(+g.dataset.id)));
document.querySelectorAll('.e').forEach(e=>e.classList.toggle('off',!(VIS.has(+e.dataset.from)&&VIS.has(+e.dataset.to))));
FAMILIES.forEach(renderButton);if(openMenu)renderRows(openMenu);
document.getElementById('count').textContent='Showing '+VIS.size+' of '+ALL.length+' issues';relayout()}
function relayout(){const cols=LAYOUT.map((m,j)=>({j,m:m.filter(n=>VIS.has(n))})).filter(c=>c.m.length);const rows=Math.max(1,...cols.map(c=>c.m.length));
const xy={};GH=G.Y0+rows*G.ROWH+30;GW=Math.max(1,cols.length)*G.COLW-10;
document.querySelectorAll('.band,.wl').forEach(e=>e.classList.add('off'));
cols.forEach((c,k)=>{const x=G.X0+k*G.COLW,off=(rows-c.m.length)*G.ROWH/2;
const band=document.querySelector('.band[data-col="'+c.j+'"]'),wl=document.querySelector('.wl[data-col="'+c.j+'"]');
band.classList.remove('off','b0','b1');band.classList.add('b'+(k%2));band.setAttribute('x',x-(G.COLW-G.NODEW)/2);band.setAttribute('height',GH-G.BANDY);
wl.classList.remove('off');wl.setAttribute('x',x+G.NODEW/2);
c.m.forEach((n,i)=>{xy[n]=[x,G.Y0+off+i*G.ROWH];document.querySelector('.node[data-id="'+n+'"]').setAttribute('transform','translate('+xy[n][0]+','+xy[n][1]+')')})});
document.querySelectorAll('.e').forEach(e=>{const a=xy[e.dataset.from],b=xy[e.dataset.to];if(!a||!b)return;const sx=a[0]+G.NODEW,sy=a[1]+G.NODEH/2,tx=b[0],ty=b[1]+G.NODEH/2,mx=(sx+tx)/2;
e.setAttribute('d','M'+sx+','+sy+' C'+mx+','+sy+' '+mx+','+ty+' '+tx+','+ty)});
if(zoomReady)fit(false)}
document.getElementById('all').addEventListener('click',ev=>{ev.preventDefault();for(const k in OFF)OFF[k]=new Set();applyFilter()});
const pane=document.getElementById('problems'),ptoggle=document.getElementById('ptoggle');
function setPane(open){pane.hidden=!open;ptoggle.setAttribute('aria-pressed',String(open));ptoggle.classList.toggle('on',open)}
ptoggle.addEventListener('click',()=>setPane(pane.hidden));document.getElementById('pclose').addEventListener('click',()=>setPane(false));
setPane(PROBLEMS>0);
const GRIP='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="9" r="1.6"/><circle cx="12" cy="9" r="1.6"/><circle cx="19" cy="9" r="1.6"/><circle cx="5" cy="15" r="1.6"/><circle cx="12" cy="15" r="1.6"/><circle cx="19" cy="15" r="1.6"/></svg>';
function list(items,cls){return '<ul>'+items.map(b=>'<li class="'+cls(b)+'">#'+b.n+' '+esc(b.title)+' ('+esc(b.state.toLowerCase())+')</li>').join('')+'</ul>'}
function cardHtml(id){const m=META[id];const [ic,name,mean]=STATUS[m.status];const [kname,,kmean]=KIND[m.kind];
let h='<div class="handle" title="Drag to move this card">'+GRIP+'<h3>#'+id+' '+esc(m.title)+'</h3></div>';
h+='<div class="row"><b>Progress</b> <span class="st">'+ic+' '+esc(name)+'</span> <span class="m">'+esc(mean)+'</span></div>';
h+='<div class="row"><b>Who takes it</b> <span class="st k-'+m.kind+'">'+esc(kname)+'</span> <span class="m">'+esc(kmean)+'</span></div>';
h+='<span class="m">'+esc(m.column)+' \\u00b7 GitHub state: '+esc(m.state)+(m.assignees.length?' \\u00b7 assigned to '+esc(m.assignees.join(', ')):' \\u00b7 nobody assigned')+'</span>';
h+='<div class="row"><b>Labels:</b>'+(m.labels.length?m.labels.map(l=>'<span class="lbl'+(l===m.kindLabel?' k':'')+'">'+esc(l)+'</span>').join(''):' none')+'</div>';
h+='<div class="row"><b>Description</b><div class="desc">'+(m.body?esc(m.body):'<i>empty</i>')+'</div></div>';
if(m.kind==='epic'){h+='<div class="row"><b>Stories:</b> '+(m.stories.length?'':'none linked as sub-issues')+'</div>';if(m.stories.length)h+=list(m.stories,b=>b.state==='CLOSED'?'c':'')}
else{if(m.parent!==null&&META[m.parent])h+='<div class="row"><b>Epic</b> #'+m.parent+' '+esc(META[m.parent].title)+'</div>';
h+='<div class="row"><b>Blocked by:</b> '+(m.blockers.length?'':'nothing')+'</div>';if(m.blockers.length)h+=list(m.blockers,b=>b.state==='OPEN'?'o':'c');
h+='<div class="row"><b>Waiting on it:</b> '+(m.waiting.length?m.waiting.map(w=>'#'+w).join(', '):'nothing')+'</div>'}
return h+'<div class="acts"><button type="button" class="tb" data-open>Open on GitHub</button><span class="m">Click the box again to clear \\u00b7 double-click opens it on GitHub \\u00b7 drag the title to move this card</span></div>'}
function place(ev){if(tipSpot){tip.style.left=tipSpot.left+'px';tip.style.top=tipSpot.top+'px';return}
const r=tip.getBoundingClientRect();let x=ev.clientX+16,y=ev.clientY+16;if(x+r.width>innerWidth-8)x=ev.clientX-r.width-16;if(y+r.height>innerHeight-8)y=ev.clientY-r.height-16;
tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,y)+'px'}
function focus(id,ev){svg.classList.add('focus');const m=META[id];const u=walk(id,UP),dn=walk(id,down);const all=new Set([...u,...dn,id,...m.stories.map(k=>k.n)]);if(m.parent!==null)all.add(m.parent);
document.querySelectorAll('.node').forEach(g=>{const n=+g.dataset.id;g.classList.toggle('hl',all.has(n));g.classList.toggle('sel',n===id)});
document.querySelectorAll('.e').forEach(e=>e.classList.toggle('hl',all.has(+e.dataset.from)&&all.has(+e.dataset.to)));
document.getElementById('hint').textContent=m.kind==='epic'?'#'+id+': '+m.stories.length+' stories in this epic, lit up across the levels.':'#'+id+': '+u.size+' issue(s) upstream must close first (left), '+dn.size+' wait on it (right).';
tip.innerHTML=cardHtml(id);tip.style.display='block';place(ev)}
function clear(){svg.classList.remove('focus');document.querySelectorAll('.hl,.sel').forEach(e=>e.classList.remove('hl','sel'));document.getElementById('hint').textContent=HINT;tip.style.display='none'}
document.getElementById('hint').textContent=HINT;
const openIssue=id=>window.open(META[id].url,'_blank','noopener');
document.querySelectorAll('.node').forEach(g=>{const id=+g.dataset.id;
g.addEventListener('click',ev=>{if(pinned===id){pinned=null;clear()}else{pinned=id;focus(id,ev)}});
g.addEventListener('dblclick',()=>openIssue(id))});
tip.addEventListener('click',ev=>{if(ev.target.closest('[data-open]')&&pinned!==null)openIssue(pinned)});
tip.addEventListener('pointerdown',ev=>{if(ev.button!==0||!ev.target.closest('.handle'))return;ev.preventDefault();const r=tip.getBoundingClientRect();tipDrag={x:ev.clientX,y:ev.clientY,left:r.left,top:r.top}});
addEventListener('keydown',ev=>{if(ev.key!=='Escape')return;if(openMenu)setMenu(null);else if(pinned!==null){pinned=null;clear()}});
function paint(){vp.setAttribute('transform','translate('+tx+','+ty+') scale('+z+')');document.getElementById('zpct').textContent=Math.round(z*100)+'%'}
function zoomAt(f,cx,cy){const nz=Math.min(3,Math.max(0.05,z*f));tx=cx-(cx-tx)*nz/z;ty=cy-(cy-ty)*nz/z;z=nz;paint()}
function fit(all){const w=wrap.clientWidth,h=wrap.clientHeight;if(w<=0||h<=0)return;z=Math.max(0.05,Math.min(1,(w-20)/GW,all?(h-20)/GH:9));tx=(w-GW*z)/2;ty=all?(h-GH*z)/2:10;paint()}
let z=1,tx=0,ty=0,drag=null,moved=false;
wrap.addEventListener('wheel',ev=>{ev.preventDefault();const r=wrap.getBoundingClientRect();zoomAt(Math.exp(-ev.deltaY*0.0015),ev.clientX-r.left,ev.clientY-r.top)},{passive:false});
wrap.addEventListener('pointerdown',ev=>{if(ev.button!==0||ev.target.closest('#zoom'))return;drag={x:ev.clientX,y:ev.clientY,tx,ty};moved=false});
addEventListener('pointermove',ev=>{if(tipDrag){const left=Math.min(innerWidth-G.TIPKEEP,Math.max(0,tipDrag.left+ev.clientX-tipDrag.x)),top=Math.min(innerHeight-G.TIPKEEP,Math.max(0,tipDrag.top+ev.clientY-tipDrag.y));
tipSpot={left,top};tip.style.left=left+'px';tip.style.top=top+'px';return}
if(!drag)return;const dx=ev.clientX-drag.x,dy=ev.clientY-drag.y;if(!moved&&Math.hypot(dx,dy)<4)return;moved=true;wrap.classList.add('drag');if(!tipSpot)tip.style.display='none';tx=drag.tx+dx;ty=drag.ty+dy;paint()});
addEventListener('pointerup',()=>{drag=null;tipDrag=null;wrap.classList.remove('drag')});
wrap.addEventListener('click',ev=>{if(moved){ev.stopPropagation();moved=false}},true);
const mid=()=>[wrap.clientWidth/2,wrap.clientHeight/2];
document.getElementById('zin').onclick=()=>zoomAt(1.25,...mid());document.getElementById('zout').onclick=()=>zoomAt(0.8,...mid());
document.getElementById('zfit').onclick=()=>fit(true);document.getElementById('z100').onclick=()=>{const [cx,cy]=mid();zoomAt(1/z,cx,cy)};
applyFilter();zoomReady=true;fit(false);"""


if __name__ == "__main__":
    main()
