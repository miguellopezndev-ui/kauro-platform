// Run as a child process under a fixed V8 heap (report-rejected-rows.test.ts, F-32): reads one package directory into memory as the
// worker holds a staged package (bytes, outside the JavaScript heap), then readMigrationPackage -> buildReportModel -> renderReportHtml,
// and prints one JSON line. A heap the chain does not fit in ends the process with V8's out-of-memory failure, never a partial line.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getHeapStatistics } from "node:v8";
import { buildReportModel, readMigrationPackage, renderReportHtml } from "@kauro/reports";

const dir = process.argv[2] as string;
const files = new Map<string, Uint8Array>();
const walk = (d: string): void => {
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    const full = join(d, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.set(relative(dir, full).split(sep).join("/"), new Uint8Array(readFileSync(full)));
  }
};
walk(dir);
const packageBytes = [...files.values()].reduce((s, b) => s + b.byteLength, 0);
const pkg = readMigrationPackage(files);
const report = buildReportModel(pkg, {
  reportId: "rpt-volume",
  packageId: "pkg-volume",
  expectedManifestSha256: createHash("sha256").update(files.get("manifest.json") as Uint8Array).digest("hex"),
  privacyClass: "SECURE_DETAIL",
  billableSourceUnits: pkg.reconciliation.sourceRows.total,
  quoteId: "q-volume",
  branding: { version: "brand-1", displayName: "Volume", logo: null },
  termsVersion: "terms-volume",
  termsSha256: "7".repeat(64),
  issuer: { legalName: "Kauro Data S.A.S.", jurisdiction: "Colombia", registrationId: "NIT-PENDING-OWNER" },
  findingIds: [],
  materialDecisionIds: [],
  rendererVersion: "renderer-1.0.0",
  declaredCounts: null,
});
const html = renderReportHtml(report, { pageSize: "LETTER", locale: "en-US", logo: null });
process.stdout.write(
  `${JSON.stringify({ packageBytes, heapLimitBytes: getHeapStatistics().heap_size_limit, counts: report.snapshot.counts, modelHash: report.modelHash, htmlSha256: html.sha256, packageDigest: pkg.packageDigest })}\n`,
);
