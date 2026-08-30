import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

test("npm prepare installs the tracked hook directory", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(manifest.scripts?.prepare || "", /install-git-hooks/);

  for (const hook of ["pre-commit", "pre-push"]) {
    const source = await readFile(path.join(repoRoot, ".githooks", hook), "utf8");
    assert.match(source, /check-no-private\.sh/);
  }
});

// npm runs `prepare` during `npm pack`, and `npm pack --json` promises its stdout is
// JSON the caller can parse. Anything a lifecycle script prints there lands in the
// middle of that JSON. npm 10 interleaves the two streams, npm 11 does not — so
// printing to stdout broke `npm test` on CI (Node 22) while passing locally on a
// newer Node, which is a bad way to find this out. Diagnostics go to stderr.
test("the hook installer keeps stdout clean for `npm pack --json`", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "sealwire-hook-stdout-"));
  tempDirs.push(workdir);
  await mkdir(path.join(workdir, "scripts"), { recursive: true });
  await copyFile(
    path.join(repoRoot, "scripts/install-git-hooks.mjs"),
    path.join(workdir, "scripts/install-git-hooks.mjs")
  );
  // A real checkout, so the installer runs its full path instead of the
  // "no git here, nothing to do" early exit.
  assert.equal(git(workdir, "init", "-q").status, 0);

  const run = spawnSync(
    process.execPath,
    [path.join(workdir, "scripts/install-git-hooks.mjs")],
    { cwd: workdir, encoding: "utf8" }
  );

  assert.equal(run.status, 0, `installer failed:\n${run.stderr}`);
  assert.equal(
    run.stdout,
    "",
    `the installer must report on stderr; stdout would corrupt \`npm pack --json\`. Got: ${run.stdout}`
  );
});

test("a normal git commit is refused while the private crate is swapped in", async () => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "sealwire-hook-"));
  tempDirs.push(workdir);

  await mkdir(path.join(workdir, ".githooks"), { recursive: true });
  await mkdir(path.join(workdir, "scripts"), { recursive: true });
  await mkdir(path.join(workdir, "crates/sealwire-private"), { recursive: true });
  await copyFile(
    path.join(repoRoot, ".githooks/pre-commit"),
    path.join(workdir, ".githooks/pre-commit")
  );
  await copyFile(
    path.join(repoRoot, "scripts/check-no-private.sh"),
    path.join(workdir, "scripts/check-no-private.sh")
  );
  await chmod(path.join(workdir, ".githooks/pre-commit"), 0o755);
  await chmod(path.join(workdir, "scripts/check-no-private.sh"), 0o755);
  await writeFile(path.join(workdir, "private-source.rs"), "// must not commit\n");

  assert.equal(git(workdir, "init", "-q").status, 0);
  assert.equal(git(workdir, "config", "user.email", "test@example.com").status, 0);
  assert.equal(git(workdir, "config", "user.name", "Test").status, 0);
  assert.equal(git(workdir, "config", "core.hooksPath", path.join(workdir, ".githooks")).status, 0);
  assert.equal(git(workdir, "add", "private-source.rs").status, 0);

  const refused = git(workdir, "commit", "-m", "must fail");
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /REFUSING TO COMMIT/);

  await writeFile(path.join(workdir, "crates/sealwire-private/STUB"), "public stub\n");
  assert.equal(git(workdir, "add", "crates/sealwire-private/STUB").status, 0);
  const accepted = git(workdir, "commit", "-m", "public stub restored");
  assert.equal(accepted.status, 0, accepted.stderr);
});
