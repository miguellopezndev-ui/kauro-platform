// Synthetic Migration Core 3.1.0 acceptance packages for the report-PDF tests. They are read, byte for byte, from the fixtures
// B13 already owns (packages/reports/test/fixtures/mc-3.1.0, by path: no import crosses the package boundary). No customer data.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReportModel, readMigrationPackage } from "@kauro/reports";
import type { VerifiedReport } from "@kauro/reports";

/** E-rejected-rows: the core's package with rows it could not read and rows no mapping covers (reports mc-3.1.0-rejected/PROVENANCE.json). */
export type CaseName = "A-clean-multi-object" | "D-salesforce" | "E-rejected-rows";
// compiled to dist/test/support: four levels up is packages/data-plane/.., i.e. packages/
const root = fileURLToPath(new URL("../../../../reports/test/fixtures/", import.meta.url));
const dirOf = (name: CaseName): string => (name === "E-rejected-rows" ? join(root, "mc-3.1.0-rejected", name, "package") : join(root, "mc-3.1.0", name));

export function loadPackage(name: CaseName): Map<string, Uint8Array> {
  const dir = dirOf(name);
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

export function reportOf(name: CaseName, overrides: Record<string, unknown> = {}): VerifiedReport {
  const files = loadPackage(name);
  const manifest = files.get("manifest.json") as Uint8Array;
  const facts = {
    reportId: "rpt-0001",
    packageId: "pkg-0001",
    expectedManifestSha256: createHash("sha256").update(manifest).digest("hex"),
    privacyClass: "SECURE_DETAIL",
    billableSourceUnits: 17,
    quoteId: "q-0001",
    branding: { version: "brand-3", displayName: "Northwind Data Partners", logo: null },
    termsVersion: "terms-2026-10-01",
    termsSha256: "7".repeat(64),
    issuer: { legalName: "Kauro Data S.A.S.", jurisdiction: "Colombia", registrationId: "NIT-PENDING-OWNER" },
    findingIds: ["F-1", "F-2"],
    materialDecisionIds: ["D-1"],
    rendererVersion: "renderer-1.0.0",
    declaredCounts: null,
    ...overrides,
  };
  return buildReportModel(readMigrationPackage(loadPackage(name)), facts);
}
