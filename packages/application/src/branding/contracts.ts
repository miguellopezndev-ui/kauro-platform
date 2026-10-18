/**
 * The agency's branding (package B13, order 7; docs/design/B13-branding.md): CMD008 UpdateBranding and the logo intake its
 * `logoArtifactRef` names. Behaviour — the order of the checks, the locks, the writes, OK/DENY/RACE — is in the design document and the
 * handlers (branding/handlers); the storage is migrations 0095 and 0096.
 *
 * - CMD008 runs B06's pipeline (access decision, journal reserve or replay, the body, journal commit) like every registry command: an
 *   OWNER or ADMIN of the agency in the path records a new branding version for future reports; the agency's version is the aggregate
 *   version the request names, so two requests naming the same version record one branding version and the other is refused STALE.
 * - The logo intake is not a registry command: it changes no aggregate, so it takes no journal entry and no version; it is
 *   content-idempotent instead (B07 D-SEL-2's selection manifest intake is its template). It is the safe media pipeline's door: the
 *   bytes come in the body (never a URL), are decoded and written again as the platform's own PNG, and stored for the agency only.
 *   A stored logo grants nothing: CMD008 cites it by reference and re-reads it.
 */
import type { BrandingVersionRepository, UnitOfWork } from "@kauro/domain";
import type { CommandHandler, CommandSpec } from "../ports/command-handler.js";
import type { IntakeSpec } from "../sources/handlers/intake.js";
import { BRANDING_LOGO_BASE64_MAX_LENGTH, BRANDING_LOGO_SCHEMA_ID } from "./request-schemas.js";
import type { UpdateBrandingView } from "./views.js";

export interface UpdateBrandingBody {
  /** The agency's version (Agency.version): the version the caller last read; the branding change moves it by one. */
  readonly expectedVersion: number;
  /** The brand name future reports print ("Prepared by …"); never the issuer's legal name, which reports print apart. */
  readonly displayName: string;
  /** A logo the agency stored through the logo intake; absent, the version names no logo. */
  readonly logoArtifactRef?: string;
}
export const UPDATE_BRANDING: CommandSpec<UpdateBrandingBody> = Object.freeze({
  id: "CMD008",
  name: "UpdateBranding",
  method: "POST",
  path: "/api/v1/agencies/{agencyId}/branding",
  role: "AGENCY_OWNER_OR_ADMIN",
  scope: "AGENCY_PATH",
  aggregateParam: "agencyId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "displayName", "logoArtifactRef"],
} satisfies CommandSpec<UpdateBrandingBody>);
export type UpdateBrandingHandler = CommandHandler<UpdateBrandingBody, UpdateBrandingView>;

/** The branding package's commands (B13): served beside the others, which stay closed sets. */
export const BRANDING_COMMANDS = Object.freeze({ CMD008: UPDATE_BRANDING } as const);
export type BrandingCommandId = keyof typeof BRANDING_COMMANDS;

/** The logo intake (not a registry command). */
export type BrandingIntakeId = "SubmitBrandingLogo";

/** The role the logo intake needs: the role of the command that cites what it stores (CMD008). */
export const BRANDING_LOGO_INTAKE_ROLE = UPDATE_BRANDING.role;

export const BRANDING_INTAKE_ROUTES: Readonly<Record<BrandingIntakeId, IntakeSpec>> = Object.freeze({
  SubmitBrandingLogo: Object.freeze({
    operationId: "SubmitBrandingLogo",
    method: "POST",
    path: "/api/v1/agencies/{agencyId}/branding/logos",
    action: "SUBMIT_BRANDING_LOGO",
    scope: "AGENCY_HEADER",
    schemaId: BRANDING_LOGO_SCHEMA_ID,
    maxStringLength: BRANDING_LOGO_BASE64_MAX_LENGTH,
    summary: "Stores an agency logo through the safe media pipeline (a PNG decoded and written again; content-idempotent; CMD008 names it by reference)",
    authority:
      "registry CMD008 precondition (\"The logo passed the safe media pipeline; branding rights and tenant scope are confirmed\") and failure (\"Unsafe SVG/script, invalid media or a foreign artifact reject; no remote image fetch from arbitrary URLs\"); B07 D-SEL-2: a non-journaled, content-idempotent intake; AGENCY_OWNER_OR_ADMIN",
  }),
});

/** The branding store in the caller's unit of work (bound by the api composition to the persistence adapter: migrations 0095, 0096). */
export interface BrandingStores {
  branding(uow: UnitOfWork): BrandingVersionRepository;
}
