/**
 * The closed view schemas of the branding package (order 7; branding/views is their compile-time form), declared with the view kit as
 * every other package's views are, and joined to the served ones (api/response-schemas VIEW_DEFINITIONS).
 */
import { RESPONSE_FIELD_VOCABULARY, VIEW_MEMBER_KIT, type ViewDefinition } from "../api/view-kit.js";
import { LOGO_MAX_BYTES, LOGO_MAX_PIXELS } from "@kauro/domain";
import type { BrandingCommandId } from "./contracts.js";

const { ID, VERSION, HASH, UTC } = RESPONSE_FIELD_VOCABULARY;
const { platform, ref } = VIEW_MEMBER_KIT;
const SIDE = Object.freeze({ type: "integer", minimum: 1, maximum: LOGO_MAX_PIXELS });
const LOGO_BYTES = Object.freeze({ type: "integer", minimum: 1, maximum: LOGO_MAX_BYTES });
const MEDIA_TYPE = Object.freeze({ type: "string", enum: ["image/png"] });
/** The brand name as recorded: 1..120 characters a report can print (migration 0095 agency_branding_versions_printable). */
const BRAND_NAME = Object.freeze({ type: "string", minLength: 1, maxLength: 120, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f<>\"'&`]+$" });

const LOGO_MEMBERS = {
  logoId: platform(true, ID, "The stored logo's id: the logoArtifactRef CMD008 names."),
  sha256: platform(true, HASH, "SHA-256 of the PNG the platform wrote from the upload's pixels: the value a branding version and a report name."),
  mediaType: platform(true, MEDIA_TYPE, "image/png: the one format the pipeline writes."),
  width: platform(true, SIDE, "Pixels, as the PNG's header states them."),
  height: platform(true, SIDE, "Pixels, as the PNG's header states them."),
  byteLength: platform(true, LOGO_BYTES, "The stored PNG's size in bytes."),
} as const;

export const BRANDING_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "BrandingLogoView",
    description: "A logo the safe media pipeline stored for the agency (order 7): named by id and SHA-256, never by its bytes or a URL.",
    contract: null,
    withheld: {},
    members: LOGO_MEMBERS,
  },
  {
    name: "BrandingVersionView",
    description: "One recorded branding version of the agency: immutable; the reports of a job print the version in force when the job was queued (migration 0095).",
    contract: null,
    withheld: {},
    members: {
      agencyId: platform(true, ID, "The agency the version belongs to."),
      brandingVersion: platform(true, VERSION, "The version's number: 1, 2, … in the order the agency recorded them."),
      displayName: platform(true, BRAND_NAME, "The brand name reports print (\"Prepared by …\"); never the issuer's legal identity."),
      logo: platform(false, ref("BrandingLogoView"), "The stored logo the version names; absent when it names none."),
      recordedAt: platform(true, UTC, "When the version was recorded, on the database clock."),
    },
  },
  {
    name: "UpdateBrandingView",
    description: "CMD008 UpdateBranding result: the agency at its new version and the branding version recorded for future reports.",
    contract: null,
    withheld: {},
    members: {
      agency: platform(true, ref("AgencyView"), "The agency after the change (its version moved by one)."),
      branding: platform(true, ref("BrandingVersionView"), "The branding version the command recorded."),
    },
  },
  {
    name: "BrandingLogoIntakeView",
    description: "The logo intake (order 7): stored once per agency and image; the same image again answers the stored logo with created false.",
    contract: null,
    withheld: {},
    members: {
      ...LOGO_MEMBERS,
      agencyId: platform(true, ID, "The agency the logo is stored for (the only agency that can read or name it)."),
      created: platform(true, { type: "boolean" }, "False when the same image was already stored for the agency."),
    },
  },
] satisfies ReadonlyArray<ViewDefinition>);

/** The success reply of the branding command. */
export const BRANDING_COMMAND_RESPONSES: Readonly<Record<BrandingCommandId, { readonly status: 201; readonly view: string }>> = Object.freeze({
  CMD008: { status: 201, view: "UpdateBrandingView" },
});
