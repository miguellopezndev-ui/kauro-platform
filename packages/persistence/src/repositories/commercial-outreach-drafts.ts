/**
 * The draft, content and resource records of package B12's lane L-DRAFT over `pg` (docs/design/B12-outreach-plan.md §L, §M, §W; migration
 * 0072): CMD061 PrepareOutreachDraft, PutOutreachContent, PublishSalesResource and the two reads. Reads are made under the unit of work's
 * own policies, so a row the caller may not see answers null, never an error that tells it exists.
 *
 * Every writer follows the one pattern of plan §L: a DISCOVERY read (no lock; it only names the subjects), the advisory subjects in the
 * global order through OutreachLocks (L1 and L2 are already held: the access decision and the journal reservation), ONE judgment statement
 * (marked /* b12:judge *\/) that reads kauro.effect_now() and every locked fact, the refusals, requireHeld, and then the first write (marked
 * /* b12:write *\/) with no other await between the judgment and it. Instants are the database's (kauro.effect_now() judges, the column
 * defaults kauro.server_now() stamp); the application passes none.
 *
 * Trace of CMD061: L3 S prospect, L5 S capability subjects (ascending), L6 S resource families (ascending), L6p S jurisdiction:purpose,
 * L7 S sender, L8 S CONTACT key then ORGANIZATION key, L10 X the new draft. PublishSalesResource: L5 S (ascending), L6 X of the family.
 * PutOutreachContent: no B12 subject (content-addressed, ON CONFLICT DO NOTHING).
 */
import { DomainFailure, NotFoundFailure, StaleVersionFailure, outreachBindingHash, outreachContentId, type UserId } from "@kauro/domain";
import { OutreachLocks } from "../outreach-access.js";
import { execute, type Queryable } from "../sql.js";
import { requireHeld, type Need } from "./commercial-outreach.js";

type Purpose = "REQUESTED_REPLY" | "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP";

export interface PrepareDraftInput {
  readonly draftId: string;
  readonly actor: { readonly kind: "SELLER"; readonly userId: UserId; readonly sellerId: string } | { readonly kind: "OWNER"; readonly userId: UserId };
  readonly prospectId: string;
  readonly senderId: string;
  readonly purpose: Purpose;
  readonly contentRef: string;
  readonly provenanceEvidenceHash: string;
  readonly resourceIds: ReadonlyArray<string>;
}

export interface PublishResourceInput {
  readonly resourceId: string;
  /** The family: chosen by the publisher for a new family (expectedVersion 0), the existing one otherwise. */
  readonly familyId: string;
  /** The CURRENT version the publisher read; 0 publishes version 1 of a new family. */
  readonly expectedVersion: number;
  readonly contentRef: string;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly publishedByUserId: UserId;
}

interface ProspectFacts {
  prospect_id: string;
  owner_seller_id: string | null;
  source_evidence_hash: string;
  organization_key: string;
  policy_jurisdiction: string;
  contact_key: string | null;
}

interface Verdict {
  judged_at: Date;
  sender_state: string | null;
  policy_state: string | null;
  suppressed: boolean;
  offered_resources: string;
}

const ISO = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const unique = (ids: ReadonlyArray<string>): string[] => [...new Set(ids)];

export class PgOutreachDrafts {
  constructor(private readonly db: Queryable) {}

  /** CMD061: one COMMIT's worth of writes (the draft and its cited resources); the journal reservation is the caller's. */
  async prepareDraft(i: PrepareDraftInput): Promise<{ readonly draftId: string; readonly version: 1; readonly state: "DRAFT"; readonly contentHash: string }> {
    const resourceIds = unique(i.resourceIds);
    // --- discovery (no lock): the facts that name the subjects; a row the caller cannot see is as unknown as one nobody holds ---
    const prospect = (
      await execute<ProspectFacts>(
        this.db,
        `SELECT p.prospect_id, p.owner_seller_id, p.source_evidence_hash, p.organization_key, kauro.outreach_jurisdiction(p.jurisdiction) AS policy_jurisdiction, c.contact_key
           FROM kauro.prospects p
           LEFT JOIN kauro.prospect_contacts c ON c.recorded_by_user_id = p.registered_by_user_id AND c.contact_id = p.business_contact_id
          WHERE p.prospect_id = $1`,
        [i.prospectId],
      )
    ).rows[0];
    if (prospect === undefined || prospect.contact_key === null) throw new NotFoundFailure("prospect");
    if (i.actor.kind === "SELLER" && prospect.owner_seller_id !== i.actor.sellerId) throw new NotFoundFailure("prospect");
    if (prospect.source_evidence_hash !== i.provenanceEvidenceHash) throw new NotFoundFailure("provenance");
    const sender = (await execute<{ user_id: string }>(this.db, "SELECT user_id FROM kauro.sender_identities WHERE sender_id = $1", [i.senderId])).rows[0];
    if (sender === undefined || (i.actor.kind === "SELLER" && sender.user_id !== i.actor.userId)) throw new NotFoundFailure("sender");
    if ((await execute(this.db, "SELECT 1 FROM kauro.outreach_contents WHERE content_id = $1", [i.contentRef])).rowCount !== 1) throw new NotFoundFailure("content");
    let families: string[] = [];
    let capabilitySubjects: string[] = [];
    if (resourceIds.length > 0) {
      const found = await execute<{ family_id: string }>(this.db, "SELECT DISTINCT family_id FROM kauro.sales_resources WHERE resource_id = ANY($1::uuid[])", [resourceIds]);
      const count = await execute(this.db, "SELECT 1 FROM kauro.sales_resources WHERE resource_id = ANY($1::uuid[])", [resourceIds]);
      if (count.rowCount !== resourceIds.length) throw new NotFoundFailure("sales_resource");
      families = found.rows.map((r) => r.family_id);
      capabilitySubjects = (
        await execute<{ subject: string }>(
          this.db,
          `SELECT DISTINCT coalesce(k.mode, k.capability_id::text) AS subject
             FROM kauro.sales_resource_capabilities rc JOIN kauro.capabilities k ON k.capability_id = rc.capability_id
            WHERE rc.resource_id = ANY($1::uuid[])`,
          [resourceIds],
        )
      ).rows.map((r) => r.subject);
    }
    const contactKey = prospect.contact_key;
    const contactSubject = `CONTACT:${contactKey}`;
    const organizationSubject = `ORGANIZATION:${prospect.organization_key}`;
    const policySubject = `${prospect.policy_jurisdiction}:${i.purpose}`;

    // --- the serializer set, in the global order (L1, L2 held by the request runtime) ---
    const locks = new OutreachLocks(this.db);
    await locks.take("L3", i.prospectId, "S");
    await locks.takeAll("L5", capabilitySubjects, "S");
    await locks.takeAll("L6", families, "S");
    await locks.take("L6p", policySubject, "S");
    await locks.take("L7", i.senderId, "S");
    await locks.takeAll("L8", [contactSubject, organizationSubject], "S");
    await locks.take("L10", i.draftId, "X");

    // --- the judgment: one statement, at the database's instant, over the locked facts ---
    const verdict = (
      await execute<Verdict>(
        this.db,
        `/* b12:judge */ SELECT kauro.effect_now() AS judged_at,
                (SELECT s.state FROM kauro.sender_identities s WHERE s.sender_id = $1) AS sender_state,
                (SELECT cp.state FROM kauro.outreach_channel_policies cp WHERE cp.jurisdiction = $2 AND cp.purpose = $3 ORDER BY cp.version DESC LIMIT 1) AS policy_state,
                (EXISTS (SELECT 1 FROM kauro.prospect_suppressions x WHERE (x.key_kind = 'CONTACT' AND x.suppression_key = $4) OR (x.key_kind = 'ORGANIZATION' AND x.suppression_key = $5))
                 OR EXISTS (SELECT 1 FROM kauro.prospects p WHERE p.prospect_id = $6 AND p.state = 'SUPPRESSED')) AS suppressed,
                (SELECT count(*) FROM kauro.sales_resources r
                  WHERE r.resource_id = ANY($7::uuid[]) AND r.state = 'CURRENT'
                    AND NOT EXISTS (SELECT 1 FROM kauro.sales_resource_capabilities rc JOIN kauro.capabilities k ON k.capability_id = rc.capability_id
                                     WHERE rc.resource_id = r.resource_id AND k.state NOT IN ('AVAILABLE', 'AVAILABLE_LIMITED'))) AS offered_resources`,
        [i.senderId, prospect.policy_jurisdiction, i.purpose, contactKey, prospect.organization_key, i.prospectId, resourceIds],
      )
    ).rows[0];
    if (verdict === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the draft judgment answered no row");
    if (verdict.sender_state === null) throw new NotFoundFailure("sender");
    if (verdict.sender_state === "REVOKED") throw new DomainFailure("PRECONDITION_FAILED", "the sender identity was revoked", { reason: "SENDER_REVOKED" });
    if (verdict.sender_state !== "VERIFIED") throw new DomainFailure("PRECONDITION_FAILED", "the sender identity is not verified", { reason: "SENDER_NOT_VERIFIED" });
    if (verdict.policy_state !== "IN_FORCE") throw new DomainFailure("PRECONDITION_FAILED", "no reviewed outreach policy is in force for the prospect's jurisdiction and this purpose", { reason: "OUTREACH_JURISDICTION_UNREVIEWED" });
    if (verdict.suppressed) throw new DomainFailure("PRECONDITION_FAILED", "the contact or the organization is suppressed", { reason: "PROSPECT_SUPPRESSED" });
    if (Number(verdict.offered_resources) !== resourceIds.length) throw new DomainFailure("PRECONDITION_FAILED", "a cited resource is no longer CURRENT or claims a capability that is not offered", { reason: "RESOURCE_NOT_CURRENT" });

    const needs: Need[] = [["L3", i.prospectId, "S"], ["L6p", policySubject, "S"], ["L7", i.senderId, "S"], ["L8", contactSubject, "S"], ["L8", organizationSubject, "S"], ["L10", i.draftId, "X"]];
    for (const s of capabilitySubjects) needs.push(["L5", s, "S"]);
    for (const f of families) needs.push(["L6", f, "S"]);
    requireHeld(locks, "CMD061 draft", needs);

    // --- the writes: the draft, then the content binding (its cited resources) ---
    const contentHash = outreachBindingHash({ prospectId: i.prospectId, contactKey, senderId: i.senderId, purpose: i.purpose, contentRef: i.contentRef });
    await execute(
      this.db,
      `/* b12:write */ INSERT INTO kauro.outreach_drafts (draft_id, prospect_id, sender_id, author_user_id, purpose, content_ref, contact_key, content_hash, provenance_evidence_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [i.draftId, i.prospectId, i.senderId, i.actor.userId, i.purpose, i.contentRef, contactKey, contentHash, i.provenanceEvidenceHash],
    );
    if (resourceIds.length > 0) {
      await execute(this.db, "INSERT INTO kauro.outreach_draft_resources (draft_id, resource_id) SELECT $1, unnest($2::uuid[])", [i.draftId, resourceIds]);
    }
    return { draftId: i.draftId, version: 1, state: "DRAFT", contentHash };
  }

  /** PutOutreachContent: content-addressed (domain outreachContentId); a second put of the same text is a no-op that answers the same id. */
  async putContent(content: { readonly subject: string; readonly body: string }, recordedByUserId: UserId): Promise<{ readonly contentRef: string; readonly createdAt: string }> {
    const contentId = outreachContentId(content.subject, content.body);
    await execute(this.db, "INSERT INTO kauro.outreach_contents (content_id, subject, body, recorded_by_user_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [contentId, content.subject, content.body, recordedByUserId]);
    const row = (await execute<{ created_at: string }>(this.db, `SELECT ${ISO} AS created_at FROM kauro.outreach_contents WHERE content_id = $1`, [contentId])).rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the stored content cannot be read back");
    return { contentRef: contentId, createdAt: row.created_at };
  }

  /** PublishSalesResource: version n+1 of a family (or version 1 of a new one); n is superseded in the same transaction. */
  async publishResource(i: PublishResourceInput): Promise<{ readonly resourceId: string; readonly familyId: string; readonly version: number; readonly state: "CURRENT" }> {
    const capabilityIds = unique(i.capabilityIds);
    const familyId = i.familyId;
    // --- discovery ---
    if ((await execute(this.db, "SELECT 1 FROM kauro.outreach_contents WHERE content_id = $1", [i.contentRef])).rowCount !== 1) throw new NotFoundFailure("content");
    let capabilitySubjects: string[] = [];
    if (capabilityIds.length > 0) {
      const caps = await execute<{ subject: string }>(this.db, "SELECT coalesce(mode, capability_id::text) AS subject FROM kauro.capabilities WHERE capability_id = ANY($1::uuid[])", [capabilityIds]);
      if (caps.rowCount !== capabilityIds.length) throw new NotFoundFailure("capability");
      capabilitySubjects = caps.rows.map((r) => r.subject);
    }
    // --- the serializer set: L5 S of every claimed capability, then L6 X of the family ---
    const locks = new OutreachLocks(this.db);
    await locks.takeAll("L5", capabilitySubjects, "S");
    await locks.take("L6", familyId, "X");
    // --- the judgment: the family's latest version, read after its subject was taken ---
    const latest = (
      await execute<{ resource_id: string; version: number; state: string }>(
        this.db,
        "/* b12:judge */ SELECT resource_id, version, state FROM kauro.sales_resources WHERE family_id = $1 ORDER BY version DESC LIMIT 1",
        [familyId],
      )
    ).rows[0];
    if (latest === undefined) {
      if (i.expectedVersion !== 0) throw new NotFoundFailure("sales_resource_family");
    } else if (latest.version !== i.expectedVersion || latest.state !== "CURRENT") {
      throw new StaleVersionFailure(latest.version, latest.state);
    }
    const needs: Need[] = [["L6", familyId, "X"]];
    for (const s of capabilitySubjects) needs.push(["L5", s, "S"]);
    requireHeld(locks, "PublishSalesResource", needs);
    // --- the writes ---
    const version = latest === undefined ? 1 : latest.version + 1;
    if (latest !== undefined) {
      await execute(this.db, "/* b12:write */ UPDATE kauro.sales_resources SET state = 'SUPERSEDED' WHERE resource_id = $1 AND state = 'CURRENT'", [latest.resource_id]);
      await execute(this.db, "INSERT INTO kauro.sales_resources (resource_id, family_id, version, content_id, published_by_user_id) VALUES ($1, $2, $3, $4, $5)", [i.resourceId, familyId, version, i.contentRef, i.publishedByUserId]);
    } else {
      await execute(this.db, "/* b12:write */ INSERT INTO kauro.sales_resources (resource_id, family_id, version, content_id, published_by_user_id) VALUES ($1, $2, $3, $4, $5)", [i.resourceId, familyId, version, i.contentRef, i.publishedByUserId]);
    }
    if (capabilityIds.length > 0) {
      await execute(this.db, "INSERT INTO kauro.sales_resource_capabilities (resource_id, capability_id) SELECT $1, unnest($2::uuid[])", [i.resourceId, capabilityIds]);
    }
    return { resourceId: i.resourceId, familyId, version, state: "CURRENT" };
  }

  async draftOf(draftId: string): Promise<{
    readonly draftId: string;
    readonly prospectId: string;
    readonly senderId: string;
    readonly purpose: Purpose;
    readonly contentRef: string;
    readonly contentHash: string;
    readonly provenanceEvidenceHash: string;
    readonly version: number;
    readonly state: string;
    readonly resourceIds: ReadonlyArray<string>;
    readonly createdAt: string;
  } | null> {
    const r = (
      await execute<{ draft_id: string; prospect_id: string; sender_id: string; purpose: Purpose; content_ref: string; content_hash: string; provenance_evidence_hash: string; version: string; state: string; created_at: string }>(
        this.db,
        `SELECT draft_id, prospect_id, sender_id, purpose, content_ref, content_hash, provenance_evidence_hash, version, state, ${ISO} AS created_at FROM kauro.outreach_drafts WHERE draft_id = $1`,
        [draftId],
      )
    ).rows[0];
    if (r === undefined) return null;
    const cited = await execute<{ resource_id: string }>(this.db, "SELECT resource_id FROM kauro.outreach_draft_resources WHERE draft_id = $1 ORDER BY resource_id", [draftId]);
    return {
      draftId: r.draft_id,
      prospectId: r.prospect_id,
      senderId: r.sender_id,
      purpose: r.purpose,
      contentRef: r.content_ref,
      contentHash: r.content_hash,
      provenanceEvidenceHash: r.provenance_evidence_hash,
      version: Number(r.version),
      state: r.state,
      resourceIds: cited.rows.map((c) => c.resource_id),
      createdAt: r.created_at,
    };
  }

  async resourceOf(resourceId: string): Promise<{
    readonly resourceId: string;
    readonly familyId: string;
    readonly version: number;
    readonly state: "CURRENT" | "SUPERSEDED";
    readonly currentResourceId: string;
    readonly contentRef: string;
    readonly capabilityIds: ReadonlyArray<string>;
    readonly createdAt: string;
  } | null> {
    const r = (
      await execute<{ resource_id: string; family_id: string; version: number; state: "CURRENT" | "SUPERSEDED"; content_id: string; current_resource_id: string | null; created_at: string }>(
        this.db,
        `SELECT r.resource_id, r.family_id, r.version, r.state, r.content_id, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                (SELECT c.resource_id FROM kauro.sales_resources c WHERE c.family_id = r.family_id AND c.state = 'CURRENT') AS current_resource_id
           FROM kauro.sales_resources r WHERE r.resource_id = $1`,
        [resourceId],
      )
    ).rows[0];
    if (r === undefined) return null;
    const claims = await execute<{ capability_id: string }>(this.db, "SELECT capability_id FROM kauro.sales_resource_capabilities WHERE resource_id = $1 ORDER BY capability_id", [resourceId]);
    return {
      resourceId: r.resource_id,
      familyId: r.family_id,
      version: r.version,
      state: r.state,
      currentResourceId: r.current_resource_id ?? r.resource_id,
      contentRef: r.content_id,
      capabilityIds: claims.rows.map((c) => c.capability_id),
      createdAt: r.created_at,
    };
  }
}
