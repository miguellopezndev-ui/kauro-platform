// UI39 Company finance, owner sections O1 (bank route) and O2 (inbound credits) (docs/design/B12-owner-screens.md D-B12S-2..D-B12S-5; failure
// matrix rows O1/O2 web). Three layers tested apart, like the payment screens: the decisions (finance/model.ts), the markup (rendered on the
// server side of React), and the commands through the real api client, OperationRunner and the K0 step-up over a scripted fetch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEMAS } from "../src/api/generated.ts";
import { validateAgainst } from "../src/api/schema-guard.ts";
import { IdentityCredential } from "../src/client/identity/port.ts";
import { OperationRunner } from "../src/client/operation-runner.ts";
import { EN } from "../src/copy/en.ts";
import {
  type BankCreditView,
  type BankRouteView,
  attributeCredit,
  configureRoute,
  confirmCredit,
  creditRow,
  disableRoute,
  enableRoute,
  enterCredit,
  listCredits,
  queueRead,
  routeCommands,
  verifyRoute,
} from "../src/screens/finance/model.ts";
import { CreditQueue, RouteSection } from "../src/screens/finance/view.tsx";
import { HASH, harness, problem, respond, type Sent } from "./support/fixtures.ts";

const ROUTE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb1";
const CREDIT = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb2";
const ORDER_ID = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb3";
const PROOF = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7001";
const ACCOUNT = "acct.main:usd-1";
const NOW = Date.parse("2026-10-14T00:00:00Z");
const fastRunner = (): OperationRunner => new OperationRunner({ now: () => NOW, randomBytes: (n) => new Uint8Array(n).fill(7), wait: async () => undefined });
const credential = () => new IdentityCredential("CONTRACT_FAKE", "STEP_UP", "provider-token-value");
const obtain = async () => credential();
const bodyOf = (s: Sent | undefined): Record<string, unknown> => JSON.parse(s?.init.body ?? "{}") as Record<string, unknown>;
const STEP_UP_URL = "/api/v1/assurance/step-ups";
const proofReply = () => respond(201, { proofId: PROOF, expiresAt: "2026-10-14T00:10:00Z" });

const route = (over: Partial<BankRouteView> = {}): BankRouteView => ({ routeId: ROUTE, routeVersion: 2, version: 5, state: "VERIFIED", rollout: null, environment: "SANDBOX", accountRef: ACCOUNT, detailsEvidenceHash: HASH, verified: true, ...over });
const credit = (over: Partial<BankCreditView> = {}): BankCreditView => ({ creditId: CREDIT, accountRef: ACCOUNT, bankTransactionId: "txn-1", state: "DRAFT_MANUAL", version: 1, source: "OWNER_MANUAL", rail: "ACH", grossCents: "125000", feeCents: null, currency: "USD", reference: null, orderId: null, captureId: null, ...over });
const routeCompleted = (r: BankRouteView = route()) => ({ kind: "COMPLETED", version: r.version + 1, replayed: false, data: { route: r } });
const creditCompleted = (c: BankCreditView = credit()) => ({ kind: "COMPLETED", version: c.version + 1, replayed: false, data: { credit: c } });
const details = { mediaType: "application/json" as const, bytes: new TextEncoder().encode('{"format":"bank-details"}') };
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const ARTIFACT = "0199c1a2-7b3d-8c4e-8a5f-1b2c3d4e5fb9";
const uploaded = (bytes: Uint8Array, accountRef = ACCOUNT) => respond(201, { artifact: { artifactRef: ARTIFACT, evidenceHash: sha(bytes), sizeBytes: bytes.byteLength, mediaType: "application/json", accountRef } });

test("fixtures: the route, the credit and the queue page are valid against the generated schemas (a drifted fixture cannot prove anything)", () => {
  assert.deepEqual(validateAgainst(SCHEMAS as never, "getBankRouteResponse200", { route: route() }), []);
  assert.deepEqual(validateAgainst(SCHEMAS as never, "getBankCreditResponse200", { data: { credit: credit() } }), []);
  assert.deepEqual(validateAgainst(SCHEMAS as never, "listBankCreditsResponse200", { data: { credits: [credit()], nextCursor: null } }), []);
});

// ---- O1: the bank route ----

test("O1: the route shows its state, version and evidence hash, never an account number, and offers only the commands its state permits", () => {
  assert.deepEqual(routeCommands(route({ state: "PENDING_VERIFICATION", verified: false })), ["VERIFY", "REPLACE_DETAILS"]);
  assert.deepEqual(routeCommands(route({ state: "VERIFIED" })), ["ENABLE", "REPLACE_DETAILS"]);
  assert.deepEqual(routeCommands(route({ state: "ENABLED", rollout: "CONTROLLED" })), ["DISABLE", "REPLACE_DETAILS"]);
  assert.deepEqual(routeCommands(route({ state: "DISABLED" })), ["REPLACE_DETAILS"]);
  const html = renderToStaticMarkup(createElement(RouteSection, { route: route({ state: "ENABLED", rollout: "CONTROLLED" }), busy: false, onCommand: () => undefined }));
  for (const text of [EN["screen.finance.route.state.ENABLED"], ACCOUNT, HASH, "2"]) assert.ok(html.includes(text), text);
  assert.ok(html.includes(EN["screen.finance.route.command.DISABLE"]));
  assert.ok(!html.includes(EN["screen.finance.route.command.VERIFY"]), "a command the state does not permit has no control");
  assert.ok(!html.includes(EN["screen.finance.route.command.ENABLE"]));
  assert.doesNotMatch(html, /routing number|account number/i, "the owner's route view never names the bank's numbers");
  const busy = renderToStaticMarkup(createElement(RouteSection, { route: route(), busy: true, onCommand: () => undefined }));
  assert.match(busy, /<button[^>]*disabled/, "a running command disables the controls");
});

test("O1/GAP-API-8: configure uploads the details file first, then sends the returned reference and hash under one form key; a refused upload sends nothing", async () => {
  const runner = fastRunner();
  const form = runner.openForm("CMD201");
  const { client, sent } = harness(async (s) => (s.url.includes("/evidence-artifacts") ? uploaded(details.bytes) : respond(201, routeCompleted(route({ state: "PENDING_VERIFICATION", verified: false })))));
  const input = { provider: "contract-fake-bank", environment: "SANDBOX" as const, accountRef: ACCOUNT, currency: "USD" as const, acceptedRails: ["ACH" as const], minimumTransferWindowMs: 345_600_000, instructionLifetimeMs: 864_000_000, providerTimeToleranceMs: 86_400_000, feePolicyVersion: "bank-fee-v1", timingSource: { url: "https://wise.com/help/articles/2827506", accessedOn: "2026-10-07" } };
  const result = await configureRoute(client, runner, form, input, details);
  assert.equal(result.kind, "RAN");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.url, "/api/v1/operations/bank-accounts/acct.main%3Ausd-1/evidence-artifacts", "the upload is first");
  assert.equal(sent[0]?.init.headers["Idempotency-Key"], undefined, "the content-addressed upload carries no key");
  assert.deepEqual(bodyOf(sent[0]), { mediaType: "application/json", contentBase64: Buffer.from(details.bytes).toString("base64"), evidenceHash: sha(details.bytes) });
  assert.equal(sent[1]?.url, "/api/v1/operations/bank-routes");
  assert.equal(sent[1]?.init.headers["Idempotency-Key"], form.key, "the configure runs under the form's key");
  assert.deepEqual(bodyOf(sent[1]), { ...input, detailsArtifactRef: ARTIFACT, detailsEvidenceHash: sha(details.bytes) });
  // a refused upload (the store answered a hash mismatch): nothing is configured, the form and its key stay
  const refused = harness(async () => respond(422, problem(422, "INTEGRITY_FAILURE", { reason: "HASH_MISMATCH" })));
  const again = await configureRoute(refused.client, runner, form, input, details);
  assert.equal(again.kind, "UPLOAD_REFUSED");
  assert.equal(refused.sent.length, 1, "configure is never sent after a refused upload");
  // an upload answered for another account is never cited
  const other = harness(async () => uploaded(details.bytes, "acct-other"));
  assert.equal((await configureRoute(other.client, runner, form, input, details)).kind, "UPLOAD_REFUSED");
  assert.equal(other.sent.length, 1);
});

test("O1 W-KEYS: verify, enable and disable run under the route version's key; a double activation sends once and a lost answer replays the same key", async () => {
  const commandsOf = (sent: readonly Sent[]) => sent.filter((s) => s.url !== STEP_UP_URL);
  const slow = harness(async (s) => {
    if (s.url === STEP_UP_URL) return proofReply();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return respond(200, routeCompleted(route({ state: "VERIFIED" })));
  });
  const runner = fastRunner();
  const pending = route({ state: "PENDING_VERIFICATION", verified: false });
  const [a, b] = await Promise.all([verifyRoute(slow.client, runner, pending, "kyc-review-1", obtain), verifyRoute(slow.client, runner, pending, "kyc-review-1", obtain)]);
  assert.equal(a.kind, "DONE");
  assert.equal(b.kind, "DONE");
  const verifies = commandsOf(slow.sent);
  assert.equal(verifies.length, 1, "the in-flight run is joined, never repeated");
  assert.equal(verifies[0]?.url, `/api/v1/operations/bank-routes/${ROUTE}/verify`);
  assert.deepEqual(bodyOf(verifies[0]), { expectedVersion: 2, verificationEvidenceRef: "kyc-review-1", authorizationRef: PROOF });
  // the same route version derives the same key; a newer version is a new intent
  const keyed = harness(async (s) => (s.url === STEP_UP_URL ? proofReply() : respond(200, routeCompleted())));
  await enableRoute(keyed.client, fastRunner(), route(), "CONTROLLED", ["0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc1"], obtain);
  await enableRoute(keyed.client, fastRunner(), route(), "CONTROLLED", ["0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc1"], obtain);
  await enableRoute(keyed.client, fastRunner(), route({ version: 6 }), "CONTROLLED", ["0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc1"], obtain);
  const keys = commandsOf(keyed.sent).map((s) => s.init.headers["Idempotency-Key"]);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.deepEqual(bodyOf(commandsOf(keyed.sent)[0]), { expectedVersion: 2, rollout: "CONTROLLED", participants: ["0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc1"], authorizationRef: PROOF });
  // a lost answer: the same key and the same proof again, ending as Checking, never failed and never a new key
  const lost = harness(async (s) => {
    if (s.url === STEP_UP_URL) return proofReply();
    throw new TypeError("network");
  });
  const disabled = await disableRoute(lost.client, fastRunner(), route({ state: "ENABLED", rollout: "CONTROLLED" }), obtain);
  assert.equal(disabled.kind, "DONE");
  assert.equal(disabled.kind === "DONE" ? disabled.outcome.kind : null, "CHECKING");
  const disables = commandsOf(lost.sent);
  assert.ok(disables.length >= 2);
  assert.equal(new Set(disables.map((s) => s.init.headers["Idempotency-Key"])).size, 1);
  assert.equal(lost.sent.filter((s) => s.url === STEP_UP_URL).length, 1, "the identity token travelled once");
});

// ---- O2: the inbound credits ----

test("O2: the queue lists one state with keyset pages, an absent fee is Unknown and never zero, and an empty queue says so", async () => {
  const { client, sent } = harness(async () => respond(200, { data: { credits: [credit(), credit({ creditId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb4", feeCents: "0" })], nextCursor: "AAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }));
  const first = queueRead(await listCredits(client, "DRAFT_MANUAL", null));
  assert.equal(sent[0]?.url, "/api/v1/operations/bank-credits?state=DRAFT_MANUAL");
  assert.equal(first.kind, "READY");
  if (first.kind !== "READY") return;
  await listCredits(client, "DRAFT_MANUAL", first.nextCursor);
  assert.equal(sent[1]?.url, `/api/v1/operations/bank-credits?state=DRAFT_MANUAL&cursor=${encodeURIComponent(first.nextCursor ?? "")}`, "the next page continues the same state");
  assert.equal(creditRow(credit()).fee, EN["screen.finance.credit.fee.unknown"], "an unknown fee is Unknown");
  assert.equal(EN["screen.finance.credit.fee.unknown"], "Unknown");
  assert.notEqual(creditRow(credit({ feeCents: "0" })).fee, EN["screen.finance.credit.fee.unknown"], "an observed zero is zero");
  assert.deepEqual(creditRow(credit()).commands, ["CONFIRM"]);
  assert.deepEqual(creditRow(credit({ state: "MATCH_REVIEW", version: 3 })).commands, ["ATTRIBUTE"]);
  for (const state of ["OBSERVED", "MATCHED", "APPLIED", "RETURN_REVIEW"] as const) assert.deepEqual(creditRow(credit({ state })).commands, [], state);
  const html = renderToStaticMarkup(createElement(CreditQueue, { state: "DRAFT_MANUAL", read: first, onState: () => undefined, onMore: () => undefined, onOpen: () => undefined }));
  assert.ok(html.includes("Unknown"));
  assert.ok(html.includes(EN["screen.finance.queue.more"]), "a page with a cursor offers the next page");
  assert.doesNotMatch(html, /routing number|account number/i);
  const empty = renderToStaticMarkup(createElement(CreditQueue, { state: "MATCH_REVIEW", read: { kind: "READY", credits: [], nextCursor: null }, onState: () => undefined, onMore: () => undefined, onOpen: () => undefined }));
  assert.ok(empty.includes(EN["screen.finance.queue.empty"]));
  assert.ok(!empty.includes(EN["screen.finance.queue.more"]), "the last page offers no next page");
});

test("O2/CMD211-212: confirm and attribute run under the credit version's key with one step-up proof each; an expired proof is the STEP_UP state that keeps the form", async () => {
  const { client, sent } = harness(async (s) => (s.url === STEP_UP_URL ? proofReply() : respond(200, creditCompleted(credit({ state: "OBSERVED", version: 2 })))));
  const confirmed = await confirmCredit(client, fastRunner(), credit(), obtain);
  assert.equal(confirmed.kind, "DONE");
  assert.equal(sent[0]?.url, STEP_UP_URL);
  assert.equal(sent[1]?.url, `/api/v1/operations/bank-credits/${CREDIT}/confirmations`);
  assert.deepEqual(bodyOf(sent[1]), { expectedVersion: 1, authorizationRef: PROOF });
  const review = credit({ state: "MATCH_REVIEW", version: 3 });
  const input = { orderId: ORDER_ID, billingEvidenceRef: "billing-evidence-1", reasonCode: "Customer billing evidence verified" };
  await attributeCredit(client, fastRunner(), review, input, obtain);
  assert.equal(sent[2]?.url, STEP_UP_URL, "a second command takes its own proof");
  assert.equal(sent[3]?.url, `/api/v1/operations/bank-credits/${CREDIT}/attributions`);
  assert.deepEqual(bodyOf(sent[3]), { expectedVersion: 3, ...input, authorizationRef: PROOF });
  assert.notEqual(sent[1]?.init.headers["Idempotency-Key"], sent[3]?.init.headers["Idempotency-Key"]);
  // the same credit version: the same key (a reload replays)
  await confirmCredit(client, fastRunner(), credit(), obtain);
  assert.equal(sent[5]?.init.headers["Idempotency-Key"], sent[1]?.init.headers["Idempotency-Key"]);
  // the api refuses the proof as stale: the STEP_UP state, nothing failed
  const stale = harness(async (s) => (s.url === STEP_UP_URL ? proofReply() : respond(403, problem(403, "ASSURANCE_REQUIRED", { reason: "STEP_UP_STALE" }))));
  const refused = await attributeCredit(stale.client, fastRunner(), review, input, obtain);
  assert.deepEqual(refused, { kind: "STEP_UP", cause: "PROOF_STALE" });
});

test("O2/CMD210: enter uploads the bank artifact first, then sends the typed facts with the returned reference and hash under one form key and one step-up proof", async () => {
  const runner = fastRunner();
  const form = runner.openForm("CMD210");
  const artifact = { mediaType: "application/json" as const, bytes: new TextEncoder().encode('{"format":"bank-credit"}') };
  const { client, sent } = harness(async (s) => (s.url.includes("/evidence-artifacts") ? uploaded(artifact.bytes) : s.url === STEP_UP_URL ? proofReply() : respond(201, creditCompleted())));
  const facts = { bankTransactionId: "txn-42", rail: "ACH" as const, grossCents: "125000", currency: "USD" as const, reference: null, bookedAt: "2026-10-13T12:00:00.000Z" };
  const result = await enterCredit(client, runner, form, ACCOUNT, facts, artifact, obtain);
  assert.equal(result.kind, "DONE");
  assert.deepEqual(sent.map((s) => s.url), [`/api/v1/operations/bank-accounts/acct.main%3Ausd-1/evidence-artifacts`, STEP_UP_URL, "/api/v1/operations/bank-accounts/acct.main%3Ausd-1/credits"]);
  assert.equal(sent[2]?.init.headers["Idempotency-Key"], form.key);
  assert.deepEqual(bodyOf(sent[2]), { ...facts, evidence: { artifactRef: ARTIFACT, evidenceHash: sha(artifact.bytes) }, authorizationRef: PROOF });
});

test("O2 DENY: a 403 clears the queue and the credit", async () => {
  const { client } = harness(async () => respond(403, problem(403, "NOT_AUTHORIZED", { reason: "CORPORATE_ROLE_MISSING" })));
  const read = queueRead(await listCredits(client, "MATCH_REVIEW", null));
  assert.equal(read.kind, "REFUSED");
  assert.equal(read.kind === "REFUSED" ? read.decision.state : null, "DENIED");
  const html = renderToStaticMarkup(createElement(CreditQueue, { state: "MATCH_REVIEW", read, onState: () => undefined, onMore: () => undefined, onOpen: () => undefined }));
  assert.doesNotMatch(html, /<table|<li data-credit/, "no credit row is drawn beside a refusal");
  assert.ok(!html.includes(CREDIT));
  assert.match(html, /data-state="DENIED"/, "the refusal is the shared state panel");
});
