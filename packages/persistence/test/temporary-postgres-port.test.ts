// The temporary server's port is probed, released, then bound by postgres: a port taken in between must not fail the run (ci-local 89f7b90).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { test } from "node:test";
import { startTemporaryPostgres } from "../src/testing/index.js";

const listen = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });

test("a port taken between the probe and the server's bind starts the server on a newly probed port; the taken one is never used", async () => {
  const squatter = await listen(0);
  const taken = (squatter.address() as { port: number }).port;
  const probe = await listen(0);
  const fresh = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const handed: number[] = [];
  const ports = [taken, fresh];
  try {
    const pg = await startTemporaryPostgres({ migrate: false, portSource: async () => { const p = ports.shift()!; handed.push(p); return p; } });
    try {
      assert.deepEqual(handed, [taken, fresh]);
      assert.equal(pg.port, fresh);
      const c = await pg.connect("postgres");
      try {
        assert.equal((await c.query("SELECT 1 AS one")).rows[0].one, 1);
      } finally {
        await c.end();
      }
    } finally {
      await pg.stop();
    }
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});
