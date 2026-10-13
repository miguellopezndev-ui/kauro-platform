// B05 T04 against the labelled Intelligence-core fake (evidence class SIMULATED); the same table runs against the real adapter in
// test/cores/core-port-contract-intelligence.real.test.ts.
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Id } from "@kauro/contracts";
import type { AgencyId } from "@kauro/domain";
import { ContractFakeIntelligenceCore, INTELLIGENCE_PORT_CONTRACT, type IntelligencePortBackend } from "../src/testing/cores.js";
import { MemoryJournal } from "./cores/intelligence-support.js";

const sha = (v: string): string => createHash("sha256").update(v).digest("hex");

const backend: IntelligencePortBackend = {
  world() {
    const core = new ContractFakeIntelligenceCore();
    core.scriptInterpretOutcomes("COMPILED");
    const journal = new MemoryJournal();
    const agencyId = "0192a000-0000-7000-8000-000000000001" as AgencyId;
    return Promise.resolve({
      port: core,
      plan: { agencyId, revisionHash: sha("revision") as never, sourceProfileHash: sha("profile") as never, targetContractHash: null },
      request: (candidateManifest, fundedCeilingCents) => ({
        auditAttemptId: "0192a000-0000-7000-8000-000000000004" as Id,
        agencyId,
        projectId: "0192a000-0000-7000-8000-000000000002" as never,
        revisionId: "0192a000-0000-7000-8000-000000000003" as Id,
        candidateManifest,
        journal,
        fundedCeilingCents,
        interpretationDeadlineAt: "2026-10-11T13:00:00.000Z" as never,
        cancellation: { check: () => Promise.resolve("CONTINUE" as const) },
      }),
      dispatches: () => journal.events.get("0192a000-0000-7000-8000-000000000004")?.filter((e) => e["kind"] === "contract-fake-intelligence-core-reservation").length ?? 0,
    });
  },
};

for (const c of INTELLIGENCE_PORT_CONTRACT) {
  test(`${c.id} ${c.title.replace("<B>", "contract fake")}`, () => c.run(backend));
}
