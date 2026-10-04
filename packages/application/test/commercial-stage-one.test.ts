// B10 stage 1 is one implementation (the `b10/stage-1` integrator; docs/design/B10-commercial-domain.md §11, D10-STAGE-1,
// D10-STAGE-2). B10-PORTS-FAKES spelled the views' vocabularies and its ports' shapes on its own, beside B10-MODEL, so that neither
// lane waited on the other; merged, the views answer exactly the tokens the domain stores (COMMERCIAL_VOCABULARY, which
// packages/persistence/test/b10-stage-one.test.ts holds equal to the database's CHECKs), and what each labelled fake reports is a
// record the domain and the database can keep: a banking calendar version with the dates it covers, a completion with a registered
// source and a stage reference exactly for a STAGE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMERCIAL_VOCABULARY, type AgencyId, type CaptureId, type CorrelationId } from "@kauro/domain";
import { COMMERCIAL_VIEW_VOCABULARY, createInMemoryPorts, emptyStore, fixedClock, sequentialIds } from "../src/index.js";
import { ContractFakeBankingCalendar, ContractFakePreparationCompletion } from "../src/testing/index.js";

const domain = COMMERCIAL_VOCABULARY as unknown as Readonly<Record<string, ReadonlyArray<string> | undefined>>;

/** Each view vocabulary and the stored tokens it answers: a record's own list, or the statement composition of D10-STMT-2. */
const ANSWERS: Readonly<Record<string, ReadonlyArray<string> | undefined>> = {
  prospectStates: domain["prospectStates"],
  claimStates: domain["attributionClaimStates"],
  sellerStates: domain["sellerStates"],
  sellerClassifications: domain["sellerClassifications"],
  statementStates: domain["statementStates"],
  payoutIntentStates: domain["payoutIntentStates"],
  foundingOffers: domain["foundingOffers"],
  // a statement line's rate kind: the first designation, a repeat, or a prospective assistance agreement's pool (D10-ASSIST-2)
  commissionSequences: domain["rateKinds"],
  adjustmentDirections: domain["adjustmentDirections"],
  periodStates: domain["periodStates"],
  calendarSources: domain["calendarSources"],
  // a sales account's new-work compensation is its service assignment's (service_assignments.compensation; D10-ASSIGN-1)
  newWorkCompensation: domain["serviceCompensations"],
  // an unrecovered balance item: an OFFSET item, or a RECOVERY item's disposition (D10-NEG-1, D10-STMT-2)
  balanceItemKinds: domain["recoveryActions"] === undefined ? undefined : ["OFFSET", ...(domain["recoveryActions"] ?? [])],
};

test("B10 stage 1 is one view vocabulary: every token list the commercial views answer is the domain's stored vocabulary, so a command lane converts nothing and no view refuses a token the database stores", () => {
  assert.deepEqual(Object.keys(COMMERCIAL_VIEW_VOCABULARY).sort(), Object.keys(ANSWERS).sort(), "every view vocabulary is compared");
  const drift: string[] = [];
  for (const [key, answered] of Object.entries(COMMERCIAL_VIEW_VOCABULARY)) {
    const stored = ANSWERS[key];
    if (stored === undefined || JSON.stringify([...answered].sort()) !== JSON.stringify([...stored].sort())) {
      drift.push(`${key}: the view answers [${answered.join(", ")}], the domain stores [${(stored ?? []).join(", ")}]`);
    }
  }
  assert.deepEqual(drift, [], "the views' tokens are the stored tokens");
});

function world() {
  const clock = fixedClock();
  const ids = sequentialIds(clock);
  const ports = createInMemoryPorts(clock, ids, emptyStore());
  const agencyId = ids.next() as AgencyId;
  const service = () => ({ kind: "SERVICE" as const, serviceId: "commission-service", correlationId: ids.next() as CorrelationId });
  return { clock, ids, ports, agencyId, service };
}

test("B10 stage 1 is one port contract: the banking-calendar fake serves a version banking_calendars can record — its version label, source and the dates it covers, every listed day inside them — and the preparation-completion fake reports completions purchase_completions can record, a registered source and a stage reference exactly for a STAGE", async () => {
  const w = world();
  const calendar = new ContractFakeBankingCalendar({ clock: w.clock });
  const served = await w.ports.unitOfWork.run(w.service(), (uow) => calendar.currentCalendar(uow, { jurisdiction: "CO", at: w.clock.now() }));
  assert.ok(served !== null);
  const coverage = served as unknown as { readonly coversFrom?: string; readonly coversTo?: string };
  assert.match(coverage.coversFrom ?? "", /^\d{4}-\d{2}-\d{2}$/, "the version states the first date it covers");
  assert.match(coverage.coversTo ?? "", /^\d{4}-\d{2}-\d{2}$/, "and the last");
  assert.ok((coverage.coversFrom ?? "") <= (coverage.coversTo ?? ""), "a coverage is a range");
  for (const d of served.nonbankingDates) assert.ok((coverage.coversFrom ?? "") <= d && d <= (coverage.coversTo ?? ""), `${d} lies inside the coverage`);
  assert.ok((coverage.coversFrom ?? "9") <= "2026-10-01" && "2026-10-15" <= (coverage.coversTo ?? ""), "the example 21 fixture covers the 1st to the 10th banking day of October 2026");
  assert.ok((domain["calendarSources"] ?? []).includes(served.source));

  const completions = new ContractFakePreparationCompletion({ clock: w.clock });
  const captureId = w.ids.next() as CaptureId;
  const stageAt = w.clock.now();
  w.clock.advance(3_600_000);
  const finalAt = w.clock.now();
  type Recorded = Parameters<ContractFakePreparationCompletion["record"]>[0];
  completions.record({ agencyId: w.agencyId, captureId, kind: "STAGE", stageRef: "parent-stage", completedAt: stageAt, source: "STAGED_PREPARATION" } as unknown as Recorded);
  completions.record({ agencyId: w.agencyId, captureId, kind: "FINAL", completedAt: finalAt, source: "STAGED_PREPARATION" } as unknown as Recorded);
  const reported = await w.ports.unitOfWork.run(w.service(), (uow) => completions.completionsOf(uow, { agencyId: w.agencyId, captureId }));
  const sources = domain["completionSources"] ?? [];
  assert.deepEqual(
    reported.map((c) => [c.kind, (c as unknown as { readonly stageRef?: string }).stageRef ?? null, sources.includes(c.source)]),
    [
      ["STAGE", "parent-stage", true],
      ["FINAL", null, true],
    ],
    "each completion carries a registered source, and a stage reference exactly when it is a STAGE",
  );
  assert.throws(
    () => completions.record({ agencyId: w.agencyId, captureId, kind: "STAGE", completedAt: stageAt, source: "STAGED_PREPARATION" } as unknown as Recorded),
    /stage/,
    "a STAGE without its stage reference is not recordable",
  );
  assert.throws(
    () => completions.record({ agencyId: w.agencyId, captureId, kind: "STAGE", stageRef: "other-stage", completedAt: stageAt, source: "contract-fake-stage-source" } as unknown as Recorded),
    /source/,
    "nor a completion from a source the ledger does not register",
  );
});
