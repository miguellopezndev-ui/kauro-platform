/**
 * The closed outcome catalogues of the branding routes (order 7; docs/design/B13-branding.md), composed from the pipeline's shared
 * entries exactly as every other package composes its own (api/outcome-kit). They join COMMAND_OUTCOMES and INTAKE_OUTCOMES
 * (api/outcomes): the api's send guard refuses any other problem, the OpenAPI document lists them per status and the matrix is
 * generated from them.
 */
import { OUTCOME_BLOCKS, closedCatalogue, problemOutcome as outcome, type ProblemOutcome } from "../api/outcome-kit.js";
import type { BrandingCommandId, BrandingIntakeId } from "./contracts.js";

const { EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, COOKIE_CSRF } = OUTCOME_BLOCKS;

const NOT_VISIBLE_AGENCY = outcome("COMMAND", "NOT_FOUND", null, "the agency is not visible to the caller (another agency's path answers as a nonexistent one)");

/** CMD008: the agency's version, its state, the printable name and the stored logo of this agency. */
const CMD008: ReadonlyArray<ProblemOutcome> = Object.freeze([
  NOT_VISIBLE_AGENCY,
  outcome("COMMAND", "STALE_VERSION", null, "expectedVersion is not the agency's current version (another branding change or agency edit committed first); nothing was recorded and the current safe version and state come back", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_OPEN", "the agency is not DRAFT or ACTIVE: it records no new branding", { current: "ALWAYS" }),
  outcome("COMMAND", "INVALID_REQUEST", "BRANDING_NAME_UNPRINTABLE", "the name is padded, longer than 120 characters, not NFC, or holds a control, format, separator or markup-significant character a report could not print; nothing was recorded", { fieldCodes: ["FORMAT"] }),
  outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "logoArtifactRef is not a logo this agency stored through the logo intake (another agency's logo answers as a nonexistent one)", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
  outcome("COMMAND", "INTEGRITY_FAILURE", "LOGO_MALFORMED", "the stored logo the request names no longer decodes as the pipeline's PNG of its recorded size; nothing was recorded"),
]);

const COMMAND_SPECIFIC: Readonly<Record<BrandingCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({ CMD008 });

/** The closed problem catalogue of the branding command (the agency comes from the path: no agency selector). */
export const BRANDING_COMMAND_OUTCOMES: Readonly<Record<BrandingCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD008: closedCatalogue("CMD008", [...EVERY_ROUTE, ...COOKIE_CSRF, ...PATH_IDS, ...TENANT, ...COMMAND_SPECIFIC.CMD008]),
});

/**
 * The logo intake: non-journaled and content-idempotent, so a body admission route without an idempotency key; each refusal of the
 * safe media pipeline is its own outcome, and none stores anything.
 */
export const BRANDING_INTAKE_OUTCOMES: Readonly<Record<BrandingIntakeId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  SubmitBrandingLogo: closedCatalogue("SubmitBrandingLogo", [
    ...EVERY_ROUTE.filter((o) => o.layer !== "IDEMPOTENCY" && o.reason !== "IDEMPOTENCY_KEY_MISSING" && o.reason !== "IDEMPOTENCY_KEY_INVALID"),
    ...COOKIE_CSRF,
    ...PATH_IDS,
    ...TENANT,
    ...AGENCY_HEADER,
    NOT_VISIBLE_AGENCY,
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_OPEN", "the agency is not DRAFT or ACTIVE: it stores no new logo", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "LOGO_DIGEST_MISMATCH", "contentSha256 is not the SHA-256 of the bytes received, or contentBase64 is not canonical base64: nothing was stored", { fieldCodes: ["FORMAT"] }),
    outcome("COMMAND", "INVALID_REQUEST", "LOGO_FORMAT_UNSUPPORTED", "the file is not a PNG (SVG, HTML, script, JPEG, GIF, WebP or anything else) or is an animated PNG: nothing was parsed or stored"),
    outcome("COMMAND", "INVALID_REQUEST", "LOGO_MALFORMED", "the PNG is broken or forged (a chunk's length, type or CRC, the chunk order, the image data, a filter, a palette index, bytes after IEND) or its data inflates past what its header implies: nothing was stored"),
    outcome("COMMAND", "INVALID_REQUEST", "LOGO_TOO_LARGE", "the file, or the PNG written again from its pixels, is larger than 512 KiB: nothing was stored"),
    outcome("COMMAND", "INVALID_REQUEST", "LOGO_DIMENSIONS_OUT_OF_RANGE", "the image is not 1..2048 pixels a side: nothing was stored"),
  ]),
});
