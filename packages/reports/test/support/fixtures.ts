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
  const dir = join(root, name);
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
  const bytes = bytesOf(content);
  files.set(path, bytes);
  const manifest = manifestOf(files);
  const entry = manifest.artifacts.find((a) => a["path"] === path);
  if (entry === undefined) throw new Error(`no manifest entry for ${path}`);
  entry["byteLength"] = bytes.byteLength;
  entry["sha256"] = createHash("sha256").update(bytes).digest("hex");
  if (path.endsWith(".csv")) entry["rowCount"] = content.split("\n").filter((l) => l.length > 0).length - 1;
  writeManifest(files, manifest);
}

export function fileText(files: Map<string, Uint8Array>, path: string): string {
  return text(files.get(path) as Uint8Array);
}

export function facts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reportId: "rpt-0001",
    packageId: "pkg-0001",
    privacyClass: "SECURE_DETAIL",
    billableSourceUnits: 17,
    quoteId: "q-0001",
    branding: { version: "brand-3", displayName: "Northwind Data Partners", logo: null },
    termsVersion: "terms-2026-10-01",
    issuer: { legalName: "Kauro Data S.A.S.", jurisdiction: "Colombia", registrationId: "NIT-PENDING-OWNER" },
    findingIds: ["F-1", "F-2"],
    materialDecisionIds: ["D-1"],
    rendererVersion: "renderer-1.0.0",
    declaredCounts: null,
    ...overrides,
  };
}
