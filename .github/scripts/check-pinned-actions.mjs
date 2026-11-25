// Fails when a workflow refers to an action by a branch or a moving tag.
//
// A tag like @v4 or a branch like @master can be moved to new code at any
// time, and the release job would run that code with the right to publish
// updates. Every third-party action is therefore pinned to a full commit hash,
// with the readable version as a comment beside it:
//
//   - uses: actions/checkout@<40-character hash> # v4.4.0
//
// To move to a newer version, look up the hash of its tag
// (gh api repos/<owner>/<repo>/commits/<tag> --jq .sha) and update both.
//
// Usage: node .github/scripts/check-pinned-actions.mjs [workflow folder]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WORKFLOW_DIR = ".github/workflows";
const WORKFLOW_FILE = /\.ya?ml$/;
// The reference after `uses:`, with optional quotes, then anything after it.
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(["']?)([^"'\s#]+)\1(.*)$/;
const FULL_COMMIT_HASH = /^[0-9a-f]{40}$/i;
const DOCKER_DIGEST = /@sha256:[0-9a-f]{64}$/i;
const VERSION_COMMENT = /^\s+#\s*\S/;

/** Why a `uses:` reference is not safely pinned, or null when it is. */
function problemWith(reference, rest) {
  if (reference.startsWith("./")) return null;
  if (reference.startsWith("docker://")) {
    return DOCKER_DIGEST.test(reference) ? null : "Docker image not pinned to a digest";
  }
  const at = reference.lastIndexOf("@");
  if (at === -1) return "no version given";
  if (!FULL_COMMIT_HASH.test(reference.slice(at + 1))) {
    return "names a branch or a moving tag, not a full commit hash";
  }
  return VERSION_COMMENT.test(rest) ? null : "no readable version comment beside the hash";
}

/** Every `uses:` line in a workflow's text that is not pinned to a fixed version. */
export function findUnpinnedActions(text) {
  const findings = [];
  text.split(/\r?\n/).forEach((content, index) => {
    const match = USES_LINE.exec(content);
    if (!match) return;
    const [, , reference, rest] = match;
    const problem = problemWith(reference, rest);
    if (problem) findings.push({ line: index + 1, reference, problem });
  });
  return findings;
}

function checkWorkflowDir(dir) {
  const files = readdirSync(dir).filter((name) => WORKFLOW_FILE.test(name));
  let count = 0;
  for (const name of files) {
    const path = join(dir, name);
    for (const finding of findUnpinnedActions(readFileSync(path, "utf8"))) {
      console.error(`${path}:${finding.line}: ${finding.reference} (${finding.problem})`);
      count++;
    }
  }
  if (count > 0) {
    console.error(`${count} action reference(s) not pinned to a full commit hash.`);
    process.exit(1);
  }
  console.log(`All actions in ${files.length} workflow file(s) are pinned to a full commit hash.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWorkflowDir(process.argv[2] ?? DEFAULT_WORKFLOW_DIR);
}
