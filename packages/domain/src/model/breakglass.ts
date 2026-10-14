/**
 * Breakglass (package B16 lane L4; registry CMD054 OpenBreakglass, CMD055 RevokeBreakglass; 08 "Breakglass"; cases R2-050, S071): a
 * short-lived audited least-privilege grant of the corporate owner over ONE project, justified by a live support case of that project or
 * an actual incident naming it, that lets its holder read the bounded preview of the project's admitted tables and nothing else.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, AssuranceProofId, BreakglassGrantId, ProjectId, UserId } from "./ids.js";
import type { SourceFileId, SourceTableId } from "./source/ids.js";
import type { DeclaredFormat } from "./source/records.js";

/** policy.json retention.breakglassSeconds: a grant expires this long after the database's instant of its opening (migration 0071 CHECK). */
export const BREAKGLASS_GRANT_SECONDS = 1800;
/**
 * policy.json retention.signedDownloadSeconds: the longest a bearer capability already issued under the platform's providers lives. A
 * revocation stops every new read at once; it never claims a zero residual lifetime for what was issued (CMD055 failure clause).
 */
export const BREAKGLASS_RESIDUAL_BEARER_SECONDS = 900;

export const BREAKGLASS_FAILURE_REASONS = [
  // the authorization (support case or incident) does not justify the scope now: another project or agency, closed, resolved, a false
  // positive, an incident not naming the project, a project on its way to deletion, a closed agency (KA089)
  "BREAKGLASS_SCOPE_UNAUTHORIZED",
  // the project already holds a live grant: one at a time
  "BREAKGLASS_GRANT_LIVE",
  // the same authorization already opened a grant of the project: after its expiry a new justified grant is required (R2-050)
  "BREAKGLASS_RENEWAL_REFUSED",
  // the step-up proof already opened a grant: no silent reuse
  "BREAKGLASS_PROOF_REUSED",
  // the grant's 1800 seconds have passed
  "BREAKGLASS_GRANT_EXPIRED",
  // the grant was revoked (or lapsed): it reads nothing more and is not revoked again
  "BREAKGLASS_GRANT_NOT_ACTIVE",
  // the grant's authorization, project or agency is no longer live (GAP-BG-7): the record is kept, its use ends
  "BREAKGLASS_GRANT_UNUSABLE",
] as const;
export type BreakglassFailureReason = (typeof BREAKGLASS_FAILURE_REASONS)[number];

export type BreakglassAuthorizationKind = "SUPPORT_CASE" | "INCIDENT";
export type BreakglassGrantState = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface BreakglassGrantRecord {
  readonly grantId: BreakglassGrantId;
  readonly holderUserId: UserId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly purpose: string;
  readonly authorizationKind: BreakglassAuthorizationKind;
  readonly authorizationRef: string;
  readonly state: BreakglassGrantState;
  readonly revision: number;
  readonly openedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly revokedAt: UtcInstant | null;
}

/** A grant read after its lock, judged at the database's instant of the judgment (effect_now()). */
export interface JudgedBreakglassGrant {
  readonly grant: BreakglassGrantRecord;
  /** expires_at has passed at the instant of the judgment. */
  readonly expired: boolean;
  /** The authorization, project and agency still justify the scope. */
  readonly live: boolean;
}

/** The admitted table a grant may preview, as the grant's own policies let the session read it. */
export interface BreakglassPreviewSubject {
  readonly tableId: SourceTableId;
  readonly fileId: SourceFileId;
  /** The table's place in its file and its column count. */
  readonly ordinal: number;
  readonly columnCount: number;
  /** The admitted generation, as its file records it (the reader re-verifies the digest and length). */
  readonly sha256: Sha256Hex;
  readonly bytes: number;
  readonly format: DeclaredFormat;
  readonly providerGeneration: string;
  /** The registry object of the accepted generation (never a bucket URI). */
  readonly provider: string;
  readonly locationRef: string;
  readonly objectName: string;
}

export interface BreakglassRepository {
  /** The project's facts under the scope it names (null when the scope is no project the session may name). */
  scopeOf(projectId: ProjectId): Promise<{ readonly agencyId: AgencyId; readonly projectId: ProjectId } | null>;
  /** Which kind of authorization `ref` is under the named scope (null when neither a support case of the project nor an incident). */
  authorizationKindOf(ref: string): Promise<BreakglassAuthorizationKind | null>;
  /** ACTIVE grants of the project whose expiry has passed become EXPIRED (their record kept); the count lapsed. */
  lapseExpired(projectId: ProjectId): Promise<number>;
  /** The project's live grant, if any. */
  liveGrantOf(projectId: ProjectId): Promise<BreakglassGrantRecord | null>;
  open(input: {
    readonly grantId: BreakglassGrantId;
    readonly holderUserId: UserId;
    readonly agencyId: AgencyId;
    readonly projectId: ProjectId;
    readonly purpose: string;
    readonly authorizationKind: BreakglassAuthorizationKind;
    readonly authorizationRef: string;
    readonly assuranceProofRef: AssuranceProofId;
  }): Promise<BreakglassGrantRecord>;
  /** The grant FOR NO KEY UPDATE (a revocation; held to COMMIT), judged after the lock; null when it does not exist. */
  lockForRevocation(grantId: BreakglassGrantId): Promise<JudgedBreakglassGrant | null>;
  /** The holder's own grant FOR SHARE (a read under it; held to COMMIT), judged after the lock and named as the session's scope. */
  lockForRead(grantId: BreakglassGrantId, holderUserId: UserId): Promise<JudgedBreakglassGrant | null>;
  revoke(grant: BreakglassGrantRecord, by: UserId, reasonCode: string): Promise<BreakglassGrantRecord>;
  /** The admitted table under the session's named grant (null when the grant covers no such table). */
  previewSubject(tableId: SourceTableId): Promise<BreakglassPreviewSubject | null>;
  /** Records one preview read under the named grant (refused by the database unless the grant still covers it). */
  recordAccess(input: { readonly accessId: string; readonly grant: BreakglassGrantRecord; readonly subject: BreakglassPreviewSubject; readonly by: UserId }): Promise<void>;
}
