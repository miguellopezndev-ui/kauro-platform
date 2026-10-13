/**
 * The owner's inbound commands of the bank-transfer route (Payments V1, lane PV1-INBOUND; docs/design/ACH-ROUTE.md r12 §7.5 C5, §7.6
 * C4/C6, §7.9 M2, §7.28 lock order), each in ONE commerce unit of work of the corporate owner's OPERATOR context on the payment service's
 * pool (`pool: "PAYMENT"`), journaled under the owner's own identity (agency NULL), its event agency-less:
 *
 *   enter     (CMD210) C5: a manual credit the owner typed, naming a stored bank artifact; a DRAFT_MANUAL that grants nothing. The artifact is
 *             NOT read here (C6 reads it); the account's INBOUND stream lock is taken FIRST, then the owner's access decision (a revocation
 *             that commits while the command waits at the lock is seen by the decision).
 *   confirm   (CMD211) C4+C6: the artifact is read outside the money lock and the transaction's locks (a savepoint released at its end),
 *             hash-verified, classified (fail closed) and compared field by field with the draft; the body then re-takes the INBOUND stream
 *             lock and the credit identity lock Lc, re-judges the owner and the step-up at the effect instant and confirms the draft as the
 *             verified artifact states it (it never rereads: the bytes verified are the bytes confirmed) -> OBSERVED.
 *   statement (CMD213) SI1+SI2: the owner's statement artifact is read, hash-verified and classified outside every lock; the body takes L1
 *             (OUTBOUND) then INBOUND, re-judges the owner and step-up, judges the coverage at the effect instant and records its coverage
 *             per stream, its lines by the bank's line identity (an identical line adds nothing, a changed one is PROVIDER_INCONSISTENCY),
 *             links debits to RECORDED attempts by execution id and opens RECORD_REQUIRED / UNDECLARED_OUTBOUND for the orphans.
 *   attribute (CMD212) M2: the owner attributes a MATCH_REVIEW credit to an order with billing evidence; in V1 the payer must be the order's
 *             accepted billing identity and the payee the route's (a foreign payer is return-only) -> MATCHED.
 *
 * Every version check answers STALE_VERSION (no reason); the command ids are the lane's operational ids of the command journal.
 */
import type { CommandId, UtcInstant } from "@kauro/contracts";
import type { AgencyId, BankCreditRecord, CausationId, CommerceUnitOfWork, CorrelationId, OperatorContext, PaymentOrderId, StatementPage, UserId } from "@kauro/domain";
import { BANK_CREDIT_RAILS, DomainFailure, NotFoundFailure, PROVIDER_CALL_TIMEOUT_MS, StaleVersionFailure, actorOf } from "@kauro/domain";
import { judgedUnderHold, type RequestAuthority } from "../../api/authority.js";
import type { AuthenticatedSubject, CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { problemOf, type Problem } from "../../api/problems.js";
import type { StoredBankEvidence } from "../ports.js";
import { CommerceAccessDenied, operatorContextOf, recordCommerceDenial, runCommerceCommand, tenantContextOf, type CommerceRequestRuntime, type RunnableCommand } from "../request/runtime.js";
import { BANK_HOLD_GATE_READ, BANK_HOLD_STATEMENT_LOCKED, type BankCreditRepository, type BankInboundCollaborators } from "./inbound-ports.js";
import { STEP_UP_ALLOW, assuredAt, evidenceUnavailable, integrationClassOf, judgedAtCommit, type BankRouteRequest } from "./route-config.js";

// --- requests and views ---------------------------------------------------------------------------------------------------------------

export interface EnterBankCreditBody {
  readonly bankTransactionId: string;
  readonly rail: "ACH" | "DOMESTIC_WIRE";
  readonly grossCents: string;
  readonly currency: "USD";
  readonly reference: string | null;
  readonly bookedAt: string;
  readonly evidence: { readonly artifactRef: string; readonly evidenceHash: string };
  readonly authorizationRef: string;
}
export interface ConfirmBankCreditBody {
  readonly expectedVersion: number;
  readonly authorizationRef: string;
}
export interface AttributeBankCreditBody {
  readonly expectedVersion: number;
  readonly orderId: string;
  readonly billingEvidenceRef: string;
  readonly reasonCode: string;
  readonly authorizationRef: string;
}

/** CMD213's body: the owner's stored statement artifact. */
export interface ImportStatementBody {
  readonly artifactRef: string;
  readonly evidenceHash: string;
  readonly authorizationRef: string;
}
/** One import: its coverage per stream, its lines (all, and first seen), its orphan debits; BALANCED only with zero orphans. */
export interface StatementImportView {
  readonly importId: string;
  readonly coverage: ReadonlyArray<{ readonly stream: "INBOUND" | "OUTBOUND"; readonly from: string; readonly to: string }>;
  readonly lines: number;
  readonly newLines: number;
  readonly orphans: number;
  readonly balanced: boolean;
}
export interface StatementImportCommandView {
  readonly import: StatementImportView;
}
/** CMD214's body: why the checkout is retired. */
export interface RetireBankCheckoutBody {
  readonly reasonCode: string;
}
/** CMD214's answer: the bank order as the retirement left it. */
export interface RetiredCheckoutView {
  readonly order: { readonly orderId: string; readonly bankState: "EXPIRED"; readonly expiryCause: "RETIRED"; readonly version: number };
}

export interface BankCreditView {
  readonly creditId: string;
  readonly accountRef: string;
  readonly bankTransactionId: string;
  readonly state: BankCreditRecord["state"];
  readonly version: number;
  readonly source: "OWNER_MANUAL";
  readonly rail: string;
  readonly grossCents: string;
  readonly feeCents: string | null;
  readonly currency: string;
  readonly reference: string | null;
  readonly orderId: string | null;
  readonly captureId: string | null;
}
export interface BankCreditCommandView {
  readonly credit: BankCreditView;
}
export interface BankMatchKeysView {
  readonly keys: {
    readonly orderId: string;
    readonly reference: string;
    readonly expectedAmountCents: string;
    readonly currency: "USD";
    readonly acceptedPayerDigest: string | null;
    readonly transferExpiresAt: string;
    readonly providerTimeToleranceMs: number;
    readonly accountRef: string;
  };
}

export const BANK_INBOUND_COMMAND_IDS = Object.freeze({ enter: "CMD210", confirm: "CMD211", attribute: "CMD212", statement: "CMD213", retire: "CMD214" } as const);
type InboundCommandId = (typeof BANK_INBOUND_COMMAND_IDS)[keyof typeof BANK_INBOUND_COMMAND_IDS];
export const inboundCommandOf = (id: InboundCommandId): RunnableCommand => ({ id, journalScope: "OPERATOR_IDENTITY", digestOmits: ["authorizationRef"] });

export function bankCreditView(c: BankCreditRecord): BankCreditView {
  return {
    creditId: c.creditId,
    accountRef: c.accountRef,
    bankTransactionId: c.bankTransactionId,
    state: c.state,
    version: c.version,
    source: "OWNER_MANUAL",
    rail: c.rail,
    grossCents: c.grossCents.toString(),
    feeCents: c.feeCents === null ? null : c.feeCents.toString(),
    currency: c.currency,
    reference: c.reference,
    orderId: c.orderId,
    captureId: c.captureId,
  };
}

/** The owner's context on the payment service's pool: the units of the inbound commands run as kauro_payment (migration 0061). */
export const paymentOperatorContextOf = (envelope: Pick<CommandEnvelope<unknown>, "userId" | "correlationId">): OperatorContext => ({ ...operatorContextOf(envelope), pool: "PAYMENT" as const });

export function inboundEnvelopeOf<Body>(id: InboundCommandId, request: BankRouteRequest<Body>): CommandEnvelope<Body> {
  return {
    command: id as CommandId,
    environment: request.environment,
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
    userId: request.subject.identity.userId as UserId,
    subject: request.subject,
    agencyId: null,
    clientAddressHash: null,
    path: request.path,
    body: request.body,
    receivedAt: request.receivedAt,
    ...(request.authority === undefined ? {} : { authority: request.authority }),
  };
}

/** Publishes one credit event (agency-less; the payload is restricted to the event type's allowlist by the domain registry). */
export async function publishCreditEvent(uow: CommerceUnitOfWork, causationId: CausationId, credit: Pick<BankCreditRecord, "creditId" | "accountRef" | "version">, eventType: "bank_credit.drafted.v1" | "bank_credit.received.v1" | "bank_credit.matched.v1" | "bank_credit.review_required.v1" | "bank_credit.applied.v1", payload: Readonly<Record<string, string | number>>): Promise<void> {
  const context = uow.context;
  if (context.kind === "ANONYMOUS") throw new DomainFailure("INTEGRITY_FAILURE", "a credit event is never anonymous");
  await uow.events.publish({
    aggregateKind: "bank_credit",
    aggregateId: credit.creditId as never,
    aggregateVersion: credit.version,
    agencyId: null,
    eventType,
    actor: actorOf(context),
    causationId,
    correlationId: context.correlationId,
    payload: { creditId: credit.creditId, ...payload },
  });
}

/** The event of one bank order state version (the agency's; the payment service publishes it in the agency it adopted). */
export async function publishOrderStateEvent(uow: CommerceUnitOfWork, causationId: CausationId, instruction: { readonly orderId: string; readonly agencyId: string; readonly version: number; readonly orderState: string }, previousState: string, cause: string): Promise<void> {
  const context = uow.context;
  if (context.kind === "ANONYMOUS") throw new DomainFailure("INTEGRITY_FAILURE", "a bank order state change is never anonymous");
  await uow.events.publish({
    aggregateKind: "bank_transfer_instruction",
    aggregateId: instruction.orderId as never,
    aggregateVersion: instruction.version,
    agencyId: instruction.agencyId as never,
    eventType: "bank_transfer_instruction.order_state_changed.v1",
    actor: actorOf(context),
    causationId,
    correlationId: context.correlationId,
    payload: { orderId: instruction.orderId, agencyId: instruction.agencyId, previousState, orderState: instruction.orderState, cause },
  });
}

// --- the stored artifact ---------------------------------------------------------------------------------------------------------------

const creditMismatch = (): DomainFailure => new DomainFailure("INTEGRITY_FAILURE", "the stored artifact disagrees with the credit", { reason: "CREDIT_EVIDENCE_MISMATCH" });

/** Reads a stored artifact under the provider-call bound and verifies its hash (the bytes are classified by the caller). */
export async function readStoredArtifact(co: BankInboundCollaborators, ref: string, expectedHash: string): Promise<StoredBankEvidence> {
  const store = co.evidence();
  if (store === null || co.classifier() === null) throw evidenceUnavailable();
  const bound = co.timer.start(PROVIDER_CALL_TIMEOUT_MS);
  let read: { readonly evidence: StoredBankEvidence | null } | null;
  try {
    read = await Promise.race([store.get(ref).then((evidence) => ({ evidence })), bound.elapsed.then(() => null)]);
  } finally {
    bound.cancel();
  }
  if (read === null) throw evidenceUnavailable();
  if (read.evidence === null) throw new DomainFailure("NOT_FOUND", "the artifact is not in the restricted store", { reason: "EVIDENCE_NOT_FOUND" });
  if (read.evidence.sha256 !== expectedHash) throw new DomainFailure("INTEGRITY_FAILURE", "the artifact is not the evidence the credit cites", { reason: "HASH_MISMATCH" });
  return read.evidence;
}

const sameInstant = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));

/** What C6 confirms: the verified artifact's money facts (the draft's gross, rail, reference and booking instant already agreed). */
interface Verified {
  readonly netCents: bigint | null;
  readonly feeCents: bigint | null;
  readonly payerDigest: string | null;
  readonly payeeDigest: string;
}

// --- handlers ------------------------------------------------------------------------------------------------------------------------

export interface BankInboundHandlers {
  enter(request: BankRouteRequest<EnterBankCreditBody>): Promise<CommandResult<BankCreditCommandView>>;
  confirm(request: BankRouteRequest<ConfirmBankCreditBody>): Promise<CommandResult<BankCreditCommandView>>;
  attribute(request: BankRouteRequest<AttributeBankCreditBody>): Promise<CommandResult<BankCreditCommandView>>;
  getCredit(request: InboundReadRequest & { readonly creditId: string }): Promise<InboundReadAnswer<BankCreditCommandView>>;
  getMatchKeys(request: InboundReadRequest & { readonly orderId: string }): Promise<InboundReadAnswer<BankMatchKeysView>>;
  /** CMD213 SI1+SI2: the owner imports a statement's coverage, its lines and their exceptions. */
  importStatement(request: BankRouteRequest<ImportStatementBody>): Promise<CommandResult<StatementImportCommandView>>;
  /** CMD214: the agency's billing member retires its open bank checkout (E1's retirement half). */
  retire(request: BankRouteRequest<RetireBankCheckoutBody> & { readonly agencyId: AgencyId }): Promise<CommandResult<RetiredCheckoutView>>;
}
export interface InboundReadRequest {
  readonly correlationId: CorrelationId;
  readonly subject: AuthenticatedSubject;
  readonly authority?: RequestAuthority;
}
export type InboundReadAnswer<View> = { readonly kind: "READ"; readonly view: View } | { readonly kind: "PROBLEM"; readonly problem: Problem };

export function createBankInboundHandlers(runtime: CommerceRequestRuntime, co: BankInboundCollaborators): BankInboundHandlers {
  const replayVersion = (view: BankCreditCommandView): number => view.credit.version;

  async function authorizeOwner(uow: CommerceUnitOfWork, envelope: CommandEnvelope<unknown>, what: string): Promise<void> {
    const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: envelope.subject.identity, role: "KAURO_OWNER" });
    if (decision.kind === "DENY") throw CommerceAccessDenied.of(what, decision);
  }

  const stale = (credit: Pick<BankCreditRecord, "version" | "state">): DomainFailure => new StaleVersionFailure(credit.version, credit.state);

  return {
    async enter(request) {
      const id = BANK_INBOUND_COMMAND_IDS.enter;
      const envelope = inboundEnvelopeOf(id, request);
      const context = paymentOperatorContextOf(envelope);
      const accountRef = request.path["accountRef"]!;
      let environment: "SANDBOX" | "LIVE" | null = null;
      return runCommerceCommand<EnterBankCreditBody, BankCreditCommandView>(runtime, {
        command: inboundCommandOf(id),
        envelope,
        context,
        replayVersion,
        async access(uow) {
          const repo = co.credits(uow);
          const environments = await repo.environmentsOfAccount(accountRef);
          environment = environments.includes(envelope.environment as "SANDBOX" | "LIVE") ? (envelope.environment as "SANDBOX" | "LIVE") : (environments[0] ?? null);
          // the stream lock before the access decision (lock-order note of migration 0046): a revocation committed meanwhile is seen by it
          if (environment !== null) await repo.lockStream(environment, accountRef, "INBOUND");
          await authorizeOwner(uow, envelope, id);
        },
        async body(uow, causationId) {
          const body = envelope.body;
          const repo = co.credits(uow);
          if (environment === null) throw new NotFoundFailure("bank account");
          if (!BANK_CREDIT_RAILS.includes(body.rail)) throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field: "rail", code: "ENUM" }] });
          if ((await repo.creditByTransaction(environment, accountRef, body.bankTransactionId, true)) !== null) {
            throw new DomainFailure("PRECONDITION_FAILED", "another credit of the account carries that bank transaction id", { reason: "CREDIT_ALREADY_ENTERED" });
          }
          await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, null, envelope.authority, runtime.clock);
          const draft = await repo.insertCredit({
            creditId: uow.ids.next(),
            environment,
            accountRef,
            bankTransactionId: body.bankTransactionId,
            state: "DRAFT_MANUAL",
            rail: body.rail,
            grossCents: BigInt(body.grossCents),
            netCents: null,
            feeCents: null,
            reference: body.reference,
            bookedAt: body.bookedAt,
            evidenceHash: body.evidence.evidenceHash,
            payerDigest: null,
            payeeDigest: null,
            artifactRef: body.evidence.artifactRef,
            createdBy: envelope.userId,
          });
          if (draft === null) throw new DomainFailure("PRECONDITION_FAILED", "another credit of the account carries that bank transaction id", { reason: "CREDIT_ALREADY_ENTERED" });
          await publishCreditEvent(uow, causationId, draft, "bank_credit.drafted.v1", { state: draft.state, evidenceHash: draft.evidenceHash });
          return { status: 201, view: { credit: bankCreditView(draft) }, version: draft.version, resourceKind: "bank_credit", resourceId: draft.creditId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    async confirm(request) {
      const id = BANK_INBOUND_COMMAND_IDS.confirm;
      const envelope = inboundEnvelopeOf(id, request);
      const context = paymentOperatorContextOf(envelope);
      const creditId = request.path["creditId"]!;
      let verified: Verified | null = null;
      let deferred: DomainFailure | null = null;
      return runCommerceCommand<ConfirmBankCreditBody, BankCreditCommandView>(runtime, {
        command: inboundCommandOf(id),
        envelope,
        context,
        replayVersion,
        async access(uow) {
          const repo = co.credits(uow);
          const seen = await repo.credit(creditId);
          // the decision first, in a unit-local scope: its share locks are released, so a revocation can commit while the command waits at the stream lock
          await repo.released(() => authorizeOwner(uow, envelope, id));
          if (seen === null) return;
          // R1 (C4): the artifact is read outside every lock the command holds; the savepoint releases the stream lock it waited for
          await repo.released(async () => {
            await repo.lockStream(seen.environment, seen.accountRef, "INBOUND");
            const credit = await repo.credit(creditId);
            if (credit === null) return;
            if (credit.version !== envelope.body.expectedVersion || credit.state !== "DRAFT_MANUAL") {
              deferred = stale(credit);
              return;
            }
            try {
              verified = await verifyDraft(co, repo, credit);
            } catch (e) {
              if (!(e instanceof DomainFailure)) throw e;
              deferred = e;
              return;
            }
          });
          // the product hold point: after the read, with every lock released (a replacement of the artifact from here on changes nothing it verified)
          if (deferred === null && verified !== null) await co.hold(BANK_HOLD_GATE_READ);
        },
        async body(uow, causationId) {
          const body = envelope.body;
          const repo = co.credits(uow);
          const seen = await repo.credit(creditId);
          if (seen === null) throw new NotFoundFailure("bank credit");
          await repo.lockStream(seen.environment, seen.accountRef, "INBOUND");
          const credit = await repo.lockCredit(creditId);
          if (credit === null) throw new NotFoundFailure("bank credit");
          // the owner is judged again under the lock (a withdrawal while the command waited or read is seen)
          await authorizeOwner(uow, envelope, id);
          if (credit.version !== body.expectedVersion || credit.state !== "DRAFT_MANUAL") throw stale(credit);
          if (deferred !== null) throw deferred;
          const facts = verified;
          if (facts === null) throw new DomainFailure("INTEGRITY_FAILURE", "the credit was not verified");
          await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, null, envelope.authority, runtime.clock);
          const written = await repo.transitionCredit(creditId, credit.version, { state: "OBSERVED", netCents: facts.netCents, feeCents: facts.feeCents, payerDigest: facts.payerDigest, payeeDigest: facts.payeeDigest });
          if (written.kind === "STALE") throw new StaleVersionFailure(written.currentVersion, written.currentState);
          await publishCreditEvent(uow, causationId, written.record, "bank_credit.received.v1", { state: written.record.state, previousState: credit.state, evidenceHash: written.record.evidenceHash });
          return { status: 200, view: { credit: bankCreditView(written.record) }, version: written.record.version, resourceKind: "bank_credit", resourceId: creditId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    async attribute(request) {
      const id = BANK_INBOUND_COMMAND_IDS.attribute;
      const envelope = inboundEnvelopeOf(id, request);
      const context = paymentOperatorContextOf(envelope);
      const creditId = request.path["creditId"]!;
      let seen: BankCreditRecord | null = null;
      return runCommerceCommand<AttributeBankCreditBody, BankCreditCommandView>(runtime, {
        command: inboundCommandOf(id),
        envelope,
        context,
        replayVersion,
        async access(uow) {
          const repo = co.credits(uow);
          seen = await repo.credit(creditId);
          if (seen !== null) await repo.lockStream(seen.environment, seen.accountRef, "INBOUND");
          await authorizeOwner(uow, envelope, id);
        },
        async body(uow, causationId) {
          const body = envelope.body;
          const repo = co.credits(uow);
          if (seen === null) throw new NotFoundFailure("bank credit");
          const credit = await repo.lockCredit(creditId);
          if (credit === null) throw new NotFoundFailure("bank credit");
          if (credit.version !== body.expectedVersion) throw stale(credit);
          const notOverridable = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "the owner cannot attribute this credit in V1", { reason: "ATTRIBUTION_NOT_OVERRIDABLE", currentVersion: credit.version, currentState: credit.state });
          if (credit.state !== "MATCH_REVIEW") throw notOverridable();
          const instruction = await repo.instruction(body.orderId);
          if (instruction === null) throw new NotFoundFailure("payment order");
          if (instruction.accountRef !== credit.accountRef || instruction.environment !== credit.environment || credit.currency !== "USD") throw notOverridable();
          const route = await co.routes(uow).version(instruction.routeId, instruction.routeVersion);
          if (route === null) throw new DomainFailure("INTEGRITY_FAILURE", "an instruction has no route version");
          const payer = await repo.acceptedPayerDigestOf(body.orderId);
          if (!route.acceptedRails.includes(credit.rail)) throw notOverridable();
          if (route.payeeDigest !== null && credit.payeeDigest !== null && route.payeeDigest !== credit.payeeDigest) throw notOverridable();
          if (payer === null || credit.payerDigest === null || payer !== credit.payerDigest) throw notOverridable();
          if (instruction.orderState !== "AWAITING_TRANSFER" && instruction.orderState !== "PARTIALLY_RECEIVED") throw new DomainFailure("PRECONDITION_FAILED", "the order is not open for a credit", { reason: "ORDER_NOT_CAPTURABLE" });
          await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, null, envelope.authority, runtime.clock);
          const written = await repo.transitionCredit(creditId, credit.version, { state: "MATCHED", orderId: body.orderId });
          if (written.kind === "STALE") throw new StaleVersionFailure(written.currentVersion, written.currentState);
          await repo.resolveCreditCases(creditId);
          await publishCreditEvent(uow, causationId, written.record, "bank_credit.matched.v1", { orderId: body.orderId, state: written.record.state, previousState: credit.state, decision: "OWNER_ATTRIBUTION" });
          return { status: 200, view: { credit: bankCreditView(written.record) }, version: written.record.version, resourceKind: "bank_credit", resourceId: creditId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    async importStatement(request) {
      const id = BANK_INBOUND_COMMAND_IDS.statement;
      const envelope = inboundEnvelopeOf(id, request);
      const context = paymentOperatorContextOf(envelope);
      const accountRef = request.path["accountRef"]!;
      let environment: "SANDBOX" | "LIVE" | null = null;
      let read: { readonly page: StatementPage; readonly normalizerVersion: string } | null = null;
      let deferred: DomainFailure | null = null;
      return runCommerceCommand<ImportStatementBody, StatementImportCommandView>(runtime, {
        command: inboundCommandOf(id),
        envelope,
        context,
        replayVersion: () => 1,
        async access(uow) {
          const repo = co.credits(uow);
          const environments = await repo.environmentsOfAccount(accountRef);
          environment = environments.includes(envelope.environment as "SANDBOX" | "LIVE") ? (envelope.environment as "SANDBOX" | "LIVE") : (environments[0] ?? null);
          // the decision first, in a unit-local scope (its share locks released): SI2 re-judges the owner under L1
          await repo.released(() => authorizeOwner(uow, envelope, id));
          if (environment === null) return;
          // SI1: the artifact is read, hash-verified and classified outside every lock (no stream lock is held yet); never cached
          try {
            read = await readStatement(co, accountRef, environment, envelope.body);
          } catch (e) {
            if (!(e instanceof DomainFailure)) throw e;
            deferred = e;
          }
        },
        async body(uow, causationId) {
          const body = envelope.body;
          const repo = co.credits(uow);
          if (environment === null) throw new NotFoundFailure("bank account");
          // §7.28: L1 (the OUTBOUND stream) first, then the INBOUND stream; the credit and execution identity locks per line below
          await repo.lockStream(environment, accountRef, "OUTBOUND");
          await repo.lockStream(environment, accountRef, "INBOUND");
          await co.hold(BANK_HOLD_STATEMENT_LOCKED);
          // the owner is judged again under the lock (a withdrawal while the command read or waited is seen)
          await authorizeOwner(uow, envelope, id);
          if (deferred !== null) throw deferred;
          const verified = read;
          if (verified === null) throw new DomainFailure("INTEGRITY_FAILURE", "the statement was not verified");
          const page = verified.page;
          const at = await assuredAt(co, uow, envelope.userId, body.authorizationRef, null);
          judgedAtCommit(co, uow, envelope.userId, body.authorizationRef, null, envelope.authority, runtime.clock);
          // freshness under the lock, at the effect instant: a coverage never ends after it, nor starts before the account's route
          if (Date.parse(page.coverageEnd) > Date.parse(at)) throw new DomainFailure("PRECONDITION_FAILED", "the statement's coverage ends after the effect instant", { reason: "COVERAGE_END_IN_FUTURE" });
          const floor = await repo.coverageFloorOf(environment, accountRef);
          if (floor === null || Date.parse(page.coverageStart) < Date.parse(floor)) throw new DomainFailure("PRECONDITION_FAILED", "the statement's coverage starts before the account's route version", { reason: "COVERAGE_OUTSIDE_ROUTE_VERSION" });
          if ((await repo.importOfArtifact(environment, accountRef, page.evidenceHash)) !== null) throw new DomainFailure("PRECONDITION_FAILED", "the artifact is already imported", { reason: "STATEMENT_ALREADY_IMPORTED" });
          const importId = uow.ids.next();
          await repo.insertImport({ importId, environment, accountRef, artifactRef: body.artifactRef, evidenceHash: page.evidenceHash, normalizerVersion: verified.normalizerVersion, idempotencyKey: envelope.idempotencyKey, importedBy: envelope.userId });
          for (const stream of ["INBOUND", "OUTBOUND"] as const) await repo.insertCoverage(importId, stream, page.coverageStart, page.coverageEnd);
          const inconsistent = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "a line is already recorded with other money fields", { reason: "PROVIDER_INCONSISTENCY" });
          let newLines = 0;
          let orphans = 0;
          for (const c of page.credits) {
            // the credit identity lock Lc shared with C6: one credit identity per bank transaction, never a second credit
            const credit = await repo.creditByTransaction(environment, accountRef, c.creditId, true);
            if (credit !== null && credit.state !== "DRAFT_MANUAL" && (c.grossCents === null || credit.grossCents !== c.grossCents || credit.currency !== c.currency)) throw inconsistent();
            const w = await repo.recordLine({ ...lineBase(importId, environment, accountRef, page.evidenceHash), lineKind: "CREDIT", lineId: uow.ids.next(), bankLineId: c.creditId, bankExecutionId: null, amountCents: c.grossCents, feeCents: c.feeCents, currency: c.currency, reference: c.reference, status: c.status, executedAt: null, bookedAt: c.bookedAt, observedAt: c.observedAt });
            if (w.kind === "DIFFERENT") throw inconsistent();
            if (w.kind === "NEW") newLines++;
          }
          for (const d of page.debits) {
            const w = await repo.recordLine({
              ...lineBase(importId, environment, accountRef, page.evidenceHash),
              lineKind: "DEBIT",
              lineId: uow.ids.next(),
              bankLineId: d.debitId,
              bankExecutionId: d.bankExecutionId,
              amountCents: d.amountCents,
              feeCents: d.feeCents,
              currency: d.currency,
              reference: d.reference,
              status: d.status,
              executedAt: d.executedAt,
              bookedAt: d.bookedAt,
              observedAt: d.observedAt,
              destinationAccountDigest: d.destination.accountDigest,
              destinationAccountLast4: d.destination.accountLast4,
              destinationRoutingDigest: d.destination.routingDigest,
              recipientRef: d.destination.recipientRef,
              recipientVersion: d.destination.recipientVersion,
            });
            if (w.kind === "DIFFERENT") throw inconsistent();
            if (w.kind === "NEW") newLines++;
            let linked = w.linkedAttemptId;
            // a debit links only by its bank execution id, to a RECORDED attempt (its execution identity lock)
            if (linked === null && d.bankExecutionId !== null) {
              const attempt = await repo.recordedAttemptOf(environment, accountRef, d.bankExecutionId);
              if (attempt !== null) {
                await repo.linkLine(w.lineId, attempt);
                linked = attempt;
              }
            }
            if (linked !== null) continue;
            orphans++;
            // a Kauro refund reference with no declaration at all is an execution before any declaration (§7.28 SI2-UNDECLARED)
            const undeclared = d.reference !== null && REFUND_REFERENCE.test(d.reference) && !(await repo.attemptDeclaredWith(d.reference));
            await repo.openLineCase(uow.ids.next(), undeclared ? "UNDECLARED_OUTBOUND" : "RECORD_REQUIRED", { environment, accountRef, lineId: w.lineId, evidenceHash: page.evidenceHash }, undeclared ? "DEBIT_BEFORE_DECLARATION" : "DEBIT_NOT_RECORDED");
          }
          const lines = page.credits.length + page.debits.length;
          await uow.events.publish({
            aggregateKind: "statement_import" as never,
            aggregateId: importId as never,
            aggregateVersion: 1,
            agencyId: null,
            eventType: "statement_import.recorded.v1" as never,
            actor: actorOf(uow.context as OperatorContext),
            causationId,
            correlationId: envelope.correlationId,
            payload: { importId, evidenceHash: page.evidenceHash, lines, newLines },
          });
          const view: StatementImportView = {
            importId,
            coverage: [
              { stream: "INBOUND", from: page.coverageStart, to: page.coverageEnd },
              { stream: "OUTBOUND", from: page.coverageStart, to: page.coverageEnd },
            ],
            lines,
            newLines,
            orphans,
            balanced: orphans === 0,
          };
          return { status: 201, view: { import: view }, version: 1, resourceKind: "statement_import", resourceId: importId, allowFact: STEP_UP_ALLOW };
        },
      });
    },

    getCredit: (request) => ownerRead(request, "READ_BANK_CREDIT", async (uow) => {
      const credit = await co.credits(uow).credit(request.creditId);
      if (credit === null) throw new NotFoundFailure("bank credit");
      return { credit: bankCreditView(credit) };
    }),

    getMatchKeys: (request) => ownerRead(request, "READ_BANK_ORDER_MATCH_KEYS", async (uow): Promise<BankMatchKeysView> => {
      const repo = co.credits(uow);
      const instruction = await repo.instruction(request.orderId);
      if (instruction === null) throw new NotFoundFailure("payment order");
      const route = await co.routes(uow).version(instruction.routeId, instruction.routeVersion);
      if (route === null) throw new DomainFailure("INTEGRITY_FAILURE", "an instruction has no route version");
      return {
        keys: {
          orderId: instruction.orderId,
          reference: instruction.reference,
          expectedAmountCents: instruction.amountCents.toString(),
          currency: instruction.currency,
          acceptedPayerDigest: await repo.acceptedPayerDigestOf(instruction.orderId),
          transferExpiresAt: instruction.transferExpiresAt,
          providerTimeToleranceMs: route.providerTimeToleranceMs,
          accountRef: instruction.accountRef,
        },
      };
    }),

    async retire(request) {
      const id = BANK_INBOUND_COMMAND_IDS.retire;
      const envelope: CommandEnvelope<RetireBankCheckoutBody> = { ...inboundEnvelopeOf(id, request), agencyId: request.agencyId };
      // the payment boundary's pool: the instruction, the order lock and the slot are the payment service's columns (0061 CMD214)
      const context = { ...tenantContextOf(envelope), pool: "PAYMENT" as const };
      const agencyId = context.agencyId;
      const orderId = request.path["orderId"]!;
      const authorize = async (uow: CommerceUnitOfWork): Promise<void> => {
        // the checkout's own role: the agency's billing member who opens a checkout (CMD028, AGENCY_BILLING) retires it
        const decision = await runtime.authorizer.authorize(uow, { command: "CMD028", identity: envelope.subject.identity, agencyId });
        if (decision.kind === "DENY") throw CommerceAccessDenied.of(id, decision);
      };
      return runCommerceCommand<RetireBankCheckoutBody, RetiredCheckoutView>(runtime, {
        command: { id, journalScope: "TENANT" },
        envelope,
        context,
        replayVersion: (view) => view.order.version,
        async access(uow) {
          // a caller with no ACTIVE membership in the agency it names is refused before any of its rows is locked (ADV-PV1R-10): the
          // membership read under a savepoint rolled back at once, so no membership half is held across the order's lock wait
          const member = await co.credits(uow).released(() => uow.memberships.findLive(agencyId, context.userId));
          if (member === null || member.state !== "ACTIVE") await authorize(uow);
        },
        async body(uow, causationId) {
          const repo = co.credits(uow);
          const seen = await repo.instruction(orderId);
          if (seen === null || seen.agencyId !== agencyId) throw new NotFoundFailure("payment order");
          // lock order (§7.28, E1's): the order's row lock, then the member's access decision after that wait (a revocation committed
          // meanwhile is seen), then the instruction's row lock; the state is judged after the last lock
          const order = await uow.commerce.orders.lock(orderId as PaymentOrderId);
          if (order === null || order.agencyId !== agencyId) throw new NotFoundFailure("payment order");
          await authorize(uow);
          const instruction = await repo.instruction(orderId, true);
          if (instruction === null) throw new NotFoundFailure("payment order");
          if (instruction.orderState !== "AWAITING_TRANSFER" && instruction.orderState !== "PARTIALLY_RECEIVED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the bank checkout is no longer open", { reason: "ORDER_NOT_CAPTURABLE" });
          }
          const after = await repo.expireOrder(orderId, instruction.version, "RETIRED");
          await repo.releaseBankSlot(orderId);
          await publishOrderStateEvent(uow, causationId, after, instruction.orderState, "CHECKOUT_RETIRED");
          const view: RetiredCheckoutView = { order: { orderId, bankState: "EXPIRED", expiryCause: "RETIRED", version: after.version } };
          return { status: 200, view, version: after.version, resourceKind: "bank_transfer_instruction", resourceId: orderId };
        },
      });
    },
  };

  async function ownerRead<View>(request: InboundReadRequest, what: string, read: (uow: CommerceUnitOfWork) => Promise<View>): Promise<InboundReadAnswer<View>> {
    const context: OperatorContext = { kind: "OPERATOR", userId: request.subject.identity.userId as UserId, correlationId: request.correlationId, pool: "PAYMENT" };
    let denied = false;
    try {
      const view = await runtime.unitOfWork.run(context, async (uow) => {
        const decision = await runtime.commerceAuthorizer.authorizeOperator(uow, { identity: request.subject.identity, role: "KAURO_OWNER" });
        if (decision.kind === "DENY") {
          denied = true;
          throw CommerceAccessDenied.of(what, decision);
        }
        const out = await read(uow);
        await judgedUnderHold(request.authority, uow, runtime.clock);
        return out;
      });
      return { kind: "READ", view };
    } catch (e) {
      if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
      if (denied || e.code === "AUTHENTICATION_REQUIRED") await recordCommerceDenial(runtime, context, what, e, null);
      return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) };
    }
  }
}

/** C4: the draft's artifact read, hash-verified, classified and compared with the draft; the facts C6 confirms. */
async function verifyDraft(co: BankInboundCollaborators, repo: BankCreditRepository, credit: BankCreditRecord): Promise<Verified> {
  const classifier = co.classifier();
  if (credit.artifactRef === null) throw new DomainFailure("INTEGRITY_FAILURE", "the credit names no artifact");
  const evidence = await readStoredArtifact(co, credit.artifactRef, credit.evidenceHash);
  if (classifier === null) throw evidenceUnavailable();
  if (evidence.accountRef !== credit.accountRef || evidence.environment !== credit.environment) throw creditMismatch();
  const classified = classifier.classifyCredit(evidence);
  if (classified.kind === "REJECTED") throw new DomainFailure("INTEGRITY_FAILURE", `the credit evidence was refused: ${classified.code}`, { reason: classified.code });
  const c = classified.value;
  if (c.creditId !== credit.bankTransactionId || c.accountRef !== credit.accountRef || c.rail !== credit.rail || c.currency !== "USD" || c.grossCents !== credit.grossCents || c.reference !== credit.reference || !sameInstant(c.bookedAt, credit.bookedAt) || c.status !== "COMPLETED") {
    throw creditMismatch();
  }
  void repo;
  return { netCents: c.netCents, feeCents: c.feeCents, payerDigest: c.payerDigest, payeeDigest: c.payeeDigest };
}

/** SI1: the owner's statement artifact, read under the provider-call bound, hash-verified and classified (fail closed); never cached. */
async function readStatement(co: BankInboundCollaborators, accountRef: string, environment: string, body: ImportStatementBody): Promise<{ readonly page: StatementPage; readonly normalizerVersion: string }> {
  const classifier = co.classifier();
  const evidence = await readStoredArtifact(co, body.artifactRef, body.evidenceHash);
  if (classifier === null) throw evidenceUnavailable();
  const classified = classifier.classifyStatement(evidence);
  // the bytes are judged first (their digest, format and authentication), then whose statement they are
  if (classified.kind === "REJECTED") throw new DomainFailure("INTEGRITY_FAILURE", `the statement evidence was refused: ${classified.code}`, { reason: classified.code });
  // then: another account's or environment's artifact is not evidence of this account
  if (evidence.accountRef !== accountRef || evidence.environment !== environment) throw new DomainFailure("INTEGRITY_FAILURE", "the artifact is not a statement of this account", { reason: "UNKNOWN_EVIDENCE" });
  const page = classified.value;
  if (page.accountRef !== accountRef || page.evidenceHash !== body.evidenceHash || !(Date.parse(page.coverageStart) < Date.parse(page.coverageEnd))) {
    throw new DomainFailure("INTEGRITY_FAILURE", "the statement does not state a coverage of this account", { reason: "MALFORMED_EVIDENCE" });
  }
  return { page, normalizerVersion: evidence.normalizerVersion };
}

/** The reference a Kauro refund execution carries (`kauro-refund-<refundId>-<n>`, migration 0045 outbound_execution_attempts). */
const REFUND_REFERENCE = /^kauro-refund-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]{1,9}$/;

const lineBase = (importId: string, environment: "SANDBOX" | "LIVE", accountRef: string, evidenceHash: string) => ({
  importId,
  environment,
  accountRef,
  evidenceHash,
  destinationAccountDigest: null,
  destinationAccountLast4: null,
  destinationRoutingDigest: null,
  recipientRef: null,
  recipientVersion: null,
});

export { integrationClassOf };
export type { UtcInstant };
