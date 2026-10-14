// Package B12 lane L-OWNER (plan companion §P): the owner tools that produce the rows B10's commands read — the seller's onboarding
// records, its agreement, its payout destination (TIER 1 money), its assignments and termination inputs, the seller's claim evidence and the
// owner's prepared allocation. The wire cells below need no database and run here; the database cells (the 8 failure-matrix columns of
// the destination, the races at L1 and at the prospect claims lock) need a PostgreSQL cluster with migration 0087 contiguous, and are
// todo until the batch renumbers it (runner.ts:66 refuses a gap) — each keeps the §P title it will be built under.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "@kauro/contracts";
import { B12_OPERATIONS, B12_PRODUCER_OPERATIONS, FAILURE_REASONS } from "@kauro/domain";
import {
  B12_PRODUCER_COMMANDS,
  COMMERCIAL_COMMANDS,
  COMMERCIAL_COMMAND_OUTCOMES,
  COMMERCIAL_COMMAND_RESPONSES,
  COMMERCIAL_REQUEST_SCHEMAS,
  COMMERCIAL_SERVED_COMMAND_IDS,
  PAYOUT_DESTINATION_COOLING_SECONDS,
  isServedCommercialCommand,
} from "@kauro/application";
import { manifestHashOf } from "@kauro/persistence";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const migration = readFileSync(join(root, "packages/persistence/migrations/0087_b12_owner_tools.sql"), "utf8");
const producers = Object.keys(B12_PRODUCER_COMMANDS);
const catalogue = (id: string): ReadonlyArray<{ readonly code: string; readonly reason: string | null }> =>
  (COMMERCIAL_COMMAND_OUTCOMES as unknown as Record<string, ReadonlyArray<{ readonly code: string; readonly reason: string | null }>>)[id] ?? [];

/** The quoted names of the explicit list an ARRAY[...] of one CHECK names. */
function listOf(constraint: string): ReadonlyArray<string> {
  const at = migration.indexOf(`ADD CONSTRAINT ${constraint} CHECK`);
  assert.ok(at >= 0, `0087 re-creates ${constraint}`);
  const body = migration.slice(migration.indexOf("ARRAY[", at) + 6, migration.indexOf("]::text[]", at));
  return [...body.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1] as string);
}

// --- wire shapes ----------------------------------------------------------------------------------------------------------------------

test("L-OWNER wire: the 15 owner tools are the domain's producer operations, each a served commercial command with a closed request schema, a declared reply and a closed outcome catalogue, and none is a registry command", () => {
  assert.deepEqual([...producers].sort(), [...B12_PRODUCER_OPERATIONS].sort());
  const registry = new Set(COMMANDS.map((c) => c.id as string));
  for (const id of producers) {
    assert.ok(id in COMMERCIAL_COMMANDS, `${id} is a commercial command`);
    assert.ok(isServedCommercialCommand(id) && (COMMERCIAL_SERVED_COMMAND_IDS as ReadonlyArray<string>).includes(id), `${id} is served`);
    const schema = (COMMERCIAL_REQUEST_SCHEMAS as unknown as Record<string, { additionalProperties: boolean; required: ReadonlyArray<string> }>)[id];
    assert.ok(schema !== undefined && schema.additionalProperties === false, `${id} has a closed request schema`);
    assert.ok(id in COMMERCIAL_COMMAND_RESPONSES, `${id} declares its reply`);
    assert.ok(catalogue(id).length > 0, `${id} has an outcome catalogue`);
    assert.ok(!registry.has(id), `${id} is not a registry command`);
    for (const o of catalogue(id)) assert.ok(o.reason === null || (FAILURE_REASONS as ReadonlyArray<string>).includes(o.reason), `${id}: ${o.reason} is a closed reason`);
  }
});

test("L-OWNER wire: both destination tools take the caller's own step-up (STEP_UP_MISSING, STEP_UP_NOT_OWNED, STEP_UP_STALE); the verification is a compare-and-swap; only the seller itself changes a destination and only the owner verifies it", () => {
  const change = B12_PRODUCER_COMMANDS.ChangePayoutDestination;
  const verify = B12_PRODUCER_COMMANDS.VerifyPayoutDestination;
  assert.equal(change.stepUp, true);
  assert.equal(verify.stepUp, true);
  assert.equal(verify.expectedVersionRequired, true);
  assert.equal(change.role, "SELLER_SELF");
  assert.equal(verify.role, "KAURO_OWNER");
  for (const id of ["ChangePayoutDestination", "VerifyPayoutDestination"]) {
    const reasons = new Set(catalogue(id).map((o) => o.reason));
    for (const r of ["STEP_UP_MISSING", "STEP_UP_NOT_OWNED", "STEP_UP_STALE"]) assert.ok(reasons.has(r), `${id} answers ${r}`);
  }
  const verifyReasons = new Set(catalogue("VerifyPayoutDestination").map((o) => o.reason));
  for (const r of ["PAYEE_UNVERIFIED", "SELF_TARGET", "UNLISTED_TRANSITION"]) assert.ok(verifyReasons.has(r), `the verification answers ${r}`);
  assert.equal(PAYOUT_DESTINATION_COOLING_SECONDS, 172_800);
});

test("L-OWNER wire: only the destination change carries a destination digest, and every owner tool answers one of the five owner-tool views", () => {
  for (const id of producers) {
    const schema = (COMMERCIAL_REQUEST_SCHEMAS as unknown as Record<string, { properties: Record<string, unknown> }>)[id];
    if (id !== "ChangePayoutDestination") assert.ok(!("destinationDigest" in (schema?.properties ?? {})), `${id} carries no destination digest`);
  }
  const replies = new Set(producers.map((id) => (COMMERCIAL_COMMAND_RESPONSES as unknown as Record<string, { view: string }>)[id]?.view));
  assert.deepEqual([...replies].sort(), ["AttributionAllocationRecordView", "PayoutDestinationStatusView", "SellerAgreementRecordView", "SellerCandidateView", "SellerRecordView"]);
});

test("L-OWNER migration 0087: the journal's operation list and the security facts' action list are exactly the domain's B12 operations, so a B12 route's ALLOW and DENY facts commit with its effect", () => {
  assert.deepEqual([...listOf("command_journal_operation_check")].sort(), [...B12_OPERATIONS].sort());
  assert.deepEqual([...listOf("security_events_action_check")].sort(), [...B12_OPERATIONS].sort());
  assert.match(migration, /CREATE CONSTRAINT TRIGGER seller_payout_destinations_change_step_up_at_commit AFTER INSERT[\s\S]+?DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER seller_payout_destinations_verify_step_up_at_commit AFTER UPDATE OF state[\s\S]+?DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /ERRCODE = 'KC020'/);
});

test("L-OWNER manifest hash: the digest of a termination manifest is its claim ids, ascending, whatever order the owner named them in", () => {
  const a = "018f0000-0000-7000-8000-000000000001";
  const b = "018f0000-0000-7000-8000-000000000002";
  assert.equal(manifestHashOf([b, a]), manifestHashOf([a, b]));
  assert.notEqual(manifestHashOf([a]), manifestHashOf([a, b]));
  assert.match(manifestHashOf([]), /^[0-9a-f]{64}$/);
});

// --- database cells (companion §P; need PostgreSQL with 0087 contiguous: todo until the batch renumbers it) ------------------------------

const PG = "needs PostgreSQL with 0087 contiguous (runner.ts:66): regen at batch, built on the renumbered head";

test.todo(`sellers OK/DENY/RACE: two candidates of one person: one row (${PG})`);
test.todo(`seller_legal_reviews OK/DENY: label is not classification (17 "Legal engagement packet"); RACE vs CMD049 at L1 both orders (${PG})`);
test.todo(`seller_agreements: signed once; RACE signature vs CMD049 at L1; PARTIAL failure after the terms row rolls back (${PG})`);
test.todo(`seller_assessments OK/DENY/RACE at L1 (${PG})`);
test.todo(`seller_confidentiality_acceptances OK/DENY; RACE at L1 (${PG})`);
test.todo(`seller_tax_documents OK/DENY (profile requirements), content-addressed; RACE at L1 (${PG})`);
test.todo(`seller_payout_destinations RACE: change vs verify at the row FOR NO KEY UPDATE, both orders: the verification judges the latest version (${PG})`);
test.todo(`seller_payout_destinations TIMEOUT: a unit that times out waiting on the seller's lock commits neither the change nor the verification (${PG})`);
test.todo(`seller_payout_destinations EXPIRY: the step-up expires while the unit waits on L1: STEP_UP_STALE, nothing commits (0087 KC020 at COMMIT, the 0040 shape) (${PG})`);
test.todo(`seller_payout_destinations CRASH-BEFORE: a crash before COMMIT leaves the destination PENDING and the journal reserved; the retry with a fresh proof applies once (${PG})`);
test.todo(`seller_payout_destinations CRASH-AFTER/RETRY: the replay answers the journaled reply without a new proof and writes nothing (${PG})`);
test.todo(`seller_payout_destinations REVOCATION: a TERMINATED seller keeps the change right (0029:1328, tail); a revoked owner grant cannot verify (${PG})`);
test.todo(`seller_payout_destinations PARTIAL: a verification refused after the supersede of the previous VERIFIED version rolls the supersede back (${PG})`);
test.todo(`seller_payout_destinations cooling: a verification before changed_at + 172800 s on the database clock is PAYEE_UNVERIFIED; the changer verifying is SELF_TARGET (${PG})`);
test.todo(`service_assignments OK/DENY; RACE vs CMD048 at its lock both orders (${PG})`);
test.todo(`assistance_agreements: signed before work; OK/DENY/RACE (${PG})`);
test.todo(`seller_terminations terms: one effective per seller; RACE vs CMD050 at L1 (${PG})`);
test.todo(`termination_manifests: claims enumerated = accepted claims at preparation; RACE vs CMD047 at the prospect claims lock (commercial-sales.ts:607) both orders (${PG})`);
test.todo(`claim_evidence OK/DENY: a backdated contact is CLAIM_EVIDENCE_INSUFFICIENT; a non-ACTIVE seller is refused (${PG})`);
test.todo(`attribution_allocations + allocation_shares: shares whole (SHARES_NOT_WHOLE), pool terms = each beneficiary's agreement (COMMISSION_POOL_MISMATCH), one frozen per agency (ATTRIBUTION_EXISTS); CMD047 freezes the prepared allocation (${PG})`);
test.todo(`fixture twins: every fixture insert of these tables in sellers-support.ts/sales-fixtures.ts used by a B10 OK test has a twin through the product route (${PG})`);
