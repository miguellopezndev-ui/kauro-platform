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
  ResolvedMembership,
  TaxRuleSnapshot,
} from "@kauro/domain";
import {
  DomainFailure,
  IdempotencyConflictFailure,
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
import type { QuoteCollaborators } from "./runtime.js";

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
            if (issuance === null || issuance.replacesQuoteId === undefined) throw refuse("OPERATION_PENDING", "the same logical operation is still pending");
            return { kind: "REPLACEMENT", replacement: await replacementContextOf(uow, co, issuance), resumed: true };
          }
          const entryId = reservation.entryId;
          const membership = held.membership;
          if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "a quote was authorized without a membership");
          const subject = await subjectOf(uow);
          const c = uow.commerce;
          const reads = co.reads(uow);
          // the project's live quote FOR UPDATE (§10: after the shared halves, before the recurrence lock)
          const liveId = await reads.liveQuoteOf(agencyId, projectId);
          const live = liveId === null ? null : await c.quotes.lock(liveId);
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

