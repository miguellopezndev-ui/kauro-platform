// Fixtures of the seller commands' route tests (package B10, mandate B10-COMMANDS-SELLERS; docs/design/B10-commercial-domain.md §5,
// decisions D10-SELL-1..3, D10-ASSIGN-1, D10-TERM-1). Every row is written by the runtime role that owns it through its real context —
// the corporate owner and the sellers as kauro_app OPERATOR sessions, the commission service as kauro_commission — never by the
// superuser, which only reads. The stage-2 fixtures of @kauro/persistence/testing cover an ACTIVE seller, prospects, claims,
// allocations, conversions and service assignments; what they cannot express — a CANDIDATE seller missing one activation fact at a time,
// the owner's prepared termination terms and manifest, a seller's thousand scraped prospects — is written here. This module owns no fake.
import type { Client } from "pg";
import type { FiscalProfileId, PlanId, UserId } from "@kauro/domain";
import { activateAgency, paidPurchase, recordReviewedFiscalProfile, type AgencyFixture, type Harness, type PaidPurchase, type RecordedSeller } from "@kauro/persistence/testing";
import type { PaymentsWorld } from "./commerce-support.js";
import { approveThroughRoute, ids, sha, type Person } from "./support.js";

/** One connection of kauro_app for the person (an OPERATOR session: its user bound, no agency), for the duration of `fn`. */
export async function asPerson<T>(h: Harness, userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await h.pg.connect("kauro_app_test");
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await client.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [userId]);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    await client.end();
  }
}

/** Which activation facts a candidate lacks (each flag removes exactly one of 17 "Activation prerequisites"). */
export interface CandidateGaps {
  /** The agreement exists but was never signed. */
  readonly unsigned?: boolean;
  /** The legal review of the classification's substance does not confirm it (a contractor label alone). */
  readonly reviewNotConfirmed?: boolean;
  /** No passed assessment is recorded. */
  readonly noAssessment?: boolean;
  /** The destination was changed with the seller's step-up but the owner has not verified it. */
  readonly unverifiedDestination?: boolean;
}

export interface CandidateSeller extends RecordedSeller {
  /** The assessment evidence reference CMD049 names (an assessment id; absent when none is recorded). */
  readonly assessmentRef: string;
}

/**
 * A CANDIDATE seller of a new corporate identity with every activation fact of design 17 recorded by the owner `owner` except the
 * ones `gaps` leaves out (the same writes as the stage-2 recordActiveSeller, without its final activation).
 */
export async function candidateSeller(h: Harness, owner: UserId, subject: string, gaps: CandidateGaps = {}): Promise<CandidateSeller> {
  const userId = await h.person(`seller-${subject}`);
  const sellerId = ids.next();
  const reviewId = ids.next();
  const agreementId = ids.next();
  const agreementVersion = `SA-${agreementId.slice(-8)}`;
  const assessmentId = ids.next();
  const destinationId = ids.next();
  const destinationDigest = sha(`destination-${destinationId}`);
  const sellerProof = await h.recordStepUp(userId);
  await asPerson(h, owner, async (c) => {
    await c.query("INSERT INTO kauro.sellers (seller_id, user_id, display_label, created_by_user_id, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())", [sellerId, userId, `Seller ${subject}`, owner]);
    await c.query(
      "INSERT INTO kauro.seller_legal_reviews (review_id, seller_id, classification, outcome, substance_hash, reviewer_label, evidence_hash, reviewed_at, recorded_by_user_id, created_at) VALUES ($1, $2, 'INDEPENDENT_COLLABORATION', $3, $4, 'Reviewing counsel', $5, now(), $6, now())",
      [reviewId, sellerId, gaps.reviewNotConfirmed === true ? "NOT_CONFIRMED" : "CONFIRMED", sha(`substance-${reviewId}`), sha(`review-${reviewId}`), owner],
    );
    await c.query(
      `INSERT INTO kauro.seller_agreements (agreement_id, seller_id, agreement_version, classification, legal_review_id, starts_at, first_bps, repeat_bps, recurring_months, offset_terms,
         retainer_cents_per_month, compensation_policy_version, signed_terms_hash, prepared_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'INDEPENDENT_COLLABORATION', $4, now(), 1000, 400, 12, 'NONE', 0, 'R2-INITIAL', $5, $6, now(), now())`,
      [agreementId, sellerId, agreementVersion, reviewId, sha(`terms-${agreementId}`), owner],
    );
    if (gaps.unsigned !== true) {
      await c.query("UPDATE kauro.seller_agreements SET signed_at = now(), signature_evidence_hash = $2, version = 2 WHERE agreement_id = $1", [agreementId, sha(`signature-${agreementId}`)]);
    }
    if (gaps.noAssessment !== true) {
      await c.query("INSERT INTO kauro.seller_assessments (assessment_id, seller_id, outcome, evidence_hash, assessed_at, recorded_by_user_id, created_at) VALUES ($1, $2, 'PASSED', $3, now(), $4, now())", [assessmentId, sellerId, sha(`assessment-${assessmentId}`), owner]);
    }
    await c.query(
      "INSERT INTO kauro.seller_confidentiality_acceptances (acceptance_id, seller_id, terms_hash, evidence_hash, accepted_at, recorded_by_user_id, created_at) VALUES ($1, $2, $3, $4, now(), $5, now())",
      [ids.next(), sellerId, sha("confidentiality-and-data-handling-v1"), sha(`acceptance-${sellerId}`), owner],
    );
    await c.query(
      "INSERT INTO kauro.seller_tax_documents (document_id, seller_id, jurisdiction, requirements_hash, evidence_hash, verified_at, verified_by_user_id, created_at) VALUES ($1, $2, 'CO', $3, $4, now(), $5, now())",
      [ids.next(), sellerId, sha(`requirements-${sellerId}`), sha(`tax-${sellerId}`), owner],
    );
  });
  // the seller's own change of its destination, with its own step-up; the owner verifies it 172800 s later (the labelled TEST CLOCK stands there)
  await asPerson(h, userId, (c) =>
    c.query(
      `INSERT INTO kauro.seller_payout_destinations (destination_id, seller_id, destination_version, masked_label, destination_digest, currency, changed_by_user_id, change_proof_ref, changed_at, created_at, updated_at)
       VALUES ($1, $2, 1, $3, $4, 'USD', $5, $6, kauro.server_now(), now(), now())`,
      [destinationId, sellerId, `Bank ****${destinationId.slice(-4)}`, destinationDigest, userId, sellerProof],
    ),
  );
  if (gaps.unverifiedDestination !== true) {
    await asPerson(h, owner, async (c) => {
      await c.query(
        "SELECT set_config('kauro_test.clock_offset_seconds', (extract(epoch FROM (x.at - transaction_timestamp())) + 172800)::text, true) FROM (SELECT changed_at AS at FROM kauro.seller_payout_destinations WHERE destination_id = $1) x",
        [destinationId],
      );
      await c.query("UPDATE kauro.seller_payout_destinations SET state = 'VERIFIED', verified_by_user_id = $2, verified_at = kauro.server_now(), version = version + 1 WHERE destination_id = $1", [destinationId, owner]);
      await c.query("SELECT set_config('kauro_test.clock_offset_seconds', '0', true)");
    });
  }
  return {
    sellerId: sellerId as never,
    userId,
    agreementId: agreementId as never,
    agreementVersion,
    reviewId,
    assessmentId,
    destinationId,
    destinationDigest,
    assessmentRef: assessmentId,
  };
}

/** The owner's prepared termination terms of a seller (CMD050 terminationTermsRef): a seller_terminations row, not yet effective. */
export async function prepareTerminationTerms(h: Harness, owner: UserId, sellerId: string): Promise<string> {
  const terminationId = ids.next();
  await asPerson(h, owner, (c) =>
    c.query("INSERT INTO kauro.seller_terminations (termination_id, seller_id, terms_hash, prepared_by_user_id, prepared_at, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now(), now())", [
      terminationId,
      sellerId,
      sha(`termination-terms-${terminationId}`),
      owner,
    ]),
  );
  return terminationId;
}

/** The owner's prepared manifest of the seller's active opportunities (CMD050 activeOpportunityManifestRef): the claim ids it hands over. */
export async function prepareManifest(h: Harness, owner: UserId, sellerId: string, entries: ReadonlyArray<string>): Promise<string> {
  const manifestId = ids.next();
  await asPerson(h, owner, (c) =>
    c.query("INSERT INTO kauro.termination_manifests (manifest_id, seller_id, claim_ids, manifest_hash, prepared_by_user_id, prepared_at, created_at) VALUES ($1, $2, $3::uuid[], $4, $5, now(), now())", [
      manifestId,
      sellerId,
      [...entries],
      sha(`manifest-${manifestId}-${entries.join(",")}`),
      owner,
    ]),
  );
  return manifestId;
}

/**
 * The seller's list-imported prospects (CMD045 with a lawful AGENCY-segment evidence record, none of them claimed): `count` RESEARCHED
 * prospects of distinct organizations written by the seller's own session in one statement.
 */
export async function scrapedProspects(h: Harness, seller: { readonly sellerId: string; readonly userId: string }, count: number): Promise<ReadonlyArray<string>> {
  const prospectIds = Array.from({ length: count }, () => ids.next());
  const evidenceHash = sha(`scraped-list-${seller.sellerId}`);
  const contactId = ids.next();
  await asPerson(h, seller.userId, async (c) => {
    await c.query(
      "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', 'AGENCY', now())",
      [ids.next(), seller.userId, seller.sellerId, evidenceHash, sha(`https://scraped-list.example/${seller.sellerId}`)],
    );
    await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactId, seller.userId, sha(`contact:${contactId}`)]);
    await c.query(
      `INSERT INTO kauro.prospects (prospect_id, organization_label, organization_key, business_contact_id, source_evidence_hash, jurisdiction, registered_by_user_id, registered_by_seller_id, owner_seller_id, created_at, updated_at)
       SELECT p.id, 'Scraped agency ' || p.n, encode(sha256(convert_to('scraped:' || $5::text || ':' || p.n, 'UTF8')), 'hex'), $2::uuid, $3, 'United States', $4::uuid, $5::uuid, $5::uuid, now(), now()
         FROM unnest($1::uuid[]) WITH ORDINALITY AS p(id, n)`,
      [prospectIds, contactId, evidenceHash, seller.userId, seller.sellerId],
    );
  });
  return prospectIds;
}

/** A seller TERMINATED as CMD050's writes leave it, directly under the owner's session (no tail, no claim touched): for tests of other commands. */
export async function terminateDirectly(h: Harness, owner: UserId, sellerId: string): Promise<void> {
  const terminationId = await prepareTerminationTerms(h, owner, sellerId);
  const manifestId = await prepareManifest(h, owner, sellerId, []);
  await asPerson(h, owner, async (c) => {
    await c.query("UPDATE kauro.seller_terminations SET manifest_id = $2, effective_at = kauro.server_now(), terminated_by_user_id = $3, version = 2 WHERE termination_id = $1", [terminationId, manifestId, owner]);
    await c.query("UPDATE kauro.sellers SET state = 'TERMINATED', terminated_at = kauro.server_now(), version = version + 1 WHERE seller_id = $1", [sellerId]);
  });
}

/** The superuser oracle's canonical text of the rows a query selects, in a stable order: "row for row" comparisons. */
export async function digest(h: Harness, sql: string, params: ReadonlyArray<unknown> = []): Promise<string> {
  const r = await h.oracle.query<{ row: string }>(`SELECT row_to_json(t)::text AS row FROM (${sql}) t ORDER BY 1`, [...params]);
  return JSON.stringify(r.rows.map((x) => x.row));
}

/** An ACTIVE selling agency of its own: its owner, a client and the reviewed fiscal profile B09's purchases need (as cmd043's). */
export interface Selling {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly clientId: string;
  readonly profileId: FiscalProfileId;
}

export async function sellingAgency(pw: PaymentsWorld, label: string): Promise<Selling> {
  const { w } = pw;
  const owner = await w.person(`${label}-owner`);
  const agency = await w.h.createAgency(owner.userId, `Agency ${label}`);
  await activateAgency(w.h, agency);
  const authority = await w.h.processingAuthority(agency);
  const clientId = await w.h.endClient(agency, authority, `${label} client`);
  const profileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: pw.kora.userId as UserId, agencyId: agency.agencyId, issuerRef: pw.issuerRef });
  return { agency, owner, clientId, profileId };
}

/** A purchase of the agency paid by one capture that alone pays it: the agency's qualifying purchase (B09's fixture, through the adapters). */
export async function paidProject(pw: PaymentsWorld, s: Selling, label: string): Promise<PaidPurchase> {
  const { w } = pw;
  const { projectId } = await w.project(s.agency, s.clientId as never);
  const plan = await w.approvable(s.agency, projectId, label, "SET", { recent: true });
  await approveThroughRoute(w, plan, s.owner, s.agency.agencyId);
  return paidPurchase(w.h, { agency: s.agency, planId: plan.planId as PlanId, route: pw.route, issuerRef: pw.issuerRef, profileId: s.profileId, treatment: "EXEMPT_EXPORT" });
}
