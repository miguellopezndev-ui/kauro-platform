/**
 * The SQL of lane L-AUTH of package B12 (docs/design/B12-outreach-plan.md §L, §2 PrepareOutreachReview, CMD062, RevokeOutreachAuthorization,
 * WithdrawOutreachChannelPolicy): the owner's review, the grant over sealed drafts, the grant's revocation and the policy withdrawal. Every
 * advisory subject of a trace is taken through this unit's OutreachLocks (one global order, refused when reordered); a writer refuses to run
 * before the subjects 0072's T2 asserts are held. Instants are the database's (kauro.effect_now() inside the judging statement).
 * D-33: nothing here reads a segment or a buyer type. A17: nothing here writes a prospect.
 */
import { DomainFailure, type OutreachPurpose, type SenderRoute, type SenderState } from "@kauro/domain";
import type { UtcInstant } from "@kauro/contracts";
import { OutreachLocks } from "../outreach-access.js";
import { ConstraintViolation, execute, instant, int, text, type Queryable } from "../sql.js";

const FMT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const ts = (col: string): string => `to_char(${col} AT TIME ZONE 'UTC', ${FMT})`;
const at = (v: unknown): UtcInstant => instant(v);

export interface AuthSenderFact {
  readonly senderId: string;
  readonly state: SenderState;
  readonly route: SenderRoute;
}
export interface AuthDraftFact {
  readonly draftId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly state: string;
  readonly senderId: string;
  readonly purpose: OutreachPurpose;
  readonly contactLabel: string | null;
  readonly policyInForce: boolean;
  readonly complianceConfigured: boolean;
}
export interface ReviewItemInput {
  readonly draftId: string;
  readonly draftVersion: number;
  readonly contentHash: string;
  readonly contactLabel: string;
}
export interface ReviewRecordFact {
  readonly reviewId: string;
  readonly ownerUserId: string;
  readonly proofId: string;
  readonly senderId: string;
  readonly digest: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly items: ReadonlyArray<ReviewItemInput>;
}
export interface GrantFacts {
  /** The review row judged at kauro.effect_now() in this statement: live (judged < expires_at) and whether a grant already consumed it. */
  readonly reviewLive: boolean;
  readonly reviewConsumed: boolean;
  /** The grant's window judged at the same instant: validFrom clamped up to it; expiresAt after it and within 14 days of it. */
  readonly windowOk: boolean;
  readonly judgedAt: UtcInstant;
  readonly sender: AuthSenderFact | null;
  readonly drafts: ReadonlyArray<AuthDraftFact>;
  /** Cited resources no longer CURRENT, and claimed capabilities no longer offered (KC033). */
  readonly resourcesNotCurrent: number;
  readonly capabilitiesRestricted: number;
}
export interface AuthorizationFact {
  readonly authorizationId: string;
  readonly reviewId: string;
  readonly grantingUserId: string;
  readonly senderId: string;
  readonly validFrom: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly maximumSends: number;
  readonly permissionEvidenceHash: string;
  readonly policyVersion: string;
  readonly revoked: boolean;
  readonly allowedContentHashes: ReadonlyArray<string>;
}
export interface PolicyFact {
  readonly jurisdiction: string;
  readonly purpose: OutreachPurpose;
  readonly version: number;
  readonly state: "IN_FORCE" | "WITHDRAWN";
}

export class PgOutreachAuth {
  readonly locks: OutreachLocks;
  constructor(private readonly db: Queryable) {
    this.locks = new OutreachLocks(db);
  }

  #held(what: string, lock: "L10" | "L4g" | "L6p", subject: string, mode: "S" | "X"): void {
    const ok = this.locks.taken.some((t) => t.lock === lock && t.subject === subject && (mode === "S" || t.mode === "X"));
    if (!ok) throw new DomainFailure("INTEGRITY_FAILURE", `${what} needs ${lock} ${mode} of ${subject} held before it writes (plan §L)`);
  }

  // --- PrepareOutreachReview (L1 -> L2 -> L10 S ascending -> effect_now -> INSERT) ---------------------------------------------------

  async senderOf(senderId: string): Promise<AuthSenderFact | null> {
    const r = await execute(this.db, "SELECT sender_id, state, route FROM kauro.sender_identities WHERE sender_id = $1", [senderId]);
    const row = r.rows[0];
    return row === undefined ? null : { senderId: text(row["sender_id"]), state: row["state"] as SenderState, route: row["route"] as SenderRoute };
  }

  /** L10 S of each draft, ascending. */
  async lockDraftsShared(draftIds: ReadonlyArray<string>): Promise<void> {
    await this.locks.takeAll("L10", draftIds, "S");
  }

  /** The drafts of a review, read after their L10 S; absent ids are simply missing from the answer. */
  async draftsOf(draftIds: ReadonlyArray<string>): Promise<ReadonlyArray<AuthDraftFact>> {
    const r = await execute(
      this.db,
      `SELECT d.draft_id, d.version, d.content_hash, d.state, d.sender_id, d.purpose,
              (SELECT c.contact_label FROM kauro.prospect_contacts c WHERE c.contact_key = d.contact_key ORDER BY c.created_at, c.contact_id LIMIT 1) AS contact_label,
              EXISTS (SELECT 1 FROM kauro.outreach_channel_policies cp WHERE cp.jurisdiction = kauro.outreach_jurisdiction(p.jurisdiction) AND cp.purpose = d.purpose AND cp.state = 'IN_FORCE') AS policy_in_force,
              EXISTS (SELECT 1 FROM kauro.outreach_channel_policies cp WHERE cp.jurisdiction = kauro.outreach_jurisdiction(p.jurisdiction) AND cp.purpose = d.purpose AND cp.state = 'IN_FORCE'
                        AND cp.postal_address IS NOT NULL AND cp.opt_out_origin IS NOT NULL) AS compliance_configured
         FROM kauro.outreach_drafts d JOIN kauro.prospects p ON p.prospect_id = d.prospect_id
        WHERE d.draft_id = ANY($1::uuid[]) ORDER BY d.draft_id`,
      [draftIds],
    );
    return r.rows.map((row) => ({
      draftId: text(row["draft_id"]),
      version: int(row["version"]),
      contentHash: text(row["content_hash"]),
      state: text(row["state"]),
      senderId: text(row["sender_id"]),
      purpose: row["purpose"] as OutreachPurpose,
      contactLabel: row["contact_label"] === null ? null : text(row["contact_label"]),
      policyInForce: row["policy_in_force"] === true,
      complianceConfigured: row["compliance_configured"] === true,
    }));
  }

  /** INSERT the review and its lines; issued_at and the 15 minutes are the database's (0072 outreach_reviews_binding). */
  async issueReview(r: { readonly reviewId: string; readonly ownerUserId: string; readonly proofId: string; readonly senderId: string; readonly digest: string; readonly items: ReadonlyArray<ReviewItemInput> }): Promise<{ readonly issuedAt: UtcInstant; readonly expiresAt: UtcInstant }> {
    for (const it of r.items) this.#held("review", "L10", it.draftId, "S");
    const ins = await execute(
      this.db,
      `INSERT INTO kauro.outreach_reviews (review_id, owner_user_id, proof_id, sender_id, digest, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, kauro.effect_now(), kauro.effect_now() + interval '15 minutes')
       RETURNING ${ts("issued_at")} AS issued_at, ${ts("expires_at")} AS expires_at`,
      [r.reviewId, r.ownerUserId, r.proofId, r.senderId, r.digest],
    );
    for (const it of r.items) {
      await execute(this.db, "INSERT INTO kauro.outreach_review_items (review_id, draft_id, draft_version, content_hash, contact_label) VALUES ($1, $2, $3, $4, $5)", [r.reviewId, it.draftId, it.draftVersion, it.contentHash, it.contactLabel]);
    }
    const row = ins.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the review insert answered no row");
    return { issuedAt: at(row["issued_at"]), expiresAt: at(row["expires_at"]) };
  }

  // --- reads of a review ----------------------------------------------------------------------------------------------------------------

  async reviewById(reviewId: string): Promise<ReviewRecordFact | null> {
    return this.#review("r.review_id = $1", reviewId);
  }
  async reviewByDigest(digest: string): Promise<ReviewRecordFact | null> {
    return this.#review("r.digest = $1", digest);
  }
  async #review(where: string, key: string): Promise<ReviewRecordFact | null> {
    const r = await execute(this.db, `SELECT r.review_id, r.owner_user_id, r.proof_id, r.sender_id, r.digest, ${ts("r.issued_at")} AS issued_at, ${ts("r.expires_at")} AS expires_at FROM kauro.outreach_reviews r WHERE ${where} ORDER BY r.issued_at DESC LIMIT 1`, [key]);
    const row = r.rows[0];
    if (row === undefined) return null;
    const items = await execute(this.db, "SELECT draft_id, draft_version, content_hash, contact_label FROM kauro.outreach_review_items WHERE review_id = $1 ORDER BY draft_id", [row["review_id"]]);
    return {
      reviewId: text(row["review_id"]),
      ownerUserId: text(row["owner_user_id"]),
      proofId: text(row["proof_id"]),
      senderId: text(row["sender_id"]),
      digest: text(row["digest"]),
      issuedAt: at(row["issued_at"]),
      expiresAt: at(row["expires_at"]),
      items: items.rows.map((i) => ({ draftId: text(i["draft_id"]), draftVersion: int(i["draft_version"]), contentHash: text(i["content_hash"]), contactLabel: text(i["contact_label"]) })),
    };
  }

  // --- CMD062 (L1 -> L2 -> L5 S -> L6 S -> L7 S -> L10 S ascending -> judge -> INSERT) --------------------------------------------------------

  /** Discovery (the links are append-only) then the serializer set in the global order: capabilities, resource families, the sender, the drafts. */
  async lockGrantSet(draftIds: ReadonlyArray<string>, senderId: string): Promise<void> {
    const caps = await execute(
      this.db,
      `SELECT DISTINCT coalesce(c.mode, c.capability_id::text) AS subject
         FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resource_capabilities rc ON rc.resource_id = dr.resource_id JOIN kauro.capabilities c ON c.capability_id = rc.capability_id
        WHERE dr.draft_id = ANY($1::uuid[])`,
      [draftIds],
    );
    const fams = await execute(this.db, "SELECT DISTINCT r.family_id::text AS family FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resources r ON r.resource_id = dr.resource_id WHERE dr.draft_id = ANY($1::uuid[])", [draftIds]);
    await this.locks.takeAll("L5", caps.rows.map((x) => text(x["subject"])), "S");
    await this.locks.takeAll("L6", fams.rows.map((x) => text(x["family"])), "S");
    await this.locks.take("L7", senderId, "S");
    await this.locks.takeAll("L10", draftIds, "S");
  }

  /** The judgment: one effect_now for the review and the window, then the locked facts of the sender, drafts and cited resources. */
  async grantFacts(q: { readonly reviewId: string; readonly draftIds: ReadonlyArray<string>; readonly senderId: string; readonly validFrom: string; readonly expiresAt: string }): Promise<GrantFacts> {
    const j = await execute(
      this.db,
      `WITH t AS MATERIALIZED (SELECT kauro.effect_now() AS at)
       SELECT ${ts("t.at")} AS judged_at,
              coalesce(t.at < r.expires_at, false) AS live,
              EXISTS (SELECT 1 FROM kauro.outreach_authorizations a WHERE a.review_id = $1) AS consumed,
              ($3::timestamptz > greatest($2::timestamptz, t.at) AND $3::timestamptz <= greatest($2::timestamptz, t.at) + interval '14 days') AS window_ok
         FROM t LEFT JOIN kauro.outreach_reviews r ON r.review_id = $1`,
      [q.reviewId, q.validFrom, q.expiresAt],
    );
    const jr = j.rows[0];
    if (jr === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the judgment statement answered no row");
    const resources = await execute(
      this.db,
      `SELECT (SELECT count(*) FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resources r ON r.resource_id = dr.resource_id WHERE dr.draft_id = ANY($1::uuid[]) AND r.state <> 'CURRENT') AS not_current,
              (SELECT count(*) FROM kauro.outreach_draft_resources dr JOIN kauro.sales_resource_capabilities rc ON rc.resource_id = dr.resource_id JOIN kauro.capabilities c ON c.capability_id = rc.capability_id
                WHERE dr.draft_id = ANY($1::uuid[]) AND c.state NOT IN ('AVAILABLE_LIMITED', 'AVAILABLE')) AS restricted`,
      [q.draftIds],
    );
    const rr = resources.rows[0];
    return {
      reviewLive: jr["live"] === true,
      reviewConsumed: jr["consumed"] === true,
      windowOk: jr["window_ok"] === true,
      judgedAt: at(jr["judged_at"]),
      sender: await this.senderOf(q.senderId),
      drafts: await this.draftsOf(q.draftIds),
      resourcesNotCurrent: int(rr?.["not_current"] ?? 0),
      capabilitiesRestricted: int(rr?.["restricted"] ?? 0),
    };
  }

  /** The grant and its sealed hashes (one per draft). U1 (review_id UNIQUE) turns the second grant of a review into OUTREACH_REVIEW_INVALID. */
  async insertGrant(g: {
    readonly authorizationId: string;
    readonly reviewId: string;
    readonly grantingUserId: string;
    readonly senderId: string;
    readonly proofId: string;
    readonly validFrom: string;
    readonly expiresAt: string;
    readonly maximumSends: number;
    readonly permissionEvidenceHash: string;
    readonly policyVersion: string;
    readonly seals: ReadonlyArray<{ readonly draftId: string; readonly contentHash: string }>;
  }): Promise<AuthorizationFact> {
    for (const s of g.seals) this.#held("grant", "L10", s.draftId, "S");
    let row;
    try {
      const r = await execute(
        this.db,
        `INSERT INTO kauro.outreach_authorizations (authorization_id, review_id, granting_user_id, sender_id, proof_id, valid_from, expires_at, maximum_sends, permission_evidence_hash, policy_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${ts("valid_from")} AS valid_from, ${ts("expires_at")} AS expires_at, revoked`,
        [g.authorizationId, g.reviewId, g.grantingUserId, g.senderId, g.proofId, g.validFrom, g.expiresAt, g.maximumSends, g.permissionEvidenceHash, g.policyVersion],
      );
      row = r.rows[0];
    } catch (e) {
      if (e instanceof ConstraintViolation && e.constraint === "outreach_authorizations_one_per_review") {
        throw new DomainFailure("PRECONDITION_FAILED", "the review was already consumed by a grant", { reason: "OUTREACH_REVIEW_INVALID" });
      }
      throw e;
    }
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the grant insert answered no row");
    for (const s of [...g.seals].sort((a, b) => (a.draftId < b.draftId ? -1 : 1))) {
      await execute(this.db, "INSERT INTO kauro.outreach_authorization_hashes (authorization_id, draft_id, content_hash) VALUES ($1, $2, $3)", [g.authorizationId, s.draftId, s.contentHash]);
    }
    return {
      authorizationId: g.authorizationId,
      reviewId: g.reviewId,
      grantingUserId: g.grantingUserId,
      senderId: g.senderId,
      validFrom: at(row["valid_from"]),
      expiresAt: at(row["expires_at"]),
      maximumSends: g.maximumSends,
      permissionEvidenceHash: g.permissionEvidenceHash,
      policyVersion: g.policyVersion,
      revoked: row["revoked"] === true,
      allowedContentHashes: [...new Set(g.seals.map((s) => s.contentHash))].sort(),
    };
  }

  // --- RevokeOutreachAuthorization (L1 -> L2 -> L4g X -> UPDATE) --------------------------------------------------------------------------

  async lockGrant(authorizationId: string): Promise<void> {
    await this.locks.take("L4g", authorizationId, "X");
  }

  async authorizationById(authorizationId: string): Promise<AuthorizationFact | null> {
    const r = await execute(
      this.db,
      `SELECT authorization_id, review_id, granting_user_id, sender_id, ${ts("valid_from")} AS valid_from, ${ts("expires_at")} AS expires_at, maximum_sends, permission_evidence_hash, policy_version, revoked
         FROM kauro.outreach_authorizations WHERE authorization_id = $1`,
      [authorizationId],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const h = await execute(this.db, "SELECT DISTINCT content_hash FROM kauro.outreach_authorization_hashes WHERE authorization_id = $1 ORDER BY content_hash", [authorizationId]);
    return {
      authorizationId: text(row["authorization_id"]),
      reviewId: text(row["review_id"]),
      grantingUserId: text(row["granting_user_id"]),
      senderId: text(row["sender_id"]),
      validFrom: at(row["valid_from"]),
      expiresAt: at(row["expires_at"]),
      maximumSends: int(row["maximum_sends"]),
      permissionEvidenceHash: text(row["permission_evidence_hash"]),
      policyVersion: text(row["policy_version"]),
      revoked: row["revoked"] === true,
      allowedContentHashes: h.rows.map((x) => text(x["content_hash"])),
    };
  }

  /** revoked false -> true (T2: L4g X). Returns false when it was already revoked (a replay of the fact). */
  async revokeGrant(authorizationId: string, byUserId: string): Promise<boolean> {
    this.#held("revocation", "L4g", authorizationId, "X");
    const r = await execute(this.db, "UPDATE kauro.outreach_authorizations SET revoked = true, revoked_by_user_id = $2 WHERE authorization_id = $1 AND NOT revoked", [authorizationId, byUserId]);
    return r.rowCount === 1;
  }

  // --- WithdrawOutreachChannelPolicy (L1 -> L2 -> L6p X -> UPDATE) -----------------------------------------------------------------------

  async lockPolicy(jurisdiction: string, purpose: string): Promise<void> {
    await this.locks.take("L6p", `${jurisdiction}:${purpose}`, "X");
  }

  /** The newest version of the policy (a withdrawn policy stays; a re-review is a new seeded version). */
  async latestPolicy(jurisdiction: string, purpose: string): Promise<PolicyFact | null> {
    const r = await execute(this.db, "SELECT jurisdiction, purpose, version, state FROM kauro.outreach_channel_policies WHERE jurisdiction = $1 AND purpose = $2 ORDER BY version DESC LIMIT 1", [jurisdiction, purpose]);
    const row = r.rows[0];
    return row === undefined ? null : { jurisdiction: text(row["jurisdiction"]), purpose: row["purpose"] as OutreachPurpose, version: int(row["version"]), state: row["state"] as "IN_FORCE" | "WITHDRAWN" };
  }

  async withdrawPolicy(p: { readonly jurisdiction: string; readonly purpose: string; readonly version: number; readonly byUserId: string }): Promise<boolean> {
    this.#held("policy withdrawal", "L6p", `${p.jurisdiction}:${p.purpose}`, "X");
    const r = await execute(
      this.db,
      "UPDATE kauro.outreach_channel_policies SET state = 'WITHDRAWN', withdrawn_by_user_id = $4 WHERE jurisdiction = $1 AND purpose = $2 AND version = $3 AND state = 'IN_FORCE'",
      [p.jurisdiction, p.purpose, p.version, p.byUserId],
    );
    return r.rowCount === 1;
  }
}
