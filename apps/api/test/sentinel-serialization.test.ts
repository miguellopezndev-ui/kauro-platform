// R23 — sentinel serialization over the seven routes (reference/FIELD_CONTRACTS.md "Common rules": "Internal records are not
// automatically safe browser DTOs. Responses must select only authorized fields and test serialization against sentinel
// data"; 10 "Responses and safe errors": problems exclude stack traces, SQL, bucket names, session URIs, raw cell values,
// internal secrets and foreign-resource existence; 10 "Agency and team routes": no authentication provider tokens, recovery
// settings or private security evidence; 08 "Security acceptance": "zero raw sentinel egress and zero secret leakage").
//
// Every route is driven through its success path and three problem paths (a closed-schema refusal whose body carries
// sentinel values under forbidden member names, a domain refusal, and an unexpected exception whose message carries SQL text
// and whose stack is real) by people whose provider subjects and bearer tokens are sentinels. The oracle then reads, across
// every tenant, the values that must never leave the server — provider subject hashes, invitation token hashes, step-up proof
// ids, receipt and target-contract evidence hashes, revision projection hashes, plan-body internals,
// journal entry ids and request digests, event ids and payload hashes — and asserts that none of them, no bearer token, no
// sentinel and no diagnostic text appears in any status line, header or body the api sent. Real routes, real composition
// root, real PostgreSQL 17.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { KnownSchemaId } from "@kauro/application";
import { commandResponseSchemaId } from "@kauro/application";
import type { ProjectId } from "@kauro/domain";
import { approvalBodyOf, call, freshKey, ids, outcome, routes, sha, world, type Call, type Person, type Reply, type World } from "./support.js";

const MARK = `snt${randomBytes(6).toString("hex")}`;
const REASON_MARK = `SNTL_${MARK.toUpperCase()}`;

let w: World;
/** One current target contract per project (migration 0073 rule (c)): each approvable subject gets a project of its own, so none supersedes another. */
const projectOfItsOwn = async (): Promise<ProjectId> => (await w.project(w.A, w.clientA)).projectId;
const people: Record<"founder" | "founder2" | "operator" | "admin" | "approver", Person> = {} as never;

interface Sent {
  readonly label: string;
  readonly reply: Reply;
}
const sent: Sent[] = [];

before(async () => {
  w = await world();
  for (const role of ["founder", "founder2", "operator", "admin", "approver"] as const) people[role] = await w.person(`${MARK}-${role}`);
  await w.h.addMember(w.A, people.operator.userId, "OPERATOR");
  await w.h.addMember(w.A, people.admin.userId, "ADMIN");
  await w.h.addMember(w.A, people.approver.userId, "APPROVER");
  // an open invitation of agency A, issued through the invitation port (every accepted member above also left a consumed one):
  // its token hash is team security material no reply may carry
  await w.h.inviteMember(w.A, (await w.person(`${MARK}-invitee`)).userId, "OPERATOR");
});
after(async () => {
  await w.stop();
});

/** Members a client could send to fish for echoes: forbidden member names carrying sentinel values. */
const FISHING = { password: `${MARK}-password`, tokenHash: sha(`${MARK}-token`), sql: `SELECT ${MARK} FROM kauro.identities` };

async function send(label: string, c: Call): Promise<Reply> {
  const reply = await call(w, c);
  sent.push({ label, reply });
  return reply;
}

function validReply(reply: Reply, schemaId: KnownSchemaId): void {
  const v = w.validator.validate(schemaId, reply.json());
  assert.equal(v.kind, "VALID", `${schemaId}: ${JSON.stringify(v.kind === "INVALID" ? v.fields : [])}`);
}

/** The unexpected-exception path: the failure strikes inside the unit of work, after the effect rows and before COMMIT. */
async function crash(label: string, c: Call): Promise<void> {
  const sunk = w.internalErrors.length;
  w.holds.arm("journal.commit", { fail: new TypeError(`SELECT ${MARK}_secret, subject_hash FROM kauro.identities WHERE password = '${MARK}-password'`) });
  const reply = await send(label, c);
  assert.equal(outcome(w, reply), "500 INTERNAL_ERROR -", label);
  assert.equal(w.internalErrors.length, sunk + 1, `${label}: the sink received the failure`);
}

async function schemaProblem(label: string, c: Call): Promise<void> {
  const reply = await send(label, c);
  assert.equal(outcome(w, reply), "400 INVALID_REQUEST SCHEMA_VIOLATION", label);
  assert.deepEqual(reply.json<{ errors: unknown }>().errors, Object.keys(FISHING).map((field) => ({ field, code: "UNKNOWN_FIELD" })), `${label}: the problem names the members, never their values`);
}

test("CMD001 CreateAgency: success, a closed-schema refusal, the database's one-DRAFT refusal and an unexpected exception carry no sentinel", async () => {
  const url = routes.createAgency();
  const ok = await send("CMD001 success", { url, token: people.founder.token, agency: null, body: { displayName: "Founded agency" } });
  assert.equal(ok.status, 201);
  validReply(ok, commandResponseSchemaId("CMD001"));
  await schemaProblem("CMD001 schema", { url, token: people.founder2.token, agency: null, body: { displayName: "Fishing", ...FISHING } });
  // the unique index agencies_one_draft_per_creator refuses the insert; its name, SQL and key never reach the wire
  assert.equal(outcome(w, await send("CMD001 domain", { url, token: people.founder.token, agency: null, body: { displayName: "Second draft" } })), "429 ADMISSION_LIMITED DRAFT_AGENCY_EXISTS");
  await crash("CMD001 crash", { url, token: people.founder2.token, agency: null, body: { displayName: "Crashing agency" } });
});

test("CMD009 CreateClient: success, a closed-schema refusal, a foreign processing authority and an unexpected exception carry no sentinel", async () => {
  const url = routes.createClient(w.A.agencyId);
  const ok = await send("CMD009 success", { url, token: people.operator.token, agency: null, body: { displayName: "Sentinel client", processingAuthorityRef: w.authorityA } });
  assert.equal(ok.status, 201);
  validReply(ok, commandResponseSchemaId("CMD009"));
  await schemaProblem("CMD009 schema", { url, token: people.operator.token, agency: null, body: { displayName: "Fishing", processingAuthorityRef: w.authorityA, ...FISHING } });
  assert.equal(outcome(w, await send("CMD009 domain", { url, token: people.operator.token, agency: null, body: { displayName: "Foreign", processingAuthorityRef: w.authorityB } })), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  await crash("CMD009 crash", { url, token: people.operator.token, agency: null, body: { displayName: "Crashing client", processingAuthorityRef: w.authorityA } });
});

test("CMD010 ArchiveClient: success, a closed-schema refusal, a stale version and an unexpected exception carry no sentinel", async () => {
  const archived = await w.h.endClient(w.A, w.authorityA, "To archive");
  const crashing = await w.h.endClient(w.A, w.authorityA, "To crash");
  const ok = await send("CMD010 success", { url: routes.archiveClient(archived), token: people.admin.token, body: { expectedVersion: 1 } });
  assert.equal(ok.status, 200);
  validReply(ok, commandResponseSchemaId("CMD010"));
  await schemaProblem("CMD010 schema", { url: routes.archiveClient(archived), token: people.admin.token, body: { expectedVersion: 2, ...FISHING } });
  assert.equal(outcome(w, await send("CMD010 domain", { url: routes.archiveClient(archived), token: people.admin.token, body: { expectedVersion: 1 } })), "409 STALE_VERSION -");
  await crash("CMD010 crash", { url: routes.archiveClient(crashing), token: people.admin.token, body: { expectedVersion: 1 } });
});

test("CMD011 CreateProject: success, a closed-schema refusal, an unoffered mode and an unexpected exception carry no sentinel", async () => {
  const url = routes.createProject(w.clientA);
  const ok = await send("CMD011 success", { url, token: people.operator.token, body: { mode: "CLEAN", purpose: "Sentinel project" } });
  assert.equal(ok.status, 201);
  validReply(ok, commandResponseSchemaId("CMD011"));
  await schemaProblem("CMD011 schema", { url, token: people.operator.token, body: { mode: "CLEAN", purpose: "Fishing", ...FISHING } });
  assert.equal(outcome(w, await send("CMD011 domain", { url, token: people.operator.token, body: { mode: "HUBSPOT", purpose: "Unoffered", targetInstanceRef: ids.next() } })), "422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED");
  await crash("CMD011 crash", { url, token: people.operator.token, body: { mode: "CLEAN", purpose: "Crashing project" } });
});

test("CMD023 RevisePlan: success (the successor body carries a sentinel), a closed-schema refusal, a stale version and an unexpected exception carry no sentinel", async () => {
  const revised = await w.approvable(w.A, await projectOfItsOwn(), `${MARK}-revise`);
  const crashing = await w.approvable(w.A, await projectOfItsOwn(), `${MARK}-revise-crash`);
  const patch = w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: REASON_MARK });
  const ok = await send("CMD023 success", { url: routes.revisePlan(revised.planId), token: people.operator.token, body: { expectedVersion: 4, decisionPatchArtifactRef: patch } });
  assert.equal(ok.status, 201);
  validReply(ok, commandResponseSchemaId("CMD023"));
  // the successor's body holds the sentinel: it was available to leak
  const successorId = ok.json<{ data: { plan: { planId: string } } }>().data.plan.planId;
  assert.ok(JSON.stringify((await w.row<{ body: unknown }>("plans", "plan_id = $1", [successorId]))?.body).includes(REASON_MARK));
  await schemaProblem("CMD023 schema", { url: routes.revisePlan(revised.planId), token: people.operator.token, body: { expectedVersion: 4, decisionPatchArtifactRef: patch, ...FISHING } });
  assert.equal(outcome(w, await send("CMD023 domain", { url: routes.revisePlan(revised.planId), token: people.operator.token, body: { expectedVersion: 4, decisionPatchArtifactRef: patch } })), "409 STALE_VERSION -");
  await crash("CMD023 crash", { url: routes.revisePlan(crashing.planId), token: people.operator.token, body: { expectedVersion: 4, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: REASON_MARK }) } });
});

test("CMD025 ApprovePlan and CMD026 WithdrawApproval: success, closed-schema refusals, a stale step-up, a non-controller and unexpected exceptions carry no sentinel — the step-up proof never comes back", async () => {
  const approved = await w.approvable(w.A, await projectOfItsOwn(), `${MARK}-approve`);
  const crashing = await w.approvable(w.A, await projectOfItsOwn(), `${MARK}-approve-crash`);
  const proof = await w.stepUp(people.approver);
  await schemaProblem("CMD025 schema", { url: routes.approvePlan(approved.planId), token: people.approver.token, body: { ...approvalBodyOf(approved, proof), ...FISHING } });
  const stale = await w.stepUp(people.approver, "STALE");
  assert.equal(outcome(w, await send("CMD025 domain", { url: routes.approvePlan(approved.planId), token: people.approver.token, body: approvalBodyOf(approved, stale) })), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  await crash("CMD025 crash", { url: routes.approvePlan(crashing.planId), token: people.approver.token, body: approvalBodyOf(crashing, proof) });
  const ok = await send("CMD025 success", { url: routes.approvePlan(approved.planId), token: people.approver.token, key: freshKey("sentinel-approve"), body: approvalBodyOf(approved, proof) });
  assert.equal(ok.status, 201);
  validReply(ok, commandResponseSchemaId("CMD025"));

  const withdraw = routes.withdrawApproval(approved.planId);
  assert.equal(outcome(w, await send("CMD026 domain", { url: withdraw, token: w.approver2.token, body: { expectedVersion: 5, reasonCode: "CUSTOMER_REQUEST" } })), "403 NOT_AUTHORIZED NOT_APPROVAL_CONTROLLER");
  await schemaProblem("CMD026 schema", { url: withdraw, token: people.approver.token, body: { expectedVersion: 5, reasonCode: "CUSTOMER_REQUEST", ...FISHING } });
  await crash("CMD026 crash", { url: withdraw, token: people.approver.token, body: { expectedVersion: 5, reasonCode: "CUSTOMER_REQUEST" } });
  const withdrawn = await send("CMD026 success", { url: withdraw, token: people.approver.token, body: { expectedVersion: 5, reasonCode: "CUSTOMER_REQUEST" } });
  assert.equal(withdrawn.status, 200);
  validReply(withdrawn, commandResponseSchemaId("CMD026"));
});

test("no sentinel, secret, internal column value or diagnostic text of any tenant appears in any reply the seven routes sent", async () => {
  // the replies cover every route on its success path and on three problem paths
  const labels = sent.map((s) => s.label);
  for (const command of ["CMD001", "CMD009", "CMD010", "CMD011", "CMD023", "CMD025", "CMD026"]) {
    for (const path of ["success", "schema", "domain", "crash"]) assert.ok(labels.includes(`${command} ${path}`), `${command} ${path}`);
  }
  assert.equal(sent.length, 28);

  // what must never leave the server, read by the superuser oracle across every tenant
  const oracle = w.h.oracle;
  const column = async (sql: string): Promise<string[]> => (await oracle.query<{ v: string }>(sql)).rows.map((r) => String(r.v));
  const forbidden = new Map<string, ReadonlyArray<string>>([
    ["sentinel marker (provider subjects, labels of the fishing members)", [MARK, REASON_MARK]],
    ["bearer tokens", [w.owner, w.admin, w.operator, w.approver, w.approver2, w.viewer, w.stranger, ...Object.values(people)].map((p) => p.token)],
    ["fishing values", Object.values(FISHING)],
    ["provider subject hashes", await column("SELECT subject_hash AS v FROM kauro.identities")],
    ["invitation token hashes", await column("SELECT token_hash AS v FROM kauro.membership_invitations")],
    ["step-up proof ids", await column("SELECT proof_id AS v FROM kauro.assurance_proofs")],
    ["receipt evidence", await column("SELECT unnest(ARRAY[core_package_hash, profile_evidence_hash, disposition_evidence_hash, artifact_evidence_hash]) AS v FROM kauro.validation_receipts")],
    ["target contract evidence", await column("SELECT unnest(ARRAY[authority_evidence_hash, schema_bundle_digest]) AS v FROM kauro.target_contracts")],
    ["revision projection hashes", await column("SELECT projection_hash AS v FROM kauro.dataset_revisions WHERE projection_hash IS NOT NULL")],
    [
      "plan body internals",
      await column(
        `SELECT DISTINCT unnest(ARRAY[m->>'mappingId', m->>'sourceTableId', m->>'sourceFieldId', m->'evidence'->>'evidenceId', m->'evidence'->>'candidateId', m->'evidence'->>'comparisonHash', m->'evidence'->>'fragmentHash']) AS v
           FROM kauro.plans, jsonb_array_elements(body->'mappings') AS m`,
      ),
    ],
    ["journal entry ids and request digests", await column("SELECT unnest(ARRAY[entry_id::text, request_digest]) AS v FROM kauro.command_journal")],
    ["event ids and payload hashes", await column("SELECT unnest(ARRAY[event_id::text, payload_hash]) AS v FROM kauro.domain_events")],
  ]);
  for (const [category, values] of forbidden) assert.ok(values.length > 0, `${category}: seeded`);
  const diagnostics = [/SELECT/, /FROM kauro/, /TypeError/, /\bat \S+\.(?:js|ts|mjs):\d+/, /node:internal/, /duplicate key/, /violates/, /agencies_one_draft_per_creator/, /Key \(/];

  for (const { label, reply } of sent) {
    const wire = `${reply.status}\n${JSON.stringify(reply.headers)}\n${reply.text}`;
    for (const [category, values] of forbidden) {
      for (const value of values) assert.ok(!wire.includes(value), `${label}: a value of "${category}" reached the wire`);
    }
    for (const pattern of diagnostics) assert.ok(!pattern.test(wire), `${label}: ${pattern} reached the wire`);
    // every reply is its route's declared shape: the success envelope, or the closed Problem document
    if (reply.status >= 400) validReply(reply, "Problem");
  }
});
