import test from "node:test";
import assert from "node:assert/strict";

import {
  expectedNativePackages,
  inspectMachoCompleteness,
  checkClaudeNativeBinary,
} from "./native-binary-check.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Regression guard for the "spawn Unknown system error -88" outage.
//
// A truncated download of @anthropic-ai/claude-agent-sdk-<plat>-<arch> left a
// 30 MB file whose Mach-O headers declared 255 MB of segments. macOS refused to
// exec it (EBADMACHO, errno 88) and the worker surfaced the raw, undiagnosable
// `spawn Unknown system error -88`. These tests lock in that the preflight
// instead produces an actionable error naming the package to reinstall — and
// that it catches the OTHER corruption shapes too (empty / header-truncated /
// load-commands cut off / malformed short segment commands), not just the exact
// tail-truncation incident.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal thin Mach-O 64 header with the given file-backed segments. */
function machoHead(segments, { cmdSize = 72 } = {}) {
  const LC_SEGMENT_64 = 0x19;
  const ncmds = segments.length;
  const sizeofcmds = ncmds * cmdSize;
  const buf = Buffer.alloc(32 + sizeofcmds);
  buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  buf.writeInt32LE(0x0100000c, 4); // cputype ARM64 (not inspected)
  buf.writeInt32LE(0, 8); // cpusubtype
  buf.writeUInt32LE(2, 12); // filetype MH_EXECUTE
  buf.writeUInt32LE(ncmds, 16);
  buf.writeUInt32LE(sizeofcmds, 20);
  buf.writeUInt32LE(0, 24); // flags
  buf.writeUInt32LE(0, 28); // reserved
  let off = 32;
  for (const seg of segments) {
    buf.writeUInt32LE(LC_SEGMENT_64, off + 0);
    buf.writeUInt32LE(cmdSize, off + 4);
    // segname[16] left as zeros
    if (cmdSize >= 56) {
      buf.writeBigUInt64LE(0n, off + 24); // vmaddr
      buf.writeBigUInt64LE(0n, off + 32); // vmsize
      buf.writeBigUInt64LE(BigInt(seg.fileoff), off + 40);
      buf.writeBigUInt64LE(BigInt(seg.filesize), off + 48);
    }
    off += cmdSize;
  }
  return buf;
}

test("expectedNativePackages: darwin-arm64 maps to the darwin-arm64 package", () => {
  const [first] = expectedNativePackages("darwin", "arm64");
  assert.equal(first.pkg, "@anthropic-ai/claude-agent-sdk-darwin-arm64");
  assert.equal(first.spec, "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
});

test("expectedNativePackages: win32 uses a .exe suffix", () => {
  const [first] = expectedNativePackages("win32", "x64");
  assert.equal(first.pkg, "@anthropic-ai/claude-agent-sdk-win32-x64");
  assert.ok(first.spec.endsWith("/claude.exe"));
});

test("expectedNativePackages: linux offers musl + glibc variants, preference first", () => {
  const glibcFirst = expectedNativePackages("linux", "x64", { preferMusl: false });
  assert.equal(glibcFirst[0].pkg, "@anthropic-ai/claude-agent-sdk-linux-x64");
  assert.ok(glibcFirst.some((c) => c.pkg.endsWith("-linux-x64-musl")));

  const muslFirst = expectedNativePackages("linux", "x64", { preferMusl: true });
  assert.equal(muslFirst[0].pkg, "@anthropic-ai/claude-agent-sdk-linux-x64-musl");
});

test("inspectMachoCompleteness: complete binary is not truncated/corrupt", () => {
  const head = machoHead([{ fileoff: 0, filesize: 1000 }]);
  const info = inspectMachoCompleteness(head, 1000);
  assert.equal(info.verified, true);
  assert.equal(info.corrupt, false);
  assert.equal(info.truncated, false);
  assert.equal(info.declaredEnd, 1000);
});

test("inspectMachoCompleteness: segment past EOF is flagged truncated (the incident)", () => {
  // 30 MB file whose headers declare 255 MB — the exact shape we saw on disk.
  const head = machoHead([
    { fileoff: 0, filesize: 4096 },
    { fileoff: 4096, filesize: 255_069_680 - 4096 },
  ]);
  const info = inspectMachoCompleteness(head, 30_552_546);
  assert.equal(info.verified, true);
  assert.equal(info.truncated, true);
  assert.equal(info.declaredEnd, 255_069_680);
});

test("inspectMachoCompleteness: empty file is corrupt (cross-platform)", () => {
  const info = inspectMachoCompleteness(Buffer.alloc(0), 0);
  assert.equal(info.corrupt, true);
});

test("inspectMachoCompleteness: Mach-O header cut short is corrupt", () => {
  // Valid MH_MAGIC_64 but only 16 bytes on disk — a real header is >= 32.
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0xfeedfacf, 0);
  const info = inspectMachoCompleteness(b, 16);
  assert.equal(info.corrupt, true);
});

test("inspectMachoCompleteness: load commands cut off by EOF are corrupt", () => {
  // Header declares 2704 bytes of load commands but the file ends right after
  // the header.
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(21, 16); // ncmds
  b.writeUInt32LE(2704, 20); // sizeofcmds — far past a 32-byte file
  const info = inspectMachoCompleteness(b, 32);
  assert.equal(info.corrupt, true);
});

test("inspectMachoCompleteness: malformed short LC_SEGMENT_64 is corrupt, not a RangeError", () => {
  // A segment command whose cmdsize (16) is far below the 72-byte struct — must
  // NOT read fileoff/filesize off the end of the buffer.
  const head = machoHead([{ fileoff: 0, filesize: 0 }], { cmdSize: 16 });
  let info;
  assert.doesNotThrow(() => {
    info = inspectMachoCompleteness(head, head.length);
  });
  assert.equal(info.corrupt, true);
});

test("inspectMachoCompleteness: non-Mach-O (e.g. ELF) is left unverified, never corrupt", () => {
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...new Array(60).fill(0)]);
  const info = inspectMachoCompleteness(elf, elf.length);
  assert.equal(info.verified, false);
  assert.notEqual(info.corrupt, true);
  assert.equal(info.truncated, undefined);
});

test("checkClaudeNativeBinary: missing binary throws an actionable, package-named error", () => {
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "darwin",
        arch: "arm64",
        sdkVersion: "0.3.210",
        resolve() {
          throw new Error("Cannot find module");
        },
        statSync() {
          throw new Error("should not stat");
        },
        readHead() {
          throw new Error("should not read");
        },
      }),
    (err) => {
      assert.match(err.message, /missing/i);
      assert.match(err.message, /@anthropic-ai\/claude-agent-sdk-darwin-arm64/);
      return true;
    },
  );
});

test("checkClaudeNativeBinary: truncated binary throws with EBADMACHO/-88 context", () => {
  const head = machoHead([{ fileoff: 0, filesize: 255_069_680 }]);
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "darwin",
        arch: "arm64",
        sdkVersion: "0.3.210",
        resolve: () => "/fake/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
        statSync: () => ({ size: 30_552_546 }),
        readHead: () => head,
      }),
    (err) => {
      assert.match(err.message, /truncated|incomplete/i);
      assert.match(err.message, /-88|EBADMACHO/);
      assert.match(err.message, /@anthropic-ai\/claude-agent-sdk-darwin-arm64/);
      return true;
    },
  );
});

test("checkClaudeNativeBinary: zero-byte binary is caught (does not pass as healthy)", () => {
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "darwin",
        arch: "arm64",
        resolve: () => "/fake/claude",
        statSync: () => ({ size: 0 }),
        readHead: () => Buffer.alloc(0),
      }),
    (err) => {
      assert.match(err.message, /incomplete|truncated|empty/i);
      return true;
    },
  );
});

test("checkClaudeNativeBinary: malformed short segment surfaces an actionable error, not RangeError", () => {
  const head = machoHead([{ fileoff: 0, filesize: 0 }], { cmdSize: 16 });
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "darwin",
        arch: "arm64",
        resolve: () => "/fake/claude",
        statSync: () => ({ size: head.length }),
        readHead: () => head,
      }),
    (err) => {
      assert.ok(!(err instanceof RangeError), "must not be a raw RangeError");
      assert.match(err.message, /incomplete|truncated/i);
      return true;
    },
  );
});

test("checkClaudeNativeBinary: healthy binary returns ok with resolved path + pkg", () => {
  const head = machoHead([{ fileoff: 0, filesize: 255_069_680 }]);
  const result = checkClaudeNativeBinary({
    platform: "darwin",
    arch: "arm64",
    resolve: () => "/real/claude",
    statSync: () => ({ size: 255_069_680 }),
    readHead: () => head,
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, "/real/claude");
  assert.equal(result.pkg, "@anthropic-ai/claude-agent-sdk-darwin-arm64");
  assert.equal(result.info.truncated, false);
});

test("repair guidance for an npx install targets the npx cache, not the user's project", () => {
  const npxBin =
    "/Users/x/.npm/_npx/9a8b7c/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
  const head = machoHead([{ fileoff: 0, filesize: 255_069_680 }]);
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "darwin",
        arch: "arm64",
        resolve: () => npxBin,
        statSync: () => ({ size: 30_552_546 }),
        readHead: () => head,
      }),
    (err) => {
      // npx-aware: clear the npx cache entry + re-run npx, NOT a bare project install.
      assert.match(err.message, /npx/i);
      assert.match(err.message, /_npx[/\\]9a8b7c/);
      // Must not emit the non-command pseudo-word `reinstall <pkg>`.
      assert.doesNotMatch(err.message, /\breinstall @anthropic/);
      return true;
    },
  );
});

/** Header + arbitrary load-command bytes with an explicitly-set sizeofcmds. */
function machoRaw({ ncmds, sizeofcmds, cmdBytes }) {
  const buf = Buffer.alloc(32 + cmdBytes.length);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(ncmds, 16);
  buf.writeUInt32LE(sizeofcmds, 20);
  cmdBytes.copy(buf, 32);
  return buf;
}

/** One LC_SEGMENT_64 command (72 bytes) with a given fileoff/filesize. */
function segCmd64(fileoff = 0, filesize = 0) {
  const c = Buffer.alloc(72);
  c.writeUInt32LE(0x19, 0); // cmd
  c.writeUInt32LE(72, 4); // cmdsize
  c.writeBigUInt64LE(BigInt(fileoff), 40);
  c.writeBigUInt64LE(BigInt(filesize), 48);
  return c;
}

test("inspectMachoCompleteness: a command overrunning sizeofcmds is corrupt", () => {
  // Header claims only 8 bytes of load commands, but there is a full 72-byte
  // segment command — the parser must NOT wander past the declared region.
  const info = inspectMachoCompleteness(
    machoRaw({ ncmds: 1, sizeofcmds: 8, cmdBytes: segCmd64(0, 0) }),
    32 + 72,
  );
  assert.equal(info.corrupt, true);
  assert.notEqual(info.truncated, true); // reported as corrupt, not silently healthy
});

test("inspectMachoCompleteness: ncmds larger than the region holds is corrupt", () => {
  // Says 2 commands but sizeofcmds only covers one.
  const info = inspectMachoCompleteness(
    machoRaw({ ncmds: 2, sizeofcmds: 72, cmdBytes: segCmd64(0, 100) }),
    32 + 72,
  );
  assert.equal(info.corrupt, true);
});

test("inspectMachoCompleteness: load commands that underfill sizeofcmds are corrupt", () => {
  // One 72-byte command but sizeofcmds claims 144 — 72 unconsumed bytes.
  const body = Buffer.concat([segCmd64(0, 10), Buffer.alloc(72)]);
  const info = inspectMachoCompleteness(
    machoRaw({ ncmds: 1, sizeofcmds: 144, cmdBytes: body }),
    32 + body.length,
  );
  assert.equal(info.corrupt, true);
});

test("repair (npx) targets exactly _npx/<hash> even with an earlier node_modules, and never rm -rf a project", () => {
  // npm's cache location is configurable; this path has node_modules BEFORE _npx.
  const npxBin =
    "/work/project/node_modules/.cache/_npx/9a8b7c/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
  const head = machoHead([{ fileoff: 0, filesize: 255_069_680 }]);
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "darwin",
        arch: "arm64",
        resolve: () => npxBin,
        statSync: () => ({ size: 30_552_546 }),
        readHead: () => head,
      }),
    (err) => {
      // Identifies the precise cache entry…
      assert.match(err.message, /[/\\].cache[/\\]_npx[/\\]9a8b7c(\s|$)/m);
      // …and never emits a destructive command that could nuke the project.
      assert.doesNotMatch(err.message, /rm -rf/);
      assert.doesNotMatch(err.message, /["']?\/work\/project["']?(\s|$)/m);
      return true;
    },
  );
});

test("repair (source/project) removes the corrupt package so npm re-extracts it (not a --force no-op)", () => {
  // Source install: SDK lives under claude-worker/node_modules, not the cwd.
  const srcBin =
    "/repo/claude-worker/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude";
  const head = machoHead([{ fileoff: 0, filesize: 255_069_680 }]);
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "linux",
        arch: "x64",
        sdkVersion: "0.3.210",
        resolve: () => srcBin,
        statSync: () => ({ size: 30_552_546 }),
        readHead: () => head,
      }),
    (err) => {
      // Names the EXACT corrupt package directory (dirname of the binary) to delete —
      // npm treats a same-version package as satisfied, so `npm install --force` alone
      // (an ADD/CHANGE-only re-extract) leaves the truncated bytes in place.
      assert.match(
        err.message,
        /[/\\]repo[/\\]claude-worker[/\\]node_modules[/\\]@anthropic-ai[/\\]claude-agent-sdk-linux-x64(\s|$)/m,
      );
      assert.match(err.message, /delete|remove/i);
      // Then a plain reinstall from the real install prefix; NOT a `npm install … --force` no-op.
      assert.match(err.message, /npm install/);
      assert.doesNotMatch(err.message, /npm install\b[^\n]*--force/);
      assert.match(err.message, /[/\\]repo[/\\]claude-worker(\s|$)/m); // the actual install prefix
      return true;
    },
  );
});

test("broken-binary wording is platform-appropriate (no macOS-only claim off macOS)", () => {
  const zero = () =>
    checkClaudeNativeBinary({
      platform: "linux",
      arch: "x64",
      resolve: () => "/x/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
      statSync: () => ({ size: 0 }),
      readHead: () => Buffer.alloc(0),
    });
  assert.throws(zero, (err) => {
    assert.doesNotMatch(err.message, /Mach-O|EBADMACHO|-88/);
    assert.match(err.message, /incomplete|corrupt/i);
    return true;
  });

  const zeroMac = () =>
    checkClaudeNativeBinary({
      platform: "darwin",
      arch: "arm64",
      resolve: () => "/x/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
      statSync: () => ({ size: 0 }),
      readHead: () => Buffer.alloc(0),
    });
  assert.throws(zeroMac, (err) => {
    assert.match(err.message, /-88|EBADMACHO/); // macOS keeps the specific diagnosis
    return true;
  });
});

test("missing-binary guidance is also npx-aware via the SDK anchor path", () => {
  const anchor =
    "/Users/x/.npm/_npx/9a8b7c/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "darwin",
        arch: "arm64",
        anchorPath: anchor,
        resolve() {
          throw new Error("Cannot find module");
        },
        statSync() {
          throw new Error("nope");
        },
        readHead() {
          throw new Error("nope");
        },
      }),
    (err) => {
      assert.match(err.message, /npx/i);
      assert.match(err.message, /_npx[/\\]9a8b7c/);
      return true;
    },
  );
});

// ── cross-platform truncation: ELF (Linux) and PE (Windows) ──────────────────
// The original outage was a truncated Mach-O, but the same partial-download
// failure happens on every platform. A truncated ELF/PE must fail preflight too.

/** Minimal 64-bit little-endian ELF header (+ optional program headers). */
function elf64Head({ shoff = 0, shnum = 0, shentsize = 64, phoff = 64, phnum = 0, phentsize = 56, segments = [] }) {
  const phEnd = phnum ? phoff + phnum * phentsize : 64;
  const b = Buffer.alloc(Math.max(64, phEnd));
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46; // \x7fELF
  b[4] = 2; // EI_CLASS = 64-bit
  b[5] = 1; // EI_DATA = little-endian
  b.writeBigUInt64LE(BigInt(phoff), 32); // e_phoff
  b.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
  b.writeUInt16LE(phentsize, 54);
  b.writeUInt16LE(phnum, 56);
  b.writeUInt16LE(shentsize, 58);
  b.writeUInt16LE(shnum, 60);
  segments.forEach((s, i) => {
    const base = phoff + i * phentsize;
    b.writeBigUInt64LE(BigInt(s.offset), base + 8); // p_offset
    b.writeBigUInt64LE(BigInt(s.filesz), base + 32); // p_filesz
  });
  return b;
}

/** Minimal PE (MZ + PE header + section table). */
function peHead({ peOff = 0x80, numSections = 0, sizeOptHdr = 0xf0, sections = [] }) {
  const sectOff = peOff + 24 + sizeOptHdr;
  const b = Buffer.alloc(Math.max(sectOff + numSections * 40, 0x40 + 4));
  b[0] = 0x4d; b[1] = 0x5a; // MZ
  b.writeUInt32LE(peOff, 0x3c); // e_lfanew
  b.writeUInt32LE(0x00004550, peOff); // 'PE\0\0'
  b.writeUInt16LE(numSections, peOff + 6); // NumberOfSections
  b.writeUInt16LE(sizeOptHdr, peOff + 20); // SizeOfOptionalHeader
  sections.forEach((s, i) => {
    const base = sectOff + i * 40;
    b.writeUInt32LE(s.sizeRaw, base + 16); // SizeOfRawData
    b.writeUInt32LE(s.ptrRaw, base + 20); // PointerToRawData
  });
  return b;
}

test("checkClaudeNativeBinary: truncated Linux ELF is caught (section table past EOF)", () => {
  const head = elf64Head({ shoff: 255_000_000, shnum: 1, shentsize: 64 });
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "linux",
        arch: "x64",
        resolve: () => "/x/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
        statSync: () => ({ size: 30_000_000 }),
        readHead: () => head,
      }),
    (err) => {
      assert.match(err.message, /incomplete|truncated|corrupt/i);
      assert.doesNotMatch(err.message, /Mach-O|-88/);
      return true;
    },
  );
});

test("checkClaudeNativeBinary: truncated ELF PT_LOAD segment past EOF is caught", () => {
  const head = elf64Head({
    shoff: 200, shnum: 1, shentsize: 64,
    phnum: 1, phoff: 64, phentsize: 56,
    segments: [{ offset: 0, filesz: 255_000_000 }],
  });
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "linux", arch: "arm64",
        resolve: () => "/x/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
        statSync: () => ({ size: 30_000_000 }),
        readHead: () => head,
      }),
    (err) => (assert.match(err.message, /incomplete|truncated|corrupt/i), true),
  );
});

test("checkClaudeNativeBinary: complete ELF passes", () => {
  const head = elf64Head({ shoff: 64, shnum: 1, shentsize: 64 }); // ends at 128
  const r = checkClaudeNativeBinary({
    platform: "linux", arch: "x64",
    resolve: () => "/x/claude",
    statSync: () => ({ size: 128 }),
    readHead: () => head,
  });
  assert.equal(r.ok, true);
});

test("checkClaudeNativeBinary: truncated Windows PE is caught (raw section past EOF)", () => {
  const head = peHead({ numSections: 1, sections: [{ ptrRaw: 4096, sizeRaw: 255_000_000 }] });
  assert.throws(
    () =>
      checkClaudeNativeBinary({
        platform: "win32", arch: "x64",
        resolve: () => "/x/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
        statSync: () => ({ size: 30_000_000 }),
        readHead: () => head,
      }),
    (err) => {
      assert.match(err.message, /incomplete|truncated|corrupt/i);
      assert.doesNotMatch(err.message, /Mach-O|-88/);
      return true;
    },
  );
});
