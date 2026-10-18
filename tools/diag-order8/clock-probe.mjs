// Probe: does the database's clock read AFTER Node's Date.now() ever stand later than a Date.now() read AFTER the statement returned?
// i.e. can a row stamped by PostgreSQL's now() be "in the future" for the Node process clock that reads right after it?
import { createRequire } from "node:module";
const require = createRequire(process.argv[2]);
const { Client } = require("pg");
const port = Number(process.argv[3] ?? 55432);
const n = Number(process.argv[4] ?? 5000);
const c = new Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
await c.connect();
let ahead = 0;
let maxAheadMs = 0;
const samples = [];
for (let i = 0; i < n; i++) {
  const a = Date.now();
  // transaction_timestamp() = now(): what financeRetryDue writes as next_attempt_at
  const r = await c.query("SELECT (extract(epoch FROM now()) * 1000)::float8 AS pg");
  const b = Date.now();
  const pg = Number(r.rows[0].pg);
  // Date.now() truncates to whole ms: PG's instant is <= the Node read after it iff pg < b + 1
  const lead = pg - b; // > 0: PG's now() is later than the Node clock read after the statement returned
  if (lead > 0) {
    ahead++;
    if (lead > maxAheadMs) maxAheadMs = lead;
    if (samples.length < 10) samples.push({ before: a, pg, after: b, leadMs: Number(lead.toFixed(3)) });
  }
}
await c.end();
console.log(JSON.stringify({ platform: process.platform, node: process.version, iterations: n, pgLaterThanNodeAfter: ahead, ratio: ahead / n, maxLeadMs: Number(maxAheadMs.toFixed(3)), samples }, null, 1));
