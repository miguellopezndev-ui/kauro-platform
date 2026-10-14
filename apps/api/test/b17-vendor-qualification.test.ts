// B17 L4 VENDOR (S078; plan M5, ADV-16/29): CMD058 ChangeCapability resolves the qualification evidence a capability version cites against
// `vendor_qualifications` (R2 05:69 "an API-only test cannot certify a different Data Loader workflow"; CMD058 precondition "Independent
// acceptance covers the exact object/operation/importer/resource envelope"). Five independent predicates, one reason each (r12): the ref
// resolves; the qualification is of this capability's tool; its profileHash equals the body's; its result is PASS; it has an export-back
// hash. They apply unless the capability is a CLEAN mode (kind MODE, mode CLEAN: no importer, no export-back). The rows are seeded
// through the oracle: no runtime role may insert one (0084; the producer is D-12).
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CapabilityVersionView } from "@kauro/application";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { call, completed, freshKey, ids, outcome, sha, type Reply } from "./support.js";

let pw: PaymentsWorld;
invariantsAfterEach(() => pw.w.h.oracle);
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const versionsUrl = (capabilityId: string): string => `/api/v1/operations/capabilities/${capabilityId}/versions`;
const change = (capabilityId: string, body: Record<string, unknown>): Promise<Reply> => call(pw.w, { url: versionsUrl(capabilityId), token: pw.kora.token, agency: null, key: freshKey("b17-vendor"), body });

/** A capability of `kind` (a TOOL, or a MODE with its mode) walked to QUALIFIED_INTERNAL (a versionable state). */
async function capability(label: string, kind: "TOOL" | "MODE" = "TOOL", mode: string | null = null, claim: string | null = kind === "TOOL" ? CLAIMED_TOOL : null): Promise<string> {
  // the importer tool the capability claims (0087): the catalogue tool id; a version of it must be backed by a qualification that tested exactly it
  const id = ids.next();
  await pw.w.h.oracle.query(
    `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, review_trigger, created_at, updated_at, importer_tool)
     VALUES ($1, $2, $3, $4, 'DESIGN', $5, '[]'::jsonb, 'VENDOR_OR_ENVELOPE_CHANGE', now(), now(), $6)`,
    [id, `B17-${label}`, kind, mode, sha(`profile-${label}`), claim],
  );
  await pw.w.h.publishCapability(id as never, "QUALIFIED_INTERNAL");
  return id;
}

const CLAIMED_TOOL = "SALESFORCE_DATA_LOADER";

interface Qualification {
  readonly capabilityId: string;
  /** The tool the qualification actually tested (default: the claimed importer tool). */
  readonly tool?: string;
  readonly profileHash: string;
  readonly exportBack?: string | null;
  readonly result?: "PASS" | "FAIL";
}
/** One vendor_qualifications row seeded through the oracle (the only way: the runtime roles have no INSERT); returns its evidence hash. */
async function qualification(label: string, q: Qualification): Promise<string> {
  const evidence = sha(`evidence-${label}`);
  await pw.w.h.oracle.query(
    `INSERT INTO kauro.vendor_qualifications (evidence_hash, capability_id, tool, profile_hash, envelope, export_back_evidence_hash, result)
     VALUES ($1, $2, $6, $3, '{"object":"Contact","operation":"UPSERT"}'::jsonb, $4, $5)`,
    [evidence, q.capabilityId, q.profileHash, q.exportBack === undefined ? sha(`export-back-${label}`) : q.exportBack, q.result ?? "PASS", q.tool ?? CLAIMED_TOOL],
  );
  return evidence;
}

const state = async (capabilityId: string) => ({
  revision: (await pw.w.h.oracle.query<{ revision: number }>("SELECT revision FROM kauro.capabilities WHERE capability_id = $1", [capabilityId])).rows[0]!.revision,
  versions: (await pw.w.h.oracle.query("SELECT version_no FROM kauro.capability_versions WHERE capability_id = $1", [capabilityId])).rows.length,
});

/**
 * The shape of every single-predicate DENY: the qualification is flawed in exactly one way and the request is refused with its reason,
 * nothing written; the same request over a sound qualification of the same tool and profile then records (the flaw was the only obstacle).
 */
async function denyAlone(label: string, flaw: (id: string, profileHash: string) => Qualification, reason: string): Promise<void> {
  const id = await capability(label);
  const profileHash = sha(`new-profile-${label}`);
  const before = await state(id);
  const flawed = await qualification(`${label}-flawed`, flaw(id, profileHash));
  const refused = await change(id, { expectedVersion: 1, profileHash, qualificationEvidenceRefs: [flawed] });
  assert.equal(outcome(pw.w, refused), `409 PRECONDITION_FAILED ${reason}`);
  assert.deepEqual(await state(id), before, "nothing was written");
  const sound = await qualification(`${label}-sound`, { capabilityId: id, profileHash });
  completed<CapabilityVersionView>(await change(id, { expectedVersion: 1, profileHash, qualificationEvidenceRefs: [sound] }), 200);
  assert.deepEqual(await state(id), { revision: before.revision + 1, versions: 1 });
}

test("S078: DENY a capability version whose qualification evidence is unknown (QUALIFICATION_EVIDENCE_UNKNOWN)", async () => {
  const id = await capability("unknown");
  const profileHash = sha("new-profile-unknown");
  const before = await state(id);
  const known = await qualification("unknown-known", { capabilityId: id, profileHash });
  // one cited ref resolves and one does not: the unknown one alone refuses the version
  assert.equal(outcome(pw.w, await change(id, { expectedVersion: 1, profileHash, qualificationEvidenceRefs: [known, sha("evidence-nobody-recorded")] })), "409 PRECONDITION_FAILED QUALIFICATION_EVIDENCE_UNKNOWN");
  assert.deepEqual(await state(id), before);
  completed<CapabilityVersionView>(await change(id, { expectedVersion: 1, profileHash, qualificationEvidenceRefs: [known] }), 200);
});

test("S078: DENY a REST qualification of a claimed Data Loader alone (QUALIFICATION_TOOL_MISMATCH)", async () => {
  // R2 S078: "REST was tested but Data Loader compatibility is claimed": every other predicate holds (this capability, its profile, PASS, export-back)
  await denyAlone("tool-mismatch", (id, profileHash) => ({ capabilityId: id, profileHash, tool: "REST" }), "QUALIFICATION_TOOL_MISMATCH");
});

test("S078: DENY a capability that claims no importer tool alone (QUALIFICATION_TOOL_MISMATCH): there is nothing for a qualification to match", async () => {
  const id = await capability("no-claim", "TOOL", null, null);
  const profileHash = sha("new-profile-no-claim");
  const before = await state(id);
  const q = await qualification("no-claim-q", { capabilityId: id, profileHash });
  assert.equal(outcome(pw.w, await change(id, { expectedVersion: 1, profileHash, qualificationEvidenceRefs: [q] })), "409 PRECONDITION_FAILED QUALIFICATION_TOOL_MISMATCH");
  assert.deepEqual(await state(id), before);
});

test("S078: DENY the claimed importer tool changing once learned (0087, 23514)", async () => {
  const id = await capability("claim-once");
  await assert.rejects(pw.w.h.oracle.query("UPDATE kauro.capabilities SET importer_tool = 'REST' WHERE capability_id = $1", [id]), (e: { code?: string }) => e.code === "23514");
});

test("S078: DENY profile mismatch alone (QUALIFICATION_PROFILE_MISMATCH)", async () => {
  await denyAlone("profile-mismatch", (id) => ({ capabilityId: id, profileHash: sha("a-different-profile") }), "QUALIFICATION_PROFILE_MISMATCH");
});

test("S078: DENY a qualification made for another capability alone (QUALIFICATION_PROFILE_MISMATCH)", async () => {
  // same tool tested, same profile hash, PASS, export-back: only the capability the acceptance was made for differs
  const other = await capability("capability-mismatch-other");
  await denyAlone("capability-mismatch", (_id, profileHash) => ({ capabilityId: other, profileHash }), "QUALIFICATION_PROFILE_MISMATCH");
});

test("S078: DENY an export-back-less qualification alone (QUALIFICATION_EXPORT_BACK_MISSING)", async () => {
  await denyAlone("export-back", (id, profileHash) => ({ capabilityId: id, profileHash, exportBack: null }), "QUALIFICATION_EXPORT_BACK_MISSING");
});

test("S078: DENY a FAIL result alone (QUALIFICATION_FAILED)", async () => {
  await denyAlone("failed", (id, profileHash) => ({ capabilityId: id, profileHash, result: "FAIL" }), "QUALIFICATION_FAILED");
});

test("S078: OK a PASS qualification of the exact tool, profile and export-back records the version", async () => {
  const id = await capability("ok");
  const profileHash = sha("new-profile-ok");
  const refs = [await qualification("ok-a", { capabilityId: id, profileHash }), await qualification("ok-b", { capabilityId: id, profileHash })];
  const done = completed<CapabilityVersionView>(await change(id, { expectedVersion: 1, profileHash, qualificationEvidenceRefs: refs }), 200);
  assert.deepEqual([done.data.version, done.data.status, done.data.qualificationEvidenceCount], [2, "PROSPECTIVE", 2]);
  assert.deepEqual(await state(id), { revision: 2, versions: 1 });
});

test("S078: OK a CLEAN capability version records without a vendor qualification", async () => {
  // the offered CLEAN mode capability: no importer, no export-back; none of the five predicates applies and nothing is seeded
  const clean = pw.w.cleanCapabilityId;
  const before = await state(clean);
  const done = completed<CapabilityVersionView>(await change(clean, { expectedVersion: before.revision, profileHash: sha("new-profile-clean"), qualificationEvidenceRefs: [sha("evidence-clean-a")] }), 200);
  assert.deepEqual([done.data.status, done.data.qualificationEvidenceCount], ["PROSPECTIVE", 1]);
  assert.deepEqual(await state(clean), { revision: before.revision + 1, versions: before.versions + 1 });
});

test("S078: DENY a CRM mode capability version without a vendor qualification: only the CLEAN mode is outside the predicates (QUALIFICATION_EVIDENCE_UNKNOWN)", async () => {
  const id = await capability("mode-hubspot", "MODE", "HUBSPOT");
  const before = await state(id);
  assert.equal(outcome(pw.w, await change(id, { expectedVersion: before.revision, profileHash: sha("new-profile-hubspot"), qualificationEvidenceRefs: [sha("evidence-hubspot")] })), "409 PRECONDITION_FAILED QUALIFICATION_EVIDENCE_UNKNOWN");
  assert.deepEqual(await state(id), before);
});
