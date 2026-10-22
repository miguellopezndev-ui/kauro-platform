// Loads the byte-exact Migration Core 3.0.0 acceptance packages (test/fixtures/mc-3.0.0, PROVENANCE.json) and forges altered
// copies the way an adversary who can rewrite the manifest would: the altered file's length, SHA-256 and record count are
// re-declared, so the manifest's own sums still match (CMD039-DENY).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CASES = ["A-clean-multi-object", "B-dirty-multinational", "C-identity-adversarial", "D-hubspot", "D-salesforce"] as const;
export type CaseName = (typeof CASES)[number];

const root = fileURLToPath(new URL("../../../test/fixtures/mc-3.0.0/", import.meta.url));

export function loadPackage(name: CaseName): Map<string, Uint8Array> {
  return loadDirectory(join(root, name));
}

/** A package the vendored core 3.0.0 wrote with rows it could not read and rows no mapping covers (mc-3.0.0-rejected/PROVENANCE.json). */
export const REJECTED_CASE = {
  dir: fileURLToPath(new URL("../../../test/fixtures/mc-3.0.0-rejected/E-rejected-rows/package/", import.meta.url)),
  manifestSha256: "7839c079d2cf4c0193f725b3f312117bcaa4e054d46cb8de4417e43a1604be37",
  packageDigest: "8d58776ea802e309ccb2fe38e75a6f613a642dfb46ca6cce64e924d959ebb14c",
  files: 30,
} as const;

export function loadRejectedPackage(): Map<string, Uint8Array> {
  return loadDirectory(REJECTED_CASE.dir);
}

function loadDirectory(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(relative(dir, full).split(sep).join("/"), new Uint8Array(readFileSync(full)));
    }
  };
  walk(dir);
  return files;
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

export function manifestOf(files: Map<string, Uint8Array>): Record<string, unknown> & { artifacts: Record<string, unknown>[] } {
  return JSON.parse(text(files.get("manifest.json") as Uint8Array));
}

export function writeManifest(files: Map<string, Uint8Array>, manifest: unknown): void {
  files.set("manifest.json", bytesOf(JSON.stringify(manifest)));
}

/** Replaces one file and re-declares it in the manifest (length, hash and, for CSV, record count). */
export function forge(files: Map<string, Uint8Array>, path: string, content: string): void {
  forgeBytes(files, path, bytesOf(content), path.endsWith(".csv") ? content.split("\n").filter((l) => l.length > 0).length - 1 : null);
}

/** `forge` for bytes built outside the JavaScript heap (a large table), with the record count the caller knows. */
export function forgeBytes(files: Map<string, Uint8Array>, path: string, bytes: Uint8Array, rowCount: number | null): void {
  files.set(path, bytes);
  const manifest = manifestOf(files);
  const entry = manifest.artifacts.find((a) => a["path"] === path);
  if (entry === undefined) throw new Error(`no manifest entry for ${path}`);
  entry["byteLength"] = bytes.byteLength;
  entry["sha256"] = createHash("sha256").update(bytes).digest("hex");
  if (rowCount !== null) entry["rowCount"] = rowCount;
  writeManifest(files, manifest);
}

export function fileText(files: Map<string, Uint8Array>, path: string): string {
  return text(files.get(path) as Uint8Array);
}

// Independent oracles. manifestSha256: the core's own acceptance.json. packageDigest: a separate Python implementation of the
// core's `kauro-package-digest/1` definition run over the fixture directories. Rows: the core's acceptance/README.md table.
export const ORACLE: Record<CaseName, { manifestSha256: string; packageDigest: string; files: number; sourceRows: number; delivered: number; merged: number; isolated: number; edgesDelivered: number; leftover: number }> = {
  "A-clean-multi-object": { manifestSha256: "69a35b99f6e033d1375ccc0f268adf8d92e09d4c54daf57d2a91a6804bdd985e", packageDigest: "37f98cce23e43a71ad24922ade889f877465e40000bcb00b54d875bbc7ff950a", files: 30, sourceRows: 19, delivered: 15, merged: 0, isolated: 0, edgesDelivered: 12, leftover: 0 },
  "B-dirty-multinational": { manifestSha256: "20d35be70a587da2ae0cd5e7f65b1ab390eb4da1a794407139153155ba1142c4", packageDigest: "543b767d068a58b856f90968e308f943008b0fbbaa1fcb4e9dd12ee2f2f454e7", files: 23, sourceRows: 8, delivered: 8, merged: 0, isolated: 0, edgesDelivered: 0, leftover: 0 },
  "C-identity-adversarial": { manifestSha256: "daca27c3d715ad187612d04321cb87d84cda1fbbae3f34aad128d8f4185754aa", packageDigest: "bb1b68fd4d1b47167fea9e5a9ee4ab0c2ac75f5d7d186b02aa231f783129efb9", files: 22, sourceRows: 10, delivered: 3, merged: 2, isolated: 5, edgesDelivered: 0, leftover: 0 },
  "D-hubspot": { manifestSha256: "6177cda1ce9bacc728b25bb38a7250321a3615cd6dc6818b2cea623b4be82241", packageDigest: "ceab42f60701016c4a67aa6cce82555e36d90a03b767e5f064418d91a0590dd4", files: 28, sourceRows: 16, delivered: 12, merged: 0, isolated: 0, edgesDelivered: 12, leftover: 0 },
  "D-salesforce": { manifestSha256: "46d9e077930d8dbbf73f934e43d5d6d788423f6683e07307e17adbf7bafb43c4", packageDigest: "232f775956d7d61c2c5e38639a2465c4484b58b8a84f7bb23b7461389c1471ce", files: 30, sourceRows: 19, delivered: 15, merged: 0, isolated: 0, edgesDelivered: 8, leftover: 4 },
};

export const TERMS_SHA256 = "7".repeat(64);

/** Facts for a report over `name`, bound to the core's own manifest hash for it (the platform record the tests stand in for). */
export function facts(name: CaseName, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reportId: "rpt-0001",
    packageId: "pkg-0001",
    expectedManifestSha256: ORACLE[name].manifestSha256,
    privacyClass: "SECURE_DETAIL",
    billableSourceUnits: 17,
    quoteId: "q-0001",
    branding: { version: "brand-3", displayName: "Northwind Data Partners", logo: null },
    termsVersion: "terms-2026-10-01",
    termsSha256: TERMS_SHA256,
    issuer: { legalName: "Kauro Data S.A.S.", jurisdiction: "Colombia", registrationId: "NIT-PENDING-OWNER" },
    findingIds: ["F-1", "F-2"],
    materialDecisionIds: ["D-1"],
    rendererVersion: "renderer-1.0.0",
    declaredCounts: null,
    ...overrides,
  };
}

/** Rows of a fixture CSV as objects (test-only reader; RFC 4180 via the package's own parser is deliberately not used here). */
export function rowsOf(files: Map<string, Uint8Array>, path: string): Record<string, string>[] {
  const lines = fileText(files, path).split("\n").filter((l) => l.length > 0);
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i] as string;
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0] as string);
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [header[i], v])));
}
