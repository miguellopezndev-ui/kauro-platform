/**
 * Principals beyond agency membership (08 "Identity is not permission": the backend checks identity status, active membership
 * or operator assignment, agency scope, resource relationship, capability, state/version and required assurance; "A service
 * account has only its technical role. It cannot act as a human owner by putting an owner ID in a request"; "Corporate operators
 * and sellers use individually managed corporate identities"; COMMAND_CATALOGUE "Service commands require a verified service
 * identity and audience, with scope derived from the stored operation").
 *
 * B06 left these roles denied by default (design §6.2: "Corporate and service roles of the catalogue (KAURO_OWNER,
 * PAYMENT_SERVICE, ...) are not memberships; roleSatisfies denies them by default and their authorizers arrive with their
 * packages"). B09 brings the two its commands name (B10 adds the commission and finance services below):
 *  - KAURO_OWNER (CMD032 ApproveRefund): a corporate grant of a person's identity, stored in kauro.corporate_roles and read by the
 *    database itself (kauro.holds_corporate_role) — never a claim of a token (D-CORP-B1);
 *  - PAYMENT_SERVICE (CMD033 ExecuteRefund, CMD034 ReconcilePayment) and AUTHENTICATED_PROVIDER (CMD030, the provider ingress):
 *    verified service identities, mapped to their one technical role by this code-owned table (D-AUTHZ-B3).
 */

export type ServiceRole = "PAYMENT_SERVICE" | "AUTHENTICATED_PROVIDER" | "FISCAL_SERVICE" | "COMMISSION_SERVICE" | "FINANCE_SERVICE" | "OPERATIONS_SERVICE" | "OUTREACH_SERVICE";

/** A service identity the service authenticator verified (issuer, audience, expected identity, environment; 10). */
export interface ServiceIdentity {
  /** The verified service identity, a lowercase token (payment-service, provider-ingress, fiscal-service, commission-service, finance-service, operations-service). */
  readonly serviceId: string;
  readonly audience: string;
  /** The deployment environment the identity was issued for (LOCAL, SANDBOX, LIVE). */
  readonly environment: "LOCAL" | "SANDBOX" | "LIVE";
}

/**
 * Code-owned service role table (D-AUTHZ-B3): each service identity holds exactly the technical role of its boundary. The
 * fiscal service's role is named for the fiscal integration package (CMD035 IssueTaxDocument, B15); B09 serves none of its
 * commands. B10 adds the two services of the commission ledger (D10-CTX-1): the commission service closes a commission period
 * (CMD051) and the finance service reconciles a commission payout against the provider evidence (CMD053); both run on the
 * kauro_commission runtime role and neither holds the other's role.
 */
export const SERVICE_ROLE_TABLE: Readonly<Record<string, ServiceRole>> = Object.freeze({
  "payment-service": "PAYMENT_SERVICE",
  "provider-ingress": "AUTHENTICATED_PROVIDER",
  "fiscal-service": "FISCAL_SERVICE",
  "commission-service": "COMMISSION_SERVICE",
  "finance-service": "FINANCE_SERVICE",
  // package B18 (R2 CMD056 RecordIncident and CMD059 RestrictCapability, role OPERATIONS_SERVICE_OR_OWNER): the operations service records an
  // incident and restricts a capability; it holds no other command, and no other service holds its role. It runs in kauro_commission's group
  // beside the commission and finance services (decision B18-OPS-1: that group's pools are the only verified service pools of the api).
  "operations-service": "OPERATIONS_SERVICE",
  // package B12 (plan A1, A14, D-B12O-12): the outreach service runs the dispatcher units D2..D5 and the public opt-out on its own
  // runtime group kauro_outreach (0072), which acts on no agency; it holds no command of the registry.
  "outreach-service": "OUTREACH_SERVICE",
});

export function serviceHoldsRole(serviceId: string, role: ServiceRole): boolean {
  return Object.prototype.hasOwnProperty.call(SERVICE_ROLE_TABLE, serviceId) && SERVICE_ROLE_TABLE[serviceId] === role;
}

/** The corporate command roles this package authorizes (the catalogue's owner role, brand-mapped by amendment A2). */
export const CORPORATE_ROLES = ["KAURO_OWNER"] as const;

export function isCorporateCommandRole(role: string): role is (typeof CORPORATE_ROLES)[number] {
  return (CORPORATE_ROLES as ReadonlyArray<string>).includes(role);
}

/** Version of the commerce authorization policy a decision records (08 "Audit events": the policy version is recorded). */
export const COMMERCE_POLICY_VERSION = "B09-1";
