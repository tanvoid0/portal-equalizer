// Last step of the Portal release pipeline (.portal/pipeline.yml): push main
// and the version tag, which sets off .github/workflows/release.yml.
//
// Anything but RELEASE_DRY_RUN=0 is a rehearsal: every check below runs and
// `git push --dry-run` proves the push would land, but nothing leaves the
// machine. Portal's Rehearse sets 1, its Ship button sets 0.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const dry = process.env.RELEASE_DRY_RUN !== "0";

// CI only compares the tag with tauri.conf.json; the bump touches four files.
const version = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version = "(.+)"/m)?.[1];
if (pkg !== version || cargo !== version)
  fail(`versions disagree: tauri.conf.json ${version}, package.json ${pkg}, Cargo.toml ${cargo}`);
const tag = `v${version}`;

// The release body's "What's new" is the one part that goes stale.
if (!readFileSync(".github/workflows/release.yml", "utf8").includes(`What's new in ${version}`))
  fail(`release.yml has no "What's new in ${version}" section`);

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("release from main");
// The tag must point at exactly what the earlier steps built and tested.
if (git("status", "--porcelain")) fail("working tree is not clean; commit first");
if (git("ls-remote", "--tags", "origin", `refs/tags/${tag}`)) fail(`${tag} is already on origin; bump the version`);

if (dry) {
  git("push", "--dry-run", "origin", "main");
  console.log(`release: rehearsal passed. Ship would push main and ${tag}.`);
} else {
  git("push", "origin", "main");
  git("tag", tag);
  git("push", "origin", tag);
  console.log(`release: pushed ${tag}. https://github.com/tanvoid0/portal-equalizer/actions`);
}
