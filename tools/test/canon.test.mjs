// Kauro's canonical synthetic world (Order 11 round 3, master plan §2.1; tools/review/private/lib/canon): it reconciles, its stress
// variants reconcile, it keeps the public sample exactly as the public site states it, it keeps the names and ids the review already
// uses, its figures follow the owner's money rules, the reconciliation catches a broken world, and world.json is a current export.
// Node 24 loads the module's .ts files with its built-in type stripping; nothing is built first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const canonDir = join(root, "tools", "review", "private", "lib", "canon");
const canon = await import("../review/private/lib/canon/index.ts");
const { reconcile, missingSteps } = await import("../review/private/lib/canon/reconcile.ts");
const sample = await import("../../apps/web/src/public/sample-data.ts");
const { CANON, STRESS_WORLDS, PRJ, WS, SELLER, P } = canon;

const byId = (list, id) => list.find((one) => one.id === id);
const project = (id) => byId(CANON.projects, id);

test("the canonical world reconciles: every count, amount, date and reference agrees", () => {
  assert.deepEqual(reconcile(CANON), []);
});

test("every stress variant is a whole world that reconciles on its own", () => {
  assert.deepEqual(Object.keys(STRESS_WORLDS).sort(), ["emptyAgency", "failedRun", "list200", "longNames", "nineDigitCounts", "partialRun", "unicode"]);
  for (const [key, world] of Object.entries(STRESS_WORLDS)) assert.deepEqual(reconcile(world), [], key);
});

test("the world covers every step of the project path, the three services, every role, and the buyers the plan asks for", () => {
  assert.deepEqual(missingSteps(CANON), []);
  assert.deepEqual([...new Set(CANON.projects.map((one) => one.service))].sort(), ["CLEAN", "HUBSPOT", "SALESFORCE"]);
  assert.deepEqual([...new Set(CANON.memberships.map((one) => one.role))].sort(), ["ADMIN", "APPROVER", "BILLING", "OPERATOR", "OWNER", "VIEWER"]);
  const kinds = (kind) => CANON.workspaces.filter((one) => one.kind === kind);
  assert.equal(kinds("AGENCY").length, 7);
  assert.equal(kinds("COMPANY").length, 3);
  assert.ok(kinds("COMPANY").some((one) => one.acquiredBySellerId === null), "a company buying direct");
  assert.equal(kinds("EXAMPLE").length, 1);
  assert.equal(CANON.projects.length, 20);
  // payment, both ways: one order waiting for a transfer, one held with proof of an initiated transfer
  assert.deepEqual(CANON.orders.filter((one) => one.state !== "PAID").map((one) => one.state).sort(), ["AWAITING_TRANSFER", "HELD_PENDING_TRANSFER"]);
  assert.equal(CANON.holds.length, 1);
  // jobs, incidents, deletions, refund requests and claims in each state the screens draw
  assert.deepEqual([...new Set(CANON.jobs.map((one) => one.state))].sort(), ["FAILED", "QUEUED", "RUNNING", "SUCCEEDED"]);
  assert.deepEqual([...new Set(CANON.incidents.map((one) => one.state))].sort(), ["OPEN", "RESOLVED"]);
  assert.deepEqual([...new Set(CANON.deletions.map((one) => one.state))].sort(), ["DONE", "PENDING"]);
  assert.ok(CANON.deletions.every((one) => one.state === "PENDING" || one.receipt !== null));
  assert.deepEqual(CANON.refundClaims.map((one) => one.state).sort(), ["PENDING_LEGAL_REVIEW", "REFUSED"]);
  assert.deepEqual([...new Set(CANON.claims.map((one) => one.state))].sort(), ["ACCEPTED", "CONVERTED", "REJECTED", "SUBMITTED"]);
  assert.deepEqual([...new Set(CANON.releases.map((one) => one.state))].sort(), ["CANDIDATE", "HELD", "PROMOTED"]);
});

test("the public sample project is exactly the public site's sample data", () => {
  const example = project(PRJ.example);
  const [contacts, companies] = sample.MANIFEST_FILES;
  assert.equal(example.service, sample.SAMPLE_MODE);
  assert.deepEqual(example.sources.map((one) => one.name), [...sample.SAMPLE_SOURCES]);
  assert.equal(example.sources[0].rows, 12_480);
  assert.equal(example.sources[1].rows, 3_204);
  assert.equal(example.units, 15_684);
  const groups = example.duplicates[0].groups;
  assert.deepEqual([groups.pairs, groups.triples, groups.keptApartPairs], [193, 14, 7]);
  assert.equal(2 * groups.pairs + 3 * groups.triples, 428, "428 contacts in duplicate candidate groups");
  assert.equal(canon.SAMPLE_IN_GROUPS, 428);
  assert.deepEqual(example.duplicates.map((one) => one.unifiedRows), [214, 253]);
  assert.deepEqual(example.outputs.map((one) => [one.name, one.sourceRows, one.unifiedRows, one.rows]), [
    [contacts.name, 12_480, 214, 12_266],
    [companies.name, 3_204, 253, 2_951],
  ]);
  const quote = CANON.quotes.find((one) => one.projectId === PRJ.example);
  assert.equal(quote.illustrative, true);
  assert.deepEqual([quote.band, quote.listMinor, quote.discountMinor, quote.totalMinor], [0, 129_500, 0, 129_500], "Prepare for HubSpot, USD 1,295, the band up to 50,000 units");
  assert.equal(CANON.orders.some((one) => one.projectId === PRJ.example) || CANON.payments.some((one) => one.projectId === PRJ.example), false);
  // the review's main project carries the same files and counts, quoted with Northwind's 5% repeat discount
  const main = project(PRJ.nwMain);
  assert.equal(main.units, example.units);
  assert.deepEqual(byId(CANON.quotes, canon.MAIN_QUOTE).totalMinor, 123_025);
});

test("the names and ids the review already uses stay", () => {
  const worldTs = readFileSync(join(root, "tools", "review", "private", "lib", "world.ts"), "utf8");
  for (const [, id, name] of worldTs.matchAll(/agencyId: "([0-9a-f-]{36})", name: "([^"]+)"/g)) {
    if (name === "Example workspace") continue;
    assert.equal(byId(CANON.workspaces, id)?.name, name, `workspace ${id}`);
  }
  assert.equal(byId(CANON.workspaces, WS.example).name, "Example workspace");
  const contexts = readFileSync(join(root, "tools", "review", "private", "lib", "contexts.ts"), "utf8");
  assert.ok(contexts.includes(`AGENCY_ID = "${WS.northwind}"`) && contexts.includes(`COMPANY_ID = "${WS.halden}"`));
  assert.ok(contexts.includes(`userId: "${P.lena}"`), "the session's user is Lena Ortiz");
  const fixtures = readFileSync(join(root, "apps", "web", "test", "support", "fixtures.ts"), "utf8");
  assert.ok(fixtures.includes(`PROJECT = "${PRJ.nwMain}"`) && fixtures.includes(`QUOTE = "${canon.MAIN_QUOTE}"`) && fixtures.includes(`ORDER = "${canon.MAIN_ORDER}"`));
  const sales = readFileSync(join(root, "tools", "review", "private", "prototypes", "sales.ts"), "utf8");
  for (const seller of CANON.sellers) assert.ok(sales.includes(`name: "${seller.name}"`) && sales.includes(`uuid("${seller.id.slice(-4)}")`), seller.name);
  const people = CANON.people.map((one) => one.name);
  for (const name of ["Lena Ortiz", "Marco Bianchi", "Priya Nair", "Samuel Osei", "Ines Duarte", "Ruth Okafor", "Tomas Reyes", "Ana Silva"]) assert.ok(people.includes(name), name);
  const clients = CANON.clients.map((one) => one.name);
  for (const name of ["Larch Studio", "Osprey Freight", "Tidewell", "Harbor Mill"]) assert.ok(clients.includes(name), name);
  assert.equal(project(PRJ.nwMain).name, "Contacts and companies");
  assert.equal(project(PRJ.nwCustomerList).service, "CLEAN");
});

test("the commission rules are the registry's", () => {
  const policy = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", "policy.json"), "utf8"));
  for (const [key, value] of Object.entries(canon.COMMISSION)) assert.equal(policy.commission[key], value, key);
  assert.equal(policy.commission.base, "SERVICE_COLLECTED_AFTER_DISCOUNT_NET_OF_REFUND_EXCLUDING_TAX");
});

test("sellers see both figures, and the owner's money rules hold", () => {
  const figures = (id) => canon.sellerFigures(CANON, id);
  assert.deepEqual(figures(SELLER.daniel), {
    netAttributableRevenueMinor: 392_025,
    commissionGeneratedMinor: 31_821,
    commissionPaidMinor: 22_950,
    commissionPendingMinor: 8_871,
    commissionHeldMinor: 0,
    offsetBalanceMinor: 3_000,
    retainerPaidMinor: 0,
    retainerPendingMinor: 0,
    payoutsConfirmedMinor: 22_950,
  });
  assert.deepEqual(figures(SELLER.amara), {
    netAttributableRevenueMinor: 189_000,
    commissionGeneratedMinor: 18_900,
    commissionPaidMinor: 0,
    commissionPendingMinor: 18_900,
    commissionHeldMinor: 12_950,
    offsetBalanceMinor: 0,
    retainerPaidMinor: 15_000,
    retainerPendingMinor: 15_000,
    payoutsConfirmedMinor: 15_000,
  });
  const sellers = Object.fromEntries(CANON.sellers.map((one) => [one.name, one]));
  assert.equal(sellers["Lucía Ferrer"].state, "CANDIDATE", "a new seller");
  assert.equal(sellers["Amara Okafor"].agreement.retainerMinorPerMonth, 15_000, "a signed non-zero retainer, shown");
  assert.ok(CANON.sellers.filter((one) => one.agreement.retainerMinorPerMonth > 0).every((one) => one.agreement.signedOn !== null));
  assert.ok(CANON.offsets.some((one) => one.sellerId === SELLER.amara), "the retainer seller also has an offset");
  // Kauro's revenue is the service net of refunds; tax is apart and an order waiting for a transfer is not money
  const kauro = canon.kauroFigures(CANON);
  assert.deepEqual(kauro, { receivedMinor: 905_755, revenueMinor: 852_550, taxMinor: 11_305, refundedMinor: 41_900, awaitingMinor: 277_130, owedToSellersMinor: 42_771 });
  assert.equal(kauro.receivedMinor - kauro.refundedMinor, kauro.revenueMinor + kauro.taxMinor);
  // a refused claim and a refused refund read neutrally
  const refused = CANON.claims.find((one) => one.state === "REJECTED");
  assert.equal(refused.sellerMessage, "Not available to claim");
  assert.equal(canon.CLAIM_RULES_LEGAL_STATUS, "PENDING_LEGAL_VALIDATION");
  const refusedRefund = CANON.refundClaims.find((one) => one.state === "REFUSED");
  assert.doesNotMatch(refusedRefund.customerMessage, /change of plan|Tidewell|Northwind/);
});

test("the alerts due now follow the owner's rules", () => {
  const alerts = canon.computeAlerts(CANON).map((one) => [one.kind, one.subjectId, one.about, one.threshold]);
  assert.deepEqual(alerts, [
    ["BLOCKED", PRJ.rfMembers, "2026-10-18T14:00:00Z", null],
    ["CLAIM_ENDING", "c-04", "2026-10-24", 3],
    ["CLAIM_ENDING", "c-11", "2026-11-01", 14],
    ["DEADLINE", PRJ.nwCustomerList, "2026-10-23T13:30:00Z", null],
    ["DEADLINE", PRJ.nwTidewellContacts, "2026-10-23T21:00:00Z", null],
    ["DEADLINE", canon.MAIN_ORDER, "2026-10-23T23:59:59Z", null],
    ["DEADLINE", PRJ.rfMembers, "2026-10-24T12:00:00Z", null],
    ["INACTIVITY", SELLER.tomas, "2026-10-05", null],
  ]);
});

test("the world is frozen: no reader can change what another reader sees", () => {
  assert.ok(Object.isFrozen(CANON) && Object.isFrozen(CANON.projects) && Object.isFrozen(CANON.projects[0].dates) && Object.isFrozen(CANON.projects[0].sources[0]));
  assert.throws(() => {
    CANON.payments[0].amountMinor = 1;
  }, TypeError);
});

test("the stress variants hold what they promise", () => {
  const { emptyAgency, longNames, unicode, nineDigitCounts, list200, failedRun, partialRun } = STRESS_WORLDS;
  assert.equal(emptyAgency.workspaces.length, 1);
  assert.equal(emptyAgency.projects.length + emptyAgency.clients.length + emptyAgency.quotes.length, 0);
  for (const name of Object.values(canon.LONG_NAMES)) assert.ok(name.length >= 60, name);
  assert.equal(longNames.workspaces[0].name, canon.LONG_NAMES.workspace);
  const names = [...unicode.workspaces, ...unicode.people, ...unicode.projects].map((one) => one.name).join(" ");
  for (const script of [/\p{Script=Arabic}/u, /\p{Script=Hebrew}/u, /\p{Script=Han}/u, /\p{Script=Katakana}/u, /[ÆØŁÑ]/u]) assert.match(names, script);
  assert.deepEqual(canon.UNICODE_CASES.filter((one) => one.dir === "rtl").map((one) => one.script), ["Arabic", "Hebrew"]);
  const nine = nineDigitCounts.projects[0];
  assert.ok(nine.sources.every((one) => String(one.rows).length === 9) && String(nine.units).length === 9);
  assert.equal(nineDigitCounts.quotes.length, 0, "beyond the ladder: no quote");
  assert.equal(list200.projects.length, 200);
  assert.equal(new Set(list200.projects.map((one) => one.name)).size, 200);
  assert.equal(list200.projects[199].name, "Batch 200");
  assert.equal(failedRun.projects[0].check.state, "FAILED");
  assert.ok(failedRun.jobs.every((one) => one.state === "FAILED"));
  const stage = partialRun.projects[0].importStages[0];
  assert.deepEqual([stage.state, stage.succeeded, stage.failed], ["PARTIAL", 9_412, 588]);
});

test("the reconciliation catches a broken world", () => {
  const broken = (change) => {
    const world = structuredClone(CANON);
    change(world);
    return reconcile(world);
  };
  const find = (list, id) => list.find((one) => one.id === id);
  const cases = [
    ["a payment one cent off its quote", (w) => (find(w.payments, "pay-2026-0119").amountMinor += 1), /payment pay-2026-0119/],
    ["delivered rows that are not source less unified", (w) => (find(w.projects, PRJ.coQ4).outputs[0].rows -= 1), /contacts-hubspot\.csv rows/],
    ["units that are not the sealed rows", (w) => (find(w.projects, PRJ.juRenewals).units += 10), /units/],
    ["commission counted on a total with tax", (w) => (find(w.commissionLines, "AO-L2").basisMinor = 82_705), /tax is never commissioned/],
    ["an offset whose balance is not basis less applied", (w) => (find(w.offsets, "OF-DK-0007").balanceMinor = 0), /balance is not basis less applied/],
    ["a payment before its order", (w) => (find(w.payments, "pay-2026-0128").receivedAt = "2026-10-19T12:00:00Z"), /payment .* comes before order|received outside/],
    ["a reference to nothing", (w) => (find(w.commissionLines, "DK-L2").statementId = "st-missing"), /st-missing, which does not exist/],
    ["a statement total that does not add up", (w) => (find(w.statements, "st-ao-2026-10").totalMinor += 100), /total is not commission less offsets plus retainer/],
    ["a refusal that reveals the relationship", (w) => (find(w.claims, "c-12").sellerMessage = "Pinewood already wrote to Kauro"), /neutral message/],
    ["a repeat discount the ladder does not give", (w) => (find(w.quotes, "q-2026-0108").discountPercent = 5), /repeat ladder/],
    ["a retainer nobody signed", (w) => w.retainerLines.push({ id: "RT-DK", sellerId: SELLER.daniel, month: "2026-10", amountMinor: 15_000, statementId: "st-dk-2026-10", state: "ACCRUED" }), /retainer lines/],
    ["one collection counted twice", (w) => w.commissionLines.push({ ...find(w.commissionLines, "DK-L3"), id: "DK-L3b" }), /counted twice/],
    ["payouts above what was paid", (w) => (find(w.payouts, "PAYOUT-2026-09-002").amountMinor = 30_000), /payouts|payout/],
    ["a date that matters off the policy", (w) => (find(w.projects, PRJ.nwMain).matters = { ends: "FILES", at: "2026-10-28T10:58:00Z" }), /date that matters/],
    ["a statement off the business calendar", (w) => (find(w.statements, "st-dk-2026-10").payDue = "2026-11-16"), /the calendar gives/],
  ];
  for (const [label, change, pattern] of cases) {
    const problems = broken(change);
    assert.ok(problems.some((one) => pattern.test(one)), `${label}: ${JSON.stringify(problems)}`);
  }
});

test("world.json is a current export of the module", async () => {
  const { exportText } = await import("../review/private/lib/canon/export.mjs");
  assert.equal(readFileSync(join(canonDir, "world.json"), "utf8"), await exportText(), "run node tools/review/private/lib/canon/export.mjs");
});
