// The agency's branding (package B13, order 7; docs/design/B13-branding.md): CMD008 UpdateBranding and the logo intake.
export type { UpdateBrandingBody, UpdateBrandingHandler, BrandingCommandId, BrandingIntakeId, BrandingStores } from "./contracts.js";
export { UPDATE_BRANDING, BRANDING_COMMANDS, BRANDING_INTAKE_ROUTES, BRANDING_LOGO_INTAKE_ROLE } from "./contracts.js";
export type { BrandingLogoDocument } from "./request-schemas.js";
export { BRANDING_LOGO_SCHEMA_ID, BRANDING_LOGO_SCHEMA, BRANDING_LOGO_BASE64_MAX_LENGTH } from "./request-schemas.js";
export type { BrandingLogoView, BrandingVersionView, UpdateBrandingView, BrandingLogoIntakeView } from "./views.js";
export { BRANDING_VIEW_DEFINITIONS, BRANDING_COMMAND_RESPONSES } from "./response-views.js";
export { BRANDING_COMMAND_OUTCOMES, BRANDING_INTAKE_OUTCOMES } from "./outcomes.js";
export { brandingLogoView, brandingVersionView } from "./projections.js";
export { updateBrandingHandler } from "./handlers/update-branding.js";
export type { BrandingIntakeHandlers } from "./handlers/logo-intake.js";
export { createBrandingIntakeHandlers } from "./handlers/logo-intake.js";

import type { CommandRuntime } from "../commands/runtime.js";
import type { BrandingStores, UpdateBrandingHandler } from "./contracts.js";
import { updateBrandingHandler } from "./handlers/update-branding.js";

/** The branding package's command handlers (B13): CMD008, served beside the others. */
export interface BrandingHandlers {
  readonly CMD008: UpdateBrandingHandler;
}

export function createBrandingHandlers(runtime: CommandRuntime, stores: BrandingStores): BrandingHandlers {
  return Object.freeze({ CMD008: updateBrandingHandler(runtime, stores) });
}
