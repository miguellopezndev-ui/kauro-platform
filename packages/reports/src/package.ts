/**
 * Reading one Migration Core 3.0.0 package (package format 2.1.0) from the bytes the caller hands over, and refusing it unless
 * every fact the report will show is backed by those bytes (design docs/design/B13-report-model.md §2).
 *
 * The package is a closed inventory: `manifest.json` names every other file with its kind, length, SHA-256 and (for CSV) its
 * record count, and the four areas `01_IMPORT`, `02_EXCEPTIONS`, `03_TRACEABILITY`, `04_DOCUMENTATION` separate what an operator
 * imports from what a person reads (R2-069). This module recomputes every length, hash and record count, refuses a file the
 * manifest does not name and a name with no file, and cross-checks the reconciliation's figures against the import files, the
 * crosswalk and the lineage, so a manifest whose sums match but whose data does not is refused (CMD039-DENY).
 *
 * Pure: no filesystem, no network, no clock. The caller (the worker) reads the package from storage.
 */
import { createHash } from "node:crypto";
import { CsvError, readTable } from "./csv.js";
import { Problems } from "./problems.js";

export const SUPPORTED_CORE_VERSION = "3.0.0";
export const SUPPORTED_PACKAGE_FORMAT = "2.1.0";
export const MANIFEST_PATH = "manifest.json";
export const RECONCILIATION_PATH = "03_TRACEABILITY/reconciliation.json";
export const LINEAGE_PATH = "03_TRACEABILITY/source-lineage.csv";
export const CROSSWALK_PATH = "03_TRACEABILITY/import-crosswalk.csv";
export const PACKAGE_DIGEST_VERSION = "kauro-package-digest/1";

export const AREAS = ["01_IMPORT", "02_EXCEPTIONS", "03_TRACEABILITY", "04_DOCUMENTATION"] as const;
export type Area = (typeof AREAS)[number];

export const ARTIFACT_KINDS = ["MACHINE_IMPORT_CSV", "MACHINE_EVIDENCE_CSV", "MACHINE_EXCEPTION_CSV", "HUMAN_VIEW_CSV", "DOCUMENT"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The four destination objects of Migration Core 3.0.0, in the order its import instructions load them (parents first). */
export const OBJECT_ORDER = ["COMPANY", "CONTACT", "DEAL", "LEAD"] as const;
export type CoreObject = (typeof OBJECT_ORDER)[number];

const SOURCE_DISPOSITIONS = ["ISOLATED", "LEFTOVER", "MERGED_PROVEN", "OUTPUT", "REJECTED_INPUT"] as const;
const EDGE_DISPOSITIONS = ["DEDUPLICATED", "LEFTOVER", "OUTPUT", "UNRESOLVED"] as const;

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
  /** The agency's own file name: untrusted text, shown only escaped and only in SECURE_DETAIL/INTERNAL_EVIDENCE reports. */
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly format: string;
  readonly encoding: string;
  readonly dataRowCount: number;
  readonly rejectedRowCount: number;
}

export interface Reconciliation {
  readonly sourceRows: { readonly total: number; readonly ingested: number; readonly accountedFor: number; readonly withoutDisposition: number; readonly byDisposition: Readonly<Record<(typeof SOURCE_DISPOSITIONS)[number], number>> };
  readonly associations: { readonly sourceEdges: number; readonly accountedFor: number; readonly withoutDisposition: number; readonly byDisposition: Readonly<Record<(typeof EDGE_DISPOSITIONS)[number], number>> };
  readonly records: { readonly deliveredTotal: number; readonly byObject: Readonly<Record<CoreObject, number>> };
  readonly reasonCodeTally: Readonly<Record<string, number>>;
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
  readonly target: { readonly mode: string; readonly importMode: string; readonly adapterVersion: string | null; readonly targetContractHash: string | null };
  readonly inputs: readonly PackageInput[];
  readonly artifacts: readonly PackageArtifact[];
  readonly reconciliation: Reconciliation;
  /** Lineage rows by contribution kind and disposition, counted from `source-lineage.csv`. */
  readonly lineage: { readonly rows: number; readonly recordRows: number; readonly byKindDisposition: Readonly<Record<string, number>> };
  /** The destination object of each record import file, read from the crosswalk. */
  readonly importObjects: ReadonlyMap<string, CoreObject>;
}

export type PackageFiles = ReadonlyMap<string, Uint8Array>;

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A portable relative path: `/`-separated segments, no empty, `.` or `..` segment, no backslash, no control or bidi character. */
export function isSafePackagePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  if (/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function areaOf(path: string): Area | null {
  const first = path.split("/")[0];
  return (AREAS as readonly string[]).includes(first ?? "") ? (first as Area) : null;
}

/** Which kinds may live in which area (Migration Core `layout.ts`): only machine import files in 01_IMPORT, and nowhere else. */
function kindFitsArea(kind: ArtifactKind, area: Area, path: string): boolean {
  switch (kind) {
    case "MACHINE_IMPORT_CSV":
      return area === "01_IMPORT" && path.endsWith(".csv");
    case "MACHINE_EXCEPTION_CSV":
      return area === "02_EXCEPTIONS" && path.endsWith(".csv");
    case "MACHINE_EVIDENCE_CSV":
      return area === "03_TRACEABILITY" && path.endsWith(".csv");
    case "HUMAN_VIEW_CSV":
      return (area === "02_EXCEPTIONS" || path.startsWith("04_DOCUMENTATION/data-view/")) && path.endsWith(".csv");
    case "DOCUMENT":
      return (area === "03_TRACEABILITY" || area === "04_DOCUMENTATION") && (path.endsWith(".json") || path.endsWith(".md"));
  }
}

function closedKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((k) => Object.hasOwn(value, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const isAssociationFile = (path: string): boolean => path.split("/").includes("associations");

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
  const runId = manifest["runId"];
  const bundleId = manifest["bundleId"];
  const configHash = manifest["configHash"];
  if (typeof runId !== "string" || typeof bundleId !== "string" || typeof configHash !== "string" || !HEX64.test(configHash) || !isCount(manifest["relationshipCandidates"])) {
    problems.add("MANIFEST_MALFORMED", MANIFEST_PATH, "runId, bundleId, configHash or relationshipCandidates malformed");
  }
  const rawTarget = manifest["target"];
  let target: VerifiedPackage["target"] = { mode: "", importMode: "", adapterVersion: null, targetContractHash: null };
  if (isObject(rawTarget) && closedKeys(rawTarget, ["importMode", "mode"], ["adapterVersion", "targetContractHash"]) && typeof rawTarget["mode"] === "string" && typeof rawTarget["importMode"] === "string") {
    target = {
      mode: rawTarget["mode"],
      importMode: rawTarget["importMode"],
      adapterVersion: typeof rawTarget["adapterVersion"] === "string" ? rawTarget["adapterVersion"] : null,
      targetContractHash: typeof rawTarget["targetContractHash"] === "string" ? rawTarget["targetContractHash"] : null,
    };
  } else {
    problems.add("MANIFEST_MALFORMED", "manifest.json#/target", "target is not the closed target object");
  }

  // --- inputs -------------------------------------------------------------------------------------------------------------------
  const inputs: PackageInput[] = [];
  const rawInputs = manifest["inputs"];
  if (!Array.isArray(rawInputs)) problems.add("MANIFEST_MALFORMED", "manifest.json#/inputs", "inputs is not a list");
  else
    rawInputs.forEach((input: unknown, index) => {
      const subject = `manifest.json#/inputs/${index}`;
      if (!isObject(input) || !closedKeys(input, ["byteLength", "encoding", "encodingEvidence", "fileId", "format", "path", "sha256", "sheets"]) || !Array.isArray(input["sheets"])) {
        problems.add("MANIFEST_MALFORMED", subject, "input is not the closed input object");
        return;
      }
      let dataRowCount = 0;
      let rejectedRowCount = 0;
      for (const sheet of input["sheets"] as unknown[]) {
        if (!isObject(sheet) || !isCount(sheet["dataRowCount"]) || !isCount(sheet["rejectedRowCount"])) {
          problems.add("MANIFEST_MALFORMED", subject, "sheet counts malformed");
          return;
        }
        dataRowCount += sheet["dataRowCount"];
        rejectedRowCount += sheet["rejectedRowCount"];
      }
      const { fileId, path, sha256: hash, byteLength, format, encoding } = input;
      if (typeof fileId !== "string" || typeof path !== "string" || typeof hash !== "string" || !HEX64.test(hash) || !isCount(byteLength) || typeof format !== "string" || typeof encoding !== "string") {
        problems.add("MANIFEST_MALFORMED", subject, "input identity malformed");
        return;
      }
      inputs.push({ fileId, path, sha256: hash, byteLength, format, encoding, dataRowCount, rejectedRowCount });
    });

  // --- artifacts: closed inventory, bytes, hashes, record counts -------------------------------------------------------------------
  const artifacts: PackageArtifact[] = [];
  const tables = new Map<string, ReturnType<typeof readTable>>();
  const declared = new Set<string>();
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
      if (declared.has(path)) {
        problems.add("DUPLICATE_PATH", path, "the manifest names this path twice");
        return;
      }
      declared.add(path);
      if (typeof kind !== "string" || !(ARTIFACT_KINDS as readonly string[]).includes(kind) || typeof hash !== "string" || !HEX64.test(hash) || !isCount(byteLength) || (kind === "DOCUMENT" ? rowCount !== null : !isCount(rowCount))) {
        problems.add("MANIFEST_MALFORMED", path, "kind, sha256, byteLength or rowCount malformed (a DOCUMENT declares rowCount null, a CSV a count)");
        return;
      }
      const area = areaOf(path);
      if (area === null || !kindFitsArea(kind as ArtifactKind, area, path)) {
        problems.add("AREA_KIND_MISMATCH", path, `a ${kind} may not live at this path`);
        return;
      }
      const bytes = files.get(path);
      if (bytes === undefined) {
        problems.add("ARTIFACT_MISSING", path, "the manifest names a file the package does not hold");
        return;
      }
      if (bytes.byteLength !== byteLength || sha256(bytes) !== hash) {
        problems.add("ARTIFACT_BYTES_MISMATCH", path, "the file's length or SHA-256 differs from the manifest");
        return;
      }
      let counted: number | null = null;
      if (kind !== "DOCUMENT") {
        try {
          const table = readTable(bytes);
          tables.set(path, table);
          counted = table.rows.length;
        } catch (error) {
          problems.add("ARTIFACT_UNREADABLE", path, error instanceof CsvError ? error.message : "unreadable CSV");
          return;
        }
        if (counted !== rowCount) {
          problems.add("ARTIFACT_ROWS_MISMATCH", path, `the manifest declares ${rowCount} records, the file holds ${counted}`);
          return;
        }
      }
      artifacts.push({ path, area, kind: kind as ArtifactKind, sha256: hash, byteLength, rowCount: counted });
    });
  for (const path of files.keys()) {
    if (path !== MANIFEST_PATH && !declared.has(path)) problems.add("ARTIFACT_UNDECLARED", isSafePackagePath(path) ? path : "(unsafe path)", "the package holds a file the manifest does not name");
  }
  problems.throwIfAny();

  // --- reconciliation and its cross-checks ---------------------------------------------------------------------------------------
  const reconciliation = readReconciliation(files, problems, { runId: runId as string, bundleId: bundleId as string, configHash: configHash as string });
  problems.throwIfAny();
  const rec = reconciliation as Reconciliation;

  const importFiles = artifacts.filter((a) => a.kind === "MACHINE_IMPORT_CSV");
  const sumRows = (list: readonly PackageArtifact[]): number => list.reduce((s, a) => s + (a.rowCount ?? 0), 0);
  const recordFiles = importFiles.filter((a) => !isAssociationFile(a.path));
  const edgeFiles = importFiles.filter((a) => isAssociationFile(a.path));
  const mismatch = (subject: string, detail: string): void => problems.add("RECONCILIATION_MISMATCH", subject, detail);

  if (sumRows(recordFiles) !== rec.records.deliveredTotal) mismatch(RECONCILIATION_PATH, "records.deliveredTotal differs from the records in the import files");
  if (sumRows(edgeFiles) !== rec.associations.byDisposition.OUTPUT) mismatch(RECONCILIATION_PATH, "associations OUTPUT differs from the rows in the association import files");
  if (manifest["relationshipCandidates"] !== rec.associations.sourceEdges) mismatch(RECONCILIATION_PATH, "associations.sourceEdges differs from the manifest's relationshipCandidates");
  const inputRows = inputs.reduce((s, i) => s + i.dataRowCount, 0);
  if (inputRows !== rec.sourceRows.total) mismatch(RECONCILIATION_PATH, "sourceRows.total differs from the data rows the manifest's inputs declare");
  const exceptionRows = (name: string): number | undefined => artifacts.find((a) => a.path === `02_EXCEPTIONS/${name}`)?.rowCount ?? undefined;
  for (const [name, disposition] of [["isolated.csv", "ISOLATED"], ["leftovers.csv", "LEFTOVER"], ["rejected-input.csv", "REJECTED_INPUT"]] as const) {
    const rows = exceptionRows(name);
    if (rows === undefined) problems.add("ARTIFACT_MISSING", `02_EXCEPTIONS/${name}`, "a required exception table is absent");
    else if (rows !== rec.sourceRows.byDisposition[disposition]) mismatch(`02_EXCEPTIONS/${name}`, `its records differ from sourceRows ${disposition}`);
  }

  // lineage: one row per source row, with its contribution kind and disposition
  const byKindDisposition: Record<string, number> = {};
  let lineageRows = 0;
  let recordRows = 0;
  const lineage = tables.get(LINEAGE_PATH);
  if (lineage === undefined) problems.add("ARTIFACT_MISSING", LINEAGE_PATH, "the package has no source lineage");
  else {
    const kindAt = lineage.header.indexOf("contribution_kind");
    const dispositionAt = lineage.header.indexOf("disposition");
    if (kindAt < 0 || dispositionAt < 0) problems.add("ARTIFACT_UNREADABLE", LINEAGE_PATH, "lineage lacks contribution_kind or disposition");
    else {
      for (const row of lineage.rows) {
        const key = `${row[kindAt]}/${row[dispositionAt]}`;
        byKindDisposition[key] = (byKindDisposition[key] ?? 0) + 1;
        if (row[kindAt] === "RECORD") recordRows++;
      }
      lineageRows = lineage.rows.length;
      if (lineageRows !== rec.sourceRows.total) mismatch(LINEAGE_PATH, "lineage rows differ from sourceRows.total");
      for (const disposition of SOURCE_DISPOSITIONS) {
        const inLineage = Object.entries(byKindDisposition).filter(([k]) => k.endsWith(`/${disposition}`)).reduce((s, [, n]) => s + n, 0);
        if (inLineage !== rec.sourceRows.byDisposition[disposition]) mismatch(LINEAGE_PATH, `lineage ${disposition} rows differ from the reconciliation`);
      }
      if ((byKindDisposition["RECORD/OUTPUT"] ?? 0) !== rec.records.deliveredTotal) mismatch(LINEAGE_PATH, "lineage RECORD/OUTPUT rows differ from records.deliveredTotal");
    }
  }

  // crosswalk: which object each record import file holds, and that it holds exactly the records the file does
  const importObjects = new Map<string, CoreObject>();
  const crosswalk = tables.get(CROSSWALK_PATH);
  if (crosswalk === undefined) problems.add("ARTIFACT_MISSING", CROSSWALK_PATH, "the package has no import crosswalk");
  else {
    const pathAt = crosswalk.header.indexOf("import_path");
    const objectAt = crosswalk.header.indexOf("object");
    if (pathAt < 0 || objectAt < 0) problems.add("ARTIFACT_UNREADABLE", CROSSWALK_PATH, "crosswalk lacks import_path or object");
    else {
      const perFile = new Map<string, number>();
      for (const row of crosswalk.rows) {
        const path = row[pathAt] ?? "";
        const object = row[objectAt] ?? "";
        perFile.set(path, (perFile.get(path) ?? 0) + 1);
        if (!(OBJECT_ORDER as readonly string[]).includes(object)) problems.add("IMPORT_OBJECT_UNKNOWN", CROSSWALK_PATH, "the crosswalk names an object this model does not know");
        else {
          const known = importObjects.get(path);
          if (known !== undefined && known !== object) mismatch(CROSSWALK_PATH, "one import file is crosswalked to two objects");
          importObjects.set(path, object as CoreObject);
        }
      }
      for (const file of recordFiles) {
        if ((perFile.get(file.path) ?? 0) !== file.rowCount) mismatch(file.path, "the crosswalk rows for this file differ from its records");
        if (!importObjects.has(file.path)) problems.add("IMPORT_OBJECT_UNKNOWN", file.path, "no crosswalk row names this file's object");
      }
      for (const path of perFile.keys()) if (!recordFiles.some((f) => f.path === path)) mismatch(CROSSWALK_PATH, "the crosswalk names a file that is not a record import file");
      for (const object of OBJECT_ORDER) {
        const delivered = recordFiles.filter((f) => importObjects.get(f.path) === object).reduce((s, f) => s + (f.rowCount ?? 0), 0);
        if (delivered !== rec.records.byObject[object]) mismatch(RECONCILIATION_PATH, `records.byObject.${object} differs from its import files`);
      }
    }
  }
  problems.throwIfAny();

  const paths = [...files.keys()].sort(compareCodeUnits);
  const digestText = `${PACKAGE_DIGEST_VERSION}\n${paths.map((p) => `${p} ${sha256(files.get(p) as Uint8Array)}\n`).join("")}`;
  return {
    packageDigest: sha256(digestText),
    manifestSha256: sha256(manifestBytes),
    coreVersion: SUPPORTED_CORE_VERSION,
    packageFormat: SUPPORTED_PACKAGE_FORMAT,
    runId: runId as string,
    bundleId: bundleId as string,
    configHash: configHash as string,
    target,
    inputs,
    artifacts,
    reconciliation: rec,
    lineage: { rows: lineageRows, recordRows, byKindDisposition },
    importObjects,
  };
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
  const tally = raw["reasonCodeTally"];
  if (!isObject(tally) || !Object.values(tally).every(isCount)) return bad("reasonCodeTally malformed");
  const rec: Reconciliation = {
    sourceRows: { total: rows["total"] as number, ingested: rows["ingested"] as number, accountedFor: rows["accountedFor"] as number, withoutDisposition: rows["withoutDisposition"] as number, byDisposition: rowCounts },
    associations: { sourceEdges: edges["sourceEdges"] as number, accountedFor: edges["accountedFor"] as number, withoutDisposition: edges["withoutDisposition"] as number, byDisposition: edgeCounts },
    records: { deliveredTotal: records["deliveredTotal"] as number, byObject },
    reasonCodeTally: tally as Record<string, number>,
  };
  // The equations the core states, recomputed rather than read from its `equationHolds` flags.
  const sum = (o: Readonly<Record<string, number>>): number => Object.values(o).reduce((s, n) => s + n, 0);
  if (sum(rec.sourceRows.byDisposition) + rec.sourceRows.withoutDisposition !== rec.sourceRows.total || rec.sourceRows.accountedFor !== sum(rec.sourceRows.byDisposition))
    problems.add("RECONCILIATION_MISMATCH", RECONCILIATION_PATH, "source rows do not conserve: dispositions do not sum to the total");
  if (sum(rec.associations.byDisposition) + rec.associations.withoutDisposition !== rec.associations.sourceEdges || rec.associations.accountedFor !== sum(rec.associations.byDisposition))
    problems.add("RECONCILIATION_MISMATCH", RECONCILIATION_PATH, "relationships do not conserve: dispositions do not sum to the source edges");
  if (sum(rec.records.byObject) !== rec.records.deliveredTotal) problems.add("RECONCILIATION_MISMATCH", RECONCILIATION_PATH, "records.byObject does not sum to deliveredTotal");
  return rec;
}
