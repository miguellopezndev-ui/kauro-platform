// CMD054 OpenBreakglass (POST /api/v1/operations/breakglass-grants, KAURO_OWNER with a fresh step-up) and CMD055 RevokeBreakglass (POST
// /api/v1/operations/breakglass-grants/{grantId}/revoke, KAURO_OWNER), and the one consumer of a grant: the breakglass preview of an admitted
// table (GET /api/v1/operations/breakglass-grants/{grantId}/tables/{tableId}/preview) — package B16 lane L4 (cases CMD054-OK, CMD054-DENY,
// CMD054-RACE, CMD055-OK, CMD055-DENY, CMD055-RACE, R2-050, S071; failure matrix GAP-BG-1..8 of mandate B16-REST-PLAN §2).
// The real routes, the corporate owner authorizer, B06's step-up verifier, the storage fake and the platform's real bounded preview reader of
// @kauro/data-plane, over PostgreSQL 17 through the runtime login roles. The superuser only reads and builds fixtures: it closes a support case,
// requests a project's deletion, closes an agency and moves a grant's instants into the past (the platform's clock passing), always outside a
// command. Interleavings are held at named points or behind locks the superuser holds; nothing sleeps except the one expiry-crossing wait,
// bounded by the instant it set itself.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { IsolatedTablePreviewReader, inspectionLimits } from "@kauro/data-plane";
import type { UserId } from "@kauro/domain";
import { invariantsAfterEach, recordActiveSeller } from "@kauro/persistence/testing";
import { asPerson } from "./sellers-support.js";
import { activate, csvContent, setSessionLimit, sourceRoutes, uploadAndAdmit } from "./source-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, routes, waitForApiLockWait, world, type Person, type Reply, type World } from "./support.js";

// The wire shapes the tests read, stated here so the tests compile before the views exist and a renamed member fails at its assertion.
interface BreakglassGrantView {
  readonly grantId: string;
  readonly scopeRef: string;
  readonly agencyId: string;
  readonly purpose: string;
  readonly authorizationRef: string;
  readonly authorizationKind: "SUPPORT_CASE" | "INCIDENT";
  readonly state: "ACTIVE" | "REVOKED" | "EXPIRED";
  readonly openedAt: string;
  readonly expiresAt: string;
  readonly access: "PREVIEW_ONLY";
  readonly version: number;
}
interface BreakglassRevocationView {
  readonly grantId: string;
  readonly state: "REVOKED";
  readonly revokedAt: string;
  readonly refreshRevoked: true;
  readonly residualBearerLifetimeSeconds: number;
  readonly residualBearerUntil: string;
  readonly version: number;
}
interface BreakglassPreviewView {
  readonly grantId: string;
  readonly tableId: string;
  readonly fileId: string;
  readonly expiresAt: string;
  readonly truncated: boolean;
  readonly rows: ReadonlyArray<ReadonlyArray<string | null>>;
}

let w: World;
let scratch: string;
let corp: Person;
let corp2: Person;
invariantsAfterEach(() => w.h.oracle);
before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kauro-breakglass-"));
  const preview = { reader: new IsolatedTablePreviewReader(), limits: inspectionLimits(), scratchDir: scratch };
  w = await world({ sources: () => ({ preview }) });
  await activate(w);
  await activate(w, w.B);
  await setSessionLimit(w, w.A, 32);
  await setSessionLimit(w, w.B, 4);
  corp = await w.person("breakglass-owner");
  await w.h.grantKauroOwner(corp.userId);
  corp2 = await w.person("breakglass-owner-two");
  await w.h.grantKauroOwner(corp2.userId);
});
after(async () => {
  await w.stop();
  rmSync(scratch, { recursive: true, force: true });
});

const grantsUrl = "/api/v1/operations/breakglass-grants";
const revokeUrl = (grantId: string): string => `${grantsUrl}/${grantId}/revoke`;
const previewUrl = (grantId: string, tableId: string): string => `${grantsUrl}/${grantId}/tables/${tableId}/preview`;
const BREAKGLASS_SECONDS = 1800;
const RESIDUAL_BEARER_SECONDS = 900;

function open(body: Record<string, unknown>, options: { readonly token?: string | null; readonly key?: string } = {}): Promise<Reply> {
  return call(w, { url: grantsUrl, token: options.token === undefined ? corp.token : options.token, agency: null, key: options.key ?? freshKey("cmd054"), body });
}
function revoke(grantId: string, body: Record<string, unknown> = { reasonCode: "WORK_COMPLETE" }, options: { readonly token?: string | null; readonly key?: string } = {}): Promise<Reply> {
  return call(w, { url: revokeUrl(grantId), token: options.token === undefined ? corp.token : options.token, agency: null, key: options.key ?? freshKey("cmd055"), body });
}
function preview(grantId: string, tableId: string, person: Person = corp, query = ""): Promise<Reply> {
  return call(w, { method: "GET", url: `${previewUrl(grantId, tableId)}${query}`, token: person.token, key: null, contentType: null, agency: null });
}
/** A COMPLETED reply of a breakglass route, asserted (the status first, so a missing route fails at its assertion). */
function served<T>(reply: Reply, status: 200 | 201) {
  assert.equal(reply.status, status, reply.text);
  return completed<T>(reply, status);
}
function dataOf<T>(reply: Reply): T {
  assert.equal(reply.status, 200, reply.text);
  const body = reply.json<{ kind: string; data: T }>();
  assert.equal(body.kind, "READ");
  return body.data;
}

interface Scope {
  readonly agencyId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly tableId: string;
  readonly caseId: string;
  readonly seed: string;
}
/** A project of agency A with one admitted CSV table, or of agency B without a file, and one OPEN support case of that project opened by a member. */
async function scope(label: string, agency: "A" | "B" = "A"): Promise<Scope> {
  const fixture = agency === "A" ? w.A : w.B;
  const member = agency === "A" ? w.operator : w.stranger;
  const { projectId, revisionId } = await w.project(fixture, agency === "A" ? w.clientA : w.clientB);
  const seed = `bg${label.replace(/[^a-z0-9]/g, "")}`;
  const file = agency === "A" ? await uploadAndAdmit(w, revisionId, 1, { content: csvContent(3, seed), person: member }) : { tables: [{ tableId: ids.next() }] };
  const created = await call(w, { url: routes.createSupportCase(projectId), token: member.token, agency: fixture.agencyId, key: freshKey("cmd044"), body: { category: "PRODUCT_DEFECT", summary: `Import mapping question ${label}`, evidenceRefs: [] } });
  const caseId = completed<{ caseId: string }>(created, 201).data.caseId;
  return { agencyId: fixture.agencyId, projectId, revisionId, tableId: file.tables[0]?.tableId as string, caseId, seed };
}
async function supportCase(s: Scope, label: string): Promise<string> {
  const created = await call(w, { url: routes.createSupportCase(s.projectId), token: w.operator.token, agency: s.agencyId, key: freshKey("cmd044"), body: { category: "PRODUCT_DEFECT", summary: `Second question ${label}`, evidenceRefs: [] } });
  return completed<{ caseId: string }>(created, 201).data.caseId;
}
async function openBody(s: Scope, overrides: Record<string, unknown> = {}, person: Person = corp): Promise<Record<string, unknown>> {
  return { scopeRef: s.projectId, purpose: "Support case triage", assuranceProofRef: await w.stepUp(person), authorizationRef: s.caseId, ...overrides };
}
async function opened(s: Scope, overrides: Record<string, unknown> = {}): Promise<BreakglassGrantView> {
  return served<BreakglassGrantView>(await open(await openBody(s, overrides)), 201).data;
}

type GrantRow = { grant_id: string; holder_user_id: string; agency_id: string; project_id: string; authorization_kind: string; authorization_ref: string; state: string; revision: number; opened_at: Date; expires_at: Date; revoked_at: Date | null; revoked_by_user_id: string | null; revoke_reason: string | null };
const grantRow = async (grantId: string): Promise<GrantRow | undefined> => (await w.h.oracle.query<GrantRow>("SELECT * FROM kauro.breakglass_grants WHERE grant_id = $1", [grantId])).rows[0];
const grantsOf = async (projectId: string): Promise<GrantRow[]> => (await w.h.oracle.query<GrantRow>("SELECT * FROM kauro.breakglass_grants WHERE project_id = $1 ORDER BY opened_at, grant_id", [projectId])).rows;
const accessCount = async (grantId: string): Promise<number> => w.count("breakglass_accesses", "grant_id = $1", [grantId]);

/** The superuser, outside every command: one transaction with the replication role, so no trigger of the platform runs. */
async function asPlatform(sql: string, params: ReadonlyArray<unknown>): Promise<void> {
  const c = await w.h.pg.connect("postgres");
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params as unknown[]);
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
}
/** The platform's clock passing: the grant opened `seconds` ago (its expiry 1800 s after that). */
const ageGrant = (grantId: string, seconds: number): Promise<void> =>
  asPlatform("UPDATE kauro.breakglass_grants SET opened_at = now() - make_interval(secs => $2), expires_at = now() - make_interval(secs => $2) + make_interval(secs => 1800) WHERE grant_id = $1", [grantId, seconds]);

/** A raw superuser connection holding `sql` inside an open transaction until `end()` commits it. */
async function holding(sql: string, params: ReadonlyArray<unknown>): Promise<{ readonly client: Client; end(): Promise<void> }> {
  const client = await w.h.pg.connect("postgres");
  await client.query("BEGIN");
  await client.query(sql, params as unknown[]);
  return {
    client,
    async end() {
      try {
        await client.query("COMMIT");
      } finally {
        await client.end();
      }
    },
  };
}

// --- CMD054 ----------------------------------------------------------------------------------------------------------------------------

test("CMD054-OK: the corporate owner with a fresh step-up opens a breakglass grant over one project for an OPEN support case of that project — 201 ACTIVE, preview only, expiring 1800 s after the database's instant, with its ALLOW fact and one journal entry; an ACTUAL incident naming the project justifies a grant too; the grant reads the table's bounded preview and every read is audited", async () => {
  const s = await scope("ok");
  const key = freshKey("cmd054-ok");
  const facts = (await w.securityEvents("CMD054")).length;
  const reply = await open(await openBody(s), { key });
  const grant = served<BreakglassGrantView>(reply, 201).data;
  assert.deepEqual(
    [grant.scopeRef, grant.agencyId, grant.authorizationRef, grant.authorizationKind, grant.state, grant.access, grant.version],
    [s.projectId, s.agencyId, s.caseId, "SUPPORT_CASE", "ACTIVE", "PREVIEW_ONLY", 1],
  );
  assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.openedAt), BREAKGLASS_SECONDS * 1000, "a short-lived grant: exactly the registry's 1800 s");
  const row = await grantRow(grant.grantId);
  assert.deepEqual([row?.holder_user_id, row?.agency_id, row?.project_id, row?.state, row?.revision], [corp.userId, s.agencyId, s.projectId, "ACTIVE", 1]);
  assert.equal(row?.expires_at.getTime(), (row?.opened_at.getTime() ?? 0) + BREAKGLASS_SECONDS * 1000);
  assert.deepEqual((await w.securityEvents("CMD054")).slice(facts).map((f) => [f.outcome, f.reason, f.actorId, f.assuranceClass]), [["ALLOW", "STEP_UP_FRESH", corp.userId, "STEP_UP"]]);
  assert.equal((await w.journal(key))?.state, "COMMITTED");
  assert.ok(!reply.text.includes(`${s.seed}0@example.com`), "the grant's answer carries no customer value");

  const reads = (await w.securityEvents("BREAKGLASS_PREVIEW")).length;
  const sample = dataOf<BreakglassPreviewView>(await preview(grant.grantId, s.tableId));
  assert.deepEqual([sample.grantId, sample.tableId, sample.expiresAt], [grant.grantId, s.tableId, grant.expiresAt]);
  assert.deepEqual(sample.rows.slice(0, 2), [["Email", "Name"], [`${s.seed}0@example.com`, `${s.seed} 0`]]);
  assert.ok(sample.rows.length <= 20 && sample.rows.every((r) => r.length <= 50), "a bounded preview, never the file");
  assert.equal(await accessCount(grant.grantId), 1, "the read is recorded against its grant");
  assert.deepEqual((await w.securityEvents("BREAKGLASS_PREVIEW")).slice(reads).map((f) => [f.outcome, f.reason, f.actorId]), [["ALLOW", "BREAKGLASS_GRANT_LIVE", corp.userId]]);

  // an actual incident whose affected scopes name the project justifies a grant of another project
  const t = await scope("ok-incident");
  const incident = completed<{ incidentId: string }>(
    await call(w, { url: "/api/v1/operations/incidents", token: corp.token, agency: null, key: freshKey("cmd056"), body: { severity: "S2", affectedScopeRefs: [`project:${t.projectId}`], summary: "Import worker reads wrong rows" } }),
    201,
  ).data;
  const byIncident = await opened(t, { authorizationRef: incident.incidentId, purpose: "Incident containment" });
  assert.deepEqual([byIncident.authorizationKind, byIncident.state], ["INCIDENT", "ACTIVE"]);
});

test("CMD054-DENY: no credential, an agency OWNER, a seller, a stale or foreign step-up, a reused step-up (silent reuse), a support case of another project or agency, an unknown, closed or resolved authorization, a false-positive incident or one not naming the project, a project whose deletion was requested, and a body asking more than a scope (blanket raw access) are refused — nothing is written", async () => {
  const s = await scope("deny");
  const other = await scope("deny-other");
  const foreign = await scope("deny-foreign", "B");
  assert.equal(outcome(w, await open(await openBody(s), { token: null })), "401 AUTHENTICATION_REQUIRED -");
  const grants = () => w.count("breakglass_grants");
  const before = await grants();
  const untouched = async (label: string) => assert.equal(await grants(), before, `${label}: no grant was written`);
  assert.equal(outcome(w, await open(await openBody(s, {}, w.owner), { token: w.owner.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "an agency OWNER is not the corporate owner");
  const seller = await w.person("breakglass-seller");
  await recordActiveSeller(w.h, { ownerUserId: corp.userId as UserId, subject: "breakglass-seller" });
  assert.equal(outcome(w, await open(await openBody(s, {}, seller), { token: seller.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING", "a seller is not the corporate owner");
  await untouched("wrong role");

  assert.equal(outcome(w, await open(await openBody(s, { assuranceProofRef: await w.stepUp(corp, "STALE") }))), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  assert.equal(outcome(w, await open(await openBody(s, { assuranceProofRef: await w.stepUp(corp2) }))), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  await untouched("step-up");

  const unauthorized = "409 PRECONDITION_FAILED BREAKGLASS_SCOPE_UNAUTHORIZED";
  assert.equal(outcome(w, await open(await openBody(s, { authorizationRef: other.caseId }))), unauthorized, "another project's support case");
  assert.equal(outcome(w, await open(await openBody(s, { authorizationRef: foreign.caseId }))), unauthorized, "another agency's support case");
  assert.equal(outcome(w, await open(await openBody(foreign, { authorizationRef: s.caseId }))), unauthorized, "an unrelated tenant through this case");
  assert.equal(outcome(w, await open(await openBody(s, { authorizationRef: ids.next() }))), unauthorized, "an authorization nobody holds");
  assert.equal(outcome(w, await open(await openBody(s, { scopeRef: ids.next() }))), unauthorized, "a project nobody holds");
  const fp = completed<{ incidentId: string }>(await call(w, { url: "/api/v1/operations/incidents", token: corp.token, agency: null, key: freshKey("cmd056"), body: { severity: "FALSE_POSITIVE", affectedScopeRefs: [`project:${s.projectId}`], summary: "Monitoring false positive" } }), 201).data;
  assert.equal(outcome(w, await open(await openBody(s, { authorizationRef: fp.incidentId }))), unauthorized, "a false positive justifies nothing");
  const elsewhere = completed<{ incidentId: string }>(await call(w, { url: "/api/v1/operations/incidents", token: corp.token, agency: null, key: freshKey("cmd056"), body: { severity: "S3", affectedScopeRefs: ["provider:storage"], summary: "Storage latency" } }), 201).data;
  assert.equal(outcome(w, await open(await openBody(s, { authorizationRef: elsewhere.incidentId }))), unauthorized, "an incident that does not name the project");
  const closed = await scope("deny-closed");
  await asPlatform("UPDATE kauro.support_cases SET state = 'CLOSED' WHERE case_id = $1", [closed.caseId]);
  assert.equal(outcome(w, await open(await openBody(closed))), unauthorized, "a closed support case");
  const resolved = await scope("deny-resolved");
  await asPlatform("UPDATE kauro.support_cases SET state = 'RESOLVED' WHERE case_id = $1", [resolved.caseId]);
  assert.equal(outcome(w, await open(await openBody(resolved))), unauthorized, "a resolved support case");
  const deleting = await scope("deny-deleting");
  await asPlatform("UPDATE kauro.projects SET state = 'DELETION_REQUESTED' WHERE project_id = $1", [deleting.projectId]);
  assert.equal(outcome(w, await open(await openBody(deleting))), unauthorized, "a project whose deletion was requested");
  await untouched("scope");

  // the closed body: a grant is one project's preview, never blanket raw access (no extra field, no list of scopes, no export)
  assert.equal((await open({ ...(await openBody(s)), rawExport: true })).status, 400, "a closed body");
  assert.equal((await open({ ...(await openBody(s)), scopeRef: [s.projectId, other.projectId] })).status, 400, "one scope");
  assert.equal((await open({ ...(await openBody(s)), scopeRef: "*" })).status, 400, "no wildcard");
  const { assuranceProofRef: _omitted, ...withoutProof } = await openBody(s);
  assert.equal((await open(withoutProof)).status, 400, "the step-up proof is required");
  await untouched("body");

  // the database holds the same line without the handler: the owner's session cannot insert a grant its authorization does not justify (KA089)
  const forged = await asPerson(w.h, corp.userId, (c) =>
    c
      .query(
        "INSERT INTO kauro.breakglass_grants (grant_id, holder_user_id, agency_id, project_id, purpose, authorization_kind, authorization_ref, assurance_proof_ref) VALUES ($1, $2, $3, $4, 'Forged', 'SUPPORT_CASE', $5, $6)",
        [ids.next(), corp.userId, s.agencyId, s.projectId, other.caseId, ids.next()],
      )
      .then(() => "inserted", (e: { code?: string }) => e.code ?? "refused"),
  );
  assert.equal(forged, "KA089");
  await untouched("forged insert");

  // silent reuse: a step-up proof opens one grant, never a second one
  const proof = await w.stepUp(corp);
  served<BreakglassGrantView>(await open(await openBody(s, { assuranceProofRef: proof })), 201);
  const t = await scope("deny-reuse");
  assert.equal(outcome(w, await open(await openBody(t, { assuranceProofRef: proof }))), "409 PRECONDITION_FAILED BREAKGLASS_PROOF_REUSED");
  assert.equal(await grants(), before + 1);
});

test("CMD054-RACE: an identical retry replays the 201 and the same key with another body is 409 IDEMPOTENCY_CONFLICT; two opens of one scope yield one live grant and one 409 BREAKGLASS_GRANT_LIVE with the wait observed (both justifications real); a crash before COMMIT leaves no grant and the retry opens one; a crash after COMMIT is replayed, never a second grant; a fault at the journal append (the second write) leaves no grant (GAP-BG-4..6, GAP-BG-8)", async () => {
  const s = await scope("race");
  const key = freshKey("cmd054-race");
  const body = await openBody(s);
  const first = await open(body, { key });
  const grant = served<BreakglassGrantView>(first, 201).data;
  const replay = await open(body, { key });
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(outcome(w, await open({ ...body, purpose: "Another purpose" }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await grantsOf(s.projectId)).length, 1, "the replay opened nothing");
  // sequentially: the scope already holds a live grant
  const second = await supportCase(s, "race-second");
  const refused = await open(await openBody(s, { authorizationRef: second }));
  assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_LIVE");
  assert.deepEqual(asProblem(w, refused).current, { version: 1, state: "ACTIVE" });

  // concurrently: the first holds its uncommitted grant until its commit; the second waits on the live-grant index, then is refused
  const r = await scope("race-two");
  const rSecond = await supportCase(r, "race-two-second");
  const hold = w.holds.arm("journal.commit");
  const winner = open(await openBody(r));
  await hold.reached;
  const loser = open(await openBody(r, { authorizationRef: rSecond }));
  try {
    await waitForApiLockWait(w, "INSERT INTO kauro.breakglass_grants");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  served<BreakglassGrantView>(won, 201);
  assert.equal(outcome(w, lost), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_LIVE");
  assert.deepEqual((await grantsOf(r.projectId)).map((g) => g.state), ["ACTIVE"], "one live grant");

  // CRASH-BEFORE: written and never committed; the retry with the same key opens exactly one
  const c = await scope("race-crash");
  const crashKey = freshKey("cmd054-crash");
  const crashBody = await openBody(c);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(w, await open(crashBody, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.deepEqual(await grantsOf(c.projectId), []);
  assert.equal(await w.journal(crashKey), null);
  served<BreakglassGrantView>(await open(crashBody, { key: crashKey }), 201);
  assert.equal((await grantsOf(c.projectId)).length, 1);

  // CRASH-AFTER: the commit landed and the answer was lost; the retry replays the journaled grant
  const a = await scope("race-after");
  const afterKey = freshKey("cmd054-after");
  const afterBody = await openBody(a);
  w.holds.arm("after.commit", { fail: new SimulatedCrash("after COMMIT") });
  assert.equal((await open(afterBody, { key: afterKey })).status, 500);
  const landed = await grantsOf(a.projectId);
  assert.equal(landed.length, 1, "the grant committed before the answer was lost");
  const retried = served<BreakglassGrantView>(await open(afterBody, { key: afterKey }), 201);
  assert.equal(retried.replayed, true);
  assert.equal(retried.data.grantId, landed[0]?.grant_id);
  assert.equal((await grantsOf(a.projectId)).length, 1, "never a second grant");

  // PARTIAL (GAP-BG-8): the grant is written, the journal append (the second write) fails: the unit rolls back whole
  const p = await scope("race-partial");
  w.holds.arm("journal.commit", { fail: new Error("journal append fault") });
  assert.equal((await open(await openBody(p))).status, 500);
  assert.deepEqual(await grantsOf(p.projectId), [], "no grant without its journal entry");
  assert.equal(grant.state, "ACTIVE");
});

// --- CMD055 ----------------------------------------------------------------------------------------------------------------------------

test("CMD055-OK: the corporate owner revokes a live grant — 200 REVOKED with the reason, the database's instant and the residual bearer lifetime of capabilities already issued (900 s, never zero); the grant reads nothing more and the record is kept; another corporate owner may revoke a grant it does not hold", async () => {
  const s = await scope("revoke-ok");
  const grant = await opened(s);
  dataOf<BreakglassPreviewView>(await preview(grant.grantId, s.tableId));
  const key = freshKey("cmd055-ok");
  const facts = (await w.securityEvents("CMD055")).length;
  const done = served<BreakglassRevocationView>(await revoke(grant.grantId, { reasonCode: "WORK_COMPLETE" }, { key }), 200).data;
  assert.deepEqual([done.grantId, done.state, done.refreshRevoked, done.residualBearerLifetimeSeconds, done.version], [grant.grantId, "REVOKED", true, RESIDUAL_BEARER_SECONDS, 2]);
  assert.equal(Date.parse(done.residualBearerUntil) - Date.parse(done.revokedAt), RESIDUAL_BEARER_SECONDS * 1000);
  const row = await grantRow(grant.grantId);
  assert.deepEqual([row?.state, row?.revision, row?.revoked_by_user_id, row?.revoke_reason, row?.expires_at.toISOString()], ["REVOKED", 2, corp.userId, "WORK_COMPLETE", grant.expiresAt]);
  assert.equal((await w.journal(key))?.state, "COMMITTED");
  assert.deepEqual((await w.securityEvents("CMD055")).slice(facts).map((f) => [f.outcome, f.reason]), [["ALLOW", "ACCESS_REVOKED"]]);
  assert.equal(outcome(w, await preview(grant.grantId, s.tableId)), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_NOT_ACTIVE");
  assert.equal(await accessCount(grant.grantId), 1, "the earlier read stays recorded, nothing after the revocation");

  const t = await scope("revoke-other-owner");
  const held = await opened(t);
  served<BreakglassRevocationView>(await revoke(held.grantId, { reasonCode: "SECURITY_REVIEW" }, { token: corp2.token }), 200);
  assert.equal((await grantRow(held.grantId))?.revoked_by_user_id, corp2.userId);
});

test("CMD055-DENY: no credential, an agency OWNER or a seller cannot revoke; an unknown grant is 404; a revoked grant is not revoked again and an expired one is not revoked at all (its record kept); a malformed reason is 400 — and no answer ever claims a zero residual bearer lifetime", async () => {
  const s = await scope("revoke-deny");
  const grant = await opened(s);
  assert.equal(outcome(w, await revoke(grant.grantId, undefined, { token: null })), "401 AUTHENTICATION_REQUIRED -");
  assert.equal(outcome(w, await revoke(grant.grantId, undefined, { token: w.owner.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.equal(outcome(w, await revoke(grant.grantId, undefined, { token: w.stranger.token })), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.equal(outcome(w, await revoke(ids.next())), "404 NOT_FOUND -");
  assert.equal((await revoke(grant.grantId, { reasonCode: "lower case" })).status, 400);
  assert.equal((await revoke(grant.grantId, { reasonCode: "WORK_COMPLETE", residualBearerLifetimeSeconds: 0 })).status, 400, "a caller cannot state a residual lifetime");
  assert.equal((await grantRow(grant.grantId))?.state, "ACTIVE", "nothing revoked by a refusal");

  const done = await revoke(grant.grantId);
  const view = served<BreakglassRevocationView>(done, 200).data;
  assert.ok(view.residualBearerLifetimeSeconds > 0 && view.residualBearerLifetimeSeconds <= RESIDUAL_BEARER_SECONDS, "a bounded, non-zero residual lifetime");
  assert.ok(!/"residualBearerLifetimeSeconds":0[,}]/.test(done.text));
  const again = await revoke(grant.grantId);
  assert.equal(outcome(w, again), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_NOT_ACTIVE");
  assert.deepEqual(asProblem(w, again).current, { version: 2, state: "REVOKED" });

  const e = await scope("revoke-expired");
  const expired = await opened(e);
  await ageGrant(expired.grantId, BREAKGLASS_SECONDS + 60);
  assert.equal(outcome(w, await revoke(expired.grantId)), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_EXPIRED");
  assert.deepEqual([(await grantRow(expired.grantId))?.state, (await grantRow(expired.grantId))?.revoked_at], ["ACTIVE", null], "the expired record is kept as it was");
});

test("CMD055-RACE: an identical retry replays the 200; two revocations of one grant yield one revocation and one 409 BREAKGLASS_GRANT_NOT_ACTIVE with the wait observed; a revocation held at the grant lock against a preview read under the grant, both orders — read first completes, revoke first refuses (GAP-BG-1); a crash before COMMIT leaves the grant live and the retry revokes it once; a lock wait past the statement bound is CAPACITY_UNAVAILABLE and revokes nothing", async () => {
  const s = await scope("revoke-race");
  const grant = await opened(s);
  const key = freshKey("cmd055-race");
  const first = await revoke(grant.grantId, { reasonCode: "WORK_COMPLETE" }, { key });
  served<BreakglassRevocationView>(first, 200);
  const replay = await revoke(grant.grantId, { reasonCode: "WORK_COMPLETE" }, { key });
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(outcome(w, await revoke(grant.grantId, { reasonCode: "OTHER_REASON" }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");

  // two revocations: the first holds the grant row until its commit; the second waits, then reads REVOKED
  const t = await scope("revoke-race-two");
  const g2 = await opened(t);
  const hold = w.holds.arm("journal.commit");
  const winner = revoke(g2.grantId);
  await hold.reached;
  const loser = revoke(g2.grantId, { reasonCode: "SECOND_REVOKER" });
  try {
    await waitForApiLockWait(w, "FROM kauro.breakglass_grants");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  served<BreakglassRevocationView>(won, 200);
  assert.equal(outcome(w, lost), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_NOT_ACTIVE");
  assert.equal((await grantRow(g2.grantId))?.revoke_reason, "WORK_COMPLETE", "one revocation");

  // revoke first: the revocation holds the grant row; the read waits on it and, once the revocation commits, is refused with no row released
  const r1 = await scope("revoke-first");
  const g3 = await opened(r1);
  const revokeHold = w.holds.arm("journal.commit");
  const revoking = revoke(g3.grantId);
  await revokeHold.reached;
  const reading = preview(g3.grantId, r1.tableId);
  try {
    await waitForApiLockWait(w, "FROM kauro.breakglass_grants");
  } finally {
    revokeHold.release();
  }
  const [revoked, refusedRead] = await Promise.all([revoking, reading]);
  served<BreakglassRevocationView>(revoked, 200);
  assert.equal(outcome(w, refusedRead), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_NOT_ACTIVE");
  assert.ok(!refusedRead.text.includes(`${r1.seed}0@example.com`), "no customer value left with the refusal");
  assert.equal(await accessCount(g3.grantId), 0);

  // read first: the read holds the grant FOR SHARE through its release (held behind the superuser's lock on the access record); the revocation
  // waits on it, the read completes with its rows, then the revocation lands
  const r2 = await scope("read-first");
  const g4 = await opened(r2);
  const gate = await holding("LOCK TABLE kauro.breakglass_accesses IN SHARE MODE", []);
  let readFirst: Reply;
  let revokeAfter: Reply;
  try {
    const read = preview(g4.grantId, r2.tableId);
    await waitForApiLockWait(w, "INSERT INTO kauro.breakglass_accesses");
    const revoker = revoke(g4.grantId);
    await waitForApiLockWait(w, "FROM kauro.breakglass_grants");
    await gate.end();
    [readFirst, revokeAfter] = await Promise.all([read, revoker]);
  } catch (e) {
    await gate.end().catch(() => undefined);
    throw e;
  }
  const rowsRead = dataOf<BreakglassPreviewView>(readFirst);
  assert.deepEqual(rowsRead.rows[1], [`${r2.seed}0@example.com`, `${r2.seed} 0`], "the read that held the grant first completes");
  served<BreakglassRevocationView>(revokeAfter, 200);
  assert.equal(await accessCount(g4.grantId), 1);
  assert.equal(outcome(w, await preview(g4.grantId, r2.tableId)), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_NOT_ACTIVE");

  // CRASH-BEFORE: revoked and never committed — the grant is still live and still reads; the retry with the same key revokes it once
  const c = await scope("revoke-crash");
  const g5 = await opened(c);
  const crashKey = freshKey("cmd055-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(w, await revoke(g5.grantId, undefined, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.equal((await grantRow(g5.grantId))?.state, "ACTIVE");
  dataOf<BreakglassPreviewView>(await preview(g5.grantId, c.tableId));
  served<BreakglassRevocationView>(await revoke(g5.grantId, undefined, { key: crashKey }), 200);
  assert.deepEqual([(await grantRow(g5.grantId))?.state, (await grantRow(g5.grantId))?.revision], ["REVOKED", 2]);

  // TIMEOUT: a revocation whose wait on the grant row outlives the statement bound is refused retryable; nothing is revoked
  const o = await scope("revoke-timeout");
  const g6 = await opened(o);
  const blocker = await holding("SELECT 1 FROM kauro.breakglass_grants WHERE grant_id = $1 FOR UPDATE", [g6.grantId]);
  let timedOut: Reply;
  try {
    timedOut = await revoke(g6.grantId);
  } finally {
    await blocker.end();
  }
  assert.equal(outcome(w, timedOut), "503 CAPACITY_UNAVAILABLE -");
  assert.equal((await grantRow(g6.grantId))?.state, "ACTIVE");
});

// --- R2-050, S071, the grant's revocation by its scope ------------------------------------------------------------------------------------

test("R2-050: renewal after the 30-min expiry is refused, a new justified grant is required, the expired record kept — the expired grant reads nothing, the same justification (even with a fresh step-up) is a renewal and is refused, a new support case opens a new grant; a read whose grant lock wait crosses expiresAt is refused (GAP-BG-2, GAP-BG-3)", async () => {
  const s = await scope("renewal");
  const grant = await opened(s);
  await ageGrant(grant.grantId, BREAKGLASS_SECONDS + 1);
  assert.equal(outcome(w, await preview(grant.grantId, s.tableId)), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_EXPIRED");
  assert.equal(await accessCount(grant.grantId), 0);
  // the database refuses the rows themselves to the expired grant's session (the policy, not only the handler)
  const visible = await asPerson(w.h, corp.userId, async (c) => {
    await c.query("SELECT set_config('kauro.breakglass_grant_id', $1, true), set_config('kauro.breakglass_project_id', $2, true)", [grant.grantId, s.projectId]);
    return Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.source_tables")).rows[0]?.n);
  });
  assert.equal(visible, 0);

  const renewal = await open(await openBody(s));
  assert.equal(outcome(w, renewal), "409 PRECONDITION_FAILED BREAKGLASS_RENEWAL_REFUSED", "the same justification is a renewal");
  const kept = await grantRow(grant.grantId);
  assert.equal(kept?.authorization_ref, s.caseId, "the expired record is kept with its justification");
  assert.notEqual(kept?.state, "REVOKED");

  const fresh = await supportCase(s, "renewal-new");
  const second = await opened(s, { authorizationRef: fresh, purpose: "New support question" });
  assert.notEqual(second.grantId, grant.grantId);
  assert.deepEqual((await grantsOf(s.projectId)).map((g) => [g.grant_id, g.authorization_ref]), [[grant.grantId, s.caseId], [second.grantId, fresh]], "both records kept, each with its own justification");
  dataOf<BreakglassPreviewView>(await preview(second.grantId, s.tableId));

  // a read whose wait on the grant lock crosses expiresAt: the holder moves the expiry 300 ms ahead while the read waits, then commits after it
  const x = await scope("renewal-crossing");
  const crossing = await opened(x);
  const holder = await holding("SELECT 1 FROM kauro.breakglass_grants WHERE grant_id = $1 FOR UPDATE", [crossing.grantId]);
  let crossed: Reply;
  try {
    const read = preview(crossing.grantId, x.tableId);
    await waitForApiLockWait(w, "FROM kauro.breakglass_grants");
    await holder.client.query("SET LOCAL session_replication_role = replica");
    const moved = await holder.client.query<{ wait_ms: string }>(
      "UPDATE kauro.breakglass_grants SET expires_at = clock_timestamp() + interval '300 milliseconds', opened_at = clock_timestamp() + interval '300 milliseconds' - interval '1800 seconds' WHERE grant_id = $1 RETURNING (extract(epoch FROM expires_at - clock_timestamp()) * 1000 + 50)::text AS wait_ms",
      [crossing.grantId],
    );
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.ceil(Number(moved.rows[0]?.wait_ms)))));
    await holder.end();
    crossed = await read;
  } catch (e) {
    await holder.end().catch(() => undefined);
    throw e;
  }
  assert.equal(outcome(w, crossed), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_EXPIRED");
  assert.equal(await accessCount(crossing.grantId), 0);
});

test("S071: a seller, an agency OWNER on another agency and the corporate owner without a grant are refused raw CRM by URL and by DTO field; with a grant: preview only, expiring, audited", async () => {
  const s = await scope("s071");
  const seller = await w.person("s071-seller");
  await recordActiveSeller(w.h, { ownerUserId: corp.userId as UserId, subject: "s071-seller" });
  const agencyPreview = sourceRoutes.preview(s.revisionId, s.tableId);
  const getAs = (person: Person, url: string, agency: string | null = s.agencyId) => call(w, { method: "GET", url, token: person.token, key: null, contentType: null, agency });
  // by URL: the agency's own preview route answers nobody outside the agency, the corporate owner included
  for (const person of [seller, w.stranger, corp]) {
    const reply = await getAs(person, agencyPreview);
    assert.ok([403, 404].includes(reply.status), `${person.name}: ${reply.text}`);
    assert.ok(!reply.text.includes(`${s.seed}0@example.com`));
  }
  assert.ok([403, 404].includes((await getAs(w.stranger, sourceRoutes.preview(s.revisionId, s.tableId), w.B.agencyId)).status), "another agency's owner under its own agency");
  // by URL: the breakglass route without a grant of one's own
  const grant = await opened(s);
  assert.equal(outcome(w, await preview(grant.grantId, s.tableId, seller)), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.equal(outcome(w, await preview(grant.grantId, s.tableId, w.stranger)), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.equal(outcome(w, await preview(grant.grantId, s.tableId, corp2)), "404 NOT_FOUND -", "a grant is its holder's: another corporate owner reads nothing under it");
  assert.equal(outcome(w, await preview(ids.next(), s.tableId)), "404 NOT_FOUND -");
  const other = await scope("s071-other");
  assert.equal(outcome(w, await preview(grant.grantId, other.tableId)), "404 NOT_FOUND -", "a grant covers its own project's tables only");
  // by DTO field: no query widens the preview, no view carries a raw value
  assert.equal((await preview(grant.grantId, s.tableId, corp, "?limit=1000")).status, 400);
  assert.equal((await preview(grant.grantId, s.tableId, corp, "?columns=all")).status, 400);
  // the database: the corporate owner's own session sees no row of the agency without a live grant of its own
  const counts = await asPerson(w.h, corp2.userId, async (c) => {
    const plain = Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.source_files")).rows[0]?.n);
    await c.query("SELECT set_config('kauro.breakglass_grant_id', $1, true), set_config('kauro.breakglass_project_id', $2, true)", [grant.grantId, s.projectId]);
    const borrowed = Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.source_files")).rows[0]?.n);
    return [plain, borrowed];
  });
  assert.deepEqual(counts, [0, 0], "another person's grant id borrows nothing");
  const own = await asPerson(w.h, corp.userId, async (c) => {
    await c.query("SELECT set_config('kauro.breakglass_grant_id', $1, true), set_config('kauro.breakglass_project_id', $2, true)", [grant.grantId, s.projectId]);
    return (await c.query<{ project_id: string }>("SELECT DISTINCT project_id::text AS project_id FROM kauro.source_files")).rows.map((r) => r.project_id);
  });
  assert.deepEqual(own, [s.projectId], "the holder's live grant shows its one project and nothing else");

  // with the grant: a bounded preview, expiring, audited
  const reads = (await w.securityEvents("BREAKGLASS_PREVIEW")).length;
  const sample = dataOf<BreakglassPreviewView>(await preview(grant.grantId, s.tableId));
  assert.ok(sample.rows.length <= 20 && sample.rows.every((r) => r.length <= 50 && r.every((cell) => cell === null || [...cell].length <= 200)));
  assert.equal(sample.expiresAt, grant.expiresAt);
  assert.equal(await accessCount(grant.grantId), 1);
  assert.equal((await w.securityEvents("BREAKGLASS_PREVIEW")).length, reads + 1);
});

test("REVOCATION (GAP-BG-7): a grant cannot survive the closure of its support case, the deletion request of its project or the closure of its agency — each makes the grant unusable at the next read, the record kept", async () => {
  const closing = await scope("unusable-case");
  const g1 = await opened(closing);
  dataOf<BreakglassPreviewView>(await preview(g1.grantId, closing.tableId));
  await asPlatform("UPDATE kauro.support_cases SET state = 'CLOSED' WHERE case_id = $1", [closing.caseId]);
  assert.equal(outcome(w, await preview(g1.grantId, closing.tableId)), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_UNUSABLE");

  const deleting = await scope("unusable-project");
  const g2 = await opened(deleting);
  await asPlatform("UPDATE kauro.projects SET state = 'DELETION_REQUESTED' WHERE project_id = $1", [deleting.projectId]);
  assert.equal(outcome(w, await preview(g2.grantId, deleting.tableId)), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_UNUSABLE");

  // the agency's closure, last: agency A is closed for the rest of this file (this is its last test)
  const agency = await scope("unusable-agency");
  const g3 = await opened(agency);
  dataOf<BreakglassPreviewView>(await preview(g3.grantId, agency.tableId));
  await asPlatform("UPDATE kauro.agencies SET state = 'CLOSED' WHERE agency_id = $1", [agency.agencyId]);
  assert.equal(outcome(w, await preview(g3.grantId, agency.tableId)), "409 PRECONDITION_FAILED BREAKGLASS_GRANT_UNUSABLE");
  for (const g of [g1, g2, g3]) assert.equal((await grantRow(g.grantId))?.state, "ACTIVE", "the record is kept; only its use ends");
  assert.deepEqual([await accessCount(g1.grantId), await accessCount(g2.grantId), await accessCount(g3.grantId)], [1, 0, 1]);
});
