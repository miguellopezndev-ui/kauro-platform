// SEC defence in depth, lane OWNER-POLICY-FORALL-2: a row-security policy names exactly the commands its role is granted. A FOR ALL
// policy for a role that holds no UPDATE or no DELETE (table or column privilege) lets the policy say more than the privileges do; the
// day a grant is widened by mistake the policy would already allow the row. Every kauro policy is therefore either FOR ALL for a role
// that really holds SELECT, INSERT, UPDATE and DELETE, or one policy per granted command.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";
import { readBoundary } from "./boundary.js";

let pg: TemporaryPostgres;
before(async () => {
  pg = await startTemporaryPostgres();
});
after(async () => {
  await pg.stop();
});

test("SEC-OWNER-POLICY-FORALL: no kauro policy is FOR ALL for a role that lacks a granted SELECT, INSERT, UPDATE or DELETE", async () => {
  const b = await readBoundary(pg);
  // a relation's owner holds every privilege by ownership: its FOR ALL policy is exactly as wide as its rights only on the relations it owns
  const su = await pg.connect("postgres");
  let ownerOf: Map<string, string>;
  try {
    const owned = await su.query<{ rel: string; owner: string }>(
      "SELECT 'kauro.' || c.relname AS rel, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro'",
    );
    ownerOf = new Map(owned.rows.map((r) => [r.rel, r.owner]));
  } finally {
    await su.end();
  }
  const offenders: string[] = [];
  for (const [key, policy] of Object.entries(b.policies)) {
    if (policy.command !== "ALL") continue;
    const rel = `kauro.${key.split("/")[0]}`;
    for (const role of policy.roles) {
      if (ownerOf.get(rel) === role) continue;
      const held = new Set<string>([...(b.tables[role]?.[rel] ?? []), ...Object.keys(b.columns[role]?.[rel] ?? {})]);
      const missing = ["SELECT", "INSERT", "UPDATE", "DELETE"].filter((p) => !held.has(p));
      if (missing.length > 0) offenders.push(`${key} ${role} lacks ${missing.join(",")}`);
    }
  }
  assert.deepEqual(offenders, [], "FOR ALL policies wider than their role's grants");
});
