/**
 * Identities of processing authority (package B08; docs/design/B08-audit-approval-jobs.md §4, §5; 07 "Database representation":
 * server-generated UUIDv7, scoped even when globally unique). Branded so an attempt id is unusable where a job id is required;
 * every one is minted through IdGenerator and checked as UUIDv7 by the database (migrations 0021, 0022).
 */
import type { Id } from "@kauro/contracts";
import type { Branded } from "../ids.js";

/** Job.jobId: one logical processing job, bound for good to one CommercialAuthorization (D8-JOB-1). */
export type ProcessingJobId = Branded<Id, "ProcessingJobId">;
/** One physical attempt of a job: the JOB_ATTEMPT lease owner at one fence (D8-ATT-1); an evidence row, not an aggregate. */
export type ProcessingAttemptId = Branded<Id, "ProcessingAttemptId">;
/** PackageManifest.packageId: one package version of a job's attempt (an aggregate, kind package_version). */
export type PackageVersionId = Branded<Id, "PackageVersionId">;
/** One verification of a package candidate against the authority the platform supplies (D8-VER-1). */
export type PackageVerificationId = Branded<Id, "PackageVerificationId">;
/** One read-back of a staged or delivered artifact at its exact generation (D8-VER-1, D8-PUB-1). */
export type ArtifactReadbackId = Branded<Id, "ArtifactReadbackId">;
/** The one cleanup record of an attempt (D8-JAN-1). */
export type AttemptCleanupId = Branded<Id, "AttemptCleanupId">;
