/**
 * CMD038 AuthorizeDownload — POST /api/v1/packages/{packageId}/download-authorizations — AGENCY_READER with a fresh step-up (package B16
 * lane L5; 13 "Delivery"; R2-048, S048; registry: "Issue scoped short-lived capabilities and an audit event without exposing unrelated
 * objects"; "a shared cache must not reuse another user's signed URL").
 *
 * Phase 1, one COMMIT (B06's pipeline in an execution unit of work): authorize (the membership's shared transition lock) -> journal
 * reserve or replay -> step-up -> the package, read without a lock (another agency's, or none, is NOT_FOUND) -> the project's shared
 * transition lock, then OPEN (PROJECT_NOT_OPEN) -> the package's shared transition lock, then AVAILABLE (PACKAGE_NOT_AVAILABLE) -> the
 * requested delivery copies (ARTIFACT_NOT_FOUND; any object not PRESENT/VERIFIED refuses the whole request, ARTIFACT_UNAVAILABLE) -> the
 * governing PAID record FOR SHARE -> kauro.effect_now() read after that lock: the deadline reached is RETENTION_EXPIRED -> the grant,
 * its artifact rows (expires_at = least(issue + 900 s, deadline), computed in SQL), download_authorization.issued.v1 -> journal 201 with
 * the grant WITHOUT its URLs.
 *
 * Phase 2, after COMMIT, for the first answer and every replay alike: a fresh unit of work re-runs the access decision and re-reads,
 * without waiting on any writer, the grant, the membership (its id and version must be the grant's: MEMBERSHIP_CHANGED, R2-048), the
 * package, the project, the objects and the record; then the signer signs each artifact OUTSIDE any transaction with the stored expiry
 * (a retry re-signs exactly the same scope, never a broader one) and a last unit of work records SIGNED. A signer that does not answer
 * within its bound leaves the grant ISSUE_UNCERTAIN and answers 503 SIGNING_UNCERTAIN; the same key re-signs.
 */
import type { CommandId, Id } from "@kauro/contracts";
import { DomainFailure, type AssuranceProofId, type DownloadArtifactRow, type DownloadAuthorizationRow, type ExecutionUnitOfWork, type MembershipId, type PackageVersionId, type ProjectId } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { requireMembership } from "../../commands/handlers/shared.js";
import { AuthorizationDenied, contextOf, resultOf, settleCommandFailure, type CommandContext, type CommandOutcome } from "../../commands/runtime.js";
import { READ_SIGNING_TIMEOUT_MS, ReadSigningTimeout, type ObjectReadSigningPort } from "../../ports/object-read-signing.js";
import type { AuthorizationRequest } from "../../ports/authorizer.js";
import { AUTHORIZE_DOWNLOAD, type AuthorizeDownloadBody, type AuthorizeDownloadHandler } from "../contracts.js";
import type { DownloadGrantView, DownloadView } from "../views.js";
import { reachedOnServer, runExecutionCommand, utc, versionAt, type ExecutionRuntime } from "./shared.js";

const LIVE_OBJECT_STATES: ReadonlySet<string> = new Set(["PRESENT", "VERIFIED"]);

/** The journaled grant (no URL: the journal never holds a bearer secret). */
function grantView(row: DownloadAuthorizationRow): DownloadGrantView {
  return {
    authorizationId: row.authorizationId,
    packageId: row.packageVersionId,
    projectId: row.projectId,
    version: row.version,
    issuedAt: utc(row.issuedAt),
    expiresAt: utc(row.expiresAt),
    lifetimeSeconds: row.lifetimeSeconds,
    providerRevocation: "UNAVAILABLE",
    artifacts: row.artifacts.map((a) => ({ artifactId: a.artifactId, role: a.role, byteLength: a.byteLength, sha256: a.sha256 })),
  };
}

/** The answer: the journaled grant with each artifact's URL, built member by member so a replay is byte-identical to the first answer. */
function answeredView(grant: DownloadGrantView, urls: ReadonlyArray<string>): DownloadView {
  return {
    authorizationId: grant.authorizationId,
    packageId: grant.packageId,
    projectId: grant.projectId,
    version: grant.version,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    lifetimeSeconds: grant.lifetimeSeconds,
    providerRevocation: "UNAVAILABLE",
    artifacts: grant.artifacts.map((a, i) => ({ artifactId: a.artifactId, role: a.role, byteLength: a.byteLength, sha256: a.sha256, url: urls[i] as string })),
  };
}

/** Phase 1: the grant, its rows and its event in the command's one unit of work. */
async function issue(uow: ExecutionUnitOfWork, ctx: CommandContext, envelope: CommandEnvelope<AuthorizeDownloadBody>): Promise<CommandOutcome<DownloadGrantView>> {
  const membership = requireMembership(ctx);
  const store = uow.downloads;
  const packageId = envelope.path["packageId"] as PackageVersionId;
  const found = await store.findPackage(packageId);
  if (found === null || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "package not visible");

  if ((await store.awaitProject(found.projectId)) !== "OPEN") throw new DomainFailure("PRECONDITION_FAILED", "the package's project is not OPEN", { reason: "PROJECT_NOT_OPEN" });
  if ((await store.awaitPackage(packageId)) !== "AVAILABLE") throw new DomainFailure("PRECONDITION_FAILED", "the package is not AVAILABLE", { reason: "PACKAGE_NOT_AVAILABLE" });

  const requested = envelope.body.artifactIds;
  const rows = await store.artifactsOf(packageId, requested);
  const byId = new Map(rows.map((r) => [r.artifactId, r] as const));
  const artifacts: DownloadArtifactRow[] = [];
  for (const id of requested) {
    const row = byId.get(id);
    if (row === undefined) throw new DomainFailure("NOT_FOUND", "an artifact is not a delivery copy of this package", { reason: "ARTIFACT_NOT_FOUND" });
    artifacts.push(row);
  }
  if (artifacts.some((a) => !LIVE_OBJECT_STATES.has(a.objectState))) throw new DomainFailure("PRECONDITION_FAILED", "a requested artifact is deleted, being deleted or quarantined", { reason: "ARTIFACT_UNAVAILABLE" });

  const record = await store.lockGoverningRetention(packageId);
  const now = await store.effectInstant();
  if (record === null || record.state !== "ACTIVE" || reachedOnServer(record.effectiveDeadline, now)) {
    throw new DomainFailure("PRECONDITION_FAILED", "the governing retention deadline is reached", { reason: "RETENTION_EXPIRED" });
  }

  const row = await store.issue({
    authorizationId: uow.ids.next(),
    packageVersionId: packageId,
    projectId: found.projectId,
    membershipId: membership.membershipId as MembershipId,
    membershipVersion: membership.version,
    issuedAt: now,
    deadline: record.effectiveDeadline,
    artifacts,
  });
  await uow.events.publish({
    aggregateKind: "download_authorization",
    aggregateId: row.authorizationId,
    aggregateVersion: row.version,
    agencyId: row.agencyId,
    eventType: "download_authorization.issued.v1",
    actor: { kind: "USER", userId: envelope.userId },
    causationId: ctx.causationId,
    correlationId: envelope.correlationId,
    payload: {
      authorizationId: row.authorizationId,
      agencyId: row.agencyId,
      projectId: row.projectId as ProjectId,
      packageVersionId: row.packageVersionId,
      membershipId: row.membershipId,
      artifactIds: row.artifacts.map((a) => a.artifactId),
      lifetimeSeconds: row.lifetimeSeconds,
    },
  });
  return { status: 201, view: grantView(row), version: row.version, resourceKind: "download_authorization", resourceId: row.authorizationId as Id };
}

/** Options of the execution handlers: the read signer CMD038 signs with (absent: CMD038 refuses before writing anything). */
export interface AuthorizeDownloadOptions {
  readonly signer?: ObjectReadSigningPort;
}

export function authorizeDownloadHandler(runtime: ExecutionRuntime, options: AuthorizeDownloadOptions = {}): AuthorizeDownloadHandler {
  const spec = AUTHORIZE_DOWNLOAD;
  return {
    spec,
    execute: async (envelope): Promise<CommandResult<DownloadView>> => {
      const correlationId = envelope.correlationId;
      const signer = options.signer;
      if (signer === undefined) {
        return resultOf(new DomainFailure("CAPACITY_UNAVAILABLE", "no read signer is bound", { reason: "DOWNLOAD_SIGNER_UNAVAILABLE" }), correlationId);
      }
      if (new Set(envelope.body.artifactIds).size !== envelope.body.artifactIds.length) {
        return resultOf(new DomainFailure("INVALID_REQUEST", "artifactIds names an artifact more than once", { reason: "SCHEMA_VIOLATION", fields: [{ field: "artifactIds", code: "FORMAT" }] }), correlationId);
      }
      const committed = await runExecutionCommand<AuthorizeDownloadBody, DownloadGrantView>(spec, runtime, envelope, (uow, ctx) => issue(uow, ctx, envelope), versionAt());
      if (committed.kind !== "COMPLETED") return committed as CommandResult<DownloadView>;
      const grant = committed.view;

      // phase 2: the access decision again and the grant's facts as they stand now, then the signatures outside any transaction
      const context = contextOf(spec, envelope);
      const request: AuthorizationRequest = {
        command: spec.id as CommandId,
        identity: envelope.subject.identity,
        agencyId: envelope.agencyId,
        assuranceProofRef: envelope.body.assuranceProofRef as AssuranceProofId,
      };
      let stored: DownloadAuthorizationRow;
      try {
        stored = await runtime.unitOfWork.run(context, async (uow) => {
          const access = await runtime.authorizer.authorize(uow, request);
          if (access.kind === "DENY") throw new AuthorizationDenied(spec.id as CommandId, access);
          const now = await uow.downloads.recheck(grant.authorizationId);
          if (now === null) throw new DomainFailure("INTEGRITY_FAILURE", "the committed download authorization is not visible to its requester");
          const a = now.authorization;
          if (access.membership === null || access.membership.membershipId !== a.membershipId || access.membership.version !== a.membershipVersion) {
            throw new DomainFailure("NOT_AUTHORIZED", "the requester's membership changed after the grant", { reason: "MEMBERSHIP_CHANGED" });
          }
          if (now.projectState !== "OPEN") throw new DomainFailure("PRECONDITION_FAILED", "the package's project is not OPEN", { reason: "PROJECT_NOT_OPEN" });
          if (now.packageState !== "AVAILABLE") throw new DomainFailure("PRECONDITION_FAILED", "the package is not AVAILABLE", { reason: "PACKAGE_NOT_AVAILABLE" });
          if (a.artifacts.length !== grant.artifacts.length || a.artifacts.some((x) => !LIVE_OBJECT_STATES.has(x.objectState))) {
            throw new DomainFailure("PRECONDITION_FAILED", "a granted artifact is deleted, being deleted or quarantined", { reason: "ARTIFACT_UNAVAILABLE" });
          }
          if (now.retention === null || now.retention.state !== "ACTIVE" || reachedOnServer(now.retention.effectiveDeadline, now.now)) {
            throw new DomainFailure("PRECONDITION_FAILED", "the governing retention deadline is reached", { reason: "RETENTION_EXPIRED" });
          }
          if (reachedOnServer(a.expiresAt, now.now)) throw new DomainFailure("PRECONDITION_FAILED", "the grant has expired; request a new one", { reason: "DOWNLOAD_AUTHORIZATION_EXPIRED" });
          return a;
        });
      } catch (e) {
        return settleCommandFailure<DownloadView>(runtime, context, spec.id, correlationId, e);
      }

      const urls: string[] = [];
      try {
        for (const a of stored.artifacts) {
          const signed = await signer.signRead(
            { objectName: a.objectName, generation: a.generation, expiresAt: grant.expiresAt, requester: { userId: stored.userId, authorizationId: stored.authorizationId } },
            READ_SIGNING_TIMEOUT_MS,
          );
          urls.push(signed.url);
        }
      } catch (e) {
        if (!(e instanceof ReadSigningTimeout)) throw e;
        await runtime.unitOfWork.run(context, (uow) => uow.downloads.recordSigning(stored.authorizationId, "ISSUE_UNCERTAIN"));
        return resultOf(new DomainFailure("CAPACITY_UNAVAILABLE", "the read signer did not answer within its bound; retry with the same key", { reason: "SIGNING_UNCERTAIN" }), correlationId);
      }
      if (stored.signState !== "SIGNED") await runtime.unitOfWork.run(context, (uow) => uow.downloads.recordSigning(stored.authorizationId, "SIGNED"));
      return { ...committed, view: answeredView(grant, urls) };
    },
  };
}
