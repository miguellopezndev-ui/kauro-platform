// Lane L-ROUTE failure cells of the Payments V1 bank-transfer route (docs/design/ACH-ROUTE.md r12 §7.1-§7.3, §7.24 I2Δ, §7.29; cases
// ACH-01..03): route configuration and qualification (R1 details evidence read, R2 Kroute), transfer-instruction issuance (I1 readiness
// read, I2 Kinstructions) and the sensitive-instructions projection (I3). Written test-first (red on KIT a6e64be: no bank route command,
// route or table exists there). Each matrix cell is one test titled exactly `<VERB> ACH-M-<row>-<column> (<family>): <row label>` and run
// through the common fault harness (runCell): the fault must demonstrably happen at the boundary the cell names or the cell fails.
//
// THE CONTRACT these cells fix for the builder (the lane's own files; nothing here changes the vendored registry):
//   owner (KAURO_OWNER, step-up)  POST /api/v1/operations/bank-routes                         configure  -> 201 PENDING_VERIFICATION, version 1
//                                 POST /api/v1/operations/bank-routes/{id}/verify             R1 read of the stored details artifact, then Kroute -> VERIFIED
//                                 POST /api/v1/operations/bank-routes/{id}/enable             -> ENABLED, rollout CONTROLLED (participants) | GENERAL (§7.29)
//                                 POST /api/v1/operations/bank-routes/{id}/disable            -> VERIFIED
//                                 POST /api/v1/operations/bank-routes/{id}/details            details replaced: new version, PENDING_VERIFICATION
//                                 GET  /api/v1/operations/bank-routes/{id}
//   buyer (AGENCY_BILLING)        POST /api/v1/quotes/{quoteId}/payment-orders  { termsHash, routeKind: "BANK_TRANSFER", routeId }  (I1+I2)
//                                 GET  /api/v1/payment-orders/{orderId}/transfer-instructions  (I3, Cache-Control: no-store)
//   tables (migration R)          kauro.bank_routes, kauro.bank_route_versions, kauro.bank_route_participants, kauro.bank_transfer_instructions
//   The PaymentOrder registry states are NOT extended (coordinator constraint): the bank order state of BANK_ORDER_EXTENSION is read from
//   kauro.bank_transfer_instructions.order_state and the reply's `transfer.bankState`, never from payment_orders.state.
//   The details artifact is a CONTRACT_FAKE store artifact of kind ACCOUNT_DETAILS (format BANK_FAKE_FORMAT) the verify command reads from
//   the restricted store outside any transaction (V1: owner-supplied evidence, no provider fetch) and classifies.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BANK_FAKE_FORMAT, BANK_FAKE_PROVIDER } from "@kauro/application/testing";
import type { CreateQuoteView } from "@kauro/application";
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { connectionPid, crashedAt, openConnection, runCell, SimulatedCrash, type FaultContext, type FaultKind, type HarnessConnection } from "@kauro/persistence/testing";
import { bankWorld, type BankWorld } from "./bank-support.js";
import type { SqlStep } from "./fault-support.js";
import { agentOf, planOf, quoted, type Agent } from "./integration-support.js";
import { asProblem, call, completed, freshKey, type Reply } from "./support.js";

let bw: BankWorld;
before(async () => {
  bw = await bankWorld();
});
after(async () => {
  await bw?.stop();
});

// --- contract ---------------------------------------------------------------------------------------------------------------------

const OPS = "/api/v1/operations/bank-routes";
const bankRoutes = {
  configure: () => OPS,
  verify: (id: string) => `${OPS}/${id}/verify`,
  enable: (id: string) => `${OPS}/${id}/enable`,
  disable: (id: string) => `${OPS}/${id}/disable`,
  details: (id: string) => `${OPS}/${id}/details`,
  get: (id: string) => `${OPS}/${id}`,
  order: (quoteId: string) => `/api/v1/quotes/${quoteId}/payment-orders`,
  instructions: (orderId: string) => `/api/v1/payment-orders/${orderId}/transfer-instructions`,
};
interface RouteView {
  readonly routeId: string;
  readonly routeVersion: number;
  readonly state: "PENDING_VERIFICATION" | "VERIFIED" | "ENABLED" | "DISABLED";
  readonly rollout: "CONTROLLED" | "GENERAL" | null;
  readonly detailsEvidenceHash: string;
}
interface TransferView {
  readonly routeId: string;
  readonly routeVersion: number;
  readonly bankState: string;
  readonly reference: string;
  readonly transferExpiresAt: string;
  readonly sendBy: string;
}
interface IssuedView {
  readonly order: { readonly orderId: string; readonly expectedAmountCents: string | number };
  readonly transfer: TransferView;
}
interface InstructionsView {
  readonly instructions: { readonly beneficiaryName: string; readonly routingNumber: string; readonly accountNumber: string; readonly amountCents: string | number; readonly currency: string; readonly reference: string; readonly sendBy: string; readonly routeVersion: number };
}
const ROUTE_TABLES = ["bank_routes", "bank_route_versions", "bank_route_participants"] as const;
/** The 23-character canonical reference: `K`, 20 Crockford base32 symbols, 2 checksum symbols (D-ACH-04). */
const REFERENCE = /^K[0-9A-HJKMNP-TV-Z]{22}$/;
const ACCOUNT_DIGITS = "000000000000";

// --- world helpers ----------------------------------------------------------------------------------------------------------------

let seq = 0;
const q = async <T extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> => (await bw.iw.h.oracle.query<T>(sql, [...params])).rows;
const n = async (sql: string, params: ReadonlyArray<unknown> = []): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) x`, params))[0]!.n);
const open = (): Promise<HarnessConnection> => openConnection(bw.iw.h.pg.clientConfig("kauro_app_test"));
const code = (r: Reply): string => `${r.status} ${asProblem(bw.iw.w, r).code}`;

/** An owner-supplied account-details artifact in the restricted store (V1 R1 evidence) for a fresh account of this cell. */
async function detailsArtifact(accountRef: string, over: { readonly accountNumber?: string; readonly validUntil?: string; readonly routingNumber?: string | null } = {}): Promise<{ readonly artifactRef: string; readonly evidenceHash: string }> {
  const details = { accountRef, detailsVersion: `details-${++seq}`, currency: "USD", acceptedRails: ["ACH", "DOMESTIC_WIRE"], beneficiaryName: "Kauro Test Beneficiary", bankName: "Contract Fake Bank", routingNumber: over.routingNumber === undefined ? "026073150" : over.routingNumber, accountNumber: over.accountNumber ?? ACCOUNT_DIGITS, accountType: "CHECKING", validUntil: over.validUntil ?? new Date(Date.now() + 30 * 86_400_000).toISOString() };
  const { artifactRef, sha256 } = await bw.evidence.put({ bytes: new TextEncoder().encode(JSON.stringify({ format: BANK_FAKE_FORMAT, kind: "ACCOUNT_DETAILS", accountRef, details })), accountRef: accountRef as never });
  return { artifactRef, evidenceHash: sha256 };
}

interface Cfg {
  readonly accountRef: string;
  readonly windowMs?: number;
  readonly lifetimeMs?: number;
}
const configureBody = async (cfg: Cfg) => {
  const d = await detailsArtifact(cfg.accountRef);
  return { provider: BANK_FAKE_PROVIDER, environment: bw.environment, accountRef: cfg.accountRef, currency: "USD", acceptedRails: ["ACH", "DOMESTIC_WIRE"], detailsArtifactRef: d.artifactRef, detailsEvidenceHash: d.evidenceHash, minimumTransferWindowMs: cfg.windowMs ?? 4 * 86_400_000, instructionLifetimeMs: cfg.lifetimeMs ?? 10 * 86_400_000, providerTimeToleranceMs: 86_400_000, feePolicyVersion: "bank-fee-v1", timingSource: { url: "https://wise.com/help/articles/2827506", accessedOn: "2026-10-07" } };
};
const owner = (url: string, body: unknown, options: { readonly key?: string; readonly token?: string } = {}): Promise<Reply> =>
  call(bw.iw.w, { url, agency: null, token: options.token ?? bw.iw.owner.token, key: options.key ?? freshKey("bank-route"), body });
const proof = (freshness: "FRESH" | "STALE" = "FRESH") => bw.iw.w.stepUp(bw.iw.owner, freshness);

/** Runs `fn` with every unit of work it opens routed over `conn` (the harness connection), the cell's points around its COMMIT. */
const on = <T>(ctx: FaultContext, conn: HarnessConnection, fn: () => Promise<T>, steps: ReadonlyArray<SqlStep> = []): Promise<T> => bw.iw.faults.on(conn, "kauro_app", ctx.points, steps, fn);

const nextAccount = (label: string): string => `acct-route-${label}-${++seq}`;
async function configured(label: string, cfg: Partial<Cfg> = {}): Promise<RouteView> {
  const reply = completed<{ route: RouteView }>(await owner(bankRoutes.configure(), await configureBody({ accountRef: nextAccount(label), ...cfg })), 201);
  assert.equal(reply.data.route.state, "PENDING_VERIFICATION", "configure starts unqualified");
  assert.equal(reply.data.route.routeVersion, 1);
  return reply.data.route;
}
const verifyBody = async (r: RouteView, expectedVersion = r.routeVersion) => ({ expectedVersion, verificationEvidenceRef: `kyc-review-${r.routeId}`, authorizationRef: await proof() });
async function verified(label: string, cfg: Partial<Cfg> = {}): Promise<RouteView> {
  const r = await configured(label, cfg);
  return completed<{ route: RouteView }>(await owner(bankRoutes.verify(r.routeId), await verifyBody(r)), 200).data.route;
}
const enableBody = async (r: RouteView, participants: ReadonlyArray<string>, rollout: "CONTROLLED" | "GENERAL" = "CONTROLLED") => ({ expectedVersion: r.routeVersion, rollout, participants, authorizationRef: await proof() });
async function enabled(label: string, participants: ReadonlyArray<string>, cfg: Partial<Cfg> = {}): Promise<RouteView> {
  const r = await verified(label, cfg);
  const e = completed<{ route: RouteView }>(await owner(bankRoutes.enable(r.routeId), await enableBody(r, participants)), 200).data.route;
  assert.deepEqual([e.state, e.rollout], ["ENABLED", "CONTROLLED"]);
  return e;
}
const disableBody = async (r: RouteView) => ({ expectedVersion: r.routeVersion, authorizationRef: await proof() });
async function routeRow(routeId: string): Promise<{ state: string; rollout: string | null; current_version: number; versions: number; events: number }> {
  const [row] = await q<{ state: string; rollout: string | null; current_version: number }>("SELECT state, rollout, current_version FROM kauro.bank_routes WHERE route_id = $1", [routeId]);
  assert.ok(row !== undefined, `route ${routeId} exists`);
  return { ...row, versions: await n("SELECT 1 FROM kauro.bank_route_versions WHERE route_id = $1", [routeId]), events: await n("SELECT 1 FROM kauro.domain_events WHERE aggregate_id::text = $1", [routeId]) };
}
const routesOf = (accountRef: string): Promise<number> => n("SELECT 1 FROM kauro.bank_routes WHERE account_ref = $1", [accountRef]);

/** A buyer with an approved plan and an issued quote: an agency's billing member. */
async function buyer(label: string): Promise<{ readonly a: Agent; readonly quote: CreateQuoteView }> {
  const a = await agentOf(bw.iw, `${label}-${++seq}`);
  const plan = await planOf(bw.iw, a, `${label}-plan`);
  return { a, quote: await quoted(bw.iw, a, plan) };
}
const issueBody = (b: { readonly quote: CreateQuoteView }, r: RouteView) => ({ termsHash: b.quote.quote.termsHash, routeKind: "BANK_TRANSFER", routeId: r.routeId });
const issue = (b: { readonly a: Agent; readonly quote: CreateQuoteView }, r: RouteView, options: { readonly key?: string; readonly body?: unknown; readonly token?: string } = {}): Promise<Reply> =>
  call(bw.iw.w, { url: bankRoutes.order(b.quote.quote.quoteId), token: options.token ?? b.a.billing.token, agency: b.a.s.agency.agencyId, key: options.key ?? freshKey("bank-issue"), body: options.body ?? issueBody(b, r) });
const readInstructions = (b: { readonly a: Agent }, orderId: string, token = b.a.billing.token, agency = b.a.s.agency.agencyId): Promise<Reply> =>
  call(bw.iw.w, { method: "GET", url: bankRoutes.instructions(orderId), token, agency, key: null, contentType: null });
/** What issuance wrote for a project: orders, instruction snapshots, accepted quotes, order events. */
async function issuedFootprint(projectId: string): Promise<{ orders: number; instructions: number; accepted: number; events: number }> {
  return {
    orders: await n("SELECT 1 FROM kauro.payment_orders WHERE project_id::text = $1", [projectId]),
    instructions: await n("SELECT 1 FROM kauro.bank_transfer_instructions i JOIN kauro.payment_orders o ON o.order_id = i.order_id WHERE o.project_id::text = $1", [projectId]),
    accepted: await n("SELECT 1 FROM kauro.quotes WHERE project_id::text = $1 AND state = 'ACCEPTED'", [projectId]),
    events: await n("SELECT 1 FROM kauro.domain_events e JOIN kauro.payment_orders o ON o.order_id::text = e.aggregate_id::text WHERE o.project_id::text = $1", [projectId]),
  };
}
const NOTHING_ISSUED = { orders: 0, instructions: 0, accepted: 0, events: 0 };
const projectOf = (b: { readonly quote: CreateQuoteView }): string => (b.quote.quote as unknown as { projectId: string }).projectId;
const noAccountDigits = (r: Reply, what: string): void => {
  assert.ok(!r.text.includes(ACCOUNT_DIGITS) && !r.text.includes("026073150"), `${what}: no account or routing number in the body`);
};

/** Replaces the store's read for the cell: `hook` runs before every read of `artifactRef` (pause, delay, crash); restored after. */
async function withStoreHook<T>(artifactRef: string | null, hook: () => Promise<void>, fn: () => Promise<T>): Promise<T> {
  const store = bw.evidence as unknown as { get: (ref: string) => Promise<unknown> };
  const real = store.get;
  store.get = async (ref: string) => {
    if (artifactRef === null || ref === artifactRef) await hook();
    return real.call(bw.evidence, ref);
  };
  try {
    return await fn();
  } finally {
    store.get = real;
  }
}
const detailsRefOf = async (routeId: string): Promise<string> => (await q<{ details_artifact_ref: string }>("SELECT details_artifact_ref FROM kauro.bank_route_versions WHERE route_id = $1 ORDER BY route_version DESC LIMIT 1", [routeId]))[0]!.details_artifact_ref;

/** Holder command paused at `at` on its own connection; waiter observed (pg_stat_activity) blocked by it; holder released. */
async function holdAndWait<H, W>(ctx: FaultContext, what: string, holder: () => Promise<H>, waiter: () => Promise<W>, at = "uow.before-commit"): Promise<{ held: PromiseSettledResult<H>; waited: PromiseSettledResult<W> }> {
  const hc = await open();
  const wc = await open();
  try {
    const pause = ctx.points.pause(at);
    const running = ctx.operation(`${what} (holder)`, () => on(ctx, hc, holder));
    const heldP = running.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
    await pause.reachedBy(running);
    const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, () => on(ctx, wc, waiter), what);
    pause.release();
    return { held: await heldP, waited: await waiting.pending };
  } finally {
    await hc.end();
    await wc.end();
  }
}
const ok = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};

/** One matrix cell with its exact design title, run by the harness (fault evidence enforced). */
function cell(title: string, fault: FaultKind, body: (ctx: FaultContext) => Promise<void>, at?: string): void {
  const id = title.split(" ")[1]!;
  test(title, async () => {
    await runCell({ id, step: title.slice(title.indexOf(": ") + 2), fault, ...(at === undefined ? {} : { at }), expect: title }, body);
  });
}
const R1 = "Read and classify owner-supplied account-details evidence";
const R2 = "Configure, verify, enable or disable a bank-transfer route";
const I1 = "Read checkout readiness under the subject locks";
const I2 = "Issue transfer instructions";
const I3 = "Read sensitive transfer instructions";

// === R1: the details evidence read (an await outside any transaction; no route write) ================================================

cell(`RACE ACH-M-R1-RACE (concurrency): ${R1}`, "race", async (ctx) => {
  // both orders at the route lock: the verify that read version-1 details and a replacement of the details
  for (const first of ["verify", "replace"] as const) {
    const r = await configured(`r1race-${first}`);
    const replacement = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref, { accountNumber: "111111111111" });
    const verify = async () => owner(bankRoutes.verify(r.routeId), await verifyBody(r));
    const replace = async () => owner(bankRoutes.details(r.routeId), { expectedVersion: 1, detailsArtifactRef: replacement.artifactRef, detailsEvidenceHash: replacement.evidenceHash, authorizationRef: await proof() });
    const { held, waited } = first === "verify" ? await holdAndWait(ctx, "replace waits for the verify", verify, replace) : await holdAndWait(ctx, "verify waits for the replacement", replace, verify);
    const v = ok(first === "verify" ? held : waited);
    const x = ok(first === "verify" ? waited : held);
    if (first === "verify") {
      assert.equal(v.status, 200, "the verify that held the lock bound version 1");
      assert.equal(x.status, 200, "the replacement after it commits");
    } else {
      assert.equal(x.status, 200, "the replacement that held the lock commits");
      assert.equal(code(v), "409 ROUTE_VERSION_CHANGED", "the verify that read stale details is refused");
    }
    const row = await routeRow(r.routeId);
    assert.deepEqual([row.state, row.current_version, row.versions], ["PENDING_VERIFICATION", 2, 2], `${first} first: the current version is the replacement, unqualified`);
    assert.equal((await q<{ h: string }>("SELECT details_evidence_hash AS h FROM kauro.bank_route_versions WHERE route_id = $1 AND route_version = 2", [r.routeId]))[0]!.h, replacement.evidenceHash);
  }
});

cell(`RACE ACH-M-R1-TIMEOUT (time): ${R1}`, "timeout", async (ctx) => {
  const r = await configured("r1timeout");
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  const reply = await withStoreHook(await detailsRefOf(r.routeId), () => stalled, () =>
    ctx.operation("verify whose details read never answers", async (op) => {
      const started = op.clock.nowMs();
      ctx.deadline(started + PROVIDER_CALL_TIMEOUT_MS, "details read bound");
      const pending = owner(bankRoutes.verify(r.routeId), await verifyBody(r));
      ctx.clock.advance(PROVIDER_CALL_TIMEOUT_MS + 1);
      const out = await pending;
      release();
      return out;
    }),
  );
  assert.equal(code(reply), "503 EVIDENCE_UNAVAILABLE", "the bound fired: no qualification on an unknown read");
  const row = await routeRow(r.routeId);
  assert.deepEqual([row.state, row.current_version, row.versions], ["PENDING_VERIFICATION", 1, 1]);
});

cell(`DENY ACH-M-R1-EXPIRY (time): ${R1}`, "expiry", async (ctx) => {
  const r = await configured("r1expiry");
  const ref = await detailsRefOf(r.routeId);
  const validUntil = (JSON.parse(new TextDecoder().decode((await bw.evidence.get(ref))!.bytes)) as { details: { validUntil: string } }).details.validUntil;
  const reply = await ctx.operation("verify while the details validity passes", async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      ctx.clock.set(Date.parse(validUntil) - 1);
      const boundary = ctx.deadline(validUntil, "details validity");
      return await withStoreHook(ref, async () => void ctx.clock.set(Date.parse(boundary) + 1), async () => owner(bankRoutes.verify(r.routeId), await verifyBody(r)));
    } finally {
      bw.iw.faults.clock = null;
    }
  });
  assert.equal(code(reply), "409 DETAILS_EXPIRED", "expired details never qualify");
  assert.deepEqual((({ state, versions, events }) => [state, versions, events])(await routeRow(r.routeId)), ["PENDING_VERIFICATION", 1, 1]);
});

test(`RACE ACH-M-R1-CRASH-BEFORE (crash): ${R1}`, async () => {
  // a read row: the crash fires immediately before the details await; nothing exists and the retry is read-only
  const r = await configured("r1crashb");
  const ref = await detailsRefOf(r.routeId);
  const before = bw.evidence.calls.filter((c) => c.identity === ref && c.operation === "GET").length;
  const crashed = await withStoreHook(ref, async () => {
    throw new SimulatedCrash("details-store.get.before");
  }, async () => owner(bankRoutes.verify(r.routeId), await verifyBody(r)));
  assert.equal(crashed.status, 500, "the verify died before its details await");
  assert.ok(crashedAt("details-store.get.before")(bw.iw.w.internalErrors.at(-1)?.error), "the crash is the injected one");
  assert.equal(bw.evidence.calls.filter((c) => c.identity === ref && c.operation === "GET").length, before, "the store was never read");
  assert.deepEqual((({ state, versions, events }) => [state, versions, events])(await routeRow(r.routeId)), ["PENDING_VERIFICATION", 1, 1], "no route fact");
  assert.equal(completed<{ route: RouteView }>(await owner(bankRoutes.verify(r.routeId), await verifyBody(r)), 200).data.route.state, "VERIFIED", "the retry reads again and qualifies");
});

cell(`RACE ACH-M-R1-CRASH-AFTER (crash): ${R1}`, "crash-before-commit", async (ctx) => {
  // the answer of the details read is lost: the crash fires after the read, before Kroute commits; recovery refetches, no automatic qualification
  const r = await configured("r1crasha");
  const ref = await detailsRefOf(r.routeId);
  const key = freshKey("r1crasha");
  const body = await verifyBody(r);
  const crash = ctx.points.crash("uow.before-commit");
  const conn = await open();
  try {
    const lost = await ctx.operation("verify lost after its details read", () => on(ctx, conn, () => owner(bankRoutes.verify(r.routeId), body, { key })));
    await crash.reached;
    assert.equal(lost.status, 500);
  } finally {
    await conn.end();
  }
  assert.deepEqual((({ state, versions }) => [state, versions])(await routeRow(r.routeId)), ["PENDING_VERIFICATION", 1], "nothing qualified");
  const reads = bw.evidence.calls.filter((c) => c.identity === ref && c.operation === "GET").length;
  const again = completed<{ route: RouteView }>(await owner(bankRoutes.verify(r.routeId), body, { key }), 200);
  assert.equal(again.replayed, false, "nothing committed to replay");
  assert.equal(bw.evidence.calls.filter((c) => c.identity === ref && c.operation === "GET").length, reads + 1, "the recovery refetched the details");
  assert.equal(again.data.route.state, "VERIFIED");
}, "uow");

test(`OK ACH-M-R1-RETRY (retry): ${R1}`, async () => {
  const r = await configured("r1retry");
  const ref = await detailsRefOf(r.routeId);
  const key = freshKey("r1retry");
  const body = await verifyBody(r);
  const first = completed<{ route: RouteView }>(await owner(bankRoutes.verify(r.routeId), body, { key }), 200);
  const again = completed<{ route: RouteView }>(await owner(bankRoutes.verify(r.routeId), body, { key }), 200);
  assert.deepEqual([again.replayed, again.data.route.routeVersion, again.data.route.state], [true, first.data.route.routeVersion, "VERIFIED"], "identical replay: same answer, no second qualification");
  assert.equal(bw.evidence.calls.filter((c) => c.identity === ref && c.operation === "GET").length >= 1, true);
  // same key, different body (another account binding): conflict, nothing changes
  const other = await detailsArtifact(nextAccount("r1retry-other"));
  assert.equal(code(await owner(bankRoutes.verify(r.routeId), { ...body, verificationEvidenceRef: other.artifactRef }, { key })), "409 IDEMPOTENCY_KEY_REUSED");
  // conflicting account binding: a details artifact of another account never qualifies this route
  const r2 = await configured("r1retry-bind");
  const foreign = await detailsArtifact(nextAccount("foreign"));
  assert.equal(code(await owner(bankRoutes.details(r2.routeId), { expectedVersion: 1, detailsArtifactRef: foreign.artifactRef, detailsEvidenceHash: foreign.evidenceHash, authorizationRef: await proof() })), "409 DETAILS_ACCOUNT_MISMATCH");
  assert.deepEqual((({ state, versions, events }) => [state, versions, events])(await routeRow(r.routeId)), ["VERIFIED", 1, 2]);
});

cell(`DENY ACH-M-R1-REVOCATION (revocation): ${R1}`, "revocation", async (ctx) => {
  // each prerequisite withdrawn while the details read is held: the details artifact, the owner's step-up, the account binding
  const withdrawals: ReadonlyArray<readonly [string, (r: RouteView, ref: string) => Promise<unknown>, string]> = [
    ["details artifact corrupted", async (_r, ref) => bw.evidence.corrupt(ref, new TextEncoder().encode("{}")), "409 HASH_MISMATCH"],
    ["details replaced", async (r) => {
      const d = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref, { accountNumber: "222222222222" });
      return completed(await owner(bankRoutes.details(r.routeId), { expectedVersion: 1, detailsArtifactRef: d.artifactRef, detailsEvidenceHash: d.evidenceHash, authorizationRef: await proof() }), 200);
    }, "409 ROUTE_VERSION_CHANGED"],
    ["route disabled for safety", async (r) => bw.iw.h.oracle.query("UPDATE kauro.bank_routes SET state = 'DISABLED' WHERE route_id = $1", [r.routeId]), "409 ROUTE_NOT_VERIFIABLE"],
  ];
  for (const [what, withdraw, refusal] of withdrawals) {
    const r = await configured(`r1rev-${what.split(" ")[1]}`);
    const ref = await detailsRefOf(r.routeId);
    let reached!: () => void;
    let go!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    const body = await verifyBody(r);
    const running = withStoreHook(ref, async () => {
      reached();
      await released;
    }, () => ctx.operation(`verify held at its details read (${what})`, () => owner(bankRoutes.verify(r.routeId), body)));
    await atRead;
    await ctx.revoked(what, () => withdraw(r, ref));
    go();
    await ctx.fenced(`verify after ${what}`, async () => {
      const reply = await running;
      if (reply.status < 400) throw new Error(`${what}: verify answered ${reply.status}`);
      throw reply;
    }, (e) => (e as Reply).status >= 400 && code(e as Reply) === refusal);
    assert.notEqual((await routeRow(r.routeId)).state, "VERIFIED", `${what}: withdrawn evidence never qualifies`);
  }
});

cell(`RACE ACH-M-R1-PARTIAL (partial): ${R1}`, "partial", async (ctx) => {
  // the account number reads, a later field does not: no partial snapshot, the route unqualified
  const r = await configured("r1partial");
  const broken = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref, { routingNumber: null });
  const replaced = completed<{ route: RouteView }>(await owner(bankRoutes.details(r.routeId), { expectedVersion: 1, detailsArtifactRef: broken.artifactRef, detailsEvidenceHash: broken.evidenceHash, authorizationRef: await proof() }), 200).data.route;
  const conn = await open();
  try {
    await ctx.partial("verify of incomplete details", "uow.before-commit", () => on(ctx, conn, async () => {
      const reply = await owner(bankRoutes.verify(r.routeId), await verifyBody(replaced));
      if (reply.status >= 400) throw Object.assign(new Error(code(reply)), { reply });
      return reply;
    }));
  } catch {
    // the harness requires the failure at its point; the assertions below state what survived
  } finally {
    await conn.end();
  }
  const row = await routeRow(r.routeId);
  assert.deepEqual([row.state, row.current_version], ["PENDING_VERIFICATION", 2], "incomplete details leave the route unqualified");
  assert.equal(await n("SELECT 1 FROM kauro.bank_route_versions WHERE route_id = $1 AND verified_at IS NOT NULL", [r.routeId]), 0, "no verification fact");
});

// === R2: Kroute (route/config version, assurance fact, journal, events) ===============================================================

cell(`RACE ACH-M-R2-RACE (concurrency): ${R2}`, "race", async (ctx) => {
  const b = await buyer("r2race");
  for (const first of ["enable", "disable"] as const) {
    const r = await enabled(`r2race-${first}`, [b.a.s.agency.agencyId]);
    // enable a CONTROLLED route's participant change vs disable, both orders at the route lock
    const widen = async () => owner(bankRoutes.enable(r.routeId), await enableBody(r, [b.a.s.agency.agencyId, bw.iw.w.A.agencyId]));
    const stop = async () => owner(bankRoutes.disable(r.routeId), await disableBody(r));
    const { held, waited } = first === "enable" ? await holdAndWait(ctx, "disable waits for enable", widen, stop) : await holdAndWait(ctx, "enable waits for disable", stop, widen);
    const winner = ok(held);
    const loser = ok(waited);
    assert.equal(winner.status, 200, `${first} holding the lock commits`);
    assert.equal(code(loser), "409 ROUTE_VERSION_CHANGED", "the loser rechecks the version under the lock");
    const row = await routeRow(r.routeId);
    assert.equal(row.state, first === "enable" ? "ENABLED" : "VERIFIED", "only the committed version decides");
  }
});

cell(`RACE ACH-M-R2-TIMEOUT (time): ${R2}`, "timeout", async (ctx) => {
  const r = await verified("r2timeout");
  const key = freshKey("r2timeout");
  const body = await enableBody(r, [bw.iw.w.A.agencyId]);
  const holder = await open();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR UPDATE", [r.routeId]);
    bw.iw.faults.statementTimeoutMs = 200;
    const conn = await open();
    try {
      const timedOut = await ctx.attempt(() => ctx.operation("enable past its lock timeout", () => on(ctx, conn, () => owner(bankRoutes.enable(r.routeId), body, { key }))));
      assert.ok(timedOut.status === 503 || timedOut.status === 500, "the lock wait timed out");
    } finally {
      bw.iw.faults.statementTimeoutMs = null;
      await conn.end();
    }
  } finally {
    await holder.query("ROLLBACK");
    await holder.end();
  }
  assert.deepEqual((({ state, versions }) => [state, versions])(await routeRow(r.routeId)), ["VERIFIED", 1], "no assumed enabling");
  assert.notEqual((await bw.iw.w.journal(key))?.state, "COMMITTED");
  const recovered = completed<{ route: RouteView }>(await ctx.attempt(() => owner(bankRoutes.enable(r.routeId), body, { key })), 200);
  assert.deepEqual([recovered.data.route.state, (await routeRow(r.routeId)).events], ["ENABLED", 3], "same key recovers once: configure, verify, enable events");
});

cell(`DENY ACH-M-R2-EXPIRY (time): ${R2}`, "expiry", async (ctx) => {
  // the step-up proof crosses its freshness bound after the route lock wait; the effect clock is read after the wait
  const r = await verified("r2expiry");
  const body = await enableBody(r, [bw.iw.w.A.agencyId]);
  const proofAt = Date.parse((await q<{ at: string }>("SELECT issued_at::text AS at FROM kauro.assurance_proofs WHERE proof_id::text = $1", [body.authorizationRef]))[0]!.at);
  const reply = await ctx.operation("enable with a step-up that expires during the lock wait", async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      const boundary = ctx.deadline(proofAt + 15 * 60_000, "step-up freshness");
      const holder = await open();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR UPDATE", [r.routeId]);
      const wc = await open();
      ctx.clock.set(Date.parse(boundary) - 1);
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => owner(bankRoutes.enable(r.routeId), body)), "enable waits for the route lock");
      ctx.clock.set(Date.parse(boundary) + 1);
      await holder.query("ROLLBACK");
      await holder.end();
      const out = ok(await waiting.pending);
      await wc.end();
      return out;
    } finally {
      bw.iw.faults.clock = null;
    }
  });
  assert.equal(code(reply), "403 STEP_UP_REQUIRED", "a proof stale at the effect refuses");
  assert.deepEqual((({ state, versions, events }) => [state, versions, events])(await routeRow(r.routeId)), ["VERIFIED", 1, 2]);
});

cell(`RACE ACH-M-R2-CRASH-BEFORE (crash): ${R2}`, "crash-before-commit", async (ctx) => {
  const r = await verified("r2crashb");
  const key = freshKey("r2crashb");
  const body = await enableBody(r, [bw.iw.w.A.agencyId]);
  const crash = ctx.points.crash("uow.before-commit");
  const conn = await open();
  try {
    const died = await ctx.operation("enable dies before Kroute COMMIT", () => on(ctx, conn, () => owner(bankRoutes.enable(r.routeId), body, { key })));
    await crash.reached;
    assert.equal(died.status, 500);
  } finally {
    await conn.end();
  }
  const row = await routeRow(r.routeId);
  assert.deepEqual([row.state, row.rollout, row.current_version, row.versions, row.events], ["VERIFIED", null, 1, 1, 2], "every config write rolled back");
  assert.equal(await n("SELECT 1 FROM kauro.bank_route_participants WHERE route_id = $1", [r.routeId]), 0);
  assert.equal(await n("SELECT 1 FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE e.aggregate_id::text = $1 AND e.event_type LIKE 'bank_route.enabled%'", [r.routeId]), 0);
  assert.notEqual((await bw.iw.w.journal(key))?.state, "COMMITTED", "the journal rolled back with it");
}, "uow");

cell(`RACE ACH-M-R2-CRASH-AFTER (crash): ${R2}`, "crash-after-commit", async (ctx) => {
  const r = await verified("r2crasha");
  const key = freshKey("r2crasha");
  const body = await enableBody(r, [bw.iw.w.A.agencyId]);
  const crash = ctx.points.crash("uow.after-commit");
  const conn = await open();
  try {
    const lost = await ctx.operation("enable whose answer is lost", () => on(ctx, conn, () => owner(bankRoutes.enable(r.routeId), body, { key })));
    await crash.reached;
    assert.equal(lost.status, 500, "the caller got no answer");
  } finally {
    await conn.end();
  }
  assert.deepEqual([(await routeRow(r.routeId)).state, (await bw.iw.w.journal(key))?.state], ["ENABLED", "COMMITTED"], "Kroute committed");
  const again = completed<{ route: RouteView }>(await owner(bankRoutes.enable(r.routeId), body, { key }), 200);
  assert.deepEqual([again.replayed, again.data.route.state, again.data.route.rollout], [true, "ENABLED", "CONTROLLED"], "same key replays the committed version");
  assert.equal(await n("SELECT 1 FROM kauro.domain_events WHERE aggregate_id::text = $1 AND event_type LIKE 'bank_route.enabled%'", [r.routeId]), 1, "one enabling event");
}, "uow");

cell(`RACE ACH-M-R2-RETRY (retry): ${R2}`, "retry", async (ctx) => {
  const r = await verified("r2retry");
  const key = freshKey("r2retry");
  const body = await enableBody(r, [bw.iw.w.A.agencyId]);
  // identical concurrent replay: one enabling, both answers equal
  const both = await ctx.concurrently(2, () => owner(bankRoutes.enable(r.routeId), body, { key }));
  const replies = both.map((s) => ok(s));
  assert.deepEqual(replies.map((x) => x.status).sort(), [200, 200]);
  assert.deepEqual(replies.map((x) => completed<{ route: RouteView }>(x, 200).replayed).sort(), [false, true]);
  // the same key with another body (another participant list / account version): conflict
  const changed = await ctx.attempt(async () => owner(bankRoutes.enable(r.routeId), { ...body, participants: [bw.iw.w.B.agencyId] }, { key }));
  assert.equal(code(changed), "409 IDEMPOTENCY_KEY_REUSED");
  const row = await routeRow(r.routeId);
  assert.deepEqual([row.state, row.events], ["ENABLED", 3], "exactly one enabling");
  assert.deepEqual((await q<{ agency_id: string }>("SELECT agency_id::text FROM kauro.bank_route_participants WHERE route_id = $1", [r.routeId])).map((x) => x.agency_id), [bw.iw.w.A.agencyId], "the key binds the exact config");
});

cell(`DENY ACH-M-R2-REVOCATION (revocation): ${R2}`, "revocation", async (ctx) => {
  // each qualification prerequisite revoked separately while enable holds... is held behind the route lock: grant, step-up, details, verification
  const revocations: ReadonlyArray<readonly [string, (r: RouteView) => Promise<unknown>, string]> = [
    ["owner grant", async () => bw.iw.h.oracle.query("UPDATE kauro.corporate_grants SET state = 'REVOKED' WHERE user_id = $1 AND role = 'KAURO_OWNER'", [bw.iw.owner.userId]), "403 NOT_AUTHORIZED"],
    ["step-up proof", async () => bw.iw.h.oracle.query("UPDATE kauro.assurance_proofs SET revoked_at = now() WHERE user_id = $1", [bw.iw.owner.userId]), "403 STEP_UP_REQUIRED"],
    ["details evidence", async (r) => bw.evidence.corrupt(await detailsRefOf(r.routeId), new TextEncoder().encode("{}")), "409 HASH_MISMATCH"],
    ["verification", async (r) => bw.iw.h.oracle.query("UPDATE kauro.bank_routes SET state = 'PENDING_VERIFICATION' WHERE route_id = $1", [r.routeId]), "409 ROUTE_NOT_VERIFIED"],
  ];
  for (const [what, revoke, refusal] of revocations) {
    const r = await verified(`r2rev-${what.split(" ")[0]}`);
    const body = await enableBody(r, [bw.iw.w.A.agencyId]);
    const holder = await open();
    const wc = await open();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR UPDATE", [r.routeId]);
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => owner(bankRoutes.enable(r.routeId), body)), `enable held behind the route lock (${what})`);
      await ctx.revoked(what, () => revoke(r));
      await holder.query("ROLLBACK");
      await ctx.fenced(`enable after ${what}`, async () => {
        const reply = ok(await waiting.pending);
        throw reply;
      }, (e) => (e as Reply).status >= 400 && code(e as Reply) === refusal);
    } finally {
      await holder.end();
      await wc.end();
      await bw.iw.h.oracle.query("UPDATE kauro.corporate_grants SET state = 'ACTIVE' WHERE user_id = $1 AND role = 'KAURO_OWNER'", [bw.iw.owner.userId]);
    }
    const row = await routeRow(r.routeId);
    assert.notEqual(row.state, "ENABLED", `${what}: enable blocked`);
    assert.equal(await n("SELECT 1 FROM kauro.bank_route_participants WHERE route_id = $1", [r.routeId]), 0);
  }
  // a disable is retained whatever was revoked: the safety stop needs no qualification
  const live = await enabled("r2rev-disable", [bw.iw.w.A.agencyId]);
  await bw.evidence.corrupt(await detailsRefOf(live.routeId), new TextEncoder().encode("{}"));
  assert.equal(completed<{ route: RouteView }>(await owner(bankRoutes.disable(live.routeId), await disableBody(live)), 200).data.route.state, "VERIFIED");
});

cell(`RACE ACH-M-R2-PARTIAL (partial): ${R2}`, "partial", async (ctx) => {
  // fail each later write of the enable: participants, the version/state update, the event, the outbox, the journal
  const steps: ReadonlyArray<SqlStep> = [
    { label: "participants", match: /INSERT INTO kauro\.bank_route_participants/ },
    { label: "route_update", match: /UPDATE kauro\.bank_routes/ },
    { label: "event", match: /INSERT INTO kauro\.domain_events/ },
    { label: "outbox", match: /INSERT INTO kauro\.outbox_records/ },
    { label: "journal", match: /UPDATE kauro\.(request_journal|idempotency)/ },
  ];
  for (const step of steps) {
    const r = await verified(`r2partial-${step.label}`);
    const key = freshKey(`r2partial-${step.label}`);
    const body = await enableBody(r, [bw.iw.w.A.agencyId]);
    const conn = await open();
    try {
      await ctx.partial(`enable failing at ${step.label}`, `db.${step.label}.before`, async () => {
        const reply = await on(ctx, conn, () => owner(bankRoutes.enable(r.routeId), body, { key }), steps);
        if (reply.status >= 500) throw bw.iw.w.internalErrors.at(-1)?.error ?? new Error(String(reply.status));
        return reply;
      });
    } finally {
      await conn.end();
    }
    const row = await routeRow(r.routeId);
    assert.deepEqual([row.state, row.rollout, row.current_version, row.versions, row.events], ["VERIFIED", null, 1, 1, 2], `${step.label}: the full footprint rolled back`);
    assert.equal(await n("SELECT 1 FROM kauro.bank_route_participants WHERE route_id = $1", [r.routeId]), 0, `${step.label}: no participant`);
    assert.notEqual((await bw.iw.w.journal(key))?.state, "COMMITTED", `${step.label}: journal rolled back`);
    assert.equal(completed<{ route: RouteView }>(await owner(bankRoutes.enable(r.routeId), body, { key }), 200).data.route.state, "ENABLED", `${step.label}: the same-key retry completes once`);
  }
});

test("DENY ACH-M-R2-GENERAL (enable condition): rollout GENERAL is refused unless one payment has its credit reconciled and its own refund RECORDED with send evidence — a credit without its refund, a refund of another payment and a refund still DECLARED or UNCERTAIN are each refused; payer arrival is not required", async () => {
  // Expressible on L-ROUTE alone: GENERAL with no qualification payment, and with a qualification order that has no credit. The sub-cases
  // with a reconciled credit (P1/P2, lane L-INBOUND) and a refund attempt DECLARED/UNCERTAIN/RECORDED (X1/G2, lane L-REFUND) extend this
  // title once those commands exist (reported to the coordinator); every refusal leaves the route CONTROLLED with no version or event.
  const b = await buyer("r2general");
  const r = await enabled("r2general", [b.a.s.agency.agencyId]);
  const before = await routeRow(r.routeId);
  assert.equal(code(await owner(bankRoutes.enable(r.routeId), await enableBody(r, [], "GENERAL"))), "409 GENERAL_ENABLE_CONDITION_UNMET", "no qualification payment");
  const order = completed<IssuedView>(await issue(b, r), 201).data;
  assert.equal(code(await owner(bankRoutes.enable(r.routeId), { ...(await enableBody(r, [], "GENERAL")), qualificationOrderId: order.order.orderId })), "409 GENERAL_ENABLE_CONDITION_UNMET", "an order awaiting transfer: no reconciled credit");
  const after = await routeRow(r.routeId);
  assert.deepEqual([after.state, after.rollout, after.current_version, after.events], [before.state, "CONTROLLED", before.current_version, before.events], "refusals change nothing");
});

// === I1: the locked readiness read of the purchased subject, capacity and route ======================================================

cell(`RACE ACH-M-I1-RACE (concurrency): ${I1}`, "race", async (ctx) => {
  // the issuance and a route disable, both orders: the one that holds the lock decides; never instructions on a disabled route
  for (const first of ["issue", "disable"] as const) {
    const b = await buyer(`i1race-${first}`);
    const r = await enabled(`i1race-${first}`, [b.a.s.agency.agencyId]);
    const issuing = () => issue(b, r);
    const stopping = async () => owner(bankRoutes.disable(r.routeId), await disableBody(r));
    const { held, waited } = first === "issue" ? await holdAndWait(ctx, "disable waits for issuance", issuing, stopping) : await holdAndWait(ctx, "issuance waits for disable", stopping, issuing);
    const issued = ok(first === "issue" ? held : waited);
    const fp = await issuedFootprint(projectOf(b));
    if (first === "issue") {
      assert.equal(issued.status, 201);
      assert.deepEqual(fp, { orders: 1, instructions: 1, accepted: 1, events: fp.events });
      assert.equal(code(await readInstructions(b, completed<IssuedView>(issued, 201).data.order.orderId)), "409 ROUTE_NOT_ENABLED", "the order stays, its details are hidden");
    } else {
      assert.equal(code(issued), "409 ROUTE_NOT_ENABLED");
      assert.deepEqual(fp, NOTHING_ISSUED);
    }
  }
});

cell(`RACE ACH-M-I1-TIMEOUT (time): ${I1}`, "timeout", async (ctx) => {
  const b = await buyer("i1timeout");
  const r = await enabled("i1timeout", [b.a.s.agency.agencyId]);
  const holder = await open();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM kauro.projects WHERE project_id::text = $1 FOR UPDATE", [projectOf(b)]);
    bw.iw.faults.statementTimeoutMs = 200;
    const conn = await open();
    try {
      const reply = await ctx.attempt(() => ctx.operation("issuance whose readiness read times out", () => on(ctx, conn, () => issue(b, r))));
      assert.equal(code(reply), "503 TEMPORARILY_UNAVAILABLE", "unknown capacity is not permission: retryable refusal");
    } finally {
      bw.iw.faults.statementTimeoutMs = null;
      await conn.end();
    }
  } finally {
    await holder.query("ROLLBACK");
    await holder.end();
  }
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
});

cell(`DENY ACH-M-I1-EXPIRY (time): ${I1}`, "expiry", async (ctx) => {
  // the quote's price expiry crosses while the readiness read waits on the project lock
  const b = await buyer("i1expiry");
  const r = await enabled("i1expiry", [b.a.s.agency.agencyId]);
  const reply = await ctx.operation("issuance waiting while the price expires", async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      const boundary = ctx.deadline(b.quote.quote.expiresAt, "quote price expiry");
      ctx.clock.set(Date.parse(boundary) - 1);
      const holder = await open();
      const wc = await open();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.projects WHERE project_id::text = $1 FOR UPDATE", [projectOf(b)]);
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => issue(b, r)), "issuance waits for the project lock");
      ctx.clock.set(Date.parse(boundary) + 1);
      await holder.query("ROLLBACK");
      await holder.end();
      const out = ok(await waiting.pending);
      await wc.end();
      return out;
    } finally {
      bw.iw.faults.clock = null;
    }
  });
  assert.equal(code(reply), "409 QUOTE_EXPIRED", "the deadline read after the wait refuses");
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
});

cell(`RACE ACH-M-I1-CRASH-BEFORE (crash): ${I1}`, "crash-before-commit", async (ctx) => {
  const b = await buyer("i1crashb");
  const r = await enabled("i1crashb", [b.a.s.agency.agencyId]);
  const crash = ctx.points.crash("uow.before-commit");
  const conn = await open();
  try {
    const died = await ctx.operation("issuance dies with its read locks held", () => on(ctx, conn, () => issue(b, r)));
    await crash.reached;
    assert.equal(died.status, 500);
  } finally {
    await conn.end();
  }
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, "no instruction state exists");
  assert.equal(await n("SELECT 1 FROM pg_locks l JOIN kauro.projects p ON true WHERE p.project_id::text = $1 AND l.granted AND l.locktype = 'tuple'", [projectOf(b)]), 0, "the read locks were released");
}, "uow");

cell(`RACE ACH-M-I1-CRASH-AFTER (crash): ${I1}`, "crash-before-commit", async (ctx) => {
  // a crash after the readiness read, before Kinstructions commits; recovery repeats every check (a route disabled meanwhile refuses)
  const b = await buyer("i1crasha");
  const r = await enabled("i1crasha", [b.a.s.agency.agencyId]);
  const key = freshKey("i1crasha");
  const crash = ctx.points.crash("uow.before-commit");
  const conn = await open();
  try {
    await ctx.operation("issuance lost after its readiness read", () => on(ctx, conn, () => issue(b, r, { key })));
    await crash.reached;
  } finally {
    await conn.end();
  }
  completed(await owner(bankRoutes.disable(r.routeId), await disableBody(r)), 200);
  assert.equal(code(await issue(b, r, { key })), "409 ROUTE_NOT_ENABLED", "a prior read grants no authority");
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
}, "uow");

cell(`RACE ACH-M-I1-RETRY (retry): ${I1}`, "retry", async (ctx) => {
  const b = await buyer("i1retry");
  const r = await enabled("i1retry", [b.a.s.agency.agencyId]);
  const key = freshKey("i1retry");
  // the first attempt is refused (another agency's participant list), the prerequisites change, the read runs again under current guards
  completed(await owner(bankRoutes.disable(r.routeId), await disableBody(r)), 200);
  assert.equal(code(await ctx.attempt(() => issue(b, r, { key }))), "409 ROUTE_NOT_ENABLED");
  const again = completed<{ route: RouteView }>(await owner(bankRoutes.enable(r.routeId), await enableBody({ ...r, state: "VERIFIED" }, [b.a.s.agency.agencyId])), 200).data.route;
  const issued = completed<IssuedView>(await ctx.attempt(() => issue(b, again, { key: freshKey("i1retry-2") })), 201);
  assert.equal(issued.data.transfer.routeVersion, again.routeVersion, "the readiness read binds the current route version");
  assert.deepEqual(await issuedFootprint(projectOf(b)), { orders: 1, instructions: 1, accepted: 1, events: (await issuedFootprint(projectOf(b))).events });
});

cell(`DENY ACH-M-I1-REVOCATION (revocation): ${I1}`, "revocation", async (ctx) => {
  // each binding prerequisite withdrawn while the readiness read waits on the project lock
  const withdrawals: ReadonlyArray<readonly [string, (b: { a: Agent }, r: RouteView) => Promise<unknown>, string]> = [
    ["billing membership", async (b) => bw.iw.h.oracle.query("UPDATE kauro.memberships SET state = 'REVOKED' WHERE user_id = $1 AND agency_id = $2", [b.a.billing.userId, b.a.s.agency.agencyId]), "403 NOT_AUTHORIZED"],
    ["route participant", async (_b, r) => bw.iw.h.oracle.query("DELETE FROM kauro.bank_route_participants WHERE route_id = $1", [r.routeId]), "409 ROUTE_NOT_ENABLED"],
    ["route enabled state", async (_b, r) => bw.iw.h.oracle.query("UPDATE kauro.bank_routes SET state = 'VERIFIED' WHERE route_id = $1", [r.routeId]), "409 ROUTE_NOT_ENABLED"],
    ["plan approval", async (b) => bw.iw.h.oracle.query("UPDATE kauro.plans SET state = 'WITHDRAWN' WHERE project_id::text = $1", [projectOf(b as never)]), "409 PLAN_NOT_APPROVED"],
  ];
  for (const [what, withdraw, refusal] of withdrawals) {
    const b = await buyer(`i1rev-${what.split(" ")[1]}`);
    const r = await enabled(`i1rev-${what.split(" ")[1]}`, [b.a.s.agency.agencyId]);
    const holder = await open();
    const wc = await open();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.projects WHERE project_id::text = $1 FOR UPDATE", [projectOf(b)]);
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => issue(b, r)), `issuance held at readiness (${what})`);
      await holder.query("ROLLBACK");
      await ctx.revoked(what, () => withdraw(b, r));
      await ctx.fenced(`issuance after ${what}`, async () => {
        throw ok(await waiting.pending);
      }, (e) => code(e as Reply) === refusal);
    } finally {
      await holder.end();
      await wc.end();
    }
    assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, `${what}: nothing issued`);
  }
});

cell(`RACE ACH-M-I1-PARTIAL (partial): ${I1}`, "partial", async (ctx) => {
  // the second reader (route readiness) fails after the first (subject locks) succeeded: no writable footprint
  const b = await buyer("i1partial");
  const r = await enabled("i1partial", [b.a.s.agency.agencyId]);
  const steps: ReadonlyArray<SqlStep> = [{ label: "subject_lock", match: /FROM kauro\.projects/ }, { label: "route_read", match: /FROM kauro\.bank_routes/ }];
  const conn = await open();
  try {
    await ctx.partial("readiness failing at the route reader", "db.route_read.before", async () => {
      const reply = await on(ctx, conn, () => issue(b, r), steps);
      if (reply.status >= 500) throw bw.iw.w.internalErrors.at(-1)?.error ?? new Error(String(reply.status));
      return reply;
    });
  } finally {
    await conn.end();
  }
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
  assert.equal(completed<IssuedView>(await issue(b, r), 201).data.transfer.bankState, "AWAITING_TRANSFER", "a clean retry issues once");
});

// === I2: Kinstructions (journal, accepted quote, order, reference/snapshot, scopes, events/outbox) ==================================

cell(`RACE ACH-M-I2-RACE (concurrency): ${I2}`, "race", async (ctx) => {
  // two issuances of one project (two keys), both orders at the project lock: one order, one reference; the loser is refused
  for (const first of ["A", "B"] as const) {
    const b = await buyer(`i2race-${first}`);
    const r = await enabled(`i2race-${first}`, [b.a.s.agency.agencyId]);
    const { held, waited } = await holdAndWait(ctx, `issuance ${first === "A" ? "B" : "A"} waits`, () => issue(b, r, { key: freshKey(`i2-${first}`) }), () => issue(b, r, { key: freshKey(`i2-${first}-other`) }));
    assert.equal(ok(held).status, 201, "the holder issues");
    assert.equal(code(ok(waited)), "409 OPEN_ORDER_EXISTS", "no cross-route open duplicate");
    const fp = await issuedFootprint(projectOf(b));
    assert.deepEqual([fp.orders, fp.instructions, fp.accepted], [1, 1, 1]);
    assert.equal(await n("SELECT DISTINCT reference FROM kauro.bank_transfer_instructions i JOIN kauro.payment_orders o ON o.order_id = i.order_id WHERE o.project_id::text = $1", [projectOf(b)]), 1);
  }
});

cell(`RACE ACH-M-I2-TIMEOUT (time): ${I2}`, "timeout", async (ctx) => {
  const b = await buyer("i2timeout");
  const r = await enabled("i2timeout", [b.a.s.agency.agencyId]);
  const key = freshKey("i2timeout");
  const holder = await open();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR UPDATE", [r.routeId]);
    bw.iw.faults.statementTimeoutMs = 200;
    const conn = await open();
    try {
      const reply = await ctx.attempt(() => ctx.operation("issuance past its statement timeout", () => on(ctx, conn, () => issue(b, r, { key }))));
      assert.ok(reply.status >= 500, "timed out");
    } finally {
      bw.iw.faults.statementTimeoutMs = null;
      await conn.end();
    }
  } finally {
    await holder.query("ROLLBACK");
    await holder.end();
  }
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
  const recovered = completed<IssuedView>(await ctx.attempt(() => issue(b, r, { key })), 201);
  const replay = completed<IssuedView>(await issue(b, r, { key }), 201);
  assert.deepEqual([replay.replayed, replay.data.transfer.reference], [true, recovered.data.transfer.reference], "the intent journal recovers: no second reference/order");
  assert.deepEqual((({ orders, instructions }) => [orders, instructions])(await issuedFootprint(projectOf(b))), [1, 1]);
});

cell(`DENY ACH-M-I2-EXPIRY (time): ${I2}`, "expiry", async (ctx) => {
  // the route's step-up-free effect: the transfer deadline is the min of lifetime and the quote price expiry; the price expiry crosses after the lock wait
  const b = await buyer("i2expiry");
  const r = await enabled("i2expiry", [b.a.s.agency.agencyId]);
  const reply = await ctx.operation("issuance after the price expiry crossed in the route-lock wait", async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      const boundary = ctx.deadline(b.quote.quote.expiresAt, "price expiry");
      ctx.clock.set(Date.parse(boundary) - 1);
      const holder = await open();
      const wc = await open();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR UPDATE", [r.routeId]);
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => issue(b, r)), "issuance waits for the route lock");
      ctx.clock.set(Date.parse(boundary));
      await holder.query("ROLLBACK");
      await holder.end();
      const out = ok(await waiting.pending);
      await wc.end();
      return out;
    } finally {
      bw.iw.faults.clock = null;
    }
  });
  assert.equal(code(reply), "409 QUOTE_EXPIRED", "no extension of the price lifetime");
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
});

cell(`RACE ACH-M-I2-CRASH-BEFORE (crash): ${I2}`, "crash-before-commit", async (ctx) => {
  const b = await buyer("i2crashb");
  const r = await enabled("i2crashb", [b.a.s.agency.agencyId]);
  const key = freshKey("i2crashb");
  const crash = ctx.points.crash("uow.before-commit");
  const conn = await open();
  try {
    await ctx.operation("issuance dies before Kinstructions COMMIT", () => on(ctx, conn, () => issue(b, r, { key })));
    await crash.reached;
  } finally {
    await conn.end();
  }
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, "quote/order/reference/journal atomic");
  assert.equal((await q<{ state: string }>("SELECT state FROM kauro.quotes WHERE quote_id::text = $1", [b.quote.quote.quoteId]))[0]!.state, "ISSUED", "the quote is not accepted");
  assert.notEqual((await bw.iw.w.journal(key))?.state, "COMMITTED");
}, "uow");

cell(`RACE ACH-M-I2-CRASH-AFTER (crash): ${I2}`, "crash-after-commit", async (ctx) => {
  const b = await buyer("i2crasha");
  const r = await enabled("i2crasha", [b.a.s.agency.agencyId], { windowMs: 86_400_000 });
  const key = freshKey("i2crasha");
  const crash = ctx.points.crash("uow.after-commit");
  const conn = await open();
  try {
    const lost = await ctx.operation("issuance whose answer is lost", () => on(ctx, conn, () => issue(b, r, { key })));
    await crash.reached;
    assert.equal(lost.status, 500);
  } finally {
    await conn.end();
  }
  const [row] = await q<{ reference: string; send_by: Date; order_state: string }>("SELECT i.reference, i.send_by, i.order_state FROM kauro.bank_transfer_instructions i JOIN kauro.payment_orders o ON o.order_id = i.order_id WHERE o.project_id::text = $1", [projectOf(b)]);
  assert.ok(row !== undefined && row.order_state === "AWAITING_TRANSFER", "Kinstructions committed");
  const again = completed<IssuedView>(await issue(b, r, { key }), 201);
  assert.deepEqual([again.replayed, again.data.transfer.reference, Date.parse(again.data.transfer.sendBy)], [true, row.reference, row.send_by.getTime()], "the same frozen reference and sendBy, never regenerated");
  // replay once the route is disabled: the order is returned, its details stay hidden
  completed(await owner(bankRoutes.disable(r.routeId), await disableBody(r)), 200);
  assert.equal(completed<IssuedView>(await issue(b, r, { key }), 201).data.transfer.reference, row.reference);
  const hidden = await readInstructions(b, again.data.order.orderId);
  assert.equal(code(hidden), "409 ROUTE_NOT_ENABLED");
  noAccountDigits(hidden, "replay after disable");
}, "uow");

cell(`RACE ACH-M-I2-RETRY (retry): ${I2}`, "retry", async (ctx) => {
  const b = await buyer("i2retry");
  const r = await enabled("i2retry", [b.a.s.agency.agencyId]);
  const key = freshKey("i2retry");
  // identical concurrent replay
  const both = (await ctx.concurrently(2, () => issue(b, r, { key }))).map((s) => ok(s));
  assert.deepEqual(both.map((x) => x.status), [201, 201]);
  const views = both.map((x) => completed<IssuedView>(x, 201));
  assert.deepEqual([views[0]!.data.order.orderId, views[0]!.data.transfer.reference], [views[1]!.data.order.orderId, views[1]!.data.transfer.reference], "one order, one reference");
  // same key, another route / body: conflict
  const other = await enabled("i2retry-other", [b.a.s.agency.agencyId]);
  assert.equal(code(await ctx.attempt(() => issue(b, other, { key }))), "409 IDEMPOTENCY_KEY_REUSED", "the intent binds the route");
  const fp = await issuedFootprint(projectOf(b));
  assert.deepEqual([fp.orders, fp.instructions, fp.accepted], [1, 1, 1]);
  assert.match(views[0]!.data.transfer.reference, REFERENCE);
});

cell(`DENY ACH-M-I2-REVOCATION (revocation): ${I2}`, "revocation", async (ctx) => {
  // each issuance prerequisite revoked while Kinstructions waits at the route lock; a replaced route version re-reads its window (I2Δ)
  const revocations: ReadonlyArray<readonly [string, (b: { a: Agent }, r: RouteView) => Promise<unknown>, string]> = [
    ["billing membership", async (b) => bw.iw.h.oracle.query("UPDATE kauro.memberships SET state = 'REVOKED' WHERE user_id = $1 AND agency_id = $2", [b.a.billing.userId, b.a.s.agency.agencyId]), "403 NOT_AUTHORIZED"],
    ["route details replaced", async (_b, r) => {
      const d = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref, { accountNumber: "333333333333" });
      return bw.iw.h.oracle.query("UPDATE kauro.bank_routes SET state = 'PENDING_VERIFICATION', current_version = current_version + 1 WHERE route_id = $1 RETURNING $2::text", [r.routeId, d.artifactRef]);
    }, "409 ROUTE_NOT_ENABLED"],
    ["route participant", async (_b, r) => bw.iw.h.oracle.query("DELETE FROM kauro.bank_route_participants WHERE route_id = $1", [r.routeId]), "409 ROUTE_NOT_ENABLED"],
  ];
  for (const [what, revoke, refusal] of revocations) {
    const b = await buyer(`i2rev-${what.split(" ")[1]}`);
    const r = await enabled(`i2rev-${what.split(" ")[1]}`, [b.a.s.agency.agencyId]);
    const holder = await open();
    const wc = await open();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR UPDATE", [r.routeId]);
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => issue(b, r)), `issuance at the route lock (${what})`);
      await holder.query("ROLLBACK");
      await ctx.revoked(what, () => revoke(b, r));
      await ctx.fenced(`issuance after ${what}`, async () => {
        throw ok(await waiting.pending);
      }, (e) => code(e as Reply) === refusal);
    } finally {
      await holder.end();
      await wc.end();
    }
    assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, `${what}: no issuance`);
  }
});

cell(`RACE ACH-M-I2-PARTIAL (partial): ${I2}`, "partial", async (ctx) => {
  const steps: ReadonlyArray<SqlStep> = [
    { label: "quote_accept", match: /UPDATE kauro\.quotes/ },
    { label: "order_insert", match: /INSERT INTO kauro\.payment_orders/ },
    { label: "instructions", match: /INSERT INTO kauro\.bank_transfer_instructions/ },
    { label: "scope", match: /INSERT INTO kauro\.[a-z_]*scope/ },
    { label: "event", match: /INSERT INTO kauro\.domain_events/ },
    { label: "outbox", match: /INSERT INTO kauro\.outbox_records/ },
    { label: "journal", match: /UPDATE kauro\.(request_journal|idempotency)/ },
  ];
  for (const step of steps.slice(1)) {
    const b = await buyer(`i2partial-${step.label}`);
    const r = await enabled(`i2partial-${step.label}`, [b.a.s.agency.agencyId]);
    const key = freshKey(`i2partial-${step.label}`);
    const conn = await open();
    try {
      await ctx.partial(`issuance failing at ${step.label}`, `db.${step.label}.before`, async () => {
        const reply = await on(ctx, conn, () => issue(b, r, { key }), steps);
        if (reply.status >= 500) throw bw.iw.w.internalErrors.at(-1)?.error ?? new Error(String(reply.status));
        return reply;
      });
    } finally {
      await conn.end();
    }
    assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, `${step.label}: no orphan reference or accepted quote`);
    assert.notEqual((await bw.iw.w.journal(key))?.state, "COMMITTED", `${step.label}: journal rolled back`);
    const retried = completed<IssuedView>(await issue(b, r, { key }), 201);
    assert.deepEqual([retried.replayed, retried.data.transfer.bankState], [false, "AWAITING_TRANSFER"], `${step.label}: the same-key retry issues once`);
  }
});

test("DENY ACH-M-I2D-EXPIRY (transfer window): Issue transfer instructions with a minimum window", async () => {
  await runCell({ id: "ACH-M-I2D-EXPIRY", step: "Issue transfer instructions with a minimum window", fault: "expiry", expect: "window -1 ms refused TRANSFER_WINDOW_TOO_SHORT, = window issued with sendBy = deadline - window" }, async (ctx) => {
    // the deadline is the quote price expiry (lifetime longer); effectNow is read after the route-lock wait
    for (const delta of [-1, 0] as const) {
      const b = await buyer(`i2d-${delta}`);
      const windowMs = 2 * 86_400_000;
      const r = await enabled(`i2d-${delta}`, [b.a.s.agency.agencyId], { windowMs, lifetimeMs: 400 * 86_400_000 });
      const deadline = Date.parse(b.quote.quote.expiresAt);
      const reply = await ctx.operation(`issuance with deadline - effectNow = window ${delta} ms`, async (op) => {
        bw.iw.faults.clock = op.clock;
        try {
          // effectNow after the wait = deadline - window - delta: the window left is window + delta
          const effect = deadline - windowMs - delta;
          const boundary = ctx.deadline(deadline - windowMs, "latest issuance instant");
          ctx.clock.set(Date.parse(boundary) - 2);
          const holder = await open();
          const wc = await open();
          await holder.query("BEGIN");
          await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR UPDATE", [r.routeId]);
          const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => issue(b, r)), "issuance waits for the route lock");
          ctx.clock.set(delta === -1 ? effect : Date.parse(boundary));
          await holder.query("ROLLBACK");
          await holder.end();
          const out = ok(await waiting.pending);
          await wc.end();
          return out;
        } finally {
          bw.iw.faults.clock = null;
        }
      });
      if (delta === -1) {
        assert.equal(code(reply), "409 TRANSFER_WINDOW_TOO_SHORT", "window - 1 ms: refused");
        assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, "nothing written");
      } else {
        const t = completed<IssuedView>(reply, 201).data.transfer;
        assert.deepEqual([Date.parse(t.transferExpiresAt), Date.parse(t.sendBy)], [deadline, deadline - windowMs], "= window: issued, sendBy = deadline - window");
      }
    }
  });
});

// === I3: the authorized sensitive-instructions projection ==========================================================================

async function issuedOrder(label: string, cfg: Partial<Cfg> = {}): Promise<{ b: { a: Agent; quote: CreateQuoteView }; r: RouteView; orderId: string; reference: string }> {
  const b = await buyer(label);
  const r = await enabled(label, [b.a.s.agency.agencyId], cfg);
  const v = completed<IssuedView>(await issue(b, r), 201).data;
  return { b, r, orderId: v.order.orderId, reference: v.transfer.reference };
}

cell(`RACE ACH-M-I3-RACE (concurrency): ${I3}`, "race", async (ctx) => {
  for (const first of ["read", "disable"] as const) {
    const x = await issuedOrder(`i3race-${first}`);
    const reading = () => readInstructions(x.b, x.orderId);
    const stopping = async () => owner(bankRoutes.disable(x.r.routeId), await disableBody(x.r));
    const { held, waited } = first === "read" ? await holdAndWait(ctx, "disable waits for the guarded read", reading, stopping) : await holdAndWait(ctx, "read waits for disable", stopping, reading);
    const read = ok(first === "read" ? held : waited);
    if (first === "read") {
      assert.equal(read.status, 200, "ENABLED at the guard: served");
      assert.equal(String(read.headers["cache-control"]), "no-store");
    } else {
      assert.equal(code(read), "409 ROUTE_NOT_ENABLED", "disable won: details hidden");
      noAccountDigits(read, "after disable");
    }
    const after = await readInstructions(x.b, x.orderId);
    assert.equal(code(after), "409 ROUTE_NOT_ENABLED", "only ENABLED serves sensitive data");
    noAccountDigits(after, "next read");
  }
});

cell(`RACE ACH-M-I3-TIMEOUT (time): ${I3}`, "timeout", async (ctx) => {
  const x = await issuedOrder("i3timeout");
  const ref = await detailsRefOf(x.r.routeId);
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  const reply = await withStoreHook(ref, () => stalled, () =>
    ctx.operation("guarded read whose artifact read never answers", async (op) => {
      ctx.deadline(op.clock.nowMs() + PROVIDER_CALL_TIMEOUT_MS, "artifact read bound");
      const pending = readInstructions(x.b, x.orderId);
      ctx.clock.advance(PROVIDER_CALL_TIMEOUT_MS + 1);
      const out = await pending;
      release();
      return out;
    }),
  );
  assert.equal(code(reply), "503 EVIDENCE_UNAVAILABLE");
  noAccountDigits(reply, "timeout");
});

cell(`DENY ACH-M-I3-EXPIRY (time): ${I3}`, "expiry", async (ctx) => {
  const x = await issuedOrder("i3expiry");
  const expiresAt = (await q<{ at: Date }>("SELECT transfer_expires_at AS at FROM kauro.bank_transfer_instructions WHERE order_id::text = $1", [x.orderId]))[0]!.at.getTime();
  const reply = await ctx.operation("guarded read across the instruction deadline", async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      ctx.clock.set(expiresAt - 1);
      const boundary = ctx.deadline(expiresAt, "instruction deadline");
      return await withStoreHook(await detailsRefOf(x.r.routeId), async () => void ctx.clock.set(Date.parse(boundary)), () => readInstructions(x.b, x.orderId));
    } finally {
      bw.iw.faults.clock = null;
    }
  });
  assert.equal(code(reply), "409 INSTRUCTIONS_EXPIRED", "expired instruction details are hidden");
  noAccountDigits(reply, "expired");
});

test(`RACE ACH-M-I3-CRASH-BEFORE (crash): ${I3}`, async () => {
  const x = await issuedOrder("i3crashb");
  const ref = await detailsRefOf(x.r.routeId);
  const logged: string[] = [];
  const reply = await withStoreHook(ref, async () => {
    throw new SimulatedCrash("details-store.get.before");
  }, () => readInstructions(x.b, x.orderId));
  assert.equal(reply.status, 500);
  noAccountDigits(reply, "crash");
  for (const e of bw.iw.w.internalErrors) logged.push(String((e.error as Error)?.stack ?? e.error));
  assert.ok(logged.every((l) => !l.includes(ACCOUNT_DIGITS)), "no logged account data");
  assert.equal((await q<{ order_state: string }>("SELECT order_state FROM kauro.bank_transfer_instructions WHERE order_id::text = $1", [x.orderId]))[0]!.order_state, "AWAITING_TRANSFER", "no state change");
});

test(`RACE ACH-M-I3-CRASH-AFTER (crash): ${I3}`, async () => {
  // the read's response is lost: nothing caches the details; a refetch is re-authorized under the current guards
  const x = await issuedOrder("i3crasha");
  const first = await readInstructions(x.b, x.orderId);
  assert.equal(first.status, 200);
  assert.equal(String(first.headers["cache-control"]), "no-store", "never cached");
  assert.equal(first.headers["etag"], undefined);
  const view = first.json<InstructionsView>().instructions;
  assert.deepEqual([view.accountNumber, view.currency, view.reference], [ACCOUNT_DIGITS, "USD", x.reference]);
  completed(await owner(bankRoutes.disable(x.r.routeId), await disableBody(x.r)), 200);
  const refetch = await readInstructions(x.b, x.orderId);
  assert.equal(code(refetch), "409 ROUTE_NOT_ENABLED", "the refetch is guarded again");
  noAccountDigits(refetch, "refetch");
});

test(`OK ACH-M-I3-RETRY (retry): ${I3}`, async () => {
  const x = await issuedOrder("i3retry");
  const a = await readInstructions(x.b, x.orderId);
  const again = await readInstructions(x.b, x.orderId);
  assert.deepEqual([a.status, again.status, a.json<InstructionsView>().instructions.reference], [200, 200, x.reference]);
  // a foreign agency's member, with its own token and agency header: nothing
  const foreign = await agentOf(bw.iw, `i3retry-foreign-${++seq}`);
  const leaked = await readInstructions({ a: foreign }, x.orderId);
  assert.ok(leaked.status === 404 || leaked.status === 403, "foreign agency refused");
  noAccountDigits(leaked, "foreign agency");
  const crossHeader = await readInstructions(x.b, x.orderId, foreign.billing.token, x.b.a.s.agency.agencyId);
  assert.ok(crossHeader.status === 403 || crossHeader.status === 404);
  noAccountDigits(crossHeader, "foreign token");
  completed(await owner(bankRoutes.disable(x.r.routeId), await disableBody(x.r)), 200);
  const afterDisable = await readInstructions(x.b, x.orderId);
  assert.equal(code(afterDisable), "409 ROUTE_NOT_ENABLED", "idempotency never bypasses visibility");
  noAccountDigits(afterDisable, "after disable");
});

cell(`DENY ACH-M-I3-REVOCATION (revocation): ${I3}`, "revocation", async (ctx) => {
  const withdrawals: ReadonlyArray<readonly [string, (x: Awaited<ReturnType<typeof issuedOrder>>) => Promise<unknown>, (r: Reply) => boolean]> = [
    ["membership", async (x) => bw.iw.h.oracle.query("UPDATE kauro.memberships SET state = 'REVOKED' WHERE user_id = $1 AND agency_id = $2", [x.b.a.billing.userId, x.b.a.s.agency.agencyId]), (r) => r.status === 403],
    ["session", async (x) => bw.iw.h.oracle.query("UPDATE kauro.sessions SET revoked_at = now() WHERE user_id = $1", [x.b.a.billing.userId]), (r) => r.status === 401],
    ["route enabled", async (x) => bw.iw.h.oracle.query("UPDATE kauro.bank_routes SET state = 'VERIFIED' WHERE route_id = $1", [x.r.routeId]), (r) => code(r) === "409 ROUTE_NOT_ENABLED"],
    ["details artifact", async (x) => bw.evidence.corrupt(await detailsRefOf(x.r.routeId), new TextEncoder().encode("{}")), (r) => code(r) === "409 HASH_MISMATCH"],
  ];
  for (const [what, withdraw, refused] of withdrawals) {
    const x = await issuedOrder(`i3rev-${what.split(" ")[0]}`);
    let reached!: () => void;
    let go!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    const running = withStoreHook(await detailsRefOf(x.r.routeId), async () => {
      reached();
      await released;
    }, () => ctx.operation(`projection held (${what})`, () => readInstructions(x.b, x.orderId)));
    await atRead;
    await ctx.revoked(what, () => withdraw(x));
    go();
    await ctx.fenced(`projection after ${what}`, async () => {
      throw await running;
    }, (e) => refused(e as Reply));
    noAccountDigits(await readInstructions(x.b, x.orderId), `${what}: next read`);
  }
});

cell(`RACE ACH-M-I3-PARTIAL (partial): ${I3}`, "partial", async (ctx) => {
  // authorization passed, the artifact decrypt fails: fail closed, no body fragment, nothing logged
  const x = await issuedOrder("i3partial");
  const ref = await detailsRefOf(x.r.routeId);
  const steps: ReadonlyArray<SqlStep> = [{ label: "guard", match: /FROM kauro\.bank_routes/ }];
  const conn = await open();
  let reply: Reply | undefined;
  try {
    await ctx.partial("projection failing at the artifact read after its guard", "db.guard.after", async () => {
      reply = await withStoreHook(ref, async () => {
        throw new SimulatedCrash("details-store.decrypt");
      }, () => on(ctx, conn, () => readInstructions(x.b, x.orderId), steps));
      if (reply.status >= 500) throw bw.iw.w.internalErrors.at(-1)?.error ?? new Error(String(reply.status));
      return reply;
    });
  } finally {
    await conn.end();
  }
  assert.ok(reply !== undefined && reply.status === 500);
  noAccountDigits(reply, "partial");
  assert.ok(!reply.text.includes(x.reference), "no fragment of the snapshot");
});

// === cases ACH-01..03 ================================================================================================================

test("ACH-01 OK: a route reaches ENABLED only through PENDING_VERIFICATION and VERIFIED with real evidence; withdrawn details disable it; with no ENABLED route no details and no order exist", async () => {
  const b = await buyer("ach01");
  const r = await configured("ach01");
  // PENDING_VERIFICATION cannot be enabled, nor can a CONTRACT_FAKE route be enabled in LIVE (environment is SANDBOX here)
  assert.equal(code(await owner(bankRoutes.enable(r.routeId), await enableBody(r, [b.a.s.agency.agencyId]))), "409 ROUTE_NOT_VERIFIED");
  assert.equal(code(await issue(b, r)), "409 ROUTE_NOT_ENABLED", "no ENABLED route: no order");
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
  const v = completed<{ route: RouteView }>(await owner(bankRoutes.verify(r.routeId), await verifyBody(r)), 200).data.route;
  assert.equal(v.state, "VERIFIED");
  assert.equal(code(await issue(b, v)), "409 ROUTE_NOT_ENABLED", "VERIFIED is not ENABLED");
  const e = completed<{ route: RouteView }>(await owner(bankRoutes.enable(r.routeId), await enableBody(v, [b.a.s.agency.agencyId])), 200).data.route;
  assert.deepEqual([e.state, e.rollout], ["ENABLED", "CONTROLLED"]);
  // a buyer outside the CONTROLLED allowlist gets no instructions and no order (K-9)
  const outsider = await buyer("ach01-outsider");
  assert.equal(code(await issue(outsider, e)), "409 ROUTE_NOT_ENABLED");
  assert.deepEqual(await issuedFootprint(projectOf(outsider)), NOTHING_ISSUED);
  const issued = completed<IssuedView>(await issue(b, e), 201).data;
  assert.equal(issued.transfer.bankState, "AWAITING_TRANSFER");
  // withdrawn (replaced) details: back to PENDING_VERIFICATION; the order keeps its old snapshot, its details are hidden; no new issuance
  const d = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref, { accountNumber: "444444444444" });
  const replaced = completed<{ route: RouteView }>(await owner(bankRoutes.details(r.routeId), { expectedVersion: e.routeVersion, detailsArtifactRef: d.artifactRef, detailsEvidenceHash: d.evidenceHash, authorizationRef: await proof() }), 200).data.route;
  assert.deepEqual([replaced.state, replaced.routeVersion], ["PENDING_VERIFICATION", e.routeVersion + 1]);
  assert.equal((await q<{ v: number }>("SELECT route_version AS v FROM kauro.bank_transfer_instructions WHERE order_id::text = $1", [issued.order.orderId]))[0]!.v, e.routeVersion, "old snapshot preserved, never reassigned");
  const hidden = await readInstructions(b, issued.order.orderId);
  assert.equal(code(hidden), "409 ROUTE_NOT_ENABLED");
  noAccountDigits(hidden, "replaced details");
  const second = await buyer("ach01-second");
  assert.equal(code(await issue(second, replaced)), "409 ROUTE_NOT_ENABLED");
});

test("ACH-02 DENY: disabled, expired or foreign reads expose no account details; USD only; no subscription, BILL or Melio dependency", async () => {
  const x = await issuedOrder("ach02");
  const served = await readInstructions(x.b, x.orderId);
  assert.equal(served.status, 200);
  const view = served.json<InstructionsView>().instructions;
  assert.deepEqual([view.currency, String(view.amountCents), view.reference], ["USD", String(x.b.quote.quote.totalCents), x.reference], "exact USD cents and the reference");
  assert.ok(!/bill\.com|melio|subscription/i.test(served.text), "no BILL, Melio or subscription dependency");
  const foreign = await agentOf(bw.iw, `ach02-foreign-${++seq}`);
  noAccountDigits(await readInstructions({ a: foreign }, x.orderId), "foreign");
  // a non-USD route cannot be configured
  assert.equal(code(await owner(bankRoutes.configure(), { ...(await configureBody({ accountRef: nextAccount("ach02-eur") })), currency: "EUR" })), "400 VALIDATION_FAILED");
  completed(await owner(bankRoutes.disable(x.r.routeId), await disableBody(x.r)), 200);
  noAccountDigits(await readInstructions(x.b, x.orderId), "disabled");
  // expired: a second order whose route is re-enabled, read after its deadline on the database clock
  await bw.iw.h.oracle.query("UPDATE kauro.bank_transfer_instructions SET transfer_expires_at = now() - interval '1 millisecond' WHERE order_id::text = $1", [x.orderId]);
  noAccountDigits(await readInstructions(x.b, x.orderId), "expired");
});

test("ACH-03 RACE: one immutable intent and 23-character reference per order; collisions retried before commit; a conflicting key is refused", async () => {
  const b = await buyer("ach03");
  const r = await enabled("ach03", [b.a.s.agency.agencyId]);
  const key = freshKey("ach03");
  const replies = await Promise.all([issue(b, r, { key }), issue(b, r, { key }), issue(b, r, { key: freshKey("ach03-other") })]);
  const created = replies.filter((x) => x.status === 201).map((x) => completed<IssuedView>(x, 201).data);
  assert.equal(new Set(created.map((c) => c.order.orderId)).size, 1, "one order");
  assert.equal(new Set(created.map((c) => c.transfer.reference)).size, 1, "one reference");
  assert.equal(replies.filter((x) => x.status === 409).length, 3 - created.length);
  const [reference] = created.map((c) => c.transfer.reference);
  assert.match(reference!, REFERENCE, "K + 20 + 2 Crockford symbols");
  assert.equal(reference!.length, 23);
  // the reference is immutable: no UPDATE of it is allowed even to the payment role
  const conn = await openConnection(bw.iw.h.pg.clientConfig("kauro_payment_test"));
  try {
    await assert.rejects(conn.query("UPDATE kauro.bank_transfer_instructions SET reference = 'K0000000000000000000000' WHERE reference = $1", [reference]), "the reference is immutable");
  } finally {
    await conn.end();
  }
  // a collision with an existing reference is retried before commit: a pre-seeded reference never appears twice
  assert.equal(await n("SELECT reference FROM kauro.bank_transfer_instructions GROUP BY environment, account_ref, reference HAVING count(*) > 1"), 0, "account/environment-wide uniqueness");
  assert.equal(code(await issue(b, r, { key, body: { ...issueBody(b, r), routeId: "00000000-0000-0000-0000-000000000000" } })), "409 IDEMPOTENCY_KEY_REUSED", "a conflicting key is refused");
});
