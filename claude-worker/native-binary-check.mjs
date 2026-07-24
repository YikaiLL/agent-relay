/**
 * Preflight for the Claude Code native CLI binary.
 *
 * @anthropic-ai/claude-agent-sdk (0.3.x) ships the actual `claude` CLI as a
 * per-platform native executable delivered through an OPTIONAL dependency
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). The SDK resolves that
 * binary and — because its path has no `.js` extension — `spawn()`s it directly.
 *
 * Two things make this fragile:
 *   1. optionalDependencies fail SILENTLY. A partial/interrupted install can
 *      leave the binary missing (npm just moves on, no error).
 *   2. A truncated download leaves a malformed Mach-O. macOS then refuses to
 *      exec it and the kernel returns errno 88 (EBADMACHO, "Malformed Mach-O").
 *      Node has no name for errno 88, so the user sees the cryptic
 *      `spawn Unknown system error -88` with no hint of what to do.
 *
 * This module turns both failure modes into an actionable error naming the exact
 * package to reinstall AND a repair procedure matched to how sealwire was
 * installed (npx cache / global / project), so the user can fix it instead of
 * guessing.
 *
 * The Mach-O completeness check reimplements `otool -l <bin>` (max of every
 * segment's `fileoff + filesize`) and compares it to the real file size — a
 * truncated download declares segments that extend past EOF. It also catches the
 * cruder corruption shapes (empty file, header/load-commands cut off, malformed
 * short segment commands) without ever reading past the buffer.
 */

import { createRequire } from "node:module";
import { openSync, readSync, closeSync, statSync as fsStatSync } from "node:fs";
import { dirname, sep } from "node:path";

const SDK_PKG = "@anthropic-ai/claude-agent-sdk";

// Mach-O magics (as read via readUInt32LE of the first 4 bytes).
const MH_MAGIC_64 = 0xfeedfacf; // 64-bit, host-endian data
const MH_CIGAM_64 = 0xcffaedfe; // 64-bit, byte-swapped data
const MH_MAGIC_32 = 0xfeedface; // 32-bit, host-endian data
const MH_CIGAM_32 = 0xcefaedfe; // 32-bit, byte-swapped data

const LC_SEGMENT = 0x1; // 32-bit segment
const LC_SEGMENT_64 = 0x19; // 64-bit segment

// Segment command struct sizes (through the fields we read: fileoff/filesize).
const SEG64_MIN = 72; // segment_command_64
const SEG32_MIN = 56; // segment_command

// ELF (Linux) and PE (Windows) magic markers.
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]; // \x7fELF
const PE_SIGNATURE = 0x00004550; // 'PE\0\0'

// How much of the head to read. Mach-O load commands live at the very start and
// are tiny (the real CLI has ~2.7 KB), so 256 KiB is always more than enough.
const HEAD_BYTES = 256 * 1024;

/**
 * The per-platform native package name(s) the SDK will try, most-preferred
 * first — mirrors the SDK's own resolution (linux tries musl/glibc variants;
 * win32 uses a `.exe`). Each entry is `{ pkg, spec }` where `spec` is what the
 * SDK passes to `require.resolve`.
 */
export function expectedNativePackages(platform, arch, { preferMusl = false } = {}) {
  const ext = platform === "win32" ? ".exe" : "";
  let names;
  if (platform === "android") {
    names = [`${SDK_PKG}-linux-${arch}-android`];
  } else if (platform === "linux") {
    names = preferMusl
      ? [`${SDK_PKG}-linux-${arch}-musl`, `${SDK_PKG}-linux-${arch}`]
      : [`${SDK_PKG}-linux-${arch}`, `${SDK_PKG}-linux-${arch}-musl`];
  } else {
    names = [`${SDK_PKG}-${platform}-${arch}`];
  }
  return names.map((pkg) => ({ pkg, spec: `${pkg}/claude${ext}` }));
}

/**
 * Inspect the Mach-O at the start of `head` (backed by a file of `fileSize`
 * bytes) and classify it:
 *   - `{ corrupt: true }`  — definitely broken (empty; or a thin Mach-O whose
 *                            own header/load-commands/segments don't fit the
 *                            file). Actionable.
 *   - `{ truncated: true }`— parsed fully; a segment reaches past EOF.
 *   - `{ verified: true, corrupt:false, truncated:false }` — looks complete.
 *   - `{ verified: false }`— a format we don't parse (fat/universal, ELF, PE).
 *                            Never flagged, to avoid false alarms.
 *
 * Never reads past `head` or claims corruption it cannot prove.
 */
export function inspectMachoCompleteness(head, fileSize) {
  // An empty file is unambiguously a broken install on every platform/format.
  if (fileSize === 0) {
    return { verified: true, corrupt: true, reason: "empty-file", fileSize };
  }
  if (!head || head.length < 4) {
    // Too small to even hold a magic number → cannot be any real executable.
    return { verified: true, corrupt: true, reason: "too-small", fileSize };
  }

  const magic = head.readUInt32LE(0);
  let is64;
  let le;
  if (magic === MH_MAGIC_64) {
    is64 = true;
    le = true;
  } else if (magic === MH_CIGAM_64) {
    is64 = true;
    le = false;
  } else if (magic === MH_MAGIC_32) {
    is64 = false;
    le = true;
  } else if (magic === MH_CIGAM_32) {
    is64 = false;
    le = false;
  } else {
    // Fat/universal (0xCAFEBABE), ELF, PE, or not an executable — cannot judge.
    return { verified: false, reason: "not-thin-macho", magic, fileSize };
  }

  // From here the file CLAIMS to be a thin Mach-O. A real one always contains
  // its full header + load commands at the very start, so any shortfall against
  // the FILE size is definite corruption. `presence()` distinguishes:
  //   "corrupt"    — the field lies beyond the real end of file, or
  //   "unreadable" — beyond what we buffered but still within the file (only
  //                  possible for absurdly large load commands; treat as
  //                  unverifiable rather than corrupt), or
  //   "ok".
  const presence = (off, size) => {
    if (off + size > fileSize) return "corrupt";
    if (off + size > head.length) return "unreadable";
    return "ok";
  };
  const u32 = (off) => (le ? head.readUInt32LE(off) : head.readUInt32BE(off));
  const u64 = (off) =>
    Number(le ? head.readBigUInt64LE(off) : head.readBigUInt64BE(off));

  const headerSize = is64 ? 32 : 28;
  const headerPresence = presence(0, headerSize);
  if (headerPresence === "corrupt") {
    return { verified: true, corrupt: true, reason: "header-truncated", fileSize };
  }
  if (headerPresence === "unreadable") {
    return { verified: false, reason: "header-unreadable", fileSize };
  }

  const ncmds = u32(16);
  const sizeofcmds = u32(20);
  const lcStart = headerSize;
  const cmdsPresence = presence(lcStart, sizeofcmds);
  if (cmdsPresence === "corrupt") {
    return { verified: true, corrupt: true, reason: "load-commands-truncated", fileSize };
  }
  if (cmdsPresence === "unreadable") {
    return { verified: false, reason: "load-commands-unreadable", fileSize };
  }

  // Iterate strictly within the DECLARED load-command region [lcStart, lcEnd).
  // `cmdsPresence === "ok"` guarantees lcEnd <= min(fileSize, head.length), so
  // reads below stay in-bounds. Bounding by lcEnd (not the whole file) is what
  // catches commands that overrun `sizeofcmds` or a header whose ncmds/sizes
  // disagree.
  const lcEnd = lcStart + sizeofcmds;
  let declaredEnd = 0;
  let off = lcStart;
  for (let i = 0; i < ncmds; i += 1) {
    if (off + 8 > lcEnd) {
      // More commands than the declared region holds.
      return { verified: true, corrupt: true, reason: "ncmds-exceeds-sizeofcmds", fileSize };
    }
    const cmd = u32(off);
    const cmdsize = u32(off + 4);
    if (cmdsize < 8 || off + cmdsize > lcEnd) {
      // A command shorter than its header, or one overrunning the region.
      return { verified: true, corrupt: true, reason: "bad-cmdsize", fileSize };
    }
    if (cmd === LC_SEGMENT_64) {
      // A genuine LC_SEGMENT_64 is 72 bytes; a shorter one means the command was
      // cut off before fileoff/filesize — corrupt, and we must NOT read those
      // fields (that was the RangeError bug).
      if (cmdsize < SEG64_MIN) {
        return { verified: true, corrupt: true, reason: "short-segment64", fileSize };
      }
      declaredEnd = Math.max(declaredEnd, u64(off + 40) + u64(off + 48));
    } else if (cmd === LC_SEGMENT) {
      if (cmdsize < SEG32_MIN) {
        return { verified: true, corrupt: true, reason: "short-segment32", fileSize };
      }
      declaredEnd = Math.max(declaredEnd, u32(off + 32) + u32(off + 36));
    }
    off += cmdsize;
  }
  // Every declared load-command byte must be consumed exactly; leftover slack
  // means the header's ncmds/sizeofcmds disagree with the actual commands.
  if (off !== lcEnd) {
    return { verified: true, corrupt: true, reason: "load-commands-underfill", fileSize };
  }

  return {
    verified: true,
    corrupt: false,
    format: is64 ? "macho64" : "macho32",
    fileSize,
    declaredEnd,
    truncated: declaredEnd > fileSize,
  };
}

/**
 * ELF (Linux) completeness. Computes the furthest declared file extent from the
 * ELF header — the section-header table end (`e_shoff + e_shnum*e_shentsize`,
 * which normally sits at the very end of file) and each program header's
 * `p_offset + p_filesz` — and compares it to the real file size. A partial
 * download declares an extent past EOF.
 */
export function inspectElfCompleteness(head, fileSize) {
  const is64 = head[4] === 2; // EI_CLASS: 1 = 32-bit, 2 = 64-bit
  const le = head[5] !== 2; // EI_DATA: 2 = big-endian, else little-endian
  const headerSize = is64 ? 64 : 52;
  if (head.length < headerSize) {
    // Real ELF header is 52 (32-bit) / 64 (64-bit) bytes; a file too short to
    // even hold it is corrupt.
    if (fileSize < headerSize) {
      return { verified: true, corrupt: true, reason: "elf-header-truncated", fileSize };
    }
    return { verified: false, reason: "elf-header-unreadable", fileSize };
  }
  const u16 = (o) => (le ? head.readUInt16LE(o) : head.readUInt16BE(o));
  const u32 = (o) => (le ? head.readUInt32LE(o) : head.readUInt32BE(o));
  const u64 = (o) => Number(le ? head.readBigUInt64LE(o) : head.readBigUInt64BE(o));

  const phoff = is64 ? u64(32) : u32(28);
  const shoff = is64 ? u64(40) : u32(32);
  const phentsize = is64 ? u16(54) : u16(42);
  const phnum = is64 ? u16(56) : u16(44);
  const shentsize = is64 ? u16(58) : u16(46);
  const shnum = is64 ? u16(60) : u16(48);

  let declaredEnd = 0;
  if (phnum > 0) declaredEnd = Math.max(declaredEnd, phoff + phnum * phentsize);
  if (shnum > 0) declaredEnd = Math.max(declaredEnd, shoff + shnum * shentsize);

  // Program headers sit right after the ELF header, so they're usually within
  // the head buffer — use them to catch a truncated PT_LOAD segment.
  const phEntryMin = is64 ? 56 : 32;
  if (phnum > 0 && phentsize >= phEntryMin && phoff + phnum * phentsize <= head.length) {
    for (let i = 0; i < phnum; i += 1) {
      const base = phoff + i * phentsize;
      const pOffset = is64 ? u64(base + 8) : u32(base + 4);
      const pFilesz = is64 ? u64(base + 32) : u32(base + 16);
      declaredEnd = Math.max(declaredEnd, pOffset + pFilesz);
    }
  }

  if (declaredEnd === 0) {
    // No section/program tables to reason about — don't guess.
    return { verified: false, reason: "elf-no-extents", fileSize };
  }
  return {
    verified: true,
    corrupt: false,
    format: is64 ? "elf64" : "elf32",
    fileSize,
    declaredEnd,
    truncated: declaredEnd > fileSize,
  };
}

/**
 * PE (Windows) completeness. Computes the furthest declared raw-data extent
 * (`PointerToRawData + SizeOfRawData` across sections, plus the section table
 * itself) and compares it to the file size.
 */
export function inspectPeCompleteness(head, fileSize) {
  if (head.length < 0x40) {
    if (fileSize < 0x40) {
      return { verified: true, corrupt: true, reason: "pe-header-truncated", fileSize };
    }
    return { verified: false, reason: "pe-header-unreadable", fileSize };
  }
  const peOff = head.readUInt32LE(0x3c); // e_lfanew
  const coffEnd = peOff + 24; // PE sig (4) + COFF file header (20)
  if (coffEnd > fileSize) {
    return { verified: true, corrupt: true, reason: "pe-header-truncated", fileSize };
  }
  if (coffEnd > head.length) {
    return { verified: false, reason: "pe-header-unreadable", fileSize };
  }
  if (head.readUInt32LE(peOff) !== PE_SIGNATURE) {
    return { verified: false, reason: "pe-bad-signature", fileSize };
  }
  const numSections = head.readUInt16LE(peOff + 6);
  const sizeOptHdr = head.readUInt16LE(peOff + 20);
  const sectTableOff = coffEnd + sizeOptHdr;
  const sectTableEnd = sectTableOff + numSections * 40;
  if (sectTableEnd > fileSize) {
    return { verified: true, corrupt: true, reason: "pe-section-table-truncated", fileSize };
  }
  if (sectTableEnd > head.length) {
    return { verified: false, reason: "pe-section-table-unreadable", fileSize };
  }

  let declaredEnd = sectTableEnd;
  for (let i = 0; i < numSections; i += 1) {
    const base = sectTableOff + i * 40;
    const sizeRaw = head.readUInt32LE(base + 16);
    const ptrRaw = head.readUInt32LE(base + 20);
    if (ptrRaw > 0) declaredEnd = Math.max(declaredEnd, ptrRaw + sizeRaw);
  }
  return {
    verified: true,
    corrupt: false,
    format: "pe",
    fileSize,
    declaredEnd,
    truncated: declaredEnd > fileSize,
  };
}

/**
 * Format-dispatching completeness check for the native CLI binary. Handles the
 * cross-platform "empty/too-small" cases, then routes to the Mach-O (macOS),
 * ELF (Linux), or PE (Windows) parser by magic. Unknown formats are left
 * unverified so we never raise a false alarm.
 */
export function inspectExecutableCompleteness(head, fileSize) {
  if (fileSize === 0) {
    return { verified: true, corrupt: true, reason: "empty-file", fileSize };
  }
  if (!head || head.length < 4) {
    return { verified: true, corrupt: true, reason: "too-small", fileSize };
  }
  const m = head.readUInt32LE(0);
  if (m === MH_MAGIC_64 || m === MH_CIGAM_64 || m === MH_MAGIC_32 || m === MH_CIGAM_32) {
    return inspectMachoCompleteness(head, fileSize);
  }
  if (ELF_MAGIC.every((b, i) => head[i] === b)) {
    return inspectElfCompleteness(head, fileSize);
  }
  if (head[0] === 0x4d && head[1] === 0x5a) {
    // 'MZ' — DOS/PE. (Fat Mach-O 0xCAFEBABE stays unverified below.)
    return inspectPeCompleteness(head, fileSize);
  }
  return { verified: false, reason: "unknown-format", fileSize };
}

/**
 * The specific `_npx/<hash>` cache directory a path lives in, or null if the
 * path is not a recognizable npx cache layout. Derived from the actual `_npx`
 * and `<hash>` components (npm's cache root is configurable and may itself sit
 * under a `node_modules`), and validated so we never point at anything but a
 * narrow npx cache entry.
 */
export function npxCacheDir(p) {
  if (!p) return null;
  const parts = p.split(sep);
  const i = parts.lastIndexOf("_npx");
  if (i < 0 || i + 2 >= parts.length) return null;
  const hash = parts[i + 1];
  if (!/^[0-9a-f]+$/i.test(hash)) return null; // npx cache keys are hex digests
  if (parts[i + 2] !== "node_modules") return null; // layout: _npx/<hash>/node_modules/…
  return parts.slice(0, i + 2).join(sep); // …/_npx/<hash>
}

/**
 * The install prefix (the directory whose `node_modules` holds the package) for
 * a resolved path like `<prefix>/node_modules/@scope/pkg/claude`, or null.
 */
export function installPrefix(p) {
  if (!p) return null;
  const marker = `${sep}node_modules${sep}`;
  const idx = p.lastIndexOf(marker);
  return idx < 0 ? null : p.slice(0, idx);
}

/**
 * Repair steps matched to how sealwire was installed. `contextPath` is any path
 * inside that install (the native binary, or the SDK entry).
 *
 * Safety: we only ever PRINT paths — never interpolate them into a destructive
 * command — so the guidance can't be mis-copy-pasted into deleting the wrong
 * directory, needs no shell escaping, and works on every OS (the only literal
 * commands are OS-agnostic npm/npx invocations).
 *
 * Effectiveness: npm treats an already-present, same-version package as
 * satisfied and only re-extracts nodes whose tree diff is ADD/CHANGE — so a
 * plain (or even `--force`) reinstall does NOT rewrite the truncated bytes. When
 * we know the corrupt package's directory (`brokenBinaryPath`), we tell the user
 * to remove it first so the reinstall re-extracts it as a fresh ADD.
 */
function repairSteps(contextPath, brokenBinaryPath = null) {
  const cacheDir = npxCacheDir(contextPath);
  if (cacheDir) {
    // Deleting the whole npx cache entry forces npx to refetch everything.
    return [
      `You are running via npx and its cached copy is broken.`,
      `Delete this npx cache directory, then re-run \`npx sealwire …\` — npx will refetch a clean copy:`,
      `  ${cacheDir}`,
      `(clearing the download cache first also helps: npm cache clean --force)`,
    ];
  }

  const prefix = installPrefix(contextPath);
  const steps = [];
  if (brokenBinaryPath) {
    steps.push(
      `A same-version reinstall is a metadata no-op and will NOT replace the`,
      `corrupted bytes — first delete this package directory:`,
      `  ${dirname(brokenBinaryPath)}`,
    );
  }
  steps.push(`Reinstall — run these from the directory that owns the install:`);
  if (prefix) steps.push(`  ${prefix}`);
  steps.push(`  npm cache clean --force`, `  npm install`);
  return steps;
}

function missingError(candidates, contextPath, cause) {
  const names = candidates.map((c) => c.pkg).join(", ");
  return new Error(
    `Claude Code native CLI binary is missing.\n` +
      `Expected one of: ${names}\n` +
      `${SDK_PKG} did not install its per-platform binary — optionalDependencies ` +
      `are skipped silently on a failed/partial install.\n` +
      `Fix:\n` +
      repairSteps(contextPath).join("\n") +
      (cause ? `\n[resolve error: ${cause.message ?? cause}]` : ""),
  );
}

function spawnFailureNote(platform) {
  if (platform === "darwin") {
    return (
      `On macOS the kernel rejects it as a malformed Mach-O, so spawning fails with ` +
      `"spawn Unknown system error -88" (EBADMACHO, errno 88).`
    );
  }
  if (platform === "win32") {
    return `Spawning this incomplete image fails — it is not a valid executable.`;
  }
  return `Spawning this incomplete ELF executable fails (e.g. ENOEXEC).`;
}

function headerLabel(format) {
  if (typeof format === "string" && format.startsWith("elf")) return "ELF";
  if (format === "pe") return "PE";
  return "Mach-O";
}

function brokenBinaryError(path, info, platform) {
  const detail =
    typeof info.declaredEnd === "number"
      ? `file is ${info.fileSize} bytes but its ${headerLabel(info.format)} headers declare ${info.declaredEnd} bytes`
      : `file is ${info.fileSize} bytes and is structurally incomplete (${info.reason})`;
  return new Error(
    `Claude Code native CLI binary is incomplete/corrupt.\n` +
      `  path: ${path}\n` +
      `  ${detail} — the download did not finish.\n` +
      `  ${spawnFailureNote(platform)}\n` +
      `Fix:\n` +
      repairSteps(path, path).join("\n"),
  );
}

/**
 * Throw an actionable error if the resolved native binary is missing, empty,
 * truncated or otherwise structurally broken; otherwise return
 * `{ ok: true, path, pkg, info }`. All I/O and resolution are injected so this
 * is a pure, unit-testable function.
 */
export function checkClaudeNativeBinary({
  platform = process.platform,
  arch = process.arch,
  preferMusl = false,
  anchorPath = null,
  resolve,
  statSync,
  readHead,
} = {}) {
  const candidates = expectedNativePackages(platform, arch, { preferMusl });

  let path = null;
  let pkg = null;
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      path = resolve(candidate.spec);
      pkg = candidate.pkg;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!path) {
    throw missingError(candidates, anchorPath, lastErr);
  }

  let fileSize;
  try {
    fileSize = statSync(path).size;
  } catch (err) {
    throw missingError(candidates, anchorPath ?? path, err);
  }

  const head = readHead(path, fileSize);
  const info = inspectExecutableCompleteness(head, fileSize);
  if (info.corrupt || info.truncated) {
    throw brokenBinaryError(path, info, platform);
  }

  return { ok: true, path, pkg, info };
}

function sdkEntryPath() {
  try {
    return createRequire(import.meta.url).resolve(SDK_PKG);
  } catch {
    return null;
  }
}

function defaultResolve(spec) {
  // Anchor resolution at the SDK's entry so we find the same hoisted/nested
  // native package the SDK itself would (createRequire from the SDK's own file).
  const here = createRequire(import.meta.url);
  const sdkEntry = here.resolve(SDK_PKG);
  return createRequire(sdkEntry).resolve(spec);
}

function defaultReadHead(path, fileSize) {
  const length = Math.min(fileSize, HEAD_BYTES);
  if (length === 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buf, 0, length, 0);
    return read === length ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function detectPreferMusl(platform) {
  if (platform !== "linux") return false;
  try {
    const report = process.report?.getReport?.();
    // musl builds have no glibcVersionRuntime in the process report.
    return report != null && report.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

/**
 * Real-dependency wrapper used by the worker: wires actual fs + module
 * resolution into {@link checkClaudeNativeBinary}. Throws an actionable error
 * if the native CLI binary is missing or broken.
 */
export function checkInstalledClaudeBinary(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  const anchorPath = sdkEntryPath();
  return checkClaudeNativeBinary({
    platform,
    arch: process.arch,
    preferMusl: detectPreferMusl(platform),
    anchorPath,
    resolve: defaultResolve,
    statSync: (p) => fsStatSync(p),
    readHead: defaultReadHead,
    ...overrides,
  });
}
