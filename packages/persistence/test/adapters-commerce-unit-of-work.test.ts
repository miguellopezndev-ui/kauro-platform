// The commerce unit of work on real PostgreSQL 17 through the runtime logins (package B09, implementation mandate M1; design §2, §3.2,
// §3.3, §7, D-CTX-B1, D-CTX-B2, D-SCOPE-B1, D-JOURNAL-B1, D-INSP-B1): scope adoption by the payment service and the corporate owner,
// the finance scope's invisibility without an ACTIVE KAURO_OWNER grant, the journal's UNCERTAIN path and the events' causation, the
// SQLSTATE translation of the commerce constraints, and the queries behind B06's inspectors.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  SQLSTATE,
  commerceReplayOf,
  commercialInspectionsOf,
  createCommerceUnitOfWorkFactory,
  failureOfSqlState,
  type PgCommerceUnitOfWork,
} from "../src/index.js";
import {
  providerScopeKey,
  type CaptureId,
  type CausationId,
  type ClientId,
  type CommercialAuthorizationId,
  type IdempotencyIdentity,
  type JournalEntryId,
  type PaymentOrderId,
  type PlanId,
  type ProjectId,
  type QuoteId,
  type RefundId,
  type UnitOfWork,
  type UserId,
} from "@kauro/domain";
import { clock, ids, sha } from "../src/testing/harness.js";
import { closeCommerceEnv, failure, openCommerceEnv, paid, quoted, type CommerceEnv } from "./commerce-adapter-support.js";
import { ENVIRONMENT, PROVIDER, createdOrder, observedCapture, requestRefund } from "./commerce-support.js";
import { project } from "./support.js";

let env: CommerceEnv;

before(async () => {
  env = await openCommerceEnv("uow");
});
after(async () => {
  await closeCommerceEnv(env);
});

const integrity = (e: unknown): boolean => failure(e).code === "INTEGRITY_FAILURE";

test("adoptScope: a SERVICE unit of work binds the one agency of a stored operation and reads none of its rows before; an unknown key answers null and adopts nothing; one adoption per unit of work, by a SERVICE or OPERATOR context only; the factory runs each context on its runtime group's pool", async () => {
  const { h, A, B } = env;
  const quote = await quoted(env, A, "adopt");
  const order = await createdOrder(env.app, A, quote, env.routes, { payment: env.payment });
  const quoteOfB = await quoted(env, B, "adopt-b");
  const orderId = order.orderId as PaymentOrderId;
  const seen = await h.commerce.run(h.service(), async (uow) => {
    const before = { scope: uow.commerceScope, order: await uow.commerce.orders.get(orderId) };
    const unknown = await uow.adoptScope("PAYMENT_ORDER", ids.next());
    const stillNone = uow.commerceScope;
    const adopted = await uow.adoptScope("PAYMENT_ORDER", order.orderId);
    const after = { scope: uow.commerceScope, order: await uow.commerce.orders.get(orderId), foreignQuote: await uow.commerce.quotes.get(quoteOfB.quoteId as QuoteId) };
    await assert.rejects(uow.adoptScope("PAYMENT_ORDER", order.orderId), integrity, "a second adoption");
    await assert.rejects(uow.adoptFinanceScope(A.agencyId), integrity, "a SERVICE context has no finance scope");
    return { before, unknown, stillNone, adopted, after };
  });
  assert.deepEqual([seen.before.scope, seen.before.order, seen.unknown, seen.stillNone], [null, null, null, null]);
  assert.equal(seen.adopted, A.agencyId);
  assert.equal(seen.after.scope, A.agencyId);
  assert.equal(seen.after.order?.state, "CREATED");
  assert.equal(seen.after.foreignQuote, null, "the adopted agency's rows only");
  // the provider identity the order learned resolves to the same agency (D-SCOPE-B2)
  const byProvider = await h.commerce.run(h.service(), (uow) => uow.adoptScope("PROVIDER_ORDER", providerScopeKey(PROVIDER, ENVIRONMENT, order.providerOrderId)));
  assert.equal(byProvider, A.agencyId);
  // a TENANT context is scoped by its own agency and adopts nothing
  await h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), async (uow) => {
    assert.equal(uow.commerceScope, A.agencyId);
    await assert.rejects(uow.adoptScope("PAYMENT_ORDER", order.orderId), integrity);
    await assert.rejects(uow.adoptFinanceScope(A.agencyId), integrity);
  });
  // an OPERATOR adopts once: never adoptFinanceScope after adoptScope, nor twice
  await h.commerce.run(h.operator(env.kora), async (uow) => {
    await uow.adoptFinanceScope(A.agencyId);
    assert.equal(uow.commerceScope, A.agencyId);
    await assert.rejects(uow.adoptFinanceScope(B.agencyId), integrity);
    await assert.rejects(uow.adoptScope("REFUND", ids.next()), integrity);
  });
  // SERVICE runs on kauro_payment, TENANT and OPERATOR on kauro_app: a factory without the payment pool refuses a SERVICE context
  const appOnly = createCommerceUnitOfWorkFactory({ app: h.appPool }, { clock });
  await assert.rejects(appOnly.run(h.service(), async () => undefined), integrity);
  const paymentOnly = createCommerceUnitOfWorkFactory({ payment: h.paymentPool }, { clock });
  await assert.rejects(paymentOnly.run(h.tenant(A.agencyId, A.ownerUserId), async () => undefined), integrity);
  assert.equal(await paymentOnly.run(h.service(), (uow) => uow.adoptScope("PAYMENT_ORDER", order.orderId)), A.agencyId);
});

test("finance scope: an OPERATOR without an ACTIVE KAURO_OWNER grant resolves no refund and reads none of the agency's commerce rows even after naming the agency; with the grant it adopts the refund's agency and reads its commerce rows, never its customer rows; once the grant is revoked they are invisible again", async () => {
  const { h, A } = env;
  const sale = await paid(env, A, "finance-scope");
  const refundId = (await requestRefund(env.app, A, sale.order, sale.captureId, { serviceCents: 1000, taxCents: 0 })) as RefundId;
  const olga = await h.person("olga-finance");
  const readAll = (userId: UserId, adopt: "REFUND" | "NAMED") =>
    h.commerce.run(h.operator(userId), async (uow) => {
      const adopted = adopt === "REFUND" ? await uow.adoptScope("REFUND", refundId) : (await uow.adoptFinanceScope(A.agencyId), A.agencyId);
      return {
        adopted,
        grant: await uow.commerce.corporateGrants.activeGrant(userId, "KAURO_OWNER"),
        refund: await uow.commerce.refunds.get(refundId),
        capture: await uow.commerce.captures.get(sale.captureId as CaptureId),
        quote: await uow.commerce.quotes.get(sale.order.quote.quoteId as QuoteId),
        project: await uow.projects.get(sale.order.quote.projectId as ProjectId),
        client: await uow.endClients.get(env.clients.get(A.agencyId)! as ClientId),
      };
    });
  const withoutGrant = await readAll(olga, "REFUND");
  assert.deepEqual(withoutGrant, { adopted: null, grant: null, refund: null, capture: null, quote: null, project: null, client: null });
  const named = await readAll(olga, "NAMED");
  assert.deepEqual([named.refund, named.capture, named.quote], [null, null, null], "naming the agency grants nothing by itself");
  const grantId = await h.grantKauroOwner(olga);
  const withGrant = await readAll(olga, "REFUND");
  assert.equal(withGrant.adopted, A.agencyId);
  assert.equal(withGrant.grant?.state, "ACTIVE");
  assert.equal(withGrant.refund?.state, "REQUESTED");
  assert.equal(withGrant.capture?.status, "COMPLETED");
  assert.equal(withGrant.quote?.state, "ACCEPTED_FOR_CHECKOUT");
  assert.deepEqual([withGrant.project, withGrant.client], [null, null], "the agency's customer rows are never in the finance scope");
  await h.revokeCorporateGrant(grantId);
  const revoked = await readAll(olga, "NAMED");
  assert.deepEqual([revoked.grant, revoked.refund, revoked.capture, revoked.quote], [null, null, null, null]);
  // a finance scope adopted in one unit of work does not reach the next one (bindContext clears kauro.finance_agency_id)
  const next = await h.commerce.run(h.operator(env.kora), (uow) => uow.commerce.refunds.get(refundId));
  assert.equal(next, null);
});

test("the command journal of a provider effect: RESERVED -> UNCERTAIN (and UNCERTAIN again, idempotently), a resume finds it PENDING and commits it from UNCERTAIN, after which it is final; the events a unit of work publishes are caused by the entry it reserved or resumed, or by the causation its caller names", async () => {
  const { h, A } = env;
  const quote = await quoted(env, A, "journal");
  const identity: IdempotencyIdentity = { environment: "LOCAL", actor: { kind: "USER", userId: A.ownerUserId }, agencyId: A.agencyId, operation: "CMD028", key: `k_journal_${ids.next().replace(/-/g, "")}` };
  const digest = sha("journal-request");
  const first = await h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), async (uow) => {
    const r = await uow.journal.reserve(identity, digest, uow.context.correlationId);
    assert.equal(r.kind, "RESERVED");
    const entryId = (r as { entryId: JournalEntryId }).entryId;
    const accepted = await uow.commerce.quotes.transition(quote.quoteId as QuoteId, 2, { state: "ACCEPTED_FOR_CHECKOUT" }, clock.now());
    assert.equal(accepted.kind, "APPLIED");
    await uow.journal.markUncertain(entryId);
    await uow.journal.markUncertain(entryId);
    return { entryId, causation: uow.events.appended.map((e) => e.causationId) };
  });
  assert.deepEqual(first.causation, [first.entryId], "the acceptance is caused by the entry it reserved");
  const resumed = await h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), async (uow) => {
    const r = await uow.journal.reserve(identity, digest, uow.context.correlationId);
    assert.equal(r.kind, "PENDING");
    assert.equal(r.kind === "PENDING" ? r.entry.state : null, "UNCERTAIN");
    const withdrawn = await uow.commerce.quotes.transition(quote.quoteId as QuoteId, 3, { state: "WITHDRAWN" }, clock.now());
    assert.equal(withdrawn.kind, "APPLIED");
    const committed = await uow.journal.commit(first.entryId, { responseStatus: 201, responseBody: { quoteId: quote.quoteId }, resourceKind: "quote", resourceId: quote.quoteId });
    return { committed: committed.state, causation: uow.events.appended.map((e) => e.causationId) };
  });
  assert.equal(resumed.committed, "COMMITTED");
  assert.deepEqual(resumed.causation, [first.entryId], "a resume's events are caused by the entry it resumed");
  await assert.rejects(h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), (uow) => uow.journal.markUncertain(first.entryId)), integrity, "a committed entry is final");
  const replay = await h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), (uow) => uow.journal.reserve(identity, digest, uow.context.correlationId));
  assert.equal(replay.kind, "REPLAY");
  // the payment service names the causation of what it applies (a consumer's source event, an inbox record)
  const sale = await paid(env, A, "journal-causation");
  const causation = ids.next() as CausationId;
  const revoked = await h.commerce.run(h.service(), async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", sale.order.orderId);
    (uow as PgCommerceUnitOfWork).causedBy(causation);
    const r = await uow.commerce.authorizations.transition(sale.authorizationId as CommercialAuthorizationId, 1, { state: "REVOKED", revocation: { at: clock.now(), phase: "PRE_EXECUTION", code: "OPERATOR_REVOKED" } }, clock.now());
    assert.equal(r.kind, "APPLIED");
    return uow.events.appended.map((e) => ({ causation: e.causationId, actor: e.actor }));
  });
  assert.deepEqual(revoked, [{ causation, actor: { kind: "SERVICE", serviceId: "payment-service" } }]);
});

test("SQLSTATE translation of the commerce constraints: a second open checkout is PAYMENT_PENDING CREATION_IN_PROGRESS (retryable), a second open request of a capture and origin PRECONDITION_FAILED REFUND_REQUEST_OPEN, the KP class as the design names it, the second revision's checks and binding keys INTEGRITY_FAILURE rather than INVALID_REQUEST, and the handler's replay constraints named for it", async () => {
  const expected: ReadonlyArray<readonly [string, string, string | undefined]> = [
    ["KP001", "INTEGRITY_FAILURE", "LEDGER_UNBALANCED"],
    ["KP002", "INTEGRITY_FAILURE", "OBLIGATION_OVER_ALLOCATED"],
    ["KP003", "PRECONDITION_FAILED", "REFUND_EXCEEDS_REMAINING"],
    ["KP004", "INTEGRITY_FAILURE", "AUTHORITY_WITHOUT_CAPTURE"],
    ["KP005", "INTEGRITY_FAILURE", "FACT_REGRESSION"],
    ["KP006", "INTEGRITY_FAILURE", "AUTHORITY_OUTLIVES_REVERSAL"],
    ["KP007", "NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"],
    ["KP008", "NOT_AUTHORIZED", "SELF_APPROVAL_FORBIDDEN"],
    ["KP009", "INTEGRITY_FAILURE", "COMMITMENT_ISOLATION"],
    ["KP010", "ASSURANCE_REQUIRED", "POLICY_NOT_APPLICABLE"],
    ["KP011", "INTEGRITY_FAILURE", "FISCAL_VALIDATION_REFUSED"],
    ["KP012", "PRECONDITION_FAILED", "REFUND_TAX_INCONSISTENT"],
    ["KP013", "PRECONDITION_FAILED", "REPLACEMENT_NOT_ALLOWED"],
  ];
  for (const [code, failureCode, reason] of expected) {
    const f = failureOfSqlState(code);
    assert.deepEqual([f?.code, f?.details.reason], [failureCode, reason], code);
  }
  const checks = ["payment_attempts_dispatch_deadline_bound", "fiscal_profiles_supersession_lineage", "ledger_entries_funds_accounts", "ledger_entries_bank_accounts"];
  const keys = ["fiscal_profiles_successor_fk", "provider_observations_attempt_fk", "capture_facts_attempt_fk", "provider_event_exceptions_attempt_fk", "reconciliation_cases_capture_order_fk", "reconciliation_cases_refund_order_fk", "reconciliation_cases_refund_capture_fk", "reconciliation_cases_refund_own_capture_fk"];
  for (const c of checks) assert.equal(failureOfSqlState(SQLSTATE.CHECK_VIOLATION, c)?.code, "INTEGRITY_FAILURE", c);
  for (const c of keys) assert.equal(failureOfSqlState(SQLSTATE.FOREIGN_KEY_VIOLATION, c)?.code, "INTEGRITY_FAILURE", c);
  // B06's own translation is unchanged: another check is a request error, another key an unknown reference
  assert.equal(failureOfSqlState(SQLSTATE.CHECK_VIOLATION, "quotes_discount_arithmetic")?.code, "INVALID_REQUEST");
  assert.deepEqual([failureOfSqlState(SQLSTATE.FOREIGN_KEY_VIOLATION, "quotes_fiscal_fk")?.code, failureOfSqlState(SQLSTATE.FOREIGN_KEY_VIOLATION, "quotes_fiscal_fk")?.details.reason], ["INVALID_REQUEST", "UNKNOWN_REFERENCE"]);
  assert.deepEqual(failureOfSqlState(SQLSTATE.UNIQUE_VIOLATION, "domain_events_capture_completed_once")?.code, "INTEGRITY_FAILURE");
  for (const c of ["commercial_authorizations_one_per_quote", "commercial_authorizations_one_live_per_capture", "commercial_authorizations_one_live_per_project", "commercial_authorizations_one_original_per_capture", "commercial_authorizations_one_per_rebinding"]) {
    assert.equal(failureOfSqlState(SQLSTATE.UNIQUE_VIOLATION, c), null, `${c} is the handler's to decide`);
    assert.equal(commerceReplayOf(SQLSTATE.UNIQUE_VIOLATION, c), "AUTHORIZATION_REPLAY");
  }
  assert.equal(commerceReplayOf(SQLSTATE.UNIQUE_VIOLATION, "capture_facts_provider_identity"), "DUPLICATE_CAPTURE");
  assert.equal(commerceReplayOf(SQLSTATE.CHECK_VIOLATION, "capture_facts_provider_identity"), null);

  // live: a second open checkout of the project (a concurrent CreatePaymentOrder under another key) and a second customer request
  const { h, A } = env;
  const quote = await quoted(env, A, "translate");
  const open = await createdOrder(env.app, A, quote, env.routes);
  await assert.rejects(
    h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), async (uow) => {
      const r = await uow.journal.reserve({ environment: "LOCAL", actor: { kind: "USER", userId: A.ownerUserId }, agencyId: A.agencyId, operation: "CMD028", key: `k_second_${ids.next().replace(/-/g, "")}` }, sha("second"), uow.context.correlationId);
      if (r.kind !== "RESERVED") throw new Error("not reserved");
      await uow.commerce.orders.insert({
        orderId: ids.next() as PaymentOrderId,
        agencyId: A.agencyId,
        projectId: quote.projectId as ProjectId,
        quoteId: quote.quoteId as QuoteId,
        approvalId: quote.subject.approvalId as never,
        route: { routeId: env.routes.routeId as never, provider: PROVIDER, environment: ENVIRONMENT, merchantRef: env.routes.merchantRef as never, payeeDigest: env.routes.payeeDigest, currency: "USD" },
        expectedAmountCents: BigInt(quote.totalCents),
        expectedServiceCents: BigInt(quote.serviceCents),
        expectedTaxCents: BigInt(quote.taxCents),
        termsHash: quote.termsHash,
        idempotencyHash: sha("second-intent"),
        createdByMembershipId: A.ownerMembershipId,
        intentEntryId: r.entryId,
        createdAt: clock.now(),
      });
    }),
    (e: unknown) => failure(e).code === "PAYMENT_PENDING" && failure(e).details.reason === "CREATION_IN_PROGRESS" && failure(e).retryable,
  );
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.payment_orders WHERE project_id = $1", [quote.projectId])).rows[0].n, 1, `only ${open.orderId}`);
  const sale = await paid(env, A, "translate-refund");
  await requestRefund(env.app, A, sale.order, sale.captureId, { serviceCents: 1000, taxCents: 0 });
  await assert.rejects(
    h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), (uow) =>
      uow.commerce.refunds.request({
        refundId: ids.next() as RefundId,
        agencyId: A.agencyId,
        projectId: sale.order.quote.projectId as ProjectId,
        orderId: sale.order.orderId as PaymentOrderId,
        captureId: sale.captureId as CaptureId,
        origin: "CUSTOMER_REQUEST",
        reasonCode: "Client asked again",
        termsHash: sale.order.quote.termsHash,
        deliveryPhase: "PRE_EXECUTION",
        proposed: { serviceCents: 1n, taxCents: 0n, excessCents: 0n },
        requestedByMembershipId: A.ownerMembershipId,
        requestedByUserId: A.ownerUserId,
        requestedAt: clock.now(),
      }),
    ),
    (e: unknown) => failure(e).code === "PRECONDITION_FAILED" && failure(e).details.reason === "REFUND_REQUEST_OPEN",
  );
});

test("the queries behind B06's inspectors: a plan's live quotes, open orders and live authorizations are its unreconciled commercial consequences, a client's live authorizations are counted, and a revoked authorization is reconciled; they read a unit of work of this package only", async () => {
  const { h, A } = env;
  const clientC = (await h.endClient(A, await h.processingAuthority(A), "Client C")) as ClientId;
  const quote = await quoted(env, A, "inspect", clientC);
  const planId = quote.subject.planId as PlanId;
  const inspect = () =>
    h.app.run(h.tenant(A.agencyId, A.ownerUserId), async (uow) => ({
      consequences: await commercialInspectionsOf(uow).unreconciledForPlan(planId),
      live: await commercialInspectionsOf(uow).liveAuthorizationsOfClient(clientC),
    }));
  assert.deepEqual(await inspect(), { consequences: [{ kind: "QUOTE", referenceId: quote.quoteId }], live: 0 });
  const order = await createdOrder(env.app, A, quote, env.routes, { payment: env.payment });
  assert.deepEqual((await inspect()).consequences, [
    { kind: "PAYMENT_ORDER", referenceId: order.orderId },
    { kind: "QUOTE", referenceId: quote.quoteId },
  ]);
  const done = await observedCapture(env.payment, A, order, env.routes, { amountCents: quote.totalCents, serviceCents: quote.serviceCents, taxCents: quote.taxCents, excessCents: 0 }, env.hubspot);
  assert.deepEqual(await inspect(), {
    consequences: [
      { kind: "COMMERCIAL_AUTHORIZATION", referenceId: done.authorizationId },
      { kind: "QUOTE", referenceId: quote.quoteId },
    ],
    live: 1,
  });
  // another client's authorizations and another plan's facts are not counted
  const other = await paid(env, A, "inspect-other");
  assert.equal((await inspect()).live, 1);
  assert.ok(!(await inspect()).consequences.some((c) => c.referenceId === other.authorizationId));
  await h.commerce.run(h.service(), async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", order.orderId);
    const r = await uow.commerce.authorizations.transition(done.authorizationId as CommercialAuthorizationId, 1, { state: "REVOKED", revocation: { at: clock.now(), phase: "PRE_EXECUTION", code: "OPERATOR_REVOKED" } }, clock.now());
    assert.equal(r.kind, "APPLIED");
  });
  assert.deepEqual(await inspect(), { consequences: [{ kind: "QUOTE", referenceId: quote.quoteId }], live: 0 });
  // the commerce unit of work is a unit of work of this package too; anything else is refused
  assert.deepEqual(await h.commerce.run(h.tenant(A.agencyId, A.ownerUserId), (uow) => commercialInspectionsOf(uow).liveAuthorizationsOfClient(clientC)), 0);
  assert.throws(() => commercialInspectionsOf({} as UnitOfWork), integrity);
});
