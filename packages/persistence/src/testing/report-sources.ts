/**
 * Fixtures of a B13 report's sources (order 6; migration 0095; @kauro/persistence/testing): a SYNTHETIC legal identity recorded by the
 * control plane, a fiscal issuer whose legal identity hash is that document's, the published terms an agency accepts as its ACTIVE OWNER
 * (CMD002's record) and a branding version the owner records — each written through the runtime role and path that writes it in the
 * platform. The identity is plainly a test's (every field says TEST); no fixture here is, or stands for, anyone's legal identity.
 */
import { legalIdentityBytesOf, type AgencyId, type FiscalIssuerRef, type LegalFactStatus, type LegalIdentity, type MembershipId } from "@kauro/domain";
import type { Sha256Hex } from "@kauro/contracts";
import { reportSourcesOf } from "../unit-of-work.js";
import { recordQualifiedFiscalIssuer } from "./commerce-fixtures.js";
import { ids, sha, type AgencyFixture, type Harness } from "./harness.js";
import { ROLES } from "./temporary-postgres.js";

/** A synthetic identity: every field says it is a test's. */
export const TEST_LEGAL_IDENTITY: LegalIdentity = Object.freeze({
  legalName: "Synthetic Test Issuer S.A.S.",
  entityType: "TEST ENTITY",
  jurisdiction: "CO",
  taxId: "TEST-TAX-000000000-0",
  commercialRegistrationId: "TEST-REG-000000",
  registeredAddress: "Synthetic Test Address 1",
});

/** Records `identity` as the control plane does (content-addressed); answers its document and hash. */
export async function recordLegalIdentity(h: Harness, identity: LegalIdentity = TEST_LEGAL_IDENTITY): Promise<{ readonly document: Uint8Array; readonly legalIdentityHash: Sha256Hex }> {
  const document = legalIdentityBytesOf(identity);
  const recorded = await h.control.run(h.system("report-sources-fixture"), (uow) => reportSourcesOf(uow).legalIdentities.record(document));
  return { document, legalIdentityHash: recorded.legalIdentityHash };
}

/**
 * A fiscal issuer named by `legalIdentityHash` (the document may be recorded before or after it, or never), its legal facts
 * `legalFactStatus` (default PROFESSIONALLY_CONFIRMED), QUALIFIED unless `qualify` is false or its facts are of another status (one
 * QUALIFIED route per jurisdiction: a second issuer of the world's jurisdiction stays CONFIGURED).
 */
export async function recordIssuerOfIdentity(h: Harness, legalIdentityHash: Sha256Hex, options: { readonly legalFactStatus?: LegalFactStatus; readonly jurisdiction?: string; readonly qualify?: boolean } = {}): Promise<FiscalIssuerRef> {
  const control = await h.pg.connect(ROLES.controlLogin);
  try {
    return await recordQualifiedFiscalIssuer(control, { legalIdentityHash, ...(options.jurisdiction === undefined ? {} : { jurisdiction: options.jurisdiction }), ...(options.legalFactStatus === undefined ? {} : { legalFactStatus: options.legalFactStatus }), ...(options.qualify === undefined ? {} : { qualify: options.qualify }) });
  } finally {
    await control.end();
  }
}

/** The published agreement versions an agency of these fixtures accepts (the control plane publishes them once per cluster). */
export const REPORT_TERMS_VERSION = "TERMS-2026-01";
export const REPORT_PRIVACY_VERSION = "PRIVACY-2026-01";

/** Publishes the terms and privacy versions the quotes of these fixtures name, unless they already are; answers their document hashes. */
export async function publishReportAgreements(h: Harness, versions: { readonly terms?: string; readonly privacy?: string } = {}): Promise<{ readonly terms: { readonly version: string; readonly documentHash: Sha256Hex }; readonly privacy: { readonly version: string; readonly documentHash: Sha256Hex } }> {
  const terms = versions.terms ?? REPORT_TERMS_VERSION;
  const privacy = versions.privacy ?? REPORT_PRIVACY_VERSION;
  const control = await h.pg.connect(ROLES.controlLogin);
  try {
    for (const [kind, version] of [["TERMS", terms], ["PRIVACY", privacy]] as const) {
      await control.query("BEGIN");
      const exists = await control.query("SELECT 1 FROM kauro.service_agreement_versions WHERE agreement_kind = $1 AND version = $2", [kind, version]);
      if (exists.rowCount === 0) {
        await control.query("UPDATE kauro.service_agreement_versions SET state = 'RETIRED', retired_at = now() WHERE agreement_kind = $1 AND state = 'PUBLISHED'", [kind]);
        await control.query("INSERT INTO kauro.service_agreement_versions (agreement_kind, version, document_hash, published_at, created_at, updated_at) VALUES ($1, $2, $3, now(), now(), now())", [kind, version, sha(`${kind}-${version}`)]);
      }
      await control.query("COMMIT");
    }
  } finally {
    await control.end();
  }
  return { terms: { version: terms, documentHash: sha(`TERMS-${terms}`) }, privacy: { version: privacy, documentHash: sha(`PRIVACY-${privacy}`) } };
}

/** The agency's ACTIVE OWNER accepts the published terms and privacy versions as itself (CMD002's record; append-only). */
export async function acceptReportAgreements(h: Harness, agency: AgencyFixture, versions: Awaited<ReturnType<typeof publishReportAgreements>>): Promise<void> {
  const app = await h.pg.connect(ROLES.appLogin);
  try {
    await app.query("BEGIN");
    await app.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agency.agencyId, agency.ownerUserId]);
    await app.query(
      `INSERT INTO kauro.agency_agreement_acceptances (acceptance_id, agency_id, membership_id, user_id, terms_version, terms_document_hash, privacy_version, privacy_document_hash, accepted_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, kauro.server_now(), now())`,
      [ids.next(), agency.agencyId, agency.ownerMembershipId, agency.ownerUserId, versions.terms.version, versions.terms.documentHash, versions.privacy.version, versions.privacy.documentHash],
    );
    await app.query("COMMIT");
  } catch (e) {
    await app.query("ROLLBACK");
    throw e;
  } finally {
    await app.end();
  }
}

/** The agency's owner records its next branding version (migration 0095; CMD008's write, whose route is not part of this edition). */
export function recordBranding(h: Harness, agency: AgencyFixture, displayName: string): ReturnType<ReturnType<typeof reportSourcesOf>["brandingVersions"]["record"]> {
  return h.app.run(h.tenant(agency.agencyId, agency.ownerUserId), (uow) =>
    reportSourcesOf(uow).brandingVersions.record({ agencyId: agency.agencyId as AgencyId, recordedByMembershipId: agency.ownerMembershipId as MembershipId, displayName }),
  );
}
