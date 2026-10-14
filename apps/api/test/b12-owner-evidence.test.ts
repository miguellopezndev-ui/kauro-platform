// B12 owner screens lane 1 (docs/design/B12-owner-screens.md D-B12S-2, D-B12S-3): the owner's evidence-artifact upload (GAP-API-8) and the
// inbound credit queue (GAP-API-9), through the REAL api of the integration world with the CONTRACT_FAKE restricted store (SIMULATED).
// The failure-matrix rows U and L of that design name these titles; each oracle reads the store's call log or the api's own replies.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { BANK_FAKE_FORMAT, BANK_FAKE_PROVIDER } from "@kauro/application/testing";
import type { BankEvidenceStore } from "@kauro/application";
import { BANK_PAYEE_DIGEST } from "./bank-support.js";
import { creditArtifact, enterC5, confirmC6, L, nextTxn, ownOwner, ownerGet, routeFor, startLane, stopLane, type CreditView } from "./inbound-lane-support.js";
import { call, freshKey, outcome, type Person, type Reply } from "./support.js";

before(async () => {
  await startLane();
});
after(async () => {
  await stopLane();
});

const OPS = "/api/v1/operations";
const uploadUrl = (accountRef: string): string => `${OPS}/bank-accounts/${accountRef}/evidence-artifacts`;
const queueUrl = (query: string): string => `${OPS}/bank-credits${query === "" ? "" : `?${query}`}`;
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const DAY = 86_400_000;
let seq = 0;

interface UploadBody {
  readonly mediaType: string;
  readonly contentBase64: string;
  readonly evidenceHash: string;
}
const bodyOf = (bytes: Uint8Array, mediaType = "application/json", hash = sha(bytes)): UploadBody => ({ mediaType, contentBase64: Buffer.from(bytes).toString("base64"), evidenceHash: hash });
const upload = (accountRef: string, body: UploadBody, token: string | null = L().owner.token): Promise<Reply> => call(L().iw.w, { url: uploadUrl(accountRef), token, agency: null, key: null, body });
const puts = (): number => L().bw.evidence.calls.filter((c) => c.port === "BankEvidenceStore" && c.operation === "PUT").length;

function detailsBytes(accountRef: string): Uint8Array {
  const details = { accountRef, detailsVersion: `details-b12-${++seq}`, currency: "USD", acceptedRails: ["ACH", "DOMESTIC_WIRE"], beneficiaryName: "Kauro Test Beneficiary", bankName: "Contract Fake Bank", routingNumber: "026073150", accountNumber: "000000000000", accountType: "CHECKING", payeeDigest: BANK_PAYEE_DIGEST, additionalFields: {}, validUntil: new Date(Date.now() + 60 * DAY).toISOString() };
  return new TextEncoder().encode(JSON.stringify({ format: BANK_FAKE_FORMAT, kind: "ACCOUNT_DETAILS", accountRef, details }));
}
interface ArtifactView {
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly accountRef: string;
}
const artifactOf = (r: Reply): ArtifactView => {
  assert.equal(r.status, 201, `upload: ${r.status} ${r.text}`);
  return r.json<{ artifact: ArtifactView }>().artifact;
};

test("U-OK: the owner uploads a bank artifact and a route is configured from the returned reference and hash", async () => {
  const { iw, bw } = L();
  const accountRef = `acct.b12:ok-${++seq}`;
  const bytes = detailsBytes(accountRef);
  const artifact = artifactOf(await upload(accountRef, bodyOf(bytes)));
  assert.equal(artifact.evidenceHash, sha(bytes), "the reply names the hash of exactly the bytes sent");
  assert.equal(artifact.sizeBytes, bytes.byteLength);
  assert.equal(artifact.mediaType, "application/json");
  assert.equal(artifact.accountRef, accountRef, "a Ref path value with '.' and ':' is the account the artifact is bound to");
  const stored = await bw.evidence.get(artifact.artifactRef);
  assert.ok(stored !== null, "the artifact is in the restricted store under the returned reference");
  assert.equal(stored.sha256, artifact.evidenceHash);
  assert.equal(stored.accountRef, accountRef);
  const configured = await call(iw.w, {
    url: `${OPS}/bank-routes`,
    token: L().owner.token,
    agency: null,
    key: freshKey("b12-configure"),
    body: { provider: BANK_FAKE_PROVIDER, environment: bw.environment, accountRef, currency: "USD", acceptedRails: ["ACH"], detailsArtifactRef: artifact.artifactRef, detailsEvidenceHash: artifact.evidenceHash, minimumTransferWindowMs: 4 * DAY, instructionLifetimeMs: 10 * DAY, providerTimeToleranceMs: DAY, feePolicyVersion: "bank-fee-v1", timingSource: { url: "https://wise.com/help/articles/2827506", accessedOn: "2026-10-07" } },
  });
  assert.equal(configured.status, 201, `configure from the uploaded artifact: ${configured.text}`);
});

test("U-LIMITS: a hash that is not the bytes', an empty or oversized artifact and bytes that are not the declared type are refused before the store is called", async () => {
  const accountRef = `acct-b12-limits-${++seq}`;
  const bytes = detailsBytes(accountRef);
  const before = puts();
  const cases: ReadonlyArray<readonly [string, UploadBody, string]> = [
    ["a hash of other bytes", bodyOf(bytes, "application/json", "0".repeat(64)), "422 INTEGRITY_FAILURE HASH_MISMATCH"],
    ["no bytes", bodyOf(new Uint8Array(0)), "400 INVALID_REQUEST ARTIFACT_SIZE_INVALID"],
    ["one byte over 512 KiB", bodyOf(new Uint8Array(524_289).fill(32)), "400 INVALID_REQUEST ARTIFACT_SIZE_INVALID"],
    ["JSON declared as a PDF", bodyOf(bytes, "application/pdf"), "422 INTEGRITY_FAILURE ARTIFACT_TYPE_MISMATCH"],
    ["a PDF declared as JSON", bodyOf(new TextEncoder().encode("%PDF-1.7\n%synthetic\n"), "application/json"), "422 INTEGRITY_FAILURE ARTIFACT_TYPE_MISMATCH"],
    ["a NUL byte in CSV", bodyOf(new Uint8Array([97, 44, 0, 10]), "text/csv"), "422 INTEGRITY_FAILURE ARTIFACT_TYPE_MISMATCH"],
    ["a JSON array is not an artifact", bodyOf(new TextEncoder().encode("[1]")), "422 INTEGRITY_FAILURE ARTIFACT_TYPE_MISMATCH"],
  ];
  for (const [label, body, expected] of cases) assert.equal(outcome(L().iw.w, await upload(accountRef, body)), expected, label);
  const badType = await upload(accountRef, { ...bodyOf(bytes), mediaType: "image/png" });
  assert.equal(badType.status, 400, `an undeclared media type is a schema violation: ${badType.text}`);
  const dotted = await upload("..", bodyOf(bytes));
  assert.ok(dotted.status === 400 || dotted.status === 404, `a dot segment is never an account: ${dotted.status}`);
  assert.equal(puts(), before, "no refused upload reached the restricted store");
});

test("U-DENY: a person without KAURO_OWNER, a revoked grant and no credential are refused and the store is never called", async () => {
  const { iw } = L();
  const accountRef = `acct-b12-deny-${++seq}`;
  const body = bodyOf(detailsBytes(accountRef));
  const before = puts();
  const stranger: Person = await iw.w.person(`b12-stranger-${seq}`);
  assert.equal(outcome(iw.w, await upload(accountRef, body, stranger.token)), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  const revoked = await ownOwner(`b12-revoked-${seq}`);
  await iw.h.revokeCorporateGrant(revoked.grantId);
  assert.equal(outcome(iw.w, await upload(accountRef, body, revoked.person.token)), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.equal((await upload(accountRef, body, null)).status, 401, "no credential");
  assert.equal(puts(), before, "the store is called only after the owner is authorized");
});

test("U-RETRY: the same bytes uploaded twice, and concurrently, answer one reference; a lost answer is retried safely", async () => {
  const accountRef = `acct-b12-retry-${++seq}`;
  const bytes = detailsBytes(accountRef);
  const [a, b] = await Promise.all([upload(accountRef, bodyOf(bytes)), upload(accountRef, bodyOf(bytes))]);
  const first = artifactOf(a);
  assert.equal(artifactOf(b).artifactRef, first.artifactRef, "two concurrent uploads of the same bytes are one artifact");
  // the answer of the first was lost: the owner sends the same bytes again
  const again = artifactOf(await upload(accountRef, bodyOf(bytes)));
  assert.deepEqual(again, first, "a retry answers the same artifact, never a second one");
});

test("U-TIMEOUT: a store that does not answer within the provider-call bound is CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE and retryable", async () => {
  const { iw, bw } = L();
  const accountRef = `acct-b12-timeout-${++seq}`;
  const real = bw.evidence;
  const silent: BankEvidenceStore = { integrationClass: real.integrationClass, get: (ref) => real.get(ref), put: () => new Promise(() => undefined) };
  iw.w.bank.evidence = silent;
  try {
    const r = await upload(accountRef, bodyOf(detailsBytes(accountRef)));
    assert.equal(outcome(iw.w, r), "503 CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE");
    assert.equal(r.json<{ retryable: boolean }>().retryable, true);
  } finally {
    iw.w.bank.evidence = real;
  }
});

interface QueuePage {
  readonly credits: ReadonlyArray<CreditView>;
  readonly nextCursor: string | null;
}
const page = async (query: string, owner: Person = L().owner): Promise<QueuePage> => {
  const r = await ownerGet(queueUrl(query), owner);
  assert.equal(r.status, 200, `queue ${query}: ${r.text}`);
  return r.json<{ data: QueuePage }>().data;
};

test("L-KEYSET: the queue lists one state oldest first in keyset pages; a credit that leaves the state is not repeated and none is skipped", async () => {
  const route = await routeFor("b12-queue", []);
  const entered: string[] = [];
  for (let i = 0; i < 3; i++) {
    const facts = { bankTransactionId: nextTxn(`b12q${i}`), rail: "ACH", grossCents: 1000n + BigInt(i), feeCents: null, currency: "USD", reference: null, payerDigest: null, bookedAt: new Date(Date.now() - 60_000).toISOString(), status: "COMPLETED" };
    const r = await enterC5(route.accountRef, facts, await creditArtifact(route.accountRef, facts));
    assert.equal(r.status, 201, `enter: ${r.text}`);
    entered.push(r.json<{ data: { credit: CreditView } }>().data.credit.creditId);
  }
  const first = await page("state=DRAFT_MANUAL&limit=2");
  assert.equal(first.credits.length, 2);
  assert.ok(first.nextCursor !== null, "a full page has a cursor");
  for (const credit of first.credits) assert.equal(credit.state, "DRAFT_MANUAL");
  const again = await page(`state=DRAFT_MANUAL&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
  // the first listed credit leaves the state between the pages
  assert.equal((await confirmC6(first.credits[0]!.creditId)).status, 200);
  const second = await page(`state=DRAFT_MANUAL&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.deepEqual(second, again, "the same cursor answers the same page");
  const listed = [...first.credits, ...second.credits].map((c) => c.creditId);
  assert.equal(new Set(listed).size, listed.length, "no credit is repeated");
  assert.deepEqual(listed.filter((id) => entered.includes(id)), entered, "oldest first, none skipped");
  if (second.credits.length < 2) assert.equal(second.nextCursor, null, "the last page has no cursor");
  const review = await page("");
  for (const credit of review.credits) assert.equal(credit.state, "MATCH_REVIEW", "the default state is the review queue");
  for (const credit of [...first.credits, ...second.credits]) {
    assert.equal(Object.hasOwn(credit, "accountNumber") || Object.hasOwn(credit, "routingNumber"), false, "no account or routing number in a queue item");
    assert.equal(credit.feeCents, null, "an unknown fee stays unknown, never zero");
  }
});

test("L-DENY: the queue is owner-only and a cursor continues only its own caller and state", async () => {
  const { iw } = L();
  const stranger: Person = await iw.w.person(`b12-queue-stranger-${++seq}`);
  assert.equal(outcome(iw.w, await ownerGet(queueUrl("state=DRAFT_MANUAL"), stranger)), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.equal(outcome(iw.w, await ownerGet(queueUrl("state=PAID"))), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(iw.w, await ownerGet(queueUrl("state=DRAFT_MANUAL&extra=1"))), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  const first = await page("state=DRAFT_MANUAL&limit=1");
  assert.ok(first.nextCursor !== null, "L-KEYSET left draft credits to page through");
  const cursor = encodeURIComponent(first.nextCursor);
  assert.equal(outcome(iw.w, await ownerGet(queueUrl(`state=OBSERVED&limit=1&cursor=${cursor}`))), "400 INVALID_REQUEST CURSOR_INVALID", "a cursor of another state");
  const other = await ownOwner(`b12-queue-other-${seq}`);
  assert.equal(outcome(iw.w, await ownerGet(queueUrl(`state=DRAFT_MANUAL&limit=1&cursor=${cursor}`), other.person)), "400 INVALID_REQUEST CURSOR_INVALID", "a cursor of another caller");
});
