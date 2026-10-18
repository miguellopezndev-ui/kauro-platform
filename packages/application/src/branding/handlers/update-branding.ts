/**
 * CMD008 UpdateBranding — POST /api/v1/agencies/{agencyId}/branding — AGENCY_OWNER_OR_ADMIN (order 7; docs/design/B13-branding.md;
 * registry: "Create a new branding version for future reports while preserving already delivered artifact identity").
 *
 * Order: authorize (live OWNER/ADMIN, membership transition lock shared to COMMIT) → reserve → the agency of the path is the caller's
 * (NOT_FOUND otherwise: another agency answers as a nonexistent one) → agency row lock (serializes every branding change of the agency
 * and its other edits) → expectedVersion of the agency (STALE_VERSION: of two requests naming one version, the second records nothing) →
 * the agency is DRAFT or ACTIVE (AGENCY_NOT_OPEN) → the name is printable (BRANDING_NAME_UNPRINTABLE) → the logo, when named, is one
 * this agency stored through the logo intake (UNKNOWN_REFERENCE; row security shows no other agency's) and still decodes as the pipeline's
 * PNG of its recorded size (LOGO_MALFORMED) → the agency's next branding version, numbered after the latest read under the lock, naming
 * that logo (0095/0096 refuse any other number, a foreign logo and an unprintable name again) → the agency at version + 1 with
 * agency.branding_versioned.v1 → journal 201.
 *
 * A recorded version never changes (append-only) and is for future jobs only: a job's reports print the version in force when the job was
 * queued, bound once at its first report (report_branding_bindings, 0095), so nothing this command does reaches a report already made,
 * published or bound. The display name is the agency's commercial brand; the issuer's legal identity is a separate record a brand never
 * replaces (R2-070).
 */
import type { AgencyId, MembershipId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, admitLogo, aggregateEvent, assertAgencyOpen, brandNameProblem, effectNowOf } from "@kauro/domain";
import { agencyView } from "../../api/projections.js";
import { runCommand, type CommandRuntime } from "../../commands/runtime.js";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { actingMember, publishAll } from "../../commands/handlers/team-shared.js";
import { UPDATE_BRANDING, type BrandingStores, type UpdateBrandingBody, type UpdateBrandingHandler } from "../contracts.js";
import { brandingVersionView } from "../projections.js";
import type { UpdateBrandingView } from "../views.js";

export function updateBrandingHandler(runtime: CommandRuntime, stores: BrandingStores): UpdateBrandingHandler {
  return {
    spec: UPDATE_BRANDING,
    execute: (envelope) =>
      runCommand<UpdateBrandingBody, UpdateBrandingView>(UPDATE_BRANDING, runtime, envelope, async (uow, ctx) => {
        const membership = requireMembership(ctx);
        const agencyId = envelope.path["agencyId"] as AgencyId;
        if (agencyId !== membership.agencyId) throw new NotFoundFailure("agency");
        const recorder = await actingMember(uow, ctx);
        const agency = await uow.agencies.lock(agencyId);
        if (agency === null) throw new NotFoundFailure("agency");
        checkExpectedVersion(agency, envelope.body.expectedVersion);
        assertAgencyOpen(agency);
        const displayName = envelope.body.displayName;
        const problem = brandNameProblem(displayName);
        if (problem !== null) {
          throw new DomainFailure("INVALID_REQUEST", `the brand name is not printable (${problem})`, { reason: "BRANDING_NAME_UNPRINTABLE", fields: [{ field: "displayName", code: "FORMAT" }] });
        }
        const branding = stores.branding(uow);
        const logoId = envelope.body.logoArtifactRef ?? null;
        if (logoId !== null) {
          const logo = await branding.logoOf(agencyId, logoId);
          if (logo === null) throw new DomainFailure("INVALID_REQUEST", "the logo is not one this agency stored", { reason: "UNKNOWN_REFERENCE", fields: [{ field: "logoArtifactRef", code: "UNKNOWN_REFERENCE" }] });
          // the stored bytes are read again and must still be what the pipeline admits, at the size recorded with them
          const bytes = await branding.logoBytesOf(agencyId, logoId);
          const again = bytes === null ? null : admitLogo(bytes);
          if (again === null || !again.ok || again.logo.width !== logo.width || again.logo.height !== logo.height) {
            throw new DomainFailure("INTEGRITY_FAILURE", "the stored logo no longer decodes as the pipeline's PNG", { reason: "LOGO_MALFORMED" });
          }
        }
        const latest = await branding.latestOf(agencyId);
        const now = await effectNowOf(uow);
        const recorded = await branding.record({
          agencyId,
          recordedByMembershipId: recorder.membershipId as MembershipId,
          displayName,
          version: (latest?.version ?? 0) + 1,
          logoId,
        });
        const next = applied(await uow.agencies.transition(agencyId, agency.version, {}, now));
        const event = aggregateEvent({
          aggregateKind: "agency",
          aggregateId: agencyId,
          aggregateVersion: next.version,
          agencyId,
          eventType: "agency.branding_versioned.v1",
          payload: {
            agencyId,
            brandingVersion: recorded.version,
            ...(recorded.logo !== null ? { logoId: recorded.logo.logoId, logoSha256: recorded.logo.sha256 } : {}),
            byMembershipId: recorder.membershipId,
          },
        });
        await publishAll(uow, ctx, envelope, [event], [{ eventType: "agency.branding_versioned.v1" }]);
        return {
          status: 201,
          view: { agency: agencyView(next, membership.role), branding: brandingVersionView(recorded) },
          version: next.version,
          resourceKind: "agency",
          resourceId: agencyId,
        };
      }),
  };
}
