/**
 * CMD002 ActivateAgency — POST /api/v1/agencies/{agencyId}/activate — AGENCY_OWNER — scope AGENCY_PATH — no provider effect (design §4, §8.1,
 * §12; decisions D10-AGY-1, D10-CTX-1; registry "record versioned acceptance and activate only eligible capabilities"; "missing agreements
 * or a mismatched billing identity leave the agency draft; no implicit signature").
 *
 * One unit of work of the owner's own TENANT context, in B06's pipeline order: access (B06 authorizer: the agency's ACTIVE OWNER, read after
 * its membership's transition lock) → journal reserve (or the replay of the journaled 200) → the body, the first failure answering:
 * the agency FOR UPDATE (it exists: the membership was found) → expectedVersion (STALE_VERSION with the current version and state) → DRAFT
 * (AGENCY_NOT_DRAFT) → the terms and privacy versions the PUBLISHED ones, each read after its shared transition lock
 * (AGREEMENT_VERSION_NOT_PUBLISHED: no default, no implicit signature) → billingProfileRef the agency's current fiscal profile
 * (BILLING_PROFILE_MISMATCH; another agency's profile is not visible to the policies, so it answers as an unknown one) with a reviewed
 * treatment (FISCAL_TREATMENT_UNREVIEWED). Writes: one append-only acceptance naming both versions, their document hashes and the owner's
 * membership at the server's instant, and the agency ACTIVE at version + 1 with the versions and its legal profile (the reviewed billing
 * profile) — agency.activated.v1. The capabilities now offered are answered, never written. The database repeats each rule: B06's
 * agencies_activation_requires_agreements and agencies_authority (KA010), the acceptance's guard (23514, KA010) and its foreign keys.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId, AgreementAcceptanceId, CausationId, FiscalProfileId, ServiceMode } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, SERVICE_MODES, activateAgency as activateAgencyOutcome, isOffered } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { agencyView } from "../../api/projections.js";
import { CommerceAccessDenied, runCommerceCommand, tenantContextOf, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { ACTIVATE_AGENCY, type ActivateAgencyBody } from "../contracts.js";
import type { AgencyActivationView } from "../views.js";
import { commercialAdmissionSpecOf, type AgencyLifecycleCollaborators, type CommercialCommandHandler } from "./runtime.js";
import { applied, checkExpectedVersion, requireMembershipOf } from "./shared.js";

export function activateAgencyHandler(runtime: CommerceRequestRuntime, co: AgencyLifecycleCollaborators): CommercialCommandHandler<ActivateAgencyBody, AgencyActivationView> {
  const spec = ACTIVATE_AGENCY;
  return {
    spec,
    admission: commercialAdmissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<ActivateAgencyBody>): Promise<CommandResult<AgencyActivationView>> {
      const context = tenantContextOf(envelope);
      const agencyId = context.agencyId;
      let membership: ReturnType<typeof requireMembershipOf> | null = null;
      return runCommerceCommand<ActivateAgencyBody, AgencyActivationView>(runtime, {
        command: { id: spec.id, journalScope: "TENANT" },
        envelope,
        context,
        async access(uow) {
          const decision = await runtime.authorizer.authorize(uow, { command: "CMD002", identity: envelope.subject.identity, agencyId });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD002", decision);
          membership = requireMembershipOf(decision.membership);
        },
        async body(uow, causationId: CausationId, now: UtcInstant) {
          if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an activation was authorized without a membership");
          const body = envelope.body;
          const life = co.lifecycle(uow);
          // the agency's exclusive half, then its row (D10-TX-1): a reader of the DRAFT agency (CMD009, CMD011) holds the shared half
          // while its inserts wait for the row's KEY SHARE, so the row first and the half after (the transition trigger) could deadlock
          await life.lockTransition(agencyId);
          const agency = await uow.agencies.lock(agencyId);
          if (agency === null) throw new NotFoundFailure("agency");
          checkExpectedVersion(agency, body.expectedVersion);
          if (agency.state !== "DRAFT") {
            throw new DomainFailure("PRECONDITION_FAILED", "the agency is not DRAFT", { reason: "AGENCY_NOT_DRAFT", currentVersion: agency.version, currentState: agency.state });
          }
          // the published versions, each read after its shared transition lock (held to COMMIT: a retirement in flight is ordered before or after)
          const terms = await life.publishedVersion("TERMS", body.termsVersion);
          const privacy = await life.publishedVersion("PRIVACY", body.privacyAgreementVersion);
          if (terms === null || privacy === null) {
            throw new DomainFailure("PRECONDITION_FAILED", "an agreement version is not the published one: no default, no implicit signature", { reason: "AGREEMENT_VERSION_NOT_PUBLISHED" });
          }
          // the agency's current fiscal profile with a reviewed treatment (read after the profile's transition lock by the adapter)
          const profile = await uow.commerce.fiscal.currentProfile(agencyId);
          if (profile === null || profile.profileId !== (body.billingProfileRef as FiscalProfileId)) {
            throw new DomainFailure("PRECONDITION_FAILED", "billingProfileRef is not the agency's current fiscal profile", { reason: "BILLING_PROFILE_MISMATCH" });
          }
          if (profile.taxTreatment === "REVIEW_REQUIRED" || profile.taxRule === "UNRESOLVED" || profile.reviewedByUserId === undefined) {
            throw new DomainFailure("PRECONDITION_FAILED", "the agency's fiscal profile carries no reviewed treatment", { reason: "FISCAL_TREATMENT_UNREVIEWED" });
          }
          // the domain's own edge (agreements_and_profile_accepted) with its guard: the accepted versions are the published ones
          const outcome = activateAgencyOutcome(agency, {
            expectedVersion: body.expectedVersion,
            termsVersion: terms.version,
            privacyAgreementVersion: privacy.version,
            legalProfileRef: profile.profileId,
            required: { termsVersion: terms.version, privacyAgreementVersion: privacy.version },
            now,
          });
          const acceptance = await life.recordAcceptance({
            acceptanceId: uow.ids.next() as AgreementAcceptanceId,
            agencyId: agencyId as AgencyId,
            membershipId: membership.membershipId,
            terms,
            privacy,
            legalProfileRef: profile.profileId,
            acceptedAt: now,
          });
          const next = applied(await uow.agencies.transition(agencyId, agency.version, { state: outcome.agency.state, termsVersion: terms.version, privacyAgreementVersion: privacy.version, legalProfileRef: profile.profileId }, now));
          await uow.events.publish({
            aggregateKind: "agency",
            aggregateId: agencyId,
            aggregateVersion: next.version,
            agencyId,
            eventType: "agency.activated.v1",
            actor: { kind: "USER", userId: envelope.userId },
            causationId,
            correlationId: envelope.correlationId,
            payload: outcome.event.payload,
          });
          // the modes the activated agency may be sold: the capabilities the platform offers now (none is written)
          const offered = new Set<ServiceMode>();
          for (const capability of await uow.capabilities.list()) if (capability.kind === "MODE" && capability.mode !== undefined && isOffered(capability)) offered.add(capability.mode);
          const offeredModes = SERVICE_MODES.filter((mode) => offered.has(mode));
          return {
            status: 200,
            view: { agency: agencyView(next, membership.role), acceptedAt: acceptance.acceptedAt, offeredModes },
            version: next.version,
            resourceKind: "agency",
            resourceId: agencyId,
          };
        },
      });
    },
  };
}
