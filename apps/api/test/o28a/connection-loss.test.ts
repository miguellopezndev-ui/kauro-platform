// O28A review F-2: a pooled connection whose backend died while it was idle (a database restart or failover) must answer the request a
// retryable 503 CAPACITY_UNAVAILABLE, never a 500 INTERNAL_ERROR: node-postgres reports that loss client-side ("Connection terminated
// unexpectedly", no SQLSTATE), and nothing was written because the unit failed at BEGIN. Deterministic: the idle backends are
// terminated and the requests are sent before the pool can notice.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { call, routes, world, type World } from "../support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w?.stop();
});

test("requests on pooled connections whose backends were terminated while idle answer 503 retryable, never 500, and the next succeeds", async () => {
  const read = () => call(w, { method: "GET", url: `/api/v1/agencies/${w.A.agencyId}`, agency: null, key: null });
  // warm the api pool: several idle connections
  await Promise.all([read(), read(), read(), read()]);
  const before = await w.count("end_clients");
  const statuses: number[] = [];
  for (let round = 0; round < 3; round++) {
    await w.h.oracle.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'kauro_app_test' AND state = 'idle' AND application_name <> ''");
    const replies = await Promise.all([read(), read(), call(w, { url: routes.createClient(w.A.agencyId), body: { displayName: `Loss ${round}`, processingAuthorityRef: w.authorityA } })]);
    for (const r of replies) {
      statuses.push(r.status);
      assert.notEqual(r.status, 500, r.text);
      if (r.status === 503) assert.equal(r.json<{ retryable: boolean }>().retryable, true);
    }
    await Promise.all([read(), read()]);
  }
  assert.deepEqual(w.internalErrors.map((e) => String(e.error)), [], "no internal error was recorded");
  assert.equal((await read()).status, 200, "the pool recovers");
  const written = (await w.count("end_clients")) - before;
  assert.equal(written, statuses.filter((s, i) => i % 3 === 2 && s === 201).length, "a command answered 503 wrote nothing");
});
