// Stored core documents and plan bindings (package B05 L3; D5-14, D5-16; migration 0058; cases B01-B03, I14) on real PostgreSQL 17, through
// the control plane's login (kauro_control_test): idempotent writes, a conflicting write is an INTEGRITY_FAILURE and overwrites nothing, an
// agency cannot see or write another agency's rows, an unbound session reads a binding by its plan hash, and nothing is ever updated or deleted.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { Sha256Hex } from "@kauro/contracts";
import { isDomainFailure, type AgencyId } from "@kauro/domain";
import { PgCoreDocumentStore } from "../src/repositories/core-documents.js";
import { start, type Harness } from "../src/testing/harness.js";
import { sha } from "./support.js";

let h: Harness;
let control: Client;
let A: AgencyId;
let B: AgencyId;

before(async () => {
  h = await start();
  control = await h.pg.connect("kauro_control_test");
  A = (await h.createAgency(await h.person("cd-alice"), "cd A")).agencyId as AgencyId;
  B = (await h.createAgency(await h.person("cd-bob"), "cd B")).agencyId as AgencyId;
});
after(async () => {
  await control.end();
  await h.stop();
});

/** One transaction of the control plane bound to an agency (or to none: a discovery read). */
async function as<T>(agency: AgencyId | null, work: (store: PgCoreDocumentStore) => Promise<T>): Promise<T> {
  await control.query("BEGIN");
  try {
    if (agency !== null) await control.query("SELECT set_config('kauro.agency_id', $1, true)", [agency]);
    const out = await work(new PgCoreDocumentStore(control));
    await control.query("COMMIT");
    return out;
  } catch (e) {
    await control.query("ROLLBACK");
    throw e;
  }
}

const hash = (s: string): Sha256Hex => sha(s) as Sha256Hex;
const profile = { profileHash: hash("p1"), profile: { files: [{ path: "contacts.csv", columns: ["email", "name"] }] } };

test("B01: a document is stored verbatim, read back, and stored again idempotently", async () => {
  const key = hash("profile-1");
  assert.equal(await as(A, (s) => s.document(A, "SOURCE_PROFILE", key)), null);
  await as(A, (s) => s.putDocument(A, "SOURCE_PROFILE", key, profile));
  await as(A, (s) => s.putDocument(A, "SOURCE_PROFILE", key, { profile: profile.profile, profileHash: profile.profileHash }));
  assert.deepEqual(await as(A, (s) => s.document(A, "SOURCE_PROFILE", key)), profile);
  assert.equal(await as(A, (s) => s.document(A, "TARGET_CONTRACT", key)), null);
  const n = await h.oracle.query("SELECT count(*)::int AS n FROM kauro.core_documents WHERE doc_hash = $1", [key]);
  assert.equal(n.rows[0].n, 1);
});

test("B01: other content under the same key is an INTEGRITY_FAILURE and the stored document is untouched", async () => {
  const key = hash("profile-2");
  await as(A, (s) => s.putDocument(A, "SOURCE_PROFILE", key, profile));
  const failure = await as(A, (s) => s.putDocument(A, "SOURCE_PROFILE", key, { ...profile, extra: 1 })).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(isDomainFailure(failure) && failure.code === "INTEGRITY_FAILURE", String(failure));
  assert.deepEqual(await as(A, (s) => s.document(A, "SOURCE_PROFILE", key)), profile);
});

test("B02: a plan binding is stored once by plan hash and read back; the same again is idempotent, another content is refused", async () => {
  const planHash = hash("plan-1");
  const binding = { configDocument: { version: 1, files: [{ path: "contacts.csv", object: "contacts" }] }, coreConfigHash: hash("cfg-1") };
  assert.equal(await as(A, (s) => s.planBinding(planHash)), null);
  await as(A, (s) => s.putPlanBinding(A, planHash, binding));
  await as(A, (s) => s.putPlanBinding(A, planHash, { configDocument: { files: binding.configDocument.files, version: 1 }, coreConfigHash: binding.coreConfigHash }));
  assert.deepEqual(await as(A, (s) => s.planBinding(planHash)), binding);
  for (const other of [{ ...binding, coreConfigHash: hash("cfg-2") }, { ...binding, configDocument: { version: 2 } }]) {
    const failure = await as(A, (s) => s.putPlanBinding(A, planHash, other)).then(() => null, (e: unknown) => e);
    assert.ok(isDomainFailure(failure) && failure.code === "INTEGRITY_FAILURE");
  }
  assert.deepEqual(await as(A, (s) => s.planBinding(planHash)), binding);
});

test("B03: an agency neither reads nor writes another agency's rows", async () => {
  const key = hash("profile-3");
  const planHash = hash("plan-3");
  await as(A, (s) => s.putDocument(A, "SOURCE_PROFILE", key, profile));
  await as(A, (s) => s.putPlanBinding(A, planHash, { configDocument: { v: 1 }, coreConfigHash: hash("cfg-3") }));
  assert.equal(await as(B, (s) => s.document(A, "SOURCE_PROFILE", key)), null);
  assert.equal(await as(B, (s) => s.planBinding(planHash)), null);
  // a write for an agency other than the session's is refused by the row policy
  await assert.rejects(as(B, (s) => s.putDocument(A, "SOURCE_PROFILE", hash("profile-4"), profile)));
  await assert.rejects(as(B, (s) => s.putPlanBinding(A, hash("plan-4"), { configDocument: { v: 1 }, coreConfigHash: hash("cfg-4") })));
  // the same plan hash from another agency never replaces or reads as its own
  const failure = await as(B, (s) => s.putPlanBinding(B, planHash, { configDocument: { v: 1 }, coreConfigHash: hash("cfg-3") })).then(() => null, (e: unknown) => e);
  assert.ok(failure !== null);
});

test("I14: an unbound session (discovery) reads a binding by plan hash; a plan without a binding reads null; rows are append-only", async () => {
  const planHash = hash("plan-5");
  await as(A, (s) => s.putPlanBinding(A, planHash, { configDocument: { v: 5 }, coreConfigHash: hash("cfg-5") }));
  assert.equal((await as(null, (s) => s.planBinding(planHash)))?.coreConfigHash, hash("cfg-5"));
  assert.equal(await as(null, (s) => s.planBinding(hash("no-binding"))), null);
  await assert.rejects(as(A, () => control.query("UPDATE kauro.core_plan_bindings SET core_config_hash = $1 WHERE plan_hash = $2", [hash("x"), planHash])));
  await assert.rejects(as(A, () => control.query("DELETE FROM kauro.core_documents")));
  // even the owner cannot rewrite history
  await assert.rejects(h.oracle.query("UPDATE kauro.core_plan_bindings SET core_config_hash = $1 WHERE plan_hash = $2", [hash("x"), planHash]));
  await assert.rejects(h.oracle.query("DELETE FROM kauro.core_documents"));
});
