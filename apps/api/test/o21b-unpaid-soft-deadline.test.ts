// Order 21 (remainder of review F-2), CP-01.02: the writer of the UNPAID soft deadline (09 "Retention schedule": seven days after
// DRAFT_READY or terminal failure, no later than fourteen days from sealing; retention.unpaidDaysFromReady), behind the switch of migration
// 0110 (kauro.retention_r2_2_active(), off until Order 19B; activation simulated here by the superuser on the test's own cluster). Real
// routes (CMD021, CMD060), the real audit store on its control-plane and request roles, real PostgreSQL 17 (migration 0111):
//
//  - switch OFF (the served behaviour): an audit's end writes no anchor and no soft deadline; the database refuses both to a forger;
//  - switch ON: DRAFT_READY, a terminal failure and a cancellation each set the revision's UNPAID soft deadline to end + 7 days, never past
//    the hard deadline, once; CMD060 then extends from that soft deadline, never past seal + 17 days;
//  - existing rows are unchanged (no backfill; a record an extension already moved keeps its end); the request and control roles cannot
//    write the soft deadline or the anchor without the audit's end of their own transaction.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { auditWorld, cancelAudit, driveTo, endLiveAudits, fundPool, startAudit, auditIdOf, auditRow, type AuditWorld, type StartedAudit, type Subject } from "./audit-support.js";
import { asControl } from "./source-support.js";
import { call, freshKey, ids, outcome, type Reply, type World } from "./support.js";

const DAY_MS = 86_400_000;
const TERMS = "TERMS-2026-1";

let aw: AuditWorld;
let w: World;
before(async () => {
  aw = await auditWorld();
  w = aw.w;
  await fundPool(aw);
});
after(async () => {
  await aw.stop();
});

const setSwitch = (on: boolean) => w.h.oracle.query(`CREATE OR REPLACE FUNCTION kauro.retention_r2_2_active() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$ SELECT ${on ? "true" : "false"} $$`);

interface Unpaid {
  readonly retentionId: string;
  readonly version: number;
  readonly sealMs: number;
  readonly hard: number;
  readonly soft: number | null;
  readonly extended: number | null;
  readonly effective: number;
}

async function unpaidOf(revisionId: string): Promise<Unpaid> {
  const r = await w.h.oracle.query<{ retention_id: string; version: string; seal: string; hard: string; soft: string | null; extended: string | null; effective: string }>(
    `SELECT r.retention_id, r.version::text AS version, floor(extract(epoch FROM a.occurred_at) * 1000)::bigint::text AS seal,
            floor(extract(epoch FROM r.hard_deadline) * 1000)::bigint::text AS hard, floor(extract(epoch FROM r.soft_deadline) * 1000)::bigint::text AS soft,
            floor(extract(epoch FROM r.extended_hard_deadline) * 1000)::bigint::text AS extended, floor(extract(epoch FROM r.effective_deadline) * 1000)::bigint::text AS effective
       FROM kauro.retention_records r JOIN kauro.retention_anchors a ON a.anchor_id = r.anchor_id WHERE r.revision_id = $1 AND r.class = 'UNPAID'`,
    [revisionId],
  );
  const x = r.rows[0];
  assert.ok(x !== undefined, "the sealed revision's UNPAID record");
  const n = (v: string | null) => (v === null ? null : Number(v));
  return { retentionId: x.retention_id, version: Number(x.version), sealMs: Number(x.seal), hard: Number(x.hard), soft: n(x.soft), extended: n(x.extended), effective: Number(x.effective) };
}

const terminalMs = async (auditId: string) => Math.floor((await auditRow(w, auditId)).terminal_at!.getTime());
const anchorsOf = (revisionId: string) => w.count("retention_anchors", "revision_id = $1 AND anchor_kind = 'AUDIT_TERMINAL'", [revisionId]);
const softEventsOf = (retentionId: string) => w.count("domain_events", "aggregate_id = $1 AND event_type = 'retention_record.soft_deadline_set.v1'", [retentionId]);

/** A fresh subject of agency A (sealed `sealedDaysAgo` days ago, an hour by default) with its audit queued through CMD020. */
async function queued(sealedDaysAgo?: number): Promise<StartedAudit> {
  await endLiveAudits(w);
  const { projectId } = await w.project(w.A, w.clientA);
  const sealed = sealedDaysAgo === undefined
    ? await w.revision(w.A, projectId, "SEALED", { recent: true })
    : await w.h.sealedRevision(w.A, projectId, "SEALED", { base: new Date(Date.now() - sealedDaysAgo * DAY_MS) });
  const target = await w.targetContract(w.A, projectId);
  const subject: Subject = { projectId, revisionId: sealed.revisionId, revisionHash: sealed.revisionHash, contractId: target.contractId, targetContractHash: target.targetContractHash };
  const reply = await startAudit(w, subject.revisionId, { targetContractId: subject.contractId });
  const auditId = auditIdOf(reply);
  return { subject, auditId, grantId: (await auditRow(w, auditId)).grant_id };
}

function extend(projectId: string, body: { readonly expectedVersion: number; readonly requestedSeconds: number }): Promise<Reply> {
  return call(w, { url: `/api/v1/projects/${projectId}/retention-extensions`, token: w.owner.token, agency: w.A.agencyId, key: freshKey("o21b"), body: { ...body, purpose: "CLIENT_REVIEW", termsVersion: TERMS } });
}

test("O21B switch OFF (served behaviour): an audit's end writes no AUDIT_TERMINAL anchor and no soft deadline; the UNPAID record ends at its hard deadline", async () => {
  await setSwitch(false);
  const a = await queued();
  const before = await unpaidOf(a.subject.revisionId);
  await driveTo(w, a, "DRAFT_READY");
  assert.equal((await auditRow(w, a.auditId)).state, "DRAFT_READY");
  assert.deepEqual(await unpaidOf(a.subject.revisionId), before, "the record is unchanged");
  assert.deepEqual([before.soft, before.effective], [null, before.hard]);
  assert.equal(await anchorsOf(a.subject.revisionId), 0);
});

test("O21B switch ON: DRAFT_READY sets the UNPAID soft deadline to the audit's end + 7 days exactly (effective with it, hard unmoved), once, with its event", async () => {
  await setSwitch(true);
  try {
    const a = await queued();
    const before = await unpaidOf(a.subject.revisionId);
    await driveTo(w, a, "DRAFT_READY");
    const end = await terminalMs(a.auditId);
    const after = await unpaidOf(a.subject.revisionId);
    assert.deepEqual([after.soft, after.effective, after.hard, after.extended, after.version], [end + 7 * DAY_MS, end + 7 * DAY_MS, before.hard, null, before.version + 1]);
    assert.equal(await anchorsOf(a.subject.revisionId), 1);
    assert.equal(await softEventsOf(after.retentionId), 1);
    // set once: the database refuses a second write of the soft deadline, whoever asks (the superuser here, triggers on)
    const again = await w.h.oracle.query("UPDATE kauro.retention_records SET soft_deadline = soft_deadline + interval '1 day', effective_deadline = effective_deadline + interval '1 day', version = version + 1 WHERE retention_id = $1", [after.retentionId]).then(() => "UPDATED", (e: { code?: string }) => e.code ?? "ERROR");
    assert.notEqual(again, "UPDATED");
  } finally {
    await setSwitch(false);
  }
});

test("O21B switch ON: a terminal failure (FAILED, control plane) and a cancellation (CMD021, request role) set it to the end + 7 days too", async () => {
  await setSwitch(true);
  try {
    const f = await queued();
    await driveTo(w, f, "FAILED");
    const fEnd = await terminalMs(f.auditId);
    assert.equal((await unpaidOf(f.subject.revisionId)).soft, fEnd + 7 * DAY_MS, "FAILED: end + 7 days");

    const c = await queued();
    const reply = await cancelAudit(w, c.auditId, { expectedVersion: Number((await auditRow(w, c.auditId)).version) });
    assert.ok(reply.status < 300, reply.text);
    assert.equal((await auditRow(w, c.auditId)).state, "CANCELLED");
    const cEnd = await terminalMs(c.auditId);
    const cancelled = await unpaidOf(c.subject.revisionId);
    assert.deepEqual([cancelled.soft, cancelled.effective], [cEnd + 7 * DAY_MS, cEnd + 7 * DAY_MS], "CANCELLED: end + 7 days");
  } finally {
    await setSwitch(false);
  }
});

test("O21B switch ON: CMD060 extends from the written soft deadline (soft + 72 h, hard unmoved); late in the 14 days the soft deadline is the hard deadline and the extension ends at seal + 17 days, never later", async () => {
  await setSwitch(true);
  try {
    const a = await queued();
    await driveTo(w, a, "DRAFT_READY");
    const end = await terminalMs(a.auditId);
    const soft = await unpaidOf(a.subject.revisionId);
    const reply = await extend(a.subject.projectId, { expectedVersion: soft.version, requestedSeconds: 259_200 });
    assert.equal(reply.status, 200, reply.text);
    const view = reply.json<{ data: { previousSoftDeadline: string; softDeadline: string } }>().data;
    assert.deepEqual([Date.parse(view.previousSoftDeadline), Date.parse(view.softDeadline)], [end + 7 * DAY_MS, end + 10 * DAY_MS]);
    const extended = await unpaidOf(a.subject.revisionId);
    assert.deepEqual([extended.soft, extended.effective, extended.extended, extended.hard], [end + 10 * DAY_MS, end + 10 * DAY_MS, null, soft.hard]);

    // sealed ten days ago: end + 7 days is past the hard deadline, so the soft deadline is the hard deadline (seal + 14 days)
    const late = await queued(10);
    await driveTo(w, late, "DRAFT_READY");
    const capped = await unpaidOf(late.subject.revisionId);
    assert.deepEqual([capped.soft, capped.effective], [capped.hard, capped.hard], "never past the hard deadline");
    assert.equal(capped.hard, capped.sealMs + 14 * DAY_MS);
    assert.equal((await extend(late.subject.projectId, { expectedVersion: capped.version, requestedSeconds: 259_200 })).status, 200);
    const top = await unpaidOf(late.subject.revisionId);
    assert.deepEqual([top.soft, top.extended, top.effective], [top.sealMs + 17 * DAY_MS, top.sealMs + 17 * DAY_MS, top.sealMs + 17 * DAY_MS], "seal + 17 days, and no further");
  } finally {
    await setSwitch(false);
  }
});

test("O21B existing rows: no backfill when the switch turns on, and a record an extension already moved keeps its end when its audit ends", async () => {
  await setSwitch(false);
  const ended = await queued();
  await driveTo(w, ended, "DRAFT_READY");
  const offRecord = await unpaidOf(ended.subject.revisionId);
  await setSwitch(true);
  try {
    assert.deepEqual(await unpaidOf(ended.subject.revisionId), offRecord, "an audit that ended while the switch was off leaves its record as it was");
    // extended first (from the hard deadline), then the audit ends: the granted end stands, no soft deadline is written
    const a = await queued();
    const record = await unpaidOf(a.subject.revisionId);
    assert.equal((await extend(a.subject.projectId, { expectedVersion: record.version, requestedSeconds: 3_600 })).status, 200);
    const moved = await unpaidOf(a.subject.revisionId);
    await driveTo(w, a, "DRAFT_READY");
    assert.deepEqual(await unpaidOf(a.subject.revisionId), moved, "the extended record is unchanged by its audit's end");
    assert.equal(await anchorsOf(a.subject.revisionId), 0);
  } finally {
    await setSwitch(false);
  }
});

test("O21B RLS: neither runtime role writes the UNPAID soft deadline or the AUDIT_TERMINAL anchor without the audit's end of its own transaction, or while the switch is off", async () => {
  const a = await queued();
  const record = await unpaidOf(a.subject.revisionId);
  const attempt = async (role: "control" | "app", sql: string): Promise<string> => {
    const run = async (c: { query: (q: string) => Promise<{ rowCount: number | null }> }) => {
      await c.query("SAVEPOINT probe");
      try {
        const r = await c.query(sql);
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        return (r.rowCount ?? 0) === 0 ? "NO_ROW" : "WRITTEN";
      } catch (e) {
        return (e as { code?: string }).code ?? "ERROR";
      } finally {
        await c.query("ROLLBACK TO SAVEPOINT probe");
      }
    };
    return role === "control" ? asControl(w, w.A.agencyId, run) : w.asTenant(w.A, run);
  };
  const anchor = `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
                  VALUES ('${ids.next()}', '${w.A.agencyId}', '${a.subject.projectId}', '${a.subject.revisionId}', NULL, 'AUDIT_TERMINAL', kauro.server_now(), repeat('a', 64), kauro.server_now())`;
  const soft = `UPDATE kauro.retention_records SET soft_deadline = hard_deadline - interval '1 day', effective_deadline = hard_deadline - interval '1 day', version = version + 1 WHERE retention_id = '${record.retentionId}'`;
  for (const on of [false, true]) {
    await setSwitch(on);
    try {
      for (const role of ["control", "app"] as const) {
        const forged = await attempt(role, soft);
        assert.notEqual(forged, "WRITTEN", `${role} soft deadline without the audit's end (switch ${on ? "on" : "off"}): ${forged}`);
        const anchored = await attempt(role, anchor);
        assert.notEqual(anchored, "WRITTEN", `${role} anchor without the audit's end (switch ${on ? "on" : "off"}): ${anchored}`);
        if (!on) assert.equal(anchored, "42501", "row-level security refuses the anchor while the switch is off");
      }
    } finally {
      await setSwitch(false);
    }
  }
  assert.deepEqual(await unpaidOf(a.subject.revisionId), record, "nothing was written");
  assert.equal(outcome(w, await extend(a.subject.projectId, { expectedVersion: record.version, requestedSeconds: 3_600 })), "409 PRECONDITION_FAILED NO_EXTENDABLE_RECORD", "and with the switch off the served answer is unchanged");
});
