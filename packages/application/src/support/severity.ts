/**
 * The severity of a support case (B11 CMD044; design section 5, W4 row). The requester never chooses it: the category decides it,
 * so a form cannot ask for the fastest review by naming an impact, and a client that omits it gets the same answer as one that
 * would have guessed it. S1 (an outage of the whole service) stays in the registry vocabulary for the operations side; no
 * category of a member's request maps to it.
 */
import type { SupportCategory, SupportSeverity } from "@kauro/domain";

export const SUPPORT_SEVERITY_BY_CATEGORY: Readonly<Record<SupportCategory, SupportSeverity>> = Object.freeze({
  SECURITY: "S2",
  PRIVACY: "S2",
  PRODUCT_DEFECT: "S3",
  BILLING: "S3",
  IMPORT_GUIDANCE: "S4",
  GENERAL: "S4",
});

export function severityOf(category: SupportCategory): SupportSeverity {
  return SUPPORT_SEVERITY_BY_CATEGORY[category];
}
