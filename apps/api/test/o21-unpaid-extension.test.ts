// Order 21, CP-01.02 (retention policy R2-RETENTION-2): the free check's one extension, built against the Order 19A candidate with its
// activation OFF. The switch is the database function kauro.retention_r2_2_active() (migration 0110); activation is the one migration that
// replaces it, simulated here by the superuser on the test's own cluster. Real route (CMD060), real composition root, real PostgreSQL 17:
//
//  - switch OFF (the served behaviour): an UNPAID-only project has nothing to extend, and the database refuses a forged UNPAID extension;
//  - switch ON: one extension of up to 72 hours moves the UNPAID record's hard and effective deadlines to at most seal + 17 days and never
//    further; a second one is refused (one per project, across classes); a request after the record's end, on an expired record, or with
//    a stale version is refused with nothing written; the record's label and the seal-bound hard deadline (seal + 14 days) never change;
//  - the retention sweeper cannot expire the record before the extended date, and expires it at that date.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { retentionPolicyEditionOf } from "@kauro/domain";
import type { ProjectId } from "@kauro/domain";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { sealedThroughRoutes } from "./source-support.js";
import { call, freshKey, ids, outcome, type Reply, type World } from "./support.js";

const DAY_MS = 86_400_000;
const MAX_SECONDS = 259_200;

let pw: PaymentsWorld;
let w: World;
let termsVersion: string;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"] });
  w = pw.w;
  const agency = await w.row<{ terms_version: string }>("agencies", "agency_id = $1", [w.A.agencyId]);
  assert.ok(agency !== null && typeof agency.terms_version === "string");
  termsVersion = agency.terms_version;
});
after(async () => {
  await pw.stop();
});

const setSwitch = (on: boolean) => w.h.oracle.query(`CREATE OR REPLACE FUNCTION kauro.retention_r2_2_active() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$ SELECT ${on ? "true" : "false"} $$`);

function extend(projectId: string, body: { readonly expectedVersion: number; readonly requestedSeconds: number }): Promise<Reply> {
  return call(w, { url: `/api/v1/projects/${projectId}/retention-extensions`, token: w.owner.token, agency: w.A.agencyId, key: freshKey("o21"), body: { ...body, purpose: "CLIENT_REVIEW", termsVersion } });
}

interface Unpaid {
  readonly projectId: ProjectId;
  readonly revisionId: string;
  readonly retentionId: string;
  readonly version: number;
  readonly sealMs: number;
}

/** An UNPAID-only project: a revision sealed `daysAgo` days ago (the B07 lifecycle writes its UNPAID record, hard = seal + 14 days). */
async function unpaidProject(daysAgo: number): Promise<Unpaid> {
  const { projectId } = await w.project(w.A, w.clientA);
  const sealed = await w.h.sealedRevision(w.A, projectId, "SEALED", { base: new Date(Date.now() - daysAgo * DAY_MS) });
  const r = await w.h.oracle.query<{ retention_id: string; version: string; seal_ms: string }>(
    `SELECT r.retention_id, r.version::text AS version, floor(extract(epoch FROM a.occurred_at) * 1000)::bigint::text AS seal_ms
       FROM kauro.retention_records r JOIN kauro.retention_anchors a ON a.anchor_id = r.anchor_id WHERE r.revision_id = $1 AND r.class = 'UNPAID'`,
    [sealed.revisionId],
  );
  const row = r.rows[0];
  assert.ok(row !== undefined, "the sealed revision has its UNPAID record");
  return { projectId, revisionId: sealed.revisionId, retentionId: row.retention_id, version: Number(row.version), sealMs: Number(row.seal_ms) };
}

async function recordOf(retentionId: string): Promise<{ hard: number; extended: number | null; effective: number; soft: string | null; version: number; state: string; label: string }> {
  const r = await w.h.oracle.query<{ hard: string; extended: string | null; effective: string; soft: string | null; version: string; state: string; policy_version: string }>(
    `SELECT floor(extract(epoch FROM hard_deadline) * 1000)::bigint::text AS hard, floor(extract(epoch FROM extended_hard_deadline) * 1000)::bigint::text AS extended,
            floor(extract(epoch FROM effective_deadline) * 1000)::bigint::text AS effective, soft_deadline::text AS soft, version::text AS version, state, policy_version
       FROM kauro.retention_records WHERE retention_id = $1`,
    [retentionId],
  );
  const x = r.rows[0]!;
  return { hard: Number(x.hard), extended: x.extended === null ? null : Number(x.extended), effective: Number(x.effective), soft: x.soft, version: Number(x.version), state: x.state, label: x.policy_version };
}

const extensionsOf = (projectId: string) => w.count("retention_extensions", "project_id = $1", [projectId]);

test("O21 CP-01.02 switch OFF (served behaviour): an UNPAID-only project has nothing to extend, and the database refuses a forged UNPAID extension", async () => {
  await setSwitch(false);
  const p = await unpaidProject(10);
  const before = await recordOf(p.retentionId);
  assert.equal(outcome(w, await extend(p.projectId, { expectedVersion: p.version, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED NO_EXTENDABLE_RECORD");
  assert.deepEqual(await recordOf(p.retentionId), before, "nothing changed");
  assert.equal(await extensionsOf(p.projectId), 0);
  // the request role forging the UNPAID path directly: refused by the row policies while the switch is off
  const c = await w.h.pg.connect("kauro_app_test");
  let forged: string;
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [w.A.agencyId, w.owner.userId]);
    forged = await c
      .query(
        `INSERT INTO kauro.retention_extensions (extension_id, agency_id, project_id, retention_id, requested_seconds, granted_seconds, previous_soft_deadline, soft_deadline,
            hard_deadline, capped_at_hard_deadline, purpose, terms_version, requested_by_membership_id, requested_by_user_id, created_at, ceiling_rule, previous_hard_deadline)
         SELECT $5, r.agency_id, r.project_id, r.retention_id, 3600, 3600, r.hard_deadline, r.hard_deadline + interval '3600 seconds', r.hard_deadline + interval '259200 seconds',
                false, 'CLIENT_REVIEW', $2, $3, $4, kauro.server_now(), 'UNPAID_SEAL_17D', r.hard_deadline
           FROM kauro.retention_records r WHERE r.retention_id = $1`,
        [p.retentionId, termsVersion, w.memberships.owner, w.owner.userId, ids.next()],
      )
      .then(() => "INSERTED", (e: { code?: string }) => e.code ?? "ERROR");
  } finally {
    await c.query("ROLLBACK");
    await c.end();
  }
  assert.equal(forged, "42501", "row-level security refuses the forged UNPAID extension");
});

test("O21 CP-01.02 switch ON: one extension of up to 72 h moves the UNPAID record to at most seal + 17 days; a second is refused; label and seal-bound hard deadline unchanged", async () => {
  await setSwitch(true);
  try {
    const p = await unpaidProject(10);
    const before = await recordOf(p.retentionId);
    assert.equal(before.hard, p.sealMs + 14 * DAY_MS, "hard = seal + 14 days");
    const reply = await extend(p.projectId, { expectedVersion: p.version, requestedSeconds: MAX_SECONDS });
    assert.equal(reply.status, 200, reply.text);
    const view = reply.json<{ data: { hardDeadline: string; effectiveDeadline: string; grantedSeconds: number; cappedAtHardDeadline: boolean } }>().data;
    const after = await recordOf(p.retentionId);
    assert.equal(after.extended, p.sealMs + 17 * DAY_MS, "the moved hard deadline is seal + 17 days exactly");
    assert.equal(after.effective, p.sealMs + 17 * DAY_MS);
    assert.equal(Date.parse(view.hardDeadline), p.sealMs + 17 * DAY_MS);
    assert.equal(Date.parse(view.effectiveDeadline), p.sealMs + 17 * DAY_MS);
    assert.deepEqual([view.grantedSeconds, view.cappedAtHardDeadline], [MAX_SECONDS, false]);
    assert.deepEqual([after.hard, after.soft, after.label, after.version], [before.hard, null, before.label, before.version + 1], "hard (seal + 14 d), no soft deadline, the label unchanged");
    assert.equal(retentionPolicyEditionOf(after.label), 1, "an existing label reads as the first edition");
    // a second extension of the project, in any class: refused, nothing written
    assert.equal(outcome(w, await extend(p.projectId, { expectedVersion: after.version, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED EXTENSION_ALREADY_USED");
    assert.deepEqual(await recordOf(p.retentionId), after);
    assert.equal(await extensionsOf(p.projectId), 1);
    // never past 17 days: the database refuses a moved hard deadline beyond seal + 17 days whoever writes it
    const beyond = await w.h.oracle.query("UPDATE kauro.retention_records SET extended_hard_deadline = hard_deadline + interval '259201 seconds' WHERE retention_id = $1", [p.retentionId]).then(() => "UPDATED", (e: { code?: string }) => e.code ?? "ERROR");
    assert.ok(beyond !== "UPDATED", `a moved hard deadline past seal + 17 days is refused (${beyond})`);
  } finally {
    await setSwitch(false);
  }
});

test("O21 CP-01.02 switch ON: a partial request ends at effective + requested; a request after the record's end, a stale version and an expired record are refused with nothing written", async () => {
  await setSwitch(true);
  try {
    const partial = await unpaidProject(10);
    const ok = await extend(partial.projectId, { expectedVersion: partial.version, requestedSeconds: 3_600 });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await recordOf(partial.retentionId)).effective, partial.sealMs + 14 * DAY_MS + 3_600_000, "end = previous end + requested");

    const stale = await unpaidProject(10);
    assert.equal(outcome(w, await extend(stale.projectId, { expectedVersion: stale.version + 5, requestedSeconds: 3_600 })), "409 STALE_VERSION -");
    assert.equal(await extensionsOf(stale.projectId), 0);

    const late = await unpaidProject(14.5);
    const lateBefore = await recordOf(late.retentionId);
    assert.equal(outcome(w, await extend(late.projectId, { expectedVersion: late.version, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED SOFT_DEADLINE_PASSED");
    assert.deepEqual(await recordOf(late.retentionId), lateBefore, "a request after the end is refused: nothing written");

    const expired = await unpaidProject(15);
    await w.h.expireRevision(w.A, expired.projectId, expired.revisionId as never);
    const ended = await recordOf(expired.retentionId);
    assert.equal(ended.state, "EXPIRED");
    assert.equal(outcome(w, await extend(expired.projectId, { expectedVersion: ended.version, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED RETENTION_EXPIRED");
    assert.equal(await extensionsOf(expired.projectId), 0);
  } finally {
    await setSwitch(false);
  }
});

test("O21 CP-01.02 switch ON: the retention sweeper cannot expire an extended record before its extended date, and expires it at that date", async () => {
  await setSwitch(true);
  try {
    const p = await unpaidProject(13);
    assert.equal((await extend(p.projectId, { expectedVersion: p.version, requestedSeconds: MAX_SECONDS })).status, 200);
    // past the 14 days, before the extended 17: the sweeper's expiry is refused (a record never expires before its effective deadline)
    const early = await w.h.expireRevision(w.A, p.projectId, p.revisionId as never, new Date(p.sealMs + 15 * DAY_MS)).then(() => "EXPIRED", (e: unknown) => String((e as { code?: string }).code ?? e));
    assert.notEqual(early, "EXPIRED", "not expired before the extended date");
    assert.equal((await recordOf(p.retentionId)).state, "ACTIVE");
    await w.h.expireRevision(w.A, p.projectId, p.revisionId as never, new Date(p.sealMs + 17 * DAY_MS + 1_000));
    assert.equal((await recordOf(p.retentionId)).state, "EXPIRED", "expired at the extended date");
  } finally {
    await setSwitch(false);
  }
});

test("O21 CP-01.02 label: a seal through the product writes R2-RETENTION-1 while the switch is off and R2-RETENTION-2 once it is on; both read by their edition, and the new record extends end to end", async () => {
  await setSwitch(false);
  const off = await sealedThroughRoutes(w);
  const offLabel = (await recordOf(off.retentionId)).label;
  assert.equal(offLabel, "R2-RETENTION-1");
  await setSwitch(true);
  try {
    const on = await sealedThroughRoutes(w);
    const record = await recordOf(on.retentionId);
    assert.equal(record.label, "R2-RETENTION-2");
    assert.deepEqual([retentionPolicyEditionOf(offLabel), retentionPolicyEditionOf(record.label), retentionPolicyEditionOf("R2-INITIAL")], [1, 2, 1]);
    const reply = await extend(on.projectId, { expectedVersion: record.version, requestedSeconds: MAX_SECONDS });
    assert.equal(reply.status, 200, reply.text);
    assert.equal((await recordOf(on.retentionId)).extended, record.hard + 3 * DAY_MS, "seal + 17 days");
  } finally {
    await setSwitch(false);
  }
});

test("O21 CP-01.02 switch ON: two concurrent extensions of one free check — exactly one is granted, the other is refused EXTENSION_ALREADY_USED", async () => {
  await setSwitch(true);
  try {
    const p = await unpaidProject(10);
    const replies = await Promise.all([extend(p.projectId, { expectedVersion: p.version, requestedSeconds: 3_600 }), extend(p.projectId, { expectedVersion: p.version, requestedSeconds: 7_200 })]);
    const answers = replies.map((r) => (r.status === 200 ? "200" : outcome(w, r))).sort();
    assert.ok(answers[0] === "200" && (answers[1] === "409 PRECONDITION_FAILED EXTENSION_ALREADY_USED" || answers[1] === "409 STALE_VERSION -"), JSON.stringify(answers));
    assert.equal(await extensionsOf(p.projectId), 1, "one extension row");
  } finally {
    await setSwitch(false);
  }
});

test("O21 CP-01.02 switch ON: the request role cannot extend another agency's UNPAID record, and a deletion request ends the free check's extension rights", async () => {
  await setSwitch(true);
  try {
    // another agency's record, forged under this agency's own context: no row of B is visible or insertable from A
    const { projectId: bProject } = await w.project(w.B, w.clientB);
    const bSealed = await w.h.sealedRevision(w.B, bProject, "SEALED", { base: new Date(Date.now() - 10 * DAY_MS) });
    const bRecord = (await w.h.oracle.query<{ retention_id: string }>("SELECT retention_id FROM kauro.retention_records WHERE revision_id = $1 AND class = 'UNPAID'", [bSealed.revisionId])).rows[0]!;
    const c = await w.h.pg.connect("kauro_app_test");
    let forged: string;
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [w.A.agencyId, w.owner.userId]);
      forged = await c
        .query(
          `INSERT INTO kauro.retention_extensions (extension_id, agency_id, project_id, retention_id, requested_seconds, granted_seconds, previous_soft_deadline, soft_deadline,
              hard_deadline, capped_at_hard_deadline, purpose, terms_version, requested_by_membership_id, requested_by_user_id, created_at, ceiling_rule, previous_hard_deadline)
           SELECT $1, $2, $3, $4, 3600, 3600, now(), now() + interval '3600 seconds', now() + interval '259200 seconds', false, 'CLIENT_REVIEW', $5, $6, $7, kauro.server_now(), 'UNPAID_SEAL_17D', now()`,
          [ids.next(), w.B.agencyId, bProject, bRecord.retention_id, termsVersion, w.memberships.owner, w.owner.userId],
        )
        .then(() => "INSERTED", (e: { code?: string }) => e.code ?? "ERROR");
    } finally {
      await c.query("ROLLBACK");
      await c.end();
    }
    assert.notEqual(forged, "INSERTED", "a row for another agency is refused");
    assert.equal(await extensionsOf(bProject), 0);

    // a deletion request: the project's records leave ACTIVE, and the free check can no longer be extended
    const p = await unpaidProject(10);
    const project = await w.row<{ version: string }>("projects", "project_id = $1", [p.projectId]);
    const deletion = await call(w, { url: `/api/v1/projects/${p.projectId}/deletion-requests`, token: w.owner.token, agency: w.A.agencyId, key: freshKey("o21-del"), body: { expectedVersion: Number(project!.version), reasonCode: "AGENCY_REQUEST", assuranceProofRef: await w.stepUp(w.owner) } });
    assert.ok(deletion.status === 200 || deletion.status === 201 || deletion.status === 202, deletion.text);
    const after = await recordOf(p.retentionId);
    assert.notEqual(after.state, "ACTIVE", `the record left ACTIVE (${after.state})`);
    const refused = await extend(p.projectId, { expectedVersion: after.version, requestedSeconds: 3_600 });
    assert.ok(refused.status === 409 || refused.status === 404, `${refused.status} ${refused.text}`);
    assert.equal(await extensionsOf(p.projectId), 0, "nothing extended after the deletion request");
  } finally {
    await setSwitch(false);
  }
});

/** A superuser write with the triggers off, for a state the product has no writer for yet (one statement batch, literal ids of this test). */
const asSuperuserUnchecked = (sql: string) => w.h.oracle.query(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT`);

test("O21 CP-01.02 switch ON (review F-1): the extension lands on the current revision's UNPAID record; a superseded revision's record is never extended", async () => {
  await setSwitch(true);
  try {
    // two sealed revisions of one project, each with its own UNPAID record; the successor is the current revision (CMD012 makes a
    // replacement current at creation; the fixture seals it beside the first, so the test moves the pointer as CMD012 would)
    const first = await unpaidProject(10);
    const second = await w.h.sealedRevision(w.A, first.projectId, "SEALED", { base: new Date(Date.now() - 2 * DAY_MS) });
    const successor = await w.h.oracle.query<{ retention_id: string; version: string }>("SELECT retention_id, version::text AS version FROM kauro.retention_records WHERE revision_id = $1 AND class = 'UNPAID'", [second.revisionId]);
    const s = successor.rows[0];
    assert.ok(s !== undefined, "the successor's UNPAID record");
    assert.ok(first.retentionId < s.retention_id, "the superseded record is the older id (the one an id order would pick)");
    await asSuperuserUnchecked(`UPDATE kauro.projects SET current_revision_id = '${second.revisionId}' WHERE project_id = '${first.projectId}'`);
    const firstBefore = await recordOf(first.retentionId);
    const successorBefore = await recordOf(s.retention_id);
    const reply = await extend(first.projectId, { expectedVersion: Number(s.version), requestedSeconds: MAX_SECONDS });
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json<{ data: { retentionId: string } }>().data.retentionId, s.retention_id);
    assert.equal((await recordOf(s.retention_id)).extended, successorBefore.hard + 3 * DAY_MS, "the current revision's record moved to its seal + 17 days");
    assert.deepEqual(await recordOf(first.retentionId), firstBefore, "the superseded revision's record is unchanged");
  } finally {
    await setSwitch(false);
  }
});

test("O21 CP-01.02 switch ON (review F-2): with an UNPAID soft deadline, soft = least(previous soft + requested, seal + 17 days) and the hard deadline moves only when the end passes it", async () => {
  await setSwitch(true);
  try {
    // the UNPAID soft deadline (ready + 7 days, never past the hard deadline) has no writer yet (an O21 activation remainder); it is
    // written here as its writer will, soft = effective, with the triggers off
    const withSoft = async (daysAgo: number, softDaysFromSeal: number): Promise<Unpaid> => {
      const p = await unpaidProject(daysAgo);
      const back = (14 - softDaysFromSeal) * 86_400;
      await asSuperuserUnchecked(`UPDATE kauro.retention_records SET soft_deadline = hard_deadline - interval '${back} seconds', effective_deadline = hard_deadline - interval '${back} seconds' WHERE retention_id = '${p.retentionId}'`);
      return p;
    };
    // the end stays inside the 14 days: the soft deadline moves, the hard deadline does not
    const inside = await withSoft(5, 8);
    const insideReply = await extend(inside.projectId, { expectedVersion: inside.version, requestedSeconds: MAX_SECONDS });
    assert.equal(insideReply.status, 200, insideReply.text);
    const insideView = insideReply.json<{ data: { previousSoftDeadline: string; softDeadline: string; grantedSeconds: number; cappedAtHardDeadline: boolean } }>().data;
    const insideAfter = await recordOf(inside.retentionId);
    assert.deepEqual([Date.parse(insideView.previousSoftDeadline), Date.parse(insideView.softDeadline)], [inside.sealMs + 8 * DAY_MS, inside.sealMs + 11 * DAY_MS]);
    assert.deepEqual([insideView.grantedSeconds, insideView.cappedAtHardDeadline], [MAX_SECONDS, false]);
    assert.deepEqual([insideAfter.extended, insideAfter.effective, insideAfter.hard], [null, inside.sealMs + 11 * DAY_MS, inside.sealMs + 14 * DAY_MS], "soft and effective at seal + 11 d, hard unmoved");
    assert.ok(insideAfter.soft !== null, "the soft deadline moved with it (effective = least(soft, hard) is the database's CHECK)");
    // the end passes the 14 days: the soft deadline and the hard deadline move to it, never past seal + 17 days
    const past = await withSoft(10, 13);
    assert.equal((await extend(past.projectId, { expectedVersion: past.version, requestedSeconds: MAX_SECONDS })).status, 200);
    const pastAfter = await recordOf(past.retentionId);
    assert.deepEqual([pastAfter.extended, pastAfter.effective], [past.sealMs + 16 * DAY_MS, past.sealMs + 16 * DAY_MS], "least(seal + 13 d + 72 h, seal + 17 d)");
    // a request after the soft deadline: refused, nothing written
    const late = await withSoft(10, 9);
    const lateBefore = await recordOf(late.retentionId);
    assert.equal(outcome(w, await extend(late.projectId, { expectedVersion: late.version, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED SOFT_DEADLINE_PASSED");
    assert.deepEqual(await recordOf(late.retentionId), lateBefore);
    assert.equal(await extensionsOf(late.projectId), 0);
  } finally {
    await setSwitch(false);
  }
});
