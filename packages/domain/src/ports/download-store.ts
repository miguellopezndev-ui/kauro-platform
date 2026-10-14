/**
 * The download authorization store (package B16 lane L5, CMD038 AuthorizeDownload; migration 0075, provisional): the request session's
 * reads and writes of one grant of short-lived read URLs over the delivery copies of an AVAILABLE package.
 *
 * The lock trace of an issuance (the handler calls these in this order, in the one unit of work of the command): the membership's shared
 * transition lock (the authorizer) -> `awaitProject` (the project's shared transition lock, then its state) -> `awaitPackage` (the
 * package's shared transition lock, then its state) -> `lockGoverningRetention` (the governing PAID record FOR SHARE) -> `effectInstant`
 * (kauro.effect_now(), read in a statement after the last lock) -> `issue`. A writer that moves the project's or the package's state
 * takes the exclusive transition lock (the triggers of migrations 0021 and 0075), so a deletion request (CMD042) or a revocation is
 * ordered wholly before or wholly after the issuance.
 *
 * The URLs themselves are never stored: the grant fixes the scope (the exact object generations) and the absolute expiry; signing is a
 * provider call after COMMIT, and `recheck` / `recordSigning` are the reads and the one write of that phase.
 */
import type { AgencyId, MembershipId, ProjectId, UserId } from "../model/ids.js";
import type { PackageVersionId } from "../model/execution/ids.js";

/** Where the provider signing of a committed grant stands (the URLs are re-signed from the grant; they are never stored). */
export type DownloadSignState = "PENDING" | "SIGNED" | "ISSUE_UNCERTAIN";

/** A package as the request session reads it (another agency's package is not visible). */
export interface DownloadPackageRow {
  readonly packageVersionId: PackageVersionId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly state: string;
}

/** One delivery copy of a package and the state of its stored object. */
export interface DownloadArtifactRow {
  /** The stored object's id: the artifact id the request names. */
  readonly artifactId: string;
  readonly objectName: string;
  readonly generation: string;
  readonly role: string;
  readonly sha256: string;
  readonly byteLength: number;
  /** stored_objects.state: only PRESENT and VERIFIED objects are downloadable. */
  readonly objectState: string;
}

/** The PAID record that governs the package's source revision (its effective deadline bounds every URL). */
export interface GoverningRetentionRow {
  readonly retentionId: string;
  readonly state: string;
  /** Exact ISO-8601 UTC instant (microseconds). */
  readonly effectiveDeadline: string;
}

export interface IssueDownloadInput {
  readonly authorizationId: string;
  readonly packageVersionId: PackageVersionId;
  readonly projectId: ProjectId;
  readonly membershipId: MembershipId;
  readonly membershipVersion: number;
  /** The effect instant read after the last lock (exact): the grant's issued_at. */
  readonly issuedAt: string;
  /** The governing record's effective deadline (exact): expires_at = least(issuedAt + 900 s, deadline). */
  readonly deadline: string;
  /** The requested artifacts, in the request's order. */
  readonly artifacts: ReadonlyArray<DownloadArtifactRow>;
}

/** A committed grant, as stored; `artifacts` in the request's order. */
export interface DownloadAuthorizationRow {
  readonly authorizationId: string;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly packageVersionId: PackageVersionId;
  readonly membershipId: MembershipId;
  readonly membershipVersion: number;
  readonly userId: UserId;
  readonly version: number;
  /** Exact instants (microseconds). */
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Whole seconds between issuedAt and expiresAt (the lifetime disclosed at issue). */
  readonly lifetimeSeconds: number;
  readonly signState: DownloadSignState;
  readonly artifacts: ReadonlyArray<DownloadArtifactRow>;
}

/** What the signing phase re-reads after COMMIT, without a lock (it never waits on a writer that has not committed). */
export interface DownloadRecheck {
  readonly authorization: DownloadAuthorizationRow;
  readonly packageState: string;
  readonly projectState: string;
  readonly retention: GoverningRetentionRow | null;
  /** kauro.effect_now() of this read (exact). */
  readonly now: string;
}

export interface DownloadAuthorizationStore {
  /** The package of the session's agency, or null (another agency's and a nonexistent one look alike). */
  findPackage(packageVersionId: PackageVersionId): Promise<DownloadPackageRow | null>;
  /** The project's shared transition lock (held to the end of the unit of work), then its state read after it; null if not visible. */
  awaitProject(projectId: ProjectId): Promise<string | null>;
  /** The package's shared transition lock, then its state read after it; null if not visible. */
  awaitPackage(packageVersionId: PackageVersionId): Promise<string | null>;
  /** The governing PAID_ORDINARY / PAID_STAGED record of the package's source revision, FOR SHARE; null if none. */
  lockGoverningRetention(packageVersionId: PackageVersionId): Promise<GoverningRetentionRow | null>;
  /** The package's delivery copies among `artifactIds` (any order; an id the package does not have is absent). */
  artifactsOf(packageVersionId: PackageVersionId, artifactIds: ReadonlyArray<string>): Promise<ReadonlyArray<DownloadArtifactRow>>;
  /** kauro.effect_now(), exact (read in a statement after the last lock). */
  effectInstant(): Promise<string>;
  /** Writes the grant (sign_state PENDING) and its artifact rows; the event is the caller's. */
  issue(input: IssueDownloadInput): Promise<DownloadAuthorizationRow>;
  /** The committed grant of the session's user with the package, project and record as they stand now; null if not visible. */
  recheck(authorizationId: string): Promise<DownloadRecheck | null>;
  /** Records the signing outcome (PENDING | ISSUE_UNCERTAIN -> SIGNED | ISSUE_UNCERTAIN); SIGNED stays SIGNED. */
  recordSigning(authorizationId: string, state: "SIGNED" | "ISSUE_UNCERTAIN"): Promise<void>;
}
