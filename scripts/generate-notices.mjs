// Writes legal/THIRD-PARTY-NOTICES.txt: Maestro's own licence, then the licence of everything
// that ships inside the app — the JavaScript packages the front end is built from, the Rust
// crates the app and its MCP server are built from, and the embedded terminal font.
//
// `npm run tauri build` runs it before bundling (beforeBuildCommand in tauri.conf.json), and the
// installers carry the file as a bundle resource. The file is generated, never committed: it
// changes with every dependency update.
//
// Usage: node scripts/generate-notices.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the notices are written, relative to the repository root. */
export const NOTICES_PATH = "legal/THIRD-PARTY-NOTICES.txt";

/** Maestro's own licence, printed first. */
const PROJECT_LICENCE_PATH = "LICENSE";

/** The fonts the front end embeds (src/styles/fonts.css), with their licence files. */
export const EMBEDDED_FONTS = [
  { name: "JetBrains Mono", licence: "OFL-1.1", file: "legal/JetBrainsMono-OFL.txt" },
];

/** File names a package uses for its licence, copyright or notice text. */
const LICENCE_FILE_NAME = /^(licen[cs]e|copying|copyright|notice|unlicense)([-._].*)?$/i;

/** Room for `cargo metadata` on a workspace with hundreds of crates. */
const CARGO_METADATA_MAX_BYTES = 256 * 1024 * 1024;

const NODE_MODULES = "node_modules/";
const RULE = "=".repeat(78);
const THIN_RULE = "-".repeat(78);

/**
 * The npm packages the app ships: every installed package in the lockfile that is not only a
 * development dependency. An optional package missing from `node_modules` (another platform's
 * binary) is left out.
 */
export function shippedNpmPackages(lockfile, nodeModulesRoot) {
  return Object.entries(lockfile.packages ?? {})
    .filter(([key, entry]) => key.startsWith(NODE_MODULES) && !entry.dev && !entry.link)
    .map(([key, entry]) => ({
      name: entry.name ?? key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length),
      version: entry.version ?? "",
      licence: entry.license ?? "UNKNOWN",
      dir: join(nodeModulesRoot, key),
    }))
    .filter((pkg) => existsSync(pkg.dir));
}

/**
 * The Rust crates the app ships: every crate a workspace member reaches through normal
 * dependencies (never only through dev or build dependencies), for every target platform.
 * The workspace members themselves are Maestro's own code and are left out.
 */
export function shippedCrates(metadata) {
  const members = new Set(metadata.workspace_members);
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const reached = new Set();
  const queue = [...members];
  while (queue.length > 0) {
    const node = nodes.get(queue.pop());
    for (const dep of node?.deps ?? []) {
      const normal = dep.dep_kinds.some((kind) => kind.kind === null);
      if (normal && !reached.has(dep.pkg)) {
        reached.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  return metadata.packages
    .filter((pkg) => reached.has(pkg.id) && !members.has(pkg.id))
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      licence: pkg.license ?? (pkg.license_file ? "see its licence file" : "UNKNOWN"),
      dir: dirname(pkg.manifest_path),
      licenceFile: pkg.license_file ?? null,
      source: pkg.repository ?? pkg.homepage ?? null,
    }));
}

/** The licence, copyright and notice texts in a package's folder, in file-name order. */
export function licenceTexts(dir, extraFile = null) {
  const names = readdirSync(dir)
    .filter((name) => LICENCE_FILE_NAME.test(name) && statSync(join(dir, name)).isFile())
    .sort();
  if (extraFile && !names.includes(extraFile) && existsSync(join(dir, extraFile))) {
    names.push(extraFile);
  }
  return names.map((name) => readFileSync(join(dir, name), "utf8").replace(/\r\n/g, "\n").trim());
}

/** Two licence texts that differ only in white space are printed once. */
function textKey(text) {
  return text.replace(/\s+/g, " ").trim();
}

function label(item) {
  return item.version ? `${item.name} ${item.version}` : item.name;
}

function indexSection(title, items) {
  const lines = items.map((item) => {
    const source = item.source ? `; source: ${item.source}` : "";
    const missing = item.texts.length === 0 ? ` (the package ships no licence file${source})` : "";
    return `  ${label(item)} - ${item.licence}${missing}`;
  });
  return [`${title} (${items.length})`, THIN_RULE, ...lines].join("\n");
}

/**
 * The notices text: Maestro's licence, an index of every shipped item with its licence, then
 * each distinct licence text once, headed by the items it covers.
 * `groups` is a list of { title, items }, each item { name, version, licence, texts }.
 */
export function renderNotices(projectLicence, groups) {
  const byText = new Map();
  for (const item of groups.flatMap((group) => group.items)) {
    for (const text of item.texts) {
      const key = textKey(text);
      const entry = byText.get(key) ?? { text, users: [] };
      entry.users.push(label(item));
      byText.set(key, entry);
    }
  }
  const licenceSections = [...byText.values()].map(
    ({ text, users }) => `${THIN_RULE}\nUsed by: ${users.join(", ")}\n${THIN_RULE}\n\n${text}`,
  );
  return [
    "THIRD-PARTY NOTICES FOR MAESTRO",
    RULE,
    "",
    "Maestro is released under the licence below. It ships with the open-source software",
    "listed after it, each under its own licence, whose texts follow the list.",
    "",
    RULE,
    "MAESTRO",
    RULE,
    "",
    projectLicence.replace(/\r\n/g, "\n").trim(),
    "",
    RULE,
    "WHAT MAESTRO SHIPS",
    RULE,
    "",
    groups.map((group) => indexSection(group.title, group.items)).join("\n\n"),
    "",
    RULE,
    "LICENCE TEXTS",
    RULE,
    "",
    licenceSections.join("\n\n"),
    "",
  ].join("\n");
}

/** Throws when the notices file is missing or empty, so no build ships without it. */
export function assertNoticesFile(path) {
  if (!existsSync(path)) {
    throw new Error(`The third-party notices file ${path} is missing.`);
  }
  if (readFileSync(path, "utf8").trim() === "") {
    throw new Error(`The third-party notices file ${path} is empty.`);
  }
}

function withTexts(items) {
  return items
    .map((item) => ({ ...item, texts: licenceTexts(item.dir, item.licenceFile) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function cargoMetadata(root) {
  const output = execFileSync(
    process.env.CARGO ?? "cargo",
    ["metadata", "--format-version", "1", "--locked"],
    { cwd: root, encoding: "utf8", maxBuffer: CARGO_METADATA_MAX_BYTES },
  );
  return JSON.parse(output);
}

export function generateNotices(root = REPO_ROOT) {
  const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const groups = [
    { title: "JavaScript packages", items: withTexts(shippedNpmPackages(lockfile, root)) },
    { title: "Rust crates", items: withTexts(shippedCrates(cargoMetadata(root))) },
    {
      title: "Fonts",
      items: EMBEDDED_FONTS.map((font) => ({
        name: font.name,
        version: "",
        licence: font.licence,
        texts: [readFileSync(join(root, font.file), "utf8").replace(/\r\n/g, "\n").trim()],
      })),
    },
  ];
  const path = join(root, NOTICES_PATH);
  writeFileSync(
    path,
    renderNotices(readFileSync(join(root, PROJECT_LICENCE_PATH), "utf8"), groups),
  );
  assertNoticesFile(path);
  const counts = groups.map((group) => `${group.title}: ${group.items.length}`);
  console.log(`Wrote ${NOTICES_PATH}: ${counts.join(", ")}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateNotices();
}
