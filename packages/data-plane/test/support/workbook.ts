// A minimal SpreadsheetML writer for the test corpus: the parts a real workbook has ([Content_Types].xml, the package and workbook
// relationships, the workbook, worksheets, shared strings, styles), with hooks to inject what an attacker would (a DTD, an
// external relationship, an active part) or what an agency's workbook holds (hidden sheets, rows and columns, merged cells,
// formulas with or without their cached values). The test knows every value it writes: its counts are independent of the parser.
import { buildZip, type ZipItem } from "./zip.js";

export type Cell =
  | string
  | number
  | null
  | undefined
  | { readonly inline: string }
  | { readonly f: string; readonly v?: string | number; readonly t?: "str" | "n" | "e" | "b" }
  | { readonly error: string };

export interface RowSpec {
  /** 1-based row index (default: the previous row + 1). */
  readonly r?: number;
  readonly hidden?: boolean;
  readonly cells: ReadonlyArray<Cell>;
}

export interface SheetSpec {
  readonly name: string;
  readonly state?: "hidden" | "veryHidden";
  readonly rows: ReadonlyArray<RowSpec | ReadonlyArray<Cell>>;
  readonly hiddenColumns?: ReadonlyArray<readonly [number, number]>;
  readonly merges?: ReadonlyArray<string>;
  readonly zeroHeight?: boolean;
  readonly rels?: ReadonlyArray<{ readonly id: string; readonly type: string; readonly target: string; readonly external?: boolean }>;
  /** XML placed before the root element (an attacker's DOCTYPE). */
  readonly prologue?: string;
  /** XML placed after sheetData (hyperlinks, oleObjects). */
  readonly after?: string;
}

export interface WorkbookSpec {
  readonly sheets: ReadonlyArray<SheetSpec>;
  /** Strings as inline strings instead of shared strings. */
  readonly inlineStrings?: boolean;
  readonly extra?: ReadonlyArray<ZipItem>;
  readonly workbookRelsExtra?: string;
  readonly contentTypesExtra?: string;
  readonly mainContentType?: string;
}

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
export const REL = {
  officeDocument: `${R}/officeDocument`,
  worksheet: `${R}/worksheet`,
  sharedStrings: `${R}/sharedStrings`,
  styles: `${R}/styles`,
  hyperlink: `${R}/hyperlink`,
  oleObject: `${R}/oleObject`,
  attachedTemplate: `${R}/attachedTemplate`,
  externalLink: `${R}/externalLink`,
};

export function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function colName(n: number): string {
  let s = "";
  let v = n;
  while (v > 0) {
    const m = (v - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

export function workbookItems(spec: WorkbookSpec): ZipItem[] {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const sst = (value: string): number => {
    let i = sharedIndex.get(value);
    if (i === undefined) {
      i = shared.length;
      shared.push(value);
      sharedIndex.set(value, i);
    }
    return i;
  };
  const cellXml = (ref: string, cell: Cell): string => {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
    if (typeof cell === "string") return spec.inlineStrings === true ? `<c r="${ref}" t="inlineStr"><is><t>${xmlText(cell)}</t></is></c>` : `<c r="${ref}" t="s"><v>${sst(cell)}</v></c>`;
    if ("inline" in cell) return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.inline)}</t></is></c>`;
    if ("error" in cell) return `<c r="${ref}" t="e"><v>${xmlText(cell.error)}</v></c>`;
    const t = cell.t === undefined || cell.t === "n" ? "" : ` t="${cell.t}"`;
    const v = cell.v === undefined ? "" : `<v>${xmlText(String(cell.v))}</v>`;
    return `<c r="${ref}"${t}><f>${xmlText(cell.f)}</f>${v}</c>`;
  };
  const items: ZipItem[] = [];
  const sheetEntries: string[] = [];
  const workbookRels: string[] = [];
  const overrides: string[] = [];
  spec.sheets.forEach((sheet, i) => {
    const n = i + 1;
    let r = 0;
    const rows = sheet.rows.map((row) => {
      const spec2: RowSpec = Array.isArray(row) ? { cells: row as ReadonlyArray<Cell> } : (row as RowSpec);
      r = spec2.r ?? r + 1;
      const cells = spec2.cells.map((c, k) => cellXml(`${colName(k + 1)}${r}`, c)).join("");
      return `<row r="${r}"${spec2.hidden === true ? ' hidden="1"' : ""}>${cells}</row>`;
    });
    const cols = sheet.hiddenColumns === undefined || sheet.hiddenColumns.length === 0 ? "" : `<cols>${sheet.hiddenColumns.map(([a, b]) => `<col min="${a}" max="${b}" hidden="1"/>`).join("")}</cols>`;
    const merges = sheet.merges === undefined || sheet.merges.length === 0 ? "" : `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`;
    const format = sheet.zeroHeight === true ? '<sheetFormatPr defaultRowHeight="15" zeroHeight="1"/>' : "";
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${sheet.prologue ?? ""}<worksheet xmlns="${NS}" xmlns:r="${R}">${format}${cols}<sheetData>${rows.join("")}</sheetData>${merges}${sheet.after ?? ""}</worksheet>`;
    items.push({ name: `xl/worksheets/sheet${n}.xml`, data: xml });
    overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    sheetEntries.push(`<sheet name="${xmlText(sheet.name)}" sheetId="${n}"${sheet.state === undefined ? "" : ` state="${sheet.state}"`} r:id="rId${n}"/>`);
    workbookRels.push(`<Relationship Id="rId${n}" Type="${REL.worksheet}" Target="worksheets/sheet${n}.xml"/>`);
    if (sheet.rels !== undefined && sheet.rels.length > 0) {
      const rels = sheet.rels.map((x) => `<Relationship Id="${x.id}" Type="${x.type}" Target="${xmlText(x.target)}"${x.external === true ? ' TargetMode="External"' : ""}/>`).join("");
      items.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${rels}</Relationships>` });
    }
  });
  const base = spec.sheets.length;
  workbookRels.push(`<Relationship Id="rId${base + 1}" Type="${REL.styles}" Target="styles.xml"/>`);
  if (spec.inlineStrings !== true) workbookRels.push(`<Relationship Id="rId${base + 2}" Type="${REL.sharedStrings}" Target="sharedStrings.xml"/>`);
  const mainType = spec.mainContentType ?? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${mainType}"/>${overrides.join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${spec.inlineStrings === true ? "" : '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'}${spec.contentTypesExtra ?? ""}</Types>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${R}"><workbookPr/><sheets>${sheetEntries.join("")}</sheets></workbook>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${NS}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellXfs count="1"><xf/></cellXfs></styleSheet>`;
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${NS}" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join("")}</sst>`;
  const head: ZipItem[] = [
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL.officeDocument}" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${workbookRels.join("")}${spec.workbookRelsExtra ?? ""}</Relationships>` },
    { name: "xl/styles.xml", data: styles },
  ];
  const tail: ZipItem[] = spec.inlineStrings === true ? [] : [{ name: "xl/sharedStrings.xml", data: sharedStrings }];
  return [...head, ...items, ...tail, ...(spec.extra ?? [])];
}

export function buildWorkbook(spec: WorkbookSpec): Buffer {
  return buildZip(workbookItems(spec));
}
