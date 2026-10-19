/**
 * The report as one self-contained HTML document (design docs/design/B13-report-html.md). The worker prints this document to
 * PDF; this module renders nothing else and fetches nothing.
 *
 * - Inert (S069): no script, no event handler, no inline style attribute, and no URL other than embedded `data:` resources: the
 *   logo's image and the pinned faces (fonts.ts); one <style> element and a CSP meta that forbids everything but that style, data:
 *   images and data: fonts. Every string is escaped for text or attribute context; free text (the agency's
 *   file names) is isolated in <bdi>. The logo is embedded only when its bytes are the stored logo the branding names (SHA-256,
 *   PNG/JPEG signature, size and pixel limits), never fetched.
 * - Printed, not recounted (R2-065, R2-071): every number is a model figure; exception tables are listed with their complete totals
 *   and the full rows stay in the package files.
 * - Print layout (S070): @page Letter or A4, repeating table headers, rows that do not split, hashes and paths that wrap.
 * - Deterministic: the same model, page size, locale and logo give the same bytes; no clock, no randomness. The only read is of the
 *   pinned font files this package ships (fonts.ts).
 */
import { createHash } from "node:crypto";
import { copyText, resolveLocale } from "./copy.js";
import { fontFaceRules } from "./fonts.js";
import type { CopyKey } from "./copy.js";
import { isVerifiedReport } from "./model.js";
import type { Figure, ReportArtifact, ReportModel, VerifiedReport } from "./model.js";
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

/**
 * The layout of the report (template 2, owner-approved on 2026-10-18; docs/design/REPORT-REDESIGN-PROPOSAL.md and the documentary criteria
 * in docs/design/KAURO_VISUAL_IDENTITY.md). The agency's logo or name leads the cover and Kauro is the issuer line only (R2-070). Inter for
 * the text and JetBrains Mono for paths, hashes and numbering, embedded as data: fonts. The Kauro palette is used by context: carbon text,
 * porcelain panels and table bands, wine for the verdict, the numbering and the source rows total, a clay tint for the counts notice.
 * Contextual alternates are off: their glyphs do not survive text extraction from the PDF.
 */
export const REPORT_TEMPLATE = "kauro-report-template/2";

const CARBON = "#242426";
const MUTED = "#5e5853";
const QUIET = "#77706a";
const PORCELAIN = "#f8f6f3";
const WINE = "#653a46";
const CLAY_TINT = "#f1e9e2";
const SANS = '"Inter", sans-serif';
const MONO = '"JetBrains Mono", monospace';

/** A CSS string literal for catalogue text (the page footer): every character outside a plain set is a CSS escape. */
const cssString = (text: string): string => `"${text.replace(/[^A-Za-z0-9 .,:;()-]/g, (c) => `\\${(c.codePointAt(0) as number).toString(16)} `)}"`;

/** "Page {page} of {pages}" as CSS content: the catalogue's words around the page counters. */
function pageNumberContent(template: string): string {
  return template
    .split(/(\{page\}|\{pages\})/)
    .filter((part) => part !== "")
    .map((part) => (part === "{page}" ? "counter(page)" : part === "{pages}" ? "counter(pages)" : cssString(part)))
    .join(" ");
}

const STYLE = (page: string, title: string, pageNumber: string): string =>
  [
    fontFaceRules(),
    `@page { size: ${page}; margin: 17mm 17mm 19mm;`,
    `  @bottom-left { content: ${cssString(title)}; font: 400 7pt ${SANS}; color: ${QUIET}; vertical-align: top; padding-top: 5mm; }`,
    `  @bottom-right { content: ${pageNumberContent(pageNumber)}; font: 400 7pt ${SANS}; color: ${QUIET}; vertical-align: top; padding-top: 5mm; } }`,
    `html { font-family: ${SANS}; font-size: 8.75pt; line-height: 1.5; color: ${CARBON}; font-variant-ligatures: no-contextual; font-feature-settings: "calt" 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`,
    "body { margin: 0; counter-reset: section; }",
    "p { margin: 0; }",
    `.p, .h { font-family: ${MONO}; }`,
    // the cover: the agency's brand, the verdict, the title and status, who prepared it and who provides the service
    "header.cover { margin: 0 0 7mm; }",
    ".brand { display: flex; align-items: center; min-height: 14mm; margin: 0 0 9mm; }",
    ".logo { display: block; max-height: 14mm; max-width: 62mm; object-fit: contain; object-position: left center; }",
    ".wordmark { font-size: 15pt; font-weight: 650; letter-spacing: -0.015em; }",
    `.verdict { margin: 0 0 3mm; color: ${WINE}; font-size: 7.5pt; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }`,
    "h1 { margin: 0 0 3.5mm; font-size: 29pt; font-weight: 650; letter-spacing: -0.028em; line-height: 1.05; }",
    `.status { max-width: 132mm; color: ${MUTED}; font-size: 11.5pt; line-height: 1.45; }`,
    ".attribution { display: flex; flex-direction: column; gap: 0.8mm; margin-top: 5mm; font-size: 7.75pt; }",
    ".attribution .prepared { font-weight: 600; }",
    `.attribution .issuer { color: ${MUTED}; }`,
    // at a glance: the three denominators first (R2-065) and the rows unified with approval; an unbound notice closes the panel
    `section.glance { margin: 0 0 8mm; padding: 4.5mm 6mm 5mm; overflow: hidden; border-radius: 2mm; background: ${PORCELAIN}; break-inside: avoid; }`,
    `.label { margin: 0 0 3.5mm; color: ${MUTED}; font-size: 6.75pt; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; }`,
    "dl.figures { display: grid; grid-template-columns: repeat(4, 1fr); column-gap: 6mm; margin: 0; }",
    `dl.figures dt { color: ${MUTED}; font-size: 7.5pt; line-height: 1.3; }`,
    'dl.figures dd { margin: 1mm 0 0; font-size: 24pt; font-weight: 300; letter-spacing: -0.03em; line-height: 1; font-feature-settings: "tnum"; }',
    `.notice { margin: 4.5mm -6mm -5mm; padding: 2.6mm 6mm; background: ${CLAY_TINT}; color: ${CARBON}; font-size: 7.75pt; }`,
    // numbered sections
    "h2 { counter-increment: section; display: flex; align-items: baseline; gap: 3mm; margin: 10mm 0 3.5mm; font-size: 12.5pt; font-weight: 650; letter-spacing: -0.012em; break-after: avoid; }",
    `h2::before { content: counter(section, decimal-leading-zero); color: ${WINE}; font-family: ${MONO}; font-size: 7.5pt; font-weight: 500; }`,
    "section.first > h2 { margin-top: 0; }",
    `.lead { max-width: 150mm; margin: 0 0 4mm; color: ${MUTED}; }`,
    `.lead .use { color: ${CARBON}; font-weight: 600; }`,
    ".instruction { max-width: 150mm; margin: 0 0 4.5mm; font-size: 10pt; font-weight: 500; line-height: 1.45; }",
    ".measures { break-inside: avoid; }",
    ".measures .label { margin: 6mm 0 2.5mm; }",
    // tables: one rule under the head, quiet bands instead of lines
    "table { width: 100%; border-collapse: collapse; margin: 0; table-layout: fixed; }",
    "thead { display: table-header-group; }",
    "tr { break-inside: avoid; }",
    `th { padding: 0 2.2mm 1.6mm; border-bottom: 0.75pt solid ${CARBON}; color: ${MUTED}; font-size: 6.5pt; font-weight: 600; letter-spacing: 0.08em; text-align: left; text-transform: uppercase; vertical-align: bottom; }`,
    "td { padding: 1.3mm 2.2mm; text-align: left; vertical-align: top; }",
    `tbody tr:nth-child(even) td { background: ${PORCELAIN}; }`,
    "td.k { font-weight: 550; }",
    "th.n, td.n { text-align: right; }",
    'td.n { font-size: 9pt; font-weight: 500; font-feature-settings: "tnum"; white-space: nowrap; }',
    `td.def { color: ${MUTED}; font-size: 7.75pt; }`,
    "td.p { font-size: 6.9pt; font-weight: 500; overflow-wrap: break-word; }",
    ".seg { white-space: nowrap; }",
    `.dir { color: ${QUIET}; font-weight: 400; }`,
    `td.h { color: ${MUTED}; font-size: 6.1pt; line-height: 1.45; overflow-wrap: anywhere; }`,
    `tr.none td { color: ${QUIET}; } tr.none td.p { font-weight: 400; }`,
    `td.p .otheruse { display: block; margin-top: 0.5mm; color: ${MUTED}; font-family: ${SANS}; font-size: 7.25pt; font-weight: 400; }`,
    `bdi { font-family: ${SANS}; font-weight: 400; color: ${MUTED}; }`,
    // the source rows as the total of their outcomes, under one rule
    `tr.total td { padding-top: 2mm; border-top: 0.75pt solid ${CARBON}; background: none; }`,
    `tr.total td.k, tr.total td.n { font-weight: 650; } tr.total td.n { color: ${WINE}; font-size: 10pt; }`,
    "col.c1 { width: 27%; } col.c2 { width: 9%; }",
    // two short tables side by side, headings on one line and tables on the next
    ".pair { display: grid; grid-template-columns: 1fr 1fr; column-gap: 10mm; margin-top: 10mm; break-inside: avoid; }",
    ".pair > h2 { margin-top: 0; align-self: end; }",
    ".pair > h2:nth-of-type(1), .pair > table:nth-of-type(1) { grid-column: 1; } .pair > h2:nth-of-type(2), .pair > table:nth-of-type(2) { grid-column: 2; }",
    ".pair > h2 { grid-row: 1; } .pair > table { grid-row: 2; table-layout: auto; }",
    // the import guide: numbered steps on quiet bands; the file and what to expect, and its hash beside them
    "ol.guide { margin: 0; padding: 0; list-style: none; counter-reset: step; }",
    "ol.guide li { display: grid; grid-template-columns: 8mm 1fr 58mm; column-gap: 4mm; padding: 2mm 2.2mm; break-inside: avoid; counter-increment: step; }",
    `ol.guide li:nth-child(even) { background: ${PORCELAIN}; }`,
    `ol.guide li::before { content: counter(step, decimal-leading-zero); grid-row: 1 / 3; color: ${WINE}; font-family: ${MONO}; font-size: 8pt; font-weight: 500; line-height: 1.5; }`,
    "ol.guide .p { grid-column: 2; font-size: 7.6pt; font-weight: 500; overflow-wrap: break-word; }",
    `ol.guide .meta { grid-column: 2; margin-top: 0.6mm; color: ${MUTED}; font-size: 7.75pt; }`,
    `ol.guide .meta > span + span::before { content: "\\b7"; margin: 0 2mm; color: ${QUIET}; }`,
    `ol.guide .h { grid-column: 3; grid-row: 1 / 3; align-self: center; color: ${MUTED}; font-size: 6.1pt; line-height: 1.45; overflow-wrap: anywhere; }`,
    // tables of files
    "col.file { width: 41%; } col.use { width: 25%; } col.rec { width: 8%; }",
    "table.exceptions col.file { width: 55%; } table.exceptions col.rec { width: 11%; }",
    "table.lineage col.file { width: 46%; } table.lineage col.rec { width: 12%; }",
    // the evidence that closes the report
    `footer { margin-top: 11mm; padding: 4.5mm 5mm; border-radius: 2mm; background: ${PORCELAIN}; break-inside: avoid; }`,
    `footer p:last-child { color: ${MUTED}; font-family: ${MONO}; font-size: 6.6pt; line-height: 1.65; overflow-wrap: anywhere; }`,
  ].join("\n");

export function renderReportHtml(report: VerifiedReport, options: RenderOptions): RenderedReport {
  if (!isVerifiedReport(report)) throw new ReportModelError([{ code: "REPORT_UNVERIFIED", subject: "report", detail: "the report was not produced by buildReportModel" }]);
  const m = report.model;
  const locale = options.locale;
  const t = (key: CopyKey, values: Readonly<Record<string, string>> = {}): string => escapeHtml(copyText(locale, key, values));
  const n = (f: Figure): string => escapeHtml(f.value.toLocaleString("en-US"));
  const e = (v: string | number): string => escapeHtml(String(v));
  // a package path: its folders lighter than the file name, a line break allowed only after a slash
  const seg = (s: string): string => `<span class="seg">${escapeHtml(s)}</span>`;
  const path = (p: string): string => {
    const parts = p.split("/");
    const file = parts.pop() as string;
    return (parts.length > 0 ? `<span class="dir">${parts.map((d) => seg(`${d}/`)).join("<wbr>")}</span><wbr>` : "") + seg(file);
  };
  const logo = checkedLogo(report, options.logo);
  const out: string[] = [];

  out.push("<!DOCTYPE html>", `<html lang="${escapeHtml(resolveLocale(locale))}">`, "<head>", '<meta charset="utf-8">', `<meta name="generator" content="${REPORT_TEMPLATE}">`);
  out.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`);
  out.push(`<title>${t("doc.title")}</title>`, `<style>\n${STYLE(options.pageSize === "A4" ? "A4" : "letter", copyText(locale, "doc.title"), copyText(locale, "page.number", { page: "{page}", pages: "{pages}" }))}\n</style>`, "</head>", "<body>");

  // the cover: the agency's brand leads (its logo, or its name set as a wordmark, never a mark of Kauro); the issuer is a line of text (R2-070)
  out.push('<header class="cover">', '<div class="brand">');
  out.push(logo !== null ? `<img class="logo" alt="${escapeHtml(m.branding.displayName)}" src="${logo}">` : `<p class="wordmark">${escapeHtml(m.branding.displayName)}</p>`);
  out.push("</div>", `<p class="verdict">${t("doc.stamp")}</p>`, `<h1>${t("doc.title")}</h1>`, `<p class="status">${t("doc.status")}</p>`);
  out.push('<div class="attribution">', `<p class="prepared">${t("doc.preparedFor", { brand: m.branding.displayName })}</p>`);
  out.push(`<p class="issuer">${t("doc.issuer", { legalName: m.issuer.legalName, jurisdiction: m.issuer.jurisdiction, registrationId: m.issuer.registrationId, termsVersion: m.termsVersion })}</p>`, "</div>", "</header>");

  // at a glance, printed from the model (each figure is bound by its data-figure once, in the tables below)
  out.push('<section class="glance">', `<p class="label">${t("glance.heading")}</p>`, '<dl class="figures">');
  for (const key of ["physicalSourceRows", "billableSourceUnits", "emittedArtifactRows", "mergedNonSurvivors"] as const)
    out.push(`<div><dt>${t(`counts.${key}`)}</dt><dd>${n(m.counts[key])}</dd></div>`);
  out.push("</dl>");
  if (m.countsBinding === "UNBOUND") out.push(`<p class="notice">${t("counts.unbound")}</p>`);
  out.push("</section>");

  // counts, every measure with its definition (R2-065): the outcomes of the source rows over their total, then the other measures
  const row = (key: keyof ReportModel["counts"], cls = ""): string =>
    `<tr${cls === "" ? "" : ` class="${cls}"`}><td class="k">${t(`counts.${key}`)}</td><td class="n" data-figure="${e(key)}">${n(m.counts[key])}</td><td class="def">${t(`counts.${key}.definition`)}</td></tr>`;
  const countsHead = `<colgroup><col class="c1"><col class="c2"><col></colgroup><thead><tr><th>${t("table.measure")}</th><th class="n">${t("table.count")}</th><th>${t("table.definition")}</th></tr></thead>`;
  out.push('<section class="first">', `<h2>${t("rows.heading")}</h2>`, `<table class="ledger">${countsHead}<tbody>`);
  out.push(row("emittedRepresentatives"), row("mergedNonSurvivors"), row("withheld"), row("rejected"), row("physicalSourceRows", "total"), "</tbody></table>");
  out.push('<div class="measures">', `<p class="label">${t("rows.other")}</p>`, `<table>${countsHead}<tbody>`);
  for (const key of ["billableSourceUnits", "emittedArtifactRows", "logicalSourceRecords", "associationEdges", "unresolved"] as const) out.push(row(key));
  out.push("</tbody></table>", "</div>", "</section>");

  // records by object and relationships, side by side
  out.push('<div class="pair">', `<h2>${t("objects.heading")}</h2>`, `<h2>${t("relationships.heading")}</h2>`);
  out.push(`<table><thead><tr><th>${t("table.object")}</th><th class="n">${t("table.records")}</th></tr></thead><tbody>`);
  for (const object of OBJECT_ORDER) out.push(`<tr><td class="k">${e(object)}</td><td class="n" data-figure="deliveredByObject.${e(object)}">${n(m.deliveredByObject[object])}</td></tr>`);
  out.push("</tbody></table>", `<table><thead><tr><th>${t("table.measure")}</th><th class="n">${t("table.count")}</th></tr></thead><tbody>`);
  for (const key of ["delivered", "leftover", "unresolved", "deduplicated"] as const)
    out.push(`<tr><td class="k">${t(`relationships.${key}`)}</td><td class="n" data-figure="relationships.${key}">${n(m.relationships[key])}</td></tr>`);
  out.push("</tbody></table>", "</div>");

  // import guide (R2-069)
  out.push("<section>", `<h2>${t("guide.heading")}</h2>`, `<p class="instruction">${t("guide.onlyImport")}</p>`, '<ol class="guide">');
  for (const s of m.importGuide) {
    out.push(`<li data-step="${e(s.order)}" data-path="${escapeHtml(s.path)}">`, `<div class="p">${path(s.path)}</div>`, '<div class="meta">');
    if (s.object !== null) out.push(`<span>${t("guide.object", { object: s.object })}</span>`);
    if (s.association !== null) out.push(`<span>${t("guide.association", { from: s.association.from, to: s.association.to })}</span>`);
    if (s.part !== null && s.parts !== null) out.push(`<span>${t("guide.part", { part: String(s.part), parts: String(s.parts) })}</span>`);
    out.push(`<span>${t("guide.records")} <span data-records="${escapeHtml(s.path)}">${n(s.records)}</span></span>`, "</div>");
    out.push(`<div class="h">${t("guide.sha256", { sha256: s.sha256 })}</div>`, "</li>");
  }
  out.push("</ol>", "</section>");

  // exceptions (R2-071): complete totals, rows stay in the package. Their common use is said once; a file whose use differs says so under
  // its name; a file without rows is set back
  const records = (a: ReportArtifact): string => `<td class="n" data-records="${escapeHtml(a.path)}">${a.records === null ? "" : n(a.records)}</td>`;
  out.push("<section>", `<h2>${t("exceptions.heading")}</h2>`, `<p class="lead"><span class="use">${t("exceptions.use")}</span> ${t("exceptions.note")}</p>`);
  out.push(`<table class="exceptions"><colgroup><col class="file"><col class="rec"><col></colgroup><thead><tr><th>${t("table.file")}</th><th class="n">${t("table.records")}</th><th>${t("table.sha256")}</th></tr></thead><tbody>`);
  for (const a of m.exceptions) {
    const other = a.use === "EXCEPTION" ? "" : `<span class="otheruse">${t(`artifacts.use.${a.use}`)}</span>`;
    out.push(`<tr data-artifact="${escapeHtml(a.path)}" data-use="${e(a.use)}"${a.records?.value === 0 ? ' class="none"' : ""}><td class="p">${path(a.path)}${other}</td>${records(a)}<td class="h">${e(a.sha256)}</td></tr>`);
  }
  out.push("</tbody></table>", "</section>");

  // package contents
  out.push("<section>", `<h2>${t("artifacts.heading")}</h2>`);
  out.push(`<table><colgroup><col class="file"><col class="use"><col class="rec"><col></colgroup><thead><tr><th>${t("table.file")}</th><th>${t("table.use")}</th><th class="n">${t("table.records")}</th><th>${t("table.sha256")}</th></tr></thead><tbody>`);
  for (const a of m.artifacts.filter((x) => !x.path.startsWith("02_EXCEPTIONS/")))
    out.push(`<tr data-artifact="${escapeHtml(a.path)}" data-use="${e(a.use)}"><td class="p">${path(a.path)}</td><td class="def">${t(`artifacts.use.${a.use}`)}</td>${records(a)}<td class="h">${e(a.sha256)}</td></tr>`);
  out.push("</tbody></table>", "</section>");

  // lineage: source files; the agency's file names only where the privacy class allows, as isolated text
  out.push("<section>", `<h2>${t("lineage.heading")}</h2>`);
  out.push(`<table class="lineage"><colgroup><col class="file"><col class="rec"><col></colgroup><thead><tr><th>${t("table.file")}</th><th class="n">${t("lineage.rows")}</th><th>${t("table.sha256")}</th></tr></thead><tbody>`);
  for (const i of m.lineage.inputs)
    out.push(`<tr><td class="p">${e(i.fileId)}${i.fileName === null ? "" : ` <bdi>${escapeHtml(i.fileName.untrusted)}</bdi>`}</td><td class="n">${n(i.dataRows)}</td><td class="h">${e(i.sha256)}</td></tr>`);
  out.push("</tbody></table>", "</section>");

  out.push(`<footer><p class="label">${t("footer.heading")}</p><p>${t("footer.identity", { packageDigest: m.package.packageDigest, manifestSha256: m.package.manifestSha256, coreVersion: m.package.coreVersion, modelHash: report.modelHash, rendererVersion: m.rendererVersion })}</p></footer>`);
  out.push("</body>", "</html>", "");
  const html = out.join("\n");
  return { html, sha256: sha256(html) };
}
