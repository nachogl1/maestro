"""Count one sub-agent's tokens from its own Claude Code transcript, for the audit's `tokens_total`.

Used only when the Agent tool reported no figure for a sub-agent (as happens when it ran as an agent-team
teammate). Prints one JSON line and always exits 0, so the audit never blocks on it (wrong arguments or a
transcript it cannot read give the `null` line too, with the usage on stderr):

    {"tokens_total": 163400, "tokens_source": "transcript"}
    {"tokens_total": null, "tokens_source": "none", "tokens_reason": "<why>"}

    python .claude/skills/dev-next/scripts/agent_tokens.py <transcript.jsonl>
    python .claude/skills/dev-next/scripts/agent_tokens.py --agent <agent id> --name <agent name> --since <started_at>

The second form looks for the transcript where Claude Code keeps sub-agent transcripts,
`~/.claude/projects/<project>/<session>/subagents/` (under $CLAUDE_CONFIG_DIR when set): first the file
`agent-<agent id>.jsonl`, then the one whose `agent-<id>.meta.json` gives the agent's name as its `description`,
counting only files changed since the run started. No match, or more than one, gives `null` with the reason.

The counting rule: every assistant response in the transcript counts once (a response written as several
entries repeats one `message.id` with the same `usage`), and each adds input + output + cache-write tokens
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`). Cache reads are left out.

Needs Python 3.9+. No third-party packages.
"""

import glob
import json
import os
import sys
from datetime import datetime, timezone

COUNTED_FIELDS = ("input_tokens", "output_tokens", "cache_creation_input_tokens")
USAGE = (
    "usage: agent_tokens.py <transcript.jsonl>\n"
    "       agent_tokens.py [--agent <agent id>] [--name <agent name>] [--since <ISO time>] [--root <config dir>]"
)


def count(path):
    """Input + output + cache-write tokens over the distinct responses of one transcript, or None with no usage."""
    by_response = {}
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        for n, line in enumerate(f):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("type") != "assistant":
                continue
            message = entry.get("message")
            usage = message.get("usage") if isinstance(message, dict) else None
            if not isinstance(usage, dict):
                continue
            key = message.get("id") or entry.get("requestId") or entry.get("uuid") or n
            by_response[key] = usage
    if not by_response:
        return None
    return sum(int(u.get(field) or 0) for u in by_response.values() for field in COUNTED_FIELDS)


def since_epoch(text):
    if not text:
        return None
    moment = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


def find(root, agent_id, name, since):
    """The one transcript of this agent, or (None, reason)."""
    folders = glob.glob(os.path.join(glob.escape(root), "projects", "*", "*", "subagents"))
    fresh = lambda p: since is None or os.path.getmtime(p) >= since
    if agent_id:
        stem = agent_id if agent_id.startswith("agent-") else "agent-" + agent_id
        hits = [p for d in folders for p in [os.path.join(d, stem + ".jsonl")] if os.path.isfile(p) and fresh(p)]
        if len(hits) == 1:
            return hits[0], None
        if len(hits) > 1:
            return None, "%d transcripts match agent id %s" % (len(hits), agent_id)
    if name:
        hits = []
        for meta in (m for d in folders for m in glob.glob(os.path.join(glob.escape(d), "agent-*.meta.json"))):
            transcript = meta[: -len(".meta.json")] + ".jsonl"
            if not os.path.isfile(transcript) or not fresh(transcript):
                continue
            try:
                with open(meta, encoding="utf-8-sig") as f:
                    described = json.load(f).get("description")
            except (OSError, ValueError, AttributeError):
                continue
            if described == name:
                hits.append(transcript)
        if len(hits) == 1:
            return hits[0], None
        if len(hits) > 1:
            return None, "%d transcripts match agent name %s since the run started" % (len(hits), name)
    return None, "no transcript found for %s where Claude Code keeps sub-agent transcripts" % (agent_id or name)


def none_line(reason):
    return json.dumps({"tokens_total": None, "tokens_source": "none", "tokens_reason": reason})


def parse(argv):
    """(path, options), or None when the arguments are wrong."""
    opts, rest = {}, []
    it = iter(argv)
    for arg in it:
        if arg in ("--agent", "--name", "--since", "--root"):
            opts[arg[2:]] = next(it, None)
            if opts[arg[2:]] is None:
                return None
        elif arg.startswith("--"):
            return None
        else:
            rest.append(arg)
    if len(rest) > 1 or (rest and opts) or not (rest or opts.get("agent") or opts.get("name")):
        return None
    return (rest[0] if rest else None), opts


def main(argv):
    parsed = parse(argv)
    if parsed is None:
        print(USAGE, file=sys.stderr)
        print(none_line("agent_tokens.py was called with wrong arguments"))
        return 0
    path, opts = parsed
    try:
        reason = None
        if path is None:
            root = opts.get("root") or os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
            path, reason = find(root, opts.get("agent"), opts.get("name"), since_epoch(opts.get("since")))
        total = count(path) if path else None
        if path and total is None:
            reason = "the transcript holds no token usage"
    except OSError as e:
        total, reason = None, "could not read the transcript: %s" % (e.strerror or type(e).__name__)
    except Exception as e:  # the audit never blocks: anything unexpected is a null figure with its reason
        total, reason = None, "could not count the transcript: %s" % type(e).__name__
    print(none_line(reason) if total is None else json.dumps({"tokens_total": total, "tokens_source": "transcript"}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
