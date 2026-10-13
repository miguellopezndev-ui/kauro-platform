// FCG-B06-LEASE-1 (tier 1; 06 "A stale worker cannot renew"; template rule 16, TIME-AFTER-AWAIT): claim_lease, heartbeat_lease and
// checkpoint_lease judge a lease's expiry at the database clock read AFTER their wait on the lease row, not at the instant the caller read
// before waiting. The interleaving is observed (mustWait): the control plane's cancel holds the row, the owner's renewal is seen waiting
// on it in pg_stat_activity, the cancel commits, the renewal goes on. The caller's early instant is one millisecond before the expiry
// while the database clock is far past it, so only a judgement after the wait refuses the renewal.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { ids, sha } from "./support.js";
import { start, type Harness } from "../src/testing/harness.js";
import { inOrder, openConnection } from "../src/testing/index.js";

let h: Harness;
before(async () => {
  h = await start();
});
after(async () => {
  await h.stop();
});

const KIND = "OUTBOX_DISPATCH";
const HOUR = 3_600_000;

interface State {
  resource: string;
  owner: string;
  /** one millisecond before the lease's expiry: the instant the caller read before it waited */
  early: string;
  deadline: Date;
}

/** A lease claimed an hour ago for one second: ended at the database clock, still live at `early`. */
async function endedLease(): Promise<State> {
  const resource = ids.next();
  const owner = ids.next();
  const claimedAt = new Date(Date.now() - HOUR);
  const deadline = new Date(claimedAt.getTime() + 2 * HOUR);
  const r = await h.oracle.query<{ expires_at: Date }>(
    "SELECT expires_at FROM kauro.claim_lease($1, $2, $3, 1, $4, $5, NULL, NULL, $6)",
    [KIND, resource, owner, deadline, sha("subject-" + resource), claimedAt],
  );
  const expires = r.rows[0]!.expires_at;
  assert.ok(expires.getTime() < Date.now(), "the lease has ended at the database clock");
  return { resource, owner, early: new Date(expires.getTime() - 1).toISOString(), deadline };
}

/**
 * A lease claimed now for one second under a deadline 1.5 s ahead (a claim is judged at the database clock, so its deadline must be
 * ahead of it when claimed), then the database clock is let pass the deadline: the remainder is measured at the database and waited.
 * `early` (one millisecond before the expiry) is before the deadline too, so only a judgement after the wait sees the deadline passed.
 */
async function pastDeadlineLease(): Promise<State> {
  const resource = ids.next();
  const owner = ids.next();
  const claimedAt = (await h.oracle.query<{ now: Date }>("SELECT kauro.effect_now() AS now")).rows[0]!.now;
  const deadline = new Date(claimedAt.getTime() + 1_500);
  const r = await h.oracle.query<{ expires_at: Date }>(
    "SELECT expires_at FROM kauro.claim_lease($1, $2, $3, 1, $4, $5, NULL, NULL, $6)",
    [KIND, resource, owner, deadline, sha("subject-" + resource), claimedAt],
  );
  const expires = r.rows[0]!.expires_at;
  assert.ok(expires.getTime() < deadline.getTime(), "the expiry is before the deadline");
  const remainder = Number((await h.oracle.query<{ ms: string }>("SELECT GREATEST(0, ceil(extract(epoch FROM ($1::timestamptz - kauro.effect_now())) * 1000)) AS ms", [deadline])).rows[0]!.ms);
  assert.ok(remainder <= 1_500, `the measured remainder ${remainder} ms is within the deadline's 1.5 s`);
  await new Promise((resolve) => setTimeout(resolve, remainder + 50));
  assert.ok((await h.oracle.query<{ past: boolean }>("SELECT kauro.effect_now() >= $1::timestamptz AS past", [deadline])).rows[0]!.past, "the deadline has passed at the database clock");
  return { resource, owner, early: new Date(expires.getTime() - 1).toISOString(), deadline };
}

async function row(s: State): Promise<{ owner_id: string; fence: string; checkpoint_hash: string | null }> {
  return (await h.oracle.query("SELECT owner_id, fence, checkpoint_hash FROM kauro.leases WHERE resource_kind = $1 AND resource_id = $2", [KIND, s.resource])).rows[0];
}

async function renewalBehindCancel(renew: (c: Client, s: State) => Promise<{ rows: unknown[] }>, expect: "fulfilled" | "rejected" = "fulfilled", setup: () => Promise<State> = () => endedLease()): Promise<{ state: State; result: unknown[]; renewal: unknown }> {
  const canceller = await openConnection(h.pg.clientConfig("kauro_control_test"));
  const renewer = await openConnection(h.pg.clientConfig("kauro_control_test"));
  let result: unknown[] = [];
  let renewal: unknown = null;
  try {
    const run = await inOrder<State>(
      {
        oracle: h.oracle,
        actors: [
          { name: "cancel", client: canceller, act: (c, s) => c.query("SELECT 1 FROM kauro.cancel_lease($1, $2)", [KIND, s.resource]) },
          {
            name: "renewal",
            client: renewer,
            act: async (c, s) => {
              result = (await renew(c, s)).rows;
            },
          },
        ],
        setup,
        verify({ outcomes }) {
          assert.equal(outcomes["cancel"]?.committed, true);
          const act = outcomes["renewal"]?.act;
          assert.equal(act?.status, expect);
          if (act?.status === "rejected") renewal = act.reason;
        },
      },
      "cancel",
    );
    return { state: run.state, result, renewal };
  } finally {
    await canceller.end();
    await renewer.end();
  }
}

test("FCG-B06-LEASE-1: a heartbeat whose wait on the lease row crossed the expiry is refused (NULL), the lease is not renewed", async () => {
  const { state, result } = await renewalBehindCancel((c, s) => c.query("SELECT resource_id FROM kauro.heartbeat_lease($1, $2, $3, 1, 60, $4)", [KIND, s.resource, s.owner, s.early]));
  assert.deepEqual(result, [{ resource_id: null }], "fenced out: NULL");
  const after = await row(state);
  assert.equal(after.fence, "1");
  assert.ok((await h.oracle.query("SELECT expires_at < now() AS ended FROM kauro.leases WHERE resource_id = $1", [state.resource])).rows[0].ended, "still ended");
});

test("FCG-B06-LEASE-1: a checkpoint whose wait on the lease row crossed the expiry is refused (NULL), nothing is stored", async () => {
  const { state, result } = await renewalBehindCancel((c, s) => c.query("SELECT resource_id FROM kauro.checkpoint_lease($1, $2, $3, 1, $4, $5)", [KIND, s.resource, s.owner, "a".repeat(64), s.early]));
  assert.deepEqual(result, [{ resource_id: null }]);
  assert.equal((await row(state)).checkpoint_hash, null);
});

test("FCG-B06-LEASE-1: the owner's claim whose wait on the lease row crossed the expiry is a takeover at fence + 1, not a renewal at its old fence", async () => {
  const { state, result } = await renewalBehindCancel((c, s) =>
    c.query("SELECT fence, owner_id FROM kauro.claim_lease($1, $2, $3, 60, $4, $5, NULL, NULL, $6)", [KIND, s.resource, s.owner, s.deadline, sha("subject-" + s.resource), s.early]),
  );
  assert.deepEqual(result, [{ fence: "2", owner_id: state.owner }], "the fence advanced: the old fence is fenced out");
  assert.equal((await row(state)).fence, "2");
});

test("FCG-B06-LEASE-1 control: a live lease is still renewed by its holder under its fence", async () => {
  const resource = ids.next();
  const owner = ids.next();
  const now = new Date();
  await h.oracle.query("SELECT 1 FROM kauro.claim_lease($1, $2, $3, 300, $4, $5, NULL, NULL, $6)", [KIND, resource, owner, new Date(Date.now() + HOUR), sha("subject-" + resource), now]);
  const hb = await h.oracle.query("SELECT fence FROM kauro.heartbeat_lease($1, $2, $3, 1, 300, $4)", [KIND, resource, owner, new Date()]);
  assert.equal(hb.rows[0].fence, "1");
});

// FCG-B06-LEASE-1b (0063): the lease's absolute deadline (claimed with 1.5 s to its deadline, immutable) is
// judged at the same instant as the expiry, after the row lock. The caller read its instant (early) before the deadline; while it
// waited on the lease row the database clock passed both the expiry and the deadline.
test("FCG-B06-LEASE-1b: a claim whose wait on the lease row crossed its deadline is refused (KA005 deadline has passed): no takeover at fence + 1, the lease row is unchanged", async () => {
  const taker = ids.next();
  const { state, renewal } = await renewalBehindCancel(
    (c, s) => c.query("SELECT fence, owner_id FROM kauro.claim_lease($1, $2, $3, 60, $4, $5, NULL, NULL, $6)", [KIND, s.resource, taker, s.deadline, sha("subject-" + s.resource), s.early]),
    "rejected",
    pastDeadlineLease,
  );
  const e = renewal as { code?: string; message?: string };
  assert.equal(e.code, "KA005");
  assert.match(String(e.message), /LEASE: deadline of .* has passed/);
  const after = await row(state);
  assert.deepEqual({ owner: after.owner_id, fence: after.fence }, { owner: state.owner, fence: "1" }, "no takeover");
});

test("FCG-B06-LEASE-1b: the holder's re-claim whose wait on the lease row crossed its deadline is refused (KA005), not a renewal", async () => {
  const { state, renewal } = await renewalBehindCancel(
    (c, s) => c.query("SELECT fence FROM kauro.claim_lease($1, $2, $3, 60, $4, $5, NULL, NULL, $6)", [KIND, s.resource, s.owner, s.deadline, sha("subject-" + s.resource), s.early]),
    "rejected",
    pastDeadlineLease,
  );
  assert.equal((renewal as { code?: string }).code, "KA005");
  assert.equal((await row(state)).fence, "1");
});

test("FCG-B06-LEASE-1b control: a claim whose deadline is still ahead at the database clock after the wait takes the ended lease over at fence + 1", async () => {
  const taker = ids.next();
  const { state, result } = await renewalBehindCancel((c, s) =>
    c.query("SELECT fence, owner_id FROM kauro.claim_lease($1, $2, $3, 60, $4, $5, NULL, NULL, $6)", [KIND, s.resource, taker, s.deadline, sha("subject-" + s.resource), s.early]),
  );
  assert.deepEqual(result, [{ fence: "2", owner_id: taker }]);
  assert.equal((await row(state)).fence, "2");
});
