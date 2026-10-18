/** The branding records as their closed views (branding/views): a selection, never the record wholesale. */
import type { BrandingLogoRecord, BrandingVersionRecord } from "@kauro/domain";
import type { UtcInstant } from "@kauro/contracts";
import type { BrandingLogoView, BrandingVersionView } from "./views.js";

export function brandingLogoView(logo: BrandingLogoRecord): BrandingLogoView {
  return { logoId: logo.logoId, sha256: logo.sha256, mediaType: logo.mediaType, width: logo.width, height: logo.height, byteLength: logo.byteLength };
}

/** A recorded instant (exact, microseconds) as a view's UTC instant: milliseconds, Z. */
const utcOf = (exact: string): UtcInstant => new Date(exact).toISOString() as UtcInstant;

export function brandingVersionView(v: BrandingVersionRecord): BrandingVersionView {
  return {
    agencyId: v.agencyId,
    brandingVersion: v.version,
    displayName: v.displayName,
    ...(v.logo !== null ? { logo: brandingLogoView(v.logo) } : {}),
    recordedAt: utcOf(v.recordedAt),
  };
}
