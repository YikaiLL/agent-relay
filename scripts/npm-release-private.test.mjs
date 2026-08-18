import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// The release pipeline is the one place where "the private crate is missing"
// must be an ERROR rather than a quiet skip. Rust CI skips the private half on
// forks on purpose — it only costs coverage. A release that skips it publishes
// a binary whose task lists and task teams refuse at runtime, to every user,
// from a workflow run that is green. These tests pin that difference, plus the
// other direction: the private SOURCES must never reach the npm tarball.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

// Every platform we publish a prebuilt binary for. A target that is present but
// commented out ships nothing, so the assertions below run against text with
// comment lines removed — otherwise a commented-out matrix entry would satisfy
// a naive `includes`.
const PUBLISHED_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
];

async function releaseWorkflow() {
  return await readFile(path.join(repoRoot, ".github/workflows/npm-release.yml"), "utf8");
}

function stripComments(yaml) {
  return yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

// Split a workflow into `- name:` step chunks so a test can assert about ONE
// step rather than about the file as a whole — "the file contains `shell: bash`
// somewhere" would pass even with it attached to an unrelated step.
function steps(yaml) {
  return stripComments(yaml)
    .split(/^\s*- name: /m)
    .slice(1);
}

function stepMatching(yaml, pattern) {
  return steps(yaml).find((step) => pattern.test(step));
}

test("every platform we publish gets a binary built with the private crate linked in", async () => {
  const workflow = stripComments(await releaseWorkflow());

  for (const target of PUBLISHED_TARGETS) {
    assert.match(
      workflow,
      new RegExp(`target: ${target.replace(".", "\\.")}\\b`),
      `${target} is not an active matrix target, so that platform ships no prebuilt binary ` +
        `and falls back to building the public stub from source — no task teams`
    );
  }

  // The build must go through the swap script AND ask for the feature. Either
  // one alone is a binary without the orchestration engines.
  assert.match(workflow, /scripts\/with-private\.sh cargo build --release -p relay-server/);
  assert.match(workflow, /--features private/);

  // ...and there must be no un-swapped build left behind next to it.
  assert.doesNotMatch(
    workflow,
    /run: cargo build --release -p relay-server/,
    "a plain cargo build in the release workflow produces a stub binary"
  );
});

test("the private crate is read with a short-lived token scoped to that one repository", async () => {
  const workflow = stripComments(await releaseWorkflow());

  // A GitHub App installation token, not a deploy key and not a PAT: it expires
  // in an hour, it is revocable on its own, and `repositories:` keeps it unable
  // to read anything but the private crate even if the run is compromised.
  const mint = stepMatching(await releaseWorkflow(), /create-github-app-token/);
  assert.ok(mint, "the release does not mint a token for the private crate");
  // `client-id`, not the legacy `app-id` the action still accepts.
  assert.match(mint, /client-id: \$\{\{ secrets\.RELAY_PRIVATE_APP_CLIENT_ID \}\}/);
  assert.match(mint, /private-key: \$\{\{ secrets\.RELAY_PRIVATE_APP_KEY \}\}/);
  assert.match(
    mint,
    /repositories: sealwire-private/,
    "an unscoped token would read every repository the app is installed on"
  );

  const checkout = stepMatching(await releaseWorkflow(), /repository: sealwire\/sealwire-private/);
  assert.ok(checkout, "no private-crate checkout step");
  assert.match(checkout, /token: \$\{\{ steps\.[\w-]+\.outputs\.token \}\}/);

  // Deploy keys are disabled by org policy, and a bare PAT would be scoped to a
  // person rather than to this job.
  assert.doesNotMatch(workflow, /ssh-key:/);
  assert.doesNotMatch(workflow, /RELAY_PRIVATE_DEPLOY_KEY/);
});

test("a release with no private-crate credentials fails loudly instead of publishing a stubbed binary", async () => {
  const workflow = stripComments(await releaseWorkflow());

  // Rust CI skips the private half when the credentials are absent, and that is
  // right THERE: forks get no secrets and it only costs coverage. The same skip
  // here would publish a binary with no orchestration engines, from a green run.
  assert.doesNotMatch(
    workflow,
    /if: env\.PRIVATE_APP_CLIENT_ID != ''/,
    "release must not silently skip the private crate the way Rust CI does"
  );

  const gate = stepMatching(await releaseWorkflow(), /exit 1/);
  assert.ok(gate, "no step fails the release when the app credentials are missing");
  assert.match(gate, /PRIVATE_APP_CLIENT_ID/);
  assert.match(gate, /PRIVATE_APP_KEY/);
});

test("Rust CI keeps skipping the private crate rather than failing on a fork", async () => {
  // The asymmetry with the release is deliberate, and it is easy to "fix" by
  // making both sides behave the same. Pinned here so that either direction of
  // that change has to be argued for: a fork PR carries no secrets, and a CI
  // that failed on them would be red for every outside contributor forever.
  const ci = await readFile(path.join(repoRoot, ".github/workflows/rust-ci.yml"), "utf8");

  assert.match(ci, /if: env\.PRIVATE_APP_CLIENT_ID != '' && github\.event_name != 'pull_request'/);
  assert.match(ci, /create-github-app-token/);
  assert.doesNotMatch(ci, /RELAY_PRIVATE_DEPLOY_KEY/);
});

test("the private-crate build runs under bash so the Windows runner does not use pwsh", async () => {
  const build = stepMatching(await releaseWorkflow(), /scripts\/with-private\.sh cargo build/);

  assert.ok(build, "no with-private build step found");
  assert.match(
    build,
    /shell: bash/,
    "with-private.sh is a bash script; the Windows runner defaults to pwsh and would not run it"
  );
});

test("npm publish is wired to the guard that refuses a swapped tree", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));

  // `files` includes `crates/**`, and that allow-list beats .gitignore — so a
  // publish that lands while with-private.sh has the real sources swapped in
  // uploads them to npm, permanently. The git-side guard does not cover this
  // channel; prepublishOnly is the hook that does.
  assert.match(
    manifest.scripts?.prepublishOnly ?? "",
    /check-no-private/,
    "npm publish runs with no private-crate guard"
  );
});

test("that guard actually rejects a tree with the private sources in it", async () => {
  // Functional, not a string match: the wiring above only means something if
  // the script it names has teeth. Build both trees and run it for real.
  const workdir = await mkdtemp(path.join(os.tmpdir(), "sealwire-guard-"));
  tempDirs.push(workdir);

  await mkdir(path.join(workdir, "scripts"), { recursive: true });
  await mkdir(path.join(workdir, "crates/sealwire-private/src"), { recursive: true });
  await copyFile(
    path.join(repoRoot, "scripts/check-no-private.sh"),
    path.join(workdir, "scripts/check-no-private.sh")
  );
  await writeFile(path.join(workdir, "crates/sealwire-private/src/team.rs"), "// private\n");

  const guard = path.join(workdir, "scripts/check-no-private.sh");

  const swapped = spawnSync("bash", [guard], { encoding: "utf8" });
  assert.notEqual(swapped.status, 0, "guard passed a tree holding the private sources");
  assert.match(swapped.stderr, /REFUSING/);

  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "");
  const stubbed = spawnSync("bash", [guard], { encoding: "utf8" });
  assert.equal(stubbed.status, 0, `guard rejected a clean stub tree: ${stubbed.stderr}`);
});
