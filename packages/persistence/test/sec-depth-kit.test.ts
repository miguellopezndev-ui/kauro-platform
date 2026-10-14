// SEC-DEPTH-PROVENANCE lane K: the kit's helpers behave as the matrix's titles rely on them (real PG17).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { consumeThroughExecution, deliverThroughExecution, nestedAsSuperuser, slowCheckHook } from "../src/testing/index.js";
import { endJob } from "../src/testing/execution-fixtures.js";
import { service, within } from "./commerce-support.js";
import { closeExecutionEnv, openExecutionEnv, oracle, purchase, type ExecutionEnv } from "./execution-support.js";

let env: ExecutionEnv;
before(async () => { env = await openExecutionEnv("sec-depth-kit"); });
after(async () => { if (env !== undefined) await closeExecutionEnv(env); });

test("kit: nestedAsSuperuser runs the statement as the superuser inside the probe trigger (guards of the written tables then fire at depth 2) from a runtime session; a refused statement aborts the transaction", async () => {
  await env.h.oracle.query("CREATE SCHEMA IF NOT EXISTS depth_probe_seen");
  await env.h.oracle.query("CREATE TABLE depth_probe_seen.seen (depth int, su boolean, role text)");
  const probe = await nestedAsSuperuser(env.h.oracle, "kauro_control", `INSERT INTO depth_probe_seen.seen SELECT pg_trigger_depth(), (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), current_user`);
  try {
    await within(env.control, service(env.A.agencyId), async (c) => { await probe.fire(c); });
    const rows = await oracle<{ depth: number; su: boolean; role: string }>(env, "SELECT depth, su, role FROM depth_probe_seen.seen");
    assert.deepEqual(rows.map((r) => [r.depth, r.su]), [[1, true]]);
    assert.notEqual(rows[0]!.role, "kauro_control");
  } finally {
    await probe.drop();
    await probe.drop();
  }
  const bad = await nestedAsSuperuser(env.h.oracle, "kauro_control", "RAISE EXCEPTION 'nested refusal' USING ERRCODE = 'KA999'");
  try {
    await assert.rejects(within(env.control, service(env.A.agencyId), async (c) => { await bad.fire(c); }), (e: unknown) => /KA999|nested refusal/.test(String((e as Error).message) + String((e as { cause?: { code?: string } }).cause?.code)));
  } finally {
    await bad.drop();
  }
});

test("kit: slowCheckHook holds the runtime transaction at the probe for at least the stated time", async () => {
  const hook = await slowCheckHook(env.h.oracle, "kauro_control", 300);
  try {
    const started = Date.now();
    await within(env.control, service(env.A.agencyId), async (c) => { await hook.fire(c); });
    assert.ok(Date.now() - started >= 290);
  } finally {
    await hook.drop();
  }
  await assert.rejects(slowCheckHook(env.h.oracle, "kauro_control", 0), /integer in 1\.\.60000/);
});

test("kit: consumeThroughExecution CONSUMES and deliverThroughExecution DELIVERS an authorization through the production writers", async () => {
  const consumed = await purchase(env, env.A, "kit-consume");
  const c = await consumeThroughExecution(env.h, env.A, consumed.authorizationId);
  try {
    const [row] = await oracle<{ state: string; job_ref: string }>(env, "SELECT state, job_ref FROM kauro.commercial_authorizations WHERE authorization_id = $1", [consumed.authorizationId]);
    assert.deepEqual([row?.state, row?.job_ref], ["CONSUMED", c.jobId]);
  } finally {
    await endJob(env.h, env.A, c.jobId);
  }
  const delivered = await purchase(env, env.B, "kit-deliver");
  const d = await deliverThroughExecution(env.h, env.B, delivered.authorizationId);
  const [row] = await oracle<{ state: string; delivered_at: Date | null }>(env, "SELECT state, delivered_at FROM kauro.commercial_authorizations WHERE authorization_id = $1", [delivered.authorizationId]);
  assert.equal(row?.state, "DELIVERED");
  assert.ok(row?.delivered_at);
  assert.ok(d.packageVersionId);
});
