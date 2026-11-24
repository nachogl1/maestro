import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNoticesFile,
  EMBEDDED_FONTS,
  licenceTexts,
  NOTICES_PATH,
  renderNotices,
  shippedCrates,
  shippedNpmPackages,
} from "./generate-notices.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "notices-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFiles(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
}

describe("shippedNpmPackages", () => {
  it("lists shipped packages, nested ones and bundled build tools, never other dev ones", () => {
    writeFiles({
      "node_modules/react/package.json": "{}",
      "node_modules/react/node_modules/loose-envify/package.json": "{}",
      "node_modules/@scope/tool/package.json": "{}",
      "node_modules/vitest/package.json": "{}",
      "node_modules/tailwindcss/package.json": "{}",
      "node_modules/vite/package.json": "{}",
    });
    const lockfile = {
      packages: {
        "": { name: "maestro", license: "MIT" },
        "node_modules/react": { version: "18.3.1", license: "MIT" },
        "node_modules/react/node_modules/loose-envify": { version: "1.4.0", license: "MIT" },
        "node_modules/@scope/tool": { version: "2.0.0", license: "ISC" },
        "node_modules/vitest": { version: "3.2.7", license: "MIT", dev: true },
        "node_modules/tailwindcss": { version: "3.4.0", license: "MIT", dev: true },
        "node_modules/vite": { version: "6.4.6", license: "MIT", dev: true },
        "node_modules/other-platform-binary": { version: "1.0.0", optional: true },
      },
    };

    const names = shippedNpmPackages(lockfile, dir).map((pkg) => `${pkg.name}@${pkg.version}`);

    expect(names).toEqual([
      "react@18.3.1",
      "loose-envify@1.4.0",
      "@scope/tool@2.0.0",
      "tailwindcss@3.4.0",
      "vite@6.4.6",
    ]);
  });
});

describe("shippedCrates", () => {
  it("follows normal dependencies only and leaves out Maestro's own crates", () => {
    const normal = [{ kind: null }];
    const metadata = {
      workspace_members: ["app", "mcp"],
      packages: ["app", "mcp", "serde", "serde_derive", "cc", "jobserver", "tempfile", "both"].map(
        (id) => ({
          id,
          name: id,
          version: "1.0.0",
          license: "MIT",
          manifest_path: `/registry/${id}/Cargo.toml`,
        }),
      ),
      resolve: {
        nodes: [
          {
            id: "app",
            deps: [
              { pkg: "serde", dep_kinds: normal },
              { pkg: "cc", dep_kinds: [{ kind: "build" }] },
              { pkg: "tempfile", dep_kinds: [{ kind: "dev" }] },
              { pkg: "mcp", dep_kinds: normal },
            ],
          },
          { id: "mcp", deps: [{ pkg: "both", dep_kinds: [{ kind: "dev" }, { kind: null }] }] },
          { id: "serde", deps: [{ pkg: "serde_derive", dep_kinds: normal }] },
          { id: "cc", deps: [{ pkg: "jobserver", dep_kinds: normal }] },
        ],
      },
    };

    const names = shippedCrates(metadata).map((crate) => crate.name);

    expect(names.sort()).toEqual(["both", "serde", "serde_derive"]);
  });
});

describe("licenceTexts", () => {
  it("reads every licence, copyright and notice file in a package folder and nothing else", () => {
    writeFiles({
      "LICENSE-MIT": "MIT text\r\n",
      "LICENSE-APACHE": "Apache text",
      NOTICE: "Notice text",
      "COPYING.txt": "Copying text",
      "README.md": "Readme",
      "LICENSES/extra.txt": "In a folder",
      "docs/terms.txt": "Named licence file",
    });

    expect(licenceTexts(dir, "docs/terms.txt")).toEqual([
      "Copying text",
      "Apache text",
      "MIT text",
      "Notice text",
      "Named licence file",
    ]);
  });
});

describe("renderNotices", () => {
  const MIT = "MIT License\n\nCopyright (c) Someone";
  const groups = [
    {
      title: "JavaScript packages",
      items: [{ name: "react", version: "18.3.1", licence: "MIT", texts: [MIT] }],
    },
    {
      title: "Rust crates",
      items: [
        { name: "serde", version: "1.0.0", licence: "MIT", texts: [MIT.replace("\n\n", "\n \n")] },
        { name: "bare", version: "0.1.0", licence: "MIT", texts: [], source: "https://e.test" },
      ],
    },
    {
      title: "Fonts",
      items: [{ name: "Some Font", version: "", licence: "OFL-1.1", texts: ["OFL"] }],
    },
  ];

  it("puts Maestro's licence first, then every shipped item with its licence", () => {
    const notices = renderNotices("Maestro licence text", groups);

    expect(notices.indexOf("Maestro licence text")).toBeLessThan(notices.indexOf("react 18.3.1"));
    for (const line of ["react 18.3.1 - MIT", "serde 1.0.0 - MIT", "Some Font - OFL-1.1"]) {
      expect(notices).toContain(line);
    }
    expect(notices).toContain(
      "bare 0.1.0 - MIT (the package ships no licence file; source: https://e.test)",
    );
  });

  it("prints a licence text shared by several items once, naming all of them", () => {
    const notices = renderNotices("Maestro licence text", groups);

    expect(notices).toContain("Used by: react 18.3.1, serde 1.0.0");
    expect(notices.split("Copyright (c) Someone")).toHaveLength(2);
    expect(notices).toContain("Used by: Some Font\n");
  });
});

describe("assertNoticesFile", () => {
  it.each([
    ["missing", null, /missing/],
    ["empty", "", /empty/],
    ["only white space", " \n\t\n", /empty/],
  ])("fails when the notices file is %s", (_name, content, error) => {
    const path = join(dir, "THIRD-PARTY-NOTICES.txt");
    if (content !== null) writeFileSync(path, content);

    expect(() => assertNoticesFile(path)).toThrow(error);
  });

  it("passes a notices file with text in it", () => {
    const path = join(dir, "THIRD-PARTY-NOTICES.txt");
    writeFileSync(path, "THIRD-PARTY NOTICES FOR MAESTRO");

    expect(() => assertNoticesFile(path)).not.toThrow();
  });
});

describe("notices in the build", () => {
  it("is generated by every Tauri build and shipped in the installers with the licence", () => {
    const tauriConfig = readJson("src-tauri/tauri.conf.json");
    const packageJson = readJson("package.json");
    const noticesFolder = `${dirname(NOTICES_PATH)}/`;

    expect(tauriConfig.build.beforeBuildCommand).toContain("npm run notices");
    expect(packageJson.scripts.notices).toBe("node scripts/generate-notices.mjs");
    expect(tauriConfig.bundle.resources[`../${noticesFolder}`]).toBe(noticesFolder);
    expect(tauriConfig.bundle.resources["../LICENSE"]).toBeTruthy();
  });

  it("covers every font the front end embeds with a licence file in the repository", () => {
    const fontsCss = readFileSync(join(REPO_ROOT, "src/styles/fonts.css"), "utf8");
    const embedded = [...fontsCss.matchAll(/font-family:\s*"([^"]+)"/g)].map((match) => match[1]);

    expect(EMBEDDED_FONTS.map((font) => font.name)).toEqual([...new Set(embedded)]);
    for (const font of EMBEDDED_FONTS) {
      expect(readFileSync(join(REPO_ROOT, font.file), "utf8")).toContain(
        "SIL OPEN FONT LICENSE Version 1.1",
      );
    }
  });
});
