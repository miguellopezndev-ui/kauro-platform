/**
 * The package structure of an untrusted workbook (ECMA-376 Open Packaging Conventions as SpreadsheetML uses them; 04 "XLSX parser
 * requirements": validate required workbook parts, relationships, sheet references, styles and shared strings; external links,
 * macros, OLE objects and encryption are not executed or transparently ignored as harmless — the inspection policy identifies the
 * precise rejection).
 *
 * Active content is refused as ACTIVE_CONTENT, by part name (a VBA project, embedded OLE objects, ActiveX controls, external links,
 * data connections, query tables, Excel 4.0 macro sheets, dialog sheets, custom UI), by content type (macro-enabled workbook, VBA
 * project, ActiveX, OLE object) and by relationship: every relationship whose target is external is refused
 * (EXTERNAL_RELATIONSHIP) except a worksheet hyperlink, which is inert metadata the inspection never follows and discloses on its
 * table (EXTERNAL_HYPERLINKS; decision D-DP-2); an internal target that leaves the package root is CORRUPT_STRUCTURE.
 *
 * Loaded inside the isolated child.
 */
import { InspectionRefusal, type Finding } from "../errors.js";
import { expandEntry, partDigestOf, type ArchiveEntry, type ExpansionMeter, type OpenedArchive } from "../archive/zip.js";
import { XmlScanner, localName, prefixedAttribute, type XmlAttributes, type XmlLimits } from "../xml/scanner.js";

export interface PackageIndex {
  readonly archive: OpenedArchive;
  /** Entries by collision key (NFC, case-folded), files only. */
  readonly byKey: ReadonlyMap<string, ArchiveEntry>;
}

export function indexPackage(archive: OpenedArchive): PackageIndex {
  const byKey = new Map<string, ArchiveEntry>();
  for (const e of archive.entries) if (!e.directory) byKey.set(e.key, e);
  return { archive, byKey };
}

export function lookup(index: PackageIndex, partName: string): ArchiveEntry | undefined {
  return index.byKey.get(partName.normalize("NFC").toLowerCase());
}

/** Parses one XML part with the hardened scanner, handing its events to `events`. */
export async function scanXmlPart(index: PackageIndex, entry: ArchiveEntry, meter: ExpansionMeter, limits: XmlLimits, events: ConstructorParameters<typeof XmlScanner>[0]): Promise<void> {
  const scanner = new XmlScanner(events, limits, partDigestOf(entry.name));
  for await (const chunk of expandEntry(index.archive, entry, meter)) scanner.write(chunk);
  scanner.end();
}

const ACTIVE_PART_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)vbaproject\.bin$/, "MACRO_PROJECT"],
  [/(^|\/)vbaprojectsignature[^/]*\.bin$/, "MACRO_PROJECT"],
  [/(^|\/)vbadata\.xml$/, "MACRO_PROJECT"],
  [/^xl\/embeddings\//, "EMBEDDED_OBJECT"],
  [/^xl\/activex\//, "ACTIVEX_CONTROL"],
  [/^xl\/externallinks\//, "EXTERNAL_LINK"],
  [/^xl\/connections\.xml$/, "DATA_CONNECTION"],
  [/^xl\/querytables\//, "QUERY_TABLE"],
  [/^xl\/macrosheets\//, "MACRO_SHEET"],
  [/^xl\/dialogsheets\//, "DIALOG_SHEET"],
  [/^customui\//, "CUSTOM_UI"],
];

const ACTIVE_CONTENT_TYPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/macroenabled/i, "MACRO_ENABLED_WORKBOOK"],
  [/vbaproject/i, "MACRO_PROJECT"],
  [/activex/i, "ACTIVEX_CONTROL"],
  [/oleobject/i, "EMBEDDED_OBJECT"],
];

const ACTIVE_RELATIONSHIP_TYPES = /\/(vbaProject|oleObject|package|activeXControl|activeXControlBinary|externalLink|externalLinkPath|connections|queryTable|control|attachedTemplate|frame|xlMacrosheet|xlIntlMacrosheet|macrosheet|dialogsheet|extensibility)$/i;

/** Active parts by name (checked before any byte is expanded). */
export function activePartFindings(index: PackageIndex): Finding[] {
  const out: Finding[] = [];
  for (const [key, entry] of index.byKey) {
    for (const [pattern, code] of ACTIVE_PART_NAMES) {
      if (pattern.test(key)) {
        out.push({ refusal: "ACTIVE_CONTENT", code, part: partDigestOf(entry.name) });
        break;
      }
    }
  }
  return out;
}

export interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly external: boolean;
  /** The resolved part name for an internal target. */
  readonly target?: string;
}

/** The source part of a relationships part: `a/b/_rels/c.xml.rels` belongs to `a/b/c.xml`, `_rels/.rels` to the package. */
export function sourceOfRels(relsName: string): string | undefined {
  const m = /^(.*?)_rels\/([^/]*)\.rels$/.exec(relsName);
  if (m === null) return undefined;
  return `${m[1] ?? ""}${m[2] ?? ""}`;
}

/** Resolves a relationship target against its source part; undefined when it leaves the package root. */
export function resolveTarget(sourcePart: string, target: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  if (decoded.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) return undefined;
  const base = decoded.startsWith("/") ? [] : sourcePart.split("/").slice(0, -1);
  const out = [...base];
  for (const seg of decoded.replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(seg);
  }
  return out.length === 0 ? undefined : out.join("/");
}

export interface RelationshipsResult {
  readonly relationships: ReadonlyArray<Relationship>;
  readonly findings: ReadonlyArray<Finding>;
  readonly externalHyperlinks: number;
}

/** Parses a relationships part; external targets and targets leaving the package are findings (see the module comment). */
export async function readRelationships(index: PackageIndex, entry: ArchiveEntry, meter: ExpansionMeter, limits: XmlLimits): Promise<RelationshipsResult> {
  const source = sourceOfRels(entry.name) ?? "";
  const relationships: Relationship[] = [];
  const findings: Finding[] = [];
  let externalHyperlinks = 0;
  const part = partDigestOf(entry.name);
  await scanXmlPart(index, entry, meter, limits, {
    open(name: string, attributes: XmlAttributes): void {
      if (name !== "Relationship") return;
      const id = attributes.get("Id") ?? "";
      const type = attributes.get("Type") ?? "";
      const target = attributes.get("Target") ?? "";
      const external = (attributes.get("TargetMode") ?? "Internal") === "External";
      if (external) {
        if (/\/hyperlink$/i.test(type)) externalHyperlinks += 1;
        else findings.push({ refusal: "ACTIVE_CONTENT", code: "EXTERNAL_RELATIONSHIP", part });
        relationships.push({ id, type, external: true });
        return;
      }
      if (ACTIVE_RELATIONSHIP_TYPES.test(type)) findings.push({ refusal: "ACTIVE_CONTENT", code: "ACTIVE_RELATIONSHIP", part });
      const resolved = resolveTarget(source, target);
      if (resolved === undefined) {
        findings.push({ refusal: "CORRUPT_STRUCTURE", code: "RELATIONSHIP_TARGET_TRAVERSAL", part });
        return;
      }
      relationships.push({ id, type, external: false, target: resolved });
    },
    close(): void {},
    text(): void {},
  });
  return { relationships, findings, externalHyperlinks };
}

export interface WorkbookSheet {
  /** Worksheet index in workbook order (chart sheets are not tables). */
  readonly ordinal: number;
  readonly name: string;
  readonly visibility: "VISIBLE" | "HIDDEN" | "VERY_HIDDEN";
  readonly partName: string;
}

export interface WorkbookStructure {
  readonly workbookPart: string;
  readonly sheets: ReadonlyArray<WorkbookSheet>;
  readonly sharedStringsPart?: string;
  readonly date1904: boolean;
  /** Part names (collision keys) the structure step already expanded. */
  readonly expanded: ReadonlySet<string>;
  readonly findings: ReadonlyArray<Finding>;
}

const RELS_KEY = "_rels/.rels";
const CONTENT_TYPES_KEY = "[content_types].xml";

/**
 * Reads [Content_Types].xml, the package relationships, the workbook and its relationships (in that order), and returns the
 * worksheets in workbook order. Missing required parts are CORRUPT_STRUCTURE; active content is ACTIVE_CONTENT (findings).
 */
export async function readWorkbookStructure(index: PackageIndex, meter: ExpansionMeter, limits: XmlLimits): Promise<WorkbookStructure> {
  const findings: Finding[] = [];
  const expanded = new Set<string>();
  const contentTypes = index.byKey.get(CONTENT_TYPES_KEY);
  if (contentTypes === undefined) throw new InspectionRefusal("UNSUPPORTED_FORMAT", "ZIP_NOT_OOXML");
  let mainType: string | undefined;
  await scanXmlPart(index, contentTypes, meter, limits, {
    open(name: string, attributes: XmlAttributes): void {
      if (name !== "Override" && name !== "Default") return;
      const type = attributes.get("ContentType") ?? "";
      for (const [pattern, code] of ACTIVE_CONTENT_TYPES) {
        if (pattern.test(type)) {
          findings.push({ refusal: "ACTIVE_CONTENT", code, part: partDigestOf(contentTypes.name) });
          break;
        }
      }
      if (name === "Override" && /spreadsheetml\.(sheet|template)\.main\+xml$/i.test(type)) mainType = (attributes.get("PartName") ?? "").replace(/^\/+/, "");
    },
    close(): void {},
    text(): void {},
  });
  expanded.add(CONTENT_TYPES_KEY);
  const rootRels = index.byKey.get(RELS_KEY);
  if (rootRels === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "MISSING_PART");
  const root = await readRelationships(index, rootRels, meter, limits);
  expanded.add(RELS_KEY);
  findings.push(...root.findings);
  const office = root.relationships.find((r) => !r.external && /\/officeDocument$/i.test(r.type));
  const workbookPart = office?.target;
  if (workbookPart === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "MISSING_PART");
  if (mainType === undefined || mainType.normalize("NFC").toLowerCase() !== workbookPart.normalize("NFC").toLowerCase()) {
    if (findings.some((f) => f.refusal === "ACTIVE_CONTENT")) return { workbookPart, sheets: [], date1904: false, expanded, findings };
    throw new InspectionRefusal("UNSUPPORTED_FORMAT", "WORKBOOK_CONTENT_TYPE");
  }
  const workbook = lookup(index, workbookPart);
  if (workbook === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "MISSING_PART");
  const declared: Array<{ readonly name: string; readonly state: string; readonly rid: string }> = [];
  let date1904 = false;
  await scanXmlPart(index, workbook, meter, limits, {
    open(name: string, attributes: XmlAttributes): void {
      if (name === "sheet") declared.push({ name: attributes.get("name") ?? "", state: attributes.get("state") ?? "visible", rid: prefixedAttribute(attributes, "id") ?? "" });
      else if (name === "workbookPr") date1904 = /^(1|true)$/.test(attributes.get("date1904") ?? "");
      else if (name === "externalReference") findings.push({ refusal: "ACTIVE_CONTENT", code: "EXTERNAL_REFERENCE", part: partDigestOf(workbook.name) });
    },
    close(): void {},
    text(): void {},
  });
  expanded.add(workbook.key);
  const workbookRelsName = `${workbookPart.split("/").slice(0, -1).map((s) => `${s}/`).join("")}_rels/${workbookPart.split("/").pop() ?? ""}.rels`;
  const workbookRels = lookup(index, workbookRelsName);
  if (workbookRels === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "MISSING_PART");
  const rels = await readRelationships(index, workbookRels, meter, limits);
  expanded.add(workbookRels.key);
  findings.push(...rels.findings);
  const byId = new Map(rels.relationships.map((r) => [r.id, r]));
  const sheets: WorkbookSheet[] = [];
  for (const d of declared) {
    const rel = byId.get(d.rid);
    if (rel === undefined || rel.external || rel.target === undefined) {
      findings.push({ refusal: "CORRUPT_STRUCTURE", code: "SHEET_REFERENCE_INVALID", part: partDigestOf(workbook.name) });
      continue;
    }
    if (!/\/worksheet$/i.test(rel.type)) continue;
    if (lookup(index, rel.target) === undefined) {
      findings.push({ refusal: "CORRUPT_STRUCTURE", code: "MISSING_PART", part: partDigestOf(workbook.name) });
      continue;
    }
    const visibility = d.state === "hidden" ? "HIDDEN" : d.state === "veryHidden" ? "VERY_HIDDEN" : "VISIBLE";
    sheets.push({ ordinal: sheets.length, name: d.name, visibility, partName: (lookup(index, rel.target) as ArchiveEntry).name });
  }
  const sst = rels.relationships.find((r) => !r.external && /\/sharedStrings$/i.test(r.type));
  if (sst?.target !== undefined && lookup(index, sst.target) === undefined) findings.push({ refusal: "CORRUPT_STRUCTURE", code: "MISSING_PART", part: partDigestOf(workbookRels.name) });
  if (sheets.length === 0 && findings.length === 0) findings.push({ refusal: "CORRUPT_STRUCTURE", code: "NO_WORKSHEETS", part: partDigestOf(workbook.name) });
  const sharedStringsPart = sst?.target === undefined ? undefined : lookup(index, sst.target)?.name;
  return sharedStringsPart === undefined ? { workbookPart, sheets, date1904, expanded, findings } : { workbookPart, sheets, sharedStringsPart, date1904, expanded, findings };
}

/** Whether a part is XML the scanner must parse (every XML part is checked: no DTD, depth, well-formedness). */
export function isXmlPart(name: string): boolean {
  return /\.(xml|rels)$/i.test(name);
}

export { localName };
