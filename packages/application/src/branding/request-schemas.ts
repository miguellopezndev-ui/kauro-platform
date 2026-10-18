/**
 * The closed document of the logo intake (order 7; docs/design/B13-branding.md). CMD008's own request schema is B06's (api/request-
 * schemas REQUEST_SCHEMAS.CMD008): its members are exactly the registry fields.
 *
 * The logo travels as the bytes themselves, base64 in the JSON body (B12 D-B12S-2's bank evidence upload is the precedent): no URL, so
 * nothing is ever fetched. The media type is PNG only — the one format the pipeline decodes (an SVG, a script or a JPEG is refused here or
 * by the pipeline, never stored). The SHA-256 the uploader computed is compared with the bytes received. `rightsConfirmed` is the
 * uploader's statement that the agency may use the logo on its reports (terms of service 15.3: "The brand, logo and colors the Customer
 * uploads remain its own; Kauro uses them only to generate its reports").
 */
import { LOGO_MAX_BYTES } from "@kauro/domain";

/** Document schema id of the logo intake. */
export const BRANDING_LOGO_SCHEMA_ID = "urn:kauro:api:v1:document:BrandingLogo" as const;

/** The canonical base64 of at most LOGO_MAX_BYTES bytes: the parser's string bound for this route (the body bound, 1 MiB, is unchanged). */
export const BRANDING_LOGO_BASE64_MAX_LENGTH = Math.ceil(LOGO_MAX_BYTES / 3) * 4;

export const BRANDING_LOGO_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: BRANDING_LOGO_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: ["mediaType", "contentBase64", "contentSha256", "rightsConfirmed"],
  properties: {
    mediaType: { type: "string", enum: ["image/png"] },
    contentBase64: { type: "string", minLength: 4, maxLength: BRANDING_LOGO_BASE64_MAX_LENGTH, pattern: "^[A-Za-z0-9+/]*={0,2}$" },
    contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    rightsConfirmed: { type: "boolean", const: true },
  },
} as const);

export interface BrandingLogoDocument {
  readonly mediaType: "image/png";
  readonly contentBase64: string;
  readonly contentSha256: string;
  readonly rightsConfirmed: true;
}
