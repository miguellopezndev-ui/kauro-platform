// B05 D5-1 (S045): the vendored cores. Each core is a pinned tarball under vendor/ (Migration Core: the published release asset,
// verbatim; Intelligence Core: a provisional pack of a clean clone until its release). `check` proves, for every core listed
// in vendor/MANIFEST.json, that sha256(file) == MANIFEST == the release SHA256SUMS line (when released) and that the
// pnpm-lock integrity equals the file's sha512; it refuses a sibling file:../, link: or workspace: spec of a core, a spec that
// is not the exact vendored version, and an override that is not the vendored file. `--release` also refuses any PROVISIONAL pin.
// `--installed` additionally proves the installed core files equal the tarball's and that each wrapper's export names equal
// its core's root exports (the wrapper must be built). No network and no credential are needed.
//   node tools/vendor-cores.mjs check [--release] [--installed] [--root <dir>]
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");
const sha512B64 = (buf) => createHash("sha512").update(buf).digest("base64");

/** export names of a core's root namespace missing from / extra in its wrapper's */
export function diffExportNames(coreNamespace, wrapperNamespace) {
  const core = new Set(Object.keys(coreNamespace));
  const wrapper = new Set(Object.keys(wrapperNamespace));
  return { missing: [...core].filter((n) => !wrapper.has(n)).sort(), extra: [...wrapper].filter((n) => !core.has(n)).sort() };
}

function* walkFiles(dir, base = dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walkFiles(p, base);
    else yield relative(base, p).split(sep).join("/");
  }
}

/** problems of an installed package directory against the sha256 of every file of the tarball (relative path -> hex) */
export function diffInstalledFiles(installedDir, expected) {
  const problems = [];
  const seen = new Set();
  for (const rel of walkFiles(installedDir)) {
    seen.add(rel);
    const want = expected.get(rel);
    if (want === undefined) problems.push(`${rel} is not in the tarball`);
    else if (sha256Hex(readFileSync(join(installedDir, rel))) !== want) problems.push(`${rel} differs from the tarball`);
  }
  for (const rel of expected.keys()) if (!seen.has(rel)) problems.push(`${rel} is missing from the install`);
  return problems;
}

function parseOverrides(text) {
  const out = new Map();
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^overrides:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside) {
      const m = /^  (?:"([^"]+)"|'([^']+)'|([^\s:'"]+)):\s*(?:"([^"]*)"|'([^']*)'|(\S.*?))\s*$/.exec(line);
      if (m) out.set(m[1] ?? m[2] ?? m[3], m[4] ?? m[5] ?? m[6]);
      else if (/^\S/.test(line)) inside = false;
    }
  }
  return out;
}

function lockIntegrity(lockText, name, file) {
  const header = `  ${name}@file:${file}:`;
  const lines = lockText.split(/\r?\n/);
  const at = lines.indexOf(header);
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length && lines[i].startsWith("    "); i += 1) {
    const m = /^    resolution: \{integrity: (sha512-[^,}\s]+)/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

function packageJsonFiles(root) {
  const out = [join(root, "package.json")];
  for (const group of ["packages", "apps"]) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, "package.json");
      if (existsSync(p)) out.push(p);
    }
  }
  return out.filter((p) => existsSync(p));
}

export function checkVendoredCores({ root, release = false }) {
  const problems = [];
  const notes = [];
  const fail = (rule, text) => problems.push(`[${rule}] ${text}`);
  const manifestPath = join(root, "vendor", "MANIFEST.json");
  if (!existsSync(manifestPath)) return { problems: ["[manifest] vendor/MANIFEST.json is missing"], notes, cores: [] };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.artifactKind !== "KAURO_VENDORED_DEPENDENCIES" || !Array.isArray(manifest.cores) || manifest.cores.length === 0) {
    return { problems: ["[manifest] vendor/MANIFEST.json is not a KAURO_VENDORED_DEPENDENCIES set with at least one core"], notes, cores: [] };
  }
  const lockPath = join(root, "pnpm-lock.yaml");
  const lockText = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "";
  if (lockText === "") fail("lock", "pnpm-lock.yaml is missing or empty");
  const wsPath = join(root, "pnpm-workspace.yaml");
  const overrides = existsSync(wsPath) ? parseOverrides(readFileSync(wsPath, "utf8")) : new Map();
  const manifests = packageJsonFiles(root).map((p) => ({ rel: relative(root, p).split(sep).join("/"), json: JSON.parse(readFileSync(p, "utf8")) }));

  for (const core of manifest.cores) {
    const { name, version, file } = core;
    const statusOk = core.status === "RELEASED" || core.status === "PROVISIONAL_UNRELEASED";
    if (!statusOk) fail("manifest", `${name}: status ${core.status} is neither RELEASED nor PROVISIONAL_UNRELEASED`);
    if (statusOk && (core.status === "PROVISIONAL_UNRELEASED") !== (core.provisional === true)) fail("manifest", `${name}: status ${core.status} disagrees with provisional ${core.provisional}`);
    if (core.status === "RELEASED" && typeof core.sha256sums !== "string") fail("manifest", `${name}: a RELEASED core names the release SHA256SUMS file it was checked against`);
    if (typeof file !== "string" || !file.startsWith("vendor/") || file.includes("..")) {
      fail("manifest", `${name}: file ${file} is not a path under vendor/`);
      continue;
    }
    const path = join(root, file);
    if (!existsSync(path)) {
      fail("manifest", `${file} is missing`);
      continue;
    }
    const bytes = readFileSync(path);
    const actual = sha256Hex(bytes);
    let clean = true;
    if (bytes.length !== core.bytes) {
      fail("bytes", `${file} is ${bytes.length} bytes, MANIFEST says ${core.bytes}`);
      clean = false;
    }
    if (actual !== core.sha256) {
      fail("sha256", `${file} sha256 ${actual} differs from MANIFEST ${core.sha256}`);
      clean = false;
    }
    if (typeof core.sha256sums === "string") {
      const sumsPath = join(root, core.sha256sums);
      if (!existsSync(sumsPath)) {
        fail("sums", `${core.sha256sums} is missing`);
        clean = false;
      } else {
        const line = readFileSync(sumsPath, "utf8").split(/\r?\n/).map((l) => /^([0-9a-f]{64}) [ *](.+)$/.exec(l)).find((m) => m && m[2] === basename(file));
        if (!line) {
          fail("sums", `${core.sha256sums} has no line for ${basename(file)}`);
          clean = false;
        } else if (line[1] !== actual) {
          fail("sums", `${core.sha256sums} line for ${basename(file)} is ${line[1]}, the file is ${actual}`);
          clean = false;
        }
      }
    }
    const integrity = lockIntegrity(lockText, name, file);
    if (integrity === null) {
      fail("lock", `pnpm-lock.yaml has no resolution for ${name}@file:${file}`);
      clean = false;
    } else if (integrity !== `sha512-${sha512B64(bytes)}`) {
      fail("lock", `pnpm-lock.yaml integrity of ${name}@file:${file} does not equal the file's sha512`);
      clean = false;
    }
    // specs: a core is declared by its exact version only, never a sibling path, link: or workspace:
    for (const m of manifests) {
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const spec = m.json[section]?.[name];
        if (spec === undefined) continue;
        if (/^(link:|workspace:|file:|portal:|\.\.?\/)/.test(spec)) {
          fail("spec", `${m.rel}: ${name} is ${JSON.stringify(spec)}; a vendored core is declared by its exact version and resolved through the pnpm-workspace.yaml override, never a path, link: or workspace:`);
          clean = false;
        } else if (spec !== version) {
          fail("spec", `${m.rel}: ${name} is ${JSON.stringify(spec)}, the vendored version is the exact ${version}`);
          clean = false;
        }
      }
    }
    const override = overrides.get(name);
    if (override !== `file:${file}`) {
      fail("spec", `pnpm-workspace.yaml: override ${name} is ${override === undefined ? "missing" : JSON.stringify(override)}, expected file:${file}`);
      clean = false;
    }
    if (core.status === "PROVISIONAL_UNRELEASED") {
      if (release) fail("release", `${name} ${version} is PROVISIONAL_UNRELEASED (source commit ${core.source?.commit}); a release refuses a provisional pin`);
      if (clean) notes.push(`${name} ${version} sha256 ${actual} == MANIFEST == lock integrity (no release SHA256SUMS) PROVISIONAL_UNRELEASED`);
    } else if (clean) notes.push(`${name} ${version} sha256 ${actual} == MANIFEST == SHA256SUMS == lock integrity (${core.status})`);
  }
  return { problems, notes, cores: manifest.cores };
}

/** sha256 of every regular file of an npm tarball (path relative to its package/ root); a dependency-free ustar/pax reader, so no tar binary is needed */
export function tarballFileHashes(tgz) {
  const tar = gunzipSync(readFileSync(tgz));
  const map = new Map();
  let pax = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (from, len) => header.subarray(from, from + len).toString("utf8").replace(/\u0000[\s\S]*$/, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    let name = prefix ? prefix + "/" + field(0, 100) : field(0, 100);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = body.toString("utf8");
      continue;
    }
    if (type === "g") continue;
    if (pax !== null) {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(pax);
      if (m) name = m[1];
      pax = null;
    }
    if (type !== "0" && type !== "\u0000") continue;
    if (!name.startsWith("package/")) throw new Error(`${tgz}: entry ${name} is outside package/`);
    map.set(name.slice("package/".length), sha256Hex(body));
  }
  return map;
}

async function checkInstalled(root, cores) {
  const problems = [];
  const notes = [];
  for (const core of cores) {
    if (typeof core.wrapper !== "string") {
      problems.push(`[manifest] ${core.name}: no wrapper package named`);
      continue;
    }
    const wrapperDir = join(root, core.wrapper);
    const wrapperName = JSON.parse(readFileSync(join(wrapperDir, "package.json"), "utf8")).name;
    const link = join(wrapperDir, "node_modules", core.name);
    if (!existsSync(link)) {
      problems.push(`[installed] ${core.wrapper}/node_modules/${core.name} is missing: run pnpm install`);
      continue;
    }
    const installed = realpathSync(link);
    const expected = tarballFileHashes(join(root, core.file));
    const fileProblems = diffInstalledFiles(installed, expected);
    if (fileProblems.length) for (const p of fileProblems) problems.push(`[installed] ${core.name}: ${p}`);
    else notes.push(`installed ${core.name} files equal the tarball's ${expected.size} files`);
    const wrapperEntry = join(wrapperDir, "dist", "src", "index.js");
    if (!existsSync(wrapperEntry)) {
      problems.push(`[installed] ${wrapperName} is not built (${core.wrapper}/dist/src/index.js): build first`);
      continue;
    }
    const corePkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const coreExport = corePkg.exports?.["."];
    const coreEntry = join(installed, typeof coreExport === "string" ? coreExport : coreExport.default);
    const coreNs = await import(pathToFileURL(coreEntry).href);
    const wrapperNs = await import(pathToFileURL(wrapperEntry).href);
    const { missing, extra } = diffExportNames(coreNs, wrapperNs);
    if (missing.length || extra.length) problems.push(`[exports] ${wrapperName} differs from ${core.name}'s root exports: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
    else notes.push(`${wrapperName} exports equal ${core.name}'s ${Object.keys(coreNs).length} root exports`);
  }
  return { problems, notes };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "check") {
    console.error("usage: node tools/vendor-cores.mjs check [--release] [--installed] [--root <dir>]");
    process.exit(2);
  }
  const at = args.indexOf("--root");
  const root = at >= 0 ? resolve(args[at + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = checkVendoredCores({ root, release: args.includes("--release") });
  let { problems, notes } = result;
  if (args.includes("--installed")) {
    const installed = await checkInstalled(root, result.cores);
    problems = [...problems, ...installed.problems];
    notes = [...notes, ...installed.notes];
  }
  for (const n of notes) console.log(`vendor-cores: ${n}`);
  if (problems.length) {
    for (const p of problems) console.error(`vendor-cores: ${p}`);
    console.error(`vendor-cores: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`vendor-cores: ${result.cores.length} vendored core(s) verified${args.includes("--release") ? " for release" : ""}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
