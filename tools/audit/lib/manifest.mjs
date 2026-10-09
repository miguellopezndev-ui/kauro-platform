// The run manifest (W-1, W-2a): `MANIFEST.sha256` lists every file of an immutable run directory, sorted by path (code-unit order,
// never the directory order), as `<sha256>  <path>` lines. verifyManifest is the only thing that makes a run directory valid: a run
// without a manifest is ignored by readers (E_MANIFEST_ABSENT); a changed file is E_MANIFEST_CHANGED, a file the manifest lists but
// the directory lacks E_MANIFEST_MISSING, a file the manifest does not list E_MANIFEST_EXTRA. Temp files (`*.tmp-*`) are not run files.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeOnce, isTempName } from "./atomic.mjs";
import { fail, sha256Hex } from "./record.mjs";

export const MANIFEST_NAME = "MANIFEST.sha256";

function walk(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (isTempName(name)) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, name)).isDirectory()) out.push(...walk(join(dir, name), rel));
    else if (rel !== MANIFEST_NAME) out.push(rel);
  }
  return out;
}

function listing(dir) {
  return walk(dir)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((rel) => ({ rel, sha256: sha256Hex(readFileSync(join(dir, rel))) }));
}

/** The manifest text of `dir` (every file but the manifest itself, sorted, with its SHA-256). */
export function buildManifest(dir) {
  return listing(dir).map((e) => `${e.sha256}  ${e.rel}\n`).join("");
}

/** Writes MANIFEST.sha256 once (writeOnce) and returns its text. */
export function writeManifest(dir, options = {}) {
  const text = buildManifest(dir);
  writeOnce(join(dir, MANIFEST_NAME), text, options);
  return text;
}

export function verifyManifest(dir) {
  let text;
  try {
    text = readFileSync(join(dir, MANIFEST_NAME), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw fail("E_MANIFEST_ABSENT", `${dir} has no ${MANIFEST_NAME}`);
    throw error;
  }
  const listed = new Map();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) throw fail("E_MANIFEST_CHANGED", `${MANIFEST_NAME} has a malformed line: ${line}`);
    listed.set(m[2], m[1]);
  }
  const actual = new Map(listing(dir).map((e) => [e.rel, e.sha256]));
  for (const rel of listed.keys()) if (!actual.has(rel)) throw fail("E_MANIFEST_MISSING", `${rel} is listed in ${MANIFEST_NAME} but absent`, { path: rel });
  for (const rel of actual.keys()) if (!listed.has(rel)) throw fail("E_MANIFEST_EXTRA", `${rel} is not listed in ${MANIFEST_NAME}`, { path: rel });
  for (const [rel, sha] of listed) if (actual.get(rel) !== sha) throw fail("E_MANIFEST_CHANGED", `${rel} differs from ${MANIFEST_NAME}`, { path: rel });
  return { files: listed.size };
}
