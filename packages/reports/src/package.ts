/**
 * Reading one Migration Core 3.1.0 package (package format 2.1.0) from the bytes the caller hands over, and refusing it unless
 * every fact the report will show is backed by those bytes (design docs/design/B13-report-model.md §2).
 *
 * The package is a closed inventory: `manifest.json` names every other file with its kind, length, SHA-256 and (for CSV) its
 * record count, and the four areas `01_IMPORT`, `02_EXCEPTIONS`, `03_TRACEABILITY`, `04_DOCUMENTATION` separate what an operator
 * imports from what a person reads (R2-069). This module recomputes every length, hash and record count, re-derives every kind
 * from its path (as the core's own verifier does), refuses a file the manifest does not name and a name with no file, and
 * cross-checks every reconciliation figure the model shows against the evidence tables and the import files, so a manifest
 * whose sums match but whose data does not is refused (CMD039-DENY).
 *
 * Every string that leaves this module is from a closed vocabulary of the core (identifiers, enums, ASCII paths), except the
 * agency's own source file names, which are typed `UntrustedText` (S069).
 *
 * Pure: no filesystem, no network, no clock. The caller (the worker) reads the package from storage.
 *
 * Bounded (F-32): every table is scanned once and dropped, record by record. What is kept is what the cross-checks need, one small
 * entry per delivered record (its surviving lineage row, its import row's association key, a bit for its crosswalk row) and per
 * exception row (its lineage disposition), never the tables themselves; tallies are over the core's closed vocabularies.
 */
import { createHash } from "node:crypto";
import { CsvError, scanTable } from "./csv.js";
import type { TableVisitor } from "./csv.js";
import { Problems } from "./problems.js";

export const SUPPORTED_CORE_VERSION = "3.1.0";
export const SUPPORTED_PACKAGE_FORMAT = "2.1.0";
export const MANIFEST_PATH = "manifest.json";
export const RECONCILIATION_PATH = "03_TRACEABILITY/reconciliation.json";
export const LINEAGE_PATH = "03_TRACEABILITY/source-lineage.csv";
export const CROSSWALK_PATH = "03_TRACEABILITY/import-crosswalk.csv";
export const ASSOCIATIONS_PATH = "03_TRACEABILITY/associations.csv";
export const UNRESOLVED_ASSOCIATIONS_PATH = "02_EXCEPTIONS/unresolved-associations.csv";
export const PACKAGE_DIGEST_VERSION = "kauro-package-digest/1";

export const AREAS = ["01_IMPORT", "02_EXCEPTIONS", "03_TRACEABILITY", "04_DOCUMENTATION"] as const;
export type Area = (typeof AREAS)[number];

export const ARTIFACT_KINDS = ["MACHINE_IMPORT_CSV", "MACHINE_EVIDENCE_CSV", "MACHINE_EXCEPTION_CSV", "HUMAN_VIEW_CSV", "DOCUMENT"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The four destination objects of Migration Core 3.1.0, in the order its import instructions load them (parents first). */
export const OBJECT_ORDER = ["COMPANY", "CONTACT", "DEAL", "LEAD"] as const;
export type CoreObject = (typeof OBJECT_ORDER)[number];

/** The core's target vocabularies (`src/domain/config.ts` TARGET_MODES, `src/domain/canonical.ts` IMPORT_MODES). */
export const TARGET_MODES = ["HUBSPOT", "SALESFORCE", "CLEAN_ONLY"] as const;
export const IMPORT_MODES = ["CREATE_ONLY", "UPDATE_ONLY", "UPSERT"] as const;

const SOURCE_DISPOSITIONS = ["ISOLATED", "LEFTOVER", "MERGED_PROVEN", "OUTPUT", "REJECTED_INPUT"] as const;
const EDGE_DISPOSITIONS = ["DEDUPLICATED", "LEFTOVER", "OUTPUT", "UNRESOLVED"] as const;
/**
 * What a source row contributed (core `reconcile/truth.ts` ContributionKind). The core writes NONE for exactly two rows
 * (`run/run-migration.ts`): a row its reader could not read (REJECTED_INPUT) and a row on a sheet no record mapping covers
 * (LEFTOVER); neither names a record.
 */
const CONTRIBUTION_KINDS = ["RECORD", "ASSOCIATION", "NONE"] as const;
/** The exception tables, each listing the source rows of one disposition, by row locator (core verifier `dispositionArtifacts.agree`). */
const EXCEPTION_TABLES = [
  ["02_EXCEPTIONS/isolated.csv", "ISOLATED"],
  ["02_EXCEPTIONS/leftovers.csv", "LEFTOVER"],
  ["02_EXCEPTIONS/rejected-input.csv", "REJECTED_INPUT"],
] as const;

/**
 * Every named artifact outside 01_IMPORT and the data view, with the kind the core declares for it (`src/artifacts/layout.ts`).
 * A name with no entry is refused: a new file the report cannot classify is not shown under a guessed use.
 */
const KIND_BY_PATH: ReadonlyMap<string, ArtifactKind> = new Map<string, ArtifactKind>([
  ["02_EXCEPTIONS/isolated.csv", "MACHINE_EXCEPTION_CSV"],
  ["02_EXCEPTIONS/leftovers.csv", "MACHINE_EXCEPTION_CSV"],
  ["02_EXCEPTIONS/rejected-input.csv", "MACHINE_EXCEPTION_CSV"],
  ["02_EXCEPTIONS/unmapped-fields.csv", "MACHINE_EXCEPTION_CSV"],
  ["02_EXCEPTIONS/unresolved-associations.csv", "MACHINE_EXCEPTION_CSV"],
  ["02_EXCEPTIONS/destination-conflicts.csv", "MACHINE_EXCEPTION_CSV"],
  ["02_EXCEPTIONS/duplicate-candidates.csv", "MACHINE_EXCEPTION_CSV"],
  ["02_EXCEPTIONS/formula-risk.csv", "HUMAN_VIEW_CSV"],
  ["03_TRACEABILITY/source-lineage.csv", "MACHINE_EVIDENCE_CSV"],
  ["03_TRACEABILITY/import-crosswalk.csv", "MACHINE_EVIDENCE_CSV"],
  ["03_TRACEABILITY/changes.csv", "MACHINE_EVIDENCE_CSV"],
  ["03_TRACEABILITY/flags.csv", "MACHINE_EVIDENCE_CSV"],
  ["03_TRACEABILITY/associations.csv", "MACHINE_EVIDENCE_CSV"],
  ["03_TRACEABILITY/destination-matching.csv", "MACHINE_EVIDENCE_CSV"],
  ["03_TRACEABILITY/instance-verification.csv", "MACHINE_EVIDENCE_CSV"],
  ["03_TRACEABILITY/merges.json", "DOCUMENT"],
  ["03_TRACEABILITY/reconciliation.json", "DOCUMENT"],
  ["03_TRACEABILITY/config.normalized.json", "DOCUMENT"],
  ["04_DOCUMENTATION/audit.md", "DOCUMENT"],
  ["04_DOCUMENTATION/import-instructions.md", "DOCUMENT"],
]);
const DATA_VIEW_PREFIX = "04_DOCUMENTATION/data-view/";

/** The one kind of string that is not from the core's closed vocabularies: shown only escaped, never as markup or a path. */
export interface UntrustedText {
  readonly untrusted: string;
}

export interface PackageArtifact {
  readonly path: string;
  readonly area: Area;
  readonly kind: ArtifactKind;
  readonly sha256: string;
  readonly byteLength: number;
  /** Data records excluding the header, counted from the bytes; null for a DOCUMENT (the core declares null too). */
  readonly rowCount: number | null;
}

export interface PackageInput {
  readonly fileId: string;
  /** The agency's own file name. */
  readonly fileName: UntrustedText;
  readonly sha256: string;
  readonly byteLength: number;
  readonly dataRowCount: number;
  readonly rejectedRowCount: number;
}

export interface Reconciliation {
  readonly sourceRows: { readonly total: number; readonly ingested: number; readonly accountedFor: number; readonly withoutDisposition: number; readonly byDisposition: Readonly<Record<(typeof SOURCE_DISPOSITIONS)[number], number>> };
  readonly associations: { readonly sourceEdges: number; readonly accountedFor: number; readonly withoutDisposition: number; readonly byDisposition: Readonly<Record<(typeof EDGE_DISPOSITIONS)[number], number>> };
  readonly records: { readonly deliveredTotal: number; readonly byObject: Readonly<Record<CoreObject, number>> };
}

export interface ImportFile {
  /** The destination object of a record file; null for an association file. */
  readonly object: CoreObject | null;
  /** The two ends of an association file; null for a record file. */
  readonly association: { readonly from: CoreObject; readonly to: CoreObject } | null;
  /** For a table the core cut into numbered parts: this file's part and the family's part count; null for an uncut table. */
  readonly part: { readonly part: number; readonly of: number } | null;
}

export interface VerifiedPackage {
  /** `kauro-package-digest/1` over every file, manifest included (Migration Core `package-digest.ts`). */
  readonly packageDigest: string;
  readonly manifestSha256: string;
  readonly coreVersion: string;
  readonly packageFormat: string;
  readonly runId: string;
  readonly bundleId: string;
  readonly configHash: string;
  readonly target: { readonly mode: (typeof TARGET_MODES)[number]; readonly importMode: (typeof IMPORT_MODES)[number]; readonly adapterVersion: string | null; readonly targetContractHash: string | null };
  readonly inputs: readonly PackageInput[];
  readonly artifacts: readonly PackageArtifact[];
  readonly reconciliation: Reconciliation;
  /** Lineage rows by contribution kind and disposition, counted from `source-lineage.csv`. */
  readonly lineage: { readonly rows: number; readonly recordRows: number; readonly byKindDisposition: Readonly<Record<string, number>> };
  /** What each import file holds, from the crosswalk (record files) and the file name (association files). */
  /** A frozen plain object keyed by import path (not a Map: `Object.freeze` cannot stop `Map.set`; review ADV-9). */
  readonly importFiles: Readonly<Record<string, ImportFile>>;
}

export type PackageFiles = ReadonlyMap<string, Uint8Array>;

/** The packages this module produced. `buildReportModel` refuses any other object, however well it is shaped (ADV-5). */
const VERIFIED = new WeakSet<object>();
export function isVerifiedPackage(value: unknown): value is VerifiedPackage {
  return typeof value === "object" && value !== null && VERIFIED.has(value);
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;
const SEMVER = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;
const TARGET_CONTRACT = /^tc_[0-9a-f]{64}$/;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A portable relative package path: ASCII letters, digits, `.`, `_`, `-` in `/`-separated segments; no `.`/`..` segment, no
 * segment ending in a dot, no Windows reserved device name. Case collisions are refused across the inventory.
 */
export function isSafePackagePath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || !PATH.test(path)) return false;
  return path.split("/").every((segment) => segment !== "." && segment !== ".." && !segment.endsWith(".") && !WINDOWS_RESERVED.test(segment));
}

/** The kind the core declares for a path, re-derived from the path alone; null when the path is not one the format places. */
function kindForPath(path: string): ArtifactKind | null {
  if (path.startsWith("01_IMPORT/") && path.endsWith(".csv")) return "MACHINE_IMPORT_CSV";
  if (path.startsWith(DATA_VIEW_PREFIX) && path.endsWith(".csv")) return "HUMAN_VIEW_CSV";
  return KIND_BY_PATH.get(path) ?? null;
}

function closedKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((k) => Object.hasOwn(value, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const NUMBERED_PART = /-([0-9]{3})\.csv$/;
const ASSOCIATION_FILE = /^01_IMPORT\/[A-Za-z0-9._-]+\/associations\/([a-z]+)_to_([a-z]+)\.csv$/;
const ASSOCIATION_KEY_COLUMNS: readonly string[] = ["association_key", "Association Key", "Kauro_Association_Key__c"];

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export function readMigrationPackage(files: PackageFiles): VerifiedPackage {
  const problems = new Problems();
  const manifestBytes = files.get(MANIFEST_PATH);
  if (manifestBytes === undefined) {
    problems.add("MANIFEST_MISSING", MANIFEST_PATH, "the package has no manifest");
    problems.throwIfAny();
    throw new Error("unreachable");
  }
  let manifest: unknown;
  try {
    manifest = parseJson(manifestBytes);
  } catch {
    problems.add("MANIFEST_MALFORMED", MANIFEST_PATH, "not UTF-8 JSON");
  }
  const topKeys = ["artifacts", "bundleId", "configHash", "coreVersion", "inputs", "manifestVersion", "relationshipCandidates", "runId", "sourceProfileHash", "sourceRegistryVersion", "target"];
  if (!isObject(manifest) || !closedKeys(manifest, topKeys)) {
    problems.add("MANIFEST_MALFORMED", MANIFEST_PATH, "the manifest is not the closed package format 2.1.0 object");
    problems.throwIfAny();
    throw new Error("unreachable");
  }
  if (manifest["coreVersion"] !== SUPPORTED_CORE_VERSION || manifest["manifestVersion"] !== SUPPORTED_PACKAGE_FORMAT) {
    problems.add("UNSUPPORTED_FORMAT", MANIFEST_PATH, `this model reads core ${SUPPORTED_CORE_VERSION} packages in format ${SUPPORTED_PACKAGE_FORMAT} only`);
    problems.throwIfAny();
  }
  const { runId, bundleId, configHash } = manifest;
  const idsOk = typeof runId === "string" && IDENTIFIER.test(runId) && typeof bundleId === "string" && IDENTIFIER.test(bundleId) && typeof configHash === "string" && HEX64.test(configHash);
  if (!idsOk || !isCount(manifest["relationshipCandidates"])) problems.add("MANIFEST_MALFORMED", MANIFEST_PATH, "runId, bundleId, configHash or relationshipCandidates outside the core's vocabulary");
  const rawTarget = manifest["target"];
  let target: VerifiedPackage["target"] = { mode: "CLEAN_ONLY", importMode: "CREATE_ONLY", adapterVersion: null, targetContractHash: null };
  if (
    isObject(rawTarget) &&
    closedKeys(rawTarget, ["importMode", "mode"], ["adapterVersion", "targetContractHash"]) &&
    oneOf(TARGET_MODES, rawTarget["mode"]) &&
    oneOf(IMPORT_MODES, rawTarget["importMode"]) &&
    (rawTarget["adapterVersion"] === undefined || (typeof rawTarget["adapterVersion"] === "string" && SEMVER.test(rawTarget["adapterVersion"]))) &&
    (rawTarget["targetContractHash"] === undefined || rawTarget["targetContractHash"] === null || (typeof rawTarget["targetContractHash"] === "string" && TARGET_CONTRACT.test(rawTarget["targetContractHash"])))
  ) {
    target = {
      mode: rawTarget["mode"],
      importMode: rawTarget["importMode"],
      adapterVersion: (rawTarget["adapterVersion"] as string | undefined) ?? null,
      targetContractHash: (rawTarget["targetContractHash"] as string | undefined) ?? null,
    };
  } else {
    problems.add("MANIFEST_MALFORMED", "manifest.json#/target", "target is not the closed target object of the core's vocabulary");
  }

  // --- inputs -------------------------------------------------------------------------------------------------------------------
  // The readers' own counts, per sheet: readerRowCount rows read, of which dataRowCount were accepted and rejectedRowCount were
  // not readable as a row (core verifier `reconciliation.equation`). A rejected row is a source row, never a delivered record.
  const inputs: PackageInput[] = [];
  const read = { rows: 0, rejected: 0, unbalancedSheets: 0 };
  const rawInputs = manifest["inputs"];
  if (!Array.isArray(rawInputs)) problems.add("MANIFEST_MALFORMED", "manifest.json#/inputs", "inputs is not a list");
  else
    rawInputs.forEach((input: unknown, index) => {
      const subject = `manifest.json#/inputs/${index}`;
      if (!isObject(input) || !closedKeys(input, ["byteLength", "encoding", "encodingEvidence", "fileId", "format", "path", "sha256", "sheets"]) || !Array.isArray(input["sheets"])) {
        problems.add("MANIFEST_MALFORMED", subject, "input is not the closed input object");
        return;
      }
      let readerRowCount = 0;
      let dataRowCount = 0;
      let rejectedRowCount = 0;
      let unbalancedSheets = 0;
      for (const sheet of input["sheets"] as unknown[]) {
        if (!isObject(sheet) || !isCount(sheet["readerRowCount"]) || !isCount(sheet["dataRowCount"]) || !isCount(sheet["rejectedRowCount"])) {
          problems.add("MANIFEST_MALFORMED", subject, "sheet counts malformed");
          return;
        }
        if (sheet["readerRowCount"] !== sheet["dataRowCount"] + sheet["rejectedRowCount"]) unbalancedSheets++;
        readerRowCount += sheet["readerRowCount"];
        dataRowCount += sheet["dataRowCount"];
        rejectedRowCount += sheet["rejectedRowCount"];
      }
      const { fileId, path, sha256: hash, byteLength } = input;
      if (typeof fileId !== "string" || !IDENTIFIER.test(fileId) || typeof path !== "string" || path.length === 0 || path.length > 1024 || typeof hash !== "string" || !HEX64.test(hash) || !isCount(byteLength)) {
        problems.add("MANIFEST_MALFORMED", subject, "input identity malformed");
        return;
      }
      read.rows += readerRowCount;
      read.rejected += rejectedRowCount;
      read.unbalancedSheets += unbalancedSheets;
      inputs.push({ fileId, fileName: { untrusted: path }, sha256: hash, byteLength, dataRowCount, rejectedRowCount });
    });

  // --- artifacts: closed inventory, kinds from paths, bytes, hashes ----------------------------------------------------------------
  const inventory: { path: string; kind: ArtifactKind; sha256: string; byteLength: number; rowCount: number | null }[] = [];
  const hashes = new Map<string, string>();
  const declared = new Set<string>();
  const folded = new Set<string>();
  const rawArtifacts = manifest["artifacts"];
  if (!Array.isArray(rawArtifacts)) problems.add("MANIFEST_MALFORMED", "manifest.json#/artifacts", "artifacts is not a list");
  else
    rawArtifacts.forEach((entry: unknown, index) => {
      const subject = `manifest.json#/artifacts/${index}`;
      if (!isObject(entry) || !closedKeys(entry, ["byteLength", "kind", "path", "rowCount", "sha256"])) {
        problems.add("MANIFEST_MALFORMED", subject, "artifact entry is not the closed artifact object");
        return;
      }
      const { path, kind, sha256: hash, byteLength, rowCount } = entry;
      if (typeof path !== "string" || !isSafePackagePath(path) || path === MANIFEST_PATH) {
        problems.add("UNSAFE_PATH", subject, "artifact path is not a portable relative package path");
        return;
      }
      if (declared.has(path) || folded.has(path.toLowerCase())) {
        problems.add("DUPLICATE_PATH", subject, "the manifest names this path twice, or two paths that differ only in case");
        return;
      }
      declared.add(path);
      folded.add(path.toLowerCase());
      if (!oneOf(ARTIFACT_KINDS, kind) || typeof hash !== "string" || !HEX64.test(hash) || !isCount(byteLength) || (kind === "DOCUMENT" ? rowCount !== null : !isCount(rowCount))) {
        problems.add("MANIFEST_MALFORMED", path, "kind, sha256, byteLength or rowCount malformed (a DOCUMENT declares rowCount null, a CSV a count)");
        return;
      }
      const expectedKind = kindForPath(path);
      if (expectedKind === null || expectedKind !== kind) {
        problems.add("AREA_KIND_MISMATCH", path, expectedKind === null ? "the format places no artifact at this path" : `the format declares ${expectedKind} at this path`);
        return;
      }
      const bytes = files.get(path);
      if (bytes === undefined) {
        problems.add("ARTIFACT_MISSING", path, "the manifest names a file the package does not hold");
        return;
      }
      const digest = sha256(bytes);
      if (bytes.byteLength !== byteLength || digest !== hash) {
        problems.add("ARTIFACT_BYTES_MISMATCH", path, "the file's length or SHA-256 differs from the manifest");
        return;
      }
      hashes.set(path, digest);
      inventory.push({ path, kind, sha256: hash, byteLength, rowCount: rowCount as number | null });
    });
  for (const path of files.keys()) {
    if (path !== MANIFEST_PATH && !declared.has(path)) problems.add("ARTIFACT_UNDECLARED", isSafePackagePath(path) ? path : "(unsafe path)", "the package holds a file the manifest does not name");
  }

  // --- tables: each scanned once, its records counted from the bytes and handed to the one check that needs them ------------------
  // A cross-check found while scanning is held in `found` and reported only once the inventory and the reconciliation are sound,
  // as when the tables were read whole first: a refusal names the first layer that does not hold, not its consequences.
  const found = new Problems();
  const mismatch = (subject: string, detail: string): void => found.add("RECONCILIATION_MISMATCH", subject, detail);
  const column = (header: readonly string[], path: string, name: string): number => {
    const at = header.indexOf(name);
    if (at < 0) found.add("ARTIFACT_UNREADABLE", path, `the table lacks its ${name} column`);
    return at;
  };
  const isRecordImport = (a: { path: string; kind: ArtifactKind }): boolean => a.kind === "MACHINE_IMPORT_CSV" && !a.path.split("/").includes("associations");
  const counted = new Map<string, number>();
  // What is kept per row is bounded by what the reconciliation declares, read here ahead of the tables (and again, with its refusals,
  // after them): a forged table with more delivered or exception rows than declared is refused without being held (review of Order 14).
  const declaredCounts = readReconciliation(files, new Problems(), { runId: runId as string, bundleId: bundleId as string, configHash: configHash as string });
  const keep = {
    records: declaredCounts?.records.deliveredTotal ?? 0,
    exceptions: declaredCounts === null ? 0 : EXCEPTION_TABLES.reduce((s, [, d]) => s + declaredCounts.sourceRows.byDisposition[d], 0),
    keys: 0,
  };
  const beyond = new Set<string>();
  const overflow = (subject: string, detail: string): void => {
    if (!beyond.has(detail)) mismatch(subject, detail);
    beyond.add(detail);
  };

  // record import files: the association key of each row, for the crosswalk (the one column it is checked against)
  const importKeys = new Map<string, { columns: number; keys: string[] }>();
  const importKeysOf = (path: string): TableVisitor => (header) => {
    const at = header.flatMap((h, i) => (ASSOCIATION_KEY_COLUMNS.includes(h) ? [i] : []));
    const entry = { columns: at.length, keys: [] as string[] };
    importKeys.set(path, entry);
    const keyAt = at[0];
    if (at.length !== 1 || keyAt === undefined) return null;
    return (row) => {
      if (keep.keys < keep.records) {
        keep.keys++;
        entry.keys.push(row[keyAt] as string);
      } else overflow(path, "the record import files hold more records than records.deliveredTotal");
    };
  };

  // lineage: one row per source row, with its contribution kind, disposition, object and migration key
  const lineageFacts = { checked: false, rows: 0, recordRows: 0 };
  const byKindDisposition: Record<string, number> = {};
  const lineageByDisposition: Record<string, number> = {};
  const survivors = new Map<string, { readonly object: string; readonly migrationKey: string; named: boolean }>();
  const exceptionRows = new Map<string, string>();
  const lineageVisitor: TableVisitor = (header) => {
    const [kindAt, dispositionAt, locatorAt, objectAt, keyAt] = ["contribution_kind", "disposition", "row_locator_id", "object", "migration_key"].map((n) => column(header, LINEAGE_PATH, n)) as [number, number, number, number, number];
    if (Math.min(kindAt, dispositionAt, locatorAt, objectAt, keyAt) < 0) return null;
    lineageFacts.checked = true;
    return (row) => {
      lineageFacts.rows++;
      const kind = row[kindAt] as string;
      const disposition = row[dispositionAt] as string;
      const knownKind = oneOf(CONTRIBUTION_KINDS, kind);
      const knownDisposition = disposition === "" || oneOf(SOURCE_DISPOSITIONS, disposition);
      if (!knownKind || !knownDisposition) mismatch(LINEAGE_PATH, "a row carries a kind or disposition outside the core's vocabulary");
      else byKindDisposition[`${kind}/${disposition}`] = (byKindDisposition[`${kind}/${disposition}`] ?? 0) + 1;
      if (knownDisposition) lineageByDisposition[disposition] = (lineageByDisposition[disposition] ?? 0) + 1;
      if (kind === "RECORD") lineageFacts.recordRows++;
      if (kind === "NONE" && ((disposition !== "REJECTED_INPUT" && disposition !== "LEFTOVER") || row[objectAt] !== "" || row[keyAt] !== ""))
        mismatch(LINEAGE_PATH, "a NONE row is neither a row the core could not read nor a row no mapping covers, or it names a record");
      if (disposition === "REJECTED_INPUT" && kind !== "NONE") mismatch(LINEAGE_PATH, "a REJECTED_INPUT row contributes something");
      const locator = row[locatorAt] as string;
      if (kind === "RECORD" && disposition === "OUTPUT") {
        if (survivors.has(locator)) mismatch(LINEAGE_PATH, "two rows share a row locator");
        if (survivors.size < keep.records || survivors.has(locator)) survivors.set(locator, { object: row[objectAt] as string, migrationKey: row[keyAt] as string, named: false });
        else overflow(LINEAGE_PATH, "lineage RECORD/OUTPUT rows exceed records.deliveredTotal");
      }
      if (EXCEPTION_TABLES.some(([, d]) => d === disposition)) {
        if (exceptionRows.has(locator)) mismatch(LINEAGE_PATH, "two rows share a row locator");
        if (exceptionRows.size < keep.exceptions || exceptionRows.has(locator)) exceptionRows.set(locator, disposition);
        else overflow(LINEAGE_PATH, "lineage ISOLATED, LEFTOVER and REJECTED_INPUT rows exceed the reconciliation");
      }
    };
  };

  // exception tables: every row is a lineage row of the table's disposition, named once
  const exceptionVisitor = (path: string, disposition: string): TableVisitor => (header) => {
    const at = column(header, path, "row_locator_id");
    if (at < 0 || !lineageFacts.checked) return null;
    return (row) => {
      const locator = row[at] as string;
      if (exceptionRows.get(locator) === disposition) exceptionRows.delete(locator);
      else mismatch(path, `a row names no lineage row of disposition ${disposition}, or names one twice`);
    };
  };

  // relationships: one row per source edge in associations.csv, with its disposition
  const edgeFacts = { checked: false, unknown: 0 };
  const edgeTally: Record<string, number> = {};
  const edgeVisitor: TableVisitor = (header) => {
    const at = column(header, ASSOCIATIONS_PATH, "disposition");
    if (at < 0) return null;
    edgeFacts.checked = true;
    return (row) => {
      const d = row[at] as string;
      if (d === "" || oneOf(EDGE_DISPOSITIONS, d)) edgeTally[d] = (edgeTally[d] ?? 0) + 1;
      else edgeFacts.unknown++;
    };
  };

  // crosswalk: every delivered record names its import file and row, its object and migration key, and its surviving lineage row;
  // the object must agree with the lineage and with the migration key, and the association key with the import file's own row
  const recordPaths = new Set(inventory.filter(isRecordImport).map((a) => a.path));
  const importFiles = new Map<string, ImportFile>();
  const crosswalkFacts = { checked: false };
  const crosswalkRows = new Map<string, number>();
  const namedRows = new Map<string, Uint8Array>();
  const crosswalkVisitor: TableVisitor = (header) => {
    const [pathAt, rowAt, keyAt, mkAt, objectAt, survivorAt] = ["import_path", "import_row_number", "association_key", "migration_key", "object", "survivor_row_locator_id"].map((n) => column(header, CROSSWALK_PATH, n)) as [number, number, number, number, number, number];
    if (Math.min(pathAt, rowAt, keyAt, mkAt, objectAt, survivorAt) < 0 || !counted.has(LINEAGE_PATH)) return null;
    crosswalkFacts.checked = true;
    return (row) => {
      const [path, rowNumber, associationKey, migrationKey, object, survivor] = [row[pathAt], row[rowAt], row[keyAt], row[mkAt], row[objectAt], row[survivorAt]] as string[] as [string, string, string, string, string, string];
      if (recordPaths.has(path)) crosswalkRows.set(path, (crosswalkRows.get(path) ?? 0) + 1);
      if (!recordPaths.has(path) || !oneOf(OBJECT_ORDER, object)) {
        found.add("IMPORT_OBJECT_UNKNOWN", CROSSWALK_PATH, "a row names no record import file or an object outside the core's vocabulary");
        return;
      }
      const records = counted.get(path) ?? 0;
      let named = namedRows.get(path);
      if (named === undefined) namedRows.set(path, (named = new Uint8Array(records + 1)));
      const n = Number(rowNumber);
      const inFile = /^[1-9][0-9]*$/.test(rowNumber) && n <= records;
      if (!inFile || named[n] === 1) mismatch(CROSSWALK_PATH, "a row number is outside its file or named twice");
      if (inFile) named[n] = 1;
      if (!migrationKey.startsWith(`mk_${object.toLowerCase()}_`)) mismatch(CROSSWALK_PATH, "a row's object disagrees with its migration key");
      const lin = survivors.get(survivor);
      if (lin === undefined || lin.object !== object || lin.migrationKey !== migrationKey || lin.named) mismatch(CROSSWALK_PATH, "a row's surviving lineage row is absent, of another object or key, or named twice");
      if (lin !== undefined) lin.named = true;
      const known = importFiles.get(path);
      if (known !== undefined && known.object !== object) mismatch(CROSSWALK_PATH, "one import file is crosswalked to two objects");
      importFiles.set(path, { object, association: null, part: null });
      const keys = importKeys.get(path);
      const keyColumns = keys?.columns ?? 0;
      if (associationKey === "" ? keyColumns !== 0 : keyColumns !== 1 || keys?.keys[n - 1] !== associationKey) mismatch(path, "the crosswalk's association key differs from the import file's own row");
    };
  };

  const visitorOf = (a: { path: string; kind: ArtifactKind }): TableVisitor | undefined => {
    if (isRecordImport(a)) return importKeysOf(a.path);
    if (a.path === LINEAGE_PATH) return lineageVisitor;
    if (a.path === ASSOCIATIONS_PATH) return edgeVisitor;
    if (a.path === CROSSWALK_PATH) return crosswalkVisitor;
    const exception = EXCEPTION_TABLES.find(([p]) => p === a.path);
    return exception === undefined ? undefined : exceptionVisitor(exception[0], exception[1]);
  };
  // the import files and the lineage first: the crosswalk and the exception tables are checked against them as they are read
  const stage = (a: { path: string; kind: ArtifactKind }): number => (isRecordImport(a) ? 0 : a.path === LINEAGE_PATH ? 1 : 2);
  for (const a of [...inventory].sort((x, y) => stage(x) - stage(y))) {
    if (a.kind === "DOCUMENT") continue;
    let rows: number;
    try {
      rows = scanTable(files.get(a.path) as Uint8Array, visitorOf(a)).rows;
    } catch (error) {
      problems.add("ARTIFACT_UNREADABLE", a.path, error instanceof CsvError ? error.message : "unreadable CSV");
      continue;
    }
    if (rows !== a.rowCount) {
      problems.add("ARTIFACT_ROWS_MISMATCH", a.path, `the manifest declares ${a.rowCount} records, the file holds ${rows}`);
      continue;
    }
    counted.set(a.path, rows);
  }
  const artifacts: PackageArtifact[] = inventory
    .filter((a) => a.kind === "DOCUMENT" || counted.has(a.path))
    .map((a) => ({ path: a.path, area: a.path.split("/")[0] as Area, kind: a.kind, sha256: a.sha256, byteLength: a.byteLength, rowCount: a.kind === "DOCUMENT" ? null : (counted.get(a.path) as number) }));
  for (const a of artifacts)
    if (a.path.startsWith(DATA_VIEW_PREFIX) && !declared.has(`01_IMPORT/${a.path.slice(DATA_VIEW_PREFIX.length)}`)) problems.add("AREA_KIND_MISMATCH", a.path, "a data view names no import file");
  problems.throwIfAny();

  // --- reconciliation and its cross-checks against the evidence -------------------------------------------------------------------
  const reconciliation = readReconciliation(files, problems, { runId: runId as string, bundleId: bundleId as string, configHash: configHash as string });
  problems.throwIfAny();
  const rec = reconciliation as Reconciliation;
  const table = (path: string): number | undefined => {
    const rows = counted.get(path);
    if (rows === undefined) problems.add("ARTIFACT_MISSING", path, "a required evidence table is absent");
    return rows;
  };
  problems.absorb(found);
  const different = (subject: string, detail: string): void => problems.add("RECONCILIATION_MISMATCH", subject, detail);

  const importArtifacts = artifacts.filter((a) => a.kind === "MACHINE_IMPORT_CSV");
  const edgeFiles: PackageArtifact[] = [];
  const recordFiles: PackageArtifact[] = [];
  for (const a of importArtifacts) {
    if (!a.path.split("/").includes("associations")) {
      recordFiles.push(a);
      continue;
    }
    const m = ASSOCIATION_FILE.exec(a.path);
    const from = m?.[1]?.toUpperCase();
    const to = m?.[2]?.toUpperCase();
    if (!oneOf(OBJECT_ORDER, from) || !oneOf(OBJECT_ORDER, to)) {
      problems.add("IMPORT_OBJECT_UNKNOWN", a.path, "an association file must be named <object>_to_<object>.csv over the core's objects");
      continue;
    }
    edgeFiles.push(a);
    importFiles.set(a.path, { object: null, association: { from, to }, part: null });
  }
  const sumRows = (list: readonly PackageArtifact[]): number => list.reduce((s, a) => s + (a.rowCount ?? 0), 0);
  if (sumRows(recordFiles) !== rec.records.deliveredTotal) different(RECONCILIATION_PATH, "records.deliveredTotal differs from the records in the import files");
  if (sumRows(edgeFiles) !== rec.associations.byDisposition.OUTPUT) different(RECONCILIATION_PATH, "associations OUTPUT differs from the rows in the association import files");
  if (manifest["relationshipCandidates"] !== rec.associations.sourceEdges) different(RECONCILIATION_PATH, "associations.sourceEdges differs from the manifest's relationshipCandidates");
  // rows read = rows ingested = source rows; the rejected rows are among them, each a REJECTED_INPUT lineage row
  if (read.unbalancedSheets > 0) different(MANIFEST_PATH, "a sheet's rows read are not its data rows plus its rejected rows");
  if (read.rows !== rec.sourceRows.ingested) different(RECONCILIATION_PATH, "sourceRows.ingested differs from the rows the manifest's inputs read");
  if (read.rejected !== rec.sourceRows.byDisposition.REJECTED_INPUT) different(RECONCILIATION_PATH, "sourceRows REJECTED_INPUT differs from the rows the manifest's inputs rejected");
  for (const [path, disposition] of EXCEPTION_TABLES) {
    const rows = table(path);
    if (rows !== undefined && rows !== rec.sourceRows.byDisposition[disposition]) different(path, `its records differ from sourceRows ${disposition}`);
  }

  // relationships: associations.csv rows by disposition; unresolved-associations = LEFTOVER + UNRESOLVED
  const edgeRows = table(ASSOCIATIONS_PATH);
  if (edgeRows !== undefined && edgeFacts.checked) {
    if (edgeRows !== rec.associations.sourceEdges) different(ASSOCIATIONS_PATH, "its rows differ from associations.sourceEdges");
    for (const d of EDGE_DISPOSITIONS) if ((edgeTally[d] ?? 0) !== rec.associations.byDisposition[d]) different(ASSOCIATIONS_PATH, `its ${d} rows differ from the reconciliation`);
    if ((edgeTally[""] ?? 0) !== rec.associations.withoutDisposition) different(ASSOCIATIONS_PATH, "its rows without a disposition differ from associations.withoutDisposition");
    if (edgeFacts.unknown > 0) different(ASSOCIATIONS_PATH, "a row carries a disposition outside the core's vocabulary");
  }
  const unresolvedRows = table(UNRESOLVED_ASSOCIATIONS_PATH);
  if (unresolvedRows !== undefined && unresolvedRows !== rec.associations.byDisposition.LEFTOVER + rec.associations.byDisposition.UNRESOLVED)
    different(UNRESOLVED_ASSOCIATIONS_PATH, "its records differ from associations LEFTOVER + UNRESOLVED");

  // lineage against the reconciliation
  if (table(LINEAGE_PATH) !== undefined && lineageFacts.checked) {
    if (lineageFacts.rows !== rec.sourceRows.total) different(LINEAGE_PATH, "lineage rows differ from sourceRows.total");
    for (const d of SOURCE_DISPOSITIONS) if ((lineageByDisposition[d] ?? 0) !== rec.sourceRows.byDisposition[d]) different(LINEAGE_PATH, `lineage ${d} rows differ from the reconciliation`);
    if ((lineageByDisposition[""] ?? 0) !== rec.sourceRows.withoutDisposition) different(LINEAGE_PATH, "lineage rows without a disposition differ from sourceRows.withoutDisposition");
    if (survivors.size !== rec.records.deliveredTotal) different(LINEAGE_PATH, "lineage RECORD/OUTPUT rows differ from records.deliveredTotal");
    const survivorsByObject: Record<string, number> = {};
    for (const s of survivors.values()) survivorsByObject[s.object] = (survivorsByObject[s.object] ?? 0) + 1;
    for (const object of OBJECT_ORDER) if ((survivorsByObject[object] ?? 0) !== rec.records.byObject[object]) different(LINEAGE_PATH, `lineage RECORD/OUTPUT ${object} rows differ from records.byObject`);
  }

  // crosswalk against the import files and the reconciliation
  if (table(CROSSWALK_PATH) !== undefined && crosswalkFacts.checked) {
    for (const file of recordFiles) {
      if (!importFiles.has(file.path)) problems.add("IMPORT_OBJECT_UNKNOWN", file.path, "no crosswalk row names this file's object");
      if ((crosswalkRows.get(file.path) ?? 0) !== file.rowCount) different(file.path, "the crosswalk rows for this file differ from its records");
    }
    for (const object of OBJECT_ORDER) {
      const delivered = recordFiles.filter((f) => importFiles.get(f.path)?.object === object).reduce((s, f) => s + (f.rowCount ?? 0), 0);
      if (delivered !== rec.records.byObject[object]) different(RECONCILIATION_PATH, `records.byObject.${object} differs from its import files`);
    }
  }
  // cut tables (Migration Core `import-partition.ts`, `-NNN` parts): a family is the path without its part number; a cut
  // family holds exactly parts 1..m and no unnumbered sibling, so "Part n of m" is a fact, not a count of similar names
  const families = new Map<string, number[]>();
  for (const a of importArtifacts) {
    const m = NUMBERED_PART.exec(a.path);
    const family = m === null ? a.path : `${a.path.slice(0, m.index)}.csv`;
    families.set(family, [...(families.get(family) ?? []), m === null ? 0 : Number(m[1])]);
  }
  const partOf = new Map<string, { part: number; of: number }>();
  for (const [family, numbers] of families) {
    if (numbers.length === 1 && numbers[0] === 0) continue;
    const sorted = [...numbers].sort((x, y) => x - y);
    if (!sorted.every((n, i) => n === i + 1)) {
      problems.add("IMPORT_PARTS_INVALID", family, "a cut table's parts are not exactly 1..m, or an unnumbered file sits beside them");
      continue;
    }
    for (const a of importArtifacts) {
      const m = NUMBERED_PART.exec(a.path);
      if (m !== null && `${a.path.slice(0, m.index)}.csv` === family) partOf.set(a.path, { part: Number(m[1]), of: sorted.length });
    }
  }
  problems.throwIfAny();

  // every other file was hashed once already, against its manifest entry
  const manifestSha256 = sha256(manifestBytes);
  hashes.set(MANIFEST_PATH, manifestSha256);
  const paths = [...files.keys()].sort(compareCodeUnits);
  const digestText = `${PACKAGE_DIGEST_VERSION}\n${paths.map((p) => `${p} ${hashes.get(p) ?? sha256(files.get(p) as Uint8Array)}\n`).join("")}`;
  const verified: VerifiedPackage = deepFreeze({
    packageDigest: sha256(digestText),
    manifestSha256,
    coreVersion: SUPPORTED_CORE_VERSION,
    packageFormat: SUPPORTED_PACKAGE_FORMAT,
    runId: runId as string,
    bundleId: bundleId as string,
    configHash: configHash as string,
    target,
    inputs,
    artifacts,
    reconciliation: rec,
    lineage: { rows: lineageFacts.rows, recordRows: lineageFacts.recordRows, byKindDisposition },
    importFiles: Object.fromEntries([...importFiles].map(([path, file]) => [path, { ...file, part: partOf.get(path) ?? null }])),
  });
  VERIFIED.add(verified);
  return verified;
}

function readCounts<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isObject(value) || !closedKeys(value, keys)) return null;
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const n = value[key];
    if (!isCount(n)) return null;
    out[key] = n;
  }
  return out;
}

function readReconciliation(files: PackageFiles, problems: Problems, binding: { runId: string; bundleId: string; configHash: string }): Reconciliation | null {
  const bytes = files.get(RECONCILIATION_PATH);
  if (bytes === undefined) {
    problems.add("ARTIFACT_MISSING", RECONCILIATION_PATH, "the package has no reconciliation");
    return null;
  }
  let raw: unknown;
  try {
    raw = parseJson(bytes);
  } catch {
    problems.add("RECONCILIATION_MALFORMED", RECONCILIATION_PATH, "not UTF-8 JSON");
    return null;
  }
  const bad = (detail: string): null => {
    problems.add("RECONCILIATION_MALFORMED", RECONCILIATION_PATH, detail);
    return null;
  };
  if (!isObject(raw)) return bad("not an object");
  if (raw["runId"] !== binding.runId || raw["bundleId"] !== binding.bundleId || raw["configHash"] !== binding.configHash || raw["coreVersion"] !== SUPPORTED_CORE_VERSION) {
    problems.add("RECONCILIATION_MISMATCH", RECONCILIATION_PATH, "runId, bundleId, configHash or coreVersion differ from the manifest");
    return null;
  }
  const rows = raw["sourceRows"];
  const edges = raw["associations"];
  const records = raw["records"];
  if (!isObject(rows) || !isObject(edges) || !isObject(records)) return bad("sourceRows, associations or records missing");
  const rowCounts = readCounts(rows["byDisposition"], SOURCE_DISPOSITIONS);
  const edgeCounts = readCounts(edges["byDisposition"], EDGE_DISPOSITIONS);
  const byObject = readCounts(records["byObject"], OBJECT_ORDER);
  const scalars = [rows["total"], rows["ingested"], rows["accountedFor"], rows["withoutDisposition"], edges["sourceEdges"], edges["accountedFor"], edges["withoutDisposition"], records["deliveredTotal"]];
  if (rowCounts === null || edgeCounts === null || byObject === null || !scalars.every(isCount)) return bad("a count is missing or not a non-negative integer");
  const rec: Reconciliation = {
    sourceRows: { total: rows["total"] as number, ingested: rows["ingested"] as number, accountedFor: rows["accountedFor"] as number, withoutDisposition: rows["withoutDisposition"] as number, byDisposition: rowCounts },
    associations: { sourceEdges: edges["sourceEdges"] as number, accountedFor: edges["accountedFor"] as number, withoutDisposition: edges["withoutDisposition"] as number, byDisposition: edgeCounts },
    records: { deliveredTotal: records["deliveredTotal"] as number, byObject },
  };
  // The equations the core states, recomputed rather than read from its `equationHolds` flags.
  const sum = (o: Readonly<Record<string, number>>): number => Object.values(o).reduce((s, n) => s + n, 0);
  if (sum(rec.sourceRows.byDisposition) + rec.sourceRows.withoutDisposition !== rec.sourceRows.total || rec.sourceRows.accountedFor !== sum(rec.sourceRows.byDisposition))
    problems.add("RECONCILIATION_MISMATCH", RECONCILIATION_PATH, "source rows do not conserve: dispositions do not sum to the total");
  if (rec.sourceRows.ingested !== rec.sourceRows.total) problems.add("RECONCILIATION_MISMATCH", RECONCILIATION_PATH, "the rows the readers produced differ from the rows the lineage holds");
  if (sum(rec.associations.byDisposition) + rec.associations.withoutDisposition !== rec.associations.sourceEdges || rec.associations.accountedFor !== sum(rec.associations.byDisposition))
    problems.add("RECONCILIATION_MISMATCH", RECONCILIATION_PATH, "relationships do not conserve: dispositions do not sum to the source edges");
  if (sum(rec.records.byObject) !== rec.records.deliveredTotal) problems.add("RECONCILIATION_MISMATCH", RECONCILIATION_PATH, "records.byObject does not sum to deliveredTotal");
  return rec;
}
