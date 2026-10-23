/**
 * O18A/O18B golden across operating systems: the vendored Migration Core 3.1.0 turns the DETERMINISM-CROSS-OS-01 subject
 * (cores/kauro-migration-core/tools/determinism-cross-os.mjs, `subjectFiles`) into the package whose canonical digest the
 * qualification recorded on Windows under two time zones and locales (docs/qualification/mc31/). The platform's verify runs
 * this on ubuntu and on windows, so the same sealed number on both legs is the Linux half of that evidence.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CORE_VERSION,
  SCRATCH_BUDGET_BYTES,
  createFilesystemScratchStore,
  loadConfig,
  runMigration,
  verifyPackage,
  writeAndPromotePackage,
} from "../src/index.js";

const SEALED_PACKAGE_DIGEST = "d9de42840ebcb10f0d60fda9aa15e417a2e58f40f025b7569d7b13b14cfbf930";

/** Byte for byte the subject of tools/determinism-cross-os.mjs: names that sort differently by locale, a multi-line cell, a quoted comma, dates. */
function subjectFiles(): { csv: string; config: string } {
  const rows = [
    ["a1", "Zoe", "zoe@example.com", "2026-03-01", "plain"],
    ["B2", "Äda", "ada@example.com", "2026-03-02", "two\nlines"],
    ["ä3", "Émile", "emile@example.com", "2026-03-03", 'a, "quoted" comma'],
    ["Z4", "Zoë", "zoe2@example.com", "2026-03-04", "İstanbul"],
    ["é5", "Eve", "eve@example.com", "2026-03-05", "i̇ dotted"],
    ["e6", "Ida", "ida@example.com", "2026-03-06", "Straße"],
    ["ss7", "Ivo", "ivo@example.com", "2026-03-07", "STRASSE"],
  ];
  const quote = (value: string): string => (/[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const csv = `${["Contact ID", "First Name", "Email", "Signed Up", "Notes"].join(",")}\n${rows.map((row) => row.map(quote).join(",")).join("\n")}\n`;
  const field = (header: string, destinationField: string, semanticType: string) => ({ column: { header }, destinationField, semanticType });
  const config = {
    configVersion: "3.0.0",
    source: { system: "generic_csv", namespace: "cross-os" },
    target: { mode: "CLEAN_ONLY", importMode: "CREATE_ONLY" },
    files: [{ id: "contacts", path: "contacts.csv", format: "CSV" }],
    records: [
      {
        id: "contacts",
        fileId: "contacts",
        object: "CONTACT",
        sourceRecordIdColumn: { header: "Contact ID" },
        fields: [
          field("First Name", "contact.firstName", "TEXT"),
          field("Email", "contact.email", "EMAIL"),
          field("Signed Up", "contact.createdAt", "DATE"),
          field("Notes", "contact.description", "TEXT"),
        ],
      },
    ],
  };
  return { csv, config: `${JSON.stringify(config, null, 2)}\n` };
}

function walk(directory: string, relative = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(directory, path));
    else found.push(path);
  }
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

test("O18A golden cross-OS: the vendored core produces the sealed canonical package for the DETERMINISM-CROSS-OS-01 subject on this OS", () => {
  assert.equal(CORE_VERSION, "3.1.0");
  const root = mkdtempSync(join(tmpdir(), "kauro-cross-os-"));
  try {
    const input = join(root, "input");
    mkdirSync(input);
    const { csv, config } = subjectFiles();
    writeFileSync(join(input, "contacts.csv"), csv, "utf8");
    const loaded = loadConfig(config, "cross-os config.json");
    const scratch = createFilesystemScratchStore({ root: join(root, "scratch"), runId: "cross-os", quotaBytes: SCRATCH_BUDGET_BYTES });
    const out = join(root, "package");
    try {
      const result = runMigration({ inputRoot: input, config: loaded.config, configHash: loaded.configHash, scratch });
      writeAndPromotePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: out, force: true });
    } finally {
      scratch.dispose();
    }
    const verifyStore = createFilesystemScratchStore({ root: join(root, "verify"), runId: "cross-os-verify", quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      assert.equal(verifyPackage(out, { scratch: verifyStore }).passed, true);
    } finally {
      verifyStore.dispose();
    }
    const lines = walk(out).map((path) => `${path} ${sha256(readFileSync(join(out, path)))}\n`);
    assert.equal(sha256(`kauro-package-digest/1\n${lines.join("")}`), SEALED_PACKAGE_DIGEST);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
