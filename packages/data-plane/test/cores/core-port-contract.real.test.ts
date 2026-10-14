// B05 T01..T03 against the real Migration Core adapter (evidence class EXECUTED_LOCAL); the same table runs against the labelled fake
// in @kauro/application's core-port-contract.fake.test.ts.
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { loadConfig } from "@kauro/migration-core";
import type { ArtifactWriter, ExecutionSubject } from "@kauro/application";
import { CORE_PORT_CONTRACT, type CorePortBackend } from "@kauro/application/testing/cores";
import { MigrationCoreAdapter, attemptScratchDirectoryOf, coreTimersOf } from "../../src/index.js";

/** The wall clock of a test (CK3 scans product code only). */
const WALL_TIMERS = coreTimersOf({ nowMs: () => Date.now() });
import { attemptFixture, limitsOf, manualChannel, sha } from "../support/attempt.js";
import { CONTACTS_CSV, configDocument, hostIoOf, inputRef, memorySource, memoryWriter, resolverOf, tempRoot } from "../support/core-config.js";

function backendOver(root: string): CorePortBackend {
  const fixture = attemptFixture(1);
  mkdirSync(attemptScratchDirectoryOf(root, fixture.attemptId), { recursive: true });
  let n = 0;
  const document = configDocument();
  const subjectOf = (): ExecutionSubject => ({
    ...fixture.subject,
    configDocument: document,
    configHash: loadConfig(JSON.stringify(document), "t").configHash,
    executionDeadlineAt: new Date(Date.now() + 3_600_000).toISOString() as ExecutionSubject["executionDeadlineAt"],
  });
  const adapterFor = (): MigrationCoreAdapter => {
    // one scratch root per call: each provoked execute is its own attempt directory
    n += 1;
    const attempt = attemptFixture(100 + n);
    mkdirSync(attemptScratchDirectoryOf(root, attempt.attemptId), { recursive: true });
    return new MigrationCoreAdapter({ attemptId: attempt.attemptId, scratchRoot: root, inputs: resolverOf([inputRef("contacts.csv", CONTACTS_CSV)]), corePackageHash: sha("core"), timers: WALL_TIMERS, pollIntervalMs: 50 });
  };
  const verifier = new MigrationCoreAdapter({ attemptId: fixture.attemptId, scratchRoot: root, inputs: resolverOf([]), corePackageHash: sha("core"), timers: WALL_TIMERS });
  return {
    evidenceClass: "EXECUTED_LOCAL",
    coreVersion: "3.0.0",
    revisionHash: sha("revision"),
    planHash: sha("plan"),
    targetContractHash: sha("target"),
    verify: (candidate, expected) => verifier.verify(candidate, expected, { limits: limitsOf() }),
    executeProvoked: async (kind) => {
      const adapter = adapterFor();
      let writer: ArtifactWriter = memoryWriter();
      let scratchBytes = 256 * 1024 * 1024;
      if (kind === "SCRATCH_EXHAUSTED") scratchBytes = 10;
      if (kind === "SHORT_WRITE" || kind === "CORRUPT_INTERMEDIATE") {
        const inner = memoryWriter();
        writer = {
          open: (role, pathHash) => {
            const h = inner.open(role, pathHash);
            return {
              write: (c) => h.write(c),
              close: async () => {
                const a = await h.close();
                return kind === "SHORT_WRITE" ? { ...a, byteLength: Math.max(0, a.byteLength - 1) } : { ...a, sha256: sha("other bytes") };
              },
            };
          },
        };
      }
      const io = hostIoOf({ source: memorySource({ "contacts.csv#1": CONTACTS_CSV }), writer, scratchBytes, channel: manualChannel() });
      const subject = { ...subjectOf(), attemptId: adapter.attemptId };
      return adapter.execute(subject, io);
    },
  };
}

const t = tempRoot();
const backend = backendOver(t.root);
for (const c of CORE_PORT_CONTRACT) {
  test(`${c.id} ${c.title.replace("<B>", "real Migration Core adapter")}`, () => c.run(backend));
}
test("core-port-contract.real cleanup", () => t.dispose());
