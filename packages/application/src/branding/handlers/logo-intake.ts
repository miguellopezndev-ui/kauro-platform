/**
 * The logo intake — POST /api/v1/agencies/{agencyId}/branding/logos — AGENCY_OWNER_OR_ADMIN (order 7; docs/design/B13-branding.md).
 * Not a catalogue command: a stored logo changes no aggregate and grants nothing until CMD008 names it, so the intake takes no journal
 * entry and no version; it is content-idempotent instead — the same image again answers the stored logo with created false (200),
 * whatever id the first request minted (B07's selection manifest intake is its template).
 *
 * Order (manual 10, as for every route): the document's admission (content type, size, strict JSON with this route's string bound, the
 * closed document schema: PNG declared, base64, SHA-256, rights confirmed; path ids, the agency selector) → the authenticated subject → the
 * access decision of the reads (ACTIVE live membership after its transition lock) and the route's own role (OWNER or ADMIN:
 * ROLE_INSUFFICIENT, a recorded denial) → the agency of the path is the caller's (NOT_FOUND) → the agency is DRAFT or ACTIVE, read under
 * its shared transition lock (AGENCY_NOT_OPEN) → the bytes are the canonical base64 of what the uploader hashed (LOGO_DIGEST_MISMATCH) →
 * the safe media pipeline (@kauro/domain admitLogo: LOGO_TOO_LARGE, LOGO_FORMAT_UNSUPPORTED, LOGO_MALFORMED, LOGO_DIMENSIONS_OUT_OF_RANGE)
 * → the platform's PNG stored once per (agency, SHA-256) by the caller's own membership, under row security bound to the agency.
 *
 * Nothing here takes a URL or opens a connection to anything but the database: the bytes are the body's.
 */
import { createHash } from "node:crypto";
import type { AgencyId, MembershipId, UnitOfWork } from "@kauro/domain";
import { DomainFailure, admitLogo, assertAgencyOpen, roleSatisfies } from "@kauro/domain";
import { runReadIn, type ReadContext, type ReadRuntime } from "../../queries/reads.js";
import type { IntakeHandler } from "../../sources/handlers/intake.js";
import { BRANDING_INTAKE_ROUTES, BRANDING_LOGO_INTAKE_ROLE, type BrandingStores } from "../contracts.js";
import { brandingLogoView } from "../projections.js";
import type { BrandingLogoDocument } from "../request-schemas.js";
import type { BrandingLogoIntakeView } from "../views.js";

export interface BrandingIntakeHandlers {
  readonly SubmitBrandingLogo: IntakeHandler<BrandingLogoIntakeView>;
}

function member(ctx: ReadContext) {
  if (ctx.membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an agency intake was authorized without a membership");
  return ctx.membership;
}

/** The bytes of a canonical base64 text (the one spelling that encodes them back to itself), or null. */
function canonicalBytesOf(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, "base64");
  return bytes.length > 0 && bytes.toString("base64") === text ? new Uint8Array(bytes) : null;
}

export function createBrandingIntakeHandlers(runtime: ReadRuntime, stores: BrandingStores): BrandingIntakeHandlers {
  const spec = BRANDING_INTAKE_ROUTES.SubmitBrandingLogo;
  const submit: IntakeHandler<BrandingLogoIntakeView> = {
    spec,
    async execute(request) {
      const run = <T>(context: Parameters<ReadRuntime["unitOfWork"]["run"]>[0], work: (uow: UnitOfWork) => Promise<T>): Promise<T> => runtime.unitOfWork.run(context, work);
      const result = await runReadIn<BrandingLogoIntakeView, UnitOfWork>(spec, runtime, request, run, async (uow, ctx) => {
        const membership = member(ctx);
        if (!roleSatisfies(BRANDING_LOGO_INTAKE_ROLE, membership.role)) throw new DomainFailure("NOT_AUTHORIZED", "the logo intake needs an OWNER or ADMIN", { reason: "ROLE_INSUFFICIENT" });
        const agencyId = request.path["agencyId"] as AgencyId;
        if (agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "agency not visible");
        const agency = await uow.agencies.lockShared(agencyId);
        if (agency === null) throw new DomainFailure("NOT_FOUND", "agency not visible");
        assertAgencyOpen(agency);
        const document = request.body as BrandingLogoDocument;
        const bytes = canonicalBytesOf(document.contentBase64);
        if (bytes === null || createHash("sha256").update(bytes).digest("hex") !== document.contentSha256) {
          throw new DomainFailure("INVALID_REQUEST", "the content is not the canonical base64 of the bytes contentSha256 names", { reason: "LOGO_DIGEST_MISMATCH", fields: [{ field: "contentSha256", code: "FORMAT" }] });
        }
        const admitted = admitLogo(bytes);
        if (!admitted.ok) throw new DomainFailure("INVALID_REQUEST", `the logo was refused by the safe media pipeline: ${admitted.detail}`, { reason: admitted.problem });
        const stored = await stores.branding(uow).recordLogo({
          agencyId,
          logoId: uow.ids.next(),
          recordedByMembershipId: membership.membershipId as MembershipId,
          bytes: admitted.logo.bytes,
          sha256: admitted.logo.sha256,
          width: admitted.logo.width,
          height: admitted.logo.height,
        });
        return { ...brandingLogoView(stored.logo), agencyId, created: stored.created };
      });
      if (result.kind === "PROBLEM") return result;
      return { kind: "STORED", created: result.view.created, view: result.view };
    },
  };
  return Object.freeze({ SubmitBrandingLogo: submit });
}
