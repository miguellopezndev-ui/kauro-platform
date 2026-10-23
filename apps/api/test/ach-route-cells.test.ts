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
import { connectionPid, crashedAt, FaultPoints, INJECTED_STATEMENT_TIMEOUT_MS, LOCK_WAIT_OBSERVATION_MS, openConnection, runCell, SimulatedCrash, type FaultContext, type FaultKind, type HarnessConnection } from "@kauro/persistence/testing";
import { BANK_PAYEE_DIGEST, bankWorld, type BankWorld } from "./bank-support.js";
import type { SqlStep } from "./fault-support.js";
import { agentOf, planOf, quoted, type Agent } from "./integration-support.js";
import { supersedeIn } from "./b17-target-supersession-support.js";
import { call, completed, freshKey, outcome, rawEvent, routes, sessionPaths, type BrowserSession, type Reply } from "./support.js";

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
/** A revocation cell's lock holder (the superuser): the revocation's own statements run in the holder's transaction and commit while it holds. */
const openHolder = (): Promise<HarnessConnection> => openConnection(bw.iw.h.pg.clientConfig("postgres"));
/** The B09/B10 outcome convention: "status CODE REASON" (FailureCode + closed reason; "-" when none). */
/** A success reads "<status> SUCCESS -" (r1: a red cell names what the product answered instead of failing inside the helper). */
const code = (r: Reply): string => (r.status < 400 ? `${r.status} SUCCESS -` : outcome(bw.iw.w, r));

/** An owner-supplied account-details artifact in the restricted store (V1 R1 evidence) for a fresh account of this cell. */
async function detailsArtifact(accountRef: string, over: { readonly accountNumber?: string; readonly validUntil?: string; readonly routingNumber?: string | null } = {}): Promise<{ readonly artifactRef: string; readonly evidenceHash: string }> {
  const details = { accountRef, detailsVersion: `details-${++seq}`, currency: "USD", acceptedRails: ["ACH", "DOMESTIC_WIRE"], beneficiaryName: "Kauro Test Beneficiary", bankName: "Contract Fake Bank", routingNumber: over.routingNumber === undefined ? "026073150" : over.routingNumber, accountNumber: over.accountNumber ?? ACCOUNT_DIGITS, accountType: "CHECKING", payeeDigest: BANK_PAYEE_DIGEST, additionalFields: {}, validUntil: over.validUntil ?? new Date(Date.now() + 30 * 86_400_000).toISOString() };
  const { artifactRef, sha256 } = await bw.evidence.put({ bytes: new TextEncoder().encode(JSON.stringify({ format: BANK_FAKE_FORMAT, kind: "ACCOUNT_DETAILS", accountRef, details })), accountRef: accountRef as never });
  return { artifactRef, evidenceHash: sha256 };
}

interface Cfg {
  readonly accountRef: string;
  readonly windowMs?: number;
  readonly lifetimeMs?: number;
  /** The details artifact's validUntil (default 30 days ahead). */
  readonly validUntil?: string;
}
const configureBody = async (cfg: Cfg) => {
  const d = await detailsArtifact(cfg.accountRef, cfg.validUntil === undefined ? {} : { validUntil: cfg.validUntil });
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
interface Buyer {
  readonly a: Agent;
  readonly quote: CreateQuoteView;
  readonly planId: string;
}
async function buyer(label: string): Promise<Buyer> {
  const a = await agentOf(bw.iw, `${label}-${++seq}`);
  const plan = await planOf(bw.iw, a, `${label}-plan`);
  return { a, quote: await quoted(bw.iw, a, plan), planId: plan.planId };
}
/**
 * The billing member's membership revoked the way B06 writes the listed Membership edge (pipeline-authorization / cmd044 fixtures): the
 * agency owner acting as itself (tenant context of `c`'s transaction), ACTIVE -> REVOKED with its version bump AND its
 * membership.revoked.v1 event in the same transaction (the membership triggers refuse an actor-less write, KA010, and an event-less one).
 */
async function revokeBilling(c: { query: HarnessConnection["query"] }, a: Agent): Promise<void> {
  const agency = a.s.agency;
  await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agency.agencyId, agency.ownerUserId]);
  const moved = await c.query<{ membership_id: string; version: string }>("UPDATE kauro.memberships SET state = 'REVOKED', revoked_at = now(), version = version + 1 WHERE user_id = $1 AND agency_id = $2 AND state = 'ACTIVE' RETURNING membership_id::text, version::text", [a.billing.userId, agency.agencyId]);
  assert.equal(moved.rowCount, 1, "the billing membership moved ACTIVE -> REVOKED");
  const { membership_id: membershipId, version } = moved.rows[0]!;
  await rawEvent(c as never, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: Number(version), agencyId: agency.agencyId, eventType: "membership.revoked.v1", actorUserId: agency.ownerUserId, payload: { membershipId, agencyId: agency.agencyId, byMembershipId: agency.ownerMembershipId, reasonCode: "OFFBOARDED" } });
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
    accepted: await n("SELECT 1 FROM kauro.quotes WHERE project_id::text = $1 AND state = 'ACCEPTED_FOR_CHECKOUT'", [projectId]),
    events: await n("SELECT 1 FROM kauro.domain_events e JOIN kauro.payment_orders o ON o.order_id::text = e.aggregate_id::text WHERE o.project_id::text = $1", [projectId]),
  };
}
const NOTHING_ISSUED = { orders: 0, instructions: 0, accepted: 0, events: 0 };
/** The order-aggregate events of ONE issuance (r1, ADV-PV1R-8): the order's creation and bank_transfer_instruction.issued.v1. Exact, so a duplicated or missing event fails. */
const ISSUED_EVENTS = 2;
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
async function holdAndWait<H, W>(ctx: FaultContext, what: string, holder: () => Promise<H>, waiter: () => Promise<W>, at = "uow.before-commit", holderSteps: ReadonlyArray<SqlStep> = []): Promise<{ held: PromiseSettledResult<H>; waited: PromiseSettledResult<W> }> {
  const hc = await open();
  const wc = await open();
  try {
    const pause = ctx.points.pause(at);
    const running = ctx.operation(`${what} (holder)`, () => on(ctx, hc, holder, holderSteps));
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

/**
 * r1 revocation form (ADV-PV1R-1, ADV-PV1R-5): the withdrawal takes its OWN lock and commits while the issuance waits on it, so the cell
 * holds whatever order the issuance takes its locks in (a holder of the quote row that then revoked a membership deadlocks with an issuance
 * that takes the membership's shared half first, the B09 order D-ACH-04 mandates). Either SQL in a holder transaction committed by
 * ctx.revoked, or a product command paused before its COMMIT and released by ctx.revoked (its 200 asserted).
 */
type Withdrawal = { readonly sql: (holder: HarnessConnection) => Promise<unknown> } | { readonly command: () => Promise<Reply> };
async function waitBehindWithdrawal(ctx: FaultContext, what: string, waiter: () => Promise<Reply>, withdrawal: Withdrawal): Promise<Reply> {
  const wc = await open();
  try {
    if ("sql" in withdrawal) {
      const holder = await openHolder();
      try {
        await holder.query("BEGIN");
        await withdrawal.sql(holder);
        const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, waiter), `waits behind the ${what}`);
        await ctx.revoked(what, () => holder.query("COMMIT"));
        return ok(await waiting.pending);
      } finally {
        await holder.end();
      }
    }
    const hc = await open();
    try {
      const pause = ctx.points.pause("uow.before-commit");
      const running = ctx.operation(`${what} (holder)`, () => on(ctx, hc, withdrawal.command));
      const settled = running.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
      await pause.reachedBy(running);
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, () => on(ctx, wc, waiter), `waits behind the ${what}`);
      await ctx.revoked(what, async () => {
        pause.release();
        const done = ok(await settled);
        assert.equal(done.status, 200, `${what}: the withdrawal commits (${code(done)})`);
      });
      return ok(await waiting.pending);
    } finally {
      await hc.end();
    }
  } finally {
    await wc.end();
  }
}
/** CMD026 approval withdrawal as a raw reply (the r1 command form). */
async function withdrawPlanCall(b: Buyer): Promise<Reply> {
  const [plan] = await q<{ version: string }>("SELECT version::text FROM kauro.plans WHERE plan_id::text = $1", [b.planId]);
  return call(bw.iw.w, { url: routes.withdrawApproval(b.planId), token: b.a.s.owner.token, agency: b.a.s.agency.agencyId, key: freshKey("withdraw"), body: { expectedVersion: Number(plan!.version), reasonCode: "OWNER_DECISION" } });
}
/** The allowlist narrowed through the product: re-enable ENABLED -> ENABLED with `participants` (departure 2: a new participant set). */
const narrowTo = (r: RouteView, participants: ReadonlyArray<string>): Withdrawal => ({ command: async () => owner(bankRoutes.enable(r.routeId), await enableBody(r, participants)) });
/** The billing member's identity disabled (its state update takes the identity's transition half, which the authorizer awaits). */
const disableIdentity = (a: Agent): Withdrawal => ({
  sql: async (holder) => {
    const moved = await holder.query("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1 AND state = 'ACTIVE'", [a.billing.userId]);
    assert.equal(moved.rowCount, 1, "the billing identity moved ACTIVE -> DISABLED");
  },
});
/** The project's target contract superseded (B09 fixture form, b09-payment-service), in the agency owner's tenant context. */
const supersedeTarget = (b: Buyer): Withdrawal => ({
  sql: async (holder) => {
    await holder.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [b.a.s.agency.agencyId, b.a.s.agency.ownerUserId]);
    const agencyId = b.a.s.agency.agencyId;
    const current = await holder.query<{ contract_id: string }>("SELECT contract_id FROM kauro.target_contracts WHERE agency_id = $1 AND project_id = $2 AND confirmed_at IS NOT NULL AND superseded_at IS NULL", [agencyId, projectOf(b)]);
    assert.ok(current.rows.length >= 1, "the target contract superseded");
    // migration 0084: a contract is superseded only by a later confirmed observation of its instance (CMD019's shape)
    for (const row of current.rows) await supersedeIn(holder, { agencyId, contractId: row.contract_id }, b.a.s.agency.ownerMembershipId);
  },
});

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
      assert.equal(code(v), "409 STALE_VERSION ROUTE_VERSION_CHANGED", "the verify that read stale details is refused");
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
  // the read is reached only after the product armed its bound (timer.start precedes store.get): the clock moves once it is armed
  let armed!: () => void;
  const readStarted = new Promise<void>((resolve) => (armed = resolve));
  const reply = await withStoreHook(await detailsRefOf(r.routeId), () => {
    armed();
    return stalled;
  }, () =>
    ctx.operation("verify whose details read never answers", async (op) => {
      const started = op.clock.nowMs();
      ctx.deadline(started + PROVIDER_CALL_TIMEOUT_MS, "details read bound");
      const pending = owner(bankRoutes.verify(r.routeId), await verifyBody(r));
      await readStarted;
      ctx.clock.advance(PROVIDER_CALL_TIMEOUT_MS + 1);
      const out = await pending;
      release();
      return out;
    }),
  );
  assert.equal(code(reply), "503 CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE", "the bound fired: no qualification on an unknown read");
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
  assert.equal(code(reply), "409 PRECONDITION_FAILED DETAILS_EXPIRED", "expired details never qualify");
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
  assert.equal(code(await owner(bankRoutes.verify(r.routeId), { ...body, verificationEvidenceRef: other.artifactRef }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  // conflicting account binding: a details artifact of another account never qualifies this route
  const r2 = await configured("r1retry-bind");
  const foreign = await detailsArtifact(nextAccount("foreign"));
  assert.equal(code(await owner(bankRoutes.details(r2.routeId), { expectedVersion: 1, detailsArtifactRef: foreign.artifactRef, detailsEvidenceHash: foreign.evidenceHash, authorizationRef: await proof() })), "409 PRECONDITION_FAILED DETAILS_ACCOUNT_MISMATCH");
  assert.deepEqual((({ state, versions, events }) => [state, versions, events])(await routeRow(r.routeId)), ["VERIFIED", 1, 2]);
});

cell(`DENY ACH-M-R1-REVOCATION (revocation): ${R1}`, "revocation", async (ctx) => {
  // each prerequisite withdrawn while the details read is held: the details artifact, the owner's step-up, the account binding
  const withdrawals: ReadonlyArray<readonly [string, (r: RouteView, ref: string) => Promise<unknown>, string]> = [
    ["details artifact corrupted", async (_r, ref) => bw.evidence.corrupt(ref, new TextEncoder().encode("{}")), "422 INTEGRITY_FAILURE HASH_MISMATCH"],
    ["details replaced", async (r) => {
      const d = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref, { accountNumber: "222222222222" });
      return completed(await owner(bankRoutes.details(r.routeId), { expectedVersion: 1, detailsArtifactRef: d.artifactRef, detailsEvidenceHash: d.evidenceHash, authorizationRef: await proof() }), 200);
    }, "409 STALE_VERSION ROUTE_VERSION_CHANGED"],
    ["route disabled for safety", async (r) => bw.iw.h.oracle.query("UPDATE kauro.bank_routes SET state = 'DISABLED' WHERE route_id = $1", [r.routeId]), "409 PRECONDITION_FAILED UNLISTED_TRANSITION"],
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
  // complete (valid) replacement details: incomplete ones are refused up front as malformed evidence (a DENY, no commit to crash at).
  // The verify's route and version reads answer, then its details read fails (the classifier is a frozen contract fake: no seam inside the
  // parse): no partial snapshot, the route unqualified
  const r = await configured("r1partial");
  const broken = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref);
  const replaced = completed<{ route: RouteView }>(await owner(bankRoutes.details(r.routeId), { expectedVersion: 1, detailsArtifactRef: broken.artifactRef, detailsEvidenceHash: broken.evidenceHash, authorizationRef: await proof() }), 200).data.route;
  const conn = await open();
  try {
    const steps: ReadonlyArray<SqlStep> = [{ label: "version_read", match: /FROM kauro\.bank_route_versions/ }];
    const body = await verifyBody(replaced);
    await ctx.partial("verify whose details parse fails after its reads", "details-read.parse", () => withStoreHook(broken.artifactRef, () => ctx.points.pass("details-read.parse"), () => on(ctx, conn, async () => {
      const reply = await owner(bankRoutes.verify(r.routeId), body);
      // the route answers 500 and reports the failure it hid: the cell sees the injected crash itself (crashedAt)
      if (reply.status >= 500) throw bw.iw.w.internalErrors.at(-1)?.error ?? new Error(String(reply.status));
      return reply;
    }, steps)));
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
    assert.equal(code(loser), "409 STALE_VERSION ROUTE_VERSION_CHANGED", "the loser rechecks the version under the lock");
    const row = await routeRow(r.routeId);
    assert.equal(row.state, first === "enable" ? "ENABLED" : "VERIFIED", "only the committed version decides");
  }
});

cell(`RACE ACH-M-R2-TIMEOUT (time): ${R2}`, "race", async (ctx) => {
  // a DATABASE bound (statement_timeout, SQLSTATE 57014), not a controlled-clock deadline: the kit's lock-timeout form (b10-cells-support
  // kindOf: lock-timeout -> race; CLOSE_TMO) proves the wait on the holder (mustWait) and that it ended while the holder still held
  const r = await verified("r2timeout");
  const key = freshKey("r2timeout");
  const body = await enableBody(r, [bw.iw.w.A.agencyId]);
  const holder = await openHolder();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [r.routeId]);
    bw.iw.faults.statementTimeoutMs = INJECTED_STATEMENT_TIMEOUT_MS;
    const conn = await open();
    try {
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: conn, holder: connectionPid(holder) }, () => on(ctx, conn, () => owner(bankRoutes.enable(r.routeId), body, { key })), "enable past its lock timeout");
      const timedOut = ok(await waiting.pending);
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
  const proofExpiresAt = (await q<{ at: Date }>("SELECT expires_at AS at FROM kauro.assurance_proofs WHERE proof_id::text = $1", [body.authorizationRef]))[0]!.at.getTime();
  const reply = await ctx.operation("enable with a step-up that expires during the lock wait", async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      const boundary = ctx.deadline(proofExpiresAt, "step-up proof expiry");
      const holder = await openHolder();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [r.routeId]);
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
  assert.equal(code(reply), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "a proof stale at the effect refuses");
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
  assert.equal(code(changed), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  const row = await routeRow(r.routeId);
  assert.deepEqual([row.state, row.events], ["ENABLED", 3], "exactly one enabling");
  assert.deepEqual((await q<{ agency_id: string }>("SELECT agency_id::text FROM kauro.bank_route_participants WHERE route_id = $1", [r.routeId])).map((x) => x.agency_id), [bw.iw.w.A.agencyId], "the key binds the exact config");
});

cell(`DENY ACH-M-R2-REVOCATION (revocation): ${R2}`, "revocation", async (ctx) => {
  // each qualification prerequisite withdrawn separately while the enable is held behind the route lock: the owner's KAURO_OWNER grant
  // (a throw-away owner, revoked through the listed ACTIVE -> REVOKED edge, never re-activated), the step-up proof (append-only: it
  // lapses at its expires_at on the controlled effect clock), the details evidence and the verification
  const REVOKE_GRANT = "UPDATE kauro.corporate_roles SET state = 'REVOKED', revoked_at = now() WHERE grant_id = $1 AND state = 'ACTIVE'";
  interface Actor {
    readonly token: string;
    readonly proof: string;
    readonly grantId: string | null;
  }
  const kinds: ReadonlyArray<readonly [string, (r: RouteView, who: Actor, holder: HarnessConnection) => Promise<unknown>, string]> = [
    ["owner grant", async (_r, who, holder) => {
      const moved = await holder.query(REVOKE_GRANT, [who.grantId]);
      assert.equal(moved.rowCount, 1, "the grant moved ACTIVE -> REVOKED");
    }, "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING"],
    ["step-up proof", async (_r, who) => {
      const expiresAt = (await q<{ at: Date }>("SELECT expires_at AS at FROM kauro.assurance_proofs WHERE proof_id::text = $1", [who.proof]))[0]!.at.getTime();
      const boundary = ctx.deadline(expiresAt, "step-up proof expiry");
      ctx.clock.set(Date.parse(boundary) + 1);
    }, "403 ASSURANCE_REQUIRED STEP_UP_STALE"],
    ["details evidence", async (r) => bw.evidence.corrupt(await detailsRefOf(r.routeId), new TextEncoder().encode("{}")), "422 INTEGRITY_FAILURE HASH_MISMATCH"],
    ["verification", async (r, _who, holder) => holder.query("UPDATE kauro.bank_routes SET state = 'PENDING_VERIFICATION' WHERE route_id = $1", [r.routeId]), "409 PRECONDITION_FAILED ROUTE_NOT_VERIFIED"],
  ];
  for (const [what, revoke, refusal] of kinds) {
    const r = await verified(`r2rev-${what.split(" ")[0]}`);
    let who: Actor = { token: bw.iw.owner.token, proof: await proof(), grantId: null };
    if (what === "owner grant") {
      const person = await bw.iw.w.person(`r2rev-owner-${++seq}`);
      const grantId = await bw.iw.h.grantKauroOwner(person.userId as never);
      who = { token: person.token, proof: await bw.iw.w.stepUp(person), grantId };
    }
    const body = { expectedVersion: r.routeVersion, rollout: "CONTROLLED", participants: [bw.iw.w.A.agencyId], authorizationRef: who.proof };
    await ctx.operation(`enable held behind the route lock (${what})`, async (op) => {
      if (what === "step-up proof") {
        bw.iw.faults.clock = op.clock;
        ctx.clock.set(Date.now());
      }
      const holder = await openHolder();
      const wc = await open();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [r.routeId]);
        const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => owner(bankRoutes.enable(r.routeId), body, { token: who.token })), `enable held behind the route lock (${what})`);
        // the revocation commits while the holder still holds the route lock: its own statements commit with the release
        await ctx.revoked(what, async () => {
          await revoke(r, who, holder);
          await holder.query("COMMIT");
        });
        await ctx.fenced(`enable after ${what}`, async () => {
          throw ok(await waiting.pending);
        }, (e) => (e as Reply).status >= 400 && code(e as Reply) === refusal);
      } finally {
        bw.iw.faults.clock = null;
        await holder.end();
        await wc.end();
      }
    });
    const row = await routeRow(r.routeId);
    assert.notEqual(row.state, "ENABLED", `${what}: enable blocked`);
    assert.equal(await n("SELECT 1 FROM kauro.bank_route_participants WHERE route_id = $1", [r.routeId]), 0, `${what}: no participant written`);
  }
  // a disable is retained whatever was revoked: the safety stop needs no qualification
  const live = await enabled("r2rev-disable", [bw.iw.w.A.agencyId]);
  await bw.evidence.corrupt(await detailsRefOf(live.routeId), new TextEncoder().encode("{}"));
  assert.equal(completed<{ route: RouteView }>(await owner(bankRoutes.disable(live.routeId), await disableBody(live)), 200).data.route.state, "VERIFIED");
});

cell(`RACE ACH-M-R2-PARTIAL (partial): ${R2}`, "partial", async (ctx) => {
  // the enable's writes in the command's real order (route-config.ts enable: update, appendParticipants, publish, journal); each LATER write
  // fails in turn — the first write (the version/state update) has no earlier completed step, so a failure there is not partial (I2 form)
  const steps: ReadonlyArray<SqlStep> = [
    { label: "route_update", match: /UPDATE kauro\.bank_routes/ },
    { label: "participants", match: /INSERT INTO kauro\.bank_route_participants/ },
    { label: "event", match: /INSERT INTO kauro\.domain_events/ },
    { label: "outbox", match: /INSERT INTO kauro\.outbox_records/ },
    { label: "journal", match: /UPDATE kauro\.command_journal/ },
  ];
  for (const step of steps.slice(1)) {
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
  assert.equal(code(await owner(bankRoutes.enable(r.routeId), await enableBody(r, [], "GENERAL"))), "409 PRECONDITION_FAILED GENERAL_ENABLE_CONDITION_UNMET", "no qualification payment");
  const order = completed<IssuedView>(await issue(b, r), 201).data;
  assert.equal(code(await owner(bankRoutes.enable(r.routeId), { ...(await enableBody(r, [], "GENERAL")), qualificationOrderId: order.order.orderId })), "409 PRECONDITION_FAILED GENERAL_ENABLE_CONDITION_UNMET", "an order awaiting transfer: no reconciled credit");
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
      assert.deepEqual(fp, { orders: 1, instructions: 1, accepted: 1, events: ISSUED_EVENTS }, "exactly one issuance and its events");
      assert.equal(code(await readInstructions(b, completed<IssuedView>(issued, 201).data.order.orderId)), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "the order stays, its details are hidden");
    } else {
      assert.equal(code(issued), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED");
      assert.deepEqual(fp, NOTHING_ISSUED);
    }
  }
});

cell(`RACE ACH-M-I1-TIMEOUT (time): ${I1}`, "race", async (ctx) => {
  // a DATABASE bound (statement_timeout, SQLSTATE 57014), not a controlled-clock deadline: the kit's lock-timeout form (b10-cells-support
  // kindOf: lock-timeout -> race; CLOSE_TMO) proves the wait on the holder (mustWait) and that it ended while the holder still held
  const b = await buyer("i1timeout");
  const r = await enabled("i1timeout", [b.a.s.agency.agencyId]);
  const holder = await openHolder();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM kauro.quotes WHERE quote_id::text = $1 FOR NO KEY UPDATE", [b.quote.quote.quoteId]);
    bw.iw.faults.statementTimeoutMs = INJECTED_STATEMENT_TIMEOUT_MS;
    const conn = await open();
    try {
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: conn, holder: connectionPid(holder) }, () => on(ctx, conn, () => issue(b, r)), "issuance whose readiness read times out");
      const reply = ok(await waiting.pending);
      assert.equal(code(reply), "503 CAPACITY_UNAVAILABLE -", "unknown capacity is not permission: retryable refusal");
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
      const holder = await openHolder();
      const wc = await open();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.quotes WHERE quote_id::text = $1 FOR NO KEY UPDATE", [b.quote.quote.quoteId]);
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
  assert.equal(code(reply), "409 PRECONDITION_FAILED QUOTE_EXPIRED", "the deadline read after the wait refuses");
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
  // the read locks were released: the quote row is lockable at once (NOWAIT raises 55P03 if any lock survived)
  const probe = await openHolder();
  try {
    await probe.query("BEGIN");
    await probe.query("SELECT 1 FROM kauro.quotes WHERE quote_id::text = $1 FOR UPDATE NOWAIT", [b.quote.quote.quoteId]);
    await probe.query("ROLLBACK");
  } finally {
    await probe.end();
  }
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
  assert.equal(code(await issue(b, r, { key })), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "a prior read grants no authority");
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
}, "uow");

cell(`RACE ACH-M-I1-RETRY (retry): ${I1}`, "retry", async (ctx) => {
  const b = await buyer("i1retry");
  const r = await enabled("i1retry", [b.a.s.agency.agencyId]);
  const key = freshKey("i1retry");
  // the first attempt is refused (another agency's participant list), the prerequisites change, the read runs again under current guards
  completed(await owner(bankRoutes.disable(r.routeId), await disableBody(r)), 200);
  assert.equal(code(await ctx.attempt(() => issue(b, r, { key }))), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED");
  const again = completed<{ route: RouteView }>(await owner(bankRoutes.enable(r.routeId), await enableBody({ ...r, state: "VERIFIED" }, [b.a.s.agency.agencyId])), 200).data.route;
  const issued = completed<IssuedView>(await ctx.attempt(() => issue(b, again, { key: freshKey("i1retry-2") })), 201);
  assert.equal(issued.data.transfer.routeVersion, again.routeVersion, "the readiness read binds the current route version");
  assert.deepEqual(await issuedFootprint(projectOf(b)), { orders: 1, instructions: 1, accepted: 1, events: ISSUED_EVENTS }, "one issuance after the refused attempt, with exactly its events");
});

cell(`DENY ACH-M-I1-REVOCATION (revocation): ${I1}`, "revocation", async (ctx) => {
  // each binding prerequisite withdrawn by a writer holding its own lock while the readiness read waits on it (r1 form: waitBehindWithdrawal;
  // the participant removed through the product's re-enable with a shorter allowlist, never a raw DELETE)
  const withdrawals: ReadonlyArray<readonly [string, (b: Buyer, r: RouteView) => Withdrawal, string]> = [
    ["billing membership", (b) => ({ sql: (holder) => revokeBilling(holder, b.a) }), "404 NOT_FOUND NOT_A_MEMBER"],
    ["billing identity", (b) => disableIdentity(b.a), "403 NOT_AUTHORIZED IDENTITY_DISABLED"],
    ["route participant", (_b, r) => narrowTo(r, [bw.iw.w.A.agencyId]), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED"],
    ["route enabled state", (_b, r) => ({ sql: (holder) => holder.query("UPDATE kauro.bank_routes SET state = 'VERIFIED' WHERE route_id = $1", [r.routeId]) }), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED"],
    ["plan approval", (b) => ({ command: () => withdrawPlanCall(b) }), "409 PRECONDITION_FAILED PLAN_WITHDRAWN"],
    ["target contract", (b) => supersedeTarget(b), "422 TARGET_STALE -"],
  ];
  for (const [what, withdrawal, refusal] of withdrawals) {
    const b = await buyer(`i1rev-${what.split(" ")[1]}`);
    const r = await enabled(`i1rev-${what.split(" ")[1]}`, [b.a.s.agency.agencyId]);
    const reply = await waitBehindWithdrawal(ctx, what, () => issue(b, r), withdrawal(b, r));
    assert.equal(code(reply), refusal, `${what}: the issuance behind the withdrawal is refused`);
    await ctx.fenced(`issuance after ${what}`, async () => {
      throw reply;
    }, (e) => code(e as Reply) === refusal);
    assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, `${what}: nothing issued`);
  }
});

cell(`RACE ACH-M-I1-PARTIAL (partial): ${I1}`, "partial", async (ctx) => {
  // the second reader (route readiness) fails after the first (subject locks) succeeded: no writable footprint
  const b = await buyer("i1partial");
  const r = await enabled("i1partial", [b.a.s.agency.agencyId]);
  const steps: ReadonlyArray<SqlStep> = [{ label: "subject_lock", match: /FROM kauro\.quotes/ }, { label: "route_read", match: /FROM kauro\.bank_routes/ }];
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
    assert.equal(code(ok(waited)), "409 PAYMENT_PENDING OPEN_ORDER_EXISTS", "no cross-route open duplicate");
    const fp = await issuedFootprint(projectOf(b));
    assert.deepEqual([fp.orders, fp.instructions, fp.accepted], [1, 1, 1]);
    assert.equal(await n("SELECT DISTINCT reference FROM kauro.bank_transfer_instructions i JOIN kauro.payment_orders o ON o.order_id = i.order_id WHERE o.project_id::text = $1", [projectOf(b)]), 1);
  }
});

cell(`RACE ACH-M-I2-TIMEOUT (time): ${I2}`, "race", async (ctx) => {
  // a DATABASE bound (statement_timeout, SQLSTATE 57014), not a controlled-clock deadline: the kit's lock-timeout form (b10-cells-support
  // kindOf: lock-timeout -> race; CLOSE_TMO) proves the wait on the holder (mustWait) and that it ended while the holder still held
  const b = await buyer("i2timeout");
  const r = await enabled("i2timeout", [b.a.s.agency.agencyId]);
  const key = freshKey("i2timeout");
  const holder = await openHolder();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [r.routeId]);
    bw.iw.faults.statementTimeoutMs = INJECTED_STATEMENT_TIMEOUT_MS;
    const conn = await open();
    try {
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: conn, holder: connectionPid(holder) }, () => on(ctx, conn, () => issue(b, r, { key })), "issuance past its statement timeout");
      const reply = ok(await waiting.pending);
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
      const holder = await openHolder();
      const wc = await open();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [r.routeId]);
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
  assert.equal(code(reply), "409 PRECONDITION_FAILED QUOTE_EXPIRED", "no extension of the price lifetime");
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
  assert.equal(code(hidden), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED");
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
  assert.equal(code(await ctx.attempt(() => issue(b, other, { key }))), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS", "the intent binds the route");
  const fp = await issuedFootprint(projectOf(b));
  assert.deepEqual([fp.orders, fp.instructions, fp.accepted], [1, 1, 1]);
  assert.match(views[0]!.data.transfer.reference, REFERENCE);
});

cell(`DENY ACH-M-I2-REVOCATION (revocation): ${I2}`, "revocation", async (ctx) => {
  // each issuance prerequisite revoked by a writer holding its own lock while Kinstructions waits on it (r1 form); the details replaced and
  // the participant removed through the product commands (replaceDetails, re-enable with a shorter allowlist), never raw writes
  const revocations: ReadonlyArray<readonly [string, (b: Buyer, r: RouteView) => Promise<Withdrawal>, string]> = [
    ["billing membership", async (b) => ({ sql: (holder) => revokeBilling(holder, b.a) }), "404 NOT_FOUND NOT_A_MEMBER"],
    ["billing identity", async (b) => disableIdentity(b.a), "403 NOT_AUTHORIZED IDENTITY_DISABLED"],
    ["route details replaced", async (_b, r) => {
      const d = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref, { accountNumber: "333333333333" });
      return { command: async () => owner(bankRoutes.details(r.routeId), { expectedVersion: r.routeVersion, detailsArtifactRef: d.artifactRef, detailsEvidenceHash: d.evidenceHash, authorizationRef: await proof() }) };
    }, "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED"],
    ["route participant", async (_b, r) => narrowTo(r, [bw.iw.w.A.agencyId]), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED"],
  ];
  for (const [what, revocation, refusal] of revocations) {
    const b = await buyer(`i2rev-${what.split(" ")[1]}`);
    const r = await enabled(`i2rev-${what.split(" ")[1]}`, [b.a.s.agency.agencyId]);
    const reply = await waitBehindWithdrawal(ctx, what, () => issue(b, r), await revocation(b, r));
    assert.equal(code(reply), refusal, `${what}: the issuance behind the revocation is refused`);
    await ctx.fenced(`issuance after ${what}`, async () => {
      throw reply;
    }, (e) => code(e as Reply) === refusal);
    assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, `${what}: no issuance`);
  }
});

cell(`RACE ACH-M-I2-PARTIAL (partial): ${I2}`, "partial", async (ctx) => {
  const steps: ReadonlyArray<SqlStep> = [
    { label: "quote_accept", match: /UPDATE kauro\.quotes/ },
    { label: "order_insert", match: /INSERT INTO kauro\.payment_orders/ },
    { label: "instructions", match: /INSERT INTO kauro\.bank_transfer_instructions/ },
    { label: "scope", match: /INSERT INTO kauro\.commerce_scopes/ },
    { label: "event", match: /INSERT INTO kauro\.domain_events/ },
    { label: "outbox", match: /INSERT INTO kauro\.outbox_records/ },
    { label: "journal", match: /UPDATE kauro\.command_journal/ },
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
    // the deadline is the earliest fixed deadline of the quote: min(price expiry, source availability) (D-ACH-04; r1 ADV-PV1R-2: the
    // fixture's source deadline is ~50 min before its price expiry, so the old price-only expectation encoded the defect); lifetime longer
    for (const delta of [-1, 0] as const) {
      const b = await buyer(`i2d-${delta}`);
      const windowMs = 2 * 86_400_000;
      const r = await enabled(`i2d-${delta}`, [b.a.s.agency.agencyId], { windowMs, lifetimeMs: 400 * 86_400_000 });
      const deadline = Math.min(Date.parse(b.quote.quote.expiresAt), Date.parse(b.quote.quote.sourceAvailableUntil));
      const reply = await ctx.operation(`issuance with deadline - effectNow = window ${delta} ms`, async (op) => {
        bw.iw.faults.clock = op.clock;
        try {
          // effectNow after the wait = deadline - window - delta: the window left is window + delta
          const effect = deadline - windowMs - delta;
          const boundary = ctx.deadline(deadline - windowMs, "latest issuance instant");
          ctx.clock.set(Date.parse(boundary) - 2);
          const holder = await openHolder();
          const wc = await open();
          await holder.query("BEGIN");
          await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [r.routeId]);
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
        assert.equal(code(reply), "409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT", "window - 1 ms: refused");
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
      assert.equal(code(read), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "disable won: details hidden");
      noAccountDigits(read, "after disable");
    }
    const after = await readInstructions(x.b, x.orderId);
    assert.equal(code(after), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "only ENABLED serves sensitive data");
    noAccountDigits(after, "next read");
  }
});

cell(`RACE ACH-M-I3-TIMEOUT (time): ${I3}`, "timeout", async (ctx) => {
  const x = await issuedOrder("i3timeout");
  const ref = await detailsRefOf(x.r.routeId);
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  // the artifact read is reached only after the product armed its bound (timer.start precedes store.get): the clock moves once it is armed
  let armed!: () => void;
  const readStarted = new Promise<void>((resolve) => (armed = resolve));
  const reply = await withStoreHook(ref, () => {
    armed();
    return stalled;
  }, () =>
    ctx.operation("guarded read whose artifact read never answers", async (op) => {
      ctx.deadline(op.clock.nowMs() + PROVIDER_CALL_TIMEOUT_MS, "artifact read bound");
      const pending = readInstructions(x.b, x.orderId);
      await readStarted;
      ctx.clock.advance(PROVIDER_CALL_TIMEOUT_MS + 1);
      const out = await pending;
      release();
      return out;
    }),
  );
  assert.equal(code(reply), "503 CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE");
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
  assert.equal(code(reply), "409 PRECONDITION_FAILED INSTRUCTIONS_EXPIRED", "expired instruction details are hidden");
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
  assert.equal(code(refetch), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "the refetch is guarded again");
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
  assert.equal(code(afterDisable), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "idempotency never bypasses visibility");
  noAccountDigits(afterDisable, "after disable");
});

cell(`DENY ACH-M-I3-REVOCATION (revocation): ${I3}`, "revocation", async (ctx) => {
  // each visibility prerequisite withdrawn while the projection is held at its artifact read: membership, route, details artifact.
  // The SESSION prerequisite is not exercised here (stated gap): bearer requests never read kauro.web_sessions, and bankWorld (KIT
  // bank-support.ts over statementsWorld) is built without the B11 session boundary (world({ sessions: true })), so no cookie request can
  // run in this file without changing support files outside the lane. It needs a sessions-enabled bank world (KIT/coordinator).
  type Issued = Awaited<ReturnType<typeof issuedOrder>>;
  interface Reader {
    read(): Promise<Reply>;
    withdraw(): Promise<unknown>;
  }
  const bearer = (x: Issued, withdraw: () => Promise<unknown>): Reader => ({ read: () => readInstructions(x.b, x.orderId), withdraw });
  const withdrawals: ReadonlyArray<readonly [string, (x: Issued) => Promise<Reader>, (r: Reply) => boolean]> = [
    ["membership", async (x) => bearer(x, () => bw.iw.w.asTenant(x.b.a.s.agency, (c) => revokeBilling(c, x.b.a))), (r) => code(r) === "404 NOT_FOUND NOT_A_MEMBER"],
    ["route enabled", async (x) => bearer(x, () => bw.iw.h.oracle.query("UPDATE kauro.bank_routes SET state = 'VERIFIED' WHERE route_id = $1", [x.r.routeId])), (r) => code(r) === "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED"],
    ["details artifact", async (x) => bearer(x, async () => bw.evidence.corrupt(await detailsRefOf(x.r.routeId), new TextEncoder().encode("{}"))), (r) => code(r) === "422 INTEGRITY_FAILURE HASH_MISMATCH"],
  ];
  for (const [what, readerOf, refused] of withdrawals) {
    const x = await issuedOrder(`i3rev-${what.split(" ")[0]}`);
    const reader = await readerOf(x);
    let reached!: () => void;
    let go!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    const running = withStoreHook(await detailsRefOf(x.r.routeId), async () => {
      reached();
      await released;
    }, () => ctx.operation(`projection held (${what})`, () => reader.read()));
    await atRead;
    await ctx.revoked(what, () => reader.withdraw());
    go();
    await ctx.fenced(`projection after ${what}`, async () => {
      throw await running;
    }, (e) => refused(e as Reply));
    const next = await reader.read();
    assert.ok(refused(next), `${what}: the next read is refused too (${next.status})`);
    noAccountDigits(next, `${what}: next read`);
  }
});

cell(`RACE ACH-M-I3-PARTIAL (partial): ${I3}`, "partial", async (ctx) => {
  // the snapshot and route reads answered, the artifact decrypt fails: fail closed, no body fragment, nothing logged. The projection's real
  // order (instructions.ts) is snapshot, route, version, artifact read, then authorization: the crash is the decrypt's own point, after them
  const x = await issuedOrder("i3partial");
  const ref = await detailsRefOf(x.r.routeId);
  const steps: ReadonlyArray<SqlStep> = [
    { label: "snapshot", match: /FROM kauro\.bank_transfer_instructions/ },
    { label: "guard", match: /FROM kauro\.bank_routes/ },
  ];
  const conn = await open();
  let reply: Reply | undefined;
  try {
    await ctx.partial("projection failing at the artifact decrypt after its reads", "details-store.decrypt", async () => {
      reply = await withStoreHook(ref, () => ctx.points.pass("details-store.decrypt"), () => on(ctx, conn, () => readInstructions(x.b, x.orderId), steps));
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
  assert.equal(code(await owner(bankRoutes.enable(r.routeId), await enableBody(r, [b.a.s.agency.agencyId]))), "409 PRECONDITION_FAILED ROUTE_NOT_VERIFIED");
  assert.equal(code(await issue(b, r)), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "no ENABLED route: no order");
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
  const v = completed<{ route: RouteView }>(await owner(bankRoutes.verify(r.routeId), await verifyBody(r)), 200).data.route;
  assert.equal(v.state, "VERIFIED");
  assert.equal(code(await issue(b, v)), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "VERIFIED is not ENABLED");
  const e = completed<{ route: RouteView }>(await owner(bankRoutes.enable(r.routeId), await enableBody(v, [b.a.s.agency.agencyId])), 200).data.route;
  assert.deepEqual([e.state, e.rollout], ["ENABLED", "CONTROLLED"]);
  // a buyer outside the CONTROLLED allowlist gets no instructions and no order (K-9)
  const outsider = await buyer("ach01-outsider");
  assert.equal(code(await issue(outsider, e)), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED");
  assert.deepEqual(await issuedFootprint(projectOf(outsider)), NOTHING_ISSUED);
  const issued = completed<IssuedView>(await issue(b, e), 201).data;
  assert.equal(issued.transfer.bankState, "AWAITING_TRANSFER");
  // withdrawn (replaced) details: back to PENDING_VERIFICATION; the order keeps its old snapshot, its details are hidden; no new issuance
  const d = await detailsArtifact((await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref, { accountNumber: "444444444444" });
  const replaced = completed<{ route: RouteView }>(await owner(bankRoutes.details(r.routeId), { expectedVersion: e.routeVersion, detailsArtifactRef: d.artifactRef, detailsEvidenceHash: d.evidenceHash, authorizationRef: await proof() }), 200).data.route;
  assert.deepEqual([replaced.state, replaced.routeVersion], ["PENDING_VERIFICATION", e.routeVersion + 1]);
  assert.equal((await q<{ v: number }>("SELECT route_version AS v FROM kauro.bank_transfer_instructions WHERE order_id::text = $1", [issued.order.orderId]))[0]!.v, e.routeVersion, "old snapshot preserved, never reassigned");
  const hidden = await readInstructions(b, issued.order.orderId);
  assert.equal(code(hidden), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED");
  noAccountDigits(hidden, "replaced details");
  const second = await buyer("ach01-second");
  assert.equal(code(await issue(second, replaced)), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED");
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
  assert.equal(code(await owner(bankRoutes.configure(), { ...(await configureBody({ accountRef: nextAccount("ach02-eur") })), currency: "EUR" })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  completed(await owner(bankRoutes.disable(x.r.routeId), await disableBody(x.r)), 200);
  noAccountDigits(await readInstructions(x.b, x.orderId), "disabled");
  // expired (r1, ADV-PV1R-8): a SECOND order on a route that stays ENABLED, read after its deadline on the database clock, so the
  // deadline check itself decides (the disabled route above would refuse first)
  const y = await issuedOrder("ach02-expired");
  assert.equal((await readInstructions(y.b, y.orderId)).status, 200, "served before its deadline");
  await bw.iw.h.oracle.query("UPDATE kauro.bank_transfer_instructions SET transfer_expires_at = now() - interval '1 millisecond' WHERE order_id::text = $1", [y.orderId]);
  assert.equal((await routeRow(y.r.routeId)).state, "ENABLED", "the route is still ENABLED");
  const expired = await readInstructions(y.b, y.orderId);
  assert.equal(code(expired), "409 PRECONDITION_FAILED INSTRUCTIONS_EXPIRED", "an expired order's details are hidden on an ENABLED route");
  noAccountDigits(expired, "expired");
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
  assert.equal(code(await issue(b, r, { key, body: { ...issueBody(b, r), routeId: "00000000-0000-0000-0000-000000000000" } })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS", "a conflicting key is refused");
});

// === adversary r1 (docs/review/pv1-route-adversary-r1.md): one cell per finding, each title prefixed with its finding id ===========

/** A cell whose title starts with its finding id: the matrix row it extends is named explicitly. */
function advCell(title: string, id: string, fault: FaultKind, body: (ctx: FaultContext) => Promise<void>): void {
  test(title, async () => {
    await runCell({ id, step: title.slice(title.indexOf(": ") + 2), fault, expect: title }, body);
  });
}
const DAY_MS = 86_400_000;
/** Coordinator ruling RR-2 (r1): the one I3 refusal for an existing visible order whose instructions are not readable. */
const INSTRUCTIONS_NOT_AVAILABLE = "409 PRECONDITION_FAILED INSTRUCTIONS_NOT_AVAILABLE";
/** What I3 answers a foreign agency's member for another agency's order (observed on a50db87; ACH-02: no existence signal). */
const FOREIGN_I3 = "404 NOT_FOUND -";
const iso = (ms: number): string => new Date(ms).toISOString();
const QUOTE_LOCK: SqlStep = { label: "quote_lock", match: /FROM kauro\.quotes WHERE quote_id = \$1 FOR NO KEY UPDATE/ };

/**
 * One issuance whose effect instant is `effectAt` on the step clock, read after a route-lock wait (the I2D form): the clock stands at
 * `before` while the issuance is dispatched, moves to `effectAt` while it waits, and the route lock is released.
 */
async function issueAt(ctx: FaultContext, b: Buyer, r: RouteView, boundary: { readonly at: number; readonly what: string }, before: number, effectAt: (boundary: number) => number): Promise<Reply> {
  return ctx.operation(`issuance across ${boundary.what}`, async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      const at = Date.parse(ctx.deadline(boundary.at, boundary.what));
      ctx.clock.set(before);
      const holder = await openHolder();
      const wc = await open();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [r.routeId]);
      const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => issue(b, r)), "issuance waits for the route lock");
      ctx.clock.set(effectAt(at));
      await holder.query("ROLLBACK");
      await holder.end();
      const out = ok(await waiting.pending);
      await wc.end();
      return out;
    } finally {
      bw.iw.faults.clock = null;
    }
  });
}

advCell(`ADV-PV1R-1 RACE ACH-M-I1-RACE (lock order, CMD043 close-agency vs bank issuance, both orders): closure and issuance of one agency never deadlock; closure first withdraws the quote and the issuance is refused with nothing issued, issuance first commits its order and the closure is refused CLOSURE_OBLIGATIONS_UNRECONCILED`, "ACH-M-I1-RACE", "race", async (ctx) => {
  // close-agency takes the agency row and its EXCLUSIVE half (close-agency.ts:75) and only then the open quotes FOR UPDATE (:114). The holder
  // pauses at the quote-lock statement: the closure BEFORE it (agency held, quote free), the issuance AFTER it (its quote lock held). An
  // issuance that locks the quote before the agency's shared half (a50db87, instructions.ts:85) closes a cycle with the closure: 40P01, which
  // the unit of work answers 503 CAPACITY_UNAVAILABLE. The D-ACH-04/B09 order (subject halves, then the route, then the quote) has no cycle.
  for (const first of ["close", "issue"] as const) {
    const b = await buyer(`adv1-${first}`);
    const r = await enabled(`adv1-${first}`, [b.a.s.agency.agencyId]);
    const agencyId = b.a.s.agency.agencyId;
    const [agencyRow] = await q<{ version: string }>("SELECT version::text FROM kauro.agencies WHERE agency_id::text = $1", [agencyId]);
    const closeBody = { expectedVersion: Number(agencyRow!.version), assuranceProofRef: await bw.iw.w.stepUp(b.a.s.owner) };
    const closing = () => call(bw.iw.w, { url: `/api/v1/agencies/${agencyId}/closure-requests`, token: b.a.s.owner.token, agency: null, key: freshKey("adv1-close"), body: closeBody });
    const issuing = () => issue(b, r);
    const { held, waited } =
      first === "close"
        ? await holdAndWait(ctx, "issuance waits behind the closure's agency half", closing, issuing, "db.quote_lock.before", [QUOTE_LOCK])
        : await holdAndWait(ctx, "closure waits behind the issuance", issuing, closing, "db.quote_lock.after", [QUOTE_LOCK]);
    const closed = ok(first === "close" ? held : waited);
    const issued = ok(first === "close" ? waited : held);
    const replies = `${first} first: closure ${code(closed)}, issuance ${code(issued)}`;
    assert.ok(![500, 503].includes(closed.status) && ![500, 503].includes(issued.status), `no deadlock (40P01 -> 503 CAPACITY_UNAVAILABLE) and no crash: ${replies}`);
    const [quote] = await q<{ state: string }>("SELECT state FROM kauro.quotes WHERE quote_id::text = $1", [b.quote.quote.quoteId]);
    const [agency] = await q<{ state: string }>("SELECT state FROM kauro.agencies WHERE agency_id::text = $1", [agencyId]);
    if (first === "close") {
      assert.equal(closed.status, 200, replies);
      assert.deepEqual([agency!.state, quote!.state], ["CLOSING", "WITHDRAWN"], "the closure withdrew the open quote");
      assert.equal(code(issued), "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE", `the issuance behind it is refused exactly AGENCY_NOT_ACTIVE: ${replies}`);
      assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
    } else {
      assert.equal(issued.status, 201, replies);
      assert.equal(code(closed), "409 PRECONDITION_FAILED CLOSURE_OBLIGATIONS_UNRECONCILED", replies);
      assert.deepEqual([agency!.state, quote!.state], ["ACTIVE", "ACCEPTED_FOR_CHECKOUT"], "the agency stays ACTIVE with its accepted quote");
      assert.deepEqual(await issuedFootprint(projectOf(b)), { orders: 1, instructions: 1, accepted: 1, events: ISSUED_EVENTS });
    }
  }
});

advCell(`ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (source availability deadline): transferExpiresAt is the quote's source availability deadline when it precedes the price expiry and the lifetime; window - 1 ms before it is refused TRANSFER_WINDOW_TOO_SHORT with nothing issued, = window issues with transferExpiresAt = source deadline and sendBy = source deadline - window`, "ACH-M-I2-EXPIRY", "expiry", async (ctx) => {
  for (const delta of [-1, 0] as const) {
    const b = await buyer(`adv2-src-${delta}`);
    const source = Date.parse(b.quote.quote.sourceAvailableUntil);
    const price = Date.parse(b.quote.quote.expiresAt);
    assert.ok(source < price, `fixture: the source deadline (${b.quote.quote.sourceAvailableUntil}) precedes the price expiry (${b.quote.quote.expiresAt})`);
    const windowMs = 2 * DAY_MS;
    const r = await enabled(`adv2-src-${delta}`, [b.a.s.agency.agencyId], { windowMs, lifetimeMs: 400 * DAY_MS });
    // effectNow after the wait = source - window - delta: the window left before the source deadline is window + delta
    const reply = await issueAt(ctx, b, r, { at: source - windowMs, what: "latest issuance instant before the source deadline" }, source - windowMs - 2, (at) => at - delta);
    if (delta === -1) {
      assert.equal(code(reply), "409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT", "window - 1 ms before the source deadline: refused");
      assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
    } else {
      const t = completed<IssuedView>(reply, 201).data.transfer;
      assert.deepEqual([t.transferExpiresAt, t.sendBy], [iso(source), iso(source - windowMs)], "the source deadline bounds the transfer");
    }
  }
});

advCell(`ADV-PV1R-2 DENY ACH-M-I2-EXPIRY (details validity): the route version's details validUntil bounds the transfer; validUntil crossing while the issuance waits at the route lock is refused DETAILS_EXPIRED with nothing issued, and an issuance window before it gets transferExpiresAt = validUntil`, "ACH-M-I2-EXPIRY", "expiry", async (ctx) => {
  const windowMs = 2 * DAY_MS;
  // (1) validUntil 5 days ahead (price 14 d, source ~14 d, lifetime 10 d): it passes during the route-lock wait
  const validUntil = Date.now() + 5 * DAY_MS;
  const b = await buyer("adv2-valid");
  const r = await enabled("adv2-valid", [b.a.s.agency.agencyId], { windowMs, validUntil: iso(validUntil) });
  const crossed = await issueAt(ctx, b, r, { at: validUntil, what: "details validity" }, validUntil - 1, (at) => at);
  assert.equal(code(crossed), "409 PRECONDITION_FAILED DETAILS_EXPIRED", "details expired at the effect instant: nothing issued");
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
  // (2) issued exactly one window before validUntil: transferExpiresAt = validUntil, sendBy = validUntil - window
  // part (1) left the controlled clock near validUntil (+5 d); part (2) starts after it so the clock only moves forward
  const v2 = Date.now() + 9 * DAY_MS;
  const b2 = await buyer("adv2-valid-cap");
  const r2 = await enabled("adv2-valid-cap", [b2.a.s.agency.agencyId], { windowMs, lifetimeMs: 400 * DAY_MS, validUntil: iso(v2) });
  const capped = completed<IssuedView>(await issueAt(ctx, b2, r2, { at: v2 - windowMs, what: "latest issuance instant before the details validity" }, v2 - windowMs - 2, (at) => at), 201).data.transfer;
  assert.deepEqual([capped.transferExpiresAt, capped.sendBy], [iso(v2), iso(v2 - windowMs)], "the details validity bounds the transfer");
});

advCell(`ADV-PV1R-2 DENY ACH-M-I3-EXPIRY (details validity): the instructions are hidden once the route version's details validUntil passes at the artifact read, before the instruction deadline`, "ACH-M-I3-EXPIRY", "expiry", async (ctx) => {
  const validUntil = Date.now() + 5 * DAY_MS;
  const x = await issuedOrder("adv2-i3", { validUntil: iso(validUntil) });
  const reply = await ctx.operation("guarded read across the details validity", async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      ctx.clock.set(validUntil - 1);
      const boundary = ctx.deadline(validUntil, "details validity");
      return await withStoreHook(await detailsRefOf(x.r.routeId), async () => void ctx.clock.set(Date.parse(boundary)), () => readInstructions(x.b, x.orderId));
    } finally {
      bw.iw.faults.clock = null;
    }
  });
  // coordinator ruling RR-2: one code for every not-readable reason of an existing visible order (order not open, details expired)
  assert.equal(code(reply), INSTRUCTIONS_NOT_AVAILABLE, "expired details are hidden");
  noAccountDigits(reply, "details expired");
});

advCell(`ADV-PV1R-3 DENY ACH-M-I3-REVOCATION (bank order state): the transfer instructions are hidden once the bank order is CAPTURED, RECEIVED_REVIEW or EXPIRED before its deadline, at the held read and at the next read`, "ACH-M-I3-REVOCATION", "revocation", async (ctx) => {
  // D-ACH-05: EXPIRED stops instructions; RECEIVED_REVIEW is closed to further instructions; CAPTURED is paid. Only AWAITING_TRANSFER and
  // PARTIALLY_RECEIVED are open. The state moves (as the payment service would) while the projection is held at its artifact read.
  // coordinator ruling RR-2: exactly 409 PRECONDITION_FAILED INSTRUCTIONS_NOT_AVAILABLE, no account digit and no reference fragment
  for (const state of ["CAPTURED", "RECEIVED_REVIEW", "EXPIRED"] as const) {
    const x = await issuedOrder(`adv3-${state.toLowerCase()}`);
    const refused = (r: Reply): boolean => code(r) === INSTRUCTIONS_NOT_AVAILABLE && !r.text.includes(ACCOUNT_DIGITS) && !r.text.includes("026073150") && !r.text.includes(x.reference);
    let reached!: () => void;
    let go!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    const running = withStoreHook(await detailsRefOf(x.r.routeId), async () => {
      reached();
      await released;
    }, () => ctx.operation(`projection held (order ${state})`, () => readInstructions(x.b, x.orderId)));
    await atRead;
    // 0062: an EXPIRED edge names its cause; before the deadline that cause is a retirement (CMD214 consumed by the payment service)
    await ctx.revoked(`order ${state}`, async () => {
      const moved = await bw.iw.h.oracle.query("UPDATE kauro.bank_transfer_instructions SET order_state = $2, expiry_cause = CASE WHEN $2 = 'EXPIRED' THEN 'RETIRED' END WHERE order_id::text = $1 AND order_state = 'AWAITING_TRANSFER'", [x.orderId, state]);
      assert.equal(moved.rowCount, 1, `the bank order moved AWAITING_TRANSFER -> ${state}`);
    });
    go();
    const held = await running;
    assert.ok(refused(held), `order ${state}: the held read is refused with no account digit (got ${code(held)})`);
    await ctx.fenced(`projection after order ${state}`, async () => {
      throw held;
    }, (e) => refused(e as Reply));
    const next = await readInstructions(x.b, x.orderId);
    assert.ok(refused(next), `order ${state}: the next read is refused too (${code(next)})`);
    assert.equal((await q<{ order_state: string; at: Date }>("SELECT order_state, transfer_expires_at AS at FROM kauro.bank_transfer_instructions WHERE order_id::text = $1", [x.orderId]))[0]!.order_state, state);
  }
});

test(`ADV-PV1R-12 DENY ACH-M-I3-REVOCATION (PARTIALLY_RECEIVED): an order the bank snapshot marks PARTIALLY_RECEIVED is not served its full obligation amount; the read is refused INSTRUCTIONS_NOT_AVAILABLE with no account digits (GAP: remaining amount, L-INBOUND E1)`, async () => {
  const x = await issuedOrder("adv12-partial");
  assert.equal((await readInstructions(x.b, x.orderId)).status, 200, "served while AWAITING_TRANSFER");
  const moved = await bw.iw.h.oracle.query("UPDATE kauro.bank_transfer_instructions SET order_state = 'PARTIALLY_RECEIVED' WHERE order_id::text = $1 AND order_state = 'AWAITING_TRANSFER'", [x.orderId]);
  assert.equal(moved.rowCount, 1, "the bank order moved AWAITING_TRANSFER -> PARTIALLY_RECEIVED");
  const reply = await readInstructions(x.b, x.orderId);
  assert.equal(code(reply), INSTRUCTIONS_NOT_AVAILABLE, "no instructions (and no full amount) for a partially received order");
  assert.ok(!reply.text.includes(ACCOUNT_DIGITS) && !reply.text.includes("026073150") && !reply.text.includes(x.reference), "no account digit, routing digit or reference");
});

advCell(`ADV-PV1R-4 RACE ACH-M-R1-RACE (stale evidence naming the replacement's version): a verify that read version-1 evidence before a replacement committed is refused STALE_VERSION even when its expectedVersion is 2, and version 2 stays unverified until a verify reads its own evidence`, "ACH-M-R1-RACE", "race", async (ctx) => {
  // the seen-version guard decides (route-config.ts:296): expectedVersion = 2 equals the locked current version, so only the version whose
  // evidence the verify read (1) refuses it. Without that guard the verify marks version 2 VERIFIED on version-1 evidence.
  const r = await configured("adv4-stale");
  const account = (await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref;
  const replacement = await detailsArtifact(account, { accountNumber: "555555555555" });
  const replace = async () => owner(bankRoutes.details(r.routeId), { expectedVersion: 1, detailsArtifactRef: replacement.artifactRef, detailsEvidenceHash: replacement.evidenceHash, authorizationRef: await proof() });
  const v1Ref = await detailsRefOf(r.routeId);
  const v1Reads = (): number => bw.evidence.calls.filter((c) => c.identity === v1Ref && c.operation === "GET").length;
  const before = v1Reads();
  const verifyNaming2 = async () => owner(bankRoutes.verify(r.routeId), await verifyBody(r, 2));
  const { held, waited } = await holdAndWait(ctx, "verify naming version 2 waits for the replacement", replace, verifyNaming2);
  assert.equal(ok(held).status, 200, "the replacement commits");
  assert.equal(v1Reads(), before + 1, "the waiting verify read version 1's evidence before the lock");
  assert.equal(code(ok(waited)), "409 STALE_VERSION ROUTE_VERSION_CHANGED", "evidence of version 1 never verifies version 2");
  const row = await routeRow(r.routeId);
  assert.deepEqual([row.state, row.current_version, row.versions], ["PENDING_VERIFICATION", 2, 2]);
  assert.equal(await n("SELECT 1 FROM kauro.bank_route_versions WHERE route_id = $1 AND verified_at IS NOT NULL", [r.routeId]), 0, "no version verified");
  const again = completed<{ route: RouteView }>(await owner(bankRoutes.verify(r.routeId), await verifyBody(r, 2)), 200).data.route;
  assert.deepEqual([again.state, again.routeVersion, again.detailsEvidenceHash], ["VERIFIED", 2, replacement.evidenceHash], "a verify that reads version 2's evidence qualifies it");
});

test(`ADV-PV1R-4 DENY ACH-M-R1-PARTIAL (incomplete details at verify): a replacement whose details lack the routing number is accepted unqualified (departure 3), and the verify that reads and classifies it is refused 422 INTEGRITY_FAILURE MALFORMED_EVIDENCE with no version verified`, async () => {
  // closest real hook to the design's "after account number read": the store read of the version-2 artifact (bw.evidence.get), immediately
  // before the frozen contract-fake classifier parses it; the hook proves the refusal comes from classifying THAT artifact
  const r = await configured("adv4-malformed");
  const account = (await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref;
  const incomplete = await detailsArtifact(account, { routingNumber: null });
  const replaced = completed<{ route: RouteView }>(await owner(bankRoutes.details(r.routeId), { expectedVersion: 1, detailsArtifactRef: incomplete.artifactRef, detailsEvidenceHash: incomplete.evidenceHash, authorizationRef: await proof() }), 200).data.route;
  assert.deepEqual([replaced.state, replaced.routeVersion], ["PENDING_VERIFICATION", 2], "the replacement binds the account only");
  let reads = 0;
  const refused = await withStoreHook(incomplete.artifactRef, async () => void reads++, async () => owner(bankRoutes.verify(r.routeId), await verifyBody(replaced)));
  assert.equal(reads, 1, "the verify read the version-2 artifact");
  assert.equal(code(refused), "422 INTEGRITY_FAILURE MALFORMED_EVIDENCE", "unclassifiable evidence never qualifies");
  const row = await routeRow(r.routeId);
  assert.deepEqual([row.state, row.current_version, row.versions], ["PENDING_VERIFICATION", 2, 2]);
  assert.equal(await n("SELECT 1 FROM kauro.bank_route_versions WHERE route_id = $1 AND verified_at IS NOT NULL", [r.routeId]), 0, "no verification fact");
});

advCell(`ADV-PV1R-5 DENY ACH-M-I2-REVOCATION (allowlist narrowed by re-enable): an agency dropped from a CONTROLLED allowlist by a re-enable that commits while its issuance waits at the route lock is refused ROUTE_NOT_ENABLED with nothing issued, stays refused afterwards, and the agency kept on the list issues`, "ACH-M-I2-REVOCATION", "revocation", async (ctx) => {
  const x = await buyer("adv5-dropped");
  const y = await buyer("adv5-kept");
  const r = await enabled("adv5", [x.a.s.agency.agencyId, y.a.s.agency.agencyId]);
  const reply = await waitBehindWithdrawal(ctx, "allowlist narrowed to the kept agency", () => issue(x, r), narrowTo(r, [y.a.s.agency.agencyId]));
  await ctx.fenced("issuance of the dropped agency", async () => {
    throw reply;
  }, (e) => code(e as Reply) === "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED");
  assert.deepEqual(await issuedFootprint(projectOf(x)), NOTHING_ISSUED, "dropped agency: nothing issued");
  assert.deepEqual((({ state, rollout, current_version }) => [state, rollout, current_version])(await routeRow(r.routeId)), ["ENABLED", "CONTROLLED", r.routeVersion], "the route stays ENABLED at the same details version");
  assert.equal(code(await issue(x, r)), "409 PRECONDITION_FAILED ROUTE_NOT_ENABLED", "a later issuance of the dropped agency is refused too");
  assert.equal(completed<IssuedView>(await issue(y, r), 201).data.transfer.bankState, "AWAITING_TRANSFER", "the kept agency issues");
});

test(`ADV-PV1R-5 DENY ACH-M-I3-REVOCATION (allowlist narrowed by re-enable): the instructions of an order issued before its agency was dropped from the CONTROLLED allowlist are hidden after the re-enable`, async () => {
  // coordinator ruling RR-3: refused with exactly the answer a foreign agency gets for the same order (no existence signal; ACH-ROUTE.md:81
  // CONTROLLED allowlist, ACH-02 "foreign reads expose no details")
  const x = await buyer("adv5-i3");
  const r = await enabled("adv5-i3", [x.a.s.agency.agencyId, bw.iw.w.A.agencyId]);
  const order = completed<IssuedView>(await issue(x, r), 201).data.order;
  assert.equal((await readInstructions(x, order.orderId)).status, 200, "served while the agency is on the list");
  completed(await owner(bankRoutes.enable(r.routeId), await enableBody(r, [bw.iw.w.A.agencyId])), 200);
  const foreign = await agentOf(bw.iw, `adv5-i3-foreign-${++seq}`);
  const foreignRead = await readInstructions({ a: foreign }, order.orderId);
  assert.equal(code(foreignRead), FOREIGN_I3, "the foreign-agency answer (I3-RETRY)");
  const hidden = await readInstructions(x, order.orderId);
  assert.equal(code(hidden), code(foreignRead), "a dropped agency gets the foreign-agency answer");
  noAccountDigits(hidden, "dropped agency");
});

/** ADV-PV1R-14: wall-clock allowance for the setup of the real-time cell (configure + step-up + verify body + lock wait) on a loaded leg. */
const ADV7_SETUP_ALLOWANCE_MS = 20_000;

advCell(`ADV-PV1R-7 DENY ACH-M-R1-EXPIRY (product effect clock, no step clock): details whose validUntil passes in real time while the verify waits at the route lock are refused DETAILS_EXPIRED, judged by kauro.effect_now() after the wait, not by the transaction start`, "ACH-M-R1-EXPIRY", "race", async (ctx) => {
  // no step clock is set, so the harness proxy (fault-support.ts repositioned) calls the product effectInstant SQL itself; the deadline is
  // crossed by the database's own clock between the transaction's start and the effect read: red if effectInstant reads transaction_timestamp()
  assert.equal(bw.iw.faults.clock, null, "no step clock: the product effect instant answers");
  // ADV-PV1R-14: the setup (configure at its effect instant, step-up proof, two connections, the lock wait) must finish before validUntil.
  // The kit declares no slack constant, so the allowance is a named constant; setup outrunning it refuses as a harness precondition.
  const setupStarted = Date.now();
  const validUntil = setupStarted + ADV7_SETUP_ALLOWANCE_MS;
  const r = await configured("adv7", { validUntil: iso(validUntil) });
  const body = await verifyBody(r);
  const holder = await openHolder();
  const wc = await open();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [r.routeId]);
    const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, () => owner(bankRoutes.verify(r.routeId), body)), "verify waits at the route lock");
    assert.ok(Date.now() < validUntil, `HARNESS PRECONDITION (not a product assertion): setup took ${Date.now() - setupStarted} ms, longer than the ${ADV7_SETUP_ALLOWANCE_MS} ms allowance`);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, validUntil - Date.now() + 300)));
    assert.equal((await q<{ crossed: boolean }>("SELECT clock_timestamp() > $1::timestamptz AS crossed", [iso(validUntil)]))[0]!.crossed, true, "the database clock passed validUntil during the wait");
    await holder.query("ROLLBACK");
    const reply = ok(await waiting.pending);
    assert.equal(code(reply), "409 PRECONDITION_FAILED DETAILS_EXPIRED", "the effect instant after the wait decides");
  } finally {
    await holder.end();
    await wc.end();
  }
  assert.deepEqual((({ state, versions, events }) => [state, versions, events])(await routeRow(r.routeId)), ["PENDING_VERIFICATION", 1, 1]);
});

advCell(`ADV-PV1R-8 RACE ACH-M-R2-RACE (two configures of one account): two owners configuring the same account race at its route row; one route exists, the configure that waited is refused UNLISTED_TRANSITION and writes nothing`, "ACH-M-R2-RACE", "race", async (ctx) => {
  // the two commands are the same command (symmetric): one order is both orders
  const account = nextAccount("adv8-configure");
  const a = await configureBody({ accountRef: account });
  const other = await configureBody({ accountRef: account });
  const { held, waited } = await holdAndWait(ctx, "the second configure of the account waits", () => owner(bankRoutes.configure(), a), () => owner(bankRoutes.configure(), other));
  assert.equal(ok(held).status, 201, "the first configure commits");
  assert.equal(code(ok(waited)), "409 PRECONDITION_FAILED UNLISTED_TRANSITION", "the account already has a route");
  assert.equal(await routesOf(account), 1, "one route per account");
  assert.equal(await n("SELECT 1 FROM kauro.bank_route_versions v JOIN kauro.bank_routes r ON r.route_id = v.route_id WHERE r.account_ref = $1", [account]), 1, "one version");
});

test(`ADV-PV1R-8 OK ACH-03 (forced reference collision): an issuance whose first reference draw collides with an existing reference of the same account draws again before COMMIT and issues once with a different reference`, async () => {
  // the collision is injected in the database: a one-shot BEFORE INSERT trigger rewrites the next snapshot's reference to an existing one, so
  // ON CONFLICT ... DO NOTHING answers no row and the issuance must draw again (red with MAX_REFERENCE_DRAWS = 1: 503 CAPACITY_UNAVAILABLE)
  const b1 = await buyer("adv8-collide-1");
  const b2 = await buyer("adv8-collide-2");
  const r = await enabled("adv8-collide", [b1.a.s.agency.agencyId, b2.a.s.agency.agencyId]);
  const first = completed<IssuedView>(await issue(b1, r), 201).data.transfer.reference;
  const account = (await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.account_ref;
  const o = bw.iw.h.oracle;
  await o.query("CREATE TABLE IF NOT EXISTS public.adv8_reference_collision (account_ref text PRIMARY KEY, reference text NOT NULL, fired integer NOT NULL DEFAULT 0)");
  await o.query(`CREATE OR REPLACE FUNCTION public.adv8_collide() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
    DECLARE forced text;
    BEGIN
      UPDATE public.adv8_reference_collision SET fired = fired + 1 WHERE account_ref = NEW.account_ref AND fired = 0 RETURNING reference INTO forced;
      IF forced IS NOT NULL THEN NEW.reference := forced; END IF;
      RETURN NEW;
    END $$`);
  await o.query("CREATE TRIGGER adv8_collide BEFORE INSERT ON kauro.bank_transfer_instructions FOR EACH ROW EXECUTE FUNCTION public.adv8_collide()");
  try {
    await o.query("INSERT INTO public.adv8_reference_collision (account_ref, reference) VALUES ($1, $2)", [account, first]);
    const second = completed<IssuedView>(await issue(b2, r), 201).data.transfer.reference;
    assert.equal((await q<{ fired: number }>("SELECT fired FROM public.adv8_reference_collision WHERE account_ref = $1", [account]))[0]!.fired, 1, "the first draw collided");
    assert.notEqual(second, first, "a different reference after the collision");
    assert.match(second, REFERENCE);
    assert.deepEqual((({ orders, instructions }) => [orders, instructions])(await issuedFootprint(projectOf(b2))), [1, 1], "issued once");
    assert.equal(await n("SELECT 1 FROM kauro.bank_transfer_instructions WHERE account_ref = $1 AND reference = $2", [account, first]), 1, "the existing reference is never reused");
  } finally {
    await o.query("DROP TRIGGER IF EXISTS adv8_collide ON kauro.bank_transfer_instructions");
    await o.query("DROP FUNCTION IF EXISTS public.adv8_collide()");
    await o.query("DROP TABLE IF EXISTS public.adv8_reference_collision");
  }
});

test(`ADV-PV1R-10 DENY ACH-M-I3-RETRY (authorize before the evidence read): a caller who is not a member of the agency it names is refused 404 NOT_A_MEMBER and the details artifact is never read from the store`, async () => {
  const x = await issuedOrder("adv10-i3");
  const ref = await detailsRefOf(x.r.routeId);
  const gets = (): number => bw.evidence.calls.filter((c) => c.identity === ref && c.operation === "GET").length;
  const before = gets();
  const foreign = await agentOf(bw.iw, `adv10-foreign-${++seq}`);
  const reply = await readInstructions(x.b, x.orderId, foreign.billing.token, x.b.a.s.agency.agencyId);
  assert.equal(code(reply), "404 NOT_FOUND NOT_A_MEMBER");
  noAccountDigits(reply, "foreign caller");
  assert.equal(gets(), before, "no store read for a caller whose membership was not established");
});

test(`ADV-PV1R-10 DENY ACH-M-I1-RETRY (authorize before locking): a caller who is not a member of the agency it names is refused 404 NOT_A_MEMBER without waiting on that agency's quote row`, async () => {
  const b = await buyer("adv10-lock");
  const r = await enabled("adv10-lock", [b.a.s.agency.agencyId]);
  const foreign = await agentOf(bw.iw, `adv10-lock-foreign-${++seq}`);
  const holder = await openHolder();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM kauro.quotes WHERE quote_id::text = $1 FOR NO KEY UPDATE", [b.quote.quote.quoteId]);
    const pending = issue(b, r, { token: foreign.billing.token });
    // bounded: an authorized-first issuance answers in well under 3 s; one that locks the quote first waits for this holder
    const raced = await Promise.race([pending, new Promise<"WAITING">((resolve) => setTimeout(() => resolve("WAITING"), 3_000))]);
    await holder.query("ROLLBACK");
    const reply = raced === "WAITING" ? await pending : raced;
    assert.notEqual(raced, "WAITING", `the non-member's issuance waited on the victim's quote row (then answered ${code(reply)})`);
    assert.equal(code(reply), "404 NOT_FOUND NOT_A_MEMBER");
  } finally {
    await holder.end();
  }
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED);
});

test(`ADV-PV1R-10 DENY RLS (tenant columns of a bank route): a participant agency's session reads no owner identifier or evidence reference of the route or its versions, and a non-participant agency reads no route or version row`, async () => {
  const b = await buyer("adv10-rls");
  const r = await enabled("adv10-rls", [b.a.s.agency.agencyId]);
  const asAgency = <T>(agency: Agent["s"]["agency"], sql: string): Promise<T[] | string> =>
    bw.iw.w.asTenant(agency, async (c) => {
      try {
        return (await c.query(sql, [r.routeId])).rows as T[];
      } catch (e) {
        return String((e as { code?: string }).code);
      }
    });
  // ADV-PV1R-13: one statement per withheld column, so re-granting any single column turns its own assertion red
  for (const [table, column] of [["bank_route_versions", "verified_by::text"], ["bank_route_versions", "created_by::text"], ["bank_route_versions", "verification_evidence_ref"], ["bank_routes", "created_by::text"]] as const) {
    const got = await asAgency<Record<string, unknown>>(b.a.s.agency, `SELECT ${column} AS v FROM kauro.${table} WHERE route_id = $1`);
    assert.equal(got, "42501", `participant: ${table}.${column} is denied (got ${JSON.stringify(got)})`);
  }
  const visible = await asAgency<Record<string, unknown>>(b.a.s.agency, "SELECT details_artifact_ref AS v FROM kauro.bank_route_versions WHERE route_id = $1");
  assert.ok(Array.isArray(visible) && visible.length === 1, `participant: the tenant-visible details reference stays readable (got ${JSON.stringify(visible)})`);
  const outsider = await agentOf(bw.iw, `adv10-rls-outsider-${++seq}`);
  assert.deepEqual(await asAgency(outsider.s.agency, "SELECT route_id FROM kauro.bank_routes WHERE route_id = $1"), [], "non-participant: no route row");
  assert.deepEqual(await asAgency(outsider.s.agency, "SELECT route_version FROM kauro.bank_route_versions WHERE route_id = $1"), [], "non-participant: no version row");
});

/** Runs `fn` with the store's reads of `refs` answering evidence whose metadata is overridden by `over` (bytes and hash unchanged). */
async function withEvidenceAs<T>(refs: ReadonlySet<string>, over: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const store = bw.evidence as unknown as { get: (ref: string) => Promise<unknown> };
  const real = store.get;
  store.get = async (ref: string) => {
    const evidence = await real.call(bw.evidence, ref);
    return refs.has(ref) && evidence !== null && typeof evidence === "object" ? { ...(evidence as object), ...over } : evidence;
  };
  try {
    return await fn();
  } finally {
    store.get = real;
  }
}

test(`ADV-PV1R-11 DENY ACH-M-R1-RETRY (integration class and provider bound at every evidence read): a replacement artifact of the route's account and environment but of another integration class or another provider is refused DETAILS_ACCOUNT_MISMATCH and writes nothing`, async () => {
  // (1) a PROVIDER-class route (its configure artifact reads back as provider-integration evidence) and a CONTRACT_FAKE replacement
  const account = nextAccount("adv11-class");
  const body = await configureBody({ accountRef: account });
  const r = await withEvidenceAs(new Set([body.detailsArtifactRef]), { integrationClass: "PROVIDER" }, async () => completed<{ route: RouteView }>(await owner(bankRoutes.configure(), body), 201).data.route);
  assert.equal((await q<{ c: string }>("SELECT integration_class AS c FROM kauro.bank_routes WHERE route_id = $1", [r.routeId]))[0]!.c, "PROVIDER");
  const fake = await detailsArtifact(account, { accountNumber: "666666666666" });
  const classRefused = await owner(bankRoutes.details(r.routeId), { expectedVersion: 1, detailsArtifactRef: fake.artifactRef, detailsEvidenceHash: fake.evidenceHash, authorizationRef: await proof() });
  assert.equal(code(classRefused), "409 PRECONDITION_FAILED DETAILS_ACCOUNT_MISMATCH", "a contract fake never replaces provider evidence");
  assert.deepEqual((({ state, current_version, versions, events }) => [state, current_version, versions, events])(await routeRow(r.routeId)), ["PENDING_VERIFICATION", 1, 1, 1]);
  // (2) a CONTRACT_FAKE route and a replacement artifact of the same account whose provider is another one
  const r2 = await configured("adv11-provider");
  const account2 = (await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [r2.routeId]))[0]!.account_ref;
  const foreignProvider = await detailsArtifact(account2, { accountNumber: "777777777777" });
  const providerRefused = await withEvidenceAs(new Set([foreignProvider.artifactRef]), { provider: "another-bank-provider" }, async () =>
    owner(bankRoutes.details(r2.routeId), { expectedVersion: 1, detailsArtifactRef: foreignProvider.artifactRef, detailsEvidenceHash: foreignProvider.evidenceHash, authorizationRef: await proof() }),
  );
  assert.equal(code(providerRefused), "409 PRECONDITION_FAILED DETAILS_ACCOUNT_MISMATCH", "another provider's evidence never replaces the route's");
  assert.deepEqual((({ state, current_version, versions, events }) => [state, current_version, versions, events])(await routeRow(r2.routeId)), ["PENDING_VERIFICATION", 1, 1, 1]);
});

test(`ADV-PV1R-6 DENY ACH-M-I3-EXPIRY (session): a browser session whose idle expiry passes while the instructions read is held at its artifact read is refused with no account digits, exactly as a read after the expiry`, async () => {
  const main = bw;
  const sessionsWorld = await bankWorld({ sessions: true });
  bw = sessionsWorld;
  try {
    const x = await issuedOrder("adv6-expiry");
    const idf = bw.iw.w.identity();
    const session = await idf.signIn(x.b.a.billing);
    const cookieRead = (): Promise<Reply> => call(bw.iw.w, { method: "GET", url: bankRoutes.instructions(x.orderId), token: null, agency: x.b.a.s.agency.agencyId, key: null, contentType: null, headers: { cookie: session.cookie, origin: idf.origin } });
    const live = await cookieRead();
    assert.equal(live.status, 200, `served under a live session (${code(live)})`);
    let reached!: () => void;
    let go!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    const running = withStoreHook(await detailsRefOf(x.r.routeId), async () => {
      reached();
      await released;
    }, cookieRead);
    await atRead;
    // the idle expiry passes during the held read: the session row's idle_expires_at is set just after its last_seen_at (the CHECK allows nothing
    // earlier), which the world's real clock has passed within milliseconds. bankWorld does not take a movable session clock.
    const aged = await bw.iw.h.oracle.query("UPDATE kauro.web_sessions SET idle_expires_at = last_seen_at + interval '1 millisecond' WHERE secret_sha256 = $1", [session.secretSha256]);
    assert.equal(aged.rowCount, 1, "the session row aged through its idle expiry");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    go();
    const held = await running;
    const next = await cookieRead();
    assert.equal(next.status, 401, `a read after the expiry is unauthenticated (${code(next)})`);
    assert.equal(code(held), code(next), "the held read is refused like a read after the expiry");
    noAccountDigits(held, "session expired during the read");
    noAccountDigits(next, "next read");
  } finally {
    bw = main;
    await sessionsWorld.stop();
  }
});

test(`ADV-PV1R-6 DENY ACH-M-I3-REVOCATION (session): a browser session revoked while the instructions read is held at its artifact read is refused with no account digits, exactly as a read after the revocation`, async () => {
  // a sessions-enabled bank world (KIT opt-in, coordinator ruling RR-4); the file's helpers run on it while this test swaps `bw`
  const main = bw;
  const sessionsWorld = await bankWorld({ sessions: true });
  bw = sessionsWorld;
  try {
    const x = await issuedOrder("adv6-session");
    const idf = bw.iw.w.identity();
    const session = await idf.signIn(x.b.a.billing);
    const cookieRead = (): Promise<Reply> => call(bw.iw.w, { method: "GET", url: bankRoutes.instructions(x.orderId), token: null, agency: x.b.a.s.agency.agencyId, key: null, contentType: null, headers: { cookie: session.cookie, origin: idf.origin } });
    const live = await cookieRead();
    assert.equal(live.status, 200, `served under a live session (${code(live)})`);
    let reached!: () => void;
    let go!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (go = resolve));
    const running = withStoreHook(await detailsRefOf(x.r.routeId), async () => {
      reached();
      await released;
    }, cookieRead);
    await atRead;
    const revoked = await call(bw.iw.w, { url: sessionPaths.revoke, token: null, agency: null, key: null, headers: { cookie: session.cookie, origin: idf.origin, "x-kauro-csrf": session.view.csrfToken } });
    assert.equal(revoked.status, 204, `the session is revoked through the product (${code(revoked)})`);
    go();
    const held = await running;
    const next = await cookieRead();
    assert.equal(next.status, 401, `a read after the revocation is unauthenticated (${code(next)})`);
    assert.equal(code(held), code(next), "the held read is refused like a read after the revocation");
    noAccountDigits(held, "session revoked during the read");
    noAccountDigits(next, "next read");
  } finally {
    bw = main;
    await sessionsWorld.stop();
  }
});

// === Codex r1 on db5f0e3 (docs/review/pv1-route-codex-r1.json): PV1R-01, PV1R-02, PV1R-03 ========================================

/** One sessions-enabled bank world for the r1 browser cells (KIT opt-in, RR-4), built on first use; the file's helpers run on it while `bw` is swapped. */
let sessionsBw: BankWorld | null = null;
after(async () => {
  await sessionsBw?.stop();
});
async function onSessions<T>(fn: () => Promise<T>): Promise<T> {
  const main = bw;
  sessionsBw ??= await bankWorld({ sessions: true });
  bw = sessionsBw;
  try {
    return await fn();
  } finally {
    bw = main;
  }
}
interface BrowserCall {
  readonly method?: "GET" | "POST";
  readonly url: string;
  readonly body?: unknown;
  readonly key?: string;
  readonly agency?: string | null;
  readonly origin?: string | null;
  readonly csrf?: string | null;
  readonly secFetchSite?: string;
  readonly bearer?: string;
}
/** A browser request under session `s`: the cookie, the app Origin and (POST) the session's CSRF token unless withheld; optionally a bearer beside it. */
function browserCall(s: BrowserSession, c: BrowserCall): Promise<Reply> {
  const method = c.method ?? "POST";
  const headers: Record<string, string> = { cookie: s.cookie };
  const origin = c.origin === undefined ? bw.iw.w.identity().origin : c.origin;
  if (origin !== null) headers["origin"] = origin;
  const csrf = c.csrf === undefined ? s.view.csrfToken : c.csrf;
  if (method === "POST" && csrf !== null) headers["x-kauro-csrf"] = csrf;
  if (c.secFetchSite !== undefined) headers["sec-fetch-site"] = c.secFetchSite;
  if (c.bearer !== undefined) headers["authorization"] = `Bearer ${c.bearer}`;
  return call(bw.iw.w, { method, url: c.url, token: null, agency: c.agency ?? null, key: method === "POST" ? (c.key ?? freshKey("browser")) : null, contentType: method === "POST" ? "application/json" : null, ...(c.body === undefined ? {} : { body: c.body }), headers });
}
/** A route's complete command footprint: row (state, rollout, current version), versions, participants, events, outbox records. */
async function routeFootprint(routeId: string): Promise<Record<string, unknown>> {
  return {
    ...(await routeRow(routeId)),
    participants: await n("SELECT 1 FROM kauro.bank_route_participants WHERE route_id = $1", [routeId]),
    outbox: await n("SELECT 1 FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE e.aggregate_id::text = $1", [routeId]),
  };
}
const accountOf = async (routeId: string): Promise<string> => (await q<{ account_ref: string }>("SELECT account_ref FROM kauro.bank_routes WHERE route_id = $1", [routeId]))[0]!.account_ref;
async function replaceBody(r: RouteView): Promise<{ expectedVersion: number; detailsArtifactRef: string; detailsEvidenceHash: string; authorizationRef: string }> {
  const d = await detailsArtifact(await accountOf(r.routeId), { accountNumber: "222222222222" });
  return { expectedVersion: r.routeVersion, detailsArtifactRef: d.artifactRef, detailsEvidenceHash: d.evidenceHash, authorizationRef: await proof() };
}
type Footprint = Record<string, unknown>;

/** The five owner POST commands, each prepared with valid state, evidence and a fresh step-up; `after` checks the state a success commits. */
interface OwnerCommand {
  readonly name: string;
  readonly prepare: () => Promise<{ readonly url: string; readonly body: unknown; readonly status: 200 | 201; readonly footprint: () => Promise<Footprint>; readonly after: (fp: Footprint) => void }>;
}
const OWNER_COMMANDS: ReadonlyArray<OwnerCommand> = [
  {
    name: "CMD201 configure",
    prepare: async () => {
      const accountRef = nextAccount("pv1r01-cfg");
      const footprint = async (): Promise<Footprint> => ({ routes: await routesOf(accountRef), versions: await n("SELECT 1 FROM kauro.bank_route_versions v JOIN kauro.bank_routes r ON r.route_id = v.route_id WHERE r.account_ref = $1", [accountRef]) });
      return { url: bankRoutes.configure(), body: await configureBody({ accountRef }), status: 201, footprint, after: (fp) => assert.deepEqual(fp, { routes: 1, versions: 1 }) };
    },
  },
  {
    name: "CMD202 verify",
    prepare: async () => {
      const r = await configured("pv1r01-verify");
      return { url: bankRoutes.verify(r.routeId), body: await verifyBody(r), status: 200, footprint: () => routeFootprint(r.routeId), after: (fp) => assert.equal(fp["state"], "VERIFIED") };
    },
  },
  {
    name: "CMD203 enable",
    prepare: async () => {
      const r = await verified("pv1r01-enable");
      return { url: bankRoutes.enable(r.routeId), body: await enableBody(r, [bw.iw.w.A.agencyId]), status: 200, footprint: () => routeFootprint(r.routeId), after: (fp) => assert.deepEqual([fp["state"], fp["participants"]], ["ENABLED", 1]) };
    },
  },
  {
    name: "CMD204 disable",
    prepare: async () => {
      const r = await enabled("pv1r01-disable", [bw.iw.w.A.agencyId]);
      return { url: bankRoutes.disable(r.routeId), body: await disableBody(r), status: 200, footprint: () => routeFootprint(r.routeId), after: (fp) => assert.equal(fp["state"], "VERIFIED") };
    },
  },
  {
    name: "CMD205 replace-details",
    prepare: async () => {
      const r = await configured("pv1r01-details");
      return { url: bankRoutes.details(r.routeId), body: await replaceBody(r), status: 200, footprint: () => routeFootprint(r.routeId), after: (fp) => assert.deepEqual([fp["state"], fp["current_version"], fp["versions"]], ["PENDING_VERIFICATION", 2, 2]) };
    },
  },
];

for (const command of OWNER_COMMANDS) {
  test(`PV1R-01 DENY ACH-M-R2-REVOCATION (unsafe cookie request, ${command.name}): without the exact app Origin, with a cross-site or same-site fetch, without or with another session's CSRF token the owner command is refused ORIGIN_REJECTED / CSRF_TOKEN_INVALID, a cookie beside a bearer token AMBIGUOUS_CREDENTIALS, each before any effect or journal reservation; the same key then commits once`, async () => {
    await onSessions(async () => {
      const idf = bw.iw.w.identity();
      const s = await idf.signIn(bw.iw.owner);
      const other = await idf.signIn(bw.iw.owner);
      const c = await command.prepare();
      const key = freshKey("pv1r01");
      const before = await c.footprint();
      const refusals: ReadonlyArray<readonly [string, string, BrowserCall]> = [
        ["no Origin", "403 NOT_AUTHORIZED ORIGIN_REJECTED", { url: c.url, body: c.body, key, origin: null }],
        ["another origin", "403 NOT_AUTHORIZED ORIGIN_REJECTED", { url: c.url, body: c.body, key, origin: "https://evil.example" }],
        ["a cross-site fetch", "403 NOT_AUTHORIZED ORIGIN_REJECTED", { url: c.url, body: c.body, key, secFetchSite: "cross-site" }],
        ["a same-site fetch", "403 NOT_AUTHORIZED ORIGIN_REJECTED", { url: c.url, body: c.body, key, secFetchSite: "same-site" }],
        ["no CSRF token", "403 NOT_AUTHORIZED CSRF_TOKEN_INVALID", { url: c.url, body: c.body, key, csrf: null }],
        ["another session's CSRF token", "403 NOT_AUTHORIZED CSRF_TOKEN_INVALID", { url: c.url, body: c.body, key, csrf: other.view.csrfToken }],
        ["a cookie beside a bearer token", "400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS", { url: c.url, body: c.body, key, bearer: bw.iw.owner.token }],
      ];
      for (const [what, expected, request] of refusals) {
        const reply = await browserCall(s, request);
        assert.equal(code(reply), expected, `${command.name}: ${what}`);
        assert.equal(await bw.iw.w.journal(key), null, `${command.name}: ${what} reserves no idempotency key`);
        assert.deepEqual(await c.footprint(), before, `${command.name}: ${what} leaves the route, version, participant, event and outbox footprint unchanged`);
      }
      // positive control: the exact app origin, a same-origin fetch and the session's own token; the same key commits once
      const accepted = await browserCall(s, { url: c.url, body: c.body, key, secFetchSite: "same-origin" });
      assert.equal(code(accepted), `${c.status} SUCCESS -`, `${command.name}: the valid browser request is served`);
      assert.equal((await bw.iw.w.journal(key))?.state, "COMMITTED");
      c.after(await c.footprint());
    });
  });
}

test(`PV1R-01 DENY ACH-M-I3-REVOCATION (ambiguous credentials on the reads): a session cookie beside a bearer token is AMBIGUOUS_CREDENTIALS on getBankRoute and on the transfer instructions (no account digits, no reference), never an anonymous 401; the cookie alone is served`, async () => {
  await onSessions(async () => {
    const idf = bw.iw.w.identity();
    const x = await issuedOrder("pv1r01-reads");
    const ownerSession = await idf.signIn(bw.iw.owner);
    const ambiguousGet = await browserCall(ownerSession, { method: "GET", url: bankRoutes.get(x.r.routeId), bearer: bw.iw.owner.token });
    assert.equal(code(ambiguousGet), "400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS", "getBankRoute: cookie beside bearer");
    assert.equal(code(await browserCall(ownerSession, { method: "GET", url: bankRoutes.get(x.r.routeId), origin: null })), "200 SUCCESS -", "getBankRoute: the cookie alone (a safe request needs no Origin)");
    const member = await idf.signIn(x.b.a.billing);
    const ambiguousRead = await browserCall(member, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId, bearer: x.b.a.billing.token });
    assert.equal(code(ambiguousRead), "400 INVALID_REQUEST AMBIGUOUS_CREDENTIALS", "transfer instructions: cookie beside bearer");
    noAccountDigits(ambiguousRead, "ambiguous credentials");
    assert.ok(!ambiguousRead.text.includes(x.reference), "ambiguous credentials: no payment reference");
    const served = await browserCall(member, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
    assert.equal(code(served), "200 SUCCESS -", "transfer instructions: the cookie alone");
    assert.equal(served.json<InstructionsView>().instructions.accountNumber, ACCOUNT_DIGITS);
  });
});

cell(`PV1R-02 DENY ACH-M-I3-REVOCATION (session ended during the route-lock wait): an instructions read held at the route share lock after its re-authentication, whose session is then revoked through the product or crosses its idle expiry, is refused like the next request with no account or routing digits and no payment reference once the holder releases without changing eligibility; a live session is served`, "race", async (ctx) => {
  await onSessions(async () => {
    for (const ending of ["live", "revoked", "expired"] as const) {
      const x = await issuedOrder(`pv1r02-${ending}`);
      const idf = bw.iw.w.identity();
      const session = await idf.signIn(x.b.a.billing);
      const cookieRead = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
      assert.equal(code(await cookieRead()), "200 SUCCESS -", `${ending}: served under the live session before the hold`);
      const holder = await openHolder();
      const wc = await open();
      let held: Reply;
      try {
        await holder.query("BEGIN");
        // the route row held FOR NO KEY UPDATE conflicts only with the read's FOR SHARE route guard (repo.lockShare), which the read takes after
        // its artifact read, its membership decision and its re-authentication (stillAuthenticated): the wait the database shows on this
        // holder is the post-re-authentication wait
        await holder.query("SELECT 1 FROM kauro.bank_routes WHERE route_id = $1 FOR NO KEY UPDATE", [x.r.routeId]);
        const waiting = await ctx.mustWait(bw.iw.h.oracle, { waiter: wc, holder: connectionPid(holder) }, () => on(ctx, wc, cookieRead), `${ending}: the instructions read waits at the route share lock`);
        if (ending === "revoked") {
          const revoked = await call(bw.iw.w, { url: sessionPaths.revoke, token: null, agency: null, key: null, headers: { cookie: session.cookie, origin: idf.origin, "x-kauro-csrf": session.view.csrfToken } });
          assert.equal(revoked.status, 204, `the session is revoked through the product during the wait (${code(revoked)})`);
        }
        if (ending === "expired") {
          const aged = await bw.iw.h.oracle.query("UPDATE kauro.web_sessions SET idle_expires_at = last_seen_at + interval '1 millisecond' WHERE secret_sha256 = $1", [session.secretSha256]);
          assert.equal(aged.rowCount, 1, "the session row aged through its idle expiry during the wait");
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        // released without changing the route or the order: only the session changed
        await holder.query("ROLLBACK");
        held = ok(await waiting.pending);
      } finally {
        await holder.end();
        await wc.end();
      }
      const next = await cookieRead();
      if (ending === "live") {
        assert.equal(code(held), "200 SUCCESS -", "live session: the held read is served after the wait");
        const v = held.json<InstructionsView>().instructions;
        assert.deepEqual([v.accountNumber, v.routingNumber, v.reference], [ACCOUNT_DIGITS, "026073150", x.reference]);
        assert.equal(code(next), "200 SUCCESS -");
        continue;
      }
      assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", `${ending}: the next request is unauthenticated`);
      assert.equal(code(held), code(next), `${ending}: the held read is refused like the next request`);
      noAccountDigits(held, `${ending} during the route-lock wait`);
      assert.ok(!held.text.includes(x.reference), `${ending}: no payment reference in the held read`);
      assert.equal((await q<{ state: string }>("SELECT state FROM kauro.bank_routes WHERE route_id = $1", [x.r.routeId]))[0]!.state, "ENABLED", `${ending}: eligibility unchanged (route still ENABLED)`);
    }
  });
});

// --- PV1R-03: step-up and details expiry crossed after the command's last freshness decision ---------------------------------------

/** The step-up proof's expiry (assurance_proofs.expires_at) of a body's authorizationRef. */
const proofExpiry = async (body: { readonly authorizationRef: string }): Promise<number> => (await q<{ at: Date }>("SELECT expires_at AS at FROM kauro.assurance_proofs WHERE proof_id::text = $1", [body.authorizationRef]))[0]!.at.getTime();
/**
 * Runs `command` on the cell's step clock at `startMs`, holds it at `uow.before-commit` (its handler returned, immediately before COMMIT),
 * moves the clock to `crossMs`, releases it and returns its answer.
 */
async function heldBeforeCommit(ctx: FaultContext, what: string, startMs: number, crossMs: number, command: () => Promise<Reply>): Promise<Reply> {
  const conn = await open();
  try {
    ctx.clock.set(startMs);
    const pause = ctx.points.pause("uow.before-commit");
    const running = ctx.operation(what, async (op) => {
      bw.iw.faults.clock = op.clock;
      try {
        return await on(ctx, conn, command);
      } finally {
        bw.iw.faults.clock = null;
      }
    });
    const settled = running.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
    await pause.reachedBy(running);
    ctx.clock.set(crossMs);
    pause.release();
    return ok(await settled);
  } finally {
    await conn.end();
  }
}
/** Runs enable on the step clock at `startMs`; its details evidence read is held while the clock moves to `crossMs` (2 ms, inside the read bound). */
async function enableHeldAtEvidenceRead(ctx: FaultContext, r: RouteView, body: unknown, startMs: number, crossMs: number): Promise<Reply> {
  const ref = await detailsRefOf(r.routeId);
  return ctx.operation("enable whose evidence read is held across the instant", async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      ctx.clock.set(startMs);
      return await withStoreHook(ref, async () => void ctx.clock.set(crossMs), () => owner(bankRoutes.enable(r.routeId), body));
    } finally {
      bw.iw.faults.clock = null;
    }
  });
}
const detailsSoon = (): string => new Date(Date.now() + 5 * 60_000).toISOString();
async function validUntilOf(routeId: string): Promise<number> {
  const ref = await detailsRefOf(routeId);
  return Date.parse((JSON.parse(new TextDecoder().decode((await bw.evidence.get(ref))!.bytes)) as { details: { validUntil: string } }).details.validUntil);
}

cell(`PV1R-03 DENY ACH-M-R2-EXPIRY (step-up expires during the enable evidence read): an enable whose clock and assurance check precede its details read, held at that read while the step-up crosses its expiry and released inside the read bound, is refused STEP_UP_STALE with no enabling footprint; the same hold short of the expiry enables`, "expiry", async (ctx) => {
  // positive control first (the clock never moves backwards: the case's proof is issued after the control's)
  const rc = await verified("pv1r03-read-proof-ok");
  const bc = await enableBody(rc, [bw.iw.w.A.agencyId]);
  const ec = await proofExpiry(bc);
  assert.equal(code(await enableHeldAtEvidenceRead(ctx, rc, bc, ec - 3, ec - 1)), "200 SUCCESS -", "control: the proof is still fresh after the held read");
  const r = await verified("pv1r03-read-proof");
  const body = await enableBody(r, [bw.iw.w.A.agencyId]);
  const before = await routeFootprint(r.routeId);
  const boundary = Date.parse(ctx.deadline(await proofExpiry(body), "step-up proof expiry"));
  const reply = await enableHeldAtEvidenceRead(ctx, r, body, boundary - 1, boundary + 1);
  assert.equal(code(reply), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "a proof stale once the evidence read returns refuses the enable");
  assert.deepEqual(await routeFootprint(r.routeId), before, "no enabling footprint (state VERIFIED, no participants, no enabled event or outbox)");
});

cell(`PV1R-03 DENY ACH-M-R1-EXPIRY (details expire during the enable evidence read): an enable held at its details read while the details validity passes, released inside the read bound, is refused DETAILS_EXPIRED (not judged at the pre-read instant) with no enabling footprint; the same hold short of the validity enables`, "expiry", async (ctx) => {
  const rc = await verified("pv1r03-read-details-ok", { validUntil: detailsSoon() });
  const vc = await validUntilOf(rc.routeId);
  assert.equal(code(await enableHeldAtEvidenceRead(ctx, rc, await enableBody(rc, [bw.iw.w.A.agencyId]), vc - 3, vc - 1)), "200 SUCCESS -", "control: the details are still valid after the held read");
  const r = await verified("pv1r03-read-details", { validUntil: detailsSoon() });
  const body = await enableBody(r, [bw.iw.w.A.agencyId]);
  const validUntil = await validUntilOf(r.routeId);
  assert.ok(validUntil < (await proofExpiry(body)), "details-only case: the step-up outlives the details");
  const before = await routeFootprint(r.routeId);
  const boundary = Date.parse(ctx.deadline(validUntil, "details validity"));
  const reply = await enableHeldAtEvidenceRead(ctx, r, body, boundary - 1, boundary + 1);
  assert.equal(code(reply), "409 PRECONDITION_FAILED DETAILS_EXPIRED", "details expired at the effect refuse the enable");
  assert.deepEqual(await routeFootprint(r.routeId), before, "no enabling footprint");
});

/** The four step-up commands at their COMMIT boundary: a prepared route and body. */
interface AtCommit {
  readonly name: string;
  readonly prepare: (label: string, cfg?: Partial<Cfg>) => Promise<{ readonly r: RouteView; readonly body: { readonly authorizationRef: string }; readonly url: string }>;
}
const AT_COMMIT: ReadonlyArray<AtCommit> = [
  {
    name: "verify",
    prepare: async (label, cfg = {}) => {
      const r = await configured(label, cfg);
      return { r, body: await verifyBody(r), url: bankRoutes.verify(r.routeId) };
    },
  },
  {
    name: "enable",
    prepare: async (label, cfg = {}) => {
      const r = await verified(label, cfg);
      return { r, body: await enableBody(r, [bw.iw.w.A.agencyId]), url: bankRoutes.enable(r.routeId) };
    },
  },
  {
    name: "disable",
    prepare: async (label, cfg = {}) => {
      const r = await enabled(label, [bw.iw.w.A.agencyId], cfg);
      return { r, body: await disableBody(r), url: bankRoutes.disable(r.routeId) };
    },
  },
  {
    name: "replace-details",
    prepare: async (label, cfg = {}) => {
      const r = await configured(label, cfg);
      return { r, body: await replaceBody(r), url: bankRoutes.details(r.routeId) };
    },
  },
];

for (const c of AT_COMMIT) {
  cell(`PV1R-03 DENY ACH-M-R2-EXPIRY (step-up expires before COMMIT, ${c.name}): the ${c.name} command held immediately before its COMMIT while its step-up crosses its expiry is refused STEP_UP_STALE, leaving route, version, participant, event and outbox state unchanged and no COMMITTED journal; the same hold short of the expiry commits`, "expiry", async (ctx) => {
    const control = await c.prepare(`pv1r03-commit-${c.name}-ok`);
    const ce = await proofExpiry(control.body);
    assert.equal(code(await heldBeforeCommit(ctx, `${c.name} held before COMMIT short of the expiry`, ce - 3, ce - 1, () => owner(control.url, control.body))), "200 SUCCESS -", `control: ${c.name} commits with a proof fresh at COMMIT`);
    const x = await c.prepare(`pv1r03-commit-${c.name}`);
    const key = freshKey(`pv1r03-${c.name}`);
    const before = await routeFootprint(x.r.routeId);
    const boundary = Date.parse(ctx.deadline(await proofExpiry(x.body), "step-up proof expiry"));
    const reply = await heldBeforeCommit(ctx, `${c.name} held before COMMIT across the expiry`, boundary - 1, boundary + 1, () => owner(x.url, x.body, { key }));
    assert.equal(code(reply), "403 ASSURANCE_REQUIRED STEP_UP_STALE", `${c.name}: a proof expired at COMMIT refuses the effect`);
    assert.deepEqual(await routeFootprint(x.r.routeId), before, `${c.name}: route, version, participant, event and outbox state unchanged`);
    assert.equal(await bw.iw.w.journal(key), null, `${c.name}: no journal entry, COMMITTED or otherwise`);
  });
}

for (const c of AT_COMMIT.filter((x) => x.name === "verify" || x.name === "enable")) {
  cell(`PV1R-03 DENY ACH-M-R1-EXPIRY (details expire before COMMIT, ${c.name}): the ${c.name} command held immediately before its COMMIT while the details validity passes (the step-up still fresh) is refused DETAILS_EXPIRED with no footprint and no COMMITTED journal; the same hold short of the validity commits`, "expiry", async (ctx) => {
    const control = await c.prepare(`pv1r03-dcommit-${c.name}-ok`, { validUntil: detailsSoon() });
    const cv = await validUntilOf(control.r.routeId);
    assert.equal(code(await heldBeforeCommit(ctx, `${c.name} held before COMMIT short of the validity`, cv - 3, cv - 1, () => owner(control.url, control.body))), "200 SUCCESS -", `control: ${c.name} commits with details valid at COMMIT`);
    const x = await c.prepare(`pv1r03-dcommit-${c.name}`, { validUntil: detailsSoon() });
    const validUntil = await validUntilOf(x.r.routeId);
    assert.ok(validUntil < (await proofExpiry(x.body)), "details-only case: the step-up outlives the details");
    const key = freshKey(`pv1r03-d-${c.name}`);
    const before = await routeFootprint(x.r.routeId);
    const boundary = Date.parse(ctx.deadline(validUntil, "details validity"));
    const reply = await heldBeforeCommit(ctx, `${c.name} held before COMMIT across the details validity`, boundary - 1, boundary + 1, () => owner(x.url, x.body, { key }));
    assert.equal(code(reply), "409 PRECONDITION_FAILED DETAILS_EXPIRED", `${c.name}: details expired at COMMIT refuse the effect`);
    assert.deepEqual(await routeFootprint(x.r.routeId), before, `${c.name}: no footprint`);
    assert.equal(await bw.iw.w.journal(key), null, `${c.name}: no journal entry`);
  });
}

// === Codex r2 on 5bac4cf (docs/review/pv1-route-codex-r2.json): PV1R-02, PV1R-03, PV1R-06, one family: TIME-AFTER-AWAIT ===========
// Each cell delays the LAST awaited step before a time judgment (the final authentication's session-store statement, the final step-up
// proof read, the issuance's COMMIT) across the boundary that judgment guards (FAILURE-MATRIX-TEMPLATE rule 15).

/**
 * Holds the answer of the `nth` session-resume touch statement (`UPDATE kauro.web_sessions SET last_seen_at ...`) the authentication
 * boundary's pool runs during `fn`: the statement has run on the server (after the resume's clock sample) and `hook` runs before its answer
 * reaches the store. The pool is restored after `fn`; `reached` says the hold happened (a vacuous cell fails on it).
 */
async function withResumeHeld<T>(nth: number, hook: () => Promise<void>, fn: () => Promise<T>): Promise<{ readonly out: T; readonly reached: boolean }> {
  type Client = { query: (...a: unknown[]) => Promise<unknown> };
  const pool = bw.iw.w.db.assurancePool as unknown as { acquire: () => Promise<{ readonly client: Client }> } | null;
  assert.ok(pool !== null, "a sessions-enabled world binds the authentication boundary's pool");
  const real = pool.acquire;
  let seen = 0;
  let reached = false;
  pool.acquire = async () => {
    const acquired = await real.call(pool);
    const client = new Proxy(acquired.client, {
      get(target, prop) {
        if (prop === "query") {
          return async (...a: unknown[]) => {
            const text = typeof a[0] === "string" ? a[0] : ((a[0] as { text?: string } | undefined)?.text ?? "");
            const answer = await target.query(...a);
            if (/UPDATE kauro\.web_sessions\s+SET last_seen_at/.test(text) && ++seen === nth) {
              reached = true;
              await hook();
            }
            return answer;
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { ...acquired, client };
  };
  try {
    return { out: await fn(), reached };
  } finally {
    pool.acquire = real;
  }
}

/**
 * A sessions-enabled bank world of its own per cell whose process clock the cell moves forward (kept apart from the shared one and from each
 * other: the owner's step-ups are judged on that clock, so a world whose clock moved hours ahead configures no further route).
 */
const movedWorlds = new Map<string, BankWorld>();
const movedNames = new Set<string>();
after(async () => {
  for (const w of movedWorlds.values()) await w.stop();
});
/** Builds the moved world `name` (a temporary cluster with every migration, and an api): once per name, never shared by two tests. */
async function movedWorld(name: string): Promise<BankWorld> {
  if (movedNames.has(name)) throw new Error(`the moved world ${name} is one test's own: another test already used it`);
  movedNames.add(name);
  const moved = await bankWorld({ sessions: true });
  movedWorlds.set(name, moved);
  return moved;
}
/** Stops the moved world `name` once its test settled: no cluster of a finished test stays alive for the rest of the file. */
async function stopMoved(name: string): Promise<void> {
  const moved = movedWorlds.get(name);
  movedWorlds.delete(name);
  await moved?.stop();
}
async function onWorld<T>(moved: BankWorld, fn: () => Promise<T>): Promise<T> {
  const main = bw;
  bw = moved;
  try {
    return await fn();
  } finally {
    bw = main;
  }
}
/** A plain test (no cell body bound) on a moved world of its own, built at its start and stopped once it settled. */
async function onMovedSessions<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await onWorld(await movedWorld(name), fn);
  } finally {
    await stopMoved(name);
  }
}
/**
 * A fault cell on a moved world of its own (cell's id unless `id` names the matrix row, as advCell). The world is built BEFORE runCell
 * starts the cell's body bound (CELL_TIMEOUT_MS bounds the cell's own steps, never the construction of a whole temporary cluster with every
 * migration and an api: 38-46 s of the 90 s under CPU load, so a cell otherwise ~10 s timed out under host load; ADV-1 r6
 * adv1r6-ended on 6b94ab6d) and stopped once the cell settled.
 */
function movedCell(world: string, title: string, fault: FaultKind, body: (ctx: FaultContext) => Promise<void>, id: string = title.split(" ")[1]!): void {
  test(title, async () => {
    const moved = await movedWorld(world);
    try {
      await runCell({ id, step: title.slice(title.indexOf(": ") + 2), fault, expect: title }, (ctx) => onWorld(moved, () => body(ctx)));
    } finally {
      await stopMoved(world);
    }
  });
}

test(`PV1R-02 DENY ACH-M-R2-EXPIRY (session expires during the cookie authentication's own store wait): a getBankRoute whose only authentication's session-store statement is held after its clock sample while the session crosses its idle expiry is refused 401 AUTHENTICATION_REQUIRED like the next request (the resume judges liveness at an instant read after the store returned); a session still live at release is served`, async () => {
  await onMovedSessions("pv1r02-get", async () => {
    const r = await configured("pv1r02r2-get");
    for (const ending of ["live", "idle"] as const) {
      const session = await bw.iw.w.identity().signIn(bw.iw.owner);
      const get = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.get(r.routeId), origin: null });
      const advanceMs = ending === "live" ? 1_000 : 1_800_000 + 60_000;
      const { out: held, reached } = await withResumeHeld(1, async () => bw.iw.w.processClock.advance(advanceMs), get);
      assert.ok(reached, `${ending}: the authentication's session-store statement was held`);
      const next = await get();
      const expected = ending === "live" ? "200 SUCCESS -" : "401 AUTHENTICATION_REQUIRED -";
      assert.equal(code(next), expected, `${ending}: the next request`);
      assert.equal(code(held), expected, `${ending}: the held request is answered like the next one`);
    }
  });
});

test(`PV1R-02 DENY ACH-M-I3-EXPIRY (session expires during the final authentication's own store wait): an instructions read whose initial authentication and first re-authentication finish, and whose FINAL authentication's session-store statement is held after its clock sample while the session crosses its idle or its absolute expiry, is refused 401 AUTHENTICATION_REQUIRED like the next request with no account or routing digits and no payment reference; a session still live at release is served`, async () => {
  await onMovedSessions("pv1r02-i3", async () => {
    const IDLE_MS = 1_800_000;
    const endings = ["live", "idle", "absolute"] as const;
    // every order is issued before the process clock moves (the owner's step-ups are judged on it); each session opens at its own case
    const orders = new Map<string, Awaited<ReturnType<typeof issuedOrder>>>();
    for (const ending of endings) orders.set(ending, await issuedOrder(`pv1r02r2-${ending}`));
    for (const ending of endings) {
      const x = orders.get(ending)!;
      const session = await bw.iw.w.identity().signIn(x.b.a.billing);
      const cookieRead = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
      if (ending === "absolute") {
        // the session kept in use (a read every 25 minutes touches it) until its absolute deadline (12 h, immutable) is 10 minutes ahead: its
        // idle deadline is then bound to the absolute one (min(now + 30 min, absolute))
        const absolute = (await q<{ at: Date }>("SELECT absolute_expires_at AS at FROM kauro.web_sessions WHERE secret_sha256 = $1", [session.secretSha256]))[0]!.at.getTime();
        while (absolute - bw.iw.w.processClock.nowMs() > 10 * 60_000 + 1_000) {
          bw.iw.w.processClock.advance(Math.min(25 * 60_000, absolute - bw.iw.w.processClock.nowMs() - 10 * 60_000));
          assert.equal(code(await cookieRead()), "200 SUCCESS -", "absolute: the session in use stays live");
        }
        const [row] = await q<{ idle: Date; abs: Date }>("SELECT idle_expires_at AS idle, absolute_expires_at AS abs FROM kauro.web_sessions WHERE secret_sha256 = $1", [session.secretSha256]);
        assert.equal(row!.idle.getTime(), row!.abs.getTime(), "absolute: the idle deadline is bound to the absolute deadline");
        assert.ok(row!.abs.getTime() - bw.iw.w.processClock.nowMs() <= 10 * 60_000 + 1_000, "absolute: the absolute deadline is about 10 minutes ahead");
      }
      assert.equal(code(await cookieRead()), "200 SUCCESS -", `${ending}: served under the live session before the hold`);
      const advanceMs = ending === "live" ? 1_000 : ending === "idle" ? IDLE_MS + 60_000 : 11 * 60_000;
      // r4 repair (PV1R-07): the final session judgment is the fence statement of the read's own unit (FOR SHARE); the read is held before it
      const held = await readHeldAtSessionFence(`${ending}: the read held before its session fence`, cookieRead, async () => void bw.iw.w.processClock.advance(advanceMs));
      const next = await cookieRead();
      if (ending === "live") {
        assert.equal(code(held), "200 SUCCESS -", "live: a session still live at release is served");
        const v = held.json<InstructionsView>().instructions;
        assert.deepEqual([v.accountNumber, v.routingNumber, v.reference], [ACCOUNT_DIGITS, "026073150", x.reference]);
        assert.equal(code(next), "200 SUCCESS -");
        continue;
      }
      assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", `${ending}: the next request is unauthenticated`);
      assert.equal(code(held), code(next), `${ending}: the held read is refused like the next request`);
      noAccountDigits(held, `${ending} expiry during the final authentication`);
      assert.ok(!held.text.includes(x.reference), `${ending}: no payment reference in the held read`);
    }
  });
});

/** I3 under a fresh browser session on the cell's step clock from `startMs`; the final authentication's store statement held while the clock moves to `crossMs`. */
async function readHeldAtFinalAuthentication(ctx: FaultContext, what: string, x: { readonly b: { readonly a: Agent }; readonly orderId: string }, startMs: number, crossMs: number): Promise<Reply> {
  const session = await bw.iw.w.identity().signIn(x.b.a.billing);
  const out = await ctx.operation(what, async (op) => {
    bw.iw.faults.clock = op.clock;
    try {
      ctx.clock.set(startMs);
      // r4 repair (PV1R-07): held before the read's own session fence (the final session judgment), the clock moved, released
      return await readHeldAtSessionFence(what, () => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId }), async () => void ctx.clock.set(crossMs));
    } finally {
      bw.iw.faults.clock = null;
    }
  });
  return out;
}
const transferExpiryOf = async (orderId: string): Promise<number> => (await q<{ at: Date }>("SELECT transfer_expires_at AS at FROM kauro.bank_transfer_instructions WHERE order_id::text = $1", [orderId]))[0]!.at.getTime();

cell(`PV1R-06 DENY ACH-M-I3-EXPIRY (instruction deadline crossed during the final authentication): an instructions read under a long-lived session whose route and order guards pass at deadline - 1 ms and whose final authentication is held while the effect clock crosses the instruction deadline is refused 409 INSTRUCTIONS_EXPIRED with no account or routing digits and no reference; the same hold short of the deadline is served`, "expiry", async (ctx) => {
  await onSessions(async () => {
    const xc = await issuedOrder("pv1r06-deadline-ok");
    const ec = await transferExpiryOf(xc.orderId);
    const control = await readHeldAtFinalAuthentication(ctx, "read held short of the instruction deadline", xc, ec - 3, ec - 1);
    assert.equal(code(control), "200 SUCCESS -", "control: the instructions are served before the deadline");
    const x = await issuedOrder("pv1r06-deadline");
    const boundary = Date.parse(ctx.deadline(await transferExpiryOf(x.orderId), "instruction deadline"));
    const reply = await readHeldAtFinalAuthentication(ctx, "read held across the instruction deadline", x, boundary - 1, boundary + 1);
    assert.equal(code(reply), "409 PRECONDITION_FAILED INSTRUCTIONS_EXPIRED", "the deadline crossed during the final authentication hides the instructions");
    noAccountDigits(reply, "instruction deadline crossed during the final authentication");
    assert.ok(!reply.text.includes(x.reference), "no payment reference");
  });
});

cell(`PV1R-06 DENY ACH-M-I3-EXPIRY (details validity crossed during the final authentication): an instructions read under a long-lived session whose final authentication is held while the effect clock crosses the route version's details validUntil is refused 409 INSTRUCTIONS_NOT_AVAILABLE with no account or routing digits and no reference; the same hold short of the validity is served`, "expiry", async (ctx) => {
  await onSessions(async () => {
    const vc = Date.now() + 5 * DAY_MS;
    const xc = await issuedOrder("pv1r06-details-ok", { validUntil: iso(vc) });
    const control = await readHeldAtFinalAuthentication(ctx, "read held short of the details validity", xc, vc - 3, vc - 1);
    assert.equal(code(control), "200 SUCCESS -", "control: the instructions are served while the details are valid");
    const validUntil = Date.now() + 6 * DAY_MS;
    const x = await issuedOrder("pv1r06-details", { validUntil: iso(validUntil) });
    // issuance caps the instruction deadline at the details validity (D-ACH-04): at that boundary I3's details judgment is the one taken first
    assert.ok((await transferExpiryOf(x.orderId)) <= validUntil, "fixture: the instruction deadline is capped by the details validity");
    const boundary = Date.parse(ctx.deadline(validUntil, "details validity"));
    const reply = await readHeldAtFinalAuthentication(ctx, "read held across the details validity", x, boundary - 1, boundary + 1);
    assert.equal(code(reply), INSTRUCTIONS_NOT_AVAILABLE, "details expired during the final authentication hide the instructions");
    noAccountDigits(reply, "details validity crossed during the final authentication");
    assert.ok(!reply.text.includes(x.reference), "no payment reference");
  });
});

/**
 * Runs `command` on the cell's step clock at `startMs`, lets it reach `uow.before-commit` (its handler, journal and security writes done),
 * then holds the answer of its FINAL step-up proof read (the pre-commit check's own read) while the clock moves to `crossMs`, and releases it.
 */
async function heldAtFinalProofRead(ctx: FaultContext, what: string, startMs: number, crossMs: number, command: () => Promise<Reply>): Promise<Reply> {
  const conn = await open();
  let armed = false;
  try {
    ctx.clock.set(startMs);
    const atCommit = ctx.points.pause("uow.before-commit");
    const running = ctx.operation(what, async (op) => {
      bw.iw.faults.clock = op.clock;
      try {
        return await on(ctx, conn, command, [{ label: "final-proof", match: /FROM kauro\.assurance_proofs/, when: () => armed }]);
      } finally {
        bw.iw.faults.clock = null;
      }
    });
    const settled = running.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
    await atCommit.reachedBy(running);
    armed = true;
    const atProof = ctx.points.pause("db.final-proof.after");
    atCommit.release();
    await atProof.reachedBy(running);
    ctx.clock.set(crossMs);
    atProof.release();
    return ok(await settled);
  } finally {
    await conn.end();
  }
}

for (const c of AT_COMMIT) {
  cell(`PV1R-03 DENY ACH-M-R2-EXPIRY (step-up expires during the final proof read, ${c.name}): the ${c.name} command whose pre-commit check reads the step-up proof with the clock at expiry - 1 ms, the read's answer held while the proof crosses its expiry, is refused STEP_UP_STALE, leaving route, version, participant, event and outbox state unchanged and no journal entry; the same hold short of the expiry commits`, "expiry", async (ctx) => {
    const control = await c.prepare(`pv1r03r2-${c.name}-ok`);
    const ce = await proofExpiry(control.body);
    assert.equal(code(await heldAtFinalProofRead(ctx, `${c.name} final proof read held short of the expiry`, ce - 3, ce - 1, () => owner(control.url, control.body))), "200 SUCCESS -", `control: ${c.name} commits with a proof fresh after its final read`);
    const x = await c.prepare(`pv1r03r2-${c.name}`);
    const key = freshKey(`pv1r03r2-${c.name}`);
    const before = await routeFootprint(x.r.routeId);
    const boundary = Date.parse(ctx.deadline(await proofExpiry(x.body), "step-up proof expiry"));
    const reply = await heldAtFinalProofRead(ctx, `${c.name} final proof read held across the expiry`, boundary - 1, boundary + 1, () => owner(x.url, x.body, { key }));
    assert.equal(code(reply), "403 ASSURANCE_REQUIRED STEP_UP_STALE", `${c.name}: a proof expired during its final read refuses the effect`);
    assert.deepEqual(await routeFootprint(x.r.routeId), before, `${c.name}: route, version, participant, event and outbox state unchanged`);
    assert.equal(await bw.iw.w.journal(key), null, `${c.name}: no journal entry, COMMITTED or otherwise`);
  });
}

for (const c of AT_COMMIT.filter((x) => x.name === "verify" || x.name === "enable")) {
  cell(`PV1R-03 DENY ACH-M-R1-EXPIRY (details expire during the final proof read, ${c.name}): the ${c.name} command whose pre-commit proof read is held while the details validity passes (the step-up still fresh) is refused DETAILS_EXPIRED with no footprint and no journal entry; the same hold short of the validity commits`, "expiry", async (ctx) => {
    const control = await c.prepare(`pv1r03r2-d-${c.name}-ok`, { validUntil: detailsSoon() });
    const cv = await validUntilOf(control.r.routeId);
    assert.equal(code(await heldAtFinalProofRead(ctx, `${c.name} final proof read held short of the validity`, cv - 3, cv - 1, () => owner(control.url, control.body))), "200 SUCCESS -", `control: ${c.name} commits with details valid after its final read`);
    const x = await c.prepare(`pv1r03r2-d-${c.name}`, { validUntil: detailsSoon() });
    const validUntil = await validUntilOf(x.r.routeId);
    assert.ok(validUntil < (await proofExpiry(x.body)), "details-only case: the step-up outlives the details");
    const key = freshKey(`pv1r03r2-d-${c.name}`);
    const before = await routeFootprint(x.r.routeId);
    const boundary = Date.parse(ctx.deadline(validUntil, "details validity"));
    const reply = await heldAtFinalProofRead(ctx, `${c.name} final proof read held across the details validity`, boundary - 1, boundary + 1, () => owner(x.url, x.body, { key }));
    assert.equal(code(reply), "409 PRECONDITION_FAILED DETAILS_EXPIRED", `${c.name}: details expired during the final proof read refuse the effect`);
    assert.deepEqual(await routeFootprint(x.r.routeId), before, `${c.name}: no footprint`);
    assert.equal(await bw.iw.w.journal(key), null, `${c.name}: no journal entry`);
  });
}

cell(`TAA-SWEEP DENY ACH-M-I2-EXPIRY (transfer window crossed before COMMIT): an issuance judged at window + 1 ms before its details-capped deadline, held immediately before its COMMIT while the effect clock passes the minimum window, is refused TRANSFER_WINDOW_TOO_SHORT with nothing issued; the same hold short of the minimum window issues`, "expiry", async (ctx) => {
  const windowMs = 2 * DAY_MS;
  const vc = Date.now() + 5 * DAY_MS;
  const bc = await buyer("taa-window-ok");
  const rc = await enabled("taa-window-ok", [bc.a.s.agency.agencyId], { windowMs, validUntil: iso(vc) });
  const control = await heldBeforeCommit(ctx, "issuance held before COMMIT short of the minimum window", vc - windowMs - 3, vc - windowMs - 1, () => issue(bc, rc));
  assert.equal(code(control), "201 SUCCESS -", "control: the window still holds at COMMIT");
  const validUntil = Date.now() + 6 * DAY_MS;
  const b = await buyer("taa-window");
  const r = await enabled("taa-window", [b.a.s.agency.agencyId], { windowMs, validUntil: iso(validUntil) });
  const boundary = Date.parse(ctx.deadline(validUntil - windowMs, "latest issuance instant before the details-capped deadline"));
  const reply = await heldBeforeCommit(ctx, "issuance held before COMMIT across the minimum window", boundary - 1, boundary + 1, () => issue(b, r));
  assert.equal(code(reply), "409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT", "the window crossed before COMMIT refuses the issuance");
  assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, "nothing issued");
});

// === Internal adversary r3 on edccbba (docs/review/pv1-route-adversary-r4.md): ADV-1 (MAJOR), ADV-3 (MINOR) =========================
// ADV-1: the I3 session `liveUntil` judgment (instructions.ts, the last line before the view) is the ONLY guard of a session that ends
// BETWEEN the effect-clock read and the view: SessionService.resume already refuses a session dead at the third resume. Each cell holds the
// `effect_now` statement AFTER the third resume, moves the process clock past the session's deadline, releases it.

/** The refusal ctx.fenced observed: the held read's answer, carried out of the fenced operation. */
class HeldReadAnswered extends Error {
  constructor(readonly reply: Reply) {
    super(`the held read was answered ${reply.status}`);
  }
}
let heldSeq = 0;
/**
 * One I3 cookie read under `session` whose answer is held at its final effect-clock read: the first `kauro.effect_now()` statement on the
 * read's connection after its route lock (`FROM kauro.bank_routes WHERE route_id = $1 FOR SHARE`), the read's final authority judgment
 * already locked (r4 repair, design-neutral: it names the read's own statements, not the authentication boundary's): `during` runs while
 * it is held.
 */
async function readHeldAtEffectRead(ctx: FaultContext, what: string, read: () => Promise<Reply>, during: () => Promise<void>): Promise<Reply> {
  const conn = await open();
  try {
    const at = i3EffectRead();
    const atEffect = ctx.points.pause(at.point);
    const running = on(ctx, conn, read, at.steps);
    const settled = running.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
    await atEffect.reachedBy(running);
    await during();
    atEffect.release();
    const out = ok(await settled);
    assert.ok(at.taken(), `${what}: the read's final effect-clock read was held`);
    return out;
  } finally {
    await conn.end();
  }
}

/** The statement of the fence (migration 0047): the presented session locked FOR SHARE in the unit's own transaction. */
const SESSION_FENCE = /FROM kauro\.web_sessions WHERE secret_sha256 = \$1 AND user_id = \$2 FOR SHARE/;
/** One I3 cookie read held BEFORE its session fence statement on its own connection (the fence not yet sent); `during` runs while it is held. */
async function readHeldAtSessionFence(what: string, read: () => Promise<Reply>, during: () => Promise<void>): Promise<Reply> {
  const conn = await open();
  try {
    const at = nthStatement("i3-fence", SESSION_FENCE, 1, "before");
    const points = new FaultPoints();
    const atFence = points.pause(at.point);
    const running = bw.iw.faults.on(conn, "kauro_app", points, at.steps, read);
    const settled = running.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
    await atFence.reachedBy(running);
    await during();
    atFence.release();
    const out = ok(await settled);
    assert.ok(at.taken(), `${what}: the read's session fence statement was held`);
    return out;
  } finally {
    await conn.end();
  }
}

for (const ending of ["idle", "absolute"] as const) {
  movedCell(`adv1-${ending}`, `ADV-1 DENY ACH-M-I3-REVOCATION (session ${ending} deadline passes after the effect-clock read): an instructions read whose final authentication answered with the session live and whose effect-clock read is held while the process clock passes the session's ${ending} deadline is refused 401 AUTHENTICATION_REQUIRED with no account or routing digits and no payment reference; the same hold with the session still live is served`, "revocation", async (ctx) => {
    const IDLE_MS = 1_800_000;
    const x = await issuedOrder(`adv1-${ending}`);
    const session = await bw.iw.w.identity().signIn(x.b.a.billing);
    const cookieRead = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
    if (ending === "absolute") {
      // kept in use (a read every 25 minutes touches it) until the absolute deadline (12 h, immutable) is about 10 minutes ahead: the idle deadline is then bound to it
      const absolute = (await q<{ at: Date }>("SELECT absolute_expires_at AS at FROM kauro.web_sessions WHERE secret_sha256 = $1", [session.secretSha256]))[0]!.at.getTime();
      while (absolute - bw.iw.w.processClock.nowMs() > 10 * 60_000 + 1_000) {
        bw.iw.w.processClock.advance(Math.min(25 * 60_000, absolute - bw.iw.w.processClock.nowMs() - 10 * 60_000));
        assert.equal(code(await cookieRead()), "200 SUCCESS -", "absolute: the session in use stays live");
      }
      const [row] = await q<{ idle: Date; abs: Date }>("SELECT idle_expires_at AS idle, absolute_expires_at AS abs FROM kauro.web_sessions WHERE secret_sha256 = $1", [session.secretSha256]);
      assert.equal(row!.idle.getTime(), row!.abs.getTime(), "absolute: the idle deadline is bound to the absolute deadline");
    }
    // positive control: one second passes while the effect-clock read is held; the session (>= 9 minutes from its deadline) is still live and is served
    const control = await readHeldAtEffectRead(ctx, `${ending} control`, cookieRead, async () => void bw.iw.w.processClock.advance(1_000));
    assert.equal(code(control), "200 SUCCESS -", `${ending} control: a session still live at release is served`);
    const v = control.json<InstructionsView>().instructions;
    assert.deepEqual([v.accountNumber, v.routingNumber, v.reference], [ACCOUNT_DIGITS, "026073150", x.reference], `${ending} control: the account, the routing number and the reference`);
    const advanceMs = ending === "idle" ? IDLE_MS + 60_000 : 11 * 60_000;
    // the revocation is the process clock passing the deadline while the read is held at its effect-clock read; the next request is fenced by it
    const held = (await ctx.revoked(`session ${ending} deadline passes while a read is held at its effect-clock read`, () => readHeldAtEffectRead(ctx, ending, cookieRead, async () => void bw.iw.w.processClock.advance(advanceMs))))!;
    assert.equal(code(held), "401 AUTHENTICATION_REQUIRED -", `${ending}: a session that ended between the effect-clock read and the view gets the authentication refusal`);
    noAccountDigits(held, `${ending} deadline passed after the effect-clock read`);
    assert.ok(!held.text.includes(x.reference), `${ending}: no payment reference in the held read`);
    const next = await ctx.fenced(`next request after the ${ending} deadline`, async () => {
      throw new HeldReadAnswered(await cookieRead());
    }, (e) => e instanceof HeldReadAnswered);
    assert.equal(code((next as HeldReadAnswered).reply), "401 AUTHENTICATION_REQUIRED -", `${ending}: the next request is unauthenticated too`);
  }, "ACH-M-I3-REVOCATION");
}

// ADV-3: the I1/I2 read order (instructions.ts, the probe read, the facts and the source deadline, THEN the effect read): a deadline crossed
// after the probe read and before the effect read is judged at the effect instant. The design (ACH-ROUTE I1/I2 EXPIRY, I2Δ) names no code for
// a crossing between two reads; the codes are the ones each fact carries: the price expiry QUOTE_EXPIRED (checkout blocker, judged at the
// effect instant), the source deadline and the transfer window TRANSFER_WINDOW_TOO_SHORT (I2Δ).

/**
 * One issuance on the step clock: the clock stands at `startMs`, the answer of the issuance's FIRST effect-instant read (the probe) is held, the
 * clock moves to `crossMs`, the read is released and the issuance goes on (its effect read, then its COMMIT).
 */
async function issueHeldAtProbe(ctx: FaultContext, what: string, b: Buyer, r: RouteView, startMs: number, crossMs: number): Promise<Reply> {
  const conn = await open();
  try {
    const label = `probe-${++heldSeq}`;
    const atProbe = ctx.points.pause(`db.${label}.after`);
    const running = ctx.operation(what, async (op) => {
      bw.iw.faults.clock = op.clock;
      try {
        ctx.clock.set(startMs);
        return await on(ctx, conn, () => issue(b, r), [{ label, match: /kauro\.server_now\(\)/, nth: 1 }]);
      } finally {
        bw.iw.faults.clock = null;
      }
    });
    const settled = running.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
    await atProbe.reachedBy(running);
    ctx.clock.set(crossMs);
    atProbe.release();
    return ok(await settled);
  } finally {
    await conn.end();
  }
}

for (const fact of ["price", "source"] as const) {
  advCell(`ADV-3 DENY ACH-M-I1-EXPIRY (${fact} deadline crossed between the probe read and the effect read): an issuance whose first effect-instant read is held at source deadline - 5 ms while the clock passes the ${fact} deadline is refused ${fact === "price" ? "QUOTE_EXPIRED (judged at the effect read)" : "TRANSFER_WINDOW_TOO_SHORT"} with nothing issued; the same hold 10 s short of the source deadline issues`, "ACH-M-I1-EXPIRY", "expiry", async (ctx) => {
    const windowMs = 1;
    const deadlineOf = (b: Buyer): number => Date.parse(fact === "price" ? b.quote.quote.expiresAt : b.quote.quote.sourceAvailableUntil);
    // the probe is read just before the source deadline in both cells (the revision is then SEALED at the probe); the price cell moves the clock on past the price expiry
    const sourceOf = (b: Buyer): number => Date.parse(b.quote.quote.sourceAvailableUntil);
    const bc = await buyer(`adv3-${fact}-ok`);
    const rc = await enabled(`adv3-${fact}-ok`, [bc.a.s.agency.agencyId], { windowMs, lifetimeMs: 400 * DAY_MS });
    assert.ok(sourceOf(bc) < Date.parse(bc.quote.quote.expiresAt), "control fixture: the source deadline precedes the price expiry");
    const dc = sourceOf(bc);
    const control = await issueHeldAtProbe(ctx, `${fact} control held 10 s short of the deadline`, bc, rc, dc - 10_005, dc - 10_004);
    assert.equal(code(control), "201 SUCCESS -", `control: the ${fact} deadline is still ahead at the effect read`);
    assert.deepEqual(await issuedFootprint(projectOf(bc)), { orders: 1, instructions: 1, accepted: 1, events: ISSUED_EVENTS }, "control: the order and its instructions issued");
    const b = await buyer(`adv3-${fact}`);
    const r = await enabled(`adv3-${fact}`, [b.a.s.agency.agencyId], { windowMs, lifetimeMs: 400 * DAY_MS });
    assert.ok(sourceOf(b) < Date.parse(b.quote.quote.expiresAt), "fixture: the source deadline precedes the price expiry");
    const boundary = Date.parse(ctx.deadline(deadlineOf(b), `${fact} deadline`));
    const reply = await issueHeldAtProbe(ctx, `${fact} deadline passes between the probe read and the effect read`, b, r, sourceOf(b) - 5, boundary + 1);
    assert.equal(code(reply), fact === "price" ? "409 PRECONDITION_FAILED QUOTE_EXPIRED" : "409 PRECONDITION_FAILED TRANSFER_WINDOW_TOO_SHORT", `the ${fact} deadline crossed between the probe and the effect read refuses the issuance`);
    assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, "nothing issued");
  });
}

// === Codex r3 on f348af1 (docs/review/pv1-route-codex-r3.json): PV1R-02, PV1R-07 — FAILURE-MATRIX-TEMPLATE rule 16 =====================
// An authority judgment that gates an effect is taken under a lock that conflicts with the writer that revokes or renews that authority, with
// the clock read after the lock is granted and the effect completed before the lock is released. Each cell makes the authority's writer race
// the judgment at the lock itself: a resume waiting on the session row while the idle deadline passes (PV1R-02), a revocation started while
// the guarded read waits on its effect clock (PV1R-07), a revocation committed before the final guard's lock and before a command's COMMIT.

/** Runs `before` when the authentication boundary's pool hands out its `nth` connection during `fn` (before that transaction's first statement). */
async function withNthSessionTransaction<T>(nth: number, before: () => Promise<void>, fn: () => Promise<T>): Promise<{ readonly out: T; readonly reached: boolean }> {
  const pool = bw.iw.w.db.assurancePool as unknown as { acquire: () => Promise<unknown> } | null;
  assert.ok(pool !== null, "a sessions-enabled world binds the authentication boundary's pool");
  const real = pool.acquire;
  let seen = 0;
  let reached = false;
  pool.acquire = async () => {
    const acquired = await real.call(pool);
    if (++seen === nth) {
      reached = true;
      await before();
    }
    return acquired;
  };
  try {
    return { out: await fn(), reached };
  } finally {
    pool.acquire = real;
  }
}
interface SessionRowState {
  readonly lastSeen: number;
  readonly idle: number;
  readonly revoked: boolean;
}
async function sessionRowOf(session: BrowserSession): Promise<SessionRowState> {
  const [row] = await q<{ last_seen_at: Date; idle_expires_at: Date; revoked_at: Date | null }>("SELECT last_seen_at, idle_expires_at, revoked_at FROM kauro.web_sessions WHERE secret_sha256 = $1", [session.secretSha256]);
  assert.ok(row !== undefined, "the session row exists");
  return { lastSeen: row.last_seen_at.getTime(), idle: row.idle_expires_at.getTime(), revoked: row.revoked_at !== null };
}
const pauseMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** True once some backend is observed waiting on a lock `pid` holds (pg_blocking_pids), within `timeoutMs`. */
async function blockedBehind(pid: number, timeoutMs = LOCK_WAIT_OBSERVATION_MS): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await n("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid])) > 0) return true;
    await pauseMs(10);
  }
  return false;
}
/** The product's logout of `session` (POST /api/v1/sessions/current/revoke with its cookie, Origin and CSRF token). */
const revokeThroughProduct = (session: BrowserSession): Promise<Reply> =>
  call(bw.iw.w, { url: sessionPaths.revoke, token: null, agency: null, key: null, headers: { cookie: session.cookie, origin: bw.iw.w.identity().origin, "x-kauro-csrf": session.view.csrfToken } });
const settle = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> => p.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);

/**
 * PV1R-02 crossing: when the authentication boundary hands out its `nth` connection during `request`, the process clock moves to the session's
 * idle deadline - LEAD_MS (a touch is due: last-seen is minutes old) and another transaction takes the session row FOR UPDATE, unchanged. Once
 * the session transaction is observed blocked on that row, the clock moves `crossMs` on and the row is released (inside the 5 s statement
 * bound). The world's process clock is real time plus an offset (it keeps running), so the lead before the deadline is LEAD_MS rather than 1 ms
 * (the time the harness itself takes between the move and the release must not cross it in the control); the crossing is LEAD_MS + 2 ms.
 */
const LEAD_MS = 2_000;
async function resumeBlockedAcrossIdle(session: BrowserSession, nth: number, crossMs: number, request: () => Promise<Reply>): Promise<{ readonly reply: Reply; readonly idle: number }> {
  const clock = bw.iw.w.processClock;
  const idle = (await sessionRowOf(session)).idle;
  let crossing: Promise<Error | null> = Promise.resolve(null);
  const { out, reached } = await withNthSessionTransaction(nth, async () => {
    assert.ok(idle - LEAD_MS - clock.nowMs() >= 60_000, "the session's last-seen is at least the touch window old at the crossing (a touch is due)");
    clock.advance(idle - LEAD_MS - clock.nowMs());
    const holder = await openHolder();
    await holder.query("BEGIN");
    const locked = await holder.query("SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR UPDATE", [session.secretSha256]);
    assert.equal(locked.rowCount, 1, "the session row is held unchanged by another transaction");
    crossing = (async (): Promise<Error | null> => {
      try {
        assert.ok(await blockedBehind(connectionPid(holder)), "the resume's session statement is observed blocked on the held session row");
        if (crossMs > 0) clock.advance(crossMs);
        return null;
      } finally {
        await holder.query("COMMIT");
        await holder.end();
      }
    })().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  }, request);
  const failed = await crossing;
  if (failed !== null) throw failed;
  assert.ok(reached, `the session transaction ${nth} of the request met the held row`);
  return { reply: out, idle };
}

test(`PV1R-02 DENY ACH-M-R2-EXPIRY (session idle deadline crossed while the cookie resume waits on the session row lock): a touch-eligible session shortly before its idle deadline whose getBankRoute resume is blocked on the session row held unchanged by another transaction, released 2 ms past the deadline inside the statement bound, is refused 401 AUTHENTICATION_REQUIRED, the ended session is NOT renewed and the next request is refused; released before the deadline it is served and renewed`, async () => {
  await onMovedSessions("pv1r02r3-get", async () => {
    const r = await configured("pv1r02r3-get");
    for (const ending of ["live", "idle"] as const) {
      const session = await bw.iw.w.identity().signIn(bw.iw.owner);
      const get = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.get(r.routeId), origin: null });
      const before = await sessionRowOf(session);
      const { reply: held, idle } = await resumeBlockedAcrossIdle(session, 1, ending === "live" ? 0 : LEAD_MS + 2, get);
      const after = await sessionRowOf(session);
      if (ending === "live") {
        assert.equal(code(held), "200 SUCCESS -", "live: a session released before its idle deadline is served");
        assert.ok(after.idle > idle, "live: the live session's idle deadline is renewed by the touch");
        assert.equal(code(await get()), "200 SUCCESS -", "live: the next request is served");
        continue;
      }
      assert.equal(code(held), "401 AUTHENTICATION_REQUIRED -", "idle: the resume released past the idle deadline refuses the request");
      assert.deepEqual(after, before, "idle: the ended session is not renewed (last-seen and idle deadline unchanged)");
      assert.equal(code(await get()), "401 AUTHENTICATION_REQUIRED -", "idle: the next request is refused");
    }
  });
});

// E1 (PV1R-07 r4 repair of the r3 PV1R-02 I3 cell, docs/review/pv1-route-test-repairs.md): the row is held when the read's own connection
// passes its route lock, so the read's final session judgment (wherever it locks the row) meets it; no count of authentication-boundary
// transactions is assumed. The live control asserts the exact secrets only: whether the final judgment touches the session is not its claim.
test(`PV1R-02 r4 DENY ACH-M-I3-EXPIRY (idle deadline crossed while the final session fence waits): an instructions read whose final session judgment, taken after its route lock, waits on the session row held unchanged by another transaction shortly before the idle deadline, released 2 ms past it, is refused 401 AUTHENTICATION_REQUIRED with no account or routing digits and no reference, the session is not renewed and the next request is refused; released before the deadline it is served with the exact secrets`, async () => {
  await onMovedSessions("pv1r02r4-i3", async () => {
    const endings = ["live", "idle"] as const;
    const orders = new Map<string, Awaited<ReturnType<typeof issuedOrder>>>();
    for (const ending of endings) orders.set(ending, await issuedOrder(`pv1r02r4-${ending}`));
    for (const ending of endings) {
      const x = orders.get(ending)!;
      const session = await bw.iw.w.identity().signIn(x.b.a.billing);
      const cookieRead = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
      const clock = bw.iw.w.processClock;
      const before = await sessionRowOf(session);
      const idle = before.idle;
      const points = new FaultPoints();
      const label = `e1-route-${++heldSeq}`;
      const atRoute = points.pause(`db.${label}.after`);
      const conn = await open();
      let held: Reply;
      try {
        const running = settle(bw.iw.faults.on(conn, "kauro_app", points, [{ label, match: /FROM kauro\.bank_routes WHERE route_id = \$1 FOR SHARE/ }], cookieRead));
        await atRoute.reachedBy(running.then(() => undefined));
        assert.ok(idle - LEAD_MS - clock.nowMs() >= 60_000, "the session's last-seen is at least the touch window old at the crossing (a touch is due)");
        clock.advance(idle - LEAD_MS - clock.nowMs());
        const holder = await openHolder();
        try {
          await holder.query("BEGIN");
          const locked = await holder.query("SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR UPDATE", [session.secretSha256]);
          assert.equal(locked.rowCount, 1, "the session row is held unchanged by another transaction");
          atRoute.release();
          assert.ok(await blockedBehind(connectionPid(holder)), "the read's final session judgment is observed blocked on the held session row");
          if (ending === "idle") clock.advance(LEAD_MS + 2);
        } finally {
          await holder.query("COMMIT");
          await holder.end();
        }
        held = ok(await running);
      } finally {
        await conn.end();
      }
      const after = await sessionRowOf(session);
      if (ending === "live") {
        assert.equal(code(held), "200 SUCCESS -", "live: a session released before its idle deadline is served");
        const v = held.json<InstructionsView>().instructions;
        assert.deepEqual([v.accountNumber, v.routingNumber, v.reference], [ACCOUNT_DIGITS, "026073150", x.reference], "live: the account, the routing number and the reference");
        assert.equal(after.revoked, false, "live: the session stands");
        continue;
      }
      assert.equal(code(held), "401 AUTHENTICATION_REQUIRED -", "idle: the read released past the idle deadline is refused");
      noAccountDigits(held, "idle deadline crossed during the final session judgment's lock wait");
      assert.ok(!held.text.includes(x.reference), "idle: no payment reference in the held read");
      assert.deepEqual(after, before, "idle: the ended session is not renewed (last-seen and idle deadline unchanged)");
      const next = await cookieRead();
      assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", "idle: the next request is refused");
      noAccountDigits(next, "next read");
    }
  });
});

/** Where a revocation started during a guarded wait stands within `timeoutMs`: COMMITTED (the row is revoked) or WAITING (blocked on a lock). */
async function revocationStanding(session: BrowserSession, timeoutMs = LOCK_WAIT_OBSERVATION_MS): Promise<"COMMITTED" | "WAITING" | "NEITHER"> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await sessionRowOf(session)).revoked) return "COMMITTED";
    if ((await n("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND (query LIKE '%UPDATE kauro.web_sessions SET revoked_at%' OR query LIKE '%FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR UPDATE%')")) > 0) return "WAITING";
    await pauseMs(10);
  }
  return "NEITHER";
}
/** The next request, fenced by the revocation: it must be refused 401 (its answer is carried out of the fenced operation). */
const nextRefused = async (ctx: FaultContext, what: string, request: () => Promise<Reply>): Promise<Reply> =>
  (
    (await ctx.fenced(what, async () => {
      const r = await request();
      if (r.status === 401) throw new HeldReadAnswered(r);
      return r;
    }, (e) => e instanceof HeldReadAnswered)) as HeldReadAnswered
  ).reply;

cell(`PV1R-07 DENY ACH-M-I3-REVOCATION (revocation started while the final guard waits on the effect clock): an instructions read held at its effect-clock read after the final authentication, during which the session is revoked through the product, never answers secrets under a committed revocation: the revocation waits on the session row the final guard holds until the view is built (the read is ordered before it and served), then commits, and the next request is refused 401 with no digits or reference; the same hold without a revocation is served with the exact secrets`, "revocation", async (ctx) => {
  await onSessions(async () => {
    const x = await issuedOrder("pv1r07-held");
    const session = await bw.iw.w.identity().signIn(x.b.a.billing);
    const cookieRead = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
    const control = await readHeldAtEffectRead(ctx, "control without a revocation", cookieRead, async () => undefined);
    assert.equal(code(control), "200 SUCCESS -", "control: served");
    const c = control.json<InstructionsView>().instructions;
    assert.deepEqual([c.accountNumber, c.routingNumber, c.reference], [ACCOUNT_DIGITS, "026073150", x.reference], "control: the exact secrets");
    let revocation: Promise<PromiseSettledResult<Reply>> | null = null;
    let standing: string | null = null;
    const held = await readHeldAtEffectRead(ctx, "revocation during the effect-clock wait", cookieRead, async () => {
      revocation = settle(revokeThroughProduct(session));
      standing = await revocationStanding(session);
    });
    assert.equal(standing, "WAITING", "a revocation started while the final guard waits on its effect clock waits on the session row the guard holds (a revocation committed then would leave the read's authority stale)");
    // the read was ordered before the revocation: its answer is the session's authority as it stood under the lock
    assert.equal(code(held), "200 SUCCESS -", "the guarded read, ordered before the revocation, is served");
    await ctx.revoked("session revoked through the product once the guarded read released the row", async () => {
      const done = ok(await revocation!);
      assert.equal(done.status, 204, `the revocation commits after the guarded read (${code(done)})`);
    });
    const refused = await nextRefused(ctx, "next request after the revocation", cookieRead);
    assert.equal(code(refused), "401 AUTHENTICATION_REQUIRED -", "the next request is unauthenticated");
    noAccountDigits(refused, "next read after the revocation");
    assert.ok(!refused.text.includes(x.reference), "no payment reference after the revocation");
  });
});

// R1 (PV1R-07 r4 repair of the r3 cell, docs/review/pv1-route-test-repairs.md): the revocation commits while the read's own connection
// stands at its route lock, before its final session judgment, instead of at the third authentication-boundary acquisition.
cell(`PV1R-07 r4 DENY ACH-M-I3-REVOCATION (revocation committed before the final session fence): an instructions read whose session is revoked through the product (committed) while the read stands at its route lock, before its final session judgment, is refused 401 AUTHENTICATION_REQUIRED with no account or routing digits and no reference, like the next request`, "revocation", async (ctx) => {
  await onSessions(async () => {
    const x = await issuedOrder("pv1r07r4-before");
    const session = await bw.iw.w.identity().signIn(x.b.a.billing);
    const cookieRead = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
    const label = `r1-route-${++heldSeq}`;
    const atRoute = ctx.points.pause(`db.${label}.after`);
    const conn = await open();
    let held: Reply;
    try {
      const running = settle(ctx.operation("read held at its route lock", () => on(ctx, conn, cookieRead, [{ label, match: /FROM kauro\.bank_routes WHERE route_id = \$1 FOR SHARE/ }])));
      await atRoute.reachedBy(running.then(() => undefined));
      await ctx.revoked("session revoked through the product before the final session judgment", async () => {
        const done = await revokeThroughProduct(session);
        assert.equal(done.status, 204, `the revocation commits (${code(done)})`);
        assert.ok((await sessionRowOf(session)).revoked, "the revocation is committed");
      });
      atRoute.release();
      held = ok(await running);
    } finally {
      await conn.end();
    }
    const refused = await nextRefused(ctx, "the held read, answered after the revocation", async () => held);
    assert.equal(code(refused), "401 AUTHENTICATION_REQUIRED -", "the held read is refused");
    noAccountDigits(held, "revoked before the final session judgment");
    assert.ok(!held.text.includes(x.reference), "no payment reference");
    assert.equal(code(await cookieRead()), "401 AUTHENTICATION_REQUIRED -", "the next request is refused");
  });
});

/**
 * Sweep of rule 16 over the other effects a cookie session authorizes: `command` runs on its own connection and is held at
 * `uow.before-commit` (its work returned); the session is revoked through the product when `revoke` is given (committed); then the command
 * is released.
 */
async function heldAtCommitUnder(ctx: FaultContext, what: string, revoke: BrowserSession | null, command: () => Promise<Reply>): Promise<Reply> {
  const conn = await open();
  try {
    const atCommit = ctx.points.pause("uow.before-commit");
    const running = ctx.operation(what, () => on(ctx, conn, command));
    const settled = settle(running);
    await atCommit.reachedBy(running);
    if (revoke !== null) {
      await ctx.revoked(`${what}: the session revoked through the product while the command waits`, async () => {
        const done = await revokeThroughProduct(revoke);
        assert.equal(done.status, 204, `the revocation commits (${code(done)})`);
      });
    }
    atCommit.release();
    return ok(await settled);
  } finally {
    await conn.end();
  }
}

for (const c of AT_COMMIT) {
  cell(`PV1R-07 DENY ACH-M-R2-REVOCATION (session revoked during the post-authentication wait, ${c.name}): the ${c.name} command of a cookie session held before its COMMIT while the session is revoked through the product is refused 401 AUTHENTICATION_REQUIRED, leaving route, version, participant, event and outbox state unchanged and no journal entry; the same hold without a revocation commits`, "revocation", async (ctx) => {
    await onSessions(async () => {
      const control = await c.prepare(`pv1r07-${c.name}-ok`);
      const cs = await bw.iw.w.identity().signIn(bw.iw.owner);
      assert.equal(code(await heldAtCommitUnder(ctx, `${c.name} control`, null, () => browserCall(cs, { url: control.url, body: control.body }))), "200 SUCCESS -", `control: ${c.name} commits under a live session`);
      const x = await c.prepare(`pv1r07-${c.name}`);
      const session = await bw.iw.w.identity().signIn(bw.iw.owner);
      const key = freshKey(`pv1r07-${c.name}`);
      const before = await routeFootprint(x.r.routeId);
      const reply = await heldAtCommitUnder(ctx, `${c.name} held before COMMIT`, session, () => browserCall(session, { url: x.url, body: x.body, key }));
      assert.equal(code(reply), "401 AUTHENTICATION_REQUIRED -", `${c.name}: a session revoked before COMMIT refuses the effect`);
      assert.deepEqual(await routeFootprint(x.r.routeId), before, `${c.name}: route, version, participant, event and outbox state unchanged`);
      assert.equal(await bw.iw.w.journal(key), null, `${c.name}: no journal entry`);
      const next = await nextRefused(ctx, `${c.name}: next request`, () => browserCall(session, { method: "GET", url: bankRoutes.get(x.r.routeId), origin: null }));
      assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", `${c.name}: the next request is refused`);
    });
  });
}

cell(`PV1R-07 DENY ACH-M-I2-REVOCATION (session revoked during the post-authentication wait, issuance): an I1/I2 issuance of a cookie session held before its COMMIT while the session is revoked through the product is refused 401 AUTHENTICATION_REQUIRED with nothing issued (no order, no instructions, no accepted quote, no event) and no journal entry; the same hold without a revocation issues`, "revocation", async (ctx) => {
  await onSessions(async () => {
    const bc = await buyer("pv1r07-issue-ok");
    const rc = await enabled("pv1r07-issue-ok", [bc.a.s.agency.agencyId]);
    const cs = await bw.iw.w.identity().signIn(bc.a.billing);
    const control = await heldAtCommitUnder(ctx, "issuance control", null, () => browserCall(cs, { url: bankRoutes.order(bc.quote.quote.quoteId), body: issueBody(bc, rc), agency: bc.a.s.agency.agencyId }));
    assert.equal(code(control), "201 SUCCESS -", "control: the issuance commits under a live session");
    const b = await buyer("pv1r07-issue");
    const r = await enabled("pv1r07-issue", [b.a.s.agency.agencyId]);
    const session = await bw.iw.w.identity().signIn(b.a.billing);
    const key = freshKey("pv1r07-issue");
    const issueCall = (k?: string): Promise<Reply> => browserCall(session, { url: bankRoutes.order(b.quote.quote.quoteId), body: issueBody(b, r), agency: b.a.s.agency.agencyId, ...(k === undefined ? {} : { key: k }) });
    const reply = await heldAtCommitUnder(ctx, "issuance held before COMMIT", session, () => issueCall(key));
    assert.equal(code(reply), "401 AUTHENTICATION_REQUIRED -", "a session revoked before COMMIT refuses the issuance");
    assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, "nothing issued");
    assert.equal(await bw.iw.w.journal(key), null, "no journal entry");
    const next = await nextRefused(ctx, "issuance: next request", () => issueCall());
    assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", "the next issuance is refused");
  });
});

// === internal adversary r6 on 68ab5cc (docs/review/pv1-route-adversary-r6.md): ADV-1 revoke instant, ADV-2 CMD028 replay ================
// Rule 16 for the writers of the authority itself: the revoking transaction takes the session row lock FIRST, THEN reads its clock, THEN judges
// (a session past a deadline at that instant is ENDED, not REVOKED) and writes at that instant.

interface SessionStamps {
  readonly lastSeen: number;
  readonly revokedAt: number | null;
}
async function sessionStampsOf(session: BrowserSession): Promise<SessionStamps> {
  const [row] = await q<{ last_seen_at: Date; revoked_at: Date | null }>("SELECT last_seen_at, revoked_at FROM kauro.web_sessions WHERE secret_sha256 = $1", [session.secretSha256]);
  assert.ok(row !== undefined, "the session row exists");
  return { lastSeen: row.last_seen_at.getTime(), revokedAt: row.revoked_at === null ? null : row.revoked_at.getTime() };
}

/** An instructions read holds the session row at its effect-clock read; `during` starts the logout (it must wait on the row) and moves the process clock by `moveMs`. */
async function logoutBehindHeldRead(ctx: FaultContext, label: string, moveMs: number, via: "logout" | "replace" = "logout"): Promise<{ readonly held: Reply; readonly standing: string | null; readonly movedTo: number; readonly session: BrowserSession; readonly done: Reply }> {
  const x = await issuedOrder(label);
  const session = await bw.iw.w.identity().signIn(x.b.a.billing);
  const cookieRead = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
  const clock = bw.iw.w.processClock;
  clock.advance(61_000); // a touch is due: the held read renews the session at its lock
  const replacement = via === "replace" ? await bw.iw.w.identity().freshToken(x.b.a.billing) : null;
  const trigger = (): Promise<Reply> => (replacement === null ? revokeThroughProduct(session) : call(bw.iw.w, { url: sessionPaths.open, token: null, key: null, agency: null, body: { idToken: replacement }, headers: { cookie: session.cookie, origin: bw.iw.w.identity().origin } }));
  let revocation: Promise<PromiseSettledResult<Reply>> | null = null;
  let standing: string | null = null;
  let movedTo = 0;
  const held = await readHeldAtEffectRead(ctx, label, cookieRead, async () => {
    revocation = settle(trigger());
    standing = await revocationStanding(session);
    clock.advance(moveMs);
    movedTo = clock.nowMs();
  });
  let done!: Reply;
  await ctx.revoked(`${label}: the logout committed once the held read released the row`, async () => {
    done = ok(await revocation!);
  });
  const next = await nextRefused(ctx, `${label}: the next request`, cookieRead);
  assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", `${label}: the next request is refused`);
  return { held, standing, movedTo, session, done };
}

movedCell("adv1r6-instant", `ADV-1 r6 DENY ACH-M-I3-REVOCATION (logout instant read after the row lock wait): a logout that waits on the session row held by a guarded read, with the process clock moving on while it waits, revokes at an instant read after its lock was granted: revoked_at is not before the read's touch (last_seen_at) nor before the instant the row was released, and the logout is answered 204`, "revocation", async (ctx) => {
  const r = await logoutBehindHeldRead(ctx, "adv1r6-instant", 5_000);
  assert.equal(r.standing, "WAITING", "the logout waits on the session row the read holds");
  assert.equal(code(r.held), "200 SUCCESS -", "the read, ordered before the logout, is served");
  assert.equal(r.done.status, 204, `the logout commits (${code(r.done)})`);
  const stamps = await sessionStampsOf(r.session);
  assert.ok(stamps.revokedAt !== null, "the session is revoked");
  assert.ok(stamps.revokedAt! >= stamps.lastSeen, `revoked_at (${stamps.revokedAt}) is not before the touch under the same lock (${stamps.lastSeen})`);
  assert.ok(stamps.revokedAt! >= r.movedTo, `revoked_at (${stamps.revokedAt}) is read after the wait on the row, not before it (the clock stood at ${r.movedTo} when the row was released)`);
});

movedCell("adv1r6-ended", `ADV-1 r6 DENY ACH-M-I3-REVOCATION (idle deadline passes while the logout waits on the session row): a logout that waits on the row of a session whose idle deadline passes during the wait finds the session ENDED at its post-lock instant: the row is not marked revoked and no SESSION_REVOKE ALLOW fact is recorded; the logout is still answered 204`, "revocation", async (ctx) => {
  const r = await logoutBehindHeldRead(ctx, "adv1r6-ended", 31 * 60_000);
  assert.equal(r.standing, "WAITING", "the logout waits on the session row the read holds");
  assert.equal(code(r.held), "401 AUTHENTICATION_REQUIRED -", "the read judged after the idle deadline is refused");
  assert.equal(r.done.status, 204, `the logout is answered 204 (${code(r.done)})`);
  const stamps = await sessionStampsOf(r.session);
  assert.equal(stamps.revokedAt, null, "an expired session is ended, not revoked");
  const facts = await q<{ outcome: string }>("SELECT outcome FROM kauro.security_events WHERE action = 'SESSION_REVOKE' AND actor_id = $1", [r.session.view.userId]);
  assert.deepEqual(facts, [], "no revocation fact for a session that ended before the revoking instant");
});

cell(`ADV-2 r6 DENY ACH-M-I2-REVOCATION (CMD028 replay judged under the session lock): the replay of a committed issuance key by a cookie session revoked (committed) before the replay's session lock is refused 401 AUTHENTICATION_REQUIRED and its body carries no transfer reference; the replay of the same key by a live session answers the stored response`, "revocation", async (ctx) => {
  await onSessions(async () => {
    const b = await buyer("adv2r6-replay");
    const r = await enabled("adv2r6-replay", [b.a.s.agency.agencyId]);
    const session = await bw.iw.w.identity().signIn(b.a.billing);
    const key = freshKey("adv2r6-replay");
    const issueCall = (): Promise<Reply> => browserCall(session, { url: bankRoutes.order(b.quote.quote.quoteId), body: issueBody(b, r), agency: b.a.s.agency.agencyId, key });
    const first = await issueCall();
    assert.equal(code(first), "201 SUCCESS -", "the first issuance commits");
    const reference = completed<IssuedView>(first, 201).data.transfer.reference;
    const live = await issueCall();
    assert.equal(code(live), "201 SUCCESS -", "control: the replay under a live session answers the stored response");
    assert.ok(live.text.includes(reference), "control: the stored response carries the reference");
    // r4 repair (PV1R-07): the revocation commits while the replay stands at its journal reservation on its own connection (after its
    // authentication, before the session fence of its own unit), as H7 does
    const label = `adv2r6-journal-${++heldSeq}`;
    const atJournal = ctx.points.pause(`db.${label}.after`);
    const rc = await open();
    let replay: Reply;
    try {
      const running = settle(ctx.operation("replay held at its journal reservation", () => on(ctx, rc, issueCall, [{ label, match: /INSERT INTO kauro\.command_journal/ }])));
      await atJournal.reachedBy(running.then(() => undefined));
      await ctx.revoked("session revoked through the product before the replay's session fence", async () => {
        const done = await revokeThroughProduct(session);
        assert.equal(done.status, 204, `the revocation commits (${code(done)})`);
      });
      atJournal.release();
      replay = ok(await running);
    } finally {
      await rc.end();
    }
    assert.equal(code(replay), "401 AUTHENTICATION_REQUIRED -", "the replay of a revoked session is refused");
    assert.ok(!replay.text.includes(reference), "no transfer reference in the replay's body");
    assert.equal(code(await nextRefused(ctx, "the next replay", issueCall)), "401 AUTHENTICATION_REQUIRED -", "the next replay is refused too");
  });
});

// === coordinator items A, B on f50fd41: the step-up and the replaced-session revoke are rule-16 writers of the session too ================

/**
 * A step-up request of a fresh session whose recording transaction (the request's SECOND session transaction; the first is its authentication)
 * meets the session row held by another transaction. Once blocked, the process clock moves by `moveMs` and the holder takes effect: it
 * commits the row unchanged, or revokes the session, before the row is released.
 */
async function stepUpBlocked(moveMs: number, effect: "unchanged" | "revoke"): Promise<{ readonly reply: Reply; readonly effectMs: number; readonly proofs: ReadonlyArray<number>; readonly before: number; readonly reached: boolean }> {
  const clock = bw.iw.w.processClock;
  const person = bw.iw.owner;
  const session = await bw.iw.w.identity().signIn(person);
  const token = await bw.iw.w.identity().freshToken(person);
  const userId = session.view.userId;
  const stamps = async (): Promise<number[]> => (await q<{ created_at: Date }>("SELECT created_at FROM kauro.assurance_proofs WHERE user_id = $1 AND kind = 'STEP_UP' ORDER BY created_at", [userId])).map((r) => r.created_at.getTime());
  const before = (await stamps()).length;
  let effectMs = 0;
  let crossing: Promise<Error | null> = Promise.resolve(null);
  const { out, reached } = await withNthSessionTransaction(
    2,
    async () => {
      const holder = await openHolder();
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR UPDATE", [session.secretSha256]);
      crossing = (async (): Promise<Error | null> => {
        try {
          assert.ok(await blockedBehind(connectionPid(holder)), "the step-up's session statement is observed blocked on the held session row");
          clock.advance(moveMs);
          effectMs = clock.nowMs();
          if (effect === "revoke") await holder.query("UPDATE kauro.web_sessions SET revoked_at = $2::timestamptz, revoke_reason = 'LOGOUT' WHERE secret_sha256 = $1", [session.secretSha256, new Date(effectMs).toISOString()]);
          return null;
        } finally {
          await holder.query("COMMIT");
          await holder.end();
        }
      })().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    },
    () => browserCall(session, { url: sessionPaths.stepUp, body: { idToken: token } }),
  );
  const failed = await crossing;
  if (failed !== null) throw failed;
  return { reply: out, effectMs, proofs: await stamps(), before, reached };
}

test("A r6 DENY ACH-M-R2-REVOCATION (step-up recorded at an instant read after the session row lock): a step-up whose recording waits on the session row held by another transaction, the process clock moving on while it waits, records its proof at an instant read after the lock was granted: created_at is not before the instant the row was released", async () => {
  await onMovedSessions("adv-a-instant", async () => {
    const r = await stepUpBlocked(5_000, "unchanged");
    assert.equal(code(r.reply), "201 SUCCESS -", "the step-up of a live session is recorded");
    assert.ok(r.reached, "the recording took a session transaction after the authentication");
    assert.equal(r.proofs.length, r.before + 1, "one proof recorded");
    const at = r.proofs[r.proofs.length - 1]!;
    assert.ok(at >= r.effectMs, `the proof's created_at (${at}) is read after the wait on the row, not before it (the clock stood at ${r.effectMs} when the row was released)`);
  });
});

test("A r6 DENY ACH-M-R2-EXPIRY (idle deadline passes while the step-up waits on the session row): the step-up is refused 401 AUTHENTICATION_REQUIRED and records no proof", async () => {
  await onMovedSessions("adv-a-idle", async () => {
    const r = await stepUpBlocked(31 * 60_000, "unchanged");
    assert.equal(code(r.reply), "401 AUTHENTICATION_REQUIRED -", "a session past its idle deadline at the post-lock instant records no step-up");
    assert.equal(r.proofs.length, r.before, "no step-up proof recorded");
    assert.ok(r.reached);
  });
});

test("A r6 DENY ACH-M-R2-REVOCATION (revocation commits while the step-up waits on the session row): the step-up is refused 401 AUTHENTICATION_REQUIRED and records no proof", async () => {
  await onMovedSessions("adv-a-revoke", async () => {
    const r = await stepUpBlocked(1_000, "revoke");
    assert.equal(code(r.reply), "401 AUTHENTICATION_REQUIRED -", "a session revoked during the wait records no step-up");
    assert.equal(r.proofs.length, r.before, "no step-up proof recorded");
    assert.ok(r.reached);
  });
});

movedCell("advb-instant", `B r6 DENY ACH-M-I3-REVOCATION (replaced session revoked at an instant read after the row lock wait): a sign-in that replaces a session whose row is held by a guarded read, the process clock moving on while it waits, revokes the old session at an instant read after its lock was granted: revoked_at is not before the read's touch nor before the instant the row was released`, "revocation", async (ctx) => {
  const r = await logoutBehindHeldRead(ctx, "advb-instant", 5_000, "replace");
  assert.equal(r.standing, "WAITING", "the replacing sign-in waits on the old session row the read holds");
  assert.equal(r.done.status, 201, `the sign-in opens its session (${code(r.done)})`);
  const stamps = await sessionStampsOf(r.session);
  assert.ok(stamps.revokedAt !== null, "the replaced session is revoked");
  assert.ok(stamps.revokedAt! >= stamps.lastSeen, `revoked_at (${stamps.revokedAt}) is not before the touch (${stamps.lastSeen})`);
  assert.ok(stamps.revokedAt! >= r.movedTo, `revoked_at (${stamps.revokedAt}) is read after the wait on the row (the clock stood at ${r.movedTo} when it was released)`);
});

movedCell("advb-ended", `B r6 DENY ACH-M-I3-REVOCATION (idle deadline of the replaced session passes while the sign-in waits on its row): the old session is ENDED, not revoked: no revoked_at, no SESSION_REVOKE fact; the sign-in still opens its session`, "revocation", async (ctx) => {
  const r = await logoutBehindHeldRead(ctx, "advb-ended", 31 * 60_000, "replace");
  assert.equal(r.standing, "WAITING", "the replacing sign-in waits on the old session row the read holds");
  assert.equal(r.done.status, 201, `the sign-in opens its session (${code(r.done)})`);
  const stamps = await sessionStampsOf(r.session);
  assert.equal(stamps.revokedAt, null, "an expired session is ended, not revoked");
  const facts = await q<{ outcome: string }>("SELECT outcome FROM kauro.security_events WHERE action = 'SESSION_REVOKE' AND actor_id = $1", [r.session.view.userId]);
  assert.deepEqual(facts, [], "no revocation fact for a session that ended before the revoking instant");
});

// === adversary r7 ADV-1 on 418f073: the 300 s re-authentication age is judged at the post-lock instant too ==================================

test("C r7 DENY ACH-M-R2-EXPIRY (re-authentication ages past 300 s while the step-up waits on the session row): the step-up is refused 403 ASSURANCE_REQUIRED STEP_UP_STALE and records no proof; the same wait 60 s short of the window records it", async () => {
  await onMovedSessions("adv-r7-stale", async () => {
    const live = await stepUpBlocked(240_000, "unchanged");
    assert.equal(code(live.reply), "201 SUCCESS -", "control: a re-authentication 240 s old at the post-lock instant is recorded");
    assert.equal(live.proofs.length, live.before + 1, "control: one proof recorded");
    // the proof's instants are pinned (r8): issued_at is the re-authentication's own instant (never the later recording instant), so the recording
    // instant is the 240 s wait plus the real time the harness took after the token was minted, and the judgment admits at most 300 s (auth_time is whole seconds, up to 999 ms older than the mint, so a 60 s margin is kept):
    // created_at - issued_at lies in [240000, 300000] ms; the freshness window is 900000 ms
    const [row] = await q<{ issued_at: Date; created_at: Date; expires_at: Date }>("SELECT issued_at, created_at, expires_at FROM kauro.assurance_proofs WHERE kind = 'STEP_UP' ORDER BY created_at DESC LIMIT 1");
    assert.ok(row !== undefined, "control: the proof row exists");
    const age = row.created_at.getTime() - row.issued_at.getTime();
    assert.ok(age >= 240_000 && age <= 300_000, `control: created_at - issued_at is the re-authentication's age at the recording instant, in [240000, 300000] ms (was ${age})`);
    assert.equal(row.expires_at.getTime() - row.issued_at.getTime(), 900_000, "control: the proof is fresh for 900000 ms from its issue");
    const r = await stepUpBlocked(301_000, "unchanged");
    assert.equal(code(r.reply), "403 ASSURANCE_REQUIRED STEP_UP_STALE", "a re-authentication 301 s old at the post-lock instant is stale");
    assert.equal(r.proofs.length, r.before, "no step-up proof recorded");
    assert.ok(r.reached);
  });
});

// === Codex r4 on ac9a2ed (tools/review/out/pv1-route-r4-ac9a2ed0c21a): PV1R-07 r4, the session lock and the effect share one transaction ===
// docs/review/pv1-route-pv1r07-design.md §5. Each cell holds the effect at a statement of its OWN connection, finds the backend holding the
// session row through PostgreSQL (a superuser probe asks FOR UPDATE; pg_blocking_pids names its blocker), terminates exactly that backend,
// revokes the session through the product (committed), then releases the effect. A lock held by another transaction than the effect's is
// no fence: the effect must not commit nor be served; the next request is refused 401; and the holder must have been the effect's own
// backend, with no authentication-boundary backend in a transaction (FAILURE-MATRIX-TEMPLATE rule 16, r4 amendment).

/** A pause point on the effect's own connection and the statement steps that arm it. */
interface HoldPoint {
  readonly point: string;
  readonly steps: ReadonlyArray<SqlStep>;
  readonly taken: () => boolean;
}
const ROUTE_LOCK = /FROM kauro\.bank_routes WHERE route_id = \$1 FOR SHARE/;
const EFFECT_READ = /kauro\.effect_now\(\)/;
const COMMIT_STATEMENT = /^\s*COMMIT\s*$/i;
/** I3's final effect-clock read: the first `kauro.effect_now()` on the read's connection after its route lock (`.after`: its answer held). */
function i3EffectRead(): HoldPoint {
  const label = `r4-i3-effect-${++heldSeq}`;
  let locked = false;
  let taken = false;
  return {
    point: `db.${label}.after`,
    taken: () => taken,
    steps: [
      {
        label: `${label}-route`,
        match: ROUTE_LOCK,
        when: () => {
          locked = true;
          return false;
        },
      },
      {
        label,
        match: EFFECT_READ,
        when: () => {
          if (!locked || taken) return false;
          taken = true;
          return true;
        },
      },
    ],
  };
}
/** The order of the effect-clock reads (E) and COMMITs (C) one request runs on its connection (a control run of the same path). */
type StatementPlan = ReadonlyArray<"E" | "C">;
async function statementPlan(request: () => Promise<Reply>): Promise<StatementPlan> {
  const conn = await open();
  const seen: Array<"E" | "C"> = [];
  try {
    const steps: ReadonlyArray<SqlStep> = [
      {
        label: "plan-effect",
        match: EFFECT_READ,
        when: () => {
          seen.push("E");
          return false;
        },
      },
      {
        label: "plan-commit",
        match: COMMIT_STATEMENT,
        when: () => {
          seen.push("C");
          return false;
        },
      },
    ];
    const reply = await bw.iw.faults.on(conn, "kauro_app", new FaultPoints(), steps, request);
    assert.ok(reply.status < 300, `the plan run of the path succeeds (${code(reply)})`);
    return seen;
  } finally {
    await conn.end();
  }
}
/** The nth statement matching `match` on the connection, held at `.after` (its answer) or `.before` (not yet sent). */
function nthStatement(name: string, match: RegExp, nth: number, side: "before" | "after"): HoldPoint {
  const label = `r4-${name}-${++heldSeq}`;
  let k = 0;
  let taken = false;
  return {
    point: `db.${label}.${side}`,
    taken: () => taken,
    steps: [
      {
        label,
        match,
        when: () => {
          if (++k !== nth) return false;
          taken = true;
          return true;
        },
      },
    ],
  };
}
/** "before the final judgment": the answer of the unit's LAST effect-clock read held (the session already locked, the judgment not yet taken). */
function finalJudgmentOf(plan: StatementPlan): HoldPoint {
  const count = plan.filter((x) => x === "E").length;
  assert.ok(count > 0, `the path reads its effect clock on its connection (${plan.join("")})`);
  return nthStatement("final-judgment", EFFECT_READ, count, "after");
}
/** "before COMMIT": the COMMIT that follows the last effect-clock read (the last COMMIT when the path reads none), held before it is sent. */
function commitOf(plan: StatementPlan): HoldPoint {
  const lastE = plan.lastIndexOf("E");
  const at = lastE < 0 ? plan.lastIndexOf("C") : plan.findIndex((x, i) => x === "C" && i > lastE);
  assert.ok(at >= 0, `the path commits on its connection (${plan.join("")})`);
  return nthStatement("commit", COMMIT_STATEMENT, plan.slice(0, at + 1).filter((x) => x === "C").length, "before");
}

/** What PostgreSQL said about the backend that held the session row when it was lost. */
interface LostHolder {
  readonly pid: number;
  readonly usename: string;
  readonly applicationName: string;
  /** The holder was the effect's own connection (connectionPid of the held effect's connection). */
  readonly own: boolean;
  /** Backends of the authentication boundary (kauro_assurance_test) in a transaction while the effect was held. */
  readonly boundaryInTransaction: number;
}
/**
 * Holder discovery and loss (design §5): a superuser probe asks the session row FOR UPDATE (lock_timeout 10 s) without being awaited; the
 * oracle polls pg_blocking_pids(probe) until it names a blocker; exactly one is required; that backend is terminated and gone; the probe then
 * gets the row and rolls back (nothing of it remains).
 */
async function loseSessionLockHolder(session: BrowserSession, conn: HarnessConnection): Promise<LostHolder> {
  const probe = await openHolder();
  probe.on("error", () => undefined);
  try {
    await probe.query("BEGIN");
    await probe.query("SET LOCAL lock_timeout = '10s'");
    const probing = settle(probe.query("SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1 FOR UPDATE", [session.secretSha256]));
    const probePid = connectionPid(probe);
    let blockers: number[] = [];
    const until = Date.now() + 4_000;
    while (Date.now() < until) {
      blockers = ((await q<{ b: number[] }>("SELECT pg_blocking_pids($1) AS b", [probePid]))[0]?.b ?? []).map(Number);
      if (blockers.length > 0) break;
      await pauseMs(10);
    }
    assert.equal(blockers.length, 1, `exactly one backend holds the session row while the effect is held (blockers ${JSON.stringify(blockers)})`);
    const pid = blockers[0]!;
    const [who] = await q<{ usename: string; application_name: string }>("SELECT usename, application_name FROM pg_stat_activity WHERE pid = $1", [pid]);
    const boundaryInTransaction = await n("SELECT 1 FROM pg_stat_activity WHERE usename = 'kauro_assurance_test' AND xact_start IS NOT NULL");
    const own = pid === connectionPid(conn);
    if (own) conn.on("error", () => undefined);
    assert.equal((await q<{ ok: boolean }>("SELECT pg_terminate_backend($1) AS ok", [pid]))[0]!.ok, true, `the holder ${pid} is terminated`);
    let gone = false;
    for (let i = 0; i < 400 && !gone; i++) {
      gone = (await n("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid])) === 0;
      if (!gone) await pauseMs(10);
    }
    assert.ok(gone, `the holder ${pid} is gone`);
    const got = ok(await probing);
    assert.equal(got.rowCount, 1, "the probe gets the session row once its holder is gone");
    await probe.query("ROLLBACK");
    return { pid, usename: who?.usename ?? "?", applicationName: who?.application_name ?? "?", own, boundaryInTransaction };
  } finally {
    await probe.end().catch(() => undefined);
  }
}
/** The effect held at `at` on its own connection; its session-lock holder lost; the session revoked through the product (committed); released. */
async function heldLosingHolder(ctx: FaultContext, what: string, session: BrowserSession, at: HoldPoint, request: () => Promise<Reply>): Promise<{ readonly reply: Reply; readonly lost: LostHolder }> {
  const conn = await open();
  conn.on("error", () => undefined);
  try {
    const pause = ctx.points.pause(at.point);
    const running = ctx.operation(what, () => on(ctx, conn, request, at.steps));
    const settled = settle(running);
    await pause.reachedBy(running);
    const lost = await loseSessionLockHolder(session, conn);
    await ctx.revoked(`${what}: the session revoked through the product after its lock holder was lost`, async () => {
      const done = await revokeThroughProduct(session);
      assert.equal(done.status, 204, `the revocation commits (${code(done)})`);
      assert.ok((await sessionRowOf(session)).revoked, "the revocation is committed");
    });
    pause.release();
    const reply = ok(await settled);
    assert.ok(at.taken(), `${what}: the effect was held at its own statement`);
    return { reply, lost };
  } finally {
    await conn.end().catch(() => undefined);
  }
}
/** No 2xx after the holder was lost: the unit's connection failure, pinned to one value — the retryable 503 CAPACITY_UNAVAILABLE a lost
 * database connection answers since the O28A review F-2 fix (it was 500 INTERNAL_ERROR on the first green run of the r4 fix, design K2). */
const notServed = (r: Reply): boolean => code(r) === "503 CAPACITY_UNAVAILABLE -";
/** The rule 16 r4 lock assertion: the effect's own backend was the only holder, and no authentication-boundary backend was in a transaction. */
function fencedByOwnTransaction(lost: LostHolder, what: string): void {
  assert.equal(lost.own, true, `${what}: the only session-lock holder is the effect's own unit backend (it was ${lost.usename} / ${lost.applicationName}, pid ${lost.pid})`);
  assert.equal(lost.boundaryInTransaction, 0, `${what}: no authentication-boundary backend is in a transaction while the effect is held`);
}

// --- H1, H2: I3 -----------------------------------------------------------------------------------------------------------------------

for (const [id, at, label] of [
  ["H1", "during the effect-clock wait", "i3-effect"],
  ["H2", "after the view was built, before COMMIT", "i3-commit"],
] as const) {
  advCell(`PV1R-07 r4 DENY ACH-M-I3-REVOCATION (session-lock holder lost ${at}): an instructions read held ${id === "H1" ? "at its final effect-clock read" : "after its view was built, before its COMMIT"} whose session-row lock holder backend is terminated, the session then revoked through the product (committed), never answers secrets: no 2xx, no account or routing digits, no reference; the next request is refused 401; the only lock holder was the read's own unit backend and no authentication-boundary backend was in a transaction`, "ACH-M-I3-REVOCATION", "revocation", async (ctx) => {
    await onSessions(async () => {
      const x = await issuedOrder(`pv1r07r4-${label}`);
      const session = await bw.iw.w.identity().signIn(x.b.a.billing);
      const cookieRead = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
      const hold = id === "H1" ? i3EffectRead() : commitOf(await statementPlan(cookieRead));
      const { reply, lost } = await heldLosingHolder(ctx, `${id} read`, session, hold, cookieRead);
      assert.ok(notServed(reply), `the read whose lock holder was lost is not served (${code(reply)})`);
      noAccountDigits(reply, `${id}: lock holder lost`);
      assert.ok(!reply.text.includes(x.reference), `${id}: no payment reference`);
      const next = await nextRefused(ctx, `${id}: next request`, cookieRead);
      assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", `${id}: the next request is refused`);
      noAccountDigits(next, `${id}: next read`);
      fencedByOwnTransaction(lost, id);
    });
  });
}

// --- H3: the four step-up route commands, at two positions ------------------------------------------------------------------------------

for (const position of ["before the final judgment", "before COMMIT"] as const) {
  for (const c of AT_COMMIT) {
    advCell(`PV1R-07 r4 DENY ACH-M-R2-REVOCATION (session-lock holder lost ${position}, ${c.name}): the ${c.name} command whose session-lock holder backend is terminated ${position}, the session then revoked through the product, commits nothing: no 2xx, route, version, participant, event and outbox state unchanged, no journal entry; the next request is refused 401`, "ACH-M-R2-REVOCATION", "revocation", async (ctx) => {
      await onSessions(async () => {
        const control = await c.prepare(`pv1r07r4-${c.name}-plan`);
        const cs = await bw.iw.w.identity().signIn(bw.iw.owner);
        const plan = await statementPlan(() => browserCall(cs, { url: control.url, body: control.body }));
        const x = await c.prepare(`pv1r07r4-${c.name}`);
        const session = await bw.iw.w.identity().signIn(bw.iw.owner);
        const key = freshKey(`pv1r07r4-${c.name}`);
        const before = await routeFootprint(x.r.routeId);
        const hold = position === "before COMMIT" ? commitOf(plan) : finalJudgmentOf(plan);
        const { reply, lost } = await heldLosingHolder(ctx, `${c.name} ${position}`, session, hold, () => browserCall(session, { url: x.url, body: x.body, key }));
        assert.ok(notServed(reply), `${c.name}: nothing commits under a lost lock (${code(reply)})`);
        assert.deepEqual(await routeFootprint(x.r.routeId), before, `${c.name}: route, version, participant, event and outbox state unchanged`);
        assert.equal(await bw.iw.w.journal(key), null, `${c.name}: no journal entry`);
        const next = await nextRefused(ctx, `${c.name}: next request`, () => browserCall(session, { method: "GET", url: bankRoutes.get(x.r.routeId), origin: null }));
        assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", `${c.name}: the next request is refused`);
        fencedByOwnTransaction(lost, c.name);
      });
    });
  }
}

// --- H4: issuance, at two positions -------------------------------------------------------------------------------------------------------

for (const position of ["before the final judgment", "before COMMIT"] as const) {
  advCell(`PV1R-07 r4 DENY ACH-M-I2-REVOCATION (session-lock holder lost ${position}, issuance): an I1/I2 issuance of a cookie session whose session-lock holder backend is terminated ${position}, the session then revoked through the product, issues nothing (no order, no instructions, no accepted quote, no event) and leaves no journal entry; the next issuance is refused 401`, "ACH-M-I2-REVOCATION", "revocation", async (ctx) => {
    await onSessions(async () => {
      const bc = await buyer("pv1r07r4-issue-plan");
      const rc = await enabled("pv1r07r4-issue-plan", [bc.a.s.agency.agencyId]);
      const cs = await bw.iw.w.identity().signIn(bc.a.billing);
      const plan = await statementPlan(() => browserCall(cs, { url: bankRoutes.order(bc.quote.quote.quoteId), body: issueBody(bc, rc), agency: bc.a.s.agency.agencyId }));
      const b = await buyer("pv1r07r4-issue");
      const r = await enabled("pv1r07r4-issue", [b.a.s.agency.agencyId]);
      const session = await bw.iw.w.identity().signIn(b.a.billing);
      const key = freshKey("pv1r07r4-issue");
      const issueCall = (k?: string): Promise<Reply> => browserCall(session, { url: bankRoutes.order(b.quote.quote.quoteId), body: issueBody(b, r), agency: b.a.s.agency.agencyId, ...(k === undefined ? {} : { key: k }) });
      const hold = position === "before COMMIT" ? commitOf(plan) : finalJudgmentOf(plan);
      const { reply, lost } = await heldLosingHolder(ctx, `issuance ${position}`, session, hold, () => issueCall(key));
      assert.ok(notServed(reply), `issuance: nothing issued under a lost lock (${code(reply)})`);
      assert.deepEqual(await issuedFootprint(projectOf(b)), NOTHING_ISSUED, "nothing issued");
      assert.equal(await bw.iw.w.journal(key), null, "no journal entry");
      const next = await nextRefused(ctx, "issuance: next request", () => issueCall());
      assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", "the next issuance is refused");
      fencedByOwnTransaction(lost, "issuance");
    });
  });
}

// --- H5: getBankRoute; H6: CMD028 replay -------------------------------------------------------------------------------------------------

advCell(`PV1R-07 r4 DENY ACH-M-R2-REVOCATION (session-lock holder lost before COMMIT, getBankRoute): a route read whose session-lock holder backend is terminated before its COMMIT, the session then revoked through the product, answers no 2xx and no route view; the next request is refused 401`, "ACH-M-R2-REVOCATION", "revocation", async (ctx) => {
  await onSessions(async () => {
    const r = await configured("pv1r07r4-get");
    const session = await bw.iw.w.identity().signIn(bw.iw.owner);
    const get = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.get(r.routeId), origin: null });
    const plan = await statementPlan(get);
    const { reply, lost } = await heldLosingHolder(ctx, "getBankRoute before COMMIT", session, commitOf(plan), get);
    assert.ok(notServed(reply), `getBankRoute: no route view under a lost lock (${code(reply)})`);
    assert.ok(!reply.text.includes(r.detailsEvidenceHash), "getBankRoute: no route view in the body");
    const next = await nextRefused(ctx, "getBankRoute: next request", get);
    assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", "getBankRoute: the next request is refused");
    fencedByOwnTransaction(lost, "getBankRoute");
  });
});

advCell(`PV1R-07 r4 DENY ACH-M-I2-REVOCATION (session-lock holder lost before COMMIT, CMD028 replay): the replay of a committed issuance key whose session-lock holder backend is terminated before the replay unit's COMMIT, the session then revoked, never returns the stored body (no reference); next request 401`, "ACH-M-I2-REVOCATION", "revocation", async (ctx) => {
  await onSessions(async () => {
    const b = await buyer("pv1r07r4-replay");
    const r = await enabled("pv1r07r4-replay", [b.a.s.agency.agencyId]);
    const session = await bw.iw.w.identity().signIn(b.a.billing);
    const key = freshKey("pv1r07r4-replay");
    const issueCall = (): Promise<Reply> => browserCall(session, { url: bankRoutes.order(b.quote.quote.quoteId), body: issueBody(b, r), agency: b.a.s.agency.agencyId, key });
    const first = await issueCall();
    assert.equal(code(first), "201 SUCCESS -", "the first issuance commits");
    const reference = completed<IssuedView>(first, 201).data.transfer.reference;
    const plan = await statementPlan(issueCall);
    const { reply, lost } = await heldLosingHolder(ctx, "CMD028 replay before COMMIT", session, commitOf(plan), issueCall);
    assert.ok(notServed(reply), `the replay under a lost lock does not return the stored body (${code(reply)})`);
    assert.ok(!reply.text.includes(reference), "no transfer reference in the replay's body");
    const next = await nextRefused(ctx, "replay: next request", issueCall);
    assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", "the next replay is refused");
    assert.ok(!next.text.includes(reference), "no reference in the next replay");
    fencedByOwnTransaction(lost, "CMD028 replay");
  });
});

// --- H7: crash after COMMIT, replay after the revocation --------------------------------------------------------------------------------

const H7_TITLE = `PV1R-07 r4 RACE (crash after COMMIT) ACH-M-I2-REVOCATION: an issuance whose COMMIT succeeded under a live session and whose answer was lost (uow.after-commit), replayed with the same key after the session was revoked through the product, is refused 401 without the stored body; replayed by a live session it answers the stored response`;
test(H7_TITLE, async () => {
  await runCell({ id: "ACH-M-I2-CRASH-AFTER", step: H7_TITLE.slice(H7_TITLE.indexOf(": ") + 2), fault: "crash-after-commit", at: "uow", expect: H7_TITLE }, async (ctx) => {
  await onSessions(async () => {
    const b = await buyer("pv1r07r4-h7");
    const r = await enabled("pv1r07r4-h7", [b.a.s.agency.agencyId]);
    const session = await bw.iw.w.identity().signIn(b.a.billing);
    const key = freshKey("pv1r07r4-h7");
    const issueCall = (): Promise<Reply> => browserCall(session, { url: bankRoutes.order(b.quote.quote.quoteId), body: issueBody(b, r), agency: b.a.s.agency.agencyId, key });
    const crash = ctx.points.crash("uow.after-commit");
    const conn = await open();
    try {
      const lostAnswer = await ctx.operation("issuance whose answer is lost after COMMIT", () => on(ctx, conn, issueCall));
      await crash.reached;
      assert.equal(lostAnswer.status, 500, `the lost answer (${code(lostAnswer)})`);
    } finally {
      await conn.end();
    }
    const [row] = await q<{ reference: string; order_state: string }>("SELECT i.reference, i.order_state FROM kauro.bank_transfer_instructions i JOIN kauro.payment_orders o ON o.order_id = i.order_id WHERE o.project_id::text = $1", [projectOf(b)]);
    assert.ok(row !== undefined && row.order_state === "AWAITING_TRANSFER", "the issuance committed (AWAITING_TRANSFER)");
    assert.equal((await bw.iw.w.journal(key))?.state, "COMMITTED", "the journal entry is COMMITTED");
    const live = await issueCall();
    assert.equal(code(live), "201 SUCCESS -", "a live session's replay answers the stored response");
    assert.equal(completed<IssuedView>(live, 201).data.transfer.reference, row.reference, "the stored reference");
    // the revocation commits while the replay stands at its journal reservation (after its authentication, before its session judgment)
    const label = `h7-journal-${++heldSeq}`;
    const atJournal = ctx.points.pause(`db.${label}.after`);
    const rc = await open();
    let replay: Reply;
    try {
      const running = settle(ctx.operation("replay held at its journal reservation", () => on(ctx, rc, issueCall, [{ label, match: /INSERT INTO kauro\.command_journal/ }])));
      await atJournal.reachedBy(running.then(() => undefined));
      await ctx.revoked("session revoked through the product before the replay's session judgment", async () => {
        const done = await revokeThroughProduct(session);
        assert.equal(done.status, 204, `the revocation commits (${code(done)})`);
      });
      atJournal.release();
      replay = ok(await running);
    } finally {
      await rc.end();
    }
    assert.equal(code(replay), "401 AUTHENTICATION_REQUIRED -", "the replay after the revocation is refused");
    assert.ok(!replay.text.includes(row.reference), "no stored reference in the refused replay");
    const next = await nextRefused(ctx, "next replay", issueCall);
    assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", "the next replay is refused too");
  });
  });
});

// --- S1: surviving holder controls --------------------------------------------------------------------------------------------------------

interface SurvivingRequest {
  readonly session: BrowserSession;
  readonly request: () => Promise<Reply>;
  readonly next: () => Promise<Reply>;
  readonly success: string;
  readonly committed: () => Promise<void>;
}
interface SurvivingPath {
  readonly path: "I3" | "getBankRoute" | "issuance" | "verify";
  readonly row: string;
  readonly prepare: (label: string) => Promise<SurvivingRequest>;
  /** I3 holds at its final effect-clock read; the others before the COMMIT that follows their last effect-clock read. */
  readonly atEffectRead: boolean;
}
const SURVIVING: ReadonlyArray<SurvivingPath> = [
  {
    path: "I3",
    row: "ACH-M-I3-RACE",
    atEffectRead: true,
    prepare: async (label) => {
      const x = await issuedOrder(label);
      const session = await bw.iw.w.identity().signIn(x.b.a.billing);
      const request = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.instructions(x.orderId), agency: x.b.a.s.agency.agencyId });
      return { session, request, next: request, success: "200 SUCCESS -", committed: async () => undefined };
    },
  },
  {
    path: "getBankRoute",
    row: "ACH-M-R2-RACE",
    atEffectRead: false,
    prepare: async (label) => {
      const r = await configured(label);
      const session = await bw.iw.w.identity().signIn(bw.iw.owner);
      const request = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.get(r.routeId), origin: null });
      return { session, request, next: request, success: "200 SUCCESS -", committed: async () => undefined };
    },
  },
  {
    path: "issuance",
    row: "ACH-M-I2-RACE",
    atEffectRead: false,
    prepare: async (label) => {
      const b = await buyer(label);
      const r = await enabled(label, [b.a.s.agency.agencyId]);
      const session = await bw.iw.w.identity().signIn(b.a.billing);
      const request = (): Promise<Reply> => browserCall(session, { url: bankRoutes.order(b.quote.quote.quoteId), body: issueBody(b, r), agency: b.a.s.agency.agencyId });
      return {
        session,
        request,
        next: request,
        success: "201 SUCCESS -",
        committed: async () => assert.deepEqual(await issuedFootprint(projectOf(b)), { orders: 1, instructions: 1, accepted: 1, events: ISSUED_EVENTS }, "issuance: the order and its instructions committed"),
      };
    },
  },
  {
    path: "verify",
    row: "ACH-M-R2-RACE",
    atEffectRead: false,
    prepare: async (label) => {
      const x = await AT_COMMIT[0]!.prepare(label);
      const session = await bw.iw.w.identity().signIn(bw.iw.owner);
      const request = (): Promise<Reply> => browserCall(session, { url: x.url, body: x.body });
      const next = (): Promise<Reply> => browserCall(session, { method: "GET", url: bankRoutes.get(x.r.routeId), origin: null });
      return { session, request, next, success: "200 SUCCESS -", committed: async () => assert.equal((await routeRow(x.r.routeId)).state, "VERIFIED", "verify: the route committed VERIFIED") };
    },
  },
];

for (const p of SURVIVING) {
  advCell(`PV1R-07 r4 OK (surviving session-lock holder, ${p.path}): held at the same point without a termination, a revocation started during the hold waits (WAITING) until the effect commits, the effect is served or committed, then the revocation commits and the next request is refused 401`, p.row, "revocation", async (ctx) => {
    await onSessions(async () => {
      const hold = p.atEffectRead ? i3EffectRead() : commitOf(await statementPlan((await p.prepare(`pv1r07r4-s1-${p.path}-plan`)).request));
      const x = await p.prepare(`pv1r07r4-s1-${p.path}`);
      const conn = await open();
      let revocation: Promise<PromiseSettledResult<Reply>> | null = null;
      let standing: string | null = null;
      let reply: Reply;
      try {
        const pause = ctx.points.pause(hold.point);
        const running = ctx.operation(`${p.path} held`, () => on(ctx, conn, x.request, hold.steps));
        const settled = settle(running);
        await pause.reachedBy(running);
        revocation = settle(revokeThroughProduct(x.session));
        standing = await revocationStanding(x.session);
        pause.release();
        reply = ok(await settled);
      } finally {
        await conn.end();
      }
      assert.equal(standing, "WAITING", `${p.path}: a revocation started during the hold waits on the session row the effect holds`);
      assert.equal(code(reply), x.success, `${p.path}: the effect, ordered before the revocation, is served or committed`);
      await x.committed();
      await ctx.revoked(`${p.path}: the revocation commits once the effect released the row`, async () => {
        const done = ok(await revocation!);
        assert.equal(done.status, 204, `${p.path}: the revocation commits after the effect (${code(done)})`);
      });
      const next = await nextRefused(ctx, `${p.path}: next request`, x.next);
      assert.equal(code(next), "401 AUTHENTICATION_REQUIRED -", `${p.path}: the next request is refused`);
    });
  });
}
