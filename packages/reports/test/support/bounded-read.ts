// Run as a child process under a pinned V8 heap (bounded-memory.test.ts, F-32): builds, outside the JavaScript heap, a copy of the core's
// acceptance package A whose change log holds `megabytes` MB of records (re-declared in the manifest, as `forge` does), reads it with
// readMigrationPackage, and prints one JSON line. A heap the reader does not fit in ends the process with V8's out-of-memory failure.
import { getHeapStatistics } from "node:v8";
import { readMigrationPackage } from "../../src/index.js";
import { fileText, forgeBytes, loadPackage } from "./fixtures.js";

const megabytes = Number(process.argv[2]);
const files = loadPackage("A-clean-multi-object");
const path = "03_TRACEABILITY/changes.csv";
const [header, row] = fileText(files, path).split("\n");
const head = Buffer.from(`${header}\n`);
const record = Buffer.from(`${row}\n`);
const rows = Math.ceil((megabytes * 1024 * 1024) / record.length);
const bytes = Buffer.allocUnsafe(head.length + rows * record.length);
head.copy(bytes, 0);
for (let i = 0; i < rows; i++) record.copy(bytes, head.length + i * record.length);
forgeBytes(files, path, bytes, rows);
const pkg = readMigrationPackage(files);
process.stdout.write(`${JSON.stringify({ rows, bytes: bytes.byteLength, read: pkg.artifacts.find((a) => a.path === path)?.rowCount, heapLimitBytes: getHeapStatistics().heap_size_limit })}\n`);
