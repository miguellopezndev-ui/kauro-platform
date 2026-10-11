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
  const deadline = new Date(Date.now() + HOUR);
  const r = await h.oracle.query<{ expires_at: Date }>(
    "SELECT expires_at FROM kauro.claim_lease($1, $2, $3, 1, $4, $5, NULL, NULL, $6)",
    [KIND, resource, owner, deadline, sha("subject-" + resource), claimedAt],
  );
  const expires = r.rows[0]!.expires_at;
  assert.ok(expires.getTime() < Date.now(), "the lease has ended at the database clock");
  return { resource, owner, early: new Date(expires.getTime() - 1).toISOString(), deadline };
}

async function row(s: State): Promise<{ owner_id: string; fence: string; checkpoint_hash: string | null }> {
  return (await h.oracle.query("SELECT owner_id, fence, checkpoint_hash FROM kauro.leases WHERE resource_kind = $1 AND resource_id = $2", [KIND, s.resource])).rows[0];
}

async function renewalBehindCancel(renew: (c: Client, s: State) => Promise<{ rows: unknown[] }>): Promise<{ state: State; result: unknown[] }> {
  const canceller = await openConnection(h.pg.clientConfig("kauro_control_test"));
  const renewer = await openConnection(h.pg.clientConfig("kauro_control_test"));
  let result: unknown[] = [];
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
        setup: () => endedLease(),
        verify({ outcomes }) {
          assert.equal(outcomes["cancel"]?.committed, true);
          assert.equal(outcomes["renewal"]?.act.status, "fulfilled");
        },
      },
      "cancel",
    );
    return { state: run.state, result };
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
