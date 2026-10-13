// B05 T01..T03 against the labelled Migration-core fake (evidence class SIMULATED); the same table runs against the real adapter in
// @kauro/data-plane's core-port-contract.real.test.ts.
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ExecutionSubject, HostIo, ScratchStore } from "../src/index.js";
import { CORE_PORT_CONTRACT, CONTRACT_FAKE_MIGRATION_CORE_VERSION, ContractFakeMigrationCore, type CorePortBackend } from "../src/testing/cores.js";

const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
const v7 = (n: number): string => `0192a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function scratch(): ScratchStore {
  const lines = new Map<string, string[]>();
  let n = 0;
  return {
    contractVersion: "1.0.0",
    createSegment(spec) {
      const segmentId = `seg-${(n += 1)}`;
      const own: string[] = [];
      lines.set(segmentId, own);
      return {
        segmentId,
        append: (line) => own.push(line),
        seal: () => ({ segmentId, schema: spec.schema, schemaVersion: spec.schemaVersion, sha256: sha(own.join("\n")), byteLength: Buffer.byteLength(own.join("\n")), rowCount: own.length, firstKey: null, lastKey: null, sorted: false }),
        abort: () => lines.delete(segmentId),
      };
    },
    readLines: function* (id) {
      for (const l of lines.get(id) ?? []) yield l;
    },
    manifest: () => {
      throw new Error("unused");
    },
    list: () => [],
    delete: (id) => void lines.delete(id),
    declareFamily: () => undefined,
    recordSort: () => undefined,
    usage: () => ({ bytes: 0, peakBytes: 0, quotaBytes: 1 << 30, segmentCount: lines.size, bytesWritten: 0, byFamily: [], framingBytesPerLine: 1 }),
    dispose: () => lines.clear(),
  };
}

function io(): HostIo {
  return {
    source: { open: () => Promise.reject(new Error("not exercised")) },
    scratch: scratch(),
    writer: {
      open: (role, pathHash) => {
        const chunks: Buffer[] = [];
        return {
          write: (c) => {
            chunks.push(Buffer.from(c));
            return Promise.resolve();
          },
          close: () => {
            const bytes = Buffer.concat(chunks);
            return Promise.resolve({ role, objectName: `staging/${pathHash}`, generation: "1", sha256: sha(bytes.toString("utf8")), byteLength: bytes.byteLength });
          },
        };
      },
    },
    cancellation: { check: () => Promise.resolve("CONTINUE" as const) },
    limits: { hardMemoryBytes: 8 * 1024 ** 3, memoryBudgetBytes: 5 * 1024 ** 3, hardScratchBytes: 64 * 1024 ** 3, scratchBudgetBytes: 48 * 1024 ** 3, wallClockMs: 28_800_000 },
  };
}

const subject: ExecutionSubject = {
  jobId: v7(10),
  attemptId: v7(11),
  agencyId: v7(1) as ExecutionSubject["agencyId"],
  projectId: v7(2) as ExecutionSubject["projectId"],
  inputBindingHash: sha("b"),
  revisionHash: sha("revision-1"),
  targetContractHash: sha("target-1"),
  planHash: sha("plan-1"),
  configDocument: { mode: "CLEAN_ONLY" },
  configHash: sha("config-1"),
  executionDeadlineAt: "2026-09-29T00:00:00.000Z",
};

const core = new ContractFakeMigrationCore();
const backend: CorePortBackend = {
  evidenceClass: "SIMULATED",
  coreVersion: CONTRACT_FAKE_MIGRATION_CORE_VERSION,
  revisionHash: sha("revision-1"),
  planHash: sha("plan-1"),
  targetContractHash: sha("target-1"),
  verify: (candidate, expected) => core.verify(candidate, expected),
  executeProvoked: (kind) => {
    if (kind === "SCRATCH_EXHAUSTED") core.failNextExecute("ENOSPC");
    else if (kind !== "COMPLETED") core.failNextExecute(kind);
    return core.execute(subject, io());
  },
};

for (const c of CORE_PORT_CONTRACT) {
  test(`${c.id} ${c.title.replace("<B>", "contract fake")}`, () => c.run(backend));
}
