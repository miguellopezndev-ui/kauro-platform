// Order 15 §4, the owner's scenario: a seller signs in and opens Commissions. The real product is the api (the review simulator's HD-1 was a
// simulator defect, fixed in PR #119 under tools/review/private): whatever the seller sends — its own token, an owner route, another seller's
// statement id, an agency selector — it reads its own home and statements only, and every owner read and action refuses it by its corporate
// role before anything is read, in every seller state; the owner reads both statements (the control). The database proves the same under the
// seller's own runtime session (OPERATOR context, kauro_app): the other seller's statement rows are not visible to it at all. Real routes, real
// composition root, real PostgreSQL 17 (the statements world: B10 commission ledger, closed period, issued statements).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { UserId } from "@kauro/domain";
import { asOperator } from "./sales-support.js";
import { terminateDirectly } from "./sellers-support.js";
import { closeMonth, eligibleLines, readStatement, seller, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
import { asProblem, call, completed, freshKey, ids, outcome, type Person, type Reply } from "./support.js";

let sw: StatementsWorld;
let s: Awaited<ReturnType<typeof seller>>;
let other: Awaited<ReturnType<typeof seller>>;
let mine: string;
let theirs: string;

before(async () => {
  sw = await statementsWorld();
  const RATES = { firstBps: 10_000, repeatBps: 400 } as const;
  s = await seller(sw, "o15-commissions-seller", RATES);
  other = await seller(sw, "o15-commissions-other", RATES);
  await eligibleLines(sw, "O15 seller agency", s, RATES, [{ basisCents: 40_000n, poolCents: 40_000n }]);
  await eligibleLines(sw, "O15 other agency", other, RATES, [{ basisCents: 90_000n, poolCents: 90_000n }]);
  completed((await closeMonth(sw, "2026-09")).reply, 200);
  mine = (await statementsOfSeller(sw, s.sellerId))[0]!.statement_id;
  theirs = (await statementsOfSeller(sw, other.sellerId))[0]!.statement_id;
});
after(async () => {
  await sw.stop();
});

const w = () => sw.w;
const get = (url: string, who: Person, agency: string | null = null): Promise<Reply> => call(w(), { method: "GET", url, token: who.token, agency, key: null, contentType: null });
/** A reply stripped of what legitimately differs between two requests: the correlation id (body and header) and the date. */
function shape(reply: Reply): unknown {
  const { correlationId: _c, ...problem } = asProblem(w(), reply);
  const { "x-correlation-id": _h, date: _d, ...headers } = reply.headers;
  return { status: reply.status, problem, headers };
}

test("O15 §4: the seller who opens Commissions reads its own home and statement only; another seller's statement answers like one nobody holds; the owner reads both", async () => {
  const home = await get("/api/v1/sales/home", s.person);
  assert.equal(home.status, 200, home.text);
  assert.equal(home.json<{ data: { sellerState: string } }>().data.sellerState, "ACTIVE");

  const own = await readStatement(sw, mine, s.person.token);
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json<{ data: { sellerId: string } }>().data.sellerId, s.sellerId);
  for (const secret of [other.sellerId, other.destinationDigest, theirs]) assert.ok(!own.text.includes(secret), "the seller's own statement names nothing of the other seller");

  const foreign = await readStatement(sw, theirs, s.person.token);
  const nowhere = await readStatement(sw, ids.next(), s.person.token);
  assert.equal(outcome(w(), foreign), "404 NOT_FOUND -");
  assert.deepEqual(shape(foreign), shape(nowhere), "another seller's statement and an id nobody holds answer alike");

  // an agency selector changes nothing on a corporate read: never another seller's statement, never more than its own
  for (const agency of [w().A.agencyId, w().B.agencyId]) {
    const selected = await get(`/api/v1/sales/statements/${theirs}`, s.person, agency);
    assert.ok(selected.status === 404 || selected.status === 400, `the selector reaches nothing: ${selected.status} ${selected.text}`);
    assert.ok(!selected.text.includes(other.sellerId), "nothing of the other seller");
    const ownSelected = await get(`/api/v1/sales/statements/${mine}`, s.person, agency);
    assert.ok(ownSelected.status === 200 || ownSelected.status === 400, `its own statement under a selector: ${ownSelected.status}`);
  }

  // the control: the owner is the owner and reads both
  assert.equal((await readStatement(sw, mine, sw.owner.token)).status, 200);
  assert.equal((await readStatement(sw, theirs, sw.owner.token)).status, 200);
});

test("O15 §4: from Commissions the seller never acts as the owner — its own payout, another's, the owner's finance, refunds, sellers and outreach reviews all refuse it by its corporate role, and nothing is written", async () => {
  const journalBefore = await w().count("command_journal");
  const intentsBefore = await w().count("payout_intents");
  const proof = await w().stepUp(s.person);
  const owned = [
    call(w(), { url: `/api/v1/sales/statements/${mine}/approve-payout`, token: s.person.token, agency: null, key: freshKey("o15-own-payout"), body: { expectedVersion: 1, payeeRef: s.destinationId, authorizationRef: proof } }),
    call(w(), { url: `/api/v1/sales/statements/${theirs}/approve-payout`, token: s.person.token, agency: null, key: freshKey("o15-their-payout"), body: { expectedVersion: 1, payeeRef: s.destinationId, authorizationRef: proof } }),
    get("/api/v1/operations/bank-credits", s.person),
    get(`/api/v1/operations/refunds/${ids.next()}`, s.person),
    get(`/api/v1/ops/outreach/reviews/${ids.next()}`, s.person),
    call(w(), { url: "/api/v1/ops/sales/sellers", token: s.person.token, agency: null, key: freshKey("o15-register"), body: { userId: s.userId, displayLabel: "Self promotion" } }),
    call(w(), { url: `/api/v1/sales/sellers/${other.sellerId}/terminate`, token: s.person.token, agency: null, key: freshKey("o15-terminate"), body: { expectedVersion: 1, terminationTermsRef: ids.next(), activeOpportunityManifestRef: ids.next() } }),
  ];
  for (const reply of await Promise.all(owned)) {
    const p = asProblem(w(), reply);
    assert.ok(reply.status === 403 && p.reason === "CORPORATE_ROLE_MISSING", `refused by the corporate role: ${reply.status} ${reply.text}`);
  }
  assert.equal(await w().count("command_journal"), journalBefore, "no journal entry");
  assert.equal(await w().count("payout_intents"), intentsBefore, "no payout intent");
});

test("O15 §4 states control: an ACTIVE seller passes the corporate-role check of prospect work that the other states fail", async () => {
  const register = await call(w(), { url: "/api/v1/sales/prospects", token: s.person.token, agency: null, key: freshKey("o15-active-prospect"), body: { organizationLabel: "o15-active.example", businessContactRef: ids.next(), sourceEvidenceHash: "b".repeat(64), jurisdiction: "United States" } });
  assert.notEqual(register.status >= 400 ? asProblem(w(), register).reason : null, "CORPORATE_ROLE_MISSING", register.text);
});

test("O15 §4 states: a SUSPENDED and a TERMINATED seller keep their home (R2-066) and reach neither another seller's statement, an owner action nor prospect work", async () => {
  const RATES = { firstBps: 10_000, repeatBps: 400 } as const;
  const suspended = await seller(sw, "o15-commissions-suspended", RATES);
  const terminated = await seller(sw, "o15-commissions-terminated", RATES);
  await asOperator(w().h, sw.owner.userId, async (c) => {
    await c.query("UPDATE kauro.sellers SET state = 'SUSPENDED', version = version + 1 WHERE seller_id = $1", [suspended.sellerId]);
  });
  await terminateDirectly(w().h, sw.owner.userId as UserId, terminated.sellerId);
  for (const who of [suspended, terminated]) {
    assert.equal((await get("/api/v1/sales/home", who.person)).status, 200, "its home");
    assert.equal(outcome(w(), await readStatement(sw, theirs, who.person.token)), "404 NOT_FOUND -", "another seller's statement");
    const payout = await call(w(), { url: `/api/v1/sales/statements/${theirs}/approve-payout`, token: who.person.token, agency: null, key: freshKey("o15-state-payout"), body: { expectedVersion: 1, payeeRef: who.destinationId, authorizationRef: await w().stepUp(who.person) } });
    assert.equal(outcome(w(), payout), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
    // prospect work needs an ACTIVE seller
    const register = await call(w(), { url: "/api/v1/sales/prospects", token: who.person.token, agency: null, key: freshKey("o15-state-prospect"), body: { organizationLabel: "o15-state.example", businessContactRef: ids.next(), sourceEvidenceHash: "b".repeat(64), jurisdiction: "United States" } });
    assert.equal(outcome(w(), register), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  }
});

test("O15 §4 database: under the seller's own runtime session (OPERATOR, kauro_app) the other seller's statement and items are invisible, and the owner's session sees both", async () => {
  const visible = (userId: string, statementId: string) =>
    asOperator(w().h, userId, async (c) => ({
      statements: Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.commission_statements WHERE statement_id = $1", [statementId])).rows[0]?.n),
      items: Number((await c.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.statement_items WHERE statement_id = $1", [statementId])).rows[0]?.n),
    }));
  const own = await visible(s.userId, mine);
  assert.ok(own.statements === 1 && own.items >= 1, `the seller sees its own statement: ${JSON.stringify(own)}`);
  assert.deepEqual(await visible(s.userId, theirs), { statements: 0, items: 0 }, "the other seller's statement is not visible to the seller's session");
  const owners = await visible(sw.owner.userId, theirs);
  assert.ok(owners.statements === 1 && owners.items >= 1, `the owner's session sees it: ${JSON.stringify(owners)}`);
});
