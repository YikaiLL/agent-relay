#!/usr/bin/env node
//
// Delete stale cargo build artifacts from target/debug.
//
// cargo never garbage-collects target/. Every time a crate's metadata hash
// changes — a source edit, a dependency bump, a new rustc — it writes a fresh
// set of `<crate>-<hash>.*` files and leaves every previous set untouched. The
// sets never get reused and nothing ever removes them, so target/debug grows
// without bound: on this workspace it reached 94G, of which 78G was 420k stale
// .rcgu.o codegen-unit files across 22 hash-generations of relay-server and 26
// of relay-broker. (Third-party deps stay tiny because their versions are
// pinned, so their hash rarely changes — the growth is all first-party crates.)
//
// This keeps the newest KEEP hash-generations per crate and deletes the rest,
// in target/debug/deps plus the parallel per-crate dirs in target/debug/
// incremental. It is called from the `npm run dev:*` entry points BEFORE cargo
// builds, which is the safe ordering: the generation cargo is about to reuse is
// the newest one, and the newest ones are exactly what this keeps. Pruning can
// therefore never force a rebuild of what is still current — it only removes
// generations that no longer correspond to any reachable source state.
//
//   node scripts/prune-cargo-target.mjs [--keep=N] [--dry-run] [--quiet] [dir...]
//
// Exits 0 even when it can do nothing (no target dir, unreadable dir): this
// runs on the dev-server startup path and must never be what stops a dev loop.

import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
// Two, not one: the newest generation is what cargo reuses, and the runner-up
// covers the common "flip back to the previous branch/feature set" edit, which
// would otherwise pay a full rebuild every time.
const keep = Math.max(1, Number(flag("keep", "2")) || 2);
const dryRun = args.includes("--dry-run");
const quiet = args.includes("--quiet");

const targets = args.filter((a) => !a.startsWith("--"));
const roots = targets.length
  ? targets.map((t) => path.resolve(t))
  : [
      path.join(repoRoot, "target", "debug"),
      path.join(repoRoot, "src-tauri", "target", "debug"),
    ];

const log = (msg) => {
  if (!quiet) console.log(`[prune-target] ${msg}`);
};

// deps/ entries: `relay_server-f9b6be44e38ef9c3.6woz….rcgu.o`,
// `librelay_broker-da34….rlib`, `relay_server-942f489c67190fdc` (the test/bin
// executable), `…-<hash>.rmeta`, `…-<hash>.d`. The metadata hash is hex and is
// what identifies the generation; everything before it is the crate.
const DEPS_HASHED = /^(.+)-([0-9a-f]{8,})(?:\.|$)/;

// incremental/ entries are per-crate session DIRECTORIES whose suffix is a
// base36 session id, not the hex metadata hash — `relay_api-0c893ewhrcnda`,
// `build_script_build-069kb14wq3fok`. Matching them with the hex pattern above
// silently skips the whole directory, which is where 22G of this workspace sat.
const INCREMENTAL_HASHED = /^(.+)-([a-z0-9]{8,})$/;

// Anything matching neither (build-script output dirs, CACHEDIR.TAG, …) is
// left alone.

// A `lib` prefix is rlib/rmeta packaging, not part of the crate name: strip it
// so `librelay_broker-<h>.rlib` groups with `relay_broker-<h>.*.rcgu.o` from
// the same build. Mis-grouping would not delete anything current (each group
// still keeps its own newest generations), but it would keep more than needed.
const crateOf = (stem) => (stem.startsWith("lib") ? stem.slice(3) : stem);

// Group by (crate, hash), stamping each generation with the newest mtime seen
// in it. One stat per generation, not per file: deps/ can hold ~400k entries
// and statting each one costs far more than the prune itself.
function collect(dir, pattern) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const groups = new Map();
  for (const entry of entries) {
    const m = pattern.exec(entry.name);
    if (!m) continue;
    const key = `${crateOf(m[1])} ${m[2]}`;
    let group = groups.get(key);
    if (!group) {
      group = { crate: crateOf(m[1]), names: [], mtime: 0, bytes: 0 };
      groups.set(key, group);
    }
    group.names.push(entry.name);
    if (group.mtime === 0) {
      try {
        const st = statSync(path.join(dir, entry.name));
        group.mtime = st.mtimeMs;
      } catch {
        group.mtime = 0;
      }
    }
  }
  return groups;
}

function prune(dir, label, pattern) {
  const groups = collect(dir, pattern);
  if (!groups) return { files: 0, bytes: 0, generations: 0 };

  // Newest generation first, per crate; everything past `keep` goes.
  const byCrate = new Map();
  for (const group of groups.values()) {
    if (!byCrate.has(group.crate)) byCrate.set(group.crate, []);
    byCrate.get(group.crate).push(group);
  }

  const doomed = [];
  for (const [, generations] of byCrate) {
    generations.sort((a, b) => b.mtime - a.mtime);
    doomed.push(...generations.slice(keep));
  }
  if (!doomed.length) return { files: 0, bytes: 0, generations: 0 };

  let files = 0;
  let bytes = 0;
  for (const group of doomed) {
    for (const name of group.names) {
      const full = path.join(dir, name);
      // Sizes are for the report only — a failed stat must not skip the
      // delete, which is the whole point of the run.
      bytes += sizeOf(full);
      if (!dryRun) {
        try {
          rmSync(full, { recursive: true, force: true });
        } catch {
          continue;
        }
      }
      files += 1;
    }
  }
  log(
    `${dryRun ? "would remove" : "removed"} ${doomed.length} stale ` +
      `generation(s), ${files} files, ${fmt(bytes)} from ${label}`
  );
  return { files, bytes, generations: doomed.length };
}

// incremental/ generations are directories, where a bare stat reports the inode
// size rather than the ~100MB of session data inside — recurse so the freed
// figure reflects what actually left the disk.
function sizeOf(target) {
  let st;
  try {
    st = statSync(target);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let children;
  try {
    children = readdirSync(target);
  } catch {
    return total;
  }
  for (const child of children) total += sizeOf(path.join(target, child));
  return total;
}

function fmt(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

let totalFiles = 0;
let totalBytes = 0;
let totalGenerations = 0;
for (const root of roots) {
  for (const [sub, pattern] of [
    ["deps", DEPS_HASHED],
    ["incremental", INCREMENTAL_HASHED],
  ]) {
    const dir = path.join(root, sub);
    const rel = path.relative(repoRoot, dir) || dir;
    const result = prune(dir, rel, pattern);
    totalFiles += result.files;
    totalBytes += result.bytes;
    totalGenerations += result.generations;
  }
}

if (totalGenerations === 0) {
  log(`nothing stale to remove (keeping the newest ${keep} per crate)`);
} else {
  log(
    `total: ${dryRun ? "would free" : "freed"} ${fmt(totalBytes)} ` +
      `across ${totalFiles} files, keeping the newest ${keep} per crate`
  );
}
