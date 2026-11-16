import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SITE_DIR = join(REPO_ROOT, "website");
const SITE_URL = "https://nachogl1.github.io/maestro/";
const FORK_LICENSE_URL = "https://github.com/nachogl1/maestro/blob/main/legal/LICENSE";
const AUTHOR_CREDIT = 'Adapted by Ignacio "Nacho" Gonzalez';
const ORIGINAL_AUTHOR_URL = "https://github.com/AngryAnt3201";
/** The one upstream link the site keeps: the footer credit to the original project. */
const ORIGINAL_PROJECT_LINK =
  '<a href="https://github.com/its-maestro-baby/maestro">its-maestro-baby/maestro</a>';
const LATEST_RELEASE_URL = "https://github.com/nachogl1/maestro/releases/latest";
const SCREENSHOTS = [
  "terminals.png",
  "sessions-working.png",
  "eagle-view.png",
  "parked-shelf.png",
  "work-journal.png",
  "issue-map.png",
];
/** Files Jekyll turns into pages: markdown and HTML outside `_` folders and `assets/`. */
const PAGE_EXTENSIONS = [".md", ".markdown", ".html"];
/** Text files whose links a visitor can follow; the vendored three.js build is excluded. */
const TEXT_EXTENSIONS = [".md", ".html", ".yml", ".css", ".js", ".scss"];
const IGNORED_DIRS = new Set(["_site", ".jekyll-cache", ".bundle", "vendor"]);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (IGNORED_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function sitePages(): string[] {
  return readdirSync(SITE_DIR)
    .filter((name) => PAGE_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .sort();
}

describe("public site (website/)", () => {
  it("publishes exactly the four pages: Home, Installation, Features and Troubleshooting", () => {
    expect(sitePages()).toEqual([
      "features.md",
      "index.md",
      "installation.md",
      "troubleshooting.md",
    ]);
  });

  it("links only to the fork, apart from the credit to the original project, and no Discord", () => {
    const offenders = listFiles(SITE_DIR)
      .filter((path) => TEXT_EXTENSIONS.some((ext) => path.endsWith(ext)))
      .filter((path) =>
        /its-maestro-baby|discord/i.test(read(path).replace(ORIGINAL_PROJECT_LINK, "")),
      );
    expect(offenders).toEqual([]);
    expect(read(join(SITE_DIR, "_config.yml"))).toContain('url: "https://nachogl1.github.io"');
  });

  it("credits the author with the decided wording and the MIT licence link on every page", () => {
    const credit = read(join(SITE_DIR, "_includes", "credit.html"));
    expect(credit).toContain(AUTHOR_CREDIT);
    expect(credit).toContain(`Created by Jack (<a href="${ORIGINAL_AUTHOR_URL}">`);
    expect(credit).toContain(ORIGINAL_PROJECT_LINK);
    expect(credit).toContain(`<a href="${FORK_LICENSE_URL}">MIT</a>`);
    for (const footer of ["_includes/footer_custom.html", "_layouts/landing.html"]) {
      expect(read(join(SITE_DIR, footer))).toContain("{% include credit.html %}");
    }
  });

  it("shows the download buttons and every screenshot on the Home page without JavaScript", () => {
    const home = read(join(SITE_DIR, "index.md"));
    expect(home).toContain(LATEST_RELEASE_URL);
    for (const screenshot of SCREENSHOTS) {
      expect(home).toContain(`assets/images/screenshots/${screenshot}`);
    }
  });

  it("leaves the install steps to the site: the README links to it and carries none", () => {
    const readme = read(join(REPO_ROOT, "README.md"));
    expect(readme).toContain(SITE_URL);
    for (const installStep of ["xattr -dr", "npm run tauri build", "cargo build --release"]) {
      expect(readme).not.toContain(installStep);
    }
  });
});
