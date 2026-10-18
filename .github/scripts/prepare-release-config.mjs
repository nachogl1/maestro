// Prepares src-tauri/tauri.conf.json for a release build (working copy only,
// never committed) and writes the release version to $GITHUB_OUTPUT.
//
// Version scheme: MAJOR.MINOR from tauri.conf.json, PATCH = workflow run
// number, so every run is strictly newer than the last. Local builds keep the
// repo's version and stay unsigned.
//
// --ad-hoc-sign: macOS only. Signs the app with an ad-hoc identity ("-")
// because there is no paid Apple Developer account; Apple Silicon refuses to
// run bundles with no signature at all.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const CONFIG_PATH = "src-tauri/tauri.conf.json";
const AD_HOC_IDENTITY = "-";

const conf = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const majorMinor = conf.version.split(".").slice(0, 2).join(".");
const version = `${majorMinor}.${process.env.GITHUB_RUN_NUMBER}`;

conf.version = version;
// Makes the bundler emit the .sig file the updater needs.
conf.bundle.createUpdaterArtifacts = true;
if (process.argv.includes("--ad-hoc-sign")) {
  conf.bundle.macOS.signingIdentity = AD_HOC_IDENTITY;
}

writeFileSync(CONFIG_PATH, `${JSON.stringify(conf, null, 2)}\n`);
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`Release version: ${version}`);
