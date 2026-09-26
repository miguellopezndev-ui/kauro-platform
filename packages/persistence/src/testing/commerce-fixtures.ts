/**
 * Control-plane fixtures of the payments and fiscal workflow (package B09) for the real-database tests of this package and of the
 * entrypoints (@kauro/persistence/testing; design §14 M1, §15 item 9). They write what no port of B09 writes — the platform's
 * configuration, provisioned by the control plane (kauro_control): a qualified merchant route of a provider and environment, a
 * qualified fiscal issuer route, and a person's corporate grant (D-ROUTE-B1, D-CORP-B1). Each row is born in its machine's initial
 * state and walks the listed edge to its qualified state with its evidence, as the control plane records it; a labelled contract
 * fake route (integration class CONTRACT_FAKE) can never be LIVE (payment_routes_fake_never_live). Everything the commerce ports do
 * write is written through the adapters (commerce unit of work, @kauro/persistence).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Client, PoolClient } from "pg";
import { createIdGenerator, toUtcInstant, type FiscalIssuerRef, type IdGenerator, type MerchantRef, type PaymentEnvironment, type PaymentRouteId, type UserId } from "@kauro/domain";

type Control = Pick<Client | PoolClient, "query">;

const ids: IdGenerator = createIdGenerator({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() }, (n) => new Uint8Array(randomBytes(n)));

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export interface QualifiedRoute {
  readonly routeId: PaymentRouteId;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly merchantRef: MerchantRef;
  readonly payeeDigest: string;
}

/**
 * A merchant route of `provider` and `environment` (15 "Merchant identity and environment are fixed by server configuration"),
 * CONFIGURED then QUALIFIED with its evidence and validity, integration class CONTRACT_FAKE unless told otherwise (a fake is never
 * LIVE). One QUALIFIED route per provider and environment (payment_routes_one_qualified).
 */
export async function recordQualifiedPaymentRoute(
  control: Control,
  options: { readonly provider?: string; readonly environment?: PaymentEnvironment; readonly payee?: string; readonly integrationClass?: "PROVIDER" | "CONTRACT_FAKE" } = {},
): Promise<QualifiedRoute> {
  const routeId = ids.next() as PaymentRouteId;
  const merchantRef = ids.next() as MerchantRef;
  const provider = options.provider ?? "paypal";
  const environment = options.environment ?? "SANDBOX";
  const payeeDigest = sha(options.payee ?? "merchant-payee");
  await control.query(
    `INSERT INTO kauro.payment_routes (route_id, provider, environment, merchant_ref, payee_digest, currency, integration_class, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'USD', $6, now(), now())`,
    [routeId, provider, environment, merchantRef, payeeDigest, options.integrationClass ?? "CONTRACT_FAKE"],
  );
  await control.query("UPDATE kauro.payment_routes SET state = 'QUALIFIED', qualification_evidence_hashes = $2::jsonb, valid_from = now() WHERE route_id = $1", [routeId, JSON.stringify([sha(`route-qualification-${routeId}`)])]);
  return { routeId, provider, environment, merchantRef, payeeDigest };
}

/**
 * The contracting and invoicing entity's issuance route (15 "Accounting integration decision"): legal facts professionally
 * confirmed, a numbering authorization and verified entitlement (R2-083), CONFIGURED then QUALIFIED; one per jurisdiction.
 */
export async function recordQualifiedFiscalIssuer(control: Control, options: { readonly jurisdiction?: string } = {}): Promise<FiscalIssuerRef> {
  const issuerRef = ids.next() as FiscalIssuerRef;
  await control.query(
    `INSERT INTO kauro.fiscal_issuers (issuer_ref, jurisdiction, legal_identity_hash, legal_fact_status, route_kind, integration_class, numbering_authorization_ref, entitlement_evidence_hash, created_at, updated_at)
     VALUES ($1, $2, $3, 'PROFESSIONALLY_CONFIRMED', 'PROVIDER_API', 'CONTRACT_FAKE', 'DIAN-18764000001', $4, now(), now())`,
    [issuerRef, options.jurisdiction ?? "CO", sha(`issuer-legal-identity-${issuerRef}`), sha(`issuer-entitlement-${issuerRef}`)],
  );
  await control.query("UPDATE kauro.fiscal_issuers SET route_state = 'QUALIFIED', qualification_evidence_hashes = $2::jsonb, valid_from = now() - interval '24 hours' WHERE issuer_ref = $1", [
    issuerRef,
    JSON.stringify([sha(`issuer-qualification-${issuerRef}`)]),
  ]);
  return issuerRef;
}

/** An ACTIVE KAURO_OWNER grant of a corporate identity, provisioned by the control plane (D-CORP-B1). */
export async function grantCorporateRole(control: Control, userId: UserId): Promise<string> {
  const grantId = ids.next();
  await control.query(
    "INSERT INTO kauro.corporate_roles (grant_id, user_id, role, evidence_hash, granted_at, created_at, updated_at) VALUES ($1, $2, 'KAURO_OWNER', $3, now(), now(), now())",
    [grantId, userId, sha(`grant-${grantId}`)],
  );
  return grantId;
}

/** Revokes a grant (grant_revoked, under the grant's transition lock keyed by its person). */
export async function revokeCorporateRole(control: Control, grantId: string): Promise<void> {
  const r = await control.query("UPDATE kauro.corporate_roles SET state = 'REVOKED', revoked_at = now() WHERE grant_id = $1 AND state = 'ACTIVE'", [grantId]);
  if (r.rowCount !== 1) throw new Error(`grant ${grantId} was not ACTIVE`);
}
