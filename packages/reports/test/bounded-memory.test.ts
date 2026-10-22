// F-32 (Order 14): reading a package costs memory for what the cross-checks keep, not for the size of its tables; and no table, however
// large or crafted, makes a field, a record or a refusal grow without bound. The volume case runs in a child process whose whole V8 heap is
// pinned (old generation and semi-spaces), so its limit is the same on every runner: a reader that held a table's records, as the reader
// before Order 14 did, needs about twenty times this heap for this table and ends with V8's out-of-memory failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readMigrationPackage, ReportModelError } from "../src/index.js";
import type { Problem } from "../src/index.js";
import { MAX_FIELD_LENGTH, MAX_FIELDS } from "../src/csv.js";
import { MAX_LISTED_PROBLEMS } from "../src/problems.js";
import { fileText, forge, forgeBytes, loadPackage } from "./support/fixtures.js";

const CHILD = fileURLToPath(new URL("./support/bounded-read.js", import.meta.url));
/** 48 MB of old generation and 2 MB semi-spaces: 54 MB of V8 heap in all. */
const HEAP = ["--max-old-space-size=48", "--max-semi-space-size=2"];

function refusal(files: Map<string, Uint8Array>): readonly Problem[] {
  try {
    readMigrationPackage(files);
  } catch (error) {
    assert.ok(error instanceof ReportModelError, `expected ReportModelError, got ${String(error)}`);
    return error.problems;
  }
  assert.fail("the package was accepted");
}

describe("F-32: a table is scanned, not held", () => {
  it("a package whose change log holds 64 MB of records is read, every record counted, in a V8 heap of 54 MB in all", () => {
    const child = spawnSync(process.execPath, [...HEAP, CHILD, "64"], { encoding: "utf8", maxBuffer: 1 << 20 });
    assert.equal(child.status, 0, `the reader ran out of its heap or failed: ${child.stderr.slice(-1500)}`);
    const result = JSON.parse(child.stdout);
    assert.ok(result.bytes >= 64 * 1024 * 1024);
    assert.equal(result.read, result.rows, "every record of the table was counted");
    assert.ok(result.heapLimitBytes <= 54 * 1024 * 1024, `the child ran under the small heap (${result.heapLimitBytes} bytes)`);
  });
});

describe("F-32: crafted tables are refused within their bounds", () => {
  it(`a field longer than ${MAX_FIELD_LENGTH} characters (an unterminated quote over 12 MB) is refused, without quoting it`, () => {
    const files = loadPackage("A-clean-multi-object");
    const path = "02_EXCEPTIONS/formula-risk.csv";
    const header = Buffer.from(`${fileText(files, path).split("\n")[0]}\n"`);
    const bytes = Buffer.alloc(header.length + 12 * 1024 * 1024, "x");
    header.copy(bytes, 0);
    forgeBytes(files, path, bytes, 1);
    const problems = refusal(files);
    assert.deepEqual(problems.map((p) => p.code), ["ARTIFACT_UNREADABLE"]);
    assert.match(problems[0]?.detail ?? "", /a field is longer than/);
    assert.ok(!JSON.stringify(problems).includes("xxxx"));
  });

  it(`a record of more than ${MAX_FIELDS} fields is refused`, () => {
    const files = loadPackage("A-clean-multi-object");
    const path = "02_EXCEPTIONS/formula-risk.csv";
    forge(files, path, `${fileText(files, path).split("\n")[0]}\n${",".repeat(MAX_FIELDS)}\n`);
    const problems = refusal(files);
    assert.deepEqual(problems.map((p) => p.code), ["ARTIFACT_UNREADABLE"]);
    assert.match(problems[0]?.detail ?? "", /more than 10000 fields/);
  });

  it(`a lineage with a problem on every one of 20,000 rows is refused with ${MAX_LISTED_PROBLEMS} problems listed and the rest counted`, () => {
    const files = loadPackage("A-clean-multi-object");
    const path = "03_TRACEABILITY/source-lineage.csv";
    const [header, first] = fileText(files, path).split("\n") as [string, string];
    assert.ok(first.includes(",RECORD,OUTPUT,"));
    const forged = first.replace(",RECORD,OUTPUT,", ",FORGED,OUTPUT,");
    forge(files, path, `${header}\n${`${forged}\n`.repeat(20_000)}`);
    const problems = refusal(files);
    assert.equal(problems.length, MAX_LISTED_PROBLEMS + 1);
    assert.match(problems[MAX_LISTED_PROBLEMS]?.detail ?? "", /^[0-9]+ more problems are not listed$/);
    assert.ok(Number(/^[0-9]+/.exec(problems[MAX_LISTED_PROBLEMS]?.detail ?? "")?.[0]) > 19_000);
  });
});
