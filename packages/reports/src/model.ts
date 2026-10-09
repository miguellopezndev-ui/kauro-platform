/**
 * The verified report model (B13; contract ReportSnapshot, owner 13: "Presentation cannot invent facts or expose raw data beyond
 * the chosen report class"). Design: docs/design/B13-report-model.md.
 *
 * Every figure the report shows is a `Figure`: a value together with the package file and the place in it the value was read
 * from. The renderers (HTML, PDF in the worker) print figures; they never add, subtract or recount (B13 "each figure comes from
 * the package and its manifest, never recalculated in the view"). The one figure that is not in the package, the billable source
 * units, comes from the frozen quote the platform hands in, and is shown beside — never instead of — the physical source rows and
 * the output rows (R2-065).
 *
 * The model is bound to the platform's record of the package (`expectedManifestSha256`), states whether its counts were bound to
 * the platform's own RowCounts (`countsBinding`), and is a frozen deep copy, so nothing a caller does after hashing changes it.
 * Every string in it is from a closed vocabulary or fenced text, except the agency's file names, typed `UntrustedText` (S069).
 */
import { DOMAINS, isSha256Hex, structuredDigest } from "@kauro/contracts";
import type { ReportSnapshot, RowCounts } from "@kauro/contracts";
import { isVerifiedPackage, LINEAGE_PATH, OBJECT_ORDER, RECONCILIATION_PATH } from "./package.js";
import type { ArtifactKind, CoreObject, PackageArtifact, UntrustedText, VerifiedPackage } from "./package.js";
import { Problems } from "./problems.js";

/** Version of this model's shape; a change to any field below changes it. */
export const REPORT_MODEL_VERSION = "2.0.0";

export interface FigureSource {
  /** The package file or area the value was read from (`input:quote` for the one platform fact). */
  readonly artifact: string;
  /** Where in it: a JSON pointer, or the selection of CSV records that were counted. */
  readonly locator: string;
}

export interface Figure {
  readonly value: number;
  readonly source: FigureSource;
}

export type PrivacyClass = ReportSnapshot["privacyClass"];

export interface Branding {
  readonly version: string;
  readonly displayName: string;
  /** A logo the platform already stored and checked (CMD008), named by its bytes; never a URL. */
  readonly logo: { readonly sha256: string; readonly mediaType: "image/png" | "image/jpeg" } | null;
}

export interface LegalIssuer {
  readonly legalName: string;
  readonly jurisdiction: string;
  readonly registrationId: string;
}

/** What the platform knows that the package does not. Closed: an unknown key is refused, so branding cannot smuggle an issuer. */
export interface PlatformFacts {
  readonly reportId: string;
  readonly packageId: string;
  /** The manifest SHA-256 the platform recorded for `packageId` when the package was accepted; the package must match it. */
  readonly expectedManifestSha256: string;
  readonly privacyClass: PrivacyClass;
  /** From the frozen quote the order captured; never derived from the package. */
  readonly billableSourceUnits: number;
  readonly quoteId: string;
  readonly branding: Branding;
  readonly termsVersion: string;
  /** SHA-256 of the terms document the issuer is read from (the model records it; it cannot read the terms itself). */
  readonly termsSha256: string;
  readonly issuer: LegalIssuer;
  readonly findingIds: readonly string[];
  readonly materialDecisionIds: readonly string[];
  readonly rendererVersion: string;
  /** The platform's RowCounts for this package (sealed-revision populations and the validation receipt), or null while none exist. */
  readonly declaredCounts: RowCounts | null;
}

/** BOUND: every count equals the platform's own RowCounts. UNBOUND: the platform supplied none, and the report must say so. */
export type CountsBinding = "BOUND" | "UNBOUND";

export type ArtifactUse = "IMPORT" | "EXCEPTION" | "TRACEABILITY" | "HUMAN_VIEW" | "DOCUMENT";

export interface ReportArtifact {
  readonly path: string;
  readonly kind: ArtifactKind;
  readonly use: ArtifactUse;
  readonly sha256: string;
  readonly byteLength: number;
  readonly records: Figure | null;
}

export interface ImportStep {
  readonly order: number;
  readonly path: string;
  readonly sha256: string;
  /** The destination object of a record file, or the two ends of an association file. */
  readonly object: CoreObject | null;
  readonly association: { readonly from: CoreObject; readonly to: CoreObject } | null;
  /** 1-based part number when the core cut the table into numbered parts, else null. */
  readonly part: number | null;
  /** How many parts that cut table has (the reader proved they are exactly 1..parts); null for an uncut table. */
  readonly parts: number | null;
  readonly records: Figure;
}

export interface ReportInput {
  readonly fileId: string;
  /** Present only in SECURE_DETAIL and INTERNAL_EVIDENCE reports. */
  readonly fileName: UntrustedText | null;
  readonly sha256: string;
  readonly byteLength: number;
  readonly dataRows: Figure;
}

export interface ReportModel {
  readonly modelVersion: string;
  readonly reportId: string;
  readonly packageId: string;
  readonly privacyClass: PrivacyClass;
  readonly countsBinding: CountsBinding;
  readonly package: {
    readonly packageDigest: string;
    readonly manifestSha256: string;
    readonly coreVersion: string;
    readonly packageFormat: string;
    readonly runId: string;
    readonly target: VerifiedPackage["target"];
  };
  readonly counts: { readonly [K in keyof RowCounts]: Figure };
  readonly deliveredByObject: { readonly [K in CoreObject]: Figure };
  readonly relationships: { readonly sourceEdges: Figure; readonly delivered: Figure; readonly leftover: Figure; readonly unresolved: Figure; readonly deduplicated: Figure };
  readonly artifacts: readonly ReportArtifact[];
  readonly importGuide: readonly ImportStep[];
  readonly exceptions: readonly ReportArtifact[];
  readonly lineage: { readonly artifact: string; readonly sha256: string; readonly rows: Figure; readonly inputs: readonly ReportInput[] };
  readonly issuer: LegalIssuer;
  readonly branding: Branding;
  readonly termsVersion: string;
  readonly termsSha256: string;
  readonly quoteId: string;
  readonly findingIds: readonly string[];
  readonly materialDecisionIds: readonly string[];
  readonly rendererVersion: string;
}

export interface VerifiedReport {
  readonly model: ReportModel;
  /** `structuredDigest(DOMAINS.REPORT_MODEL, 1, model)`: the renderer's exact input. */
  readonly modelHash: string;
  /** The registry ReportSnapshot (closed contract). Whether its counts are bound is in the model, under `modelHash`. */
  readonly snapshot: ReportSnapshot;
  readonly countsBinding: CountsBinding;
}

const fig = (value: number, artifact: string, locator: string): Figure => ({ value, source: { artifact, locator } });
const recon = (value: number, pointer: string): Figure => fig(value, RECONCILIATION_PATH, pointer);

/**
 * Refused in brand and issuer text (S069): controls (Cc), format characters (Cf: bidirectional controls, zero-width
 * characters, U+FEFF), line and paragraph separators (Zl, Zp), and the characters that change meaning in HTML text or an
 * attribute (`<`, `>`, `"`, `'`, `&`, `` ` ``). The renderer escapes everything anyway; this is the earlier of two fences.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"'&`]/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRIVACY_CLASSES: readonly PrivacyClass[] = ["AGENCY_SUMMARY", "SECURE_DETAIL", "INTERNAL_EVIDENCE"];
const FACT_KEYS = ["reportId", "packageId", "expectedManifestSha256", "privacyClass", "billableSourceUnits", "quoteId", "branding", "termsVersion", "termsSha256", "issuer", "findingIds", "materialDecisionIds", "rendererVersion", "declaredCounts"];
const ROW_COUNT_KEYS: readonly (keyof RowCounts)[] = [
  "physicalSourceRows",
  "logicalSourceRecords",
  "billableSourceUnits",
  "associationEdges",
  "emittedRepresentatives",
  "mergedNonSurvivors",
  "rejected",
  "withheld",
  "unresolved",
  "emittedArtifactRows",
];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const safeText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !UNSAFE_TEXT.test(v) && v === v.normalize("NFC");

function checkFacts(facts: unknown, problems: Problems): facts is PlatformFacts {
  if (!isObject(facts) || !exactKeys(facts, FACT_KEYS)) {
    problems.add("FACTS_MALFORMED", "facts", "platform facts are not the closed PlatformFacts object");
    return false;
  }
  const f = facts;
  for (const key of ["reportId", "packageId", "quoteId", "termsVersion", "rendererVersion"] as const) if (typeof f[key] !== "string" || !ID.test(f[key])) problems.add("FACTS_MALFORMED", key, "not an identifier");
  for (const key of ["expectedManifestSha256", "termsSha256"] as const) if (!isSha256Hex(f[key])) problems.add("FACTS_MALFORMED", key, "not a SHA-256");
  if (!PRIVACY_CLASSES.includes(f["privacyClass"] as PrivacyClass)) problems.add("FACTS_MALFORMED", "privacyClass", "unknown privacy class");
  const units = f["billableSourceUnits"];
  if (typeof units !== "number" || !Number.isSafeInteger(units) || units < 0) problems.add("FACTS_MALFORMED", "billableSourceUnits", "not a non-negative integer");
  for (const key of ["findingIds", "materialDecisionIds"] as const) {
    const list = f[key];
    if (!Array.isArray(list) || !list.every((id) => typeof id === "string" && ID.test(id)) || new Set(list).size !== list.length) problems.add("FACTS_MALFORMED", key, "not a list of distinct identifiers");
  }
  const branding = f["branding"];
  if (!isObject(branding) || !exactKeys(branding, ["version", "displayName", "logo"])) problems.add("FACTS_MALFORMED", "branding", "branding is not the closed Branding object");
  else {
    if (typeof branding["version"] !== "string" || !ID.test(branding["version"])) problems.add("FACTS_MALFORMED", "branding.version", "not an identifier");
    if (!safeText(branding["displayName"], 120)) problems.add("BRANDING_UNSAFE", "branding.displayName", "empty, too long, not NFC, or holds a control, format, separator or markup-significant character");
    const logo = branding["logo"];
    if (logo !== null && (!isObject(logo) || !exactKeys(logo, ["sha256", "mediaType"]) || !isSha256Hex(logo["sha256"]) || (logo["mediaType"] !== "image/png" && logo["mediaType"] !== "image/jpeg")))
      problems.add("BRANDING_UNSAFE", "branding.logo", "a logo is a stored PNG or JPEG named by its SHA-256, never a URL or SVG");
  }
  const issuer = f["issuer"];
  if (!isObject(issuer) || !exactKeys(issuer, ["legalName", "jurisdiction", "registrationId"]) || !safeText(issuer["legalName"], 200) || !safeText(issuer["jurisdiction"], 100) || !safeText(issuer["registrationId"], 100))
    problems.add("FACTS_MALFORMED", "issuer", "the issuer is not a complete, safe legal identity");
  const declared = f["declaredCounts"];
  if (declared !== null && (!isObject(declared) || !exactKeys(declared, ROW_COUNT_KEYS) || !ROW_COUNT_KEYS.every((k) => Number.isSafeInteger(declared[k]) && (declared[k] as number) >= 0)))
    problems.add("FACTS_MALFORMED", "declaredCounts", "not a complete RowCounts");
  return problems.list.length === 0;
}

function useOf(artifact: PackageArtifact): ArtifactUse {
  switch (artifact.kind) {
    case "MACHINE_IMPORT_CSV":
      return "IMPORT";
    case "MACHINE_EXCEPTION_CSV":
      return "EXCEPTION";
    case "MACHINE_EVIDENCE_CSV":
      return "TRACEABILITY";
    case "HUMAN_VIEW_CSV":
      return "HUMAN_VIEW";
    case "DOCUMENT":
      return "DOCUMENT";
  }
}

function importGuide(pkg: VerifiedPackage): ImportStep[] {
  const imports = pkg.artifacts.filter((a) => a.kind === "MACHINE_IMPORT_CSV");
  const fileOf = (path: string) => (Object.hasOwn(pkg.importFiles, path) ? pkg.importFiles[path] : undefined);
  const familyOf = (path: string): string => path.replace(/-[0-9]{3}\.csv$/, ".csv");
  const objectOf = (path: string): CoreObject | null => (Object.hasOwn(pkg.importFiles, path) ? pkg.importFiles[path]?.object : null) ?? null;
  const records = imports
    .filter((a) => objectOf(a.path) !== null)
    .sort((a, b) => {
      const byObject = OBJECT_ORDER.indexOf(objectOf(a.path) as CoreObject) - OBJECT_ORDER.indexOf(objectOf(b.path) as CoreObject);
      if (byObject !== 0) return byObject;
      if (familyOf(a.path) !== familyOf(b.path)) return familyOf(a.path) < familyOf(b.path) ? -1 : 1;
      return (fileOf(a.path)?.part?.part ?? 0) - (fileOf(b.path)?.part?.part ?? 0);
    });
  const edges = imports
    .filter((a) => objectOf(a.path) === null)
    .sort((a, b) => (familyOf(a.path) !== familyOf(b.path) ? (familyOf(a.path) < familyOf(b.path) ? -1 : 1) : (fileOf(a.path)?.part?.part ?? 0) - (fileOf(b.path)?.part?.part ?? 0)));
  return [...records, ...edges].map((a, index) => ({
    order: index + 1,
    path: a.path,
    sha256: a.sha256,
    object: objectOf(a.path),
    association: (Object.hasOwn(pkg.importFiles, a.path) ? pkg.importFiles[a.path]?.association : null) ?? null,
    part: fileOf(a.path)?.part?.part ?? null,
    parts: fileOf(a.path)?.part?.of ?? null,
    records: fig(a.rowCount ?? 0, a.path, "records excluding the header"),
  }));
}

/** The reports this module built. `renderReportHtml` refuses any other object, however well it is shaped (review PR21-2). */
const VERIFIED_REPORTS = new WeakSet<object>();
export function isVerifiedReport(value: unknown): value is VerifiedReport {
  return typeof value === "object" && value !== null && VERIFIED_REPORTS.has(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds the model, or refuses with every problem found. `pkg` must come from `readMigrationPackage` (a look-alike object is
 * refused); `facts` is taken as `unknown` because it crosses a trust boundary (database rows and a stored branding version) and
 * is checked as a closed object here.
 */
export function buildReportModel(pkg: VerifiedPackage, facts: unknown): VerifiedReport {
  const problems = new Problems();
  if (!isVerifiedPackage(pkg)) {
    problems.add("PACKAGE_UNVERIFIED", "pkg", "the package was not produced by readMigrationPackage");
    problems.throwIfAny();
  }
  // Checked on a private copy, so what is checked is what is used (a getter or a later mutation cannot change it).
  let copy: unknown;
  try {
    copy = structuredClone(facts);
  } catch {
    copy = undefined;
  }
  if (!checkFacts(copy, problems)) problems.throwIfAny();
  const f = copy as PlatformFacts;
  if (f.expectedManifestSha256 !== pkg.manifestSha256) problems.add("PACKAGE_BINDING_MISMATCH", "expectedManifestSha256", "the package is not the one the platform recorded for this packageId");
  const rec = pkg.reconciliation;
  const rows = rec.sourceRows.byDisposition;
  const edges = rec.associations.byDisposition;
  const importRows = pkg.artifacts.filter((a) => a.kind === "MACHINE_IMPORT_CSV").reduce((s, a) => s + (a.rowCount ?? 0), 0);

  // RowCounts, each named denominator from one place (design §3). The counters are over physical source rows except
  // logicalSourceRecords (lineage RECORD rows), associationEdges (source edges) and emittedArtifactRows (import file records).
  // Every reconciliation figure below was cross-checked against the evidence tables by readMigrationPackage.
  const counts: ReportModel["counts"] = {
    physicalSourceRows: recon(rec.sourceRows.total, "/sourceRows/total"),
    logicalSourceRecords: fig(pkg.lineage.recordRows, LINEAGE_PATH, "records with contribution_kind=RECORD"),
    billableSourceUnits: fig(f.billableSourceUnits, "input:quote", `/quotes/${f.quoteId}/billableSourceUnits`),
    associationEdges: recon(rec.associations.sourceEdges, "/associations/sourceEdges"),
    emittedRepresentatives: recon(rows.OUTPUT, "/sourceRows/byDisposition/OUTPUT"),
    mergedNonSurvivors: recon(rows.MERGED_PROVEN, "/sourceRows/byDisposition/MERGED_PROVEN"),
    rejected: recon(rows.REJECTED_INPUT, "/sourceRows/byDisposition/REJECTED_INPUT"),
    withheld: recon(rows.ISOLATED + rows.LEFTOVER, "/sourceRows/byDisposition/ISOLATED + /sourceRows/byDisposition/LEFTOVER"),
    unresolved: recon(rec.sourceRows.withoutDisposition + rec.associations.withoutDisposition, "/sourceRows/withoutDisposition + /associations/withoutDisposition"),
    emittedArtifactRows: fig(importRows, "01_IMPORT", "records of every MACHINE_IMPORT_CSV under 01_IMPORT, counted from its bytes"),
  };
  // "unresolved: Nonterminal decisions; positive value blocks final acceptance" — a report is not built over them.
  if (counts.unresolved.value > 0) problems.add("UNRESOLVED_DECISIONS", RECONCILIATION_PATH, "source rows or relationships have no disposition");
  const countsBinding: CountsBinding = f.declaredCounts === null ? "UNBOUND" : "BOUND";
  if (f.declaredCounts !== null)
    for (const key of ROW_COUNT_KEYS) if (f.declaredCounts[key] !== counts[key].value) problems.add("DECLARED_COUNTS_MISMATCH", `declaredCounts.${key}`, "the platform's count differs from what the package bytes prove");
  problems.throwIfAny();

  const artifacts: ReportArtifact[] = pkg.artifacts.map((a) => ({
    path: a.path,
    kind: a.kind,
    use: useOf(a),
    sha256: a.sha256,
    byteLength: a.byteLength,
    records: a.rowCount === null ? null : fig(a.rowCount, a.path, "records excluding the header"),
  }));
  const deliveredByObject = Object.fromEntries(OBJECT_ORDER.map((o) => [o, recon(rec.records.byObject[o], `/records/byObject/${o}`)])) as ReportModel["deliveredByObject"];
  const showNames = f.privacyClass !== "AGENCY_SUMMARY";
  const lineageArtifact = pkg.artifacts.find((a) => a.path === LINEAGE_PATH) as PackageArtifact;

  const model: ReportModel = deepFreeze(
    structuredClone({
      modelVersion: REPORT_MODEL_VERSION,
      reportId: f.reportId,
      packageId: f.packageId,
      privacyClass: f.privacyClass,
      countsBinding,
      package: { packageDigest: pkg.packageDigest, manifestSha256: pkg.manifestSha256, coreVersion: pkg.coreVersion, packageFormat: pkg.packageFormat, runId: pkg.runId, target: pkg.target },
      counts,
      deliveredByObject,
      relationships: {
        sourceEdges: counts.associationEdges,
        delivered: recon(edges.OUTPUT, "/associations/byDisposition/OUTPUT"),
        leftover: recon(edges.LEFTOVER, "/associations/byDisposition/LEFTOVER"),
        unresolved: recon(edges.UNRESOLVED, "/associations/byDisposition/UNRESOLVED"),
        deduplicated: recon(edges.DEDUPLICATED, "/associations/byDisposition/DEDUPLICATED"),
      },
      artifacts,
      importGuide: importGuide(pkg),
      exceptions: artifacts.filter((a) => a.path.startsWith("02_EXCEPTIONS/")),
      lineage: {
        artifact: LINEAGE_PATH,
        sha256: lineageArtifact.sha256,
        rows: fig(pkg.lineage.rows, LINEAGE_PATH, "records excluding the header"),
        inputs: pkg.inputs.map((i) => ({ fileId: i.fileId, fileName: showNames ? i.fileName : null, sha256: i.sha256, byteLength: i.byteLength, dataRows: fig(i.dataRowCount, "manifest.json", `/inputs[fileId=${i.fileId}]/sheets/*/dataRowCount`) })),
      },
      issuer: f.issuer,
      branding: f.branding,
      termsVersion: f.termsVersion,
      termsSha256: f.termsSha256,
      quoteId: f.quoteId,
      findingIds: f.findingIds,
      materialDecisionIds: f.materialDecisionIds,
      rendererVersion: f.rendererVersion,
    }),
  );
  const modelHash = structuredDigest(DOMAINS.REPORT_MODEL, 1, model);
  const snapshot: ReportSnapshot = deepFreeze({
    reportId: f.reportId,
    packageId: f.packageId,
    counts: Object.fromEntries(ROW_COUNT_KEYS.map((k) => [k, counts[k].value])) as Record<keyof RowCounts, number>,
    findingIds: [...f.findingIds],
    materialDecisionIds: [...f.materialDecisionIds],
    brandingVersion: f.branding.version,
    termsVersion: f.termsVersion,
    modelHash,
    rendererVersion: f.rendererVersion,
    privacyClass: f.privacyClass,
  });
  const verified: VerifiedReport = Object.freeze({ model, modelHash, snapshot, countsBinding });
  VERIFIED_REPORTS.add(verified);
  return verified;
}
