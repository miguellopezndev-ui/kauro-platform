// Kauro's canonical synthetic world (Order 11 round 3, master plan §2.1; tools/review/private/lib/canon): it reconciles, its stress
// variants reconcile, it keeps the public sample exactly as the public site states it, it keeps the names and ids the review already
// uses, its figures follow the owner's money rules, its packages are what Migration Core 3.0.0 writes (the core's file names everywhere,
// and the three projects the engine ran equal to its summary.json, read from the archive when it is present), the reconciliation catches a
// broken world, and world.json is a current export.
// Node 24 loads the module's .ts files with its built-in type stripping; nothing is built first.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const canonDir = join(root, "tools", "review", "private", "lib", "canon");
const canon = await import("../review/private/lib/canon/index.ts");
const { reconcile, missingSteps } = await import("../review/private/lib/canon/reconcile.ts");
const engine = await import("../review/private/lib/canon/engine.ts");
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
  // the counts are the public site's; the file names are the core's (sample-data.ts keeps its own names, a public-site change)
  assert.deepEqual(example.outputs.map((one) => [one.path, one.sourceRows, one.unifiedRows, one.heldBackRows, one.unreadableRows, one.rows]), [
    ["01_IMPORT/hubspot/contacts.csv", contacts.source, contacts.unified, 0, 0, contacts.rows],
    ["01_IMPORT/hubspot/companies.csv", companies.source, companies.unified, 0, 0, companies.rows],
  ]);
  assert.deepEqual([contacts.source, contacts.unified, contacts.rows, companies.source, companies.unified, companies.rows], [12_480, 214, 12_266, 3_204, 253, 2_951]);
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
    ["delivered rows that are not source less unified, held back and not readable", (w) => (find(w.projects, PRJ.coQ4).outputs[0].rows -= 1), /contacts\.csv rows/],
    ["a held-back row the engine did not set aside", (w) => (find(w.projects, PRJ.hoDealers).outputs[0].heldBackRows += 1), /companies\.csv rows|isolated\.csv/],
    ["an invented output file name", (w) => (find(w.projects, PRJ.coQ4).outputs[0].path = "01_IMPORT/hubspot/contacts-hubspot.csv"), /not a name Migration Core 3\.0\.0 writes/],
    ["a file under another service's folder", (w) => (find(w.projects, PRJ.hoDealers).outputs[0].path = "01_IMPORT/hubspot/companies.csv"), /not a name Migration Core 3\.0\.0 writes for CLEAN/],
    ["relationships that do not add up", (w) => (find(w.projects, PRJ.coAccounts).associations[0].unresolved += 1), /source edges/],
    ["an engine file whose rows differ from the project", (w) => (find(w.projects, PRJ.coAccounts).engine.files.find((one) => one.path === "02_EXCEPTIONS/rejected-input.csv").rows = 7), /rejected-input\.csv holds 7 rows/],
    ["a contact-roles file 3.0.0 cannot write", (w) => find(w.projects, PRJ.nwOpportunities).outputs.push({ path: "01_IMPORT/salesforce/contact-roles-salesforce.csv", name: "contact-roles-salesforce.csv", object: "CONTACT_ROLES", sourceRows: 0, unifiedRows: 0, heldBackRows: 0, unreadableRows: 0, rows: 0 }), /contact-roles-salesforce\.csv is not a name|writes no such file/],
    ["an import file no stage loads", (w) => (find(w.projects, PRJ.coAccounts).importStages = find(w.projects, PRJ.coAccounts).importStages.slice(0, 2)), /loaded by exactly one import stage/],
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

test("every package file is named as Migration Core 3.0.0 names it, and delivered = source less unified, held back and not readable", () => {
  const worlds = [CANON, ...Object.values(STRESS_WORLDS)];
  let checked = 0;
  for (const world of worlds) {
    for (const one of world.projects) {
      const paths = [...one.outputs.map((file) => file.path), ...one.associations.map((file) => file.path), ...one.importStages.map((stage) => stage.path), ...(one.engine?.files.map((file) => file.path) ?? [])];
      for (const path of paths) {
        assert.match(path, engine.PACKAGE_PATH, `${one.name}: ${path}`);
        if (path.startsWith("01_IMPORT/")) assert.ok(path.startsWith(`01_IMPORT/${engine.ADAPTER[one.service]}/`), `${one.name}: ${path} under its service's folder`);
        checked += 1;
      }
      for (const output of one.outputs) assert.equal(output.sourceRows, output.rows + output.unifiedRows + output.heldBackRows + output.unreadableRows, `${one.name}: ${output.path}`);
      for (const file of one.associations) assert.equal(file.sourceEdges, file.rows + file.deduplicated + file.unresolved, `${one.name}: ${file.path}`);
    }
  }
  assert.ok(checked > 80, "the canon's packages were all checked");
  assert.doesNotMatch(JSON.stringify(CANON.projects.map((one) => [one.outputs, one.associations, one.importStages])), /-clean\.csv|-hubspot\.csv|-salesforce\.csv/, "no invented output names remain");
  // only the three projects the engine ran carry its run, and only they hold rows held back or not readable
  assert.deepEqual(CANON.projects.filter((one) => one.engine !== null).map((one) => one.id).sort(), [PRJ.coAccounts, PRJ.example, PRJ.hoDealers].sort());
  for (const one of CANON.projects.filter((candidate) => candidate.engine === null)) for (const output of one.outputs) assert.deepEqual([output.heldBackRows, output.unreadableRows], [0, 0], one.name);
});

test("Opportunities (…7205) has no contact-role file or stage: 3.0.0 cannot produce one", () => {
  const opportunities = project(PRJ.nwOpportunities);
  assert.deepEqual(opportunities.outputs.map((one) => [one.path, one.rows]), [["01_IMPORT/salesforce/Opportunity.csv", 1_840]]);
  assert.deepEqual(opportunities.importStages.map((one) => [one.order, one.path, one.state]), [[1, "01_IMPORT/salesforce/Opportunity.csv", "WAITING"]]);
  assert.equal(opportunities.sources.find((one) => one.object === "CONTACT_ROLES").selected, false, "the contact-roles export was left out at selection");
  assert.equal(opportunities.units, 1_840);
  assert.equal(CANON.quotes.find((one) => one.projectId === PRJ.nwOpportunities).units, 1_840);
  assert.equal(engine.importPath("SALESFORCE", "CONTACT_ROLES"), null);
});

test("the three projects Migration Core ran hold its figures, as the canon states them", () => {
  const figures = (id) => {
    const one = project(id);
    return {
      outputs: one.outputs.map((file) => [file.path, file.sourceRows, file.rows, file.unifiedRows, file.heldBackRows, file.unreadableRows]),
      associations: one.associations.map((file) => [file.path, file.sourceEdges, file.rows, file.deduplicated, file.unresolved]),
      stages: one.importStages.map((stage) => [stage.order, stage.path, stage.rows]),
      run: [one.engine.runId, one.engine.checksPassed, one.engine.files.length, one.engine.reportVariant],
    };
  };
  assert.deepEqual(figures(PRJ.example), {
    outputs: [["01_IMPORT/hubspot/contacts.csv", 12_480, 12_266, 214, 0, 0], ["01_IMPORT/hubspot/companies.csv", 3_204, 2_951, 253, 0, 0]],
    associations: [["01_IMPORT/hubspot/associations/contact_to_company.csv", 11_343, 11_129, 214, 0]],
    stages: [],
    run: ["run_3b9567f72e0bba6cb9ef7b89", 65, 24, null],
  });
  assert.deepEqual(figures(PRJ.coAccounts), {
    outputs: [["01_IMPORT/salesforce/Account.csv", 9_980, 9_761, 212, 4, 3], ["01_IMPORT/salesforce/Contact.csv", 61_400, 59_654, 1_734, 7, 5]],
    associations: [["01_IMPORT/salesforce/associations/contact_to_company.csv", 57_675, 56_009, 1_613, 53]],
    stages: [[1, "01_IMPORT/salesforce/Account.csv", 9_761], [2, "01_IMPORT/salesforce/Contact.csv", 59_654], [3, "01_IMPORT/salesforce/associations/contact_to_company.csv", 56_009]],
    run: ["run_d5ec68c7e07cb8f7c90fb377", 65, 25, { runId: "run_325c19a659493c1e8468f588", sourceRows: 71_372 }],
  });
  assert.deepEqual(figures(PRJ.hoDealers), {
    outputs: [["01_IMPORT/clean-only/companies.csv", 3_980, 3_917, 57, 4, 2]],
    associations: [],
    stages: [],
    run: ["run_b04e17cbf39f3809cebee937", 60, 22, { runId: "run_25f889238c3b90ec5ddd5973", sourceRows: 3_978 }],
  });
});

// the archive exists on the owner's machine only; CI without it still checks the canon's own figures above
const ARCHIVE = join(root, "..", "Kauro.archive", "Deliveries", "Visual", "order11", "research", "round3-docs-canon", "packages");
test("the three projects Migration Core ran equal its summary.json (when the archive is present)", (t) => {
  const ran = CANON.projects.filter((one) => one.engine !== null);
  const present = ran.filter((one) => existsSync(join(ARCHIVE, engine.RUN_FOLDERS[one.engine.runId].main, "summary.json")));
  if (present.length === 0) {
    t.skip(`archive not present: ${ARCHIVE}`);
    return;
  }
  assert.equal(present.length, 3, "all three summaries, or none");
  const sumOf = (values) => values.reduce((total, one) => total + one, 0);
  for (const one of present) {
    const folders = engine.RUN_FOLDERS[one.engine.runId];
    const summary = JSON.parse(readFileSync(join(ARCHIVE, folders.main, "summary.json"), "utf8"));
    const label = `${one.name} (${one.id.slice(-4)})`;
    assert.equal(summary.coreVersion, one.engine.coreVersion, label);
    assert.equal(summary.runId, one.engine.runId, label);
    assert.equal(summary.manifestSha256, one.engine.manifestSha256, label);
    assert.equal(summary.verifyLine, `package verified: ${one.engine.files.length} artifacts, ${one.units} source rows, ${one.engine.checksPassed} checks passed`, label);
    const rec = summary.reconciliation;
    assert.deepEqual(rec.sourceRows.byDisposition, {
      ISOLATED: sumOf(one.outputs.map((file) => file.heldBackRows)),
      LEFTOVER: 0,
      MERGED_PROVEN: sumOf(one.outputs.map((file) => file.unifiedRows)),
      OUTPUT: sumOf(one.outputs.map((file) => file.rows)),
      REJECTED_INPUT: sumOf(one.outputs.map((file) => file.unreadableRows)),
    }, label);
    assert.equal(rec.sourceRows.total, one.units, label);
    const byObject = { COMPANY: 0, CONTACT: 0, DEAL: 0, LEAD: 0 };
    for (const file of one.outputs) byObject[engine.CORE_OBJECT[file.object]] += file.rows;
    assert.deepEqual(rec.records.byObject, byObject, label);
    // per source file: the rows read, and its lines not readable are its object's
    for (const input of summary.inputs) {
      const source = one.sources.find((file) => file.name === input.path);
      const output = one.outputs.find((file) => file.object === source.object);
      assert.equal(sumOf(input.sheets.map((sheet) => sheet.readerRowCount)), source.rows, `${label}: ${input.path}`);
      assert.equal(sumOf(input.sheets.map((sheet) => sheet.rejectedRowCount)), output.unreadableRows, `${label}: ${input.path} not readable`);
    }
    // unified rows per object, from the merges' group sizes (a merge of n rows absorbs n - 1)
    const absorbed = {};
    for (const [key, count] of Object.entries(summary.merges.groupSizes)) {
      const [object, size] = key.split(":");
      absorbed[object] = (absorbed[object] ?? 0) + count * (Number(size) - 1);
    }
    for (const file of one.outputs) assert.equal(absorbed[engine.CORE_OBJECT[file.object]] ?? 0, file.unifiedRows, `${label}: ${file.path} unified`);
    assert.deepEqual(rec.associations.byDisposition, {
      DEDUPLICATED: sumOf(one.associations.map((file) => file.deduplicated)),
      LEFTOVER: 0,
      OUTPUT: sumOf(one.associations.map((file) => file.rows)),
      UNRESOLVED: sumOf(one.associations.map((file) => file.unresolved)),
    }, label);
    assert.deepEqual(summary.artifacts.map((file) => ({ path: file.path, kind: file.kind, rows: file.rows })), one.engine.files, `${label}: every package file, its kind and its rows`);
    if (folders.variant !== null) {
      const variant = JSON.parse(readFileSync(join(ARCHIVE, folders.variant, "summary.json"), "utf8"));
      assert.deepEqual([variant.runId, variant.reconciliation.sourceRows.total], [one.engine.reportVariant.runId, one.engine.reportVariant.sourceRows], `${label}: report variant`);
      assert.equal(variant.reconciliation.sourceRows.byDisposition.REJECTED_INPUT, 0, `${label}: the variant has no line not readable`);
      assert.deepEqual(variant.reconciliation.records.byObject, rec.records.byObject, `${label}: the variant delivers the same records`);
    }
  }
});

test("world.json is a current export of the module", async () => {
  const { exportText } = await import("../review/private/lib/canon/export.mjs");
  assert.equal(readFileSync(join(canonDir, "world.json"), "utf8"), await exportText(), "run node tools/review/private/lib/canon/export.mjs");
});
