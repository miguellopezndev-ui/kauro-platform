// The synthetic people the review can be seen as (Order 11 §5). Each is a session and, inside an agency, the agency's own answer with the
// actions the api permits that person; nothing here grants anything: the real screens draw what these answers say, as they would draw the
// api's. Every name is invented and every address uses a reserved domain.
import type { AgencyView, getCurrentSessionResponse200 } from "@web/api/generated.ts";

export type ContextKey = "agency" | "company" | "operator" | "seller" | "owner" | "outsider";

export interface ReviewContext {
  readonly key: ContextKey;
  readonly label: string;
  readonly who: string;
  /** The tenant this person works in, or null on the private (ops) origin. */
  readonly agency: AgencyView | null;
  readonly buyerType: "agency" | "in-house" | null;
  /** True when the api answers this person's agency reads with a refusal (not a member). */
  readonly refused: boolean;
}

export const AGENCY_ID = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1";
export const COMPANY_ID = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb9";

const ALL_ACTIONS: AgencyView["permittedActions"] = [
  "MANAGE_AGENCY",
  "MANAGE_TEAM",
  "MANAGE_CLIENTS",
  "CREATE_CLIENTS",
  "OPERATE_PROJECTS",
  "APPROVE_PLANS",
  "MANAGE_BILLING",
  "REQUEST_DELETION",
  "MANAGE_BRANDING",
  "VIEW",
];

const agency = (agencyId: string, displayName: string, permittedActions: AgencyView["permittedActions"]): AgencyView => ({
  agencyId,
  version: 7,
  displayName,
  state: "ACTIVE",
  termsVersion: "TERMS_2026_10",
  privacyAgreementVersion: "DPA_2026_10",
  createdAt: "2026-09-02T14:20:00Z",
  permittedActions,
});

export const CONTEXTS: Readonly<Record<ContextKey, ReviewContext>> = {
  agency: { key: "agency", label: "Agency owner", who: "Lena Ortiz, owner of Northwind Data (an agency with several clients)", agency: agency(AGENCY_ID, "Northwind Data", ALL_ACTIONS), buyerType: "agency", refused: false },
  company: { key: "company", label: "Direct company", who: "Tomas Reyes, owner of Halden Outdoor (a company buying for its own data)", agency: agency(COMPANY_ID, "Halden Outdoor", ALL_ACTIONS), buyerType: "in-house", refused: false },
  operator: { key: "operator", label: "Agency operator", who: "Priya Nair, operator at Northwind Data (runs projects; cannot manage the team, billing or the agency)", agency: agency(AGENCY_ID, "Northwind Data", ["OPERATE_PROJECTS", "CREATE_CLIENTS", "VIEW"]), buyerType: "agency", refused: false },
  seller: { key: "seller", label: "Seller", who: "Daniel Kim, an independent seller (sales screens only; no client data)", agency: null, buyerType: null, refused: false },
  owner: { key: "owner", label: "Kauro owner", who: "The Kauro owner on the operations origin (no customer CRM data)", agency: null, buyerType: null, refused: false },
  outsider: { key: "outsider", label: "No access", who: "A signed-in person who is not a member of this agency", agency: agency(AGENCY_ID, "Northwind Data", ["VIEW"]), buyerType: "agency", refused: true },
};

/** The contexts that make sense for a screen of each origin (the others are offered as "no access"). */
export const CONTEXTS_FOR = {
  APP: ["agency", "company", "operator", "outsider"],
  OPS: ["owner", "seller", "outsider"],
} as const satisfies Readonly<Record<"APP" | "OPS", readonly ContextKey[]>>;

export function sessionFor(now: number): getCurrentSessionResponse200 {
  return {
    userId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7a01",
    emailVerified: true,
    mfaEnrolled: true,
    mfaAt: new Date(now - 3_600_000).toISOString(),
    stepUpFreshUntil: null,
    idleExpiresAt: new Date(now + 8 * 3_600_000).toISOString(),
    absoluteExpiresAt: new Date(now + 12 * 3_600_000).toISOString(),
    csrfToken: "review-csrf-synthetic-not-a-secret".padEnd(43, "0"),
  };
}
