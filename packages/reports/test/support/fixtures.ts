// Loads the byte-exact Migration Core 3.1.0 acceptance packages (test/fixtures/mc-3.1.0, PROVENANCE.json) and forges altered
// copies the way an adversary who can rewrite the manifest would: the altered file's length, SHA-256 and record count are
// re-declared, so the manifest's own sums still match (CMD039-DENY).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CASES = ["A-clean-multi-object", "B-dirty-multinational", "C-identity-adversarial", "D-hubspot", "D-salesforce"] as const;
export type CaseName = (typeof CASES)[number];

const root = fileURLToPath(new URL("../../../test/fixtures/mc-3.1.0/", import.meta.url));

export function loadPackage(name: CaseName): Map<string, Uint8Array> {
  return loadDirectory(join(root, name));
}

/** A package the vendored core 3.1.0 wrote with rows it could not read and rows no mapping covers (mc-3.1.0-rejected/PROVENANCE.json). */
export const REJECTED_CASE = {
  dir: fileURLToPath(new URL("../../../test/fixtures/mc-3.1.0-rejected/E-rejected-rows/package/", import.meta.url)),
  manifestSha256: "4c22b27f7033ad7c5feba79a45fddf11106b5da223431b757ff774391c8dd55f",
  packageDigest: "e422c95c7f16aeb32f0c22d8d11fc407c68684bbd6cd5a2815d67c3ff4c4de63",
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
  "A-clean-multi-object": { manifestSha256: "9979ff952e8d078c6c9f3b971dfb033f5d22dee1c7fb38e26162f47165f7b2ea", packageDigest: "36022380c955e6b3ae1f7a27e6ddd161ccfedce015fe201c9a1ae74348511683", files: 30, sourceRows: 19, delivered: 15, merged: 0, isolated: 0, edgesDelivered: 12, leftover: 0 },
  "B-dirty-multinational": { manifestSha256: "0ec16efddb489a54d8eafac50fff4a7a66dd3771db11bf9233751c9a5c427e2a", packageDigest: "94886637603d0cf505e0d789daee0fb5b8b45082b0b79a55c2eb18542c28d99e", files: 23, sourceRows: 8, delivered: 8, merged: 0, isolated: 0, edgesDelivered: 0, leftover: 0 },
  "C-identity-adversarial": { manifestSha256: "90dd6c430192485ba41456c138bc44418b702f4178de7aa158be75da5883c522", packageDigest: "530671eeb2c4e1fb6f86f16f86adc53af6c95671359aa3da3593ec4404d5cfe6", files: 22, sourceRows: 10, delivered: 3, merged: 2, isolated: 5, edgesDelivered: 0, leftover: 0 },
  "D-hubspot": { manifestSha256: "b3db3ade09ebcfe20ecf228ac94901a458d4e7af5c3f8c08d0d52d1c14bf8457", packageDigest: "a57b9f9401a6382b65b6f499743ea9cd8a235399f33802b5b21fa12c0183da06", files: 28, sourceRows: 16, delivered: 12, merged: 0, isolated: 0, edgesDelivered: 12, leftover: 0 },
  "D-salesforce": { manifestSha256: "c88a1306f8cbb5a5f344f3608e1a7f3769a53caa40d4cfa4c414f739e77f7a75", packageDigest: "280dab9ff34d386bfcd5e605f99b9fe572c197b2b6eeb5952e7dcde4de2c22e2", files: 30, sourceRows: 19, delivered: 15, merged: 0, isolated: 0, edgesDelivered: 8, leftover: 4 },
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
