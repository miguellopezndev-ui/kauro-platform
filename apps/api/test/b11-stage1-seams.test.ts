// B11 stage-1 integration (INT-1) — the seams where B11's mandates meet the B07+B09 candidate they were not built on
// (docs/design/B11-agency-app.md section 12, the INT-1 rows). Each test fails without its seam's fix: W2's session boundary was
// written against B06's routes only, so the routes B07 and B09 serve had to answer its CSRF rule and its ambiguous-credential
// refusal too. Real routes, the real composition root with the session boundary bound, a real PostgreSQL 17 cluster; the identity
// provider is W2's contract fake (ContractFakeIdentityIssuer, CONTRACT_FAKE, SIMULATED).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { paymentRoutes } from "./commerce-support.js";
import { sourceRoutes } from "./source-support.js";
import { call, freshKey, outcome, sha, world, type BrowserSession, type Reply, type World } from "./support.js";

let w: World;
before(async () => {
  w = await world({ sessions: true });
});
after(async () => {
  await w.stop();
});

/** An unsafe browser request under a session: the cookie, an Origin and (unless withheld) the session's CSRF token. */
function unsafe(s: BrowserSession, c: { readonly url: string; readonly body: unknown; readonly key: string | null; readonly origin?: string | null; readonly csrf?: string | null; readonly bearer?: string }): Promise<Reply> {
  const headers: Record<string, string> = { cookie: s.cookie };
  const origin = c.origin === undefined ? w.identity().origin : c.origin;
  if (origin !== null) headers["origin"] = origin;
  const csrf = c.csrf === undefined ? s.view.csrfToken : c.csrf;
  if (csrf !== null) headers["x-kauro-csrf"] = csrf;
  if (c.bearer !== undefined) headers["authorization"] = `Bearer ${c.bearer}`;
  return call(w, { url: c.url, token: null, key: c.key, agency: w.A.agencyId, body: c.body, headers });
}

/** A selection manifest document that passes the intake's closed schema (its ids name nothing: the request never reaches the handler). */
function syntheticManifest(revisionId: string) {
  const fileId = randomUUID();
  const tableId = randomUUID();
  return {
    schemaVersion: 1,
    revisionId,
    inventoryHash: sha("inventory"),
    files: [{ fileId, origin: "THIS_REVISION", disposition: "INCLUDE" }],
    tables: [{ tableId, fileId, structureHash: sha("structure"), disposition: "INCLUDE", parser: { kind: "CSV", encoding: "UTF_8", delimiter: "COMMA", quote: "DOUBLE_QUOTE", header: { mode: "FIRST_RECORD" }, blankLines: "SKIP" } }],
    projections: [{ projectionKey: "CONTACT_0", tableId, objectKind: "CONTACT", kind: "ROW", fieldOrdinals: [0, 1] }],
    associations: [],
  };
}

test("B11 INT-1 seam, the session boundary across B07 and B09 (D-AUTH-5): an unsafe request the session cookie authenticates — a B07 command, the B07 selection manifest intake, a B09 payment command — is refused ORIGIN_REJECTED or CSRF_TOKEN_INVALID before its journal and its handler, a cookie beside a bearer token is AMBIGUOUS_CREDENTIALS on each, and every refusal is an anonymous fact of its action", async () => {
  const s = await w.identity().signIn(w.owner);
  const revisionId = randomUUID();
  const routes: ReadonlyArray<{ readonly name: string; readonly action: string; readonly url: string; readonly body: unknown; readonly journaled: boolean }> = [
    { name: "CMD012 CreateRevision (B07)", action: "CMD012", url: sourceRoutes.createRevision(randomUUID()), body: { expectedVersion: 1, supersedesRevisionId: revisionId }, journaled: true },
    { name: "SubmitSelectionManifest (B07 intake)", action: "SUBMIT_SELECTION_MANIFEST", url: sourceRoutes.selectionManifests(revisionId), body: syntheticManifest(revisionId), journaled: false },
    { name: "CMD028 CreatePaymentOrder (B09)", action: "CMD028", url: paymentRoutes.createPaymentOrder(randomUUID()), body: { termsHash: sha("terms") }, journaled: true },
  ];
  const correlations: string[] = [];
  for (const r of routes) {
    const key = r.journaled ? freshKey("int1-seam") : null;
    const refusals: Array<[string, string, Reply]> = [
      ["another origin", "403 NOT_AUTHORIZED ORIGIN_REJECTED", await unsafe(s, { url: r.url, body: r.body, key, origin: "https://evil.example" })],
      ["no Origin", "403 NOT_AUTHORIZED ORIGIN_REJECTED", await unsafe(s, { url: r.url, body: r.body, key, origin: null })],
      ["no CSRF token", "403 NOT_AUTHORIZED CSRF_TOKEN_INVALID", await unsafe(s, { url: r.url, body: r.body, key, csrf: null })],
      ["a cookie beside a bearer token", "400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS", await unsafe(s, { url: r.url, body: r.body, key, bearer: w.owner.token })],
    ];
    for (const [what, expected, reply] of refusals) {
      assert.equal(outcome(w, reply), expected, `${r.name}: ${what}`);
      correlations.push(String(reply.headers["x-correlation-id"]));
    }
    if (key !== null) assert.equal(await w.journal(key), null, `${r.name}: no refusal reserves the idempotency key`);
    // the same request with the exact origin and the session's token is authenticated as the session's person and reaches the
    // route's own decision (the ids name nothing visible to agency A)
    const accepted = await unsafe(s, { url: r.url, body: r.body, key: r.journaled ? freshKey("int1-seam-ok") : null });
    assert.equal(accepted.status, 404, `${r.name}: authenticated, then not found (${accepted.text})`);
  }
  const facts = await w.h.oracle.query<{ action: string; reason_code: string; actor_kind: string; agency_id: string | null }>(
    "SELECT action, reason_code, actor_kind, agency_id FROM kauro.security_events WHERE correlation_id = ANY($1::uuid[]) ORDER BY occurred_at, security_event_id",
    [correlations],
  );
  assert.equal(facts.rows.length, correlations.length, "one durable fact per refusal");
  assert.ok(facts.rows.every((f) => f.actor_kind === "ANONYMOUS" && f.agency_id === null), "each refusal is anonymous: the request is not trusted to be the session's person");
  assert.deepEqual([...new Set(facts.rows.map((f) => f.action))].sort(), ["CMD012", "CMD028", "SUBMIT_SELECTION_MANIFEST"]);
  assert.deepEqual([...new Set(facts.rows.map((f) => f.reason_code))].sort(), ["AMBIGUOUS_CREDENTIALS", "CSRF_TOKEN_INVALID", "ORIGIN_REJECTED"]);
  assert.deepEqual(w.internalErrors, [], "no refusal was a response-contract violation");
});
