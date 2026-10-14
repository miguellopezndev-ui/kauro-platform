// Fixture of the B10 sales tests (mandate B10-COMMANDS-PROSPECTS; docs/design/B10-case-map.md CMD045..CMD047): a world whose api is bound to
// the labelled contract fake of BuyerTypeReader (SIMULATED, D10-FAKE-1), a corporate owner holding the ACTIVE KAURO_OWNER grant, ACTIVE
// sellers recorded with every activation fact (@kauro/persistence/testing), and the rows the commands consume — a seller's source evidence
// and business contact, a seller's claim evidence, an owner-prepared allocation — each written by the runtime role that owns it, under its
// real OPERATOR context. Nothing is written as the superuser; the superuser only reads.
import type { Client } from "pg";
import { ContractFakeBuyerTypeReader } from "@kauro/application/testing";
import type { UserId } from "@kauro/domain";
import { organizationKeyOf } from "@kauro/domain";
import { recordActiveSeller, type Harness, type RecordedSeller } from "@kauro/persistence/testing";
import { clock, ids, sha, world, type Person, type World, type WorldOptions } from "./support.js";

export interface Seller extends RecordedSeller {
  readonly person: Person;
}

/** A person's OPERATOR session on the runtime login role: its person bound, no agency (the shape of the api's own unit of work). */
export async function asOperator<T>(h: Harness, userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await h.pg.connect("kauro_app_test");
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [userId]);
    try {
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

export interface SalesWorld {
  readonly w: World;
  readonly buyerTypes: ContractFakeBuyerTypeReader;
  /** A corporate owner: an individually managed corporate identity with an ACTIVE KAURO_OWNER grant. */
  readonly owner: Person;
  seller(label: string): Promise<Seller>;
  stop(): Promise<void>;
}

/** An ACTIVE seller of a new corporate identity, recorded by the owner with every activation fact, and the person whose token is its own. */
export async function recordSeller(w: World, ownerUserId: string, label: string): Promise<Seller> {
  const person = await w.person(`seller-${label}`, { sync: false });
  const recorded = await recordActiveSeller(w.h, { ownerUserId: ownerUserId as UserId, subject: label });
  if (recorded.userId !== person.userId) throw new Error("the seller's identity is not the person the token names");
  return { ...recorded, person };
}

export async function salesWorld(options: Omit<WorldOptions, "commercial"> = {}, label = "sales"): Promise<SalesWorld> {
  const buyerTypes = new ContractFakeBuyerTypeReader({ clock });
  const w = await world({ ...options, commercial: { buyerTypes } });
  const owner = await w.person(`${label}-corporate-owner`);
  await w.h.grantKauroOwner(owner.userId);
  return {
    w,
    buyerTypes,
    owner,
    seller: (sellerLabel) => recordSeller(w, owner.userId, sellerLabel),
    stop: () => w.stop(),
  };
}

export interface RecordedEvidence {
  readonly sourceEvidenceHash: string;
  readonly contactRef: string;
  readonly contactKey: string;
}

/** A caller's own AGENCY-segment source evidence (lawful basis, dated) and restricted business contact, written under its own session. */
export async function recordSourceEvidence(
  h: Harness,
  by: { readonly userId: string; readonly sellerId?: string },
  options: { readonly domain: string; readonly segment?: "AGENCY" | "COMPANY"; readonly contactKey?: string },
): Promise<RecordedEvidence> {
  const contactRef = ids.next();
  const contactKey = options.contactKey ?? sha(`contact:${options.domain}:${contactRef}`);
  const sourceEvidenceHash = sha(`source-evidence-${options.domain}-${contactRef}`);
  await asOperator(h, by.userId, async (c) => {
    await c.query(
      "INSERT INTO kauro.prospect_source_evidence (evidence_id, recorded_by_user_id, seller_id, evidence_hash, source_url_digest, observed_on, lawful_basis, segment, created_at) VALUES ($1, $2, $3, $4, $5, current_date, 'LEGITIMATE_INTEREST', $6, now())",
      [ids.next(), by.userId, by.sellerId ?? null, sourceEvidenceHash, sha(`https://${options.domain}/`), options.segment ?? "AGENCY"],
    );
    await c.query("INSERT INTO kauro.prospect_contacts (contact_id, recorded_by_user_id, contact_key, contact_label, role_label, channel, created_at) VALUES ($1, $2, $3, 'Operations lead', 'Head of operations', 'EMAIL', now())", [contactRef, by.userId, contactKey]);
  });
  return { sourceEvidenceHash, contactRef, contactKey };
}

/** The owner's suppression of an organization (by its domain, normalized as the platform does) or of a contact key. */
export async function suppress(h: Harness, ownerUserId: string, target: { readonly domain: string } | { readonly contactKey: string }): Promise<void> {
  const keyKind = "domain" in target ? "ORGANIZATION" : "CONTACT";
  const key = "domain" in target ? (organizationKeyOf(target.domain)?.key ?? "") : target.contactKey;
  // the writer holds L8 X of 'KEYKIND:key' (B12 0088 prospect_suppressions_locks, plan §L), the lock CMD064 SUPPRESSED takes
  await asOperator(h, ownerUserId, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.prospect_suppressions', $1))", [`${keyKind}:${key}`]);
    await c.query("INSERT INTO kauro.prospect_suppressions (suppression_id, key_kind, suppression_key, reason, recorded_by_user_id, recorded_at, created_at) VALUES ($1, $2, $3, 'OPTED_OUT', $4, kauro.server_now(), now())", [ids.next(), keyKind, key, ownerUserId]);
  });
}

/** A seller's claim evidence for a prospect: first meaningful contact two days ago and the given activity kinds (substantive by default). */
export async function recordClaimEvidence(h: Harness, seller: RecordedSeller, prospectId: string, activityKinds: ReadonlyArray<string> = ["DISCOVERY_MEETING", "QUALIFIED_NEED"]): Promise<string> {
  const evidenceHash = sha(`claim-evidence-${ids.next()}`);
  await asOperator(h, seller.userId, (c) =>
    c.query(
      `INSERT INTO kauro.claim_evidence (evidence_id, seller_id, prospect_id, evidence_hash, source_channel, first_meaningful_contact_at, qualified_need_hash, activity_kinds, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, 'DISCOVERY_CALL', kauro.server_now() - interval '2 days', $5, $6::text[], kauro.server_now(), now())`,
      [ids.next(), seller.sellerId, prospectId, evidenceHash, sha(`need-${evidenceHash}`), activityKinds],
    ),
  );
  return evidenceHash;
}

/**
 * The owner's prepared allocation of the claims on a prospect to an agency, unfrozen: the ruling reason and evidence, the pool terms of the
 * sellers' signed agreements (1000/400 bps, twelve months) and each beneficiary's share. Returns its id (CMD047's shareAllocationRef).
 */
export async function prepareAllocation(
  h: Harness,
  options: { readonly ownerUserId: string; readonly agencyId: string; readonly prospectId: string; readonly shares: ReadonlyArray<{ readonly seller: RecordedSeller; readonly claimId: string; readonly shareBps: number }> },
): Promise<string> {
  const allocationId = ids.next();
  await asOperator(h, options.ownerUserId, async (c) => {
    await c.query(
      `INSERT INTO kauro.attribution_allocations (allocation_id, agency_id, prospect_id, identity_evidence_hash, ruling_reason, ruling_evidence_hash, first_bps, repeat_bps, recurring_months, prepared_by_user_id, prepared_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'Qualified discovery and first meaningful contact by the claimant', $5, 1000, 400, 12, $6, now(), now(), now())`,
      [allocationId, options.agencyId, options.prospectId, sha(`identity-${allocationId}`), sha(`ruling-${allocationId}`), options.ownerUserId],
    );
    for (const s of options.shares) {
      await c.query(
        `INSERT INTO kauro.allocation_shares (allocation_id, seller_id, claim_id, prospect_id, agreement_id, agreement_version, share_bps, first_bps, repeat_bps, recurring_months, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1000, 400, 12, now())`,
        [allocationId, s.seller.sellerId, s.claimId, options.prospectId, s.seller.agreementId, s.seller.agreementVersion, s.shareBps],
      );
    }
  });
  return allocationId;
}
