// Run as a child process under a pinned V8 heap (bounded-memory.test.ts, F-32): builds, outside the JavaScript heap, a copy of the core's
// acceptance package A whose change log holds `megabytes` MB of records (re-declared in the manifest, as `forge` does), reads it with
// readMigrationPackage, and prints one JSON line. A heap the reader does not fit in ends the process with V8's out-of-memory failure.
import { getHeapStatistics } from "node:v8";
import { readMigrationPackage } from "../../src/index.js";
import { fileText, forgeBytes, loadPackage } from "./fixtures.js";

// `lineage`: the lineage instead, its first delivered row repeated with a new row locator each time: a forgery whose every row is one the
// cross-checks would keep, so the reader must refuse it without holding more rows than the reconciliation declares.
const megabytes = Number(process.argv[2]);
const lineage = process.argv[3] === "lineage";
const files = loadPackage("A-clean-multi-object");
const path = lineage ? "03_TRACEABILITY/source-lineage.csv" : "03_TRACEABILITY/changes.csv";
const [header, row] = fileText(files, path).split("\n");
const head = Buffer.from(`${header}\n`);
const record = Buffer.from(`${row}\n`);
const rows = Math.ceil((megabytes * 1024 * 1024) / record.length);
const bytes = Buffer.allocUnsafe(head.length + rows * record.length);
head.copy(bytes, 0);
for (let i = 0; i < rows; i++) record.copy(bytes, head.length + i * record.length);
if (lineage) {
  // a distinct row locator per row: the 12 hex digits of its file part (`F-<12 hex>:S0:R2`) become the row's number
  const at = record.indexOf(/,(F-[0-9a-f]{12}:S0:R[0-9]+),/.exec(String(row))?.[1] as string) + 2;
  for (let i = 0; i < rows; i++) bytes.write(i.toString(16).padStart(12, "0"), head.length + i * record.length + at, "latin1");
}
forgeBytes(files, path, bytes, rows);
if (lineage) {
  try {
    readMigrationPackage(files);
  } catch (error) {
    const problems = (error as { problems?: { detail: string }[] }).problems ?? [];
    process.stdout.write(`${JSON.stringify({ rows, refused: problems.map((p) => p.detail), heapLimitBytes: getHeapStatistics().heap_size_limit })}\n`);
    process.exit(0);
  }
  throw new Error("the forged lineage was accepted");
}
const pkg = readMigrationPackage(files);
process.stdout.write(`${JSON.stringify({ rows, bytes: bytes.byteLength, read: pkg.artifacts.find((a) => a.path === path)?.rowCount, heapLimitBytes: getHeapStatistics().heap_size_limit })}\n`);
