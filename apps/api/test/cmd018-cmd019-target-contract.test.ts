// CMD018 CreateTargetContract — POST /api/v1/projects/{projectId}/target-contracts — AGENCY_OPERATOR, and CMD019 ConfirmTargetContract —
// POST /api/v1/target-contracts/{contractId}/confirm — AGENCY_APPROVER (package B17; registry cases CMD018-OK / -DENY / -RACE and CMD019-OK /
// -DENY / -RACE, gate G-VENDOR). Real routes, adapters and oracle. A metadata artifact is data an agency member stored for the project's
// target instance; CMD018 turns it into an immutable DRAFT target version (the body digest derived server-side), CMD019 records the
// approver's confirmation of exactly that digest.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { TargetContractView } from "@kauro/application";
import { targetBodyDigest, toUtcInstant, type TargetBody } from "@kauro/domain";
import { serverNow, type AgencyFixture } from "@kauro/persistence/testing";
import { call, completed, freshKey, ids, outcome, sha, world, type Person, type Reply, type World } from "./support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

const createUrl = (projectId: string): string => `/api/v1/projects/${projectId}/target-contracts`;
const confirmUrl = (contractId: string): string => `/api/v1/target-contracts/${contractId}/confirm`;

const OBJECTS = [
  {
    apiName: "Contact",
    operations: ["CREATE", "UPDATE"],
    fields: [{ apiName: "email", dataType: "TEXT", createable: true, updateable: true, requiredOnCreate: false, allowedValues: [], clearMechanism: "UNSUPPORTED", unique: true, nillable: true }],
    identifierFields: ["email"],
    relationships: [],
  },
];

/** The instant `offsetMs` from the database's clock, as the canonical utc primitive (a fixture never reads the process clock). */
async function dbInstant(offsetMs: number): Promise<string> {
  return toUtcInstant(Date.parse(await serverNow(w.h.oracle)) + offsetMs);
}

interface ArtifactOptions {
  readonly kind?: "METADATA" | "CONFIRMATION_EVIDENCE";
  readonly mode?: "CLEAN" | "HUBSPOT" | "SALESFORCE";
  readonly instanceId?: string;
  readonly document?: Record<string, unknown>;
  readonly observedOffsetMs?: number;
  readonly agency?: AgencyFixture;
  readonly membership?: string;
}

/** An artifact stored through the tenant role (RLS and the insert grant apply), as an agency member would. */
async function storeArtifact(projectId: string, o: ArtifactOptions = {}): Promise<{ readonly artifactRef: string; readonly contentHash: string; readonly instanceId: string }> {
  const agency = o.agency ?? w.A;
  const artifactRef = ids.next();
  const instanceId = o.instanceId ?? ids.next();
  const document = o.document ?? { importerVersion: "R2-INITIAL", capabilityVersion: "R2-INITIAL", observedAt: await dbInstant(o.observedOffsetMs ?? -60_000), objects: OBJECTS };
  const contentHash = sha(JSON.stringify(document) + artifactRef);
  await w.asTenant(agency, (c) =>
    c.query(
      "INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)",
      [artifactRef, agency.agencyId, projectId, o.kind ?? "METADATA", o.mode ?? "CLEAN", instanceId, JSON.stringify(document), contentHash, o.membership ?? agency.ownerMembershipId],
    ),
  );
  return { artifactRef, contentHash, instanceId };
}

function create(projectId: string, body: Record<string, unknown>, who: Person = w.operator, key: string = freshKey("cmd018")): Promise<Reply> {
  return call(w, { url: createUrl(projectId), token: who.token, key, body });
}
function confirm(contractId: string, body: Record<string, unknown>, who: Person = w.approver, key: string = freshKey("cmd019")): Promise<Reply> {
  return call(w, { url: confirmUrl(contractId), token: who.token, key, body });
}

async function cleanProject(): Promise<string> {
  return (await w.project(w.A, w.clientA)).projectId;
}

interface ContractRow extends Record<string, unknown> {
  contract_id: string;
  version: number;
  confirmed_at: Date | null;
  confirmed_by_membership_id: string | null;
  confirmation_evidence_ref: string | null;
  body_hash: string;
  objects: unknown;
  observed_at: Date;
  authority_evidence_hash: string;
  instance_id: string;
  mode: "CLEAN" | "HUBSPOT" | "SALESFORCE";
  importer_profile_id: string;
  importer_version: string;
  capability_version: string;
}
const contractRow = (id: string): Promise<ContractRow | null> => w.row<ContractRow>("target_contracts", "contract_id = $1", [id]);
const contractCount = async (projectId: string): Promise<number> => Number((await w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.target_contracts WHERE project_id = $1", [projectId])).rows[0]?.n);

/** A draft contract through the real CMD018 route. */
async function draftThroughRoute(projectId: string, o: ArtifactOptions = {}): Promise<TargetContractView> {
  const artifact = await storeArtifact(projectId, o);
  return completed<TargetContractView>(await create(projectId, { metadataArtifactRef: artifact.artifactRef, importerProfileId: ids.next() }), 201).data;
}

/** A contract row written directly (a fixture the route refuses to create: an observation ahead of or far behind the clock). */
async function directContract(projectId: string, observedOffsetMs: number): Promise<{ readonly contractId: string; readonly bodyHash: string }> {
  const contractId = ids.next();
  const body: TargetBody = {
    mode: "CLEAN",
    instanceId: ids.next(),
    importerProfileId: ids.next(),
    importerVersion: "R2-INITIAL",
    objects: OBJECTS as unknown as TargetBody["objects"],
    observedAt: await dbInstant(observedOffsetMs),
    authorityEvidenceHash: sha(`authority-${contractId}`),
    capabilityVersion: "R2-INITIAL",
  };
  const bodyHash = targetBodyDigest(body);
  await w.asTenant(w.A, (c) =>
    c.query(
      `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, NULL, $9, $12, now())`,
      [contractId, w.A.agencyId, projectId, body.mode, body.instanceId, body.importerProfileId, body.importerVersion, JSON.stringify(body.objects), body.authorityEvidenceHash, bodyHash, body.observedAt, body.capabilityVersion],
    ),
  );
  return { contractId, bodyHash };
}

test("CMD018-OK: an OPERATOR creates an immutable DRAFT target version from the admitted metadata artifact; the digest is derived server-side from the stored body", async () => {
  const projectId = await cleanProject();
  const artifact = await storeArtifact(projectId);
  const profile = ids.next();
  const key = freshKey("cmd018-ok");
  const first = completed<TargetContractView>(await create(projectId, { metadataArtifactRef: artifact.artifactRef, importerProfileId: profile }, w.operator, key), 201);
  assert.equal(first.version, 1);
  assert.equal(first.replayed, false);
  const view = first.data;
  assert.deepEqual([view.state, view.version, view.mode, view.projectId, view.objectCount, view.importerProfileId, view.instanceId], ["DRAFT", 1, "CLEAN", projectId, 1, profile, artifact.instanceId]);
  assert.equal(view.confirmedAt, undefined);
  assert.deepEqual(view.permittedActions, [], "an OPERATOR cannot confirm");
  assert.ok(!("objects" in view), "the metadata body is never in the view");

  // oracle: one DRAFT row whose digest is the digest of the very values stored; the authority evidence is the artifact's digest
  const row = await contractRow(view.contractId);
  assert.ok(row);
  assert.deepEqual([row.version, row.confirmed_at, row.confirmed_by_membership_id, row.confirmation_evidence_ref, row.authority_evidence_hash], [1, null, null, null, artifact.contentHash]);
  const recomputed = targetBodyDigest({
    mode: row.mode,
    instanceId: row.instance_id,
    importerProfileId: row.importer_profile_id,
    importerVersion: row.importer_version,
    objects: row.objects as TargetBody["objects"],
    observedAt: toUtcInstant(row.observed_at.getTime()),
    authorityEvidenceHash: row.authority_evidence_hash,
    capabilityVersion: row.capability_version,
  });
  assert.equal(row.body_hash, recomputed);
  assert.equal(view.bodyHash, recomputed);
  assert.deepEqual(row.objects, OBJECTS);
  assert.equal(await contractCount(projectId), 1);

  // the same key again is the same answer, not another contract
  const replay = completed<TargetContractView>(await create(projectId, { metadataArtifactRef: artifact.artifactRef, importerProfileId: profile }, w.operator, key), 201);
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.contractId, view.contractId);
  assert.equal(await contractCount(projectId), 1);
});

test("CMD018-DENY: a VIEWER, a non-member, a foreign or unknown artifact, a mismatched CRM, instance or project, an invalid or verified-flagged document, an unknown request field and a future observation are all refused and write nothing", async () => {
  const projectId = await cleanProject();
  const artifact = await storeArtifact(projectId);
  const good = { metadataArtifactRef: artifact.artifactRef, importerProfileId: ids.next() };

  // wrong role and a member of another agency
  assert.equal(outcome(w, await create(projectId, good, w.viewer)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await create(projectId, good, w.approver)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await create(projectId, good, w.stranger)), "404 NOT_FOUND NOT_A_MEMBER");
  // the caller cannot set verified=true, nor anything else the registry does not list
  assert.equal(outcome(w, await create(projectId, { ...good, verified: true })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await create(projectId, { importerProfileId: good.importerProfileId })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  // an unknown artifact, an artifact of the wrong kind, a project of another agency (answered as one that does not exist)
  assert.equal(outcome(w, await create(projectId, { ...good, metadataArtifactRef: ids.next() })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  const evidence = await storeArtifact(projectId, { kind: "CONFIRMATION_EVIDENCE" });
  assert.equal(outcome(w, await create(projectId, { ...good, metadataArtifactRef: evidence.artifactRef })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  const foreignProject = (await w.project(w.B, w.clientB)).projectId;
  assert.equal(outcome(w, await create(foreignProject, good)), "404 NOT_FOUND -");
  // mismatched project, CRM mode and instance
  const other = await cleanProject();
  const ofOther = await storeArtifact(other);
  assert.equal(outcome(w, await create(projectId, { ...good, metadataArtifactRef: ofOther.artifactRef })), "409 PRECONDITION_FAILED TARGET_SCOPE_MISMATCH");
  const hubspotArtifact = await storeArtifact(projectId, { mode: "HUBSPOT" });
  assert.equal(outcome(w, await create(projectId, { ...good, metadataArtifactRef: hubspotArtifact.artifactRef })), "409 PRECONDITION_FAILED TARGET_SCOPE_MISMATCH", "another CRM than the project's");
  const hubspot = await w.project(w.A, w.clientA, { mode: "HUBSPOT" });
  const declared = (await w.row<{ target_instance_ref: string }>("projects", "project_id = $1", [hubspot.projectId]))?.target_instance_ref;
  assert.ok(declared);
  const wrongInstance = await storeArtifact(hubspot.projectId, { mode: "HUBSPOT" });
  assert.equal(outcome(w, await create(hubspot.projectId, { ...good, metadataArtifactRef: wrongInstance.artifactRef })), "409 PRECONDITION_FAILED TARGET_SCOPE_MISMATCH", "another instance than the declared one");
  const rightInstance = await storeArtifact(hubspot.projectId, { mode: "HUBSPOT", instanceId: declared });
  completed<TargetContractView>(await create(hubspot.projectId, { ...good, metadataArtifactRef: rightInstance.artifactRef }), 201);
  // the project's earlier contract binds the instance of every later one
  const sameDeclaredButLater = await storeArtifact(projectId);
  completed<TargetContractView>(await create(projectId, { ...good, metadataArtifactRef: sameDeclaredButLater.artifactRef }), 201);
  const driftedInstance = await storeArtifact(projectId);
  assert.equal(outcome(w, await create(projectId, { ...good, metadataArtifactRef: driftedInstance.artifactRef })), "409 PRECONDITION_FAILED TARGET_SCOPE_MISMATCH", "another instance than the project's earlier contract");

  // the metadata is data in a closed shape: a verified flag, an unknown member, an unknown field type
  const fresh = await cleanProject();
  const observedAt = await dbInstant(-60_000);
  const bad = async (document: Record<string, unknown>): Promise<string> => {
    const a = await storeArtifact(fresh, { document });
    return outcome(w, await create(fresh, { metadataArtifactRef: a.artifactRef, importerProfileId: ids.next() }));
  };
  const base = { importerVersion: "R2-INITIAL", capabilityVersion: "R2-INITIAL", observedAt, objects: OBJECTS };
  assert.equal(await bad({ ...base, verified: true }), "400 INVALID_REQUEST TARGET_METADATA_INVALID");
  assert.equal(await bad({ ...base, objects: [{ ...OBJECTS[0], verified: true }] }), "400 INVALID_REQUEST TARGET_METADATA_INVALID");
  assert.equal(await bad({ ...base, objects: [{ ...OBJECTS[0], fields: [{ ...OBJECTS[0]?.fields[0], dataType: "SCRIPT" }] }] }), "400 INVALID_REQUEST TARGET_METADATA_INVALID");
  assert.equal(await bad({ ...base, objects: [] }), "400 INVALID_REQUEST TARGET_METADATA_INVALID");
  assert.equal(await bad({ importerVersion: "R2-INITIAL", observedAt, objects: OBJECTS }), "400 INVALID_REQUEST TARGET_METADATA_INVALID");
  // an observation ahead of the database clock
  assert.equal(await bad({ ...base, observedAt: await dbInstant(3_600_000) }), "409 PRECONDITION_FAILED OBSERVATION_IN_FUTURE");
  assert.equal(await contractCount(fresh), 0, "a refused request wrote nothing");
});

test("CMD018-RACE: the same key replays one contract, the same key with another request conflicts, and two keys on one artifact yield one contract (TARGET_CONTRACT_EXISTS for the loser)", async () => {
  const projectId = await cleanProject();
  const artifact = await storeArtifact(projectId);
  const profile = ids.next();
  const body = { metadataArtifactRef: artifact.artifactRef, importerProfileId: profile };

  // same key, another request: nothing is executed again
  const key = freshKey("cmd018-race");
  completed<TargetContractView>(await create(projectId, body, w.operator, key), 201);
  assert.equal(outcome(w, await create(projectId, { ...body, importerProfileId: ids.next() }, w.operator, key)), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await contractCount(projectId), 1);

  // two keys, one observed body: exactly one contract
  const second = await cleanProject();
  const a2 = await storeArtifact(second);
  const b2 = { metadataArtifactRef: a2.artifactRef, importerProfileId: profile };
  const replies = await Promise.all([create(second, b2), create(second, b2), create(second, b2)]);
  const outcomes = replies.map((r) => (r.status === 201 ? "201" : outcome(w, r))).sort();
  assert.deepEqual(outcomes, ["201", "409 PRECONDITION_FAILED TARGET_CONTRACT_EXISTS", "409 PRECONDITION_FAILED TARGET_CONTRACT_EXISTS"]);
  assert.equal(await contractCount(second), 1, "no duplicate authority");
});

test("CMD019-OK: an APPROVER confirms the exact contract; its body is untouched, the version advances, the instant is the database's and the confirming membership and evidence are recorded", async () => {
  const projectId = await cleanProject();
  const draft = await draftThroughRoute(projectId);
  assert.deepEqual(draft.permittedActions, [], "the OPERATOR who created it cannot confirm");
  const before = await contractRow(draft.contractId);
  assert.ok(before);
  const evidence = await storeArtifact(projectId, { kind: "CONFIRMATION_EVIDENCE", document: { shown: "complete body and destination scope" } });
  const key = freshKey("cmd019-ok");
  const done = completed<TargetContractView>(await confirm(draft.contractId, { expectedVersion: 1, bodyHash: draft.bodyHash, confirmationEvidenceRef: evidence.artifactRef }, w.approver, key), 200);
  assert.equal(done.version, 2);
  assert.equal(done.replayed, false);
  assert.deepEqual([done.data.state, done.data.version, done.data.bodyHash, done.data.permittedActions], ["CONFIRMED", 2, draft.bodyHash, []]);
  assert.ok(done.data.confirmedAt);

  const row = await contractRow(draft.contractId);
  assert.ok(row);
  assert.deepEqual([row.version, row.confirmed_by_membership_id, row.confirmation_evidence_ref], [2, w.memberships.approver, evidence.artifactRef]);
  assert.ok(row.confirmed_at instanceof Date);
  // the body did not change: same hash, same stored values
  assert.deepEqual([row.body_hash, row.objects, row.observed_at, row.instance_id, row.authority_evidence_hash], [before.body_hash, before.objects, before.observed_at, before.instance_id, before.authority_evidence_hash]);

  // the same key again answers the same confirmation
  const replay = completed<TargetContractView>(await confirm(draft.contractId, { expectedVersion: 1, bodyHash: draft.bodyHash, confirmationEvidenceRef: evidence.artifactRef }, w.approver, key), 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.confirmedAt, done.data.confirmedAt);
});

test("CMD019-DENY: an OPERATOR, a VIEWER and a non-member are refused; a digest that is not the stored body's, a body changed under its digest, a future or stale observation, foreign evidence and a stale version are rejected and the contract stays DRAFT", async () => {
  const projectId = await cleanProject();
  const draft = await draftThroughRoute(projectId);
  const evidence = await storeArtifact(projectId, { kind: "CONFIRMATION_EVIDENCE", document: { shown: "complete body" } });
  const good = { expectedVersion: 1, bodyHash: draft.bodyHash, confirmationEvidenceRef: evidence.artifactRef };
  const stillDraft = async (id: string): Promise<void> => {
    const row = await contractRow(id);
    assert.deepEqual([row?.version, row?.confirmed_at, row?.confirmed_by_membership_id], [1, null, null]);
  };

  assert.equal(outcome(w, await confirm(draft.contractId, good, w.operator)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await confirm(draft.contractId, good, w.viewer)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await confirm(draft.contractId, good, w.stranger)), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, await confirm(draft.contractId, { ...good, verified: true })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await confirm(ids.next(), good)), "404 NOT_FOUND -");
  // a contract of another agency is not visible to this one
  const foreignProject = (await w.project(w.B, w.clientB)).projectId;
  const foreign = ids.next();
  await w.asTenant(w.B, (c) =>
    c.query(
      `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
       VALUES ($1, $2, $3, 'CLEAN', $4, $5, 'R2-INITIAL', '[]'::jsonb, $6, $6, now(), NULL, $6, 'R2-INITIAL', now())`,
      [foreign, w.B.agencyId, foreignProject, ids.next(), ids.next(), sha("foreign")],
    ),
  );
  assert.equal(outcome(w, await confirm(foreign, good)), "404 NOT_FOUND -");

  // stale version and a digest that is not this body's (a reused digest of other metadata)
  assert.equal(outcome(w, await confirm(draft.contractId, { ...good, expectedVersion: 2 })), "409 STALE_VERSION -");
  assert.equal(outcome(w, await confirm(draft.contractId, { ...good, bodyHash: sha("other metadata") })), "409 STALE_VERSION -");
  // foreign, missing and wrong-kind evidence
  const other = await cleanProject();
  const otherEvidence = await storeArtifact(other, { kind: "CONFIRMATION_EVIDENCE", document: { shown: "x" } });
  assert.equal(outcome(w, await confirm(draft.contractId, { ...good, confirmationEvidenceRef: otherEvidence.artifactRef })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  assert.equal(outcome(w, await confirm(draft.contractId, { ...good, confirmationEvidenceRef: ids.next() })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  const metadataAsEvidence = await storeArtifact(projectId);
  assert.equal(outcome(w, await confirm(draft.contractId, { ...good, confirmationEvidenceRef: metadataAsEvidence.artifactRef })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  await stillDraft(draft.contractId);

  // the metadata changed under a digest that was reused: the stored body is no longer the body its digest names
  const tampered = await draftThroughRoute(await cleanProject());
  const tamperedEvidence = await storeArtifact(tampered.projectId, { kind: "CONFIRMATION_EVIDENCE", document: { shown: "t" } });
  // the immutability trigger refuses this edit for every ordinary writer: only a replica-role superuser can simulate a body changed under its digest
  await w.h.oracle.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE kauro.target_contracts SET objects = '[]'::jsonb WHERE contract_id = '${tampered.contractId}'; COMMIT;`);
  assert.equal(
    outcome(w, await confirm(tampered.contractId, { expectedVersion: 1, bodyHash: tampered.bodyHash, confirmationEvidenceRef: tamperedEvidence.artifactRef })),
    "422 INTEGRITY_FAILURE BODY_DIGEST_MISMATCH",
  );
  await stillDraft(tampered.contractId);

  // an observation ahead of the clock and one past the freshness window
  const futureProject = await cleanProject();
  const future = await directContract(futureProject, 3_600_000);
  const futureEvidence = await storeArtifact(futureProject, { kind: "CONFIRMATION_EVIDENCE", document: { shown: "f" } });
  assert.equal(outcome(w, await confirm(future.contractId, { expectedVersion: 1, bodyHash: future.bodyHash, confirmationEvidenceRef: futureEvidence.artifactRef })), "409 PRECONDITION_FAILED OBSERVATION_IN_FUTURE");
  const staleProject = await cleanProject();
  const stale = await directContract(staleProject, -3 * 86_400_000);
  const staleEvidence = await storeArtifact(staleProject, { kind: "CONFIRMATION_EVIDENCE", document: { shown: "s" } });
  assert.equal(outcome(w, await confirm(stale.contractId, { expectedVersion: 1, bodyHash: stale.bodyHash, confirmationEvidenceRef: staleEvidence.artifactRef })), "409 PRECONDITION_FAILED OBSERVATION_NOT_FRESH");
  await stillDraft(future.contractId);
  await stillDraft(stale.contractId);
});

test("CMD019-RACE: two approvers confirming one version yield one confirmation (the loser is told it is confirmed), the same key replays, the same key with another digest conflicts, and a confirmed contract is never confirmed again", async () => {
  const projectId = await cleanProject();
  const draft = await draftThroughRoute(projectId);
  const evidence = await storeArtifact(projectId, { kind: "CONFIRMATION_EVIDENCE", document: { shown: "complete body" } });
  const body = { expectedVersion: 1, bodyHash: draft.bodyHash, confirmationEvidenceRef: evidence.artifactRef };

  const replies = await Promise.all([confirm(draft.contractId, body, w.approver), confirm(draft.contractId, body, w.approver2), confirm(draft.contractId, body, w.owner)]);
  const outcomes = replies.map((r) => (r.status === 200 ? "200" : outcome(w, r))).sort();
  assert.deepEqual(outcomes, ["200", "409 PRECONDITION_FAILED TARGET_ALREADY_CONFIRMED", "409 PRECONDITION_FAILED TARGET_ALREADY_CONFIRMED"]);
  const row = await contractRow(draft.contractId);
  assert.equal(row?.version, 2, "exactly one confirmation");

  // the loser is told where the contract stands; a later request at the old version still is
  const later = await confirm(draft.contractId, body, w.approver);
  assert.equal(outcome(w, later), "409 PRECONDITION_FAILED TARGET_ALREADY_CONFIRMED");
  const problem = later.json<{ current?: { version: number; state: string } }>();
  assert.deepEqual([problem.current?.version, problem.current?.state], [2, "CONFIRMED"]);

  // idempotency: same key and request replays, same key and another digest conflicts
  const second = await draftThroughRoute(await cleanProject());
  const evidence2 = await storeArtifact(second.projectId, { kind: "CONFIRMATION_EVIDENCE", document: { shown: "again" } });
  const key = freshKey("cmd019-race");
  const request = { expectedVersion: 1, bodyHash: second.bodyHash, confirmationEvidenceRef: evidence2.artifactRef };
  completed<TargetContractView>(await confirm(second.contractId, request, w.approver, key), 200);
  assert.equal(completed<TargetContractView>(await confirm(second.contractId, request, w.approver, key), 200).replayed, true);
  assert.equal(outcome(w, await confirm(second.contractId, { ...request, bodyHash: sha("another") }, w.approver, key)), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
});
