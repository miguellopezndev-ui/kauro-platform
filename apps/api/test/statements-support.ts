/**
 * The world of the statement and payout tests (package B10, mandate B10-STATEMENTS-PAYOUTS; docs/design/B10-case-map.md rows citing
 * cmd051-close-commission-period, cmd052-approve-commission-payout, cmd053-reconcile-commission-payout and commission-statement-reads; design
 * §7, §10, §13). One api serves every route — B06's, the request side and the payment service's of B09 (payment-support paymentWorld with
 * requestSide), the B10 commands and the commission group's service routes — over a real PostgreSQL 17 the test starts itself, with the
 * people of the B06 world. The commission service runs over its own verified pools (openCommissionPools: a login of kauro_commission and
 * one of kauro_control); the service routes run CMD051 and CMD053 in units of work of those pools that a test stands at a chosen instant on
 * the labelled TEST CLOCK (never behind the real one, so every row a test wrote stands before the close it makes). The labelled contract
 * fakes of BankingCalendarSource and PayoutEvidenceVerifier (CONTRACT_FAKE, SIMULATED; D10-FAKE-1) and of PreparationCompletionSource are
 * injected, as no deployment binds them; B09's provider and service-identity fakes are the payment world's, reused.
 *
 * Ledger rows are written by the runtime roles that own them through the stage-2 fixtures of @kauro/persistence/testing (sellers, prospects,
 * claims, conversions, accrued and eligible lines, holds) and the commission-support purchases (B09's quote, checkout and the payment
 * service's reconciliation of a provider-fake capture); the allocation is the owner's, at the rates a test names. The superuser only reads,
 * except where commission-support's synthetic price schedule needs it (said there). Nothing sleeps.
 */
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { BANKING_CALENDAR_FIXTURE_NONBANKING, ContractFakeBankingCalendar, ContractFakePayoutEvidence, ContractFakePreparationCompletion } from "@kauro/application/testing";
import { correctCommissionStatement, type CommandResult, type StatementCorrectionView, type StatementServiceHold, type StatementServiceRuntime } from "@kauro/application";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CorrelationId, ExecutionContext, SettlementId, UserId } from "@kauro/domain";
import { registryCommissionPolicy, registryPricePolicy } from "@kauro/domain";
import { PgCommercialUnitOfWork, PgCommercialUnitOfWorkFactory, ledgerOf, statementsOf } from "@kauro/persistence";
import { ROLES, TEST_CLOCK_OFFSET_SETTING, recordAccruedLine, recordActiveSeller, recordClaim, recordConversion, recordEligibleLine, recordProspect, type RecordedSeller, type SellerTerms } from "@kauro/persistence/testing";
import { proposeCommissionClose } from "@kauro/application";
import { COMMISSION_APPLICATION_NAME, createCommissionService, createPeriodsSweep, openCommissionPools, statementServiceRuntime, type CommissionPools, type CommissionService } from "../src/index.js";
import { CommissionHolds, approvedPlan, captureOf, checkoutOf, purchase, recordSyntheticSchedule, sellingAgency, statedQuote, type CommissionWorld, type Purchase, type Selling } from "./commission-support.js";
import { FaultRouting } from "./fault-support.js";
import { paymentWorld, serviceToken, type PaymentWorld } from "./payment-support.js";
import { call, clock, freshKey, ids, movableClock, sha, type Person, type Reply, type World, type WorldOptions } from "./support.js";

export { COMMISSION_APPLICATION_NAME };

// --- the commission service's units of work on the labelled TEST CLOCK -----------------------------------------------------------

class StandingUnitOfWork extends PgCommercialUnitOfWork {
  /** Stands this transaction's TEST CLOCK at `at`, or `seconds` ahead of its transaction time; never behind it (D10-CLOCK-1). */
  async stand(position: { readonly at: string } | { readonly seconds: number }): Promise<void> {
    if ("at" in position) {
      await this.client.query(`SELECT set_config('${TEST_CLOCK_OFFSET_SETTING}', greatest(0, extract(epoch FROM ($1::timestamptz - transaction_timestamp())))::text, true)`, [position.at]);
    } else {
      await this.client.query("SELECT set_config($1, $2, true)", [TEST_CLOCK_OFFSET_SETTING, String(position.seconds)]);
    }
  }
}

/**
 * B10's commercial unit-of-work factory over the commission service's pools whose SERVICE units of work stand where `position()` says:
 * at an instant (never behind the real clock), a number of seconds ahead (or behind: how the PERIODS sweep stands in a past month), or
 * at the real clock (null).
 */
export class StandingUnits extends PgCommercialUnitOfWorkFactory {
  readonly #position: () => { readonly at: string } | { readonly seconds: number } | null;

  constructor(pools: CommissionPools["pools"], position: () => { readonly at: string } | { readonly seconds: number } | null) {
    super({ commission: pools.commission, control: pools.control }, { clock, random: (n) => new Uint8Array(randomBytes(n)) });
    this.#position = position;
  }

  protected override createUnitOfWork(client: ConstructorParameters<typeof PgCommercialUnitOfWork>[0], context: ConstructorParameters<typeof PgCommercialUnitOfWork>[1], idsOf: ConstructorParameters<typeof PgCommercialUnitOfWork>[2], clockOf: ConstructorParameters<typeof PgCommercialUnitOfWork>[3]): PgCommercialUnitOfWork {
    return new StandingUnitOfWork(client, context, idsOf, clockOf, [registryPricePolicy()]);
  }

  override run<T>(context: ExecutionContext, work: (uow: PgCommercialUnitOfWork) => Promise<T>, options?: Parameters<PgCommercialUnitOfWorkFactory["run"]>[2]): Promise<T> {
    return super.run(
      context,
      async (uow) => {
        const position = this.#position();
        if (context.kind === "SERVICE" && position !== null) await (uow as StandingUnitOfWork).stand(position);
        return work(uow);
      },
      options,
    );
  }
}

// --- hold points of the service commands --------------------------------------------------------------------------------------------

/** A simulated crash at a service command's hold point: the unit of work rolls back and the route answers 500. */
export class ServiceCrash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
    this.name = "ServiceCrash";
  }
}

export class ServiceHolds {
  readonly #armed = new Map<string, { readonly reached: () => void; readonly release: Promise<void>; readonly fail: Error | null }>();

  /** Pauses (or crashes) the next run of `command` that reaches its point before COMMIT. */
  arm(command: "CMD051" | "CMD053", options: { readonly fail?: Error } = {}): { readonly reached: Promise<void>; release(): void } {
    if (this.#armed.has(command)) throw new Error(`hold ${command} is already armed`);
    let reachedResolve: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = options.fail !== undefined ? Promise.resolve() : new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    this.#armed.set(command, { reached: reachedResolve, release, fail: options.fail ?? null });
    return { reached, release: () => releaseResolve() };
  }

  readonly hook: StatementServiceHold = async (command) => {
    const armed = this.#armed.get(command);
    if (armed === undefined) return;
    this.#armed.delete(command);
    armed.reached();
    if (armed.fail !== null) throw armed.fail;
    await armed.release;
  };
}

// --- the world ---------------------------------------------------------------------------------------------------------------------

/** The controlled calendar of example 21 over 2026 to 2030: weekends and 2026-10-12 nonbanking (TEST_FIXTURE, never a feed). */
export const FIXTURE_CALENDAR = Object.freeze({ calendarVersion: "test-fixture-2026-2030", coversFrom: "2026-01-01", coversTo: "2030-12-31" });

export interface StatementsWorld extends CommissionWorld {
  /** The one api of every route, with the people of the B06 world. */
  readonly w: World;
  readonly calendar: ContractFakeBankingCalendar;
  readonly payouts: ContractFakePayoutEvidence;
  readonly serviceHolds: ServiceHolds;
  /** Routes a command's real unit of work over a connection of the common fault harness (the B10 failure cells; test/fault-support.ts). */
  readonly faults: FaultRouting;
  /** The commission group's service runtime over the fault-routed, test-clock units: how a correction (CMD051, no route) runs (D10-GAP-7). */
  readonly statementRuntime: StatementServiceRuntime;
  /** A corporate person with an ACTIVE KAURO_OWNER grant and a bearer token (CMD052, the reads). */
  readonly owner: Person;
  /** Stands the service routes' units of work at `at` on the TEST CLOCK (never behind the real clock); null: the real clock. */
  standAt(at: string | null): void;
  /** The PERIODS sweep over the commission service standing `seconds` from now (negative: in the past) or at the real clock. */
  periods(seconds?: number): ReturnType<typeof createPeriodsSweep>;
}

export async function statementsWorld(options: { readonly commercial?: WorldOptions["commercial"] } = {}): Promise<StatementsWorld> {
  const calendar = new ContractFakeBankingCalendar({ clock });
  const now = clock.now();
  calendar.serve({ calendarVersion: FIXTURE_CALENDAR.calendarVersion, jurisdiction: "CO", source: "TEST_FIXTURE", nonbankingDates: [...BANKING_CALENDAR_FIXTURE_NONBANKING], coversFrom: FIXTURE_CALENDAR.coversFrom, coversTo: FIXTURE_CALENDAR.coversTo, recordedAt: new Date(Date.parse(now) - 3_600_000).toISOString() as UtcInstant, evidenceHash: sha("fixture") as Sha256Hex });
  const payouts = new ContractFakePayoutEvidence({ clock });
  const serviceHolds = new ServiceHolds();
  const faults = new FaultRouting();
  let standing: string | null = null;
  const opened: { pools: CommissionPools | null } = { pools: null };
  const pw: PaymentWorld = await paymentWorld({
    requestSide: true,
    wrapUnitOfWork: (inner) => faults.wrap(inner),
    ...(options.commercial !== undefined ? { commercial: options.commercial } : {}),
    commissions: async (h) => {
      const base = { host: "127.0.0.1", port: h.pg.port, database: ROLES.database } as const;
      const pools = await openCommissionPools({ commission: { ...base, user: ROLES.commissionLogin, poolMax: 4 }, control: { ...base, user: ROLES.controlLogin, poolMax: 2 } }, { clock, random: (n) => new Uint8Array(randomBytes(n)) });
      opened.pools = pools;
      const units = new StandingUnits(pools.pools, () => (standing === null ? null : { at: standing }));
      return { binding: { units: faults.wrap(units), calendar, payoutEvidence: { integrationClass: payouts.integrationClass, verify: (r) => (faults.verifier === null ? payouts.verify(r) : (faults.verifier(r, (x) => payouts.verify(x)) as ReturnType<typeof payouts.verify>)) }, hold: serviceHolds.hook }, close: () => pools.close() };
    },
  });
  faults.stand = () => (standing === null ? null : { at: standing });
  const pools = opened.pools;
  if (pools === null) throw new Error("the commission pools were not opened by the api's assembly");
  const statementRuntime = statementServiceRuntime({ units: faults.wrap(new StandingUnits(pools.pools, () => (standing === null ? null : { at: standing }))), calendar }, "LOCAL", clock);
  const { w } = pw;
  const h = w.h;
  const dispatcherClock = movableClock();
  const completions = new ContractFakePreparationCompletion({ clock });
  const holds = new CommissionHolds();
  const backgroundFailures: Array<{ correlationId: string; error: unknown }> = [];
  const serviceOf = (units: PgCommercialUnitOfWorkFactory): CommissionService =>
    createCommissionService({ assembly: { units, completions, hold: (point) => holds.hook(point) }, environment: "LOCAL", clock: dispatcherClock, ids, periods: { calendar, hold: serviceHolds.hook }, onBackgroundFailure: (correlationId, error) => backgroundFailures.push({ correlationId, error }) });
  const service = serviceOf(pools.units);
  const owner = await w.person("statements-owner");
  await h.grantKauroOwner(owner.userId);
  return {
    pw,
    h,
    w,
    pools,
    service,
    clock: dispatcherClock,
    completions,
    holds,
    backgroundFailures,
    ahead: (seconds) => serviceOf(new StandingUnits(pools.pools, () => ({ seconds }))),
    kora: owner.userId as UserId,
    owner,
    calendar,
    payouts,
    serviceHolds,
    faults,
    statementRuntime,
    standAt(at) {
      standing = at;
    },
    periods(seconds) {
      const runtime = (seconds === undefined ? service : serviceOf(new StandingUnits(pools.pools, () => ({ seconds })))).runtime;
      return createPeriodsSweep(runtime, { calendar, hold: serviceHolds.hook });
    },
    async stop() {
      await pw.stop();
    },
  };
}

// --- routes --------------------------------------------------------------------------------------------------------------------------

export const routes = {
  close: (periodId: string) => `/api/v1/sales/commission-periods/${periodId}/close`,
  approve: (statementId: string) => `/api/v1/sales/statements/${statementId}/approve-payout`,
  reconcile: (statementId: string) => `/api/v1/sales/statements/${statementId}/reconcile-payout`,
  statement: (statementId: string) => `/api/v1/sales/statements/${statementId}`,
};

/** A bearer token of the commission group's services (minted by B09's service-authenticator fake). */
export function commissionToken(sw: StatementsWorld, serviceId: "commission-service" | "finance-service" | "payment-service" = "commission-service", environment: "LOCAL" | "LIVE" = "LOCAL"): string {
  return serviceToken(sw.pw, { serviceId, environment });
}

export function closePeriod(sw: StatementsWorld, periodId: string, body: unknown, options: { readonly token?: string | null; readonly key?: string } = {}): Promise<Reply> {
  return call(sw.w, { url: routes.close(periodId), agency: null, token: options.token === undefined ? commissionToken(sw) : options.token, key: options.key ?? freshKey("cmd051"), body });
}

/** CMD051's correction of a statement as the commission service (no route: D10-GAP-7), journaled under `key`. */
export function correctStatement(sw: StatementsWorld, statementId: string, body: { readonly expectedVersion: number }, options: { readonly key?: string } = {}): Promise<CommandResult<StatementCorrectionView>> {
  return correctCommissionStatement(sw.statementRuntime, {
    correlationId: ids.next() as CorrelationId,
    idempotencyKey: options.key ?? freshKey("cmd051-correct"),
    identity: { serviceId: "commission-service", audience: "kauro-api", environment: "LOCAL" },
    path: { statementId },
    body,
  });
}

/** The outcome of a service command as the cells assert it: "200", or "<status> <code> <reason>". */
export function resultOf(r: CommandResult<unknown>): string {
  if (r.kind === "COMPLETED") return String(r.status);
  if (r.kind === "ACCEPTED") return "202";
  return `${r.problem.status} ${r.problem.code} ${r.problem.reason ?? "-"}`;
}

export function approvePayout(sw: StatementsWorld, statementId: string, body: unknown, options: { readonly token?: string; readonly key?: string } = {}): Promise<Reply> {
  return call(sw.w, { url: routes.approve(statementId), agency: null, token: options.token ?? sw.owner.token, key: options.key ?? freshKey("cmd052"), body });
}

export function reconcilePayout(sw: StatementsWorld, statementId: string, body: unknown, options: { readonly token?: string | null; readonly key?: string } = {}): Promise<Reply> {
  return call(sw.w, { url: routes.reconcile(statementId), agency: null, token: options.token === undefined ? commissionToken(sw, "finance-service") : options.token, key: options.key ?? freshKey("cmd053"), body });
}

export function readStatement(sw: StatementsWorld, statementId: string, token: string): Promise<Reply> {
  return call(sw.w, { method: "GET", url: routes.statement(statementId), agency: null, token, key: null, contentType: null });
}

// --- periods ---------------------------------------------------------------------------------------------------------------------

/** The commission service's SERVICE context (no agency adopted: periods and statements are corporate). */
export function commissionContext(): ExecutionContext {
  return { kind: "SERVICE", serviceId: "commission-service", correlationId: ids.next() as CorrelationId };
}

/** Opens the period of a month (YYYY-MM) as the PERIODS sweep does, standing in that month on the TEST CLOCK; answers its id. */
export async function openMonth(sw: StatementsWorld, month: string): Promise<string> {
  const middle = Date.parse(`${month}-15T17:00:00Z`);
  const report = await sw.periods(Math.round((middle - Date.now()) / 1000)).run({ limit: 0 });
  const outcome = report.items.find((i) => i.subject === "OPEN")?.outcome ?? "";
  if (!outcome.endsWith(month)) throw new Error(`the PERIODS sweep did not open ${month}: ${outcome}`);
  return periodIdOf(sw, month);
}

export async function periodIdOf(sw: StatementsWorld, month: string): Promise<string> {
  const r = await sw.h.oracle.query<{ period_id: string }>("SELECT period_id FROM kauro.commission_periods WHERE period_month = ($1 || '-01')::date", [month]);
  if (r.rows[0] === undefined) throw new Error(`no period of ${month}`);
  return r.rows[0].period_id;
}

/**
 * Opens a month's period (2026, January to September), and closes it through the CMD051 route with the proposal of the ledger as it
 * stands, the close standing on 2026-10-07 at noon in Bogota (or at the real clock, when that is later): every month of the fixture's
 * 2026 is due by then.
 */
export async function closeMonth(sw: StatementsWorld, month: string): Promise<{ readonly periodId: string; readonly reply: Reply }> {
  const periodId = await openMonth(sw, month);
  const ledgerCutoffHash = await proposal(sw, periodId);
  sw.standAt("2026-10-07T17:00:00Z");
  try {
    return { periodId, reply: await closePeriod(sw, periodId, { ledgerCutoffHash }) };
  } finally {
    sw.standAt(null);
  }
}

/** The close the commission service would propose now (KAURO_COMMISSION_CUTOFF_V1 of the ledger as it stands; D10-STMT-4). */
export function proposal(sw: StatementsWorld, periodId: string): Promise<string> {
  return sw.pools.units.run(commissionContext(), async (uow) => {
    const period = await statementsOf(uow).getPeriod(periodId as never);
    if (period === null) throw new Error("the period is not readable by the commission service");
    const exact = await uow.serverInstant();
    return (await proposeCommissionClose(statementsOf(uow), period, `${exact.slice(0, 23)}Z` as UtcInstant)).ledgerCutoffHash;
  });
}

// --- sellers, attribution and ledger lines ---------------------------------------------------------------------------------------

/** Runs a statement block as kauro_app under an OPERATOR session of `userId` (its person bound, no agency). */
export async function asPerson<T>(sw: StatementsWorld, userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await sw.h.pg.connect("kauro_app_test");
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await client.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [userId]);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    await client.end();
  }
}

/** An ACTIVE seller with a bearer token of its own person (its statements' reader), under the agreement terms given. */
export async function seller(sw: StatementsWorld, subject: string, terms: SellerTerms = {}): Promise<RecordedSeller & { readonly person: Person }> {
  const person = await sw.w.person(`seller-${subject}`);
  const recorded = await recordActiveSeller(sw.h, { ownerUserId: sw.owner.userId as UserId, subject, terms });
  if (recorded.userId !== person.userId) throw new Error("the seller is not the person its token names");
  return { ...recorded, person };
}

/** A selling agency acquired by `s`: its prospect, the seller's claim and the owner's frozen allocation at the rates given (CMD045..CMD047 writes). */
export async function acquired(sw: StatementsWorld, label: string, s: RecordedSeller, rates: { readonly firstBps: number; readonly repeatBps: number }): Promise<{ readonly selling: Selling; readonly allocationId: string }> {
  // people and their tokens are named by a slug (a bearer token carries no space)
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const selling = await sellingAgency(sw, slug);
  const prospect = await recordProspect(sw.h, { by: s, domain: `${slug}.example` });
  const { claimId } = await recordClaim(sw.h, { seller: s, prospectId: prospect.prospectId });
  const allocationId = ids.next();
  await asPerson(sw, sw.owner.userId, async (c) => {
    await c.query(
      `INSERT INTO kauro.attribution_allocations (allocation_id, agency_id, prospect_id, identity_evidence_hash, ruling_reason, ruling_evidence_hash, first_bps, repeat_bps, recurring_months, prepared_by_user_id, prepared_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Qualified discovery and first meaningful contact by the claimant', $5, $6, $7, 12, $8, kauro.server_now(), now(), now())`,
      [allocationId, selling.agency.agencyId, prospect.prospectId, sha(`identity-${allocationId}`), sha(`ruling-${allocationId}`), rates.firstBps, rates.repeatBps, sw.owner.userId],
    );
    await c.query(
      `INSERT INTO kauro.allocation_shares (allocation_id, seller_id, claim_id, prospect_id, agreement_id, agreement_version, share_bps, first_bps, repeat_bps, recurring_months, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 10000, $7, $8, 12, now())`,
      [allocationId, s.sellerId, claimId, prospect.prospectId, s.agreementId, s.agreementVersion, rates.firstBps, rates.repeatBps],
    );
    await c.query("UPDATE kauro.attribution_allocations SET frozen_at = kauro.server_now(), frozen_by_user_id = $2, version = version + 1 WHERE allocation_id = $1", [allocationId, sw.owner.userId]);
    await c.query(
      `UPDATE kauro.attribution_claims SET state = 'ACCEPTED', agency_id = $2, allocation_id = $3, accepted_at = kauro.server_now(), expires_at = kauro.server_now() + interval '2160 hours', decided_by_user_id = $4, version = version + 1 WHERE claim_id = $1`,
      [claimId, selling.agency.agencyId, allocationId, sw.owner.userId],
    );
  });
  return { selling, allocationId };
}

/** An acquisition's paid purchases with the seller's line on each, at the rates and integer cents the test states. */
export interface SoldLine {
  readonly purchase: Purchase;
  readonly lineId: string;
}

/** A line a test states: its basis and pool in integer cents, and where it stands (ELIGIBLE by default). */
export interface LineSpec {
  readonly basisCents: bigint;
  readonly poolCents: bigint;
  /** The purchase's service at a stated price (a synthetic schedule): absent, B09's fixture quote (97,125 service). */
  readonly serviceCents?: bigint;
  /** ELIGIBLE (FINAL completion 720 hours ago, funds AVAILABLE), ACCRUED (no FINAL completion) or AWAITING_FUNDS (FINAL, no funds observed). */
  readonly state?: "ELIGIBLE" | "ACCRUED" | "AWAITING_FUNDS";
}

const SYNTHETIC = "STATEMENTS-SYNTHETIC";
let syntheticRecorded = false;

/** A purchase of the agency at a stated service (no tax: a reviewed exempt export), B09's quote adapter under a synthetic schedule. */
async function statedPurchase(sw: StatementsWorld, s: Selling, label: string, serviceCents: bigint): Promise<Purchase> {
  if (!syntheticRecorded) {
    await recordSyntheticSchedule(sw, SYNTHETIC);
    syntheticRecorded = true;
  }
  const quote = await statedQuote(sw, s, await approvedPlan(sw, s, label), { policyVersion: SYNTHETIC, serviceCents, tax: { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 }, taxCents: 0n });
  return captureOf(sw, s, await checkoutOf(sw, s, quote));
}

/**
 * The seller's lines on paid purchases of one acquired agency: the first purchase converts the claim (the COMMISSIONS consumer's
 * conversion), and each purchase accrues one ACQUISITION pool whose single line the test states in integer cents (pool = basis at the
 * allocation's rate, rounded once — the caller writes the example's cents). An ELIGIBLE line is made so 720 hours after its FINAL
 * completion with its funds AVAILABLE (@kauro/persistence/testing recordEligibleLine); an ACCRUED one has no FINAL completion; an
 * AWAITING_FUNDS one has its FINAL completion recorded by the commission service and no funds observed.
 */
export async function eligibleLines(
  sw: StatementsWorld,
  label: string,
  s: RecordedSeller,
  rates: { readonly firstBps: number; readonly repeatBps: number },
  lines: ReadonlyArray<LineSpec>,
): Promise<{ readonly selling: Selling; readonly allocationId: string; readonly entitlementId: string; readonly lines: ReadonlyArray<SoldLine> }> {
  const { selling, allocationId } = await acquired(sw, label, s, rates);
  const sold: SoldLine[] = [];
  let entitlementId = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const tag = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}`;
    const p = line.serviceCents === undefined ? await purchase(sw, selling, tag) : await statedPurchase(sw, selling, tag, line.serviceCents);
    if (i === 0) entitlementId = (await recordConversion(sw.h, { agencyId: selling.agency.agencyId, allocationId })).get(s.sellerId)!.entitlementId;
    const input = {
      agencyId: selling.agency.agencyId,
      authorizationId: p.authorizationId,
      captureId: p.captureId,
      allocationId,
      entitlementId,
      sellerId: s.sellerId,
      rateKind: i === 0 ? ("FIRST" as const) : ("REPEAT" as const),
      rateBps: i === 0 ? rates.firstBps : rates.repeatBps,
      basisCents: line.basisCents,
      poolCents: line.poolCents,
    };
    const state = line.state ?? "ELIGIBLE";
    const recorded = state === "ELIGIBLE" ? await recordEligibleLine(sw.h, input) : await recordAccruedLine(sw.h, input);
    if (state === "AWAITING_FUNDS") {
      await sw.pools.units.run(commissionContext(), async (uow) => {
        await uow.adoptAgency(selling.agency.agencyId);
        await ledgerOf(uow).recordCompletion({
          completionId: ids.next() as never,
          purchaseId: p.authorizationId as never,
          agencyId: selling.agency.agencyId,
          kind: "FINAL",
          completedAt: new Date(Date.now() - 60_000).toISOString() as UtcInstant,
          evidenceHash: sha(`final-${p.authorizationId}`),
          source: "AUTHORIZATION_DELIVERY",
          recordedAt: `${(await uow.serverInstant()).slice(0, 23)}Z` as UtcInstant,
        });
      });
    }
    sold.push({ purchase: p, lineId: recorded.lineId });
  }
  return { selling, allocationId, entitlementId, lines: sold };
}

// --- payouts -------------------------------------------------------------------------------------------------------------------------

let observed = 0;
let lastObservedAt = 0;

/**
 * A settlement observation of the payment service with bank evidence: the bank-available cash CMD052 reads (B09 settlements). It is
 * observed at the database's own clock (strictly after the previous one), never in the future: a SETTLED intent keeps claiming its cash
 * until an observation strictly newer than its settlement is recorded (B10G-R3), so a future-dated observation would release it early.
 */
export async function bankCash(sw: StatementsWorld, bankAvailableCents: bigint, units: { run: typeof sw.pw.pools.commerce.run } = sw.pw.pools.commerce): Promise<void> {
  observed += 1;
  const dbNow = (await sw.h.oracle.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at.getTime();
  lastObservedAt = Math.max(dbNow, lastObservedAt + 1);
  const at = new Date(lastObservedAt).toISOString() as UtcInstant;
  await units.run({ kind: "SERVICE", serviceId: "payment-service", correlationId: ids.next() as CorrelationId }, (uow) =>
    uow.commerce.settlements.record({
      settlementId: uow.ids.next() as SettlementId,
      routeId: sw.pw.route.routeId,
      providerBalanceRef: uow.ids.next(),
      currency: "USD",
      grossCents: bankAvailableCents,
      feeCents: 0n,
      heldCents: 0n,
      withdrawnCents: bankAvailableCents,
      bankAvailableCents,
      bankEvidenceHash: sha(`bank-statement-${observed}`),
      periodStart: new Date(Date.parse(at) - 86_400_000).toISOString() as UtcInstant,
      periodEnd: at,
      observedAt: at,
      evidenceHash: sha(`settlement-${observed}`),
    } as never),
  );
}

/** The cents unsettled authorized intents already claim once a newer bank observation lands (the superuser oracle): a SETTLED intent is then shown by the bank cash itself. */
export async function claimedCents(sw: StatementsWorld): Promise<bigint> {
  const r = await sw.h.oracle.query<{ cents: string }>("SELECT coalesce(sum(amount_cents), 0)::text AS cents FROM kauro.payout_intents WHERE state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN')");
  return BigInt(r.rows[0]!.cents);
}

/** The seller's own change of its payout destination with its own step-up: a new version PENDING_VERIFICATION. */
export async function changeDestination(sw: StatementsWorld, s: RecordedSeller): Promise<{ readonly destinationId: string; readonly destinationDigest: string; readonly destinationVersion: number }> {
  const proof = await sw.h.recordStepUp(s.userId);
  const destinationId = ids.next();
  const destinationDigest = sha(`destination-${destinationId}`);
  const destinationVersion = await asPerson(sw, s.userId, async (c) => {
    const v = (await c.query<{ v: number }>("SELECT coalesce(max(destination_version), 0)::int + 1 AS v FROM kauro.seller_payout_destinations WHERE seller_id = $1", [s.sellerId])).rows[0]!.v;
    await c.query(
      `INSERT INTO kauro.seller_payout_destinations (destination_id, seller_id, destination_version, masked_label, destination_digest, currency, changed_by_user_id, change_proof_ref, changed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7, kauro.server_now(), now(), now())`,
      [destinationId, s.sellerId, v, `Bank ****${destinationId.slice(-4)}`, destinationDigest, s.userId, proof],
    );
    return v;
  });
  return { destinationId, destinationDigest, destinationVersion };
}

/** The owner verifies a changed destination 172800 s after the change (the TEST CLOCK stands there) and supersedes the one it replaces. */
export async function verifyDestination(sw: StatementsWorld, destinationId: string, supersedes: string): Promise<void> {
  await asPerson(sw, sw.owner.userId, async (c) => {
    await c.query(
      "SELECT set_config('kauro_test.clock_offset_seconds', (extract(epoch FROM (x.at - transaction_timestamp())) + 172800)::text, true) FROM (SELECT changed_at AS at FROM kauro.seller_payout_destinations WHERE destination_id = $1) x",
      [destinationId],
    );
    await c.query("UPDATE kauro.seller_payout_destinations SET state = 'SUPERSEDED', superseded_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [supersedes]);
    await c.query("UPDATE kauro.seller_payout_destinations SET state = 'VERIFIED', verified_by_user_id = $2, verified_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [destinationId, sw.owner.userId]);
  });
}

/** The intent of a statement as the stored row has it (the superuser oracle): the facts a payout fake's evidence names. */
export async function intentOf(sw: StatementsWorld, statementId: string): Promise<{ intentId: string; state: string; amount: bigint; reference: string; destinationDigest: Sha256Hex; destinationVersion: number; destinationId: string; feeBearer: string; currency: string }> {
  const r = await sw.h.oracle.query<{ intent_id: string; state: string; amount_cents: string; reference: string; destination_digest: string; destination_version: number; destination_id: string; fee_bearer: string; currency: string }>(
    "SELECT intent_id, state, amount_cents::text, reference, destination_digest, destination_version, destination_id, fee_bearer, currency FROM kauro.payout_intents WHERE statement_id = $1 ORDER BY authorized_at DESC LIMIT 1",
    [statementId],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("the statement has no intent");
  return { intentId: row.intent_id, state: row.state, amount: BigInt(row.amount_cents), reference: row.reference, destinationDigest: row.destination_digest as Sha256Hex, destinationVersion: row.destination_version, destinationId: row.destination_id, feeBearer: row.fee_bearer, currency: row.currency };
}

/** Scripts the payout fake's evidence for an intent under a fresh stored reference, and answers the reference. */
export function scriptEvidence(sw: StatementsWorld, evidence: ReturnType<ContractFakePayoutEvidence["matching"]>): string {
  const ref = ids.next();
  sw.payouts.script(ref, evidence);
  return ref;
}

// --- oracle reads --------------------------------------------------------------------------------------------------------------------

export async function rows<T extends Record<string, unknown>>(sw: StatementsWorld, sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
  return (await sw.h.oracle.query<T>(sql, [...params])).rows;
}

export async function statementsOfSeller(sw: StatementsWorld, sellerId: string): Promise<Array<{ statement_id: string; period_id: string; state: string; label: string; statement_date: string; pay_date: string; payable_cents: string; held_cents: string; accrued_pending_cents: string; paid_to_date_cents: string; negative_balance_cents: string; version: string; payout_evidence_hash: string | null }>> {
  return rows(
    sw,
    `SELECT statement_id, period_id, state, label, to_char(statement_date, 'YYYY-MM-DD') AS statement_date, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, payable_cents::text, held_cents::text, accrued_pending_cents::text,
            paid_to_date_cents::text, negative_balance_cents::text, version::text, payout_evidence_hash FROM kauro.commission_statements WHERE seller_id = $1 ORDER BY created_at`,
    [sellerId],
  );
}

export async function itemsOf(sw: StatementsWorld, statementId: string): Promise<Array<{ item_no: number; item_kind: string; disposition: string; line_id: string | null; adjustment_id: string | null; held_cents: string; payable_cents: string; hold_reason: string | null; hold_review_at: Date | null }>> {
  return rows(sw, "SELECT item_no, item_kind, disposition, line_id, adjustment_id, held_cents::text, payable_cents::text, hold_reason, hold_review_at FROM kauro.statement_items WHERE statement_id = $1 ORDER BY item_no", [statementId]);
}

export async function lineStates(sw: StatementsWorld, lineIds: ReadonlyArray<string>): Promise<string[]> {
  const r = await rows<{ line_id: string; state: string }>(sw, "SELECT line_id, state FROM kauro.commission_lines WHERE line_id = ANY ($1::uuid[])", [[...lineIds]]);
  return lineIds.map((id) => r.find((x) => x.line_id === id)?.state ?? "MISSING");
}

export async function periodRow(sw: StatementsWorld, periodId: string): Promise<{ state: string; version: string; close_due_on: string | null; pay_due_on: string | null; calendar_source: string | null; cutoff_hash: string | null }> {
  return (await rows<{ state: string; version: string; close_due_on: string | null; pay_due_on: string | null; calendar_source: string | null; cutoff_hash: string | null }>(
    sw,
    "SELECT state, version::text, to_char(close_due_on, 'YYYY-MM-DD') AS close_due_on, to_char(pay_due_on, 'YYYY-MM-DD') AS pay_due_on, calendar_source, cutoff_hash FROM kauro.commission_periods WHERE period_id = $1",
    [periodId],
  ))[0]!;
}

/** The registry commission policy's zone (America/Bogota). */
export const ZONE = registryCommissionPolicy().operationalTimeZone;

export { ledgerOf, statementsOf, freshKey };
