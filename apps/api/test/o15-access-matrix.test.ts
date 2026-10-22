// Order 15: the executable access matrix of every served route (OWASP API Top 10 2023 API5 BFLA; ASVS 5.0 V8 "Authorization"; 08 "Identity is
// not permission"). One api serves every route of this edition — B06's, B07's, B08's, the request side and the payment service of B09, B10's
// commands and service routes, the bank routes, B12's seller and owner screens, B16's team, retention and operations commands — over a real
// PostgreSQL 17 the test starts itself (bankWorld over integrationWorld). The matrix below is the authority this test holds the code to:
//
//  - census: every route the server registers has exactly one principal class here, and the class agrees with the route's declared role in
//    the OpenAPI document (x-kauro-role); a new route fails until it is classified;
//  - refusal: every identity a class does not admit — anonymous, a disabled or unverified identity, a verified person with no role, a member
//    of the other agency, a suspended member, the corporate owner on an agency route, an agency owner on a corporate route, a seller in every
//    state on an owner route, every person on a service route — is refused BY AUTHORIZATION (a reason of the identity, membership, corporate
//    role or service checks, never the absence of the object the path names), with a Problem that names nothing, no journal entry and no event;
//  - control: the identity a class admits passes the same checks on the same request (its answer is never one of those reasons), so no
//    refusal above is the route refusing everyone;
//  - no effect: the whole sweep leaves every table but the security facts exactly as it found them.
//
// Bodies are built from the route's own request schema in apps/api/openapi.json, so each request passes admission and reaches the
// authorization it probes; path ids are fresh (nonexistent) ids, and the agency is always agency A (path and X-Kauro-Agency). Object-level
// (BOLA) refusals of foreign objects are o15-object-isolation.test.ts's.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { UserId } from "@kauro/domain";
import { routeInventoryOf } from "../src/index.js";
import { bankWorld, type BankWorld } from "./bank-support.js";
import { recordSeller } from "./sales-support.js";
import { serviceToken } from "./payment-support.js";
import { asPerson, candidateSeller, terminateDirectly } from "./sellers-support.js";
import { asProblem, call, clock, freshKey, ids, sha, type Person, type Reply, type World } from "./support.js";

/** Who a route admits. */
type Principal =
  | "PUBLIC" // no credential: the public pages' api, the probes, the opt-out link
  | "PROVIDER" // a payment provider's signed delivery (its signature is the credential; cmd030)
  | "SESSION" // the browser session boundary and the step-up of the signed-in person (b11-sessions)
  | "IDENTITY" // any verified identity, whatever its memberships (CreateAgency, ListAgencies, AcceptInvitation)
  | "AGENCY" // an ACTIVE membership of the agency the request names (the command's own role then narrows it)
  | "KAURO_OWNER" // the corporate owner's ACTIVE KAURO_OWNER grant
  | "SELLER" // the caller's own seller row (ACTIVE for prospect work; any state for the payout destination; not CANDIDATE for the home)
  | "SELLER_OR_OWNER" // the caller's own (active or assigned) seller row, or the corporate owner
  | "SERVICE" // a verified service identity of the command's technical role only
  | "SERVICE_OR_OWNER"; // the operations service, or the corporate owner

/** The matrix: every route of this edition and the principal it admits. */
const MATRIX: Readonly<Record<string, Principal>> = {
  "POST /api/v1/agencies": "IDENTITY",
  "GET /api/v1/agencies": "IDENTITY",
  "GET /api/v1/agencies/{agencyId}": "AGENCY",
  "POST /api/v1/agencies/{agencyId}/activate": "AGENCY",
  "POST /api/v1/agencies/{agencyId}/branding": "AGENCY",
  "POST /api/v1/agencies/{agencyId}/branding/logos": "AGENCY",
  "GET /api/v1/agencies/{agencyId}/buyer-type": "AGENCY",
  "POST /api/v1/agencies/{agencyId}/buyer-type": "AGENCY",
  "POST /api/v1/agencies/{agencyId}/clients": "AGENCY",
  "GET /api/v1/agencies/{agencyId}/clients": "AGENCY",
  "POST /api/v1/agencies/{agencyId}/closure-requests": "AGENCY",
  "POST /api/v1/agencies/{agencyId}/invitations": "AGENCY",
  "GET /api/v1/agencies/{agencyId}/members": "AGENCY",
  "POST /api/v1/agencies/{agencyId}/ownership-transfers": "AGENCY",
  "GET /api/v1/agencies/{agencyId}/projects": "AGENCY",
  "POST /api/v1/assurance/step-ups": "SESSION",
  "GET /api/v1/audits/{auditId}": "AGENCY",
  "POST /api/v1/audits/{auditId}/cancel": "AGENCY",
  "POST /api/v1/audits/{auditId}/decision-artifacts": "AGENCY",
  "POST /api/v1/audits/{auditId}/plans": "AGENCY",
  "POST /api/v1/clients/{clientId}/archive": "AGENCY",
  "POST /api/v1/clients/{clientId}/projects": "AGENCY",
  "POST /api/v1/invitations/{invitationId}/accept": "IDENTITY",
  "GET /api/v1/jobs/{jobId}": "AGENCY",
  "POST /api/v1/jobs/{jobId}/cancel": "AGENCY",
  "POST /api/v1/memberships/{membershipId}/capabilities": "AGENCY",
  "POST /api/v1/memberships/{membershipId}/revoke": "AGENCY",
  "POST /api/v1/operations/bank-accounts/{accountRef}/credits": "KAURO_OWNER",
  "POST /api/v1/operations/bank-accounts/{accountRef}/evidence-artifacts": "KAURO_OWNER",
  "POST /api/v1/operations/bank-accounts/{accountRef}/settlements": "KAURO_OWNER",
  "GET /api/v1/operations/bank-accounts/{accountRef}/settlements": "KAURO_OWNER",
  "GET /api/v1/operations/bank-accounts/{accountRef}/settlements/{requestId}": "KAURO_OWNER",
  "POST /api/v1/operations/bank-accounts/{accountRef}/statement-imports": "KAURO_OWNER",
  "GET /api/v1/operations/bank-credits": "KAURO_OWNER",
  "GET /api/v1/operations/bank-credits/{creditId}": "KAURO_OWNER",
  "POST /api/v1/operations/bank-credits/{creditId}/attributions": "KAURO_OWNER",
  "POST /api/v1/operations/bank-credits/{creditId}/confirmations": "KAURO_OWNER",
  "GET /api/v1/operations/bank-orders/{orderId}/match-keys": "KAURO_OWNER",
  "POST /api/v1/operations/bank-routes": "KAURO_OWNER",
  "GET /api/v1/operations/bank-routes/{routeId}": "KAURO_OWNER",
  "POST /api/v1/operations/bank-routes/{routeId}/details": "KAURO_OWNER",
  "POST /api/v1/operations/bank-routes/{routeId}/disable": "KAURO_OWNER",
  "POST /api/v1/operations/bank-routes/{routeId}/enable": "KAURO_OWNER",
  "POST /api/v1/operations/bank-routes/{routeId}/verify": "KAURO_OWNER",
  "POST /api/v1/operations/breakglass-grants": "KAURO_OWNER",
  "POST /api/v1/operations/breakglass-grants/{grantId}/revoke": "KAURO_OWNER",
  "GET /api/v1/operations/breakglass-grants/{grantId}/tables/{tableId}/preview": "KAURO_OWNER",
  "POST /api/v1/operations/capabilities/{capabilityId}/restrict": "SERVICE_OR_OWNER",
  "POST /api/v1/operations/capabilities/{capabilityId}/versions": "KAURO_OWNER",
  "GET /api/v1/operations/execution-attempts": "KAURO_OWNER",
  "POST /api/v1/operations/execution-attempts/{attemptId}/bounces": "KAURO_OWNER",
  "POST /api/v1/operations/execution-attempts/{attemptId}/records": "KAURO_OWNER",
  "POST /api/v1/operations/execution-attempts/{attemptId}/resend-declarations": "KAURO_OWNER",
  "POST /api/v1/operations/execution-attempts/{attemptId}/resolutions": "KAURO_OWNER",
  "POST /api/v1/operations/incidents": "SERVICE_OR_OWNER",
  "POST /api/v1/operations/recoveries": "KAURO_OWNER",
  "GET /api/v1/operations/refunds/{refundId}": "KAURO_OWNER",
  "POST /api/v1/operations/refunds/{refundId}/execution-declarations": "KAURO_OWNER",
  "POST /api/v1/operations/treasury-refunds/{treasuryRefundId}/approve": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/authorizations": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/authorizations/{authorizationId}/revoke": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/contents": "SELLER_OR_OWNER",
  "POST /api/v1/ops/outreach/diagnoses": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/drafts": "SELLER_OR_OWNER",
  "GET /api/v1/ops/outreach/drafts/{draftId}": "SELLER_OR_OWNER",
  "GET /api/v1/ops/outreach/metrics": "SELLER_OR_OWNER",
  "POST /api/v1/ops/outreach/policy-withdrawals": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/reviews": "KAURO_OWNER",
  "GET /api/v1/ops/outreach/reviews/{reviewId}": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/senders": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/senders/{senderId}/revoke": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/senders/{senderId}/verify": "KAURO_OWNER",
  "POST /api/v1/ops/outreach/{draftId}/send": "SELLER_OR_OWNER",
  "POST /api/v1/ops/prospects/{prospectId}/contacts": "SELLER_OR_OWNER",
  "POST /api/v1/ops/prospects/{prospectId}/sources": "SELLER_OR_OWNER",
  "POST /api/v1/ops/sales/activities": "SELLER_OR_OWNER",
  "POST /api/v1/ops/sales/agreements/{agreementId}/signature": "KAURO_OWNER",
  "POST /api/v1/ops/sales/payout-destinations": "SELLER",
  "POST /api/v1/ops/sales/payout-destinations/{destinationId}/verify": "KAURO_OWNER",
  "GET /api/v1/ops/sales/prospects/{prospectId}/activities": "SELLER_OR_OWNER",
  "POST /api/v1/ops/sales/prospects/{prospectId}/allocations": "KAURO_OWNER",
  "POST /api/v1/ops/sales/prospects/{prospectId}/claim-evidence": "SELLER",
  "POST /api/v1/ops/sales/resources": "KAURO_OWNER",
  "GET /api/v1/ops/sales/resources/{resourceId}": "SELLER_OR_OWNER",
  "POST /api/v1/ops/sales/sellers": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/agreements": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/assessments": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/assistance-agreements": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/confidentiality-acceptances": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/legal-reviews": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/service-assignments": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/tax-documents": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/termination-manifests": "KAURO_OWNER",
  "POST /api/v1/ops/sales/sellers/{sellerId}/termination-terms": "KAURO_OWNER",
  "POST /api/v1/packages/{packageId}/download-authorizations": "AGENCY",
  "GET /api/v1/payment-orders/{orderId}": "AGENCY",
  "POST /api/v1/payment-orders/{orderId}/capture": "AGENCY",
  "POST /api/v1/payment-orders/{orderId}/reconcile": "SERVICE",
  "POST /api/v1/payment-orders/{orderId}/retirements": "AGENCY",
  "GET /api/v1/payment-orders/{orderId}/transfer-instructions": "AGENCY",
  "POST /api/v1/payments/webhooks/{provider}": "PROVIDER",
  "POST /api/v1/plans/{planId}/approve": "AGENCY",
  "POST /api/v1/plans/{planId}/revisions": "AGENCY",
  "POST /api/v1/plans/{planId}/validate": "AGENCY",
  "POST /api/v1/plans/{planId}/withdraw": "AGENCY",
  "GET /api/v1/projects/{projectId}": "AGENCY",
  "POST /api/v1/projects/{projectId}/deletion-requests": "AGENCY",
  "POST /api/v1/projects/{projectId}/execute": "AGENCY",
  "POST /api/v1/projects/{projectId}/import-stages/{stageId}/continue": "AGENCY",
  "POST /api/v1/projects/{projectId}/import-stages/{stageId}/receipts": "AGENCY",
  "POST /api/v1/projects/{projectId}/quotes": "AGENCY",
  "POST /api/v1/projects/{projectId}/refund-requests": "AGENCY",
  "POST /api/v1/projects/{projectId}/retention-extensions": "AGENCY",
  "POST /api/v1/projects/{projectId}/revisions": "AGENCY",
  "POST /api/v1/projects/{projectId}/support-cases": "AGENCY",
  "GET /api/v1/projects/{projectId}/support-cases": "AGENCY",
  "POST /api/v1/projects/{projectId}/target-contracts": "AGENCY",
  "GET /api/v1/public/capability-publication": "PUBLIC",
  "GET /api/v1/public/identity-config": "PUBLIC",
  "POST /api/v1/public/inquiries": "PUBLIC",
  "GET /api/v1/public/outreach/opt-out/{token}": "PUBLIC",
  "POST /api/v1/public/outreach/opt-out/{token}": "PUBLIC",
  "GET /api/v1/quotes/{quoteId}": "AGENCY",
  "POST /api/v1/quotes/{quoteId}/payment-orders": "AGENCY",
  "GET /api/v1/refunds/{refundId}": "AGENCY",
  "POST /api/v1/refunds/{refundId}/approve": "KAURO_OWNER",
  "POST /api/v1/refunds/{refundId}/execute": "SERVICE",
  "GET /api/v1/revisions/{revisionId}": "AGENCY",
  "POST /api/v1/revisions/{revisionId}/audits": "AGENCY",
  "GET /api/v1/revisions/{revisionId}/inspection": "AGENCY",
  "POST /api/v1/revisions/{revisionId}/seal": "AGENCY",
  "POST /api/v1/revisions/{revisionId}/selection": "AGENCY",
  "POST /api/v1/revisions/{revisionId}/selection-manifests": "AGENCY",
  "GET /api/v1/revisions/{revisionId}/selection-manifests/{selectionManifestId}": "AGENCY",
  "GET /api/v1/revisions/{revisionId}/tables/{tableId}/preview": "AGENCY",
  "POST /api/v1/revisions/{revisionId}/uploads": "AGENCY",
  "GET /api/v1/revisions/{revisionId}/uploads": "AGENCY",
  "POST /api/v1/sales/agencies/{agencyId}/assignment": "KAURO_OWNER",
  "POST /api/v1/sales/claims/{claimId}/accept": "KAURO_OWNER",
  "POST /api/v1/sales/commission-periods/{periodId}/close": "SERVICE",
  "GET /api/v1/sales/home": "SELLER",
  "POST /api/v1/sales/prospects": "SELLER_OR_OWNER",
  "POST /api/v1/sales/prospects/{prospectId}/claims": "SELLER",
  "POST /api/v1/sales/sellers/{sellerId}/activate": "KAURO_OWNER",
  "POST /api/v1/sales/sellers/{sellerId}/terminate": "KAURO_OWNER",
  "GET /api/v1/sales/statements/{statementId}": "SELLER_OR_OWNER",
  "POST /api/v1/sales/statements/{statementId}/approve-payout": "KAURO_OWNER",
  "POST /api/v1/sales/statements/{statementId}/reconcile-payout": "SERVICE",
  "POST /api/v1/sessions": "SESSION",
  "GET /api/v1/sessions/current": "SESSION",
  "POST /api/v1/sessions/current/revoke": "SESSION",
  "GET /api/v1/support-cases/{caseId}": "AGENCY",
  "POST /api/v1/target-contracts/{contractId}/confirm": "AGENCY",
  "GET /api/v1/uploads/{uploadId}": "AGENCY",
  "POST /api/v1/uploads/{uploadId}/cancel": "AGENCY",
  "POST /api/v1/uploads/{uploadId}/complete": "AGENCY",
  "GET /api/v1/uploads/{uploadId}/session": "AGENCY",
  "GET /livez": "PUBLIC",
  "GET /readyz": "PUBLIC",
};

/** The declared role (x-kauro-role) each principal class may carry; a route without one is a read, intake or boundary route. */
const DECLARED: Readonly<Record<Principal, ReadonlySet<string | undefined>>> = {
  PUBLIC: new Set([undefined]),
  PROVIDER: new Set(["AUTHENTICATED_PROVIDER"]),
  SESSION: new Set([undefined]),
  IDENTITY: new Set(["VERIFIED_USER", undefined]),
  AGENCY: new Set([undefined, "AGENCY_READER", "AGENCY_MEMBER", "AGENCY_OWNER", "AGENCY_OWNER_OR_ADMIN", "AGENCY_ADMIN", "AGENCY_OPERATOR", "AGENCY_APPROVER", "AGENCY_BILLING"]),
  KAURO_OWNER: new Set(["KAURO_OWNER", "KAURO_OWNER_OR_SECURITY_SERVICE", "OWNER"]),
  SELLER: new Set(["ACTIVE_SELLER", "SELLER_SELF", "OWN_SELLER_ANY_STATE"]),
  SELLER_OR_OWNER: new Set(["ACTIVE_SELLER_OR_OWNER", "ASSIGNED_SELLER_OR_OWNER", "ASSIGNED_SELLER_OR_KAURO_OWNER", "SELLER_OR_KAURO_OWNER", "ASSIGNED_SELLER_OWNER_OR_RECONCILER"]),
  SERVICE: new Set(["PAYMENT_SERVICE", "COMMISSION_SERVICE", "FINANCE_SERVICE"]),
  SERVICE_OR_OWNER: new Set(["OPERATIONS_SERVICE_OR_OWNER"]),
};

type Who =
  | "ANONYMOUS"
  | "PAYMENT_SERVICE"
  | "DISABLED"
  | "UNVERIFIED"
  | "NO_ROLE"
  | "AGENCY_OWNER_A"
  | "AGENCY_VIEWER_A"
  | "SUSPENDED_MEMBER_A"
  | "MEMBER_OF_B"
  | "KAURO_OWNER"
  | "SELLER_ACTIVE"
  | "SELLER_SUSPENDED"
  | "SELLER_TERMINATED"
  | "SELLER_CANDIDATE";

const PEOPLE: ReadonlyArray<Who> = ["ANONYMOUS", "PAYMENT_SERVICE", "DISABLED", "UNVERIFIED", "NO_ROLE", "AGENCY_OWNER_A", "AGENCY_VIEWER_A", "SUSPENDED_MEMBER_A", "MEMBER_OF_B", "KAURO_OWNER", "SELLER_ACTIVE", "SELLER_SUSPENDED", "SELLER_TERMINATED", "SELLER_CANDIDATE"];
const SELLERS: ReadonlyArray<Who> = ["SELLER_ACTIVE", "SELLER_SUSPENDED", "SELLER_TERMINATED", "SELLER_CANDIDATE"];

/** The service that owns each SERVICE route; every other caller, the payment service included, is refused there. */
const SERVICE_OF: Readonly<Record<string, Who | null>> = {
  "POST /api/v1/payment-orders/{orderId}/reconcile": "PAYMENT_SERVICE",
  "POST /api/v1/refunds/{refundId}/execute": "PAYMENT_SERVICE",
  "POST /api/v1/sales/commission-periods/{periodId}/close": null,
  "POST /api/v1/sales/statements/{statementId}/reconcile-payout": null,
};

/**
 * The identities each class must refuse. A route's own narrower rule (an agency role, a seller state, the seller assigned to a prospect) is
 * the per-command tests'; here every caller outside the class is refused, the payment service's credential included (a service identity
 * acts only under its own technical role: 08 "a service account has only its technical role").
 */
function refusedBy(key: string, principal: Principal): ReadonlyArray<Who> {
  switch (principal) {
    case "PUBLIC":
    case "PROVIDER":
    case "SESSION":
      return [];
    case "IDENTITY":
      return ["ANONYMOUS", "PAYMENT_SERVICE", "DISABLED"];
    case "AGENCY":
      return ["ANONYMOUS", "PAYMENT_SERVICE", "DISABLED", "UNVERIFIED", "NO_ROLE", "SUSPENDED_MEMBER_A", "MEMBER_OF_B", "KAURO_OWNER", ...SELLERS];
    case "KAURO_OWNER":
    case "SERVICE_OR_OWNER":
      return PEOPLE.filter((p) => p !== "KAURO_OWNER");
    case "SELLER":
      return ["ANONYMOUS", "PAYMENT_SERVICE", "DISABLED", "UNVERIFIED", "NO_ROLE", "AGENCY_OWNER_A", "AGENCY_VIEWER_A", "SUSPENDED_MEMBER_A", "MEMBER_OF_B", "KAURO_OWNER"];
    case "SELLER_OR_OWNER":
      return ["ANONYMOUS", "PAYMENT_SERVICE", "DISABLED", "UNVERIFIED", "NO_ROLE", "AGENCY_OWNER_A", "AGENCY_VIEWER_A", "SUSPENDED_MEMBER_A", "MEMBER_OF_B"];
    case "SERVICE":
      return PEOPLE.filter((p) => p !== SERVICE_OF[key]);
  }
}

/** The identity that a class admits, for the control request (null: the class has no person to stand for it). */
function admittedBy(principal: Principal): Who | null {
  switch (principal) {
    case "IDENTITY":
      return "NO_ROLE";
    case "AGENCY":
      return "AGENCY_OWNER_A";
    case "KAURO_OWNER":
    case "SERVICE_OR_OWNER":
    case "SELLER_OR_OWNER":
      return "KAURO_OWNER";
    case "SELLER":
      return "SELLER_ACTIVE";
    default:
      return null;
  }
}

/** Whether a refusal is authentication's or authorization's own: no credential it accepts (401), or a reason of the checks above. */
function refusedByAccessControl(status: number, code: string, reason: string): boolean {
  return (status === 401 && code === "AUTHENTICATION_REQUIRED") || AUTHORIZATION_REASONS.has(reason);
}

/**
 * The reasons that are authorization's own (identity, membership, corporate role, service identity, credentials): a refusal must carry
 * one, and a control request must not. NOT_A_MEMBER is the agency check's (foreign and nonexistent agencies alike, D-AUTHZ-4).
 */
const AUTHORIZATION_REASONS: ReadonlySet<string> = new Set([
  "SUBJECT_UNAUTHENTICATED",
  "IDENTITY_DISABLED",
  "IDENTITY_UNVERIFIED",
  "TENANT_CONTEXT_MISSING",
  "NOT_A_MEMBER",
  "MEMBERSHIP_SUSPENDED",
  "MEMBERSHIP_NOT_ACTIVE",
  "ROLE_INSUFFICIENT",
  "CORPORATE_ROLE_MISSING",
  "SERVICE_NOT_PERMITTED",
  "SERVICE_ENVIRONMENT_MISMATCH",
  "SERVICE_IDENTITY_REQUIRED",
  "SELLER_NOT_ACTIVE",
  "SELLER_NOT_ASSIGNED",
]);

// --- the request each route is probed with ----------------------------------------------------------------------------------------

/** apps/api/openapi.json, from dist/test/*.js: three directories up is apps/api. */
const OPENAPI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "openapi.json");

interface Schema {
  readonly type?: string | readonly string[];
  readonly $ref?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly items?: Schema;
  readonly minItems?: number;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly oneOf?: readonly Schema[];
  readonly anyOf?: readonly Schema[];
  readonly allOf?: readonly Schema[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
  readonly maximum?: number;
  readonly format?: string;
}

interface Operation {
  readonly operationId: string;
  readonly "x-kauro-role"?: string;
  readonly "x-kauro-idempotency"?: string;
  readonly "x-kauro-intake"?: unknown;
  readonly requestBody?: { readonly content: Readonly<Record<string, { readonly schema: Schema }>> };
}

interface Document {
  readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  readonly components: { readonly schemas: Readonly<Record<string, Schema>> };
}

const doc = JSON.parse(readFileSync(OPENAPI, "utf8")) as Document;

function operationOf(key: string): Operation {
  const [method, path] = key.split(" ") as [string, string];
  const op = doc.paths[path]?.[method.toLowerCase()];
  if (op === undefined) throw new Error(`${key} is not in the OpenAPI document`);
  return op;
}

const resolve = (s: Schema): Schema => (s.$ref !== undefined ? (doc.components.schemas[s.$ref.split("/").pop() as string] as Schema) : s);

/** Candidate strings a string schema is satisfied with, tried in order against its pattern and lengths. */
function stringCandidates(): string[] {
  const now = clock.now();
  return [ids.next(), sha(`o15-${ids.next()}`), now, now.slice(0, 10), "2026-10-22", "CO", "Order fifteen probe", "O15_PROBE", "o15-probe", "probe@example.com", "https://example.com/o15", "platform:o15", "1", "QQ==", "1000"];
}

/**
 * Bodies a schema sample cannot stand for, because the route judges the body alone before it authorizes (a rule over the body's own bytes,
 * never a read): the owner's evidence upload checks the declared hash against the bytes, X3 EXECUTED needs its evidence.
 */
const EVIDENCE_JSON = Buffer.from('{"o15":true}', "utf8");
const BODY_OF: Readonly<Record<string, () => unknown>> = {
  "POST /api/v1/operations/bank-accounts/{accountRef}/evidence-artifacts": () => ({ mediaType: "application/json", contentBase64: EVIDENCE_JSON.toString("base64"), evidenceHash: createHash("sha256").update(EVIDENCE_JSON).digest("hex") }),
  "POST /api/v1/operations/execution-attempts/{attemptId}/resolutions": () => ({ outcome: "EXECUTED", evidence: { artifactRef: ids.next(), evidenceHash: sha("o15") }, authorizationRef: ids.next() }),
};

/** A value the schema admits: required members only, the first alternative, the smallest array. */
function sampleOf(raw: Schema, where: string): unknown {
  const s = resolve(raw);
  if (s.const !== undefined) return s.const;
  if (s.enum !== undefined) return s.enum[0];
  if (s.oneOf !== undefined) return sampleOf(s.oneOf[0] as Schema, where);
  if (s.anyOf !== undefined) return sampleOf(s.anyOf[0] as Schema, where);
  if (s.allOf !== undefined) return Object.assign({}, ...s.allOf.map((x) => sampleOf(x, where) as object));
  const type = Array.isArray(s.type) ? (s.type.find((t) => t !== "null") as string) : (s.type as string | undefined);
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const name of s.required ?? []) out[name] = sampleOf(s.properties?.[name] ?? {}, `${where}.${name}`);
      return out;
    }
    case "array":
      return Array.from({ length: Math.max(1, s.minItems ?? 0) }, () => sampleOf(s.items ?? {}, `${where}[]`));
    case "integer":
    case "number":
      return Math.max(1, s.minimum ?? 1, s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
    case "boolean":
      return false;
    case "string": {
      const pattern = s.pattern !== undefined ? new RegExp(s.pattern, "u") : null;
      const fits = (v: string) => (pattern === null || pattern.test(v)) && v.length >= (s.minLength ?? 0) && v.length <= (s.maxLength ?? Infinity);
      const found = stringCandidates().find(fits);
      if (found !== undefined) return found;
      const padded = "a".repeat(Math.max(1, s.minLength ?? 1));
      if (fits(padded)) return padded;
      throw new Error(`${where}: no sample for ${JSON.stringify(s)}`);
    }
    default:
      return {};
  }
}

let bw: BankWorld;
let w: World;
let tokenOf: Readonly<Record<Exclude<Who, "ANONYMOUS" | "PAYMENT_SERVICE">, string>>;

before(async () => {
  bw = await bankWorld();
  w = bw.iw.w;
  const owner = bw.iw.owner;
  const seller = async (label: string) => (await recordSeller(w, owner.userId, `o15-${label}`)).person;
  const active = await seller("active");
  const suspendedSeller = await recordSeller(w, owner.userId, "o15-suspended");
  await asPerson(w.h, owner.userId, async (c) => {
    await c.query("UPDATE kauro.sellers SET state = 'SUSPENDED', version = version + 1 WHERE seller_id = $1", [suspendedSeller.sellerId]);
  });
  const terminated = await recordSeller(w, owner.userId, "o15-terminated");
  await terminateDirectly(w.h, owner.userId as UserId, terminated.sellerId);
  await candidateSeller(w.h, owner.userId as UserId, "o15-candidate");
  const candidatePerson = await w.person("seller-o15-candidate", { sync: false });
  const people: Record<string, Person> = {
    DISABLED: await w.person("o15-disabled", { state: "DISABLED" }),
    UNVERIFIED: w.unverified,
    NO_ROLE: await w.person("o15-no-role"),
    AGENCY_OWNER_A: w.owner,
    AGENCY_VIEWER_A: w.viewer,
    SUSPENDED_MEMBER_A: w.suspended,
    MEMBER_OF_B: w.stranger,
    KAURO_OWNER: owner,
    SELLER_ACTIVE: active,
    SELLER_SUSPENDED: suspendedSeller.person,
    SELLER_TERMINATED: terminated.person,
    SELLER_CANDIDATE: candidatePerson,
  };
  tokenOf = Object.fromEntries(Object.entries(people).map(([k, p]) => [k, p.token])) as typeof tokenOf;
});
after(async () => {
  await bw?.stop();
});

/** The request of a route by an identity: fresh ids, agency A in the path and the selector, a body its schema admits. */
async function probe(key: string, who: Who): Promise<{ readonly reply: Reply; readonly idempotencyKey: string | null }> {
  const [method, path] = key.split(" ") as ["GET" | "POST", string];
  const op = operationOf(key);
  const url = path.replace(/\{([A-Za-z]+)\}/g, (_m, name: string) => (name === "agencyId" ? w.A.agencyId : name === "accountRef" ? "o15-probe-account" : ids.next()));
  const content = op.requestBody?.content;
  const media = content === undefined ? null : (Object.keys(content)[0] as string);
  const body = media === null ? undefined : (BODY_OF[key]?.() ?? sampleOf((content as Record<string, { schema: Schema }>)[media]!.schema, key));
  const idempotencyKey = method === "POST" && op["x-kauro-idempotency"] === "REQUIRED" ? freshKey(`o15-${who}`) : null;
  const reply = await call(w, {
    method,
    url,
    token: who === "ANONYMOUS" ? null : who === "PAYMENT_SERVICE" ? serviceToken(bw.iw.pw) : tokenOf[who],
    key: idempotencyKey,
    agency: w.A.agencyId,
    ...(body === undefined ? (method === "GET" ? { contentType: null } : {}) : { body, contentType: media }),
  });
  return { reply, idempotencyKey };
}

const served = (): string[] =>
  routeInventoryOf(w.app)
    .map((r) => `${r.method} ${r.url.replace(/:([A-Za-z]+)/g, "{$1}")}`)
    .sort();

/** The routes this world does not bind (the public api, the session boundary and the opt-out link are other worlds'): never a guarded class. */
const UNBOUND_HERE: ReadonlySet<Principal> = new Set(["PUBLIC", "SESSION"]);

test("O15 census: every route of the contract is classified once in the access matrix, its class agrees with its declared role, and every route the api serves here is probed", () => {
  const documented = Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`)).sort();
  assert.deepEqual(Object.keys(MATRIX).sort(), documented, "the matrix names exactly the routes of the OpenAPI document (tools/openapi.mjs holds the document to the server's inventory)");
  const routes = served();
  for (const key of routes) assert.ok(key in MATRIX, `${key} is served but not classified`);
  for (const [key, principal] of Object.entries(MATRIX)) if (!routes.includes(key)) assert.ok(UNBOUND_HERE.has(principal), `${key} (${principal}) is not served by this world, so it would go unprobed`);
  for (const [key, principal] of Object.entries(MATRIX)) {
    const role = operationOf(key)["x-kauro-role"];
    assert.ok(DECLARED[principal].has(role), `${key}: the declared role ${String(role)} is not one ${principal} may carry`);
  }
});

test("O15 refusal: every identity a route's principal class does not admit is refused by authorization, with nothing written", async () => {
  const before = await tableDigests();
  const cells: string[] = [];
  const failures: string[] = [];
  const routes = new Set(served());
  for (const [key, principal] of Object.entries(MATRIX)) {
    if (!routes.has(key)) continue;
    for (const who of refusedBy(key, principal)) {
      const eventsBefore = await w.count("domain_events");
      const { reply, idempotencyKey } = await probe(key, who);
      const cell = `${key} as ${who}`;
      if (![401, 403, 404].includes(reply.status)) {
        failures.push(`${cell}: ${reply.status} ${reply.text.slice(0, 300)}`);
        continue;
      }
      const problem = asProblem(w, reply);
      const reason = problem.reason ?? "-";
      cells.push(`${cell} → ${reply.status} ${problem.code} ${reason}`);
      if (!refusedByAccessControl(reply.status, problem.code, reason)) failures.push(`${cell}: refused by ${reply.status} ${problem.code} ${reason}, not by authorization`);
      if (idempotencyKey !== null && (await w.journal(idempotencyKey)) !== null) failures.push(`${cell}: a journal entry was written`);
      if ((await w.count("domain_events")) !== eventsBefore) failures.push(`${cell}: an event was written`);
    }
  }
  process.stdout.write(`# o15 refusal cells: ${cells.length}\n${cells.map((c) => `#   ${c}`).join("\n")}\n`);
  assert.deepEqual(failures, []);
  const after = await tableDigests();
  const changed = Object.keys(after).filter((t) => after[t] !== before[t] && !REFUSAL_WRITES.has(t));
  assert.deepEqual(changed, [], "no table but the security facts changed");
});

test("O15 control: the identity each class admits passes the same identity, membership and corporate-role checks on the same requests", async () => {
  const failures: string[] = [];
  for (const [key, principal] of Object.entries(MATRIX)) {
    const control = admittedBy(principal);
    if (control === null) continue;
    const { reply } = await probe(key, control);
    const reason = reply.status >= 400 ? (asProblem(w, reply).reason ?? "-") : "-";
    if (AUTHORIZATION_REASONS.has(reason) || reply.status === 401 || reply.status >= 500) failures.push(`${key} as ${control}: ${reply.status} ${reason}`);
  }
  assert.deepEqual(failures, []);
});

/** The table a refusal may write: the durable security fact it leaves (08 "Audit events"). */
const REFUSAL_WRITES: ReadonlySet<string> = new Set(["security_events"]);

/**
 * Each table's content digest (every row's text, in a stable order), read by the superuser oracle: an inserted, updated or deleted row
 * of any table changes its digest, so a refusal that wrote anything but its security fact is seen whatever it wrote.
 */
async function tableDigests(): Promise<Record<string, string>> {
  const tables = await w.h.oracle.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'kauro' AND table_type = 'BASE TABLE' ORDER BY 1");
  const out: Record<string, string> = {};
  for (const { table_name } of tables.rows) {
    const r = await w.h.oracle.query<{ d: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM kauro."${table_name}" t`);
    out[table_name] = r.rows[0]?.d ?? "";
  }
  return out;
}
