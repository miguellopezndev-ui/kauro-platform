// The labelled contract fakes of package B10's ports (design 11 "Ports and bindings", D10-FAKE-1, D10-BIND-1, D10-CAL-1; 21
// "Evidence classes"): the banking calendar is the controlled fixture of example 21 (weekends and 2026-10-12 nonbanking, source
// TEST_FIXTURE, never VERIFIED_FEED), the buyer-type, preparation-completion and payout-evidence fakes answer only what their
// scripts hold, and every fake carries CONTRACT_FAKE, the evidence class SIMULATED, a call log a test can read and hold points
// (never a sleep). They are reachable only from the ./testing subpath (architecture.rules.json testOnlySubpaths), so no
// composition root can bind one; the two shipped bindings without a database answer BUYER_TYPE_UNSET's null and
// PAYOUT_EVIDENCE_UNAVAILABLE and are not fakes.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { AgencyId, CorrelationId } from "@kauro/domain";
import {
  PAYOUT_EVIDENCE_UNAVAILABLE,
  UnavailablePayoutEvidenceVerifier,
  UnrecordedBuyerTypeReader,
  createInMemoryPorts,
  emptyStore,
  fixedClock,
  sequentialIds,
} from "../src/index.js";
import {
  CONTRACT_FAKE,
  FAKE_EVIDENCE_CLASS,
  ContractFakeBankingCalendar,
  ContractFakeBuyerTypeReader,
  ContractFakePayoutEvidence,
  ContractFakePreparationCompletion,
} from "../src/testing/index.js";

function world() {
  const clock = fixedClock();
  const ids = sequentialIds(clock);
  const ports = createInMemoryPorts(clock, ids, emptyStore());
  const agencyId = ids.next() as AgencyId;
  const userId = ids.next() as never;
  const tenant = () => ({ kind: "TENANT" as const, agencyId, userId, correlationId: ids.next() as CorrelationId });
  const service = () => ({ kind: "SERVICE" as const, serviceId: "commission-service", correlationId: ids.next() as CorrelationId });
  const operator = () => ({ kind: "OPERATOR" as const, userId, correlationId: ids.next() as CorrelationId });
  return { clock, ids, ports, agencyId, tenant, service, operator };
}

type World = ReturnType<typeof world>;

// an independent reading of D10-CAL-1: the ordinal banking day after a month-end, weekends and the listed days excluded
function weekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
function nextDay(date: string): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
function bankingDayAfter(monthEnd: string, ordinal: number, nonbanking: ReadonlyArray<string>): string {
  let day = monthEnd;
  let counted = 0;
  while (counted < ordinal) {
    day = nextDay(day);
    if (!weekend(day) && !nonbanking.includes(day)) counted += 1;
  }
  return day;
}

test("the banking-calendar fake serves the controlled fixture with 2026-10-12 nonbanking, labelled TEST_FIXTURE and evidence class SIMULATED, never VERIFIED_FEED, and records each call", async () => {
  const w = world();
  const calendar = new ContractFakeBankingCalendar({ clock: w.clock });
  assert.deepEqual([calendar.provider, calendar.integrationClass, calendar.evidenceClass, calendar.binding], ["contract-fake-banking-calendar", CONTRACT_FAKE, FAKE_EVIDENCE_CLASS, CONTRACT_FAKE]);
  assert.deepEqual([CONTRACT_FAKE, FAKE_EVIDENCE_CLASS], ["CONTRACT_FAKE", "SIMULATED"]);
  const at = w.clock.now();
  const served = await w.ports.unitOfWork.run(w.service(), (uow) => calendar.currentCalendar(uow, { jurisdiction: "CO", at }));
  assert.ok(served !== null);
  assert.equal(served.jurisdiction, "CO");
  assert.equal(served.source, "TEST_FIXTURE", "the fixture is never presented as a verified feed");
  assert.notEqual(served.source as string, "VERIFIED_FEED");
  assert.deepEqual([...served.nonbankingDates], ["2026-10-12"], "the listed days only: weekends are excluded by rule, not by list");
  assert.match(served.evidenceHash, /^[0-9a-f]{64}$/);
  assert.ok(served.calendarVersion.length > 0 && served.recordedAt <= at);
  // example 21: the 5th and the 10th banking day after the 2026-09-30 month-end, with and without the listed holiday
  assert.equal(bankingDayAfter("2026-09-30", 5, served.nonbankingDates), "2026-10-07");
  assert.equal(bankingDayAfter("2026-09-30", 10, served.nonbankingDates), "2026-10-15");
  assert.equal(bankingDayAfter("2026-09-30", 10, []), "2026-10-14", "the listed day moves the pay date by one banking day");
  // the fake's own day test agrees with the independent reading
  for (const [date, expected] of [["2026-10-09", false], ["2026-10-10", true], ["2026-10-11", true], ["2026-10-12", true], ["2026-10-13", false], ["2026-10-15", false]] as const) {
    assert.equal(calendar.isNonbanking(date), expected, date);
    assert.equal(weekend(date) || served.nonbankingDates.includes(date), expected, date);
  }
  // only the controlled source may be served: a feed label is refused at the fake, so a test can never pass a fixture off as one
  assert.throws(() => calendar.serve({ ...served, source: "VERIFIED_FEED" as never }), /TEST_FIXTURE/);
  assert.throws(() => calendar.serve({ ...served, nonbankingDates: ["12-10-2026"] }), /date/);
  calendar.serve({ ...served, calendarVersion: "test-fixture-variant", nonbankingDates: ["2026-10-12", "2026-11-02"] });
  const variant = await w.ports.unitOfWork.run(w.tenant(), (uow) => calendar.currentCalendar(uow, { jurisdiction: "CO", at }));
  assert.deepEqual([variant?.calendarVersion, variant?.source, [...(variant?.nonbankingDates ?? [])]], ["test-fixture-variant", "TEST_FIXTURE", ["2026-10-12", "2026-11-02"]]);
  assert.equal(calendar.isNonbanking("2026-11-02"), true);
  // another jurisdiction has no calendar; a withdrawn calendar answers null (the consumer refuses CALENDAR_UNAVAILABLE), and returns on restore
  assert.equal(await w.ports.unitOfWork.run(w.operator(), (uow) => calendar.currentCalendar(uow, { jurisdiction: "US" as never, at })), null);
  calendar.withdraw();
  assert.equal(await w.ports.unitOfWork.run(w.service(), (uow) => calendar.currentCalendar(uow, { jurisdiction: "CO", at })), null);
  calendar.restore();
  assert.equal((await w.ports.unitOfWork.run(w.service(), (uow) => calendar.currentCalendar(uow, { jurisdiction: "CO", at })))?.source, "TEST_FIXTURE");
  // each call is recorded on arrival with the context it ran in, the jurisdiction and the database instant; the log is a copy
  assert.deepEqual(
    calendar.calls.map((c) => [c.port, c.operation, c.identity, c.at, c.sent]),
    [
      ["BankingCalendarSource", "CURRENT_CALENDAR SERVICE", "CO", at, true],
      ["BankingCalendarSource", "CURRENT_CALENDAR TENANT", "CO", at, true],
      ["BankingCalendarSource", "CURRENT_CALENDAR OPERATOR", "US", at, true],
      ["BankingCalendarSource", "CURRENT_CALENDAR SERVICE", "CO", at, true],
      ["BankingCalendarSource", "CURRENT_CALENDAR SERVICE", "CO", at, true],
    ],
  );
  const log = calendar.calls as unknown as unknown[];
  assert.throws(() => log.push({}), TypeError, "the log is frozen");
  // a hold point stops the call after it was recorded, until the test releases it (never a sleep)
  const hold = calendar.hold("CURRENT_CALENDAR");
  let answered = false;
  const pending = w.ports.unitOfWork.run(w.service(), (uow) => calendar.currentCalendar(uow, { jurisdiction: "CO", at })).then((v) => {
    answered = true;
    return v;
  });
  await hold.reached;
  assert.equal(answered, false, "the call waits at the hold point");
  assert.equal(calendar.calls.length, 6, "and was recorded when it arrived");
  hold.release();
  assert.equal((await pending)?.source, "TEST_FIXTURE");
  assert.equal(answered, true);
  // a hold covers one arrival: the next call passes without a hold
  assert.equal((await w.ports.unitOfWork.run(w.service(), (uow) => calendar.currentCalendar(uow, { jurisdiction: "CO", at })))?.source, "TEST_FIXTURE");
});

test("the buyer-type, preparation-completion and payout-evidence fakes answer only what their scripts hold — unset, STAGE or FINAL, SUBMITTED, SETTLED, FAILED or RETURNED — each labelled CONTRACT_FAKE and SIMULATED with a call log, reachable only from the testing subpath", async () => {
  const w = world();
  const buyers = new ContractFakeBuyerTypeReader({ clock: w.clock });
  const completions = new ContractFakePreparationCompletion({ clock: w.clock });
  const payouts = new ContractFakePayoutEvidence({ clock: w.clock });
  for (const [fake, provider] of [[buyers, "contract-fake-buyer-type"], [completions, "contract-fake-preparation-completion"], [payouts, "contract-fake-payout-evidence"]] as const) {
    assert.deepEqual([fake.provider, fake.integrationClass, fake.evidenceClass, fake.contractFake], [provider, "CONTRACT_FAKE", "SIMULATED", true], provider);
  }
  assert.deepEqual([buyers.binding, completions.binding], [CONTRACT_FAKE, CONTRACT_FAKE], "the two platform ports are bound as a contract fake");
  const other = w.ids.next() as AgencyId;

  // buyer type: unset until scripted (a quote is then refused BUYER_TYPE_UNSET), AGENCY or IN_HOUSE afterwards, per agency
  const buyerOf = (agencyId: AgencyId) => w.ports.unitOfWork.run(w.tenant(), (uow) => buyers.buyerTypeOf(uow, { agencyId }));
  assert.equal(await buyerOf(w.agencyId), null);
  buyers.set(w.agencyId, "AGENCY");
  buyers.set(other, "IN_HOUSE");
  assert.deepEqual([await buyerOf(w.agencyId), await buyerOf(other)], ["AGENCY", "IN_HOUSE"]);
  buyers.set(w.agencyId, null);
  assert.equal(await buyerOf(w.agencyId), null, "a script can return an agency to unset");
  assert.equal(await buyerOf(w.ids.next() as AgencyId), null, "an agency nobody scripted is unset");
  assert.deepEqual(buyers.calls.map((c) => [c.port, c.operation, c.identity, c.sent]), [
    ["BuyerTypeReader", "BUYER_TYPE_OF TENANT", w.agencyId, true],
    ["BuyerTypeReader", "BUYER_TYPE_OF TENANT", w.agencyId, true],
    ["BuyerTypeReader", "BUYER_TYPE_OF TENANT", other, true],
    ["BuyerTypeReader", "BUYER_TYPE_OF TENANT", w.agencyId, true],
    ["BuyerTypeReader", "BUYER_TYPE_OF TENANT", buyers.calls[4]!.identity, true],
  ]);

  // preparation completions: only what was recorded, for that agency and capture, in instant order; a STAGE completion is a STAGE
  const captureId = w.ids.next();
  const secondCapture = w.ids.next();
  const completionsOf = (agencyId: AgencyId, capture: string) => w.ports.unitOfWork.run(w.service(), (uow) => completions.completionsOf(uow, { agencyId, captureId: capture }));
  assert.deepEqual(await completionsOf(w.agencyId, captureId), [], "nothing recorded is nothing completed");
  const stageAt = w.clock.now();
  w.clock.advance(3_600_000);
  const finalAt = w.clock.now();
  completions.record({ agencyId: w.agencyId, captureId, kind: "FINAL", completedAt: finalAt, source: "contract-fake-final-source" });
  completions.record({ agencyId: w.agencyId, captureId, kind: "STAGE", completedAt: stageAt, source: "contract-fake-stage-source" });
  const recorded = await completionsOf(w.agencyId, captureId);
  assert.deepEqual(recorded.map((c) => [c.kind, c.completedAt, c.source]), [["STAGE", stageAt, "contract-fake-stage-source"], ["FINAL", finalAt, "contract-fake-final-source"]]);
  for (const c of recorded) assert.match(c.evidenceHash, /^[0-9a-f]{64}$/);
  assert.notEqual(recorded[0]!.evidenceHash, recorded[1]!.evidenceHash);
  assert.deepEqual((await completionsOf(w.agencyId, captureId)).map((c) => c.evidenceHash), recorded.map((c) => c.evidenceHash), "the evidence is a function of what was recorded");
  assert.deepEqual(await completionsOf(other, captureId), [], "another agency's completions are not this agency's");
  assert.deepEqual(await completionsOf(w.agencyId, secondCapture), [], "another capture's neither");
  assert.throws(() => completions.record({ agencyId: w.agencyId, captureId, kind: "FINAL", completedAt: finalAt, source: "again" }), /already recorded/, "one completion per purchase and kind");
  completions.record({ agencyId: w.agencyId, captureId: secondCapture, kind: "STAGE", completedAt: stageAt, source: "contract-fake-stage-source" });
  assert.deepEqual((await completionsOf(w.agencyId, secondCapture)).map((c) => c.kind), ["STAGE"], "a purchase with only a STAGE completion has no FINAL to answer");
  assert.deepEqual(completions.calls.map((c) => [c.port, c.operation, c.identity]), [
    ["PreparationCompletionSource", "COMPLETIONS_OF SERVICE", `${w.agencyId}/${captureId}`],
    ["PreparationCompletionSource", "COMPLETIONS_OF SERVICE", `${w.agencyId}/${captureId}`],
    ["PreparationCompletionSource", "COMPLETIONS_OF SERVICE", `${w.agencyId}/${captureId}`],
    ["PreparationCompletionSource", "COMPLETIONS_OF SERVICE", `${other}/${captureId}`],
    ["PreparationCompletionSource", "COMPLETIONS_OF SERVICE", `${w.agencyId}/${secondCapture}`],
    ["PreparationCompletionSource", "COMPLETIONS_OF SERVICE", `${w.agencyId}/${secondCapture}`],
  ]);

  // payout evidence: the four provider statuses, scripted by reference; anything unscripted is UNAVAILABLE, never guessed
  const intent = { reference: `kauro-payout-${w.ids.next()}`, destinationDigest: "d".repeat(64), amountCents: 84_500n, currency: "USD" };
  const observedAt = w.clock.now();
  for (const status of ["SUBMITTED", "SETTLED", "FAILED", "RETURNED"] as const) payouts.script(`evidence-${status}`, payouts.matching(intent, status));
  for (const status of ["SUBMITTED", "SETTLED", "FAILED", "RETURNED"] as const) {
    const answer = await payouts.verify({ evidenceRef: `evidence-${status}` });
    assert.ok(answer.kind === "VERIFIED", status);
    const e = answer.evidence;
    assert.deepEqual([e.status, e.reference, e.destinationDigest, e.amountCents, e.currency, e.observedAt], [status, intent.reference, intent.destinationDigest, 84_500n, "USD", observedAt], status);
    assert.match(e.evidenceHash, /^[0-9a-f]{64}$/);
  }
  const hashes = new Set<string>();
  for (const status of ["SUBMITTED", "SETTLED", "FAILED", "RETURNED"] as const) {
    const answer = await payouts.verify({ evidenceRef: `evidence-${status}` });
    if (answer.kind === "VERIFIED") hashes.add(answer.evidence.evidenceHash);
  }
  assert.equal(hashes.size, 4, "each status carries its own evidence hash");
  // a mismatching reference, destination or amount differs from the intent in exactly the named member
  for (const [member, key] of [["REFERENCE", "reference"], ["DESTINATION", "destinationDigest"], ["AMOUNT", "amountCents"]] as const) {
    const evidence = payouts.mismatching(intent, "SETTLED", member);
    payouts.script(`mismatch-${member}`, evidence);
    const answer = await payouts.verify({ evidenceRef: `mismatch-${member}` });
    assert.ok(answer.kind === "VERIFIED", member);
    for (const k of ["reference", "destinationDigest", "amountCents", "currency"] as const) {
      assert.equal(answer.evidence[k] === intent[k], k !== key, `${member} changes ${key} and nothing else (${k})`);
    }
    assert.equal(answer.evidence.status, "SETTLED");
  }
  assert.deepEqual(await payouts.verify({ evidenceRef: "never-scripted" }), { kind: "UNAVAILABLE", reason: PAYOUT_EVIDENCE_UNAVAILABLE });
  assert.equal(PAYOUT_EVIDENCE_UNAVAILABLE, "PAYOUT_EVIDENCE_UNAVAILABLE");
  assert.deepEqual(payouts.calls.slice(0, 2).map((c) => [c.port, c.operation, c.identity, c.at, c.sent]), [
    ["PayoutEvidenceVerifier", "VERIFY", "evidence-SUBMITTED", observedAt, true],
    ["PayoutEvidenceVerifier", "VERIFY", "evidence-SETTLED", observedAt, true],
  ]);
  assert.equal(payouts.calls.at(-1)?.identity, "never-scripted");
  assert.equal(payouts.calls.length, 4 + 4 + 3 + 1, "every call is recorded, answered or not");
  // a hold stops a verification at the provider after it was recorded
  const hold = payouts.hold("VERIFY");
  let answered = false;
  const pending = payouts.verify({ evidenceRef: "evidence-SETTLED" }).then((v) => {
    answered = true;
    return v;
  });
  await hold.reached;
  assert.equal(answered, false);
  assert.equal(payouts.calls.at(-1)?.identity, "evidence-SETTLED");
  hold.release();
  assert.equal((await pending).kind, "VERIFIED");
  // the other two fakes hold too, by their own operation names
  const buyerHold = buyers.hold("BUYER_TYPE_OF");
  const buyerPending = buyerOf(w.agencyId);
  await buyerHold.reached;
  buyerHold.release();
  assert.equal(await buyerPending, null);
  const completionHold = completions.hold("COMPLETIONS_OF");
  const completionPending = completionsOf(w.agencyId, captureId);
  await completionHold.reached;
  completionHold.release();
  assert.equal((await completionPending).length, 2);

  // reachable only from the ./testing subpath: no production entry point reaches the commercial fakes, no source imports the subpath
  const root = resolve(import.meta.dirname, "..", "..");
  const repo = resolve(root, "..", "..");
  const fakesDir = join(root, "src", "commercial", "testing");
  const fakeFiles = sourcesUnder(fakesDir);
  assert.ok(fakeFiles.length >= 5, "the four fakes, their holds and the index");
  const fromSubpath = reachableFrom(join(root, "src", "testing", "index.ts"));
  assert.ok(fakeFiles.every((f) => fromSubpath.has(f)), "the ./testing index reaches every commercial fake");
  const fromEntry = reachableFrom(join(root, "src", "index.ts"));
  assert.ok([...fromEntry].some((f) => f.endsWith(join("commercial", "authorizer.ts"))), "the walk follows the entry point into the commercial contracts");
  assert.deepEqual([...fromEntry].filter((f) => fakeFiles.includes(f)), [], "no production entry point reaches a commercial fake");
  assert.deepEqual([...fromEntry].filter((f) => f.startsWith(join(root, "src", "commercial") + (process.platform === "win32" ? "\\" : "/")) && /\btesting\b/.test(f)), []);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, { default: string }> };
  assert.equal(manifest.exports["./testing"]?.default, "./dist/src/testing/index.js");
  const rules = JSON.parse(readFileSync(join(repo, "architecture.rules.json"), "utf8")) as { testOnlySubpaths: string[] };
  assert.ok(rules.testOnlySubpaths.includes("/testing"));
  const production = [...sourcesUnder(join(repo, "packages")), ...sourcesUnder(join(repo, "apps"))];
  assert.deepEqual(production.filter((f) => /["']@kauro\/application\/testing["']/.test(readFileSync(f, "utf8"))), []);
  const testing: Record<string, unknown> = await import("../src/testing/index.js");
  for (const name of ["ContractFakeBuyerTypeReader", "ContractFakePreparationCompletion", "ContractFakeBankingCalendar", "ContractFakePayoutEvidence"]) assert.equal(typeof testing[name], "function", name);
  const main: Record<string, unknown> = await import("../src/index.js");
  for (const name of ["ContractFakeBuyerTypeReader", "ContractFakePreparationCompletion", "ContractFakeBankingCalendar", "ContractFakePayoutEvidence"]) assert.equal(main[name], undefined, `${name} is not on the main entry`);
});

test("the two shipped bindings that need no database answer only refusals: no buyer type is ever recorded (a quote is refused BUYER_TYPE_UNSET) and no payout evidence is available (a reconciliation is refused PAYOUT_EVIDENCE_UNAVAILABLE), and neither is a fake", async () => {
  const w: World = world();
  const buyers = new UnrecordedBuyerTypeReader();
  assert.equal(buyers.binding, "PLATFORM");
  for (const context of [w.tenant(), w.service(), w.operator()]) {
    assert.equal(await w.ports.unitOfWork.run(context, (uow) => buyers.buyerTypeOf(uow, { agencyId: w.agencyId })), null, context.kind);
  }
  const verifier = new UnavailablePayoutEvidenceVerifier();
  assert.notEqual(verifier.integrationClass, CONTRACT_FAKE);
  assert.deepEqual(await verifier.verify({ evidenceRef: "any-reference" }), { kind: "UNAVAILABLE", reason: PAYOUT_EVIDENCE_UNAVAILABLE });
  assert.deepEqual(await verifier.verify({ evidenceRef: "" }), { kind: "UNAVAILABLE", reason: PAYOUT_EVIDENCE_UNAVAILABLE });
  for (const shipped of [buyers, verifier] as const) {
    assert.equal((shipped as unknown as Record<string, unknown>)["evidenceClass"], undefined, "a shipped binding carries no simulated label");
    assert.equal((shipped as unknown as Record<string, unknown>)["contractFake"], undefined);
  }
});

// --- the fakes are test-only (architecture.rules.json testOnlySubpaths; D10-FAKE-1) -------------------------------------------------

const IMPORT = /(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** The source modules an entry point reaches through relative imports. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2];
      if (spec === undefined || !spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      if (existsSync(target)) visit(target);
    }
  };
  visit(entry);
  return seen;
}

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "test") continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) sourcesUnder(path, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}
