/**
 * The views of the branding package (order 7): compile-time shapes of the closed schemas in branding/response-views, member for member.
 * The brand name is the agency's own text; the logo is named by its id and its SHA-256, never by its bytes or a URL.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyView } from "../api/views.js";

/** A logo the safe media pipeline stored for the agency. */
export interface BrandingLogoView {
  readonly logoId: string;
  readonly sha256: string;
  readonly mediaType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
}

/** One recorded branding version (immutable; the reports of the jobs bound to it print it). */
export interface BrandingVersionView {
  readonly agencyId: string;
  readonly brandingVersion: number;
  readonly displayName: string;
  /** Absent when the version names no logo. */
  readonly logo?: BrandingLogoView;
  readonly recordedAt: UtcInstant;
}

/** CMD008: the agency at its new version and the branding version the command recorded. */
export interface UpdateBrandingView {
  readonly agency: AgencyView;
  readonly branding: BrandingVersionView;
}

/** The logo intake: the stored logo; created false when the same image was already stored for the agency. */
export interface BrandingLogoIntakeView extends BrandingLogoView {
  readonly agencyId: string;
  readonly created: boolean;
}
