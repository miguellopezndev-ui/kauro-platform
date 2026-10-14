// SEC defence in depth, lane OWNER-POLICY-FORALL-2: a row-security policy names exactly the commands its role is granted. A FOR ALL
// policy for a role that holds no UPDATE or no DELETE (table or column privilege) lets the policy say more than the privileges do; the
// day a grant is widened by mistake the policy would already allow the row. Every kauro policy is therefore either FOR ALL for a role
// that really holds SELECT, INSERT, UPDATE and DELETE, or one policy per granted command.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";
import { readBoundary } from "./boundary.js";

/** Owned by lane OWNER-OUTBOX-POLICY (migration 0075 splits them); remove this allowance when that migration is merged. */
const OWNED_BY_OUTBOX_LANE = new Set(["outbox_records/outbox_records_owner_bank", "outbox_records/outbox_records_owner_route"]);

let pg: TemporaryPostgres;
before(async () => {
  pg = await startTemporaryPostgres();
});
after(async () => {
  await pg.stop();
});

test("SEC-OWNER-POLICY-FORALL: no kauro policy is FOR ALL for a role that lacks a granted SELECT, INSERT, UPDATE or DELETE", async () => {
  const b = await readBoundary(pg);
  const offenders: string[] = [];
  for (const [key, policy] of Object.entries(b.policies)) {
    if (policy.command !== "ALL" || OWNED_BY_OUTBOX_LANE.has(key)) continue;
    const rel = `kauro.${key.split("/")[0]}`;
    for (const role of policy.roles) {
      const held = new Set<string>([...(b.tables[role]?.[rel] ?? []), ...Object.keys(b.columns[role]?.[rel] ?? {})]);
      const missing = ["SELECT", "INSERT", "UPDATE", "DELETE"].filter((p) => !held.has(p));
      if (missing.length > 0) offenders.push(`${key} ${role} lacks ${missing.join(",")}`);
    }
  }
  assert.deepEqual(offenders, [], "FOR ALL policies wider than their role's grants");
});
