/**
 * CMD027 CreateQuote — POST /api/v1/projects/{projectId}/quotes — AGENCY_BILLING — scope AGENCY_HEADER — no provider effect (design §3.4,
 * §3.5, §10, §12; decisions D10-QUOTE-1..4; registry "compute server price, maximum eligible discount, taxes, expiry and immutable
 * terms"; "zero-unit or unqualified work cannot be charged as a minimum-price project; incomplete tax facts block issuance").
 *
 * B06's pipeline in the agency member's own unit of work (TENANT, kauro_app): access (B06 authorizer: AGENCY_BILLING) → journal reserve
 * (or the replay of the journaled 201) → the shared halves in the platform's lock order — agency, the project's capability, the plan's
 * approval, the sealed source revision, the target contract, the agency's fiscal profile — then the project's live quote FOR UPDATE and the
 * agency recurrence lock's shared half (the issuance core's own order, so a snapshot sees a designation wholly or not at all). The
 * preconditions answer their first failure in the design's order: project and plan visible (NOT_FOUND); agency ACTIVE with its accepted terms
 * (AGENCY_NOT_ACTIVE); the plan APPROVED under its live approval; billable units above zero (NO_BILLABLE_UNITS); the band within the launch
 * envelope (ENVELOPE_NOT_OFFERED); the mode offered; the buyer type recorded (BUYER_TYPE_UNSET; BuyerTypeReader); the source SEALED and
 * available on the database clock (SOURCE_EXPIRED; B07's SourceAvailabilityReader) and the target contract current (TARGET_STALE); the
 * billing profile the agency's current one (BILLING_PROFILE_MISMATCH) with a reviewed treatment (FISCAL_TREATMENT_UNREVIEWED).
 *
 * An unpaid project (or one whose last purchase was returned) is quoted by the issuance core of the recurrence package: the snapshot at the
 * issuance instant, the one highest discount, the founding slot, the quote DRAFT → ISSUED, the previous unpaid quote SUPERSEDED with its
 * reservation released, `quote_issuances` — all in this unit of work, journaled 201.
 *
 * A project whose live quote is paid and whose entitlement is ACTIVE takes the included replacement instead (§3.5; replacement.ts): one
 * transaction issues the replacement quote carrying the paid terms and records its issuance (the intent, the journal entry staying RESERVED),
 * the payment service's unit of work calls B09's PurchaseRebinder (settle), and a last transaction answers from what became durable
 * (complete). A crash between any two resumes by the journal entry; a refused re-binding withdraws the replacement and answers its blockers.
 */
import type { UtcInstant } from "@kauro/contracts";
import { policy as registryPolicy } from "@kauro/contracts";
import type {
  AgencyRecord,
  CausationId,
  CommerceUnitOfWork,
  JournalEntryId,
  MembershipRole,
  PlanRecord,
  ProjectId,
  ProjectRecord,
  QuoteIssuance,
  QuoteRecord,
  ResolvedMembership,
  TaxRuleSnapshot,
} from "@kauro/domain";
import {
  DomainFailure,
  IdempotencyConflictFailure,
  LiveQuoteChangedFailure,
  NotFoundFailure,
  OFFERED_CAPABILITY_STATES,
  baseServiceCents,
  blockerFailure,
  instantMs,
  quotableTaxRule,
  registryPricePolicy,
  toUtcInstant,
} from "@kauro/domain";
import type { EligibilitySnapshotId, FiscalIssuerRef, FiscalProfileId, FiscalProfileRecord, MembershipId, QuoteId } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { quoteViewOf } from "../../commerce/request/checkout.js";
import {
  CommerceAccessDenied,
  DENIAL_CODES,
  commerceDigestOf,
  commerceIdentityOf,
  recordCommerceDenial,
  resultOf,
  tenantContextOf,
  versionOfView,
  type CommerceRequestRuntime,
} from "../../commerce/request/runtime.js";
import { CREATE_QUOTE, type CreateQuoteBody } from "../contracts.js";
import type { CreateQuoteView, QuoteEligibilityView } from "../views.js";
import { commercialAdmissionSpecOf, type CommercialCommandHandler } from "../agency/runtime.js";
import { requireMembershipOf } from "../agency/shared.js";
import { completeReplacement, issueReplacement, replacementContextOf, settleReplacement, type ReplacementContext } from "./replacement.js";
import type { QuoteCollaborators, QuoteReads } from "./runtime.js";

/** The seconds a caller waits before it retries a replacement whose re-binding did not answer (the 202's polling guidance). */
const REPLACEMENT_POLL_AFTER_SECONDS = 5;

/** What a first execution leaves to do after its transaction: nothing (the journaled answer), or the rest of a replacement. */
type First = { readonly kind: "REPLAY"; readonly view: CreateQuoteView } | { readonly kind: "FINAL"; readonly view: CreateQuoteView } | { readonly kind: "REPLACEMENT"; readonly replacement: ReplacementContext; readonly resumed: boolean };

/** The facts every issuance rests on, read and checked in the design's order (§3.4). */
export interface QuotedSubject {
  readonly project: ProjectRecord;
  readonly plan: PlanRecord;
  readonly agency: AgencyRecord;
  readonly units: number;
  readonly profile: FiscalProfileRecord;
  readonly tax: TaxRuleSnapshot;
  readonly issuerRef: FiscalIssuerRef;
  readonly sourceDeadline: UtcInstant;
  readonly termsVersion: string;
  readonly buyerType: "AGENCY" | "IN_HOUSE";
  readonly issuedAt: UtcInstant;
}

const refuse = (reason: NonNullable<DomainFailure["details"]["reason"]>, message: string, details: Partial<DomainFailure["details"]> = {}): DomainFailure =>
  new DomainFailure("PRECONDITION_FAILED", message, { reason, ...details });

/** A quote `quotes_one_live_per_project` counts as the project's live one (the predicate of liveQuoteOf). */
const isLiveQuote = (q: QuoteRecord): boolean => q.state === "ACCEPTED_FOR_CHECKOUT" || (q.replacesQuoteId === undefined && (q.state === "DRAFT" || q.state === "ISSUED"));

/** The rounds lockLiveQuote re-reads the live quote: each needs another transaction to change the project's live quote meanwhile and commit. */
const LIVE_QUOTE_LOCK_ROUNDS = 3;

/**
 * The retryable STALE_VERSION of CMD027 (outcomes.ts: "the project's live quote changed under this request", current ALWAYS; design §12,
 * D10-GAP-25): current is the project's quote as it stands (the live one, else the latest), read in `reads`' own transaction.
 */
async function staleLiveQuote(reads: QuoteReads, agencyId: AgencyRecord["agencyId"], projectId: ProjectId): Promise<DomainFailure> {
  const current = await reads.currentQuoteOf(agencyId, projectId);
  const details = current === null ? {} : { currentVersion: current.version, currentState: current.state };
  return new DomainFailure("STALE_VERSION", "the project's live quote changed under this request", details, true);
}

/**
 * The project's live quote, FOR UPDATE and still live once the lock is held (D10-GAP-25). liveQuoteOf is a plain read: the quote it names
 * may be superseded before the lock is taken (a re-binding committing between the read and the FOR UPDATE, or updating the row before a
 * waiter woken by an earlier COMMIT takes it; main run 37557133856), and the superseded paid quote would send a replacement down the
 * ordinary issuance path, refused by quotes_one_live_per_project. The live quote is read again under the lock just taken. A project with no
 * live quote has no row to lock: its first issuance is serialized on the project's issuance subject (an exclusive transaction-level
 * advisory lock only CreateQuote takes, so it orders nothing else), then read again, so two first issuances supersede one another and
 * never collide on the index. A project whose live quote keeps changing is refused the retryable STALE_VERSION with nothing written.
 */
async function lockLiveQuote(uow: CommerceUnitOfWork, co: QuoteCollaborators, agencyId: AgencyRecord["agencyId"], projectId: ProjectId): Promise<QuoteRecord | null> {
  const reads = co.reads(uow);
  let serialized = false;
  for (let round = 0; round < LIVE_QUOTE_LOCK_ROUNDS; ) {
    const liveId = await reads.liveQuoteOf(agencyId, projectId);
    if (liveId === null) {
      if (serialized) return null;
      // lock order (D10-GAP-25): the first-issuance lock is waited for only before any quote row lock (round 0); after a quote row lock of an
      // earlier round it is only tried, and a project whose first issuance another request holds is the retryable STALE_VERSION, nothing written
      if (!(await reads.serializeFirstIssuance(agencyId, projectId, round === 0))) throw await staleLiveQuote(reads, agencyId, projectId);
      serialized = true;
      continue;
    }
    const locked = await uow.commerce.quotes.lock(liveId);
    if (locked !== null && isLiveQuote(locked)) return locked;
    round += 1;
  }
  throw await staleLiveQuote(reads, agencyId, projectId);
}

function eligibilityOf(issued: QuoteIssuance): QuoteEligibilityView {
  const s = issued.eligibility.snapshot;
  return {
    qualifyingProjectCount: s.qualifyingCount,
    repeatDiscountBps: s.repeatDiscountBps,
    foundingOffer: issued.eligibility.foundingOffer,
    appliedDiscountBps: s.appliedDiscountBps,
    // the snapshot's instant is exact to the microsecond (the database compares it); the wire states it to the millisecond like every instant
    lookbackStartsAt: toUtcInstant(Date.parse(s.lookbackStartsAt)),
  };
}

export function createQuoteHandler(runtime: CommerceRequestRuntime, co: QuoteCollaborators): CommercialCommandHandler<CreateQuoteBody, CreateQuoteView> {
  const spec = CREATE_QUOTE;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<CreateQuoteBody>): Promise<CommandResult<CreateQuoteView>> {
      const context = tenantContextOf(envelope);
      const agencyId = context.agencyId;
      const command = { id: spec.id, journalScope: "TENANT" } as const;
      const identity = commerceIdentityOf(command, envelope);
      const digest = commerceDigestOf(command, envelope);
      const projectId = envelope.path["projectId"] as ProjectId;
      const held: { membership: ResolvedMembership | null } = { membership: null };
      let accessDenied = false;

      /** The subject of the quote, every fact read after its shared lock in the platform's order and checked in the design's order. */
      const subjectOf = async (uow: CommerceUnitOfWork): Promise<QuotedSubject> => {
        const reads = co.reads(uow);
        const project = await uow.projects.get(projectId);
        if (project === null || project.agencyId !== agencyId) throw new NotFoundFailure("project");
        const plan = await uow.plans.get(envelope.body.planId as PlanRecord["planId"]);
        if (plan === null || plan.projectId !== projectId) throw new NotFoundFailure("plan");
        // the shared halves, in the order of §10: agency → capability → approval → source revision → target contract → fiscal profile
        const agency = await uow.agencies.lockShared(agencyId);
        if (agency === null) throw new NotFoundFailure("agency");
        const modeCapability = await uow.capabilities.lockMode(project.mode);
        const capability = modeCapability !== null && modeCapability.capabilityId === project.capabilityId ? modeCapability : await uow.capabilities.get(project.capabilityId);
        if (plan.approvalId !== undefined) await reads.awaitApproval(plan.approvalId);
        const approval = plan.approvalId === undefined ? null : await uow.approvals.get(plan.approvalId);
        const revision = await uow.revisions.lockSealedByHash(agencyId, projectId, plan.revisionHash);
        const target = await uow.targetContracts.lockCurrentByHash(agencyId, projectId, plan.targetContractHash);
        const profile = await uow.commerce.fiscal.currentProfile(agencyId);
        const issuedAt = await reads.serverNow();

        if (agency.state !== "ACTIVE") throw refuse("AGENCY_NOT_ACTIVE", "the agency is not ACTIVE", { currentVersion: agency.version, currentState: agency.state });
        if (agency.termsVersion === undefined) throw refuse("AGREEMENTS_INCOMPLETE", "the agency has accepted no terms version", { currentVersion: agency.version, currentState: agency.state });
        if (plan.state !== "APPROVED" || plan.approvalId === undefined) {
          const reason = plan.state === "SUPERSEDED" ? "PLAN_SUPERSEDED" : plan.state === "WITHDRAWN" ? "PLAN_WITHDRAWN" : "PLAN_NOT_APPROVED";
          throw refuse(reason, "the plan is not APPROVED", { currentVersion: plan.version, currentState: plan.state });
        }
        if (approval === null || approval.withdrawnAt !== undefined || approval.planId !== plan.planId) throw refuse("APPROVAL_NOT_CURRENT", "the plan's approval is not live");
        const units = await reads.billableUnitsOf({ agencyId, projectId, revisionHash: plan.revisionHash });
        if (units === null) throw blockerFailure("SOURCE_EXPIRED");
        if (units === 0) throw refuse("NO_BILLABLE_UNITS", "there is nothing to sell: the sealed source freezes no billable units");
        const priced = registryPricePolicy();
        const band = priced.bands.find((b) => units <= b.maximumUnits);
        if (band === undefined || band.maximumUnits > registryPolicyLaunchUnits()) {
          throw new DomainFailure("CAPABILITY_UNAVAILABLE", "the billable units are beyond the offered launch envelope", { reason: "ENVELOPE_NOT_OFFERED" });
        }
        if (capability === null || !OFFERED_CAPABILITY_STATES.has(capability.state)) throw blockerFailure("CAPABILITY_RESTRICTED");
        const buyerType = await co.buyerType.buyerTypeOf(uow, { agencyId });
        if (buyerType === null) throw refuse("BUYER_TYPE_UNSET", "no buyer type is recorded for the agency");
        // the source: SEALED and available on the database clock, through B07's reader (the quote promises no more than it states)
        const sources = co.request.sources;
        if (sources === null) throw new DomainFailure("INTEGRITY_FAILURE", "no source availability reader is bound in this deployment", { reason: "PLAN_SERVICES_UNAVAILABLE" });
        const availability = revision === null || revision.state !== "SEALED" || revision.availableUntil === null ? null : await sources.availabilityOf(uow, { agencyId, projectId, revisionHash: plan.revisionHash });
        if (availability === null || availability.state !== "SEALED" || instantMs(issuedAt) >= instantMs(availability.effectiveDeadline)) throw blockerFailure("SOURCE_EXPIRED");
        if (target === null || target.confirmedAt === undefined || target.supersededAt !== undefined) throw blockerFailure("TARGET_STALE");
        if (profile === null || profile.profileId !== (envelope.body.billingProfileRef as FiscalProfileId)) throw refuse("BILLING_PROFILE_MISMATCH", "billingProfileRef is not the agency's current fiscal profile");
        const rule = quotableTaxRule(profile, issuedAt);
        if (rule.kind === "BLOCKED") throw blockerFailure("FISCAL_TREATMENT_UNREVIEWED");
        return { project, plan, agency, units, profile, tax: rule.snapshot, issuerRef: profile.operatorLegalRef, sourceDeadline: availability.effectiveDeadline, termsVersion: agency.termsVersion, buyerType, issuedAt };
      };

      try {
        const first = await runtime.unitOfWork.run(context, async (uow): Promise<First> => {
          try {
            const decision = await runtime.authorizer.authorize(uow, { command: "CMD027", identity: envelope.subject.identity, agencyId });
            if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD027", decision);
            held.membership = requireMembershipOf(decision.membership);
          } catch (e) {
            accessDenied = e instanceof DomainFailure;
            throw e;
          }
          const reservation = await uow.journal.reserve(identity, digest, envelope.correlationId);
          if (reservation.kind === "REPLAY") {
            const status = reservation.entry.responseStatus;
            if (status !== 201 || reservation.entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
            return { kind: "REPLAY", view: reservation.entry.responseBody as CreateQuoteView };
          }
          if (reservation.kind === "CONFLICT") throw new IdempotencyConflictFailure();
          if (reservation.kind === "PENDING") {
            // a replacement whose intent committed and whose answer did not: it resumes from the issuance its journal entry recorded
            const issuance = await co.recurrence(uow).issuanceOfEntry(reservation.entry.entryId);
            // the ordinary issuance commits its answer with its quote and a replacement's intent commits its issuance with the entry: an open entry
            // without a replacement issuance is a breach that never clears, never a retryable pending operation (D10-GAP-25)
            if (issuance === null || issuance.replacesQuoteId === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a journal entry is open without the replacement issuance it commits with");
            return { kind: "REPLACEMENT", replacement: await replacementContextOf(uow, co, issuance), resumed: true };
          }
          const entryId = reservation.entryId;
          const membership = held.membership;
          if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "a quote was authorized without a membership");
          const subject = await subjectOf(uow);
          const c = uow.commerce;
          // the project's live quote FOR UPDATE (§10: after the shared halves, before the recurrence lock), live once its lock is held
          const live = await lockLiveQuote(uow, co, agencyId, projectId);
          const authorization = live === null ? null : await c.authorizations.findByQuote(live.quoteId);
          if (live !== null && authorization !== null && authorization.state !== "REVOKED") {
            const replacement = await issueReplacement(uow, co, { entryId, envelope, membership, subject, live, authorization });
            await co.hold?.("INTENT_BEFORE_COMMIT");
            return { kind: "REPLACEMENT", replacement, resumed: false };
          }
          const recurrence = co.recurrence(uow);
          await recurrence.lockShared(agencyId);
          await co.hold?.("AFTER_RECURRENCE_LOCK");
          const issued = await recurrence.issueQuote({
            journalEntryId: entryId as JournalEntryId,
            quoteId: uow.ids.next() as QuoteId,
            snapshotId: uow.ids.next() as EligibilitySnapshotId,
            agencyId,
            projectId,
            planId: subject.plan.planId,
            approvalId: subject.plan.approvalId as NonNullable<PlanRecord["approvalId"]>,
            revisionHash: subject.plan.revisionHash,
            planHash: subject.plan.bodyHash,
            targetContractHash: subject.plan.targetContractHash,
            mode: subject.project.mode,
            billableUnits: subject.units,
            pricePolicyVersion: registryPricePolicy().version,
            fiscalProfileId: subject.profile.profileId,
            issuerRef: subject.issuerRef,
            tax: subject.tax,
            termsVersion: subject.termsVersion,
            buyerType: subject.buyerType,
            sourceDeadline: subject.sourceDeadline,
            createdByMembershipId: membership.membershipId as MembershipId,
            issuedAt: subject.issuedAt,
          });
          const role: MembershipRole = membership.role;
          const view: CreateQuoteView = {
            quote: await quoteViewOf(uow, co.request, issued.quote, role, subject.issuedAt),
            eligibility: eligibilityOf(issued),
            ...(issued.superseded !== null ? { supersededQuoteId: issued.superseded.quote.quoteId } : {}),
          };
          const committed = await uow.journal.commit(entryId, { responseStatus: 201, responseBody: view, resourceKind: "quote", resourceId: issued.quote.quoteId });
          if (committed.state !== "COMMITTED" || committed.responseStatus !== 201 || committed.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
          return { kind: "FINAL", view: committed.responseBody as CreateQuoteView };
        });
        if (first.kind === "REPLAY") return { kind: "COMPLETED", status: 201, view: first.view, version: versionOfView(first.view), replayed: true };
        if (first.kind === "FINAL") return { kind: "COMPLETED", status: 201, view: first.view, version: versionOfView(first.view), replayed: false };

        // the replacement: the intent is durable; the payment service re-binds the purchase; the last transaction answers (D10-QUOTE-4)
        if (!first.resumed) await co.hold?.("AFTER_INTENT");
        const role = held.membership === null ? null : held.membership.role;
        const settled = await settleReplacement(runtime, co, first.replacement, envelope.correlationId);
        // the re-binding did not answer within its bound: the intent stays durable and the entry open; the same key resumes (202, D10-GAP-6a)
        if (settled.kind === "PENDING") {
          return { kind: "ACCEPTED", status: 202, operationId: first.replacement.toQuoteId, state: "ISSUED", statusPath: `/api/v1/quotes/${first.replacement.toQuoteId}`, pollAfterSeconds: REPLACEMENT_POLL_AFTER_SECONDS };
        }
        await co.hold?.("AFTER_SETTLE");
        const view = await completeReplacement(runtime, co, first.replacement, settled, { context, identity, role });
        return { kind: "COMPLETED", status: 201, view: view.view, version: versionOfView(view.view), replayed: view.replayed };
      } catch (e) {
        if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
        // a second live quote refused by quotes_one_live_per_project (sqlstate.ts: STALE_VERSION without the row) answers with the project's quote
        if (e instanceof LiveQuoteChangedFailure) {
          const stale = await runtime.unitOfWork.run(context, (uow) => staleLiveQuote(co.reads(uow), agencyId, projectId));
          stale.cause = e;
          return resultOf<CreateQuoteView>(stale, envelope.correlationId);
        }
        if (accessDenied || DENIAL_CODES.has(e.code)) await recordCommerceDenial(runtime, context, spec.id, e, agencyId);
        return resultOf<CreateQuoteView>(e, envelope.correlationId);
      }
    },
  };
}

function registryPolicyLaunchUnits(): number {
  const capacity = (registryPolicy() as { readonly capacity: { readonly launchSourceUnits: number } }).capacity;
  return capacity.launchSourceUnits;
}

/** The base amount of the units' band under the registry policy (null: nothing to sell). */
export function baseCentsOf(mode: ProjectRecord["mode"], units: number): bigint | null {
  return baseServiceCents(registryPricePolicy(), mode, units);
}

