// The fixtures behind the bank-transfer test seams of the Payments V1 lanes (KIT-2; docs/design/ACH-ROUTE.md r12). They contain no
// business logic of L-INBOUND or L-REFUND: a purchase "paid by bank transfer" is made through the REAL route commands (configure, verify,
// enable, CMD028 with routeKind BANK_TRANSFER) and then given the capture an applied exact credit would give it, written the way
// commission-support.ts captureOf writes a provider capture (the payment service's unit of work), plus the credit row of migration 0054.
// When L-INBOUND's applier exists, a lane replaces `applyExactCredit` by the product path; every caller keeps its signature.
//
// One `BankFixtures` serves two hosts: the integration world (bankWorld: S1..S7) and the commission world (IN1: `cw.bank`).
import assert from "node:assert/strict";
import { BANK_FAKE_PROVIDER, fakeCreditBytes, fakeOutboundBytes, type BankEvidenceFake, type ContractFakeBuyerTypeReader, type FakeCreditFields } from "@kauro/application/testing";
import type { PaymentEnvironment } from "@kauro/domain";
import type { Sha256Hex } from "@kauro/contracts";
import { createPaymentDispatcher, leaseResourceOf, type PaymentDispatcher } from "../src/index.js";
import { planOf, quoted, type Agent, type IntegrationWorld } from "./integration-support.js";
import { approvedPlan, captureOf, fixtureQuote, quoteFactsOf, type CommissionWorld, type Purchase, type Selling } from "./commission-support.js";
import { paymentRoutes } from "./commerce-support.js";
import { call, completed, freshKey, ids, type Person, type Reply, type World } from "./support.js";

export { ROUTE_TIMING, TEST_FINGERPRINT_KEY, testDestinationFingerprinter } from "./bank-constants-support.js";

// --- the host -----------------------------------------------------------------------------------------------------------------------

export interface BankHost {
  /** The world the purchase is made in (an IntegrationWorld or a CommissionWorld whose api serves the request side). */
  readonly cw: CommissionWorld;
  readonly w: World;
  /** A corporate person with an ACTIVE KAURO_OWNER grant (route commands, refunds). */
  readonly owner: Person;
  readonly evidence: BankEvidenceFake;
  readonly accountRef: string;
  readonly environment: PaymentEnvironment;
  readonly payeeDigest: Sha256Hex;
  readonly buyers: ContractFakeBuyerTypeReader;
}

export interface CreditVersion {
  readonly bankCreditId: string;
  readonly bankTransactionId: string;
  readonly kind: "REVERSAL" | "FUNDS";
  readonly reversedCents?: bigint;
  readonly fundsState?: "HELD" | "AVAILABLE";
  readonly artifactRef: string;
  readonly evidenceHash: string;
}

export interface LaneRoute {
  readonly routeId: string;
  readonly paymentRouteId: string;
  readonly accountRef: string;
}

interface RouteView {
  readonly routeId: string;
  readonly routeVersion: number;
  readonly state: string;
}

const OPS = "/api/v1/operations/bank-routes";
/** The approved destination of the manual-rail refund fixtures (021000021 passes the ABA check). */
const REFUND_DESTINATION = Object.freeze({ routingNumber: "021000021", accountNumber: "12341234", holderName: "Alice Smith" });
let artifactSeq = 0;

export class BankFixtures {
  /**
   * The entry point of L-INBOUND that takes an authenticated later VERSION of a credit (a reversal: G6; a funds observation: the credit's
   * fundsState). The lane binds it; unbound, S5 and `fundsOf` refuse loudly after storing the version, so no cell passes on a no-op.
   */
  creditVersionConsumer: ((v: CreditVersion) => Promise<Reply | void>) | undefined;
  private route: (LaneRoute & { state: "VERIFIED" | "ENABLED"; version: number }) | undefined;
  private readonly participants = new Set<string>();

  constructor(private readonly host: BankHost) {}

  private get oracle() {
    return this.host.cw.h.oracle;
  }

  private ownerCall(url: string, body: unknown): Promise<Reply> {
    return call(this.host.w, { url, agency: null, token: this.host.owner.token, key: freshKey("kit-bank-route"), body });
  }

  // --- the lane route: configure, verify, enable through the owner commands ---------------------------------------------------------------

  /** The one route of the host's account, qualified through the real owner commands; `agencyId` is admitted to its CONTROLLED rollout. */
  async ensureRoute(agencyId?: string): Promise<LaneRoute> {
    const { host } = this;
    if (this.route === undefined) {
      const details = {
        accountRef: host.accountRef,
        detailsVersion: `details-kit-${++artifactSeq}`,
        currency: "USD",
        acceptedRails: ["ACH", "DOMESTIC_WIRE"],
        beneficiaryName: "Kauro Test Beneficiary",
        bankName: "Contract Fake Bank",
        routingNumber: "026073150",
        accountNumber: "000000000000",
        accountType: "CHECKING",
        payeeDigest: host.payeeDigest,
        additionalFields: {},
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      };
      const { artifactRef, sha256 } = await host.evidence.put({ bytes: new TextEncoder().encode(JSON.stringify({ format: "contract-fake-bank-evidence/1", kind: "ACCOUNT_DETAILS", accountRef: host.accountRef, details })), accountRef: host.accountRef as never });
      const configured = completed<{ route: RouteView }>(
        await this.ownerCall(OPS, {
          provider: BANK_FAKE_PROVIDER,
          environment: host.environment,
          accountRef: host.accountRef,
          currency: "USD",
          acceptedRails: ["ACH", "DOMESTIC_WIRE"],
          detailsArtifactRef: artifactRef,
          detailsEvidenceHash: sha256,
          minimumTransferWindowMs: 4 * 86_400_000,
          instructionLifetimeMs: 10 * 86_400_000,
          providerTimeToleranceMs: 86_400_000,
          feePolicyVersion: "bank-fee-v1",
          timingSource: { url: "https://wise.com/help/articles/2827506", accessedOn: "2026-10-07" },
        }),
        201,
      ).data.route;
      const verified = completed<{ route: RouteView }>(
        await this.ownerCall(`${OPS}/${configured.routeId}/verify`, { expectedVersion: configured.routeVersion, verificationEvidenceRef: `kyc-review-${configured.routeId}`, authorizationRef: await host.w.stepUp(host.owner) }),
        200,
      ).data.route;
      const [row] = (await this.oracle.query<{ payment_route_id: string }>("SELECT payment_route_id::text FROM kauro.bank_routes WHERE route_id = $1", [verified.routeId])).rows;
      this.route = { routeId: verified.routeId, paymentRouteId: row!.payment_route_id, accountRef: host.accountRef, state: "VERIFIED", version: verified.routeVersion };
    }
    if (agencyId !== undefined && !this.participants.has(agencyId)) {
      this.participants.add(agencyId);
      if (this.route.state === "VERIFIED") {
        const enabled = completed<{ route: RouteView }>(
          await this.ownerCall(`${OPS}/${this.route.routeId}/enable`, { expectedVersion: this.route.version, rollout: "CONTROLLED", participants: [...this.participants], authorizationRef: await host.w.stepUp(host.owner) }),
          200,
        ).data.route;
        assert.equal(enabled.state, "ENABLED");
        this.route = { ...this.route, state: "ENABLED", version: enabled.routeVersion };
      } else {
        // another agency of the same CONTROLLED allowlist in force: appended to its set, as a re-enable would append it (rows are never deleted)
        await this.oracle.query(
          "INSERT INTO kauro.bank_route_participants (route_id, set_version, agency_id) SELECT route_id, participants_version, $2 FROM kauro.bank_routes WHERE route_id = $1 ON CONFLICT DO NOTHING",
          [this.route.routeId, agencyId],
        );
      }
    }
    return this.route;
  }

  // --- credits ----------------------------------------------------------------------------------------------------------------------------

  private storeCredit(fields: FakeCreditFields): Promise<{ artifactRef: string; evidenceHash: Sha256Hex }> {
    return this.host.evidence.put({ bytes: fakeCreditBytes(this.host.accountRef, fields) }).then((r) => ({ artifactRef: r.artifactRef, evidenceHash: r.sha256 }));
  }

  /** An unassigned credit of `cents` in RETURN_REVIEW with a REQUESTED treasury refund of its whole gross (S2). */
  async unassignedCredit(cents: bigint, label: string): Promise<{ bankCreditId: string; treasuryRefundId: string }> {
    const { host } = this;
    const route = await this.ensureRoute();
    const bankTransactionId = `btx-${label.replace(/[^A-Za-z0-9-]/g, "-")}-${ids.next().slice(-12)}`;
    const observedAt = new Date().toISOString();
    const stored = await this.storeCredit({ creditId: bankTransactionId, rail: "ACH", currency: "USD", grossCents: cents, netCents: cents, feeCents: 0n, payeeDigest: host.payeeDigest, payerEvidenceRef: `payer-${label}`, payerDigest: "c".repeat(64) as Sha256Hex, status: "COMPLETED", bookedAt: observedAt, observedAt });
    const bankCreditId = ids.next();
    const treasuryRefundId = ids.next();
    await this.oracle.query(
      `INSERT INTO kauro.bank_credits (bank_credit_id, environment, account_ref, bank_transaction_id, state, rail, currency, gross_cents, net_cents, fee_cents, booked_at, evidence_hash)
       VALUES ($1, $2, $3, $4, 'RETURN_REVIEW', 'ACH', 'USD', $5, $5, 0, $6, $7)`,
      [bankCreditId, host.environment, host.accountRef, bankTransactionId, cents.toString(), observedAt, stored.evidenceHash],
    );
    await this.oracle.query("INSERT INTO kauro.treasury_refunds (treasury_refund_id, route_id, environment, account_ref, bank_credit_id, amount_cents) VALUES ($1, $2, $3, $4, $5, $6)", [treasuryRefundId, route.routeId, host.environment, host.accountRef, bankCreditId, cents.toString()]);
    return { bankCreditId, treasuryRefundId };
  }

  /** An authenticated reversal version of a credit (by credit id or by the capture it paid), handed to the bound L-INBOUND consumer (S5). */
  async reverseCredit(creditOrCaptureId: string, cents: bigint): Promise<Reply | void> {
    const { host } = this;
    const rows = (await this.oracle.query<{ bank_credit_id: string; bank_transaction_id: string; gross_cents: string }>("SELECT bank_credit_id::text, bank_transaction_id, gross_cents::text FROM kauro.bank_credits WHERE bank_credit_id::text = $1 OR capture_id::text = $1", [creditOrCaptureId])).rows;
    assert.equal(rows.length, 1, `reverseCredit: exactly one credit for ${creditOrCaptureId}`);
    const credit = rows[0]!;
    const observedAt = new Date().toISOString();
    const stored = await this.storeCredit({ creditId: credit.bank_transaction_id, rail: "ACH", currency: "USD", grossCents: BigInt(credit.gross_cents), payeeDigest: host.payeeDigest, status: "REVERSED", reversedCents: cents, observedAt });
    return this.deliver({ bankCreditId: credit.bank_credit_id, bankTransactionId: credit.bank_transaction_id, kind: "REVERSAL", reversedCents: cents, artifactRef: stored.artifactRef, evidenceHash: stored.evidenceHash }, "S5");
  }

  private async deliver(v: CreditVersion, seam: string): Promise<Reply | void> {
    if (this.creditVersionConsumer === undefined) throw new Error(`SEAM ${seam} not bound: the ${v.kind} version ${v.artifactRef} of credit ${v.bankCreditId} is stored but no inbound consumer is bound; L-INBOUND sets creditVersionConsumer`);
    return this.creditVersionConsumer(v);
  }

  /** The funds observation of the credit that paid a capture: an authenticated credit version carrying fundsState (IN1). */
  async fundsOf(captureId: string, fundsState: "HELD" | "AVAILABLE"): Promise<Reply | void> {
    const { host } = this;
    const rows = (await this.oracle.query<{ bank_credit_id: string; bank_transaction_id: string; gross_cents: string }>("SELECT bank_credit_id::text, bank_transaction_id, gross_cents::text FROM kauro.bank_credits WHERE capture_id::text = $1", [captureId])).rows;
    assert.equal(rows.length, 1, `fundsOf: exactly one credit paid capture ${captureId}`);
    const credit = rows[0]!;
    const observedAt = new Date().toISOString();
    const stored = await this.storeCredit({ creditId: credit.bank_transaction_id, rail: "ACH", currency: "USD", grossCents: BigInt(credit.gross_cents), payeeDigest: host.payeeDigest, status: "COMPLETED", fundsState, observedAt });
    return this.deliver({ bankCreditId: credit.bank_credit_id, bankTransactionId: credit.bank_transaction_id, kind: "FUNDS", fundsState, artifactRef: stored.artifactRef, evidenceHash: stored.evidenceHash }, "IN1");
  }

  // --- a purchase paid by bank transfer (S1, IN1) -----------------------------------------------------------------------------------------

  /**
   * The order issued by the REAL CMD028 (routeKind BANK_TRANSFER) of a quote of the agency, then paid by one exact applied credit: the
   * credit row (APPLIED, order and capture), the capture COMPLETED, the order CAPTURED, the original authorization.
   */
  async paidByBankTransfer(s: Selling, billingToken: string, quote: { readonly quoteId: string; readonly termsHash: string }): Promise<Purchase> {
    const { host } = this;
    const route = await this.ensureRoute(s.agency.agencyId);
    const issued = completed<{ order: { orderId: string }; transfer: { reference: string } }>(
      await call(host.w, { url: `/api/v1/quotes/${quote.quoteId}/payment-orders`, token: billingToken, agency: s.agency.agencyId, key: freshKey("kit-bank-issue"), body: { termsHash: quote.termsHash, routeKind: "BANK_TRANSFER", routeId: route.routeId } }),
      201,
    ).data;
    const orderId = issued.order.orderId;
    const facts = await quoteFactsOf(host.cw, s, quote.quoteId as never);
    const [bound] = (await this.oracle.query<{ provider: string; environment: "SANDBOX" | "LIVE"; merchant_ref: string; payee_digest: Sha256Hex }>("SELECT provider, environment, merchant_ref, payee_digest FROM kauro.payment_orders WHERE order_id = $1", [orderId])).rows;
    const bankTransactionId = `btx-${orderId.slice(-12)}-${++artifactSeq}`;
    const observedAt = new Date().toISOString();
    const stored = await this.storeCredit({ creditId: bankTransactionId, rail: "ACH", currency: "USD", grossCents: facts.totalCents, netCents: facts.totalCents, feeCents: 0n, payeeDigest: host.payeeDigest, reference: issued.transfer.reference, status: "COMPLETED", bookedAt: observedAt, observedAt });
    const purchase = await captureOf(
      host.cw,
      s,
      { agencyId: s.agency.agencyId, quote: facts, orderId: orderId as never, attemptId: "" as never, providerOrderId: `bank:${orderId}` },
      { bank: { route: { provider: bound!.provider, environment: bound!.environment, merchantRef: bound!.merchant_ref, payeeDigest: bound!.payee_digest }, providerCaptureId: bankTransactionId } },
    );
    await this.oracle.query(
      `INSERT INTO kauro.bank_credits (bank_credit_id, environment, account_ref, bank_transaction_id, state, rail, currency, gross_cents, net_cents, fee_cents, reference, booked_at, evidence_hash, order_id, capture_id)
       VALUES ($1, $2, $3, $4, 'APPLIED', 'ACH', 'USD', $5, $5, 0, $6, $7, $8, $9, $10)`,
      [ids.next(), host.environment, host.accountRef, bankTransactionId, facts.totalCents.toString(), issued.transfer.reference, observedAt, stored.evidenceHash, orderId, purchase.captureId],
    );
    await this.oracle.query("UPDATE kauro.bank_transfer_instructions SET order_state = 'CAPTURED' WHERE order_id = $1", [orderId]);
    return purchase;
  }

  // --- a refund through the manual rail (IN1: L-REFUND's F2 + X1 + G2 over the lane's route contract) --------------------------------------

  /**
   * CMD031 as the agency's member, CMD032 with the destination (F2), X1 DeclareRefundExecution and G2 RecordExecution with the send receipt,
   * the HTTP contract of apps/api/test/refund-lane-support.ts on origin/pv1/refund. Answers the refund id once it is COMPLETED.
   */
  async refundedByManualRail(s: Selling, p: Purchase, serviceCents: bigint, taxCents: bigint): Promise<string> {
    const { host } = this;
    const as = (token: string, agency: string | null) => ({ token, agency });
    const requested = completed<{ refund: { refundId: string } }>(
      await call(host.w, { url: paymentRoutes.requestRefund(p.projectId), ...as(s.owner.token, s.agency.agencyId), key: freshKey("kit-refund-request"), body: { reasonCode: "The client cancelled before execution", evidenceRef: ids.next() } }),
      201,
    ).data.refund.refundId;
    const evidence = await this.storeCredit({ creditId: `dest-${requested.slice(-12)}`, currency: "USD", payeeDigest: "b".repeat(64) as Sha256Hex, grossCents: 1n, payerEvidenceRef: "payer-kit", payerDigest: "c".repeat(64) as Sha256Hex, status: "COMPLETED", observedAt: new Date().toISOString() });
    const approved = await call(host.w, {
      url: paymentRoutes.approveRefund(requested),
      ...as(host.owner.token, null),
      key: freshKey("kit-refund-approve"),
      body: { expectedVersion: 1, serviceCents: serviceCents.toString(), taxCents: taxCents.toString(), authorizationRef: await host.w.stepUp(host.owner), destination: { ...REFUND_DESTINATION }, destinationEvidence: { artifactRef: evidence.artifactRef, evidenceHash: evidence.evidenceHash } },
    });
    assert.equal(approved.status, 200, `F2 approves the refund of ${p.captureId}: ${approved.text}`);
    const declared = completed<{ attempt: { attemptId: string; amountCents: string; reference: string; declaredAt: string } }>(
      await call(host.w, { url: `/api/v1/operations/refunds/${requested}/execution-declarations`, ...as(host.owner.token, null), key: freshKey("kit-refund-declare"), body: { expectedVersion: 2, amountCents: (serviceCents + taxCents).toString(), authorizationRef: await host.w.stepUp(host.owner) } }),
      201,
    ).data.attempt;
    const declaredMs = Date.parse(declared.declaredAt);
    const receipt = await host.evidence.put({
      bytes: fakeOutboundBytes(host.accountRef, { bankExecutionId: `exec-kit-${declared.attemptId.slice(-12)}`, amountCents: BigInt(declared.amountCents), currency: "USD", reference: declared.reference, executedAt: new Date(declaredMs + 1).toISOString(), destination: { full: { ...REFUND_DESTINATION }, accountLast4: "1234" }, status: "COMPLETED", observedAt: new Date(declaredMs + 2).toISOString() }),
    });
    const recorded = await call(host.w, { url: `/api/v1/operations/execution-attempts/${declared.attemptId}/records`, ...as(host.owner.token, null), key: freshKey("kit-refund-record"), body: { evidence: { artifactRef: receipt.artifactRef, evidenceHash: receipt.sha256 }, authorizationRef: await host.w.stepUp(host.owner) } });
    assert.equal(recorded.status, 200, `G2 records the refund of ${p.captureId}: ${recorded.text}`);
    return requested;
  }

  // --- the recipient record artifact (S4) -------------------------------------------------------------------------------------------------

  async storeRecipientRecord(r: { readonly recipientRef: string; readonly recipientVersion: string; readonly full: { readonly routingNumber: string; readonly accountNumber: string; readonly holderName: string } }): Promise<{ artifactRef: string; evidenceHash: Sha256Hex }> {
    const bytes = new TextEncoder().encode(JSON.stringify({ format: "contract-fake-bank-evidence/1", kind: "RECIPIENT", accountRef: this.host.accountRef, recipient: { recipientRef: r.recipientRef, recipientVersion: r.recipientVersion, full: r.full } }));
    const { artifactRef, sha256 } = await this.host.evidence.put({ bytes });
    return { artifactRef, evidenceHash: sha256 };
  }
}

// --- the stale FINANCE worker (S7) ------------------------------------------------------------------------------------------------------

export interface StaleWorker {
  /** A dispatcher whose pass believes it still holds the FINANCE lease it claimed before the takeover (a worker that resumed late). */
  readonly dispatcher: PaymentDispatcher;
  /** The fence the superseded worker holds, and the one the rival moved the lease to. */
  readonly staleFence: number;
  readonly currentFence: number;
}

/**
 * A FINANCE worker that claimed its lease, was superseded by a rival (owner and fence moved on the lease row), and is then run again with
 * its OLD claim: createPaymentDispatcher with the superseded owner whose claim answers the lease it held. Its pass can only settle through
 * the heartbeat of its old fence, which no longer matches: the dispatcher reports FENCED for what it delivered. Whether anything was posted
 * before that is the product's: the cell asserts the ledger.
 */
export async function staleFinanceWorker(iw: IntegrationWorld): Promise<StaleWorker> {
  const { service } = iw.pw;
  const resourceId = leaseResourceOf("FINANCE");
  const worker = createPaymentDispatcher(service.runtime, service.effects);
  // the worker's real claim (a lease row, its owner and its fence exist afterwards)
  const first = await worker.runOnce("FINANCE", { limit: 1 });
  assert.equal(first.held, false, "the FINANCE lease was free for the worker to claim");
  const oracle = iw.h.oracle;
  const before = (await oracle.query<{ fence: string }>("SELECT fence::text FROM kauro.leases WHERE resource_kind = 'OUTBOX_DISPATCH' AND resource_id = $1 AND owner_id = $2", [resourceId, worker.ownerId])).rows;
  assert.equal(before.length, 1, "the worker holds the FINANCE lease");
  const staleFence = Number(before[0]!.fence);
  const rival = ids.next();
  // the rival's takeover through the lease primitive itself, at an instant past the worker's expiry (the guard admits nothing else)
  const moved = await oracle.query<{ fence: string }>(
    `SELECT (kauro.claim_lease(resource_kind, resource_id, $3::uuid, 60, deadline_at, subject_hash, cost_authority_id, checkpoint_hash, expires_at + interval '1 second')).fence::text AS fence
       FROM kauro.leases WHERE resource_kind = 'OUTBOX_DISPATCH' AND resource_id = $1 AND owner_id = $2`,
    [resourceId, worker.ownerId, rival],
  );
  assert.equal(Number(moved.rows[0]?.fence), staleFence + 1, "the rival took the lease over under the next fence");
  const claimOfOldFence = { kind: "CLAIMED", lease: { resourceKind: "OUTBOX_DISPATCH", resourceId, ownerId: worker.ownerId, fence: staleFence } };
  // the same collaborators, except that the lease claim answers the old one (methods keep their own receiver)
  const over = <T extends object>(target: T, override: Record<string, unknown>): T =>
    new Proxy(target, {
      get(t, name) {
        if (typeof name === "string" && Object.hasOwn(override, name)) return override[name];
        const v: unknown = Reflect.get(t, name, t);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  const real = service.runtime.assembly.commerce;
  const commerce = over(real, {
    run: (ctx: unknown, fn: (uow: object) => Promise<unknown>) => (real.run as (c: unknown, f: unknown) => Promise<unknown>)(ctx, (uow: { leases: object }) => fn(over(uow, { leases: over(uow.leases, { claim: async () => claimOfOldFence }) }))),
  });
  const runtime = { ...service.runtime, assembly: { ...service.runtime.assembly, commerce } } as typeof service.runtime;
  return { dispatcher: createPaymentDispatcher(runtime, service.effects, { ownerId: worker.ownerId }), staleFence, currentFence: Number(moved.rows[0]!.fence) };
}

// --- helpers shared by both hosts -------------------------------------------------------------------------------------------------------

/** The commission world's side of the seam (IN1): a purchase of a Selling agency over the same fixtures the provider rail uses (same cents). */
export async function commissionBankPurchase(fixtures: BankFixtures, cw: CommissionWorld, buyers: ContractFakeBuyerTypeReader, s: Selling, label: string): Promise<Purchase> {
  buyers.set(s.agency.agencyId, "AGENCY");
  const plan = await approvedPlan(cw, s, label);
  const facts = await fixtureQuote(cw, s, plan);
  return fixtures.paidByBankTransfer(s, s.owner.token, { quoteId: facts.quoteId, termsHash: facts.termsHash });
}

/** The integration world's side (S1): the agency's own plan and quote through the public commands, then the same payment. */
export async function integrationBankPurchase(fixtures: BankFixtures, iw: IntegrationWorld, a: Agent, label: string): Promise<Purchase> {
  const plan = await planOf(iw, a, label);
  const q = await quoted(iw, a, plan);
  return fixtures.paidByBankTransfer(a.s, a.billing.token, { quoteId: q.quote.quoteId, termsHash: q.quote.termsHash });
}

