/**
 * The report as one self-contained HTML document (design docs/design/B13-report-html.md). The worker prints this document to
 * PDF; this module renders nothing else and fetches nothing.
 *
 * - Inert (S069): no script, no event handler, no inline style attribute, no URL; one <style> element and a CSP meta that forbids
 *   everything but that style and a data: image. Every string is escaped for text or attribute context; free text (the agency's
 *   file names) is isolated in <bdi>. The logo is embedded only when its bytes are the stored logo the branding names (SHA-256,
 *   PNG/JPEG signature, size and pixel limits), never fetched.
 * - Printed, not recounted (R2-065, R2-071): every number is a model figure; exception tables are listed with their complete totals
 *   and the full rows stay in the package files.
 * - Print layout (S070): @page Letter or A4, repeating table headers, rows that do not split, hashes and paths that wrap.
 * - Deterministic: the same model, page size, locale and logo give the same bytes; no clock, no randomness.
 */
import { createHash } from "node:crypto";
import { copyText } from "./copy.js";
import type { CopyKey } from "./copy.js";
import type { Figure, ImportStep, ReportArtifact, VerifiedReport } from "./model.js";
import { OBJECT_ORDER } from "./package.js";
import { ReportModelError } from "./problems.js";

export type PageSize = "LETTER" | "A4";

export interface RenderOptions {
  readonly pageSize: PageSize;
  /** A locale of the copy catalog; anything else renders in English. */
  readonly locale: string;
  /** The stored logo's bytes when the branding names a logo; null otherwise. */
  readonly logo: Uint8Array | null;
}

export interface RenderedReport {
  readonly html: string;
  readonly sha256: string;
}

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_PIXELS = 2048;

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Escapes for both text and double-quoted attribute context. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function logoDimensions(bytes: Uint8Array, mediaType: "image/png" | "image/jpeg"): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mediaType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || !signature.every((b, i) => bytes[i] === b)) return null;
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: SOI, then segments until a start-of-frame marker carries the dimensions.
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] as number;
    const length = view.getUint16(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

function checkedLogo(report: VerifiedReport, bytes: Uint8Array | null): string | null {
  const declared = report.model.branding.logo;
  const refuse = (detail: string): never => {
    throw new ReportModelError([{ code: "BRANDING_UNSAFE", subject: "logo", detail }]);
  };
  if (declared === null) {
    if (bytes !== null) refuse("logo bytes were given for a branding that names no logo");
    return null;
  }
  if (bytes === null) return refuse("the branding names a logo but its bytes were not given");
  if (bytes.byteLength > LOGO_MAX_BYTES) refuse(`the logo is larger than ${LOGO_MAX_BYTES} bytes`);
  if (sha256(bytes) !== declared.sha256) refuse("the logo bytes are not the stored logo the branding names");
  const size = logoDimensions(bytes, declared.mediaType);
  if (size === null) refuse(`the logo is not a ${declared.mediaType} image`);
  else if (size.width < 1 || size.height < 1 || size.width > LOGO_MAX_PIXELS || size.height > LOGO_MAX_PIXELS) refuse(`the logo is outside 1..${LOGO_MAX_PIXELS} pixels a side`);
  return `data:${declared.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

const STYLE = (page: string): string =>
  [
    `@page { size: ${page}; margin: 18mm 16mm; }`,
    "html { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #111; }",
    "h1 { font-size: 18pt; margin: 0 0 4pt; } h2 { font-size: 13pt; margin: 14pt 0 6pt; break-after: avoid; }",
    "table { width: 100%; border-collapse: collapse; margin: 0 0 8pt; }",
    "thead { display: table-header-group; }",
    "tr { break-inside: avoid; }",
    "th, td { border: 0.5pt solid #999; padding: 3pt 4pt; text-align: left; vertical-align: top; }",
    "td.n { text-align: right; font-variant-numeric: tabular-nums; }",
    ".h, .p { font-family: Courier, monospace; font-size: 8pt; overflow-wrap: anywhere; }",
    ".notice { border: 1pt solid #a60; padding: 6pt; margin: 6pt 0; }",
    ".logo { max-height: 18mm; max-width: 60mm; }",
    "ol.guide li { break-inside: avoid; margin: 0 0 6pt; }",
    "footer { margin-top: 14pt; font-size: 8pt; overflow-wrap: anywhere; }",
  ].join("\n");

export function renderReportHtml(report: VerifiedReport, options: RenderOptions): RenderedReport {
  const m = report.model;
  const locale = options.locale;
  const t = (key: CopyKey, values: Readonly<Record<string, string>> = {}): string => escapeHtml(copyText(locale, key, values));
  const n = (f: Figure): string => f.value.toLocaleString("en-US");
  const logo = checkedLogo(report, options.logo);
  const out: string[] = [];

  out.push("<!DOCTYPE html>", '<html lang="en-US">', "<head>", '<meta charset="utf-8">');
  out.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`);
  out.push(`<title>${t("doc.title")}</title>`, `<style>\n${STYLE(options.pageSize === "A4" ? "A4" : "letter")}\n</style>`, "</head>", "<body>");

  out.push("<header>");
  if (logo !== null) out.push(`<img class="logo" alt="${escapeHtml(m.branding.displayName)}" src="${logo}">`);
  out.push(`<h1>${t("doc.title")}</h1>`);
  out.push(`<p>${t("doc.preparedFor", { brand: m.branding.displayName })}</p>`);
  out.push(`<p>${t("doc.issuer", { legalName: m.issuer.legalName, jurisdiction: m.issuer.jurisdiction, registrationId: m.issuer.registrationId, termsVersion: m.termsVersion })}</p>`);
  out.push(`<p>${t("doc.status")}</p>`, "</header>");

  // counts: the three denominators first (R2-065), every measure with its definition
  out.push("<section>", `<h2>${t("counts.heading")}</h2>`);
  if (m.countsBinding === "UNBOUND") out.push(`<p class="notice">${t("counts.unbound")}</p>`);
  out.push(`<table><thead><tr><th>${t("table.measure")}</th><th>${t("table.count")}</th><th>${t("table.definition")}</th></tr></thead><tbody>`);
  const order = ["physicalSourceRows", "billableSourceUnits", "emittedArtifactRows", "logicalSourceRecords", "emittedRepresentatives", "mergedNonSurvivors", "withheld", "rejected", "unresolved", "associationEdges"] as const;
  for (const key of order)
    out.push(`<tr><td>${t(`counts.${key}`)}</td><td class="n" data-figure="${key}">${n(m.counts[key])}</td><td>${t(`counts.${key}.definition`)}</td></tr>`);
  out.push("</tbody></table>");
  out.push(`<h2>${t("objects.heading")}</h2>`, `<table><thead><tr><th>${t("table.object")}</th><th>${t("table.records")}</th></tr></thead><tbody>`);
  for (const object of OBJECT_ORDER) out.push(`<tr><td>${object}</td><td class="n" data-figure="deliveredByObject.${object}">${n(m.deliveredByObject[object])}</td></tr>`);
  out.push("</tbody></table>");
  out.push(`<h2>${t("relationships.heading")}</h2>`, `<table><thead><tr><th>${t("table.measure")}</th><th>${t("table.count")}</th></tr></thead><tbody>`);
  for (const key of ["delivered", "leftover", "unresolved", "deduplicated"] as const)
    out.push(`<tr><td>${t(`relationships.${key}`)}</td><td class="n" data-figure="relationships.${key}">${n(m.relationships[key])}</td></tr>`);
  out.push("</tbody></table>", "</section>");

  // import guide (R2-069)
  const familyOf = (s: ImportStep): string => s.path.replace(/-[0-9]{3}\.csv$/, ".csv");
  out.push("<section>", `<h2>${t("guide.heading")}</h2>`, `<p>${t("guide.onlyImport")}</p>`, '<ol class="guide">');
  for (const s of m.importGuide) {
    const parts = m.importGuide.filter((x) => familyOf(x) === familyOf(s)).length;
    out.push(`<li data-step="${s.order}" data-path="${escapeHtml(s.path)}">`);
    out.push(`<div class="p">${escapeHtml(s.path)}</div>`);
    if (s.object !== null) out.push(`<div>${t("guide.object", { object: s.object })}</div>`);
    if (s.association !== null) out.push(`<div>${t("guide.association", { from: s.association.from, to: s.association.to })}</div>`);
    if (s.part !== null) out.push(`<div>${t("guide.part", { part: String(s.part), parts: String(parts) })}</div>`);
    out.push(`<div>${t("guide.records")} <span data-records="${escapeHtml(s.path)}">${n(s.records)}</span></div>`);
    out.push(`<div class="h">${t("guide.sha256", { sha256: s.sha256 })}</div>`, "</li>");
  }
  out.push("</ol>", "</section>");

  // exceptions (R2-071): complete totals, rows stay in the package
  const artifactRows = (list: readonly ReportArtifact[]): void => {
    out.push(`<table><thead><tr><th>${t("table.file")}</th><th>${t("table.use")}</th><th>${t("table.records")}</th><th>${t("table.sha256")}</th></tr></thead><tbody>`);
    for (const a of list)
      out.push(
        `<tr data-artifact="${escapeHtml(a.path)}" data-use="${a.use}"><td class="p">${escapeHtml(a.path)}</td><td>${t(`artifacts.use.${a.use}`)}</td><td class="n" data-records="${escapeHtml(a.path)}">${a.records === null ? "" : n(a.records)}</td><td class="h">${a.sha256}</td></tr>`,
      );
    out.push("</tbody></table>");
  };
  out.push("<section>", `<h2>${t("exceptions.heading")}</h2>`, `<p>${t("exceptions.note")}</p>`);
  artifactRows(m.exceptions);
  out.push("</section>", "<section>", `<h2>${t("artifacts.heading")}</h2>`);
  artifactRows(m.artifacts.filter((a) => !a.path.startsWith("02_EXCEPTIONS/")));
  out.push("</section>");

  // lineage: source files; the agency's file names only where the privacy class allows, as isolated text
  out.push("<section>", `<h2>${t("lineage.heading")}</h2>`, `<table><thead><tr><th>${t("table.file")}</th><th>${t("lineage.rows")}</th><th>${t("table.sha256")}</th></tr></thead><tbody>`);
  for (const i of m.lineage.inputs)
    out.push(`<tr><td class="p">${i.fileId}${i.fileName === null ? "" : ` <bdi>${escapeHtml(i.fileName.untrusted)}</bdi>`}</td><td class="n">${n(i.dataRows)}</td><td class="h">${i.sha256}</td></tr>`);
  out.push("</tbody></table>", "</section>");

  out.push(`<footer>${t("footer.identity", { packageDigest: m.package.packageDigest, manifestSha256: m.package.manifestSha256, coreVersion: m.package.coreVersion, modelHash: report.modelHash, rendererVersion: m.rendererVersion })}</footer>`);
  out.push("</body>", "</html>", "");
  const html = out.join("\n");
  return { html, sha256: sha256(html) };
}
