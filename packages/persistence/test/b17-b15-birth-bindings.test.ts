// The database births of lane L0D KIT-DB (migrations 0072, 0073, 0074; docs/design/B15-B17-B18-local-plan.md section 5 M1, M4 (a)-(e),
// M5, M6, M17): every refusal is the runtime role that would cross the boundary, with the credentials already emitted to it, beside
// the legitimate write that still commits (21 "Positive and negative symmetry", FAILURE-MATRIX-TEMPLATE r20, r24b). Each refusal has
// its red control (r24c, one guard per control input): the same forged statement, as the same role, commits once that one guard is
// dropped inside a transaction the oracle rolls back (`withoutGuard`), so the refusal is the guard's and no other's.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { COMMERCE_EVENT_SUBSCRIPTIONS, type MembershipId, type UserId } from "@kauro/domain";
import { start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import {
  PAYMENT_SERVICE,
  activateAgency,
  approvedSubject,
  commerceEvent,
  createdOrder,
  fiscalProfile,
  grantKauroOwner,
  issuedQuote,
  observedCapture,
  qualifiedRoutes,
  service,
  within,
  type Routes,
} from "./commerce-support.js";
import { constraintOf, event, ids, plan, planBody, project, sealedSource, sha, sqlState, targetContract, tx } from "./support.js";

let h: Harness;
let app: Client;
let control: Client;
let validator: Client;
let assurance: Client;
let payment: Client;
let kora: UserId;
let viewer: UserId;
let viewerMembership: MembershipId;
let A: AgencyFixture;
let routes: Routes;
let clean: string;
let hubspot: string;
let clientA: string;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  validator = await h.pg.connect("kauro_validator_test");
  assurance = await h.pg.connect("kauro_assurance_test");
  payment = await h.pg.connect("kauro_payment_test");
  kora = await h.person("kora-births");
  viewer = await h.person("viewer-births");
  clean = await h.offeredCapability("CLEAN");
  hubspot = await h.offeredCapability("HUBSPOT");
  routes = await qualifiedRoutes(control);
  await grantKauroOwner(control, kora);
  const owner = await h.person("owner-births");
  A = await h.createAgency(owner, "Births A");
  await activateAgency(app, A);
  viewerMembership = await h.addMember(A, viewer, "VIEWER");
  clientA = await h.endClient(A, await h.processingAuthority(A), "Births client");
});
after(async () => {
  for (const c of [app, control, validator, assurance, payment]) await c.end();
  await h.stop();
});

const refusedWith = (code: string, pattern?: RegExp | string) => (e: unknown): boolean =>
  sqlState(e) === code &&
  (pattern === undefined || (typeof pattern === "string" ? constraintOf(e) === pattern : pattern.test(e instanceof Error ? e.message : String(e))));
const owner = () => ({ agencyId: A.agencyId, userId: A.ownerUserId });
const clients = () => ({ app, control });

interface Forged {
  /** the runtime role the forged statement runs as (a login role the harness emits) */
  readonly role: "kauro_app_test" | "kauro_control_test" | "kauro_payment_test";
  /** the session context of that role (kauro.agency_id, kauro.user_id, ...) */
  readonly settings: Readonly<Record<string, string>>;
  /** world state the oracle arranges before the role switch (the same transaction; rolled back with it) */
  readonly setup?: (o: Client) => Promise<unknown>;
  /** the one guard the red control removes (DDL), none for the refusal itself */
  readonly drop?: string;
  /** read after RESET ROLE, inside the same transaction (locks, rows) */
  readonly inspect?: (o: Client) => Promise<unknown>;
}

/**
 * Runs `forged` as `f.role` inside one oracle transaction that is always rolled back: the refusal (no `drop`) rethrows the
 * database's error; the red control (`drop` given) proves the forged statement commits-in-place once the guard is gone.
 */
async function attempt<T>(f: Forged, forged: (o: Client) => Promise<unknown>): Promise<T | undefined> {
  const o = h.oracle;
  await o.query("BEGIN");
  try {
    if (f.drop !== undefined) await o.query(f.drop);
    if (f.setup !== undefined) await f.setup(o);
    await o.query(`SET LOCAL ROLE ${f.role}`);
    for (const [k, v] of Object.entries(f.settings)) await o.query("SELECT set_config($1, $2, true)", [k, v]);
    await forged(o);
    await o.query("RESET ROLE");
    return f.inspect === undefined ? undefined : ((await f.inspect(o)) as T);
  } finally {
    await o.query("ROLLBACK");
  }
}

/** The refusal and its red control: refused as is; commits in place with exactly `drop` removed. */
async function deniedByGuard(f: Forged & { readonly drop: string }, forged: (o: Client) => Promise<unknown>, code: string, pattern?: RegExp | string): Promise<void> {
  const { drop, ...refusal } = f;
  await assert.rejects(attempt(refusal, forged), refusedWith(code, pattern), `refused: ${String(pattern ?? code)}`);
  await assert.doesNotReject(attempt(f, forged), `red control: the forged statement passes once "${drop}" is removed`);
}

/** The advisory transition locks this session holds on (kind, subject) (pg_locks; a bigint key is objsubid 1). */
async function lockModes(o: Client, kind: string, subject: string): Promise<string[]> {
  const r = await o.query<{ mode: string }>(
    `SELECT l.mode FROM pg_locks l, (SELECT kauro.transition_key($1, $2) AS k) t
      WHERE l.pid = pg_backend_pid() AND l.locktype = 'advisory' AND l.objsubid = 1
        AND l.classid = ((t.k >> 32) & 4294967295)::oid AND l.objid = (t.k & 4294967295)::oid ORDER BY l.mode`,
    [kind, subject],
  );
  return r.rows.map((x) => x.mode);
}

const appSession = (userId: string = A.ownerUserId) => ({ "kauro.agency_id": A.agencyId, "kauro.user_id": userId });

// --- 0073 target contracts -------------------------------------------------------------------------------------------------------------

async function currentInstance(projectId: string): Promise<string | undefined> {
  const r = await h.oracle.query<{ instance_id: string }>(
    "SELECT instance_id FROM kauro.target_contracts WHERE agency_id = $1 AND project_id = $2 AND confirmed_at IS NOT NULL AND superseded_at IS NULL",
    [A.agencyId, projectId],
  );
  return r.rows[0]?.instance_id;
}

const contractInsert = `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, confirmed_by_membership_id, confirmation_evidence_ref, superseded_at, superseded_by_contract_id, authority_evidence_hash, capability_version, created_at)
  VALUES ($1, $2, $3, 'CLEAN', $4, $5, 'R2-INITIAL', '[]'::jsonb, $6, $7, now() + make_interval(secs => $8), $9, $10, $11, $12, $13, $14, 'R2-INITIAL', now())`;

interface ContractRow {
  readonly contractId: string;
  readonly bodyHash: string;
}

function contractParams(projectId: string, instanceId: string, extra: { offsetSeconds?: number; confirmedAt?: string | null; membership?: string | null; evidence?: string | null; supersededAt?: string | null; supersededBy?: string | null } = {}): { row: ContractRow; params: unknown[] } {
  const contractId = ids.next();
  const bodyHash = sha(`births-target-${contractId}`);
  return {
    row: { contractId, bodyHash },
    params: [contractId, A.agencyId, projectId, instanceId, ids.next(), sha("bundle"), bodyHash, extra.offsetSeconds ?? 0, extra.confirmedAt ?? null, extra.membership ?? null, extra.evidence ?? null, extra.supersededAt ?? null, extra.supersededBy ?? null, sha(`authority-${contractId}`)],
  };
}

/** A confirmation evidence artifact of the instance, as the request session records it before CMD019 confirms. */
async function evidence(c: Client, projectId: string, instanceId: string): Promise<string> {
  const evidenceId = ids.next();
  await c.query(
    `INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id)
     VALUES ($1, $2, $3, 'CONFIRMATION_EVIDENCE', 'CLEAN', $4, '{}'::jsonb, $5, $6)`,
    [evidenceId, A.agencyId, projectId, instanceId, sha(`confirmation-${evidenceId}`), A.ownerMembershipId],
  );
  return evidenceId;
}

/** A DRAFT contract of the instance, born by the request session (0073 (a)); observed `offsetSeconds` after its transaction's now(). */
async function draftContract(projectId: string, instanceId: string, offsetSeconds = 0): Promise<ContractRow> {
  const { row, params } = contractParams(projectId, instanceId, { offsetSeconds });
  await tx(app, owner(), (c) => c.query(contractInsert, params));
  return row;
}

const confirmSql = "UPDATE kauro.target_contracts SET confirmed_at = kauro.server_now(), confirmed_by_membership_id = $2, confirmation_evidence_ref = $3, version = version + 1 WHERE contract_id = $1";
const supersedeSql = "UPDATE kauro.target_contracts SET superseded_at = now(), superseded_by_contract_id = $2, version = version + 1 WHERE contract_id = $1";

test("0073 (a): the request session bears a target contract only as a DRAFT — never confirmed, never superseded at birth", async () => {
  const { projectId } = await project(app, A, clientA, clean);
  const instanceId = ids.next();
  const ev = await tx(app, owner(), (c) => evidence(c, projectId, instanceId));
  const confirmed = contractParams(projectId, instanceId, { confirmedAt: new Date().toISOString(), membership: A.ownerMembershipId, evidence: ev });
  const drop = "DROP POLICY target_contracts_tenant_birth_draft ON kauro.target_contracts";
  await deniedByGuard({ role: "kauro_app_test", settings: appSession(), drop }, (o) => o.query(contractInsert, confirmed.params), "42501", /row-level security/);
  // a superseded birth (the superseder exists and is confirmed: only the birth policy refuses)
  const current = await targetContract(app, A, projectId, "births-a");
  const superseded = contractParams(projectId, (await currentInstance(projectId))!, { offsetSeconds: -60, confirmedAt: new Date().toISOString(), membership: A.ownerMembershipId, evidence: ev, supersededAt: new Date().toISOString(), supersededBy: current.contractId });
  await assert.rejects(attempt({ role: "kauro_app_test", settings: appSession() }, (o) => o.query(contractInsert, superseded.params)), refusedWith("42501", /row-level security/));
  // OK siblings: the draft commits; the oracle's confirmed fixture rows stay possible (the policy is the request session's only)
  const draft = await draftContract(projectId, (await currentInstance(projectId))!);
  assert.equal((await h.oracle.query("SELECT confirmed_at FROM kauro.target_contracts WHERE contract_id = $1", [draft.contractId])).rows[0]!.confirmed_at, null);
  const other = await project(app, A, clientA, clean);
  const oracleRow = contractParams(other.projectId, ids.next(), { confirmedAt: new Date().toISOString(), membership: A.ownerMembershipId });
  await h.oracle.query("BEGIN");
  try {
    oracleRow.params[10] = await evidence(h.oracle, other.projectId, String(oracleRow.params[3]));
    await h.oracle.query(contractInsert, oracleRow.params);
  } finally {
    await h.oracle.query("ROLLBACK");
  }
});

test("0073 (b)/(c): supersession is learned once, together, by a later confirmed observation of the same instance, confirmed in the same transaction; one current contract per project", async () => {
  const { projectId } = await project(app, A, clientA, clean);
  const first = await targetContract(app, A, projectId, "births-b");
  const instanceId = (await currentInstance(projectId))!;
  const later = await draftContract(projectId, instanceId, 60);
  const earlier = await draftContract(projectId, instanceId, -3600);
  const elsewhere = await draftContract(projectId, ids.next(), 60);
  const trig = "DROP TRIGGER target_contracts_supersession ON kauro.target_contracts";
  const s = { role: "kauro_app_test" as const, settings: appSession() };
  // the instant without its superseder (and the superseder without its instant): the trigger and the whole-pair CHECK each refuse
  await deniedByGuard(
    { ...s, drop: `${trig}; ALTER TABLE kauro.target_contracts DROP CONSTRAINT target_contracts_supersession_whole` },
    (o) => o.query("UPDATE kauro.target_contracts SET superseded_at = now(), version = version + 1 WHERE contract_id = $1", [first.contractId]),
    "23514",
    /together/,
  );
  await assert.rejects(
    attempt({ ...s, drop: trig }, (o) => o.query("UPDATE kauro.target_contracts SET superseded_at = now(), version = version + 1 WHERE contract_id = $1", [first.contractId])),
    refusedWith("23514", "target_contracts_supersession_whole"),
  );
  await deniedByGuard({ ...s, drop: trig }, (o) => o.query(supersedeSql, [first.contractId, earlier.contractId]), "23514", /later observation/);
  await deniedByGuard({ ...s, drop: trig }, (o) => o.query(supersedeSql, [first.contractId, elsewhere.contractId]), "23514", /later observation/);
  // a DRAFT is never superseded
  await deniedByGuard({ ...s, drop: trig }, (o) => o.query(supersedeSql, [earlier.contractId, later.contractId]), "23514", /only a confirmed/);
  // the superseder not confirmed in this transaction: refused at COMMIT (deferred), and at once when the constraints are made immediate
  await assert.rejects(tx(app, owner(), (c) => c.query(supersedeSql, [first.contractId, later.contractId])), refusedWith("23514", /confirmed in the same transaction/));
  await deniedByGuard(
    { ...s, drop: "DROP TRIGGER target_contracts_superseder_confirmed ON kauro.target_contracts" },
    async (o) => {
      await o.query(supersedeSql, [first.contractId, later.contractId]);
      await o.query("SET CONSTRAINTS ALL IMMEDIATE");
    },
    "23514",
    /confirmed in the same transaction/,
  );
  // (c) a second current contract: confirming `later` without superseding `first`
  await deniedByGuard(
    { ...s, drop: "DROP INDEX kauro.target_contracts_one_current" },
    async (o) => o.query(confirmSql, [later.contractId, A.ownerMembershipId, await evidence(o, projectId, instanceId)]),
    "23505",
    "target_contracts_one_current",
  );
  // OK: CMD019's shape — supersede the current contract and confirm the superseder in one transaction
  await tx(app, owner(), async (c) => {
    await c.query(supersedeSql, [first.contractId, later.contractId]);
    await c.query(confirmSql, [later.contractId, A.ownerMembershipId, await evidence(c, projectId, instanceId)]);
  });
  const rows = await h.oracle.query<{ superseded_by_contract_id: string; same: boolean }>(
    "SELECT o.superseded_by_contract_id, o.superseded_at = n.confirmed_at AS same FROM kauro.target_contracts o JOIN kauro.target_contracts n ON n.contract_id = o.superseded_by_contract_id WHERE o.contract_id = $1",
    [first.contractId],
  );
  assert.deepEqual(rows.rows[0], { superseded_by_contract_id: later.contractId, same: true }, "superseded at the database's instant of the confirming transaction");
  // learned once: never re-pointed, never cleared
  const third = await draftContract(projectId, instanceId, 120);
  await deniedByGuard({ ...s, drop: trig }, (o) => o.query(supersedeSql, [first.contractId, third.contractId]), "23514", /superseded once/);
  await deniedByGuard(
    { ...s, drop: trig },
    (o) => o.query("UPDATE kauro.target_contracts SET superseded_at = superseded_at + interval '1 second', version = version + 1 WHERE contract_id = $1", [first.contractId]),
    "23514",
    /superseded once/,
  );
});

/** A plan born by the request session with its creation event (body: planBody with the given subjects, or `body`). */
const planInsert = `INSERT INTO kauro.plans (plan_id, agency_id, project_id, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, recheck_of_plan_id, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now(), now())`;

function planParams(projectId: string, revisionHash: string, targetHash: string, opts: { recheckOf?: string; policy?: string } = {}): { planId: string; params: unknown[] } {
  const planId = ids.next();
  const policy = opts.policy ?? sha("policy");
  return { planId, params: [planId, A.agencyId, projectId, revisionHash, targetHash, policy, JSON.stringify(planBody(revisionHash, targetHash, policy)), sha(`births-plan-${planId}`), A.ownerMembershipId, opts.recheckOf ?? null] };
}

async function bornPlan(c: Client, p: { planId: string; params: unknown[] }, projectId: string): Promise<void> {
  await c.query(planInsert, p.params);
  await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "plan.created.v1", actorUserId: A.ownerUserId, payload: { planId: p.planId, agencyId: A.agencyId, projectId, bodyHash: p.params[7] } });
}

test("0073 (d)/(e): a plan is born only on a target that is not superseded, after the target's shared half; a re-check plan re-checks its own project's plan of the superseded target with only targetContractHash replaced", async () => {
  const { projectId } = await project(app, A, clientA, clean);
  const other = await project(app, A, clientA, clean);
  const revision = (await sealedSource(clients(), A, projectId, "births-d")).manifestHash;
  const c1 = await targetContract(app, A, projectId, "births-d1");
  const p0 = planParams(projectId, revision, c1.bodyHash);
  await tx(app, owner(), (c) => bornPlan(c, p0, projectId));
  const c2 = await targetContract(app, A, projectId, "births-d2");
  const s = { role: "kauro_app_test" as const, settings: appSession() };
  // (d) a plan on the superseded c1
  await deniedByGuard({ ...s, drop: "DROP TRIGGER plans_target_not_superseded ON kauro.plans" }, (o) => o.query(planInsert, planParams(projectId, revision, c1.bodyHash).params), "23514", /TARGET_STALE/);
  // OK: a plan on the current c2, judged after the shared half of c2 (the half CMD019's confirmation holds exclusively)
  const modes = await attempt<string[]>({ ...s, inspect: (o) => lockModes(o, "kauro.target_contracts", c2.contractId) }, (o) => o.query(planInsert, planParams(projectId, revision, c2.bodyHash).params));
  assert.deepEqual(modes, ["ShareLock"], "the plan birth awaits the target's transition half");
  const unlocked = await attempt<string[]>({ ...s, drop: "DROP TRIGGER plans_target_not_superseded ON kauro.plans", inspect: (o) => lockModes(o, "kauro.target_contracts", c2.contractId) }, (o) =>
    o.query(planInsert, planParams(projectId, revision, c2.bodyHash).params),
  );
  assert.deepEqual(unlocked, [], "red control: without the guard the birth is not ordered with the confirmation");
  // (e) the re-check of p0 on c2
  const recheckDrop = "DROP TRIGGER plans_recheck_birth ON kauro.plans";
  await deniedByGuard({ ...s, drop: recheckDrop }, (o) => o.query(planInsert, planParams(projectId, revision, c2.bodyHash, { recheckOf: p0.planId, policy: sha("another-policy") }).params), "23514", /only targetContractHash replaced/);
  const otherPlan = planParams(other.projectId, (await sealedSource(clients(), A, other.projectId, "births-e")).manifestHash, (await targetContract(app, A, other.projectId, "births-e")).bodyHash);
  await tx(app, owner(), (c) => bornPlan(c, otherPlan, other.projectId));
  await deniedByGuard({ ...s, drop: recheckDrop }, (o) => o.query(planInsert, planParams(projectId, revision, c2.bodyHash, { recheckOf: otherPlan.planId }).params), "23514", /own project/);
  const recheck = planParams(projectId, revision, c2.bodyHash, { recheckOf: p0.planId });
  await tx(app, owner(), (c) => bornPlan(c, recheck, projectId));
  await assert.rejects(tx(app, owner(), (c) => bornPlan(c, planParams(projectId, revision, c2.bodyHash, { recheckOf: p0.planId }), projectId)), refusedWith("23505", "plans_recheck_once"));
  // the re-check of p0 names the contract that superseded p0's target, not a later one
  const c3 = await targetContract(app, A, projectId, "births-d3");
  await deniedByGuard({ ...s, drop: recheckDrop }, (o) => o.query(planInsert, planParams(projectId, revision, c3.bodyHash, { recheckOf: p0.planId }).params), "23514", /superseded the re-checked/);
  // learned at birth only
  await deniedByGuard(
    { ...s, drop: "DROP TRIGGER plans_recheck_immutable ON kauro.plans" },
    (o) => o.query("UPDATE kauro.plans SET recheck_of_plan_id = NULL, version = version + 1 WHERE plan_id = $1", [recheck.planId]),
    "KA004",
    /recheck_of_plan_id/,
  );
});

// --- 0073 plan validation refusal reason; vendor qualifications ---------------------------------------------------------------------------

test("0073: a refusal reason is learned once, only by the ERROR settlement of its intent, and is never born with the intent", async () => {
  const { projectId } = await project(app, A, clientA, clean);
  const p = await plan(clients(), A, projectId, "VALIDATION_REQUIRED", "births-refusal");
  const validationId = ids.next();
  const intent = [validationId, A.agencyId, p.planId, p.bodyHash, p.revisionHash, p.targetContractHash, A.ownerMembershipId];
  const insertWithReason = `INSERT INTO kauro.plan_validations (validation_id, agency_id, plan_id, plan_hash, revision_hash, target_contract_hash, fence, origin, requested_by_membership_id, refusal_reason)
    VALUES ($1, $2, $3, $4, $5, $6, 1, 'COMMAND', $7, 'IMPORTER_PROFILE_DRIFT')`;
  // the request session holds no privilege on the column (the guard of its INSERT); the birth trigger is the second, for any writer
  await assert.rejects(attempt({ role: "kauro_app_test", settings: appSession() }, (o) => o.query(insertWithReason, intent)), refusedWith("42501", /permission denied/));
  // with the privilege granted the birth trigger refuses; with both removed the forged birth passes
  const grant = "GRANT INSERT (refusal_reason) ON kauro.plan_validations TO kauro_app";
  await deniedByGuard(
    { role: "kauro_app_test", settings: appSession(), setup: (o) => o.query(grant), drop: "DROP TRIGGER plan_validations_refusal_once ON kauro.plan_validations" },
    (o) => o.query(insertWithReason, intent),
    "23514",
    /born without a refusal reason/,
  );
  await tx(app, owner(), (c) =>
    c.query(
      `INSERT INTO kauro.plan_validations (validation_id, agency_id, plan_id, plan_hash, revision_hash, target_contract_hash, fence, origin, requested_by_membership_id)
       VALUES ($1, $2, $3, $4, $5, $6, 1, 'COMMAND', $7)`,
      intent,
    ),
  );
  const ctl = { role: "kauro_control_test" as const, settings: { "kauro.agency_id": A.agencyId } };
  // only with ERROR
  await deniedByGuard(
    { ...ctl, drop: "ALTER TABLE kauro.plan_validations DROP CONSTRAINT plan_validations_refusal_only_error" },
    (o) => o.query("UPDATE kauro.plan_validations SET result = 'CANCELLED', refusal_reason = 'IMPORTER_PROFILE_DRIFT' WHERE validation_id = $1", [validationId]),
    "23514",
    "plan_validations_refusal_only_error",
  );
  // OK: the ERROR settlement carries its reason
  await tx(control, { agencyId: A.agencyId }, (c) => c.query("UPDATE kauro.plan_validations SET result = 'ERROR', refusal_reason = 'IMPORTER_PROFILE_DRIFT' WHERE validation_id = $1", [validationId]));
  // never re-learned after the settlement
  await deniedByGuard(
    { ...ctl, drop: "DROP TRIGGER plan_validations_refusal_once ON kauro.plan_validations" },
    (o) => o.query("UPDATE kauro.plan_validations SET refusal_reason = 'DIGEST_MISMATCH' WHERE validation_id = $1", [validationId]),
    "23514",
    /learned once/,
  );
});

test("0073: no runtime role inserts a vendor qualification (insert-only evidence, D-12 produces it)", async () => {
  const row = [sha(`vq-${ids.next()}`), clean, sha("vq-profile")];
  const insert = "INSERT INTO kauro.vendor_qualifications (evidence_hash, capability_id, tool, profile_hash, envelope, result) VALUES ($1, $2, 'Data Loader', $3, '{}'::jsonb, 'PASS')";
  for (const [role, settings, policy] of [
    ["kauro_app_test", appSession(), "kauro_app"],
    ["kauro_control_test", {}, "kauro_control"],
    ["kauro_payment_test", {}, "kauro_payment"],
  ] as const) {
    await deniedByGuard(
      { role, settings, drop: `GRANT INSERT ON kauro.vendor_qualifications TO ${policy}; CREATE POLICY births_red ON kauro.vendor_qualifications FOR INSERT TO ${policy} WITH CHECK (true)` },
      (o) => o.query(insert, row),
      "42501",
    );
  }
});

// --- 0072 stage receipt reconciliations and parent edges ----------------------------------------------------------------------------------

test("0072: a differing receipt of a finalized stage opens one reconciliation naming its own stage-receipt upload; identical content and unfinished stages never do", async () => {
  const { projectId } = await project(app, A, clientA, clean);
  const p = await plan(clients(), A, projectId, "DRAFT", "births-stage");
  const o = h.oracle;
  const instanceId = ids.next();
  const stage = async (state: string, extra: { parents?: string[]; sources?: string[]; edges?: unknown[] } = {}): Promise<string> => {
    const stageId = ids.next();
    await o.query(
      `INSERT INTO kauro.import_stages (stage_id, agency_id, project_id, plan_id, sequence, object_api_name, operation, state, parent_stage_ids, package_hash, receipt_required, expires_at, instance_id, source_ids, parent_edges)
       VALUES ($1, $2, $3, $4, 0, 'Contact', 'UPSERT', $5, $6::jsonb, $7, true, now() + interval '7 days', $8, $9::jsonb, $10::jsonb)`,
      [stageId, A.agencyId, projectId, p.planId, state, JSON.stringify(extra.parents ?? []), sha(`package-${stageId}`), instanceId, JSON.stringify(extra.sources ?? ["s1"]), JSON.stringify(extra.edges ?? [])],
    );
    return stageId;
  };
  const upload = async (kind: string, contentHash: string, instance = instanceId): Promise<string> => {
    const artifactId = ids.next();
    await o.query(
      `INSERT INTO kauro.target_artifacts (artifact_id, agency_id, project_id, kind, mode, instance_id, document, content_hash, created_by_membership_id)
       VALUES ($1, $2, $3, $4, 'CLEAN', $5, '{}'::jsonb, $6, $7)`,
      [artifactId, A.agencyId, projectId, kind, instance, contentHash, A.ownerMembershipId],
    );
    return artifactId;
  };
  const verified = await stage("VERIFIED_SUCCESS");
  const held = sha("receipt-held");
  const heldUpload = await upload("STAGE_RECEIPT", held);
  await o.query(
    `INSERT INTO kauro.stage_receipts (receipt_id, agency_id, project_id, stage_id, revision, instance_id, source_package_hash, receipt_upload_ref, receipt_file_hash, identity_mapping_hash, matched_rows, failed_rows, unresolved_rows, result, mapping, validator_version, submitted_by_membership_id)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, 0, 0, 0, 'COMPLETE', '[]'::jsonb, 'v1', $10)`,
    [ids.next(), A.agencyId, projectId, verified, instanceId, sha("package"), heldUpload, held, sha("mapping"), A.ownerMembershipId],
  );
  const differing = sha("receipt-differing");
  const differingUpload = await upload("STAGE_RECEIPT", differing);
  const insert = "INSERT INTO kauro.stage_receipt_reconciliations (reconciliation_id, agency_id, project_id, stage_id, content_hash, receipt_upload_ref, opened_by_membership_id) VALUES ($1, $2, $3, $4, $5, $6, $7)";
  const open = (stageId: string, hash: string, uploadRef: string, membership: string = A.ownerMembershipId) => (c: Client) => c.query(insert, [ids.next(), A.agencyId, projectId, stageId, hash, uploadRef, membership]);
  const s = { role: "kauro_app_test" as const, settings: appSession() };
  const birth = "DROP TRIGGER stage_receipt_reconciliations_birth ON kauro.stage_receipt_reconciliations";
  const unfinished = await stage("RECEIPT_UPLOADED");
  await deniedByGuard({ ...s, drop: birth }, open(unfinished, differing, differingUpload), "23514", /finalized stage/);
  await deniedByGuard({ ...s, drop: birth }, open(verified, differing, await upload("METADATA", differing)), "23514", /stage-receipt upload/);
  await deniedByGuard({ ...s, drop: birth }, open(verified, sha("receipt-other"), differingUpload), "23514", /stage-receipt upload/);
  await deniedByGuard({ ...s, drop: birth }, open(verified, differing, await upload("STAGE_RECEIPT", differing, ids.next())), "23514", /stage-receipt upload/);
  await deniedByGuard({ ...s, drop: birth }, open(verified, held, heldUpload), "23514", /idempotent/);
  // a viewer is no actor of CMD040 (the policy)
  await deniedByGuard(
    { role: "kauro_app_test", settings: appSession(viewer), drop: "DROP POLICY stage_receipt_reconciliations_tenant_open ON kauro.stage_receipt_reconciliations; CREATE POLICY births_red ON kauro.stage_receipt_reconciliations FOR INSERT TO kauro_app WITH CHECK (true)" },
    open(verified, differing, differingUpload, viewerMembership),
    "42501",
    /row-level security/,
  );
  // OK: the differing receipt opens one reconciliation, OPEN at the database's instant; once per content
  const opened = ids.next();
  await tx(app, owner(), (c) => c.query(insert, [opened, A.agencyId, projectId, verified, differing, differingUpload, A.ownerMembershipId]));
  const row = await o.query<{ state: string }>("SELECT state FROM kauro.stage_receipt_reconciliations WHERE reconciliation_id = $1", [opened]);
  assert.equal(row.rows[0]!.state, "OPEN");
  await assert.rejects(tx(app, owner(), (c) => open(verified, differing, differingUpload)(c)), refusedWith("23505", "stage_receipt_reconciliations_once"));
  await assert.rejects(o.query("UPDATE kauro.stage_receipt_reconciliations SET content_hash = $2 WHERE reconciliation_id = $1", [opened, held]), (e: unknown) => /append|forbid|cannot/i.test(String(e)));

  // parent edges: bound to the stage's own parents and sources (the compiler's birth), never changed
  await assert.rejects(stage("PREPARED", { parents: [verified], sources: ["c1"], edges: [{ childSourceId: "c1", parentStageId: ids.next(), parentSourceId: "s1" }] }), refusedWith("23514", "import_stages_parent_edges_bound"));
  await assert.rejects(stage("PREPARED", { parents: [verified], sources: ["c1"], edges: [{ childSourceId: "c9", parentStageId: verified, parentSourceId: "s1" }] }), refusedWith("23514", "import_stages_parent_edges_bound"));
  await assert.rejects(stage("PREPARED", { parents: [verified], sources: ["c1"], edges: [{ childSourceId: "c1", parentStageId: verified, parentSourceId: "s1", extra: 1 }] }), refusedWith("23514", "import_stages_parent_edges_bound"));
  const child = await stage("PREPARED", { parents: [verified], sources: ["c1"], edges: [{ childSourceId: "c1", parentStageId: verified, parentSourceId: "s1" }] });
  await assert.rejects(o.query("UPDATE kauro.import_stages SET parent_edges = '[]'::jsonb, version = version + 1 WHERE stage_id = $1", [child]), refusedWith("KA004"));
  await o.query("BEGIN");
  try {
    await o.query("DROP TRIGGER import_stages_parent_edges_immutable ON kauro.import_stages");
    await o.query("UPDATE kauro.import_stages SET parent_edges = '[]'::jsonb, version = version + 1 WHERE stage_id = $1", [child]);
  } finally {
    await o.query("ROLLBACK");
  }
  // the request session holds no privilege on the edges at all
  await assert.rejects(attempt(s, (c) => c.query("UPDATE kauro.import_stages SET parent_edges = '[]'::jsonb, version = version + 1 WHERE stage_id = $1", [child])), refusedWith("42501"));
});

// --- 0074 tax document issuance ---------------------------------------------------------------------------------------------------------

async function validatedInvoice(seed: string, profileId: string): Promise<string> {
  const { projectId } = await project(app, A, clientA, hubspot, "HUBSPOT");
  const subject = await approvedSubject({ app, control }, validator, assurance, A, projectId, seed);
  const quote = await issuedQuote(app, A, subject, profileId, routes.issuerRef, { treatment: "EXEMPT_EXPORT" });
  const order = await createdOrder(app, A, quote, routes, { payment });
  const done = await observedCapture(payment, A, order, routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, hubspot);
  return within(payment, service(A.agencyId), async (c) => {
    const documentId = ids.next();
    await c.query(
      `INSERT INTO kauro.tax_documents (document_id, agency_id, order_id, capture_id, kind, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps, service_cents, tax_cents, currency, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'INVOICE', $5, $6, 'EXEMPT_EXPORT', 'ZERO_REVIEWED', 0, $7, 0, 'USD', now(), now())`,
      [documentId, A.agencyId, order.orderId, done.captureId, profileId, routes.issuerRef, quote.serviceCents],
    );
    await commerceEvent(c, "tax_document", documentId, 1, A.agencyId, "tax_document.drafted.v1", PAYMENT_SERVICE);
    await c.query("UPDATE kauro.tax_documents SET state = 'VALIDATED', version = 2 WHERE document_id = $1", [documentId]);
    await commerceEvent(c, "tax_document", documentId, 2, A.agencyId, "tax_document.validated.v1", PAYMENT_SERVICE);
    return documentId;
  });
}

const submittingSql = "UPDATE kauro.tax_documents SET state = 'SUBMITTING', issue_request_hash = $2, version = 3 WHERE document_id = $1";
const issuedSql = (accepted: boolean) =>
  `UPDATE kauro.tax_documents SET state = 'ISSUED', provider_document_id = 'DOC-' || left($1::text, 8), legal_number = 'SETP-' || right(replace($1::text, '-', ''), 6), evidence_hash = $2, issued_at = now()${accepted ? ", fiscal_status = 'ACCEPTED', verification_ref = 'CUFE-' || $1::text" : ""}, version = 4 WHERE document_id = $1`;

test("0074: the issuer's half covers every judged column; the document's state is a transition subject; SUBMITTING is judged after both shared halves at the effect instant", async () => {
  const profileId = await fiscalProfile(app, kora, A, routes.issuerRef, "EXEMPT_EXPORT");
  const doc = await validatedInvoice("births-fiscal", profileId);
  const pay = { role: "kauro_payment_test" as const, settings: { "kauro.agency_id": A.agencyId } };
  const ctl = { role: "kauro_control_test" as const, settings: {} };
  // M17: each of the 7 judged columns takes the issuer's exclusive half when it changes; the red control drops the lock trigger
  const changes: ReadonlyArray<string> = [
    "route_state = 'SUSPENDED'",
    "legal_fact_status = CASE legal_fact_status WHEN 'OBSERVED' THEN 'PROFESSIONALLY_CONFIRMED' ELSE 'OBSERVED' END",
    "numbering_authorization_ref = 'NUM-births-2'",
    `entitlement_evidence_hash = '${sha("entitlement-2")}'`,
    `qualification_evidence_hashes = qualification_evidence_hashes || '["${sha("qualification-2")}"]'::jsonb`,
    "valid_from = valid_from - interval '1 day'",
    "valid_until = now() + interval '30 days'",
  ];
  for (const set of changes) {
    const write = (o: Client) => o.query(`UPDATE kauro.fiscal_issuers SET ${set} WHERE issuer_ref = $1`, [routes.issuerRef]);
    const inspect = (o: Client) => lockModes(o, "kauro.fiscal_issuers", routes.issuerRef);
    assert.deepEqual(await attempt<string[]>({ ...ctl, inspect }, write), ["ExclusiveLock"], `the change ${set} takes the issuer's exclusive half`);
    assert.deepEqual(await attempt<string[]>({ ...ctl, inspect, drop: "DROP TRIGGER fiscal_issuers_transition_lock ON kauro.fiscal_issuers" }, write), [], `red control: ${set}`);
  }
  // M15: the state change takes the document's exclusive half; SUBMITTING holds the profile's and the issuer's shared halves
  const submit = (o: Client) => o.query(submittingSql, [doc, sha(`issue-${doc}`)]);
  const halves = (o: Client) =>
    Promise.all([lockModes(o, "kauro.tax_documents", doc), lockModes(o, "kauro.fiscal_profiles", A.agencyId), lockModes(o, "kauro.fiscal_issuers", routes.issuerRef)]);
  assert.deepEqual(await attempt({ ...pay, inspect: halves }, submit), [["ExclusiveLock"], ["ShareLock"], ["ShareLock"]]);
  assert.deepEqual(await attempt({ ...pay, inspect: halves, drop: "DROP TRIGGER tax_documents_transition_lock ON kauro.tax_documents" }, submit), [[], ["ShareLock"], ["ShareLock"]]);
  const guard = "DROP TRIGGER tax_documents_submitting_guard ON kauro.tax_documents";
  // the route gate (R2-083): a suspended issuer has no qualified, entitled route
  await deniedByGuard({ ...pay, drop: guard, setup: (o) => o.query("UPDATE kauro.fiscal_issuers SET route_state = 'SUSPENDED' WHERE issuer_ref = $1", [routes.issuerRef]) }, submit, "23514", /FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED/);
  // the issuer's validity: ended, or not yet begun
  await deniedByGuard({ ...pay, drop: guard, setup: (o) => o.query("UPDATE kauro.fiscal_issuers SET valid_until = now() - interval '1 second', valid_from = now() - interval '2 days' WHERE issuer_ref = $1", [routes.issuerRef]) }, submit, "23514", /FISCAL_ISSUER_NOT_IN_FORCE/);
  await deniedByGuard({ ...pay, drop: guard, setup: (o) => o.query("UPDATE kauro.fiscal_issuers SET valid_from = now() + interval '1 hour', valid_until = NULL WHERE issuer_ref = $1", [routes.issuerRef]) }, submit, "23514", /FISCAL_ISSUER_NOT_IN_FORCE/);
  // the profile's validity: not yet in force, ended, or superseded
  for (const set of ["valid_from = now() + interval '1 hour'", "valid_until = now() - interval '1 second'", "superseded_at = now()"]) {
    await deniedByGuard(
      { ...pay, drop: guard, setup: (o) => o.query(`SET LOCAL session_replication_role = replica; UPDATE kauro.fiscal_profiles SET ${set} WHERE profile_id = '${profileId}'; SET LOCAL session_replication_role = origin`) },
      submit,
      "23514",
      /FISCAL_PROFILE_NOT_IN_FORCE/,
    );
  }
  // OK: the qualified issuer in force and the current profile
  await within(payment, service(A.agencyId), async (c) => {
    await submit(c);
    await commerceEvent(c, "tax_document", doc, 3, A.agencyId, "tax_document.submitting.v1", PAYMENT_SERVICE);
  });
  // R2 15:139: an issued document carries its fiscal acceptance and its verification reference
  await deniedByGuard({ ...pay, drop: "ALTER TABLE kauro.tax_documents DROP CONSTRAINT tax_documents_issued_accepted" }, (o) => o.query(issuedSql(false), [doc, sha(`evidence-${doc}`)]), "23514", "tax_documents_issued_accepted");
  await deniedByGuard(
    { ...pay, drop: "ALTER TABLE kauro.tax_documents DROP CONSTRAINT tax_documents_acceptance_only_issued" },
    (o) => o.query("UPDATE kauro.tax_documents SET fiscal_status = 'ACCEPTED', verification_ref = 'CUFE-early', version = 4 WHERE document_id = $1", [doc]),
    "23514",
    "tax_documents_acceptance_only_issued",
  );
  await within(payment, service(A.agencyId), async (c) => {
    await c.query(issuedSql(true), [doc, sha(`evidence-${doc}`)]);
    await commerceEvent(c, "tax_document", doc, 4, A.agencyId, "tax_document.issued.v1", PAYMENT_SERVICE);
  });
  // learned once
  await deniedByGuard(
    { ...pay, drop: "DROP TRIGGER tax_documents_issuance_learned_once ON kauro.tax_documents" },
    (o) => o.query("UPDATE kauro.tax_documents SET fiscal_status = 'ACCEPTED_WITH_OBSERVATIONS', version = 5 WHERE document_id = $1", [doc]),
    "KA004",
    /learned once/,
  );
});

test("0074: the FISCAL consumer receives the submitting and issued facts, exactly as @kauro/domain lists them", async () => {
  const rows = await h.oracle.query<{ event_type: string; consumer: string }>("SELECT event_type, consumer FROM kauro.commerce_event_subscriptions WHERE consumer = 'FISCAL' ORDER BY event_type");
  const domain = COMMERCE_EVENT_SUBSCRIPTIONS.filter((s) => s.consumer === "FISCAL")
    .map((s) => ({ event_type: String(s.eventType), consumer: String(s.consumer) }))
    .sort((a, b) => (a.event_type < b.event_type ? -1 : 1));
  assert.deepEqual(rows.rows, domain);
  for (const t of ["tax_document.submitting.v1", "tax_document.issued.v1"]) assert.ok(rows.rows.some((r) => r.event_type === t), t);
});
