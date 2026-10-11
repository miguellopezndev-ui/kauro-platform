// B05 L1 (S045): the Migration Core adapter over the real vendored core in the real isolated child.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "@kauro/migration-core";
import { attemptScratchDirectoryOf } from "../../src/index.js";
import { MigrationCoreAdapter, CORE_RUN_DIRECTORY } from "../../src/index.js";
import { attemptFixture, sha } from "../support/attempt.js";
import { CONTACTS_CSV, configDocument, hostIoOf, inputRef, memorySource, resolverOf, tempRoot } from "../support/core-config.js";

function adapterFor(root: string, refs = [inputRef("contacts.csv", CONTACTS_CSV)]) {
  const fixture = attemptFixture(1);
  mkdirSync(attemptScratchDirectoryOf(root, fixture.attemptId), { recursive: true });
  const adapter = new MigrationCoreAdapter({ attemptId: fixture.attemptId, scratchRoot: root, inputs: resolverOf(refs), corePackageHash: sha("core"), pollIntervalMs: 50 });
  const document = configDocument();
  const subject = { ...fixture.subject, configDocument: document, configHash: loadConfig(JSON.stringify(document), "t").configHash, executionDeadlineAt: new Date(Date.now() + 3_600_000).toISOString() as typeof fixture.subject.executionDeadlineAt };
  return { fixture, adapter, subject };
}

test("M01 OK: execute over the real core completes and stages every package file with the bytes the core wrote", async () => {
  const t = tempRoot();
  try {
    const { adapter, subject } = adapterFor(t.root);
    const io = hostIoOf({ source: memorySource({ [`contacts.csv#1`]: CONTACTS_CSV }) });
    const out = await adapter.execute(subject, io);
    assert.equal(out.terminalCause, "COMPLETED", JSON.stringify(out));
    assert.ok(out.stagedArtifacts.length > 3);
    assert.equal(out.evidenceClass, "EXECUTED_LOCAL");
    assert.equal(out.coreVersion, "3.0.0");
    assert.equal(readdirSync(join(attemptScratchDirectoryOf(t.root, subject.attemptId), CORE_RUN_DIRECTORY)).length, 0);
  } finally {
    t.dispose();
  }
});
