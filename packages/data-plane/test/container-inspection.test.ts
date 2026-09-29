// The container inspector against a corpus built in the test (S024 "XLSX contains traversal, duplicate archive entries, XML
// entities or excessive expansion -> Reject without outside writes, network access or unbounded decompression"; 04 "XLSX parser
// requirements" and "CSV parser requirements"; decision D-ISO-1, B07-F6). Every inspection runs the real inspector in its
// isolated child under the policy limits of this edition (the registry's 1 GiB per part and 20 GiB total). The observers are
// checked against independent truth: a sentinel file outside every scratch, a TCP listener of the test that counts the
// connections it receives, the scratch left empty, and the decompressed-byte counter against the bound. Each observer has its
// negative control: a probe that writes outside the scratch, connects, resolves, fetches, requests, spawns and starts a worker
// under the very same flags and preload — and, to show why the hooks exist, a connection under the permission model without them.
// The OS-level egress denial of a production worker host is LATER (B15) and is not claimed here.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createDeflateRaw, deflateRawSync } from "node:zlib";
import type { ContainerInspection } from "@kauro/application";
import { INPUT_ENVELOPE, parserProfileHashOf } from "@kauro/domain";
import { ARCHIVE_BOUNDS, INSPECTOR_VERSION, IsolatedContainerInspector, IsolatedTablePreviewReader, PreviewFailure, inspectionLimits, parserProfileHashOfInspection, partDigestOf, runIsolated, sandboxFlags } from "../src/index.js";
import { freshDir, listener, removeDir, sentinel, source, type Listener, type Sentinel } from "./support/harness.js";
import { REL, buildWorkbook, workbookItems, type Cell, type SheetSpec } from "./support/workbook.js";
import { patternedText } from "./support/patterns.js";
import { buildOverlappingZip, buildZip, type ZipItem } from "./support/zip.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GIB = 1_073_741_824;
const limits = inspectionLimits();
const inspector = new IsolatedContainerInspector();
let scratch: string;
let guard: Sentinel;
let net: Listener;

before(async () => {
  scratch = freshDir("scratch");
  guard = sentinel();
  net = await listener();
});

after(async () => {
  await net.close();
  removeDir(scratch);
  removeDir(guard.dir);
});

async function inspect(bytes: Buffer, declaredFormat: "CSV" | "XLSX" = "XLSX", overrides: { readonly observedBytes?: number; readonly chunk?: number; readonly fileBytes?: number } = {}): Promise<ContainerInspection> {
  const result = await inspector.inspect({
    open: source(bytes, overrides.chunk),
    declaredFormat,
    observedBytes: overrides.observedBytes ?? bytes.length,
    limits: overrides.fileBytes === undefined ? limits : { ...limits, fileBytes: overrides.fileBytes },
    scratchDir: scratch,
  });
  // the attempt's own directory is gone; nothing else was ever written into the scratch
  assert.deepEqual(readdirSync(scratch), [], "the inspection leaves its scratch empty");
  return result;
}

function codes(r: ContainerInspection): string[] {
  return r.problems.map((p) => p.code);
}

/** The observers of S024: nothing written outside, no network attempt, no process, decompression within the bound. */
function assertIsolated(r: ContainerInspection, bound: number): void {
  assert.equal(r.isolation.mechanism, "NODE_PERMISSION_CHILD");
  assert.equal(r.isolation.outsideWriteAttempts, 0);
  assert.equal(r.isolation.networkAttempts, 0);
  assert.equal(r.isolation.processAttempts, 0);
  assert.ok(r.isolation.decompressedBytes <= bound, `decompressed ${r.isolation.decompressedBytes} > bound ${bound}`);
  assert.equal(r.isolation.osNetworkDenied, undefined, "the OS-level egress denial is not measured here (LATER: B15)");
  assert.ok(guard.unchanged(), "the sentinel outside the scratch is unchanged");
  assert.equal(net.connections(), 0, "the test's listener received no connection");
}

function assertRefused(r: ContainerInspection, refusal: NonNullable<ContainerInspection["refusal"]>, code: string, bytes: number): void {
  assert.equal(r.refusal, refusal, `${code}: ${JSON.stringify(r.problems)}`);
  assert.ok(codes(r).includes(code), `expected ${code} in ${JSON.stringify(codes(r))}`);
  assert.equal(r.structureStatus, "STRUCTURE_INVALID");
  assert.deepEqual(r.tables, []);
  assert.deepEqual(r.expectedScanParts.map((p) => [p.partKind, p.bytes]), [["CONTAINER", bytes]], "a refused file expects only its container to be scanned");
}

const BENIGN: ReadonlyArray<SheetSpec> = [{ name: "Contacts", rows: [["Id", "Name"], [1, "Ana"], [2, "Bo"]] }];

/** A deflate stream of `total` bytes whose 64 KiB blocks begin with 300 pseudo-random bytes: about 100:1, under the ratio bound. */
async function patternStream(total: number): Promise<Buffer> {
  const deflate = createDeflateRaw({ level: 1 });
  const out: Buffer[] = [];
  deflate.on("data", (c: Buffer) => out.push(c));
  const ended = new Promise<void>((resolve) => deflate.on("end", () => resolve()));
  let seed = 7;
  for (let written = 0; written < total; ) {
    const n = Math.min(65_536, total - written);
    const block = Buffer.alloc(n);
    for (let i = 0; i < Math.min(300, n); i++) {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      block[i] = seed >>> 24;
    }
    written += n;
    if (!deflate.write(block)) await new Promise<void>((resolve) => deflate.once("drain", () => resolve()));
  }
  deflate.end();
  await ended;
  return Buffer.concat(out);
}

test("S024: an XLSX with a traversal entry, duplicate entries, an XML entity or DTD, an external relationship, or an expansion beyond 1 GiB per part / 20 GiB total is refused CORRUPT_STRUCTURE, ACTIVE_CONTENT or RESOURCE_LIMIT — no write outside the attempt scratch, no network attempt, decompression stopped at the bound", { timeout: 600_000 }, async () => {
  // the bounds are the registry's intake envelope, not test values
  assert.equal(limits.xlsxExpandedPartBytes, INPUT_ENVELOPE.xlsxExpandedPartBytes);
  assert.equal(limits.xlsxExpandedPartBytes, GIB);
  assert.equal(limits.xlsxExpandedTotalBytes, 20 * GIB);
  const partBound = limits.xlsxExpandedPartBytes;
  const totalBound = limits.xlsxExpandedTotalBytes;
  const withExtra = (extra: ReadonlyArray<ZipItem>, sheets: ReadonlyArray<SheetSpec> = BENIGN): Buffer => buildWorkbook({ sheets, extra });

  // positive neighbour: the benign workbook passes every check under the same observers
  const benign = buildWorkbook({ sheets: BENIGN });
  const ok = await inspect(benign);
  assert.equal(ok.refusal, undefined);
  assert.equal(ok.structureStatus, "STRUCTURE_VALID");
  assert.equal(ok.detectedFormat, "XLSX");
  assertIsolated(ok, totalBound);

  // traversal, absolute and backslash paths: refused before a single byte is decompressed
  for (const [name, code] of [
    ["../../evil.xml", "PATH_TRAVERSAL"],
    ["xl/../../evil.xml", "PATH_TRAVERSAL"],
    ["/etc/evil.xml", "ABSOLUTE_PATH"],
    ["C:/evil.xml", "ABSOLUTE_PATH"],
    ["xl\\..\\..\\evil.xml", "PATH_BACKSLASH"],
  ] as const) {
    const bytes = withExtra([{ name, data: "<x/>" }]);
    const r = await inspect(bytes);
    assertRefused(r, "CORRUPT_STRUCTURE", code, bytes.length);
    assert.equal(r.isolation.decompressedBytes, 0, `${code}: nothing expanded`);
    assertIsolated(r, 0);
  }

  // duplicate entries: the same name twice, and names that collide once normalized (case-folded; NFC against NFD)
  const items = workbookItems({ sheets: BENIGN });
  const sheet = items.find((i) => i.name === "xl/worksheets/sheet1.xml") as ZipItem;
  for (const extra of [[{ ...sheet }], [{ ...sheet, name: "XL/Worksheets/Sheet1.xml" }], [{ name: "xl/caf\u00e9.xml", data: "<x/>" }, { name: "xl/cafe\u0301.xml", data: "<x/>" }]]) {
    const bytes = buildZip([...items, ...extra]);
    const r = await inspect(bytes);
    assertRefused(r, "CORRUPT_STRUCTURE", "DUPLICATE_ENTRY", bytes.length);
    assert.equal(r.isolation.decompressedBytes, 0);
    assertIsolated(r, 0);
  }

  // hostile layout and entry kinds, refused on the metadata alone: overlapping entries (the same bytes expanded twice), a symlink
  const overlapping = buildOverlappingZip();
  const overlapResult = await inspect(overlapping);
  assertRefused(overlapResult, "CORRUPT_STRUCTURE", "OVERLAPPING_ENTRIES", overlapping.length);
  assert.equal(overlapResult.isolation.decompressedBytes, 0);
  assertIsolated(overlapResult, 0);
  const symlink = withExtra([{ name: "xl/link.xml", data: "/etc/passwd", method: 0, versionMadeBy: (3 << 8) | 20, externalAttributes: (0o120777 << 16) >>> 0 }]);
  const symlinkResult = await inspect(symlink);
  assertRefused(symlinkResult, "CORRUPT_STRUCTURE", "SYMLINK_ENTRY", symlink.length);
  assertIsolated(symlinkResult, 0);
  // a relationship whose internal target climbs out of the package root
  const escaping = buildWorkbook({ sheets: [{ ...(BENIGN[0] as SheetSpec), rels: [{ id: "rId9", type: REL.oleObject.replace("oleObject", "image"), target: "../../../outside.xml" }] }] });
  const escapingResult = await inspect(escaping);
  assertRefused(escapingResult, "CORRUPT_STRUCTURE", "RELATIONSHIP_TARGET_TRAVERSAL", escaping.length);
  assertIsolated(escapingResult, totalBound);
  // active content by part name: a macro project
  const macro = withExtra([{ name: "xl/vbaProject.bin", data: Buffer.alloc(64, 7) }]);
  const macroResult = await inspect(macro);
  assertRefused(macroResult, "ACTIVE_CONTENT", "MACRO_PROJECT", macro.length);
  assertIsolated(macroResult, 0);
  // XML nested beyond the depth bound (a depth bomb inside a worksheet)
  const deep = `${"<g>".repeat(limits.maxXmlDepth)}${"</g>".repeat(limits.maxXmlDepth)}`;
  const depthBomb = buildWorkbook({ sheets: [{ ...(BENIGN[0] as SheetSpec), after: `<extLst>${deep}</extLst>` }] });
  const depthResult = await inspect(depthBomb);
  assertRefused(depthResult, "RESOURCE_LIMIT", "XML_DEPTH_LIMIT", depthBomb.length);
  assertIsolated(depthResult, totalBound);
  // one row whose cells, each within the 1 MiB cell bound, together exceed the 8 MiB record bound (09 "Initial intake envelope")
  const cellChars = 1_000_000;
  const cells = Math.floor(limits.decodedRecordBytes / cellChars) + 1;
  assert.ok(cellChars <= limits.decodedCellBytes && cells * cellChars > limits.decodedRecordBytes);
  const wideRow = buildWorkbook({ sheets: [{ name: "Wide", rows: [["Id"], Array.from({ length: cells }, (_, k) => ({ inline: patternedText(cellChars, k + 1) }))] }] });
  const wideResult = await inspect(wideRow);
  assertRefused(wideResult, "RESOURCE_LIMIT", "RECORD_BYTES_LIMIT", wideRow.length);
  assertIsolated(wideResult, totalBound);

  // an XML DTD with entities (the billion laughs), an external entity aimed at the test's listener, an undefined entity
  const lol = `<!DOCTYPE worksheet [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>`;
  const xxe = `<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "http://127.0.0.1:${net.port}/xxe">]>`;
  for (const prologue of [lol, xxe]) {
    const bytes = buildWorkbook({ sheets: [{ ...(BENIGN[0] as SheetSpec), prologue }] });
    const r = await inspect(bytes);
    assertRefused(r, "ACTIVE_CONTENT", "XML_DTD", bytes.length);
    assertIsolated(r, totalBound);
  }
  const undefinedEntity = buildWorkbook({ sheets: [{ ...(BENIGN[0] as SheetSpec), after: "<headerFooter><oddHeader>&xxe;</oddHeader></headerFooter>" }] });
  const undefinedResult = await inspect(undefinedEntity);
  assertRefused(undefinedResult, "CORRUPT_STRUCTURE", "XML_UNDEFINED_ENTITY", undefinedEntity.length);
  assertIsolated(undefinedResult, totalBound);

  // external relationships (a template and an OLE object fetched from the test's listener) and an external-link part
  const externalTemplate = buildWorkbook({ sheets: BENIGN, workbookRelsExtra: `<Relationship Id="rId90" Type="${REL.attachedTemplate}" Target="http://127.0.0.1:${net.port}/template.xltx" TargetMode="External"/>` });
  const externalObject = buildWorkbook({ sheets: [{ ...(BENIGN[0] as SheetSpec), rels: [{ id: "rId9", type: REL.oleObject, target: `http://127.0.0.1:${net.port}/object.bin`, external: true }] }] });
  for (const bytes of [externalTemplate, externalObject]) {
    const r = await inspect(bytes);
    assertRefused(r, "ACTIVE_CONTENT", "EXTERNAL_RELATIONSHIP", bytes.length);
    assertIsolated(r, totalBound);
  }
  const externalLink = withExtra([{ name: "xl/externalLinks/externalLink1.xml", data: "<externalLink/>" }]);
  const linkResult = await inspect(externalLink);
  assertRefused(linkResult, "ACTIVE_CONTENT", "EXTERNAL_LINK", externalLink.length);
  assertIsolated(linkResult, 0);

  // expansion beyond 1 GiB per part, declared honestly: refused before decompression
  const overPart = withExtra([{ name: "xl/media/image1.bin", compressed: Buffer.alloc(8 * 1024 * 1024, 1), declaredSize: partBound + 1, declaredCrc: 0 }]);
  const overPartResult = await inspect(overPart);
  assertRefused(overPartResult, "RESOURCE_LIMIT", "PART_EXPANSION_LIMIT", overPart.length);
  assert.equal(overPartResult.isolation.decompressedBytes, 0);
  assertIsolated(overPartResult, 0);

  // beyond 20 GiB in total with every part within 1 GiB: refused before decompression
  const overTotal = withExtra(Array.from({ length: 21 }, (_, i) => ({ name: `xl/media/image${i + 1}.bin`, compressed: Buffer.alloc(64, 2), declaredSize: partBound, declaredCrc: 0 })));
  const overTotalResult = await inspect(overTotal);
  assertRefused(overTotalResult, "RESOURCE_LIMIT", "TOTAL_EXPANSION_LIMIT", overTotal.length);
  assert.equal(overTotalResult.isolation.decompressedBytes, 0);
  assertIsolated(overTotalResult, 0);
  assert.ok(21 * partBound > totalBound, "twenty-one parts at the part bound exceed the total bound");

  // a zip bomb that declares its size honestly: the ratio bound refuses it before decompression
  const zeros = deflateRawSync(Buffer.alloc(64 * 1024 * 1024));
  const ratioBomb = withExtra([{ name: "xl/media/image1.bin", compressed: zeros, declaredSize: 64 * 1024 * 1024, declaredCrc: 0 }]);
  const ratioResult = await inspect(ratioBomb);
  assertRefused(ratioResult, "RESOURCE_LIMIT", "COMPRESSION_RATIO_LIMIT", ratioBomb.length);
  assert.equal(ratioResult.isolation.decompressedBytes, 0);
  assertIsolated(ratioResult, 0);

  // a zip bomb that lies about its size (declares 1,000 bytes): decompression stops at the declared length
  const liarSmall = withExtra([{ name: "xl/media/image1.bin", compressed: zeros, declaredSize: 1_000, declaredCrc: 0 }]);
  const liarSmallResult = await inspect(liarSmall);
  assertRefused(liarSmallResult, "CORRUPT_STRUCTURE", "ENTRY_SIZE_MISMATCH", liarSmall.length);
  assert.ok(liarSmallResult.isolation.decompressedBytes <= 1_000 + 65_536, `stopped at the declared length: ${liarSmallResult.isolation.decompressedBytes}`);
  assertIsolated(liarSmallResult, 1_000 + 65_536);

  // a part that really expands beyond 1 GiB while declaring exactly the bound: decompression runs to the bound and stops there
  const beyond = await patternStream(partBound + 1_048_576);
  const liarAtBound = withExtra([{ name: "xl/media/image1.bin", compressed: beyond, declaredSize: partBound, declaredCrc: 0 }]);
  const atBound = await inspect(liarAtBound);
  assertRefused(atBound, "RESOURCE_LIMIT", "PART_EXPANSION_LIMIT", liarAtBound.length);
  assert.ok(atBound.isolation.decompressedBytes >= partBound, "the bomb was expanded up to the bound");
  assert.ok(atBound.isolation.decompressedBytes <= partBound + 65_536, `and not one counted byte beyond the part bound (the other parts are < 64 KiB): ${atBound.isolation.decompressedBytes}`);
  assertIsolated(atBound, totalBound);
});

test("D-ISO-1 negative controls: a probe that writes outside the attempt scratch is refused by the permission model and counted, a probe that connects or resolves a name is recorded by the network hooks and refused", { timeout: 120_000 }, async () => {
  const work = freshDir("probe");
  try {
    const outside = join(guard.dir, "outside", "escaped.txt");
    const task = join(HERE, "probes", "escape-probe.js");
    const run = await runIsolated<Record<string, string>>({
      task,
      payload: { outside, port: net.port, attempts: ["write", "writeAsync", "connect", "lookup", "fetch", "http", "spawn", "worker"] },
      readPaths: [],
      workDir: work,
      timeoutMs: 60_000,
      heapMegabytes: ARCHIVE_BOUNDS.childHeapMegabytes,
    });
    assert.ok(run.outcome?.ok === true, JSON.stringify(run.outcome));
    const seen = run.outcome.value;
    // positive control: the scratch is writable
    assert.equal(seen["inside"], "WRITTEN");
    assert.ok(existsSync(join(work, "inside.txt")));
    // the permission model refuses the writes outside the scratch, the process and the worker; the preload counts each refusal
    assert.equal(seen["write"], "ERR_ACCESS_DENIED:FileSystemWrite");
    assert.equal(seen["writeAsync"], "ERR_ACCESS_DENIED:FileSystemWrite");
    assert.equal(seen["spawn"], "ERR_ACCESS_DENIED:ChildProcess");
    assert.equal(seen["worker"], "ERR_ACCESS_DENIED:WorkerThreads");
    assert.equal(run.observers.outsideWriteAttempts, 2);
    assert.equal(run.observers.processAttempts, 2);
    assert.equal(existsSync(outside), false);
    assert.equal(existsSync(`${outside}.async`), false);
    assert.ok(guard.unchanged());
    // the hooks record every network attempt and refuse it: the test's listener received nothing
    for (const attempt of ["connect", "lookup", "fetch", "http"]) assert.equal(seen[attempt], "KAURO_NETWORK_REFUSED", attempt);
    assert.equal(run.observers.networkAttempts, 4);
    assert.deepEqual(run.observers.network, ["net.connect", "dns.lookup", "fetch", "http.get"]);
    assert.equal(net.connections(), 0);
    // the flags are the inspector's: the permission model on, the scratch the only writable path, nothing else allowed
    assert.ok(run.flags.includes("--permission"));
    assert.deepEqual(run.flags.filter((f) => f.startsWith("--allow-fs-write=")), [`--allow-fs-write=${work}`]);
    for (const forbidden of ["--allow-child-process", "--allow-worker", "--allow-addons", "--allow-wasi", "--allow-inspector"]) assert.ok(!run.flags.some((f) => f.startsWith(forbidden)), forbidden);
    assert.deepEqual(sandboxFlags({ task, readPaths: [], workDir: work, heapMegabytes: ARCHIVE_BOUNDS.childHeapMegabytes }), run.flags);
  } finally {
    removeDir(work);
  }
  // why the hooks: under the permission model alone (no preload) the same connection goes out and a listener counts it (its own
  // listener, so the shared one keeps observing zero for every inspection of this file)
  const control = await listener();
  try {
    const bare = join(HERE, "probes", "bare-connect.js");
    const unhooked = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dirname(bare)}`, bare, String(control.port)], { encoding: "utf8", env: process.env["SystemRoot"] === undefined ? {} : { SystemRoot: process.env["SystemRoot"] } });
    assert.equal(unhooked.stdout, "CONNECTED");
    await control.accepted(1);
    assert.equal(control.connections(), 1);
    assert.equal(net.connections(), 0);
  } finally {
    await control.close();
  }
  // and the sentinel observer itself sees a write outside the scratch when one happens (made here by the test, then undone)
  const planted = join(guard.dir, "outside", "planted.txt");
  writeFileSync(planted, "x");
  assert.equal(guard.unchanged(), false, "the sentinel observer detects a file written beside it");
  rmSync(planted);
  assert.ok(guard.unchanged());
});

const LONG = "L".repeat(250);

test("the worksheet inventory reports visibility, formulas and their caches, merged cells, hidden rows and columns and positional columns with label states; the expected scan parts are the container at its verified length and every part at its verified expanded length", async () => {
  const items = workbookItems({
    sheets: [
      {
        name: "Contacts",
        rows: [
          { r: 2, cells: ["Id", "Name", "name ", "", LONG, "Tab\there", undefined, "Owner"] },
          [1, "Ana", "x", null, "y", "z", null, "Eve"],
          { hidden: true, cells: [2, "Bo"] },
          { r: 9, cells: [3, "Cy"] },
          { r: 12, hidden: true, cells: [] },
        ],
        hiddenColumns: [[7, 9]],
        merges: ["A10:B10", "C10:D10"],
        rels: [{ id: "rId5", type: REL.hyperlink, target: "https://example.invalid/", external: true }],
      },
      { name: "Hidden", state: "hidden", rows: [["Key"], ["k1"]] },
      { name: "Very", state: "veryHidden", rows: [["Key"], ["k2"]] },
      {
        name: "Formulas",
        rows: [
          ["A", "B"],
          [{ f: "1+1", v: 2 }, { f: "A2&\"x\"", v: "2x", t: "str" }],
          [{ f: "1/0", v: "#DIV/0!", t: "e" }, { f: "SUM(A1:A2)" }],
          [{ f: "[1]Sheet1!A1", v: 5 }, null],
        ],
      },
    ],
  });
  const bytes = buildZip(items);
  const r = await inspect(bytes);
  assert.equal(r.refusal, undefined, JSON.stringify(r.problems));
  assert.equal(r.structureStatus, "STRUCTURE_VALID");
  assertIsolated(r, limits.xlsxExpandedTotalBytes);
  assert.equal(r.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(r.bytes, bytes.length);
  // every part expanded exactly once: the counter is the sum of the parts' lengths
  const expanded = items.reduce((n, i) => n + Buffer.byteLength(i.data as string), 0);
  assert.equal(r.isolation.decompressedBytes, expanded);
  const [container, ...parts] = r.expectedScanParts;
  assert.deepEqual(container, { partDigest: r.sha256, partKind: "CONTAINER", bytes: bytes.length });
  assert.deepEqual(
    parts.map((p) => [p.partDigest, p.bytes]),
    items.map((i) => [partDigestOf(i.name), Buffer.byteLength(i.data as string)]),
  );
  const kinds = new Map(items.map((i, k) => [i.name, parts[k]?.partKind]));
  assert.equal(kinds.get("xl/workbook.xml"), "WORKBOOK_PART");
  assert.equal(kinds.get("xl/worksheets/sheet1.xml"), "WORKSHEET_PART");
  assert.equal(kinds.get("xl/sharedStrings.xml"), "SHARED_STRINGS_PART");
  assert.equal(kinds.get("xl/styles.xml"), "STYLES_PART");
  assert.equal(kinds.get("_rels/.rels"), "RELATIONSHIPS_PART");
  assert.equal(kinds.get("[Content_Types].xml"), "OTHER_PART");

  assert.deepEqual(r.tables.map((t) => [t.ordinal, t.name, t.visibility]), [
    [0, "Contacts", "VISIBLE"],
    [1, "Hidden", "HIDDEN"],
    [2, "Very", "VERY_HIDDEN"],
    [3, "Formulas", "VISIBLE"],
  ]);
  const contacts = r.tables[0];
  assert.ok(contacts !== undefined);
  // used range: rows 2..9 (row 12 holds nothing), columns A..H; rows 5..8 are empty rows of the span
  assert.equal(contacts.rowEstimate, 8);
  assert.equal(contacts.columnCount, 8);
  assert.equal(contacts.hiddenRowCount, 1, "the hidden row inside the span; the hidden row after the last value row is not in the table");
  assert.equal(contacts.hiddenColumnCount, 2, "columns G and H of the span are hidden (I is outside it)");
  assert.equal(contacts.mergedCellCount, 2);
  assert.equal(contacts.hasFormulas, false);
  assert.equal(contacts.formulaCache, "NOT_APPLICABLE");
  assert.deepEqual(
    contacts.columns.map((c) => [c.ordinal, c.labelState, c.label === undefined ? undefined : c.label.length]),
    [
      [0, "PRESENT", 2],
      [1, "DUPLICATE_LABEL", 4],
      [2, "DUPLICATE_LABEL", 5],
      [3, "EMPTY", undefined],
      [4, "DISPLAY_TRUNCATED", 200],
      [5, "DISPLAY_TRUNCATED", 8],
      [6, "EMPTY", undefined],
      [7, "PRESENT", 5],
    ],
  );
  assert.equal(contacts.columns[5]?.label, "Tab\ufffdhere", "a control character is shown as U+FFFD, never passed through");
  for (const issue of ["DUPLICATE_HEADER_LABELS", "EMPTY_HEADER_LABELS", "EXTERNAL_HYPERLINKS", "HIDDEN_COLUMNS_PRESENT", "HIDDEN_ROWS_PRESENT", "MERGED_CELLS_PRESENT"]) assert.ok(contacts.issues.includes(issue), issue);
  assert.ok(r.tables[1]?.issues.includes("HIDDEN_WORKSHEET"));
  const formulas = r.tables[3];
  assert.ok(formulas !== undefined);
  assert.equal(formulas.hasFormulas, true);
  assert.equal(formulas.formulaCache, "EXTERNAL_DEPENDENCY", "the external reference dominates the error and missing caches");
  for (const issue of ["FORMULAS_PRESENT", "FORMULA_CACHE_MISSING", "FORMULA_ERROR_VALUES", "FORMULA_EXTERNAL_DEPENDENCY"]) assert.ok(formulas.issues.includes(issue), issue);
  assert.equal(r.parserProfile["format"], "XLSX");
  assert.equal(r.parserProfile["partBytesLimit"], limits.xlsxExpandedPartBytes);
  assert.equal(r.parserProfile["maxCompressionRatio"], ARCHIVE_BOUNDS.maxCompressionRatio);
  for (const check of ["READ_COMPLETE", "SHA256", "OBSERVED_LENGTH", "FORMAT_DETECTED", "ARCHIVE_METADATA", "WORKBOOK_STRUCTURE", "ARCHIVE_ENTRIES_EXPANDED", "ARCHIVE_CRC", "XML_WELL_FORMED_NO_DTD", "ACTIVE_CONTENT_ABSENT", "WORKSHEET_INVENTORY"]) {
    assert.ok(r.checksCompleted.includes(check), check);
  }
  // the parser profile hash (KAURO_PARSER_PROFILE_V1) digests the pinned configuration and the detected facts: the same file and
  // configuration give the same hash whatever the chunking; another pinned bound gives another profile
  const hash = parserProfileHashOfInspection(r);
  assert.equal(hash, parserProfileHashOf(r.parserProfile));
  assert.equal(r.parserProfile["inspectorVersion"], INSPECTOR_VERSION);
  assert.equal(parserProfileHashOfInspection(await inspect(bytes, "XLSX", { chunk: 997 })), hash);
  const otherBound = await inspector.inspect({ open: source(bytes), declaredFormat: "XLSX", observedBytes: bytes.length, limits: { ...limits, maxXmlDepth: 32 }, scratchDir: scratch });
  assert.notEqual(parserProfileHashOfInspection(otherBound), hash);
});

test("CSV dialect facts: encoding by byte-order mark or validity (Windows-1252 ambiguity reported), delimiter by consistency (ambiguity reported, never the widest), line endings, blank lines, ragged rows and embedded line breaks; an unclosed quote, a NUL or an oversized cell is refused; the SHA-256 streams over any chunking", async () => {
  const one = async (text: Buffer | string, chunk?: number): Promise<ContainerInspection> => {
    const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    const r = await inspect(bytes, "CSV", chunk === undefined ? {} : { chunk });
    assertIsolated(r, 0);
    return r;
  };
  const bom = await one(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Nombre;Correo\r\nAna;a@x\r\nBo;b@y\r\n")]));
  assert.equal(bom.detectedFormat, "CSV");
  assert.deepEqual([bom.parserProfile["encoding"], bom.parserProfile["bom"], bom.parserProfile["delimiter"], bom.parserProfile["lineEndings"], bom.parserProfile["records"]], ["UTF_8", true, "SEMICOLON", "CRLF", 3]);
  assert.deepEqual(bom.tables[0]?.columns.map((c) => c.label), ["Nombre", "Correo"]);

  const cp1252 = await one(Buffer.from([...Buffer.from("Name,Quote\n"), ...Buffer.from("Ana,"), 0x93, ...Buffer.from("hi"), 0x94, 0x0a]));
  assert.equal(cp1252.parserProfile["encoding"], "WINDOWS_1252");
  assert.ok(cp1252.tables[0]?.issues.includes("ENCODING_AMBIGUOUS"));
  assert.ok(cp1252.tables[0]?.issues.includes("ENCODING_NOT_UTF8"));

  const utf16 = await one(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("A\tB\n1\t2\n", "utf16le")]));
  assert.deepEqual([utf16.parserProfile["encoding"], utf16.parserProfile["delimiter"]], ["UTF_16LE", "TAB"]);

  const messy = await one('Id|Note|Extra\n1|"two\nlines"|x\n\n2|plain\r\n3|"say ""hi"""|y');
  assert.equal(messy.parserProfile["delimiter"], "PIPE");
  assert.equal(messy.parserProfile["lineEndings"], "MIXED");
  assert.equal(messy.tables[0]?.rowEstimate, 4, "four records, the blank line not among them");
  for (const issue of ["BLANK_LINES_PRESENT", "RAGGED_ROWS", "EMBEDDED_LINE_BREAKS", "NO_TERMINAL_NEWLINE", "LINE_ENDINGS_MIXED"]) assert.ok(messy.tables[0]?.issues.includes(issue), issue);

  const ambiguous = await one("a,b;c\n1,2;3\n4,5;6\n");
  assert.equal(ambiguous.parserProfile["delimiter"], "COMMA");
  assert.ok(ambiguous.tables[0]?.issues.includes("DELIMITER_AMBIGUOUS"));
  const single = await one("only\n1\n2\n");
  assert.ok(single.tables[0]?.issues.includes("SINGLE_COLUMN"));

  const unclosed = await one('a,b\n1,"never closed\n');
  assert.deepEqual([unclosed.refusal, codes(unclosed)], ["CORRUPT_STRUCTURE", ["CSV_UNCLOSED_QUOTE"]]);
  const nul = await one(Buffer.from("a,b\n1,\u0000\n"));
  assert.deepEqual([nul.refusal, nul.detectedFormat, codes(nul)], ["CORRUPT_STRUCTURE", "UNSUPPORTED", ["CSV_NUL_CHARACTER"]]);
  const wide = await one(`a,b\n1,${"x".repeat(limits.decodedCellBytes + 1)}\n`);
  assert.deepEqual([wide.refusal, codes(wide)], ["RESOURCE_LIMIT", ["CELL_BYTES_LIMIT"]]);

  // the digest is over every byte, whatever the chunking
  const text = Buffer.from("Id,Name\n" + Array.from({ length: 2_000 }, (_, i) => `${i},name ${i}`).join("\n") + "\n");
  const byByte = await one(text, 1);
  const byBlock = await one(text, 4_096);
  assert.equal(byByte.sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(byBlock.sha256, byByte.sha256);
  assert.deepEqual(byBlock.tables, byByte.tables);
});

test("the detected format is the bytes', never the declaration's; an observed length the bytes contradict, an empty object and an object beyond the per-file bound are refused with the container at its verified length", async () => {
  const workbook = buildWorkbook({ sheets: BENIGN });
  const claimedCsv = await inspect(workbook, "CSV");
  assert.equal(claimedCsv.detectedFormat, "XLSX", "a workbook declared CSV is detected as XLSX (the receipt decides FORMAT_MISMATCH)");
  const claimedXlsx = await inspect(Buffer.from("a,b\n1,2\n"), "XLSX");
  assert.equal(claimedXlsx.detectedFormat, "CSV");
  const compound = await inspect(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]));
  assert.deepEqual([compound.detectedFormat, compound.refusal, codes(compound)], ["UNSUPPORTED", "UNSUPPORTED_FORMAT", ["COMPOUND_FILE"]]);
  const empty = await inspect(Buffer.alloc(0), "CSV");
  assert.deepEqual([empty.refusal, codes(empty), empty.expectedScanParts[0]?.bytes], ["CORRUPT_STRUCTURE", ["EMPTY_FILE"], 0]);
  const shorter = await inspect(workbook, "XLSX", { observedBytes: workbook.length + 10 });
  assert.equal(shorter.refusal, "CORRUPT_STRUCTURE");
  assert.ok(codes(shorter).includes("OBSERVED_LENGTH_MISMATCH"));
  assert.equal(shorter.expectedScanParts[0]?.bytes, workbook.length, "the container is expected at the length actually read");
  const beyondFile = await inspect(Buffer.alloc(300, 0x41), "CSV", { fileBytes: 100 });
  assert.deepEqual([beyondFile.refusal, codes(beyondFile)], ["RESOURCE_LIMIT", ["FILE_BYTES_LIMIT"]]);
  assert.equal(beyondFile.isolation.decompressedBytes, 0);
});

test("D-SAPI-7: the preview reader returns at most 20 rows of at most 50 columns, each cell at most 200 characters of decoded text (a formula's cached value, never its evaluation), and only for the admitted bytes", async () => {
  const reader = new IsolatedTablePreviewReader();
  const rows: Cell[][] = [Array.from({ length: 60 }, (_, c) => `H${c}`)];
  for (let r = 1; r < 30; r++) rows.push(Array.from({ length: 60 }, (_, c) => (c === 3 && r === 2 ? "é".repeat(300) : r * 100 + c)));
  (rows[1] as Cell[])[0] = { f: 'WEBSERVICE("http://127.0.0.1:1/")', v: "cached", t: "str" };
  (rows[3] as Cell[])[1] = null;
  const bytes = buildWorkbook({ sheets: [{ name: "Hidden first", state: "hidden", rows: [["x"]] }, { name: "Big", rows }] });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const preview = await reader.preview({ open: source(bytes), sha256, bytes: bytes.length, format: "XLSX", ordinal: 1, limits, scratchDir: scratch });
  assert.deepEqual(readdirSync(scratch), []);
  assert.equal(preview.rows.length, 20);
  assert.equal(preview.columnCount, 50);
  assert.ok(preview.rows.every((r) => r.length === 50));
  assert.equal(preview.truncated, true);
  assert.equal(preview.rows[0]?.[0], "H0");
  assert.equal(preview.rows[1]?.[0], "cached");
  assert.equal(preview.rows[2]?.[3], "é".repeat(200));
  assert.equal(preview.rows[3]?.[1], null);
  assert.equal(preview.rows[19]?.[49], String(19 * 100 + 49));
  assert.equal(net.connections(), 0);
  const csv = Buffer.from("a,b\n1,2\n");
  const small = await reader.preview({ open: source(csv), sha256: createHash("sha256").update(csv).digest("hex"), bytes: csv.length, format: "CSV", ordinal: 0, limits, scratchDir: scratch });
  assert.deepEqual([small.rows, small.columnCount, small.truncated], [[["a", "b"], ["1", "2"]], 2, false]);
  await assert.rejects(reader.preview({ open: source(csv), sha256: "0".repeat(64), bytes: csv.length, format: "CSV", ordinal: 0, limits, scratchDir: scratch }), (e: unknown) => e instanceof PreviewFailure && e.code === "ACCEPTED_GENERATION_MISMATCH");
  assert.deepEqual(readdirSync(scratch), []);
});
