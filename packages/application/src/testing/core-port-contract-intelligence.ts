/**
 * The shared contract table of the Intelligence ports (B05 T04): the same case runs against the labelled contract fake and against the
 * real adapter, each backend supplying only how to build a world for a funded ceiling. A case throws on failure; the caller wraps it in its
 * own test (this module imports no test runner).
 */
import assert from "node:assert/strict";
import type { CandidateManifest, InterpretPort, InterpretRequest, InterpretResult, PlanCandidatesRequest } from "../ports/index.js";

export interface IntelligenceWorld {
  readonly port: InterpretPort;
  readonly plan: PlanCandidatesRequest;
  /** An interpret request for the manifest, under a funded ceiling, on the world's journal (the same journal on every call). */
  request(manifest: CandidateManifest, fundedCeilingCents: number): InterpretRequest;
  /** How many model requests have left the process so far. */
  dispatches(): number;
}

export interface IntelligencePortBackend {
  /** A fresh world whose model, when asked, answers a complete valid proposal. */
  world(): Promise<IntelligenceWorld>;
}

export interface IntelligencePortContractCase {
  readonly id: string;
  readonly title: string;
  run(backend: IntelligencePortBackend): Promise<void>;
}

export const INTELLIGENCE_PORT_CONTRACT: readonly IntelligencePortContractCase[] = [
  {
    id: "T04",
    title: "<B>: planCandidates plans a complete manifest with no dispatch or spend; interpret compiles a stored response before any new dispatch and never dispatches without a reservation",
    async run(backend) {
      const w = await backend.world();
      const manifest = await w.port.planCandidates(w.plan);
      assert.match(manifest.candidateSetHash, /^[0-9a-f]{64}$/u);
      assert.equal(w.dispatches(), 0, "planning dispatches nothing");

      // never a dispatch without a funded reservation
      const unfunded: InterpretResult = await w.port.interpret(w.request(manifest, 0));
      assert.notEqual(unfunded.outcome, "COMPILED");
      assert.equal(unfunded.reservedCents, 0);
      assert.equal(unfunded.spentCents, 0);
      assert.equal(w.dispatches(), 0, "no funded room, no dispatch");

      const first = await w.port.interpret(w.request(manifest, 500));
      assert.equal(first.outcome, "COMPILED");
      assert.ok(first.spentCents <= first.reservedCents && first.reservedCents <= 500, "spend stays inside the reservation inside the ceiling");
      assert.equal(first.evidenceClass, manifest.evidenceClass);
      const sent = w.dispatches();
      assert.equal(sent, 1);

      // a second interpret of the same step compiles the stored response first
      const second = await w.port.interpret(w.request(manifest, 500));
      assert.equal(second.outcome, "COMPILED");
      assert.deepEqual(second.candidateDecisions, first.candidateDecisions);
      assert.equal(w.dispatches(), sent, "the stored response is compiled before any new dispatch");
    },
  },
];
