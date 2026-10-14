// B12 lane L-HOME: GetSellerHome and the terminated seller's scope (R2-066, GAP-HO-1; migration 0089; owner manual 12 "Seller onboarding and
// access lifecycle"). The real route, the real authorizers and PostgreSQL 17 through the runtime login roles; the superuser only reads.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SellerHomeView } from "@kauro/application";
import { asOperator, recordSourceEvidence, salesWorld, type SalesWorld } from "./sales-support.js";
import { call, completed, freshKey, outcome, type Person } from "./support.js";

let sw: SalesWorld;
invariantsAfterEach(() => sw.w.h.oracle);
before(async () => {
  sw = await salesWorld({}, "b12home");
});
after(async () => {
  await sw.stop();
});
const w = () => sw.w;

const home = (who: Person) => call(w(), { method: "GET", url: "/api/v1/sales/home", token: who.token, agency: null, key: null });
const readHome = async (who: Person): Promise<SellerHomeView> => {
  const reply = await home(who);
  assert.equal(reply.status, 200, reply.text);
  const body = reply.json<{ readonly kind: string; readonly data: SellerHomeView }>();
  assert.equal(body.kind, "READ");
  return body.data;
};

/** The prospect-data rows the seller's own session sees (RLS of 0029 and 0072 through migration 0089). */
async function visibleRows(userId: string): Promise<Record<string, number>> {
  const tables = ["prospects", "prospect_contacts", "prospect_source_evidence", "prospect_suppressions", "prospect_contact_addresses", "outreach_drafts", "sales_activities"];
  return asOperator(w().h, userId, async (c) => {
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM kauro.${t}`)).rows[0]?.n);
    return out;
  });
}

test("R2-066: a TERMINATED seller reads its home (state, no prospect actions, support route shown as not configured) while CMD045 refuses it and its session sees zero prospect-data rows", async () => {
  const seller = await sw.seller("home-terminated");
  const evidence = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "home-terminated.example" });
  const register = (key: string) =>
    call(w(), {
      url: "/api/v1/sales/prospects",
      token: seller.person.token,
      agency: null,
      key,
      body: { organizationLabel: "home-terminated.example", businessContactRef: evidence.contactRef, sourceEvidenceHash: evidence.sourceEvidenceHash, jurisdiction: "United States" },
    });
  completed(await register(freshKey("b12home-reg")), 201);

  const active = await readHome(seller.person);
  assert.equal(active.sellerState, "ACTIVE");
  assert.ok(active.permittedActions.includes("REGISTER_PROSPECT"));
  assert.equal(active.supportRoute, null, "no route configured: null, shown as not configured");
  const before = await visibleRows(seller.userId);
  assert.ok((before["prospects"] ?? 0) >= 1 && (before["prospect_contacts"] ?? 0) >= 1 && (before["prospect_source_evidence"] ?? 0) >= 1, `an ACTIVE seller sees its rows: ${JSON.stringify(before)}`);

  await asOperator(w().h, sw.owner.userId, (c) =>
    c.query("UPDATE kauro.sellers SET state = 'TERMINATED', terminated_at = kauro.server_now(), version = version + 1 WHERE user_id = $1", [seller.userId]),
  );

  const gone = await readHome(seller.person);
  assert.equal(gone.sellerState, "TERMINATED");
  assert.deepEqual([...gone.permittedActions].sort(), ["CONTACT_SUPPORT", "READ_HOME", "READ_STATEMENTS"]);
  assert.equal(gone.supportRoute, null);
  assert.deepEqual(await visibleRows(seller.userId), { prospects: 0, prospect_contacts: 0, prospect_source_evidence: 0, prospect_suppressions: 0, prospect_contact_addresses: 0, outreach_drafts: 0, sales_activities: 0 });
  assert.equal(outcome(w(), await register(freshKey("b12home-denied"))), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
});

test("GetSellerHome DENY: an agency member's tenant session and a person without a seller row are 403 CORPORATE_ROLE_MISSING", async () => {
  const reply = await call(w(), { method: "GET", url: "/api/v1/sales/home", token: w().owner.token, agency: w().A.agencyId, key: null });
  assert.equal(reply.status, 403);
  const stranger = await w().person("b12home-stranger");
  assert.equal(outcome(w(), await home(stranger)), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
});

test("R2-066 (configured route): the home shows KAURO_SELLER_SUPPORT_ROUTE when the deployment configures one", { todo: "regen at batch: salesWorld takes no commercial.sellerSupportRoute option yet (composition accepts it)" }, () => {});

test("GAP-HO-1 RACE (revocation): CMD050 against a seller's prospect read held at L1 in both orders gives rows then 0", { todo: "needs the raceAtWrite harness run (owner sprint: compile only)" }, () => {});
