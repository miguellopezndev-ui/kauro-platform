// ORDER 8 probe: how far can PostgreSQL's now() stand AFTER a Node Date.now() read taken once the statement returned?
// (a row stamped next_attempt_at = now() is then "not yet due" for a dispatcher reading Date.now() right after).
// Samples for SECONDS seconds, a statement every ~2 ms; reports the lead per 5-second bucket (V8 resyncs its Windows clock each minute).
import { createRequire } from "node:module";
const require = createRequire(process.argv[2]);
const { Client } = require("pg");
const port = Number(process.argv[3] ?? 55432);
const seconds = Number(process.argv[4] ?? 150);
const c = new Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
await c.connect();
const buckets = new Map();
const start = Date.now();
let n = 0, ahead = 0, maxLead = -Infinity, over2 = 0, over5 = 0, over10 = 0;
while (Date.now() - start < seconds * 1000) {
  const r = await c.query("SELECT (extract(epoch FROM now()) * 1000)::float8 AS pg");
  const b = Date.now();
  const lead = Number(r.rows[0].pg) - b;
  n++;
  if (lead > 0) ahead++;
  if (lead > 2) over2++;
  if (lead > 5) over5++;
  if (lead > 10) over10++;
  maxLead = Math.max(maxLead, lead);
  const k = Math.floor((b - start) / 5000) * 5;
  // a bucket is printed as soon as the next one opens (the probe may be killed when the loop it shadows ends)
  if (!buckets.has(k) && buckets.size > 0) { const [pk, ps] = [...buckets].at(-1); console.log(`${new Date(start + pk * 1000).toISOString()} +${String(pk).padStart(4)}s n=${ps.n} lead ms min=${ps.minLeadMs.toFixed(3)} max=${ps.maxLeadMs.toFixed(3)}`); }
  const s = buckets.get(k) ?? { n: 0, maxLeadMs: -Infinity, minLeadMs: Infinity };
  s.n++; s.maxLeadMs = Math.max(s.maxLeadMs, lead); s.minLeadMs = Math.min(s.minLeadMs, lead);
  buckets.set(k, s);
  await new Promise((r) => setTimeout(r, 2));
}
await c.end();
const perBucket = [...buckets].map(([k, s]) => `${new Date(start + k * 1000).toISOString()} +${String(k).padStart(4)}s n=${s.n} lead ms min=${s.minLeadMs.toFixed(3)} max=${s.maxLeadMs.toFixed(3)}`);
console.log(JSON.stringify({ platform: process.platform, node: process.version, samples: n, pgAfterNode: ahead, leadOver2ms: over2, leadOver5ms: over5, leadOver10ms: over10, maxLeadMs: Number(maxLead.toFixed(3)) }, null, 1));
