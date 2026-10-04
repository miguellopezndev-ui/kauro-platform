/**
 * Identities of audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §9; 07
 * "Database representation": server-generated UUIDv7, scoped even when globally unique). Branded so a step id is unusable where an
 * audit id is required; every one is minted through IdGenerator and checked as UUIDv7 by the database (migration 0023). A decision
 * artifact is named by B06's ArtifactRef (the reference CMD022 and CMD023 resolve), so it has no brand of its own.
 */
import type { Id } from "@kauro/contracts";
import type { Branded } from "../ids.js";

/** Audit.auditId: one logical audit of one (revision, target contract), for good (D8-AUD-1). */
export type AuditId = Branded<Id, "AuditId">;
/** CostGrant.grantId: the platform's monthly pool or an AUDIT grant carved from it (D8-GRANT-1). */
export type CostGrantId = Branded<Id, "CostGrantId">;
/** One claim of an audit step (PROFILE, INTERPRET, VALIDATE) at the audit's next fence (D8-AUD-2); an evidence row. */
export type AuditStepId = Branded<Id, "AuditStepId">;
/** ModelTask.taskId: a logical model task of an audit; its dispatch attempts are request journal rows of this task id (D8-AUD-3). */
export type ModelTaskId = Branded<Id, "ModelTaskId">;
/** One validation intent of a plan (CMD024, or an audit's system draft), with its own fence (D8-PLAN-2). */
export type PlanValidationId = Branded<Id, "PlanValidationId">;
