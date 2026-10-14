/**
 * Domain events and the outbox vocabulary (07 "Outbox, inbox and event ordering"; contract DomainEvent, OutboxRecord).
 *
 * A DomainEvent is written in the same transaction as the aggregate change it records (07 "Transaction discipline"); the
 * database refuses to commit an aggregate version without its event (constraint trigger kauro.require_event_for_version).
 * Payloads are allowlisted references and safe counts, never CRM rows, labels or secrets: every event type declares the keys
 * it may carry and every value must be an id, a hash, an uppercase token, a non-negative integer, a boolean or a list of
 * ids/hashes. Consumers are registered destinations; the code-owned subscription table below is the fan-out authority the
 * EventPublisher uses to create outbox records.
 */
import type { DomainEvent, Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, isSha256Hex, rawDigest } from "@kauro/contracts";
import { COMMERCE_AGGREGATE_KINDS, COMMERCE_CONSUMERS, COMMERCE_EVENT_PAYLOAD_ALLOWLIST, COMMERCE_EVENT_SUBSCRIPTIONS, COMMERCE_EVENT_TYPES } from "../commerce/events.js";
import { BANK_CREDIT_AGGREGATE_KINDS, BANK_CREDIT_EVENT_PAYLOAD_ALLOWLIST, BANK_CREDIT_EVENT_SUBSCRIPTIONS, BANK_CREDIT_EVENT_TYPES } from "../commerce/bank-credit.js";
import { BANK_ROUTE_AGGREGATE_KINDS, BANK_ROUTE_EVENT_PAYLOAD_ALLOWLIST, BANK_ROUTE_EVENT_SUBSCRIPTIONS, BANK_ROUTE_EVENT_TYPES } from "../commerce/bank-route.js";
import { TREASURY_REFUND_AGGREGATE_KINDS, TREASURY_REFUND_EVENT_PAYLOAD_ALLOWLIST, TREASURY_REFUND_EVENT_SUBSCRIPTIONS, TREASURY_REFUND_EVENT_TYPES } from "../commerce/treasury-refund.js";
import { OUTBOUND_ATTEMPT_AGGREGATE_KINDS, OUTBOUND_ATTEMPT_EVENT_PAYLOAD_ALLOWLIST, OUTBOUND_ATTEMPT_EVENT_SUBSCRIPTIONS, OUTBOUND_ATTEMPT_EVENT_TYPES } from "../commerce/execution-attempt.js";
import { COMMERCIAL_EVENT_PAYLOAD_ALLOWLIST, COMMERCIAL_EVENT_SUBSCRIPTIONS, COMMERCIAL_EVENT_TYPES } from "../commercial/events.js";
import { OUTREACH_AGGREGATE_KINDS, OUTREACH_CONSUMERS, OUTREACH_EVENT_PAYLOAD_ALLOWLIST, OUTREACH_EVENT_SUBSCRIPTIONS, OUTREACH_EVENT_TYPES } from "../commercial/outreach-events.js";
import { EXECUTION_AGGREGATE_KINDS, EXECUTION_CONSUMERS, EXECUTION_EVENT_PAYLOAD_ALLOWLIST, EXECUTION_EVENT_SUBSCRIPTIONS, EXECUTION_EVENT_TYPES } from "./execution/events.js";
import { AUDIT_AGGREGATE_KINDS, AUDIT_AUTHORITY_EVENT_TYPES, AUDIT_CONSUMERS, AUDIT_EVENT_PAYLOAD_ALLOWLIST, AUDIT_EVENT_SUBSCRIPTIONS } from "./audit/events.js";
import type { AgencyId, CausationId, CorrelationId, EventId } from "./ids.js";
import { isUuid } from "./ids.js";
import { isUtcInstant } from "../ports/clock.js";
import type { ActorRef } from "./tenant.js";

export const EVENT_TYPES = [
  // Agency lifecycle (registry Agency machine: agreements_and_profile_accepted, material_risk_or_account_failure,
  // restriction_remedied, owner_requests_closure, owner_abandons_setup, closure_obligations_completed)
  "agency.created.v1",
  "agency.activated.v1",
  "agency.restricted.v1",
  "agency.restriction_remedied.v1",
  "agency.closing.v1",
  "agency.closed.v1",
  // Membership lifecycle (registry Membership machine)
  "membership.created.v1",
  "membership.invited.v1",
  "membership.accepted.v1",
  "membership.expired.v1",
  "membership.suspended.v1",
  "membership.reactivated.v1",
  "membership.revoked.v1",
  "membership.role_changed.v1",
  "agency.ownership_transferred.v1",
  // End clients
  "end_client.created.v1",
  "end_client.archived.v1",
  // Projects and revisions (registry DatasetRevision machine: one event per target state, registered with the machine the
  // schema seeds, as the Agency and Membership lifecycles are; their commands arrive with B07)
  "project.created.v1",
  "dataset_revision.created.v1",
  "dataset_revision.uploading.v1",
  "dataset_revision.inspecting.v1",
  "dataset_revision.ready_to_seal.v1",
  "dataset_revision.sealed.v1",
  "dataset_revision.rejected.v1",
  "dataset_revision.cancelled.v1",
  "dataset_revision.superseded.v1",
  "dataset_revision.expired.v1",
  "dataset_revision.deleted.v1",
  // Plans and approvals (registry Plan machine)
  "plan.created.v1",
  "plan.validation_required.v1",
  "plan.validating.v1",
  "plan.validated.v1",
  "plan.superseded.v1",
  "plan.approved.v1",
  "plan.withdrawn.v1",
  "approval.created.v1",
  "approval.withdrawn.v1",
  // Source lifecycle (B07, docs/design/B07-upload-source-lifecycle.md §9). The DatasetRevision lifecycle events above are
  // B06's registration of the registry machine; B07 adds the events of its own aggregates and of the version bumps that change
  // no revision state. Upload sessions (platform machine UploadSession, decision D-UP-1):
  "upload_session.reserved.v1",
  "upload_session.session_issued.v1",
  "upload_session.completion_reported.v1",
  "upload_session.completion_observed.v1",
  "upload_session.completion_not_observed.v1",
  "upload_session.admitted.v1",
  "upload_session.rejected.v1",
  "upload_session.cancelled.v1",
  "upload_session.expired.v1",
  "upload_session.provider_cancellation_recorded.v1",
  // a selection bound to a revision (CMD016): the in-place rebind, previously_admitted_inputs_selected and selection_changes
  "dataset_revision.selection_changed.v1",
  // CreateRevision moves the project's current revision (decision D-REV-1)
  "project.current_revision_changed.v1",
  // retention records (platform machine RetentionRecord, decision D-RET-2)
  "retention_record.created.v1",
  "retention_record.expired.v1",
  // the one explicit soft-deadline extension of a project (B16 CMD060; migration 0069, provisional)
  "retention_record.extended.v1",
  // the managed deletion of a project (B16 CMD042 and DELETION_EXECUTOR; migration 0071, provisional)
  "project.deletion_requested.v1",
  "project.deleted.v1",
  "retention_record.deleting.v1",
  "retention_record.deleted.v1",
  // admitted source files (platform machine SourceFile, decision D-FILE-1; an aggregate since B07-F9): the admission recorded by
  // UPLOAD_INSPECTION and its revocation, which the execution consumer and the agency must learn of
  "source_file.admitted.v1",
  "source_file.admission_revoked.v1",
  // Payments and fiscal workflow (package B09, commerce/events.ts; migration 0013)
  ...COMMERCE_EVENT_TYPES,
  // Support (B11 CMD044: a case is born OPEN; the summary never travels in an event, D-SUP-5)
  "support_case.opened.v1",
  // Agency buyer type (B11 CMD101 SetBuyerType, migration 0062: recorded once, before the first quote; R2 A3 3.7)
  "agency_buyer_type.recorded.v1",
  // Download authorizations (B16 lane L5 CMD038 AuthorizeDownload; migration 0075, provisional): the audit fact of one grant
  "download_authorization.issued.v1",
  // Processing authority (package B08, model/execution/events.ts; migrations 0021 and 0022)
  ...EXECUTION_EVENT_TYPES,
  // Audit authority (package B08, model/audit/events.ts; migration 0023)
  ...AUDIT_AUTHORITY_EVENT_TYPES,
  // Agency recurrence and commission domain (package B10, commercial/events.ts; migration 0028)
  ...COMMERCIAL_EVENT_TYPES,
  // Payments V1 bank-transfer route (commerce/bank-route.ts; migration 0046, lane L-ROUTE)
  ...BANK_ROUTE_EVENT_TYPES,
  // Payments V1 inbound credits (commerce/bank-credit.ts; migration 0063, lane PV1-INBOUND)
  ...BANK_CREDIT_EVENT_TYPES,
  // Payments V1 route-scope treasury refunds (commerce/treasury-refund.ts; migration 0080, lane L-REFUND)
  ...TREASURY_REFUND_EVENT_TYPES,
  // Payments V1 outbound execution attempts (commerce/execution-attempt.ts; migration 0080 slice 2, lane L-REFUND)
  ...OUTBOUND_ATTEMPT_EVENT_TYPES,
  // Outreach (commercial/outreach-events.ts; migration 0072, package B12)
  ...OUTREACH_EVENT_TYPES,
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * The aggregate kinds an event may name. The database registry `kauro.aggregate_kinds` (migration 0008, the foundation shared by
 * every package: docs/design/FOUNDATION-aggregate-kinds.md) holds the same kinds, each bound to its table and uuid primary-key
 * column; the persistence tests prove the two lists equal. A package that adds an aggregate registers its kind with one INSERT in
 * its own migration and adds it here (B07: upload_session, source_file, retention_record, registered by migrations 0009, 0010 and
 * 0012; B09: the commerce kinds, registered by migrations 0013..0017; B08: processing_job and package_version, registered by
 * migrations 0021 and 0022, and audit and cost_grant, registered by migration 0023; B11: support_case, registered by migration 0026, and agency_buyer_type, registered by migration 0062).
 */
export const AGGREGATE_KINDS = ["agency", "membership", "end_client", "project", "dataset_revision", "plan", "approval", "upload_session", "source_file", "retention_record", ...COMMERCE_AGGREGATE_KINDS, ...EXECUTION_AGGREGATE_KINDS, ...AUDIT_AGGREGATE_KINDS, "support_case", ...BANK_ROUTE_AGGREGATE_KINDS, "agency_buyer_type", ...BANK_CREDIT_AGGREGATE_KINDS, "download_authorization", ...TREASURY_REFUND_AGGREGATE_KINDS, ...OUTBOUND_ATTEMPT_AGGREGATE_KINDS, ...OUTREACH_AGGREGATE_KINDS] as const;
export type AggregateKind = (typeof AGGREGATE_KINDS)[number];

/**
 * The kinds whose registry row is agency_scoped = false (migration 0072): the aggregate's table has no agency_id, its events carry no
 * agency and the database refuses an event of the kind that names one. Every other kind is agency scoped (a bank route's NULL agency_id is a
 * value of an agency-scoped kind). The persistence tests prove the registry agrees with this list.
 */
export const UNSCOPED_AGGREGATE_KINDS = OUTREACH_AGGREGATE_KINDS;

/** Keys each event type may carry (07: references and safe counts only). */
export const EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<EventType, ReadonlyArray<string>>> = Object.freeze({
  "agency.created.v1": ["agencyId", "createdByUserId", "state"],
  "agency.activated.v1": ["agencyId"],
  "agency.restricted.v1": ["agencyId", "incidentId"],
  "agency.restriction_remedied.v1": ["agencyId", "incidentId"],
  "agency.closing.v1": ["agencyId"],
  "agency.closed.v1": ["agencyId"],
  "membership.created.v1": ["membershipId", "agencyId", "userId", "role", "state"],
  "membership.invited.v1": ["membershipId", "agencyId", "role", "invitedByMembershipId"],
  "membership.accepted.v1": ["membershipId", "agencyId", "userId", "role"],
  "membership.expired.v1": ["membershipId", "agencyId"],
  "membership.suspended.v1": ["membershipId", "agencyId", "byMembershipId"],
  "membership.reactivated.v1": ["membershipId", "agencyId", "byMembershipId"],
  "membership.revoked.v1": ["membershipId", "agencyId", "byMembershipId", "reasonCode"],
  "membership.role_changed.v1": ["membershipId", "agencyId", "role", "previousRole", "byMembershipId"],
  "agency.ownership_transferred.v1": ["agencyId", "fromMembershipId", "toMembershipId"],
  "end_client.created.v1": ["clientId", "agencyId", "processingAuthorityRef", "createdByMembershipId"],
  "end_client.archived.v1": ["clientId", "agencyId", "openProjects", "archivedByMembershipId"],
  "project.created.v1": ["projectId", "agencyId", "clientId", "mode", "capabilityId", "capabilityVersion", "initialRevisionId", "createdByMembershipId"],
  // B06 registered the DatasetRevision lifecycle with the machine; B07, which performs its edges, widens each allowlist with the
  // references and counts its edge records (ids, digests, tokens and counts only — never a display name, a worksheet name, a
  // header label, a provider session reference, an object name or a generation string; design B07 §9)
  "dataset_revision.created.v1": ["revisionId", "agencyId", "projectId", "state", "supersedesRevisionId", "createdByMembershipId"],
  "dataset_revision.uploading.v1": ["revisionId", "agencyId", "projectId", "firstUploadId", "state"],
  "dataset_revision.inspecting.v1": ["revisionId", "agencyId", "projectId", "previousState", "state"],
  "dataset_revision.ready_to_seal.v1": ["revisionId", "agencyId", "projectId", "selectionHash", "evaluationHash", "physicalSourceRows", "logicalSourceRecords", "billableSourceUnits", "associationEdges"],
  "dataset_revision.sealed.v1": ["revisionId", "agencyId", "projectId", "manifestHash", "projectionHash", "selectionHash", "evaluationHash", "physicalSourceRows", "logicalSourceRecords", "billableSourceUnits", "associationEdges", "fileCount", "sealedBytes", "retentionId"],
  "dataset_revision.rejected.v1": ["revisionId", "agencyId", "projectId", "selectionHash", "evaluationHash", "reasonCode"],
  "dataset_revision.cancelled.v1": ["revisionId", "agencyId", "projectId", "previousState", "reasonCode", "successorRevisionId", "cancelledUploadIds"],
  "dataset_revision.superseded.v1": ["revisionId", "agencyId", "projectId", "successorRevisionId", "manifestHash", "affectedPlanIds", "affectedApprovalIds", "affectedCommercialAuthorizationIds"],
  "dataset_revision.expired.v1": ["revisionId", "agencyId", "projectId", "previousState", "reasonCode", "retentionId"],
  "dataset_revision.deleted.v1": ["revisionId", "agencyId", "projectId", "deletedObjectCount", "residualObjectCount", "tombstoneHash"],
  "plan.created.v1": ["planId", "agencyId", "projectId", "bodyHash", "supersedesPlanId", "createdByMembershipId"],
  "plan.validation_required.v1": ["planId", "agencyId", "bodyHash"],
  "plan.validating.v1": ["planId", "agencyId", "bodyHash"],
  "plan.validated.v1": ["planId", "agencyId", "bodyHash", "validationReceiptHash"],
  "plan.superseded.v1": ["planId", "agencyId", "successorPlanId", "invalidatedApprovalId", "invalidatedReceiptHash"],
  "plan.approved.v1": ["planId", "agencyId", "approvalId", "approvalHash"],
  "plan.withdrawn.v1": ["planId", "agencyId", "approvalId"],
  "approval.created.v1": ["approvalId", "agencyId", "planId", "planHash", "revisionHash", "targetContractHash", "validationReceiptHash", "disclosuresHash", "actorMembershipId", "approvalHash"],
  // the withdrawal reason is a label (CMD026 reasonCode, decision D-API-1): it stays on the approval row, never in a payload
  "approval.withdrawn.v1": ["approvalId", "agencyId", "planId", "withdrawnByMembershipId", "completedExternalActions", "supersededByPlanId"],
  // B07 (docs/design/B07-upload-source-lifecycle.md §9): ids, digests, tokens and byte/row counts only — never a display name,
  // a worksheet name, a header label, a provider session reference, an object name or a generation string
  "upload_session.reserved.v1": ["uploadId", "agencyId", "projectId", "revisionId", "reservedBytes", "declaredFormat", "requestedByMembershipId", "state"],
  "upload_session.session_issued.v1": ["uploadId", "agencyId", "revisionId", "sessionAttempt", "providerSessionDigest"],
  "upload_session.completion_reported.v1": ["uploadId", "agencyId", "revisionId", "completionClaimDigest", "reportedByMembershipId"],
  "upload_session.completion_observed.v1": ["uploadId", "agencyId", "revisionId", "observedBytes", "claimConsistent"],
  "upload_session.completion_not_observed.v1": ["uploadId", "agencyId", "revisionId"],
  "upload_session.admitted.v1": ["uploadId", "agencyId", "revisionId", "fileId", "inspectionReceiptHash", "observedBytes", "scanState", "detectedFormat"],
  "upload_session.rejected.v1": ["uploadId", "agencyId", "revisionId", "inspectionReceiptHash", "rejectionClass", "scanState"],
  "upload_session.cancelled.v1": ["uploadId", "agencyId", "revisionId", "cancelledByMembershipId", "reasonCode", "providerCancellationState", "releasedBytes"],
  "upload_session.expired.v1": ["uploadId", "agencyId", "revisionId", "previousState", "reasonCode", "releasedBytes", "providerCancellationState", "fileId"],
  "upload_session.provider_cancellation_recorded.v1": ["uploadId", "agencyId", "revisionId", "providerCancellationState"],
  "dataset_revision.selection_changed.v1": ["revisionId", "agencyId", "projectId", "selectionManifestId", "selectionHash", "inventoryHash", "previousState", "state", "includedFileCount", "includedTableCount", "reusedFileIds"],
  "project.current_revision_changed.v1": ["projectId", "agencyId", "currentRevisionId", "previousRevisionId", "changedByMembershipId"],
  "retention_record.created.v1": ["retentionId", "agencyId", "projectId", "revisionId", "retentionClass", "anchorEvidenceHash", "policyVersion"],
  "retention_record.expired.v1": ["retentionId", "agencyId", "projectId", "revisionId", "retentionClass"],
  "project.deletion_requested.v1": ["projectId", "agencyId", "deletionId", "reasonCode"],
  "project.deleted.v1": ["projectId", "agencyId", "deletionId"],
  "retention_record.deleting.v1": ["retentionId", "agencyId", "projectId", "deletionId"],
  "retention_record.deleted.v1": ["retentionId", "agencyId", "projectId", "deletionId", "withResiduals"],
  "retention_record.extended.v1": ["retentionId", "agencyId", "projectId", "revisionId", "extensionId", "retentionClass", "requestedSeconds", "grantedSeconds", "cappedAtHardDeadline"],
  "source_file.admitted.v1": ["fileId", "agencyId", "projectId", "originRevisionId", "originUploadId", "inspectionReceiptHash", "bytes", "format"],
  // the revisions whose selection or seal names the file travel as ids so EXECUTION_CONTROL (B08) can revoke stale authority
  "source_file.admission_revoked.v1": ["fileId", "agencyId", "projectId", "revocationReason", "selectedByRevisionIds", "sealedByRevisionIds"],
  // payments and fiscal workflow (package B09, commerce/events.ts)
  ...COMMERCE_EVENT_PAYLOAD_ALLOWLIST,
  // nextReviewAt is a canonical UTC instant, admitted by the payload gate (D-SUP-5); the summary and the evidence are never in it
  "support_case.opened.v1": ["caseId", "projectId", "category", "severity", "nextReviewAt"],
  // the buyer type and the owner's affirmation travel as the two enumerated facts, with the recording membership's id
  "agency_buyer_type.recorded.v1": ["agencyId", "buyerType", "forEconomicActivity", "recordedByMembershipId"],
  // the grant travels as ids and counts: never an object name, a URL or a signature (S048; the URLs are bearer secrets, never journaled)
  "download_authorization.issued.v1": ["authorizationId", "agencyId", "projectId", "packageVersionId", "membershipId", "artifactIds", "lifetimeSeconds"],
  // processing authority (package B08, model/execution/events.ts)
  ...EXECUTION_EVENT_PAYLOAD_ALLOWLIST,
  // audit authority (package B08, model/audit/events.ts)
  ...AUDIT_EVENT_PAYLOAD_ALLOWLIST,
  // agency recurrence and commission domain (package B10, commercial/events.ts): ids only
  ...COMMERCIAL_EVENT_PAYLOAD_ALLOWLIST,
  // Payments V1 bank-transfer route (commerce/bank-route.ts): references, hashes and tokens only
  ...BANK_ROUTE_EVENT_PAYLOAD_ALLOWLIST,
  ...BANK_CREDIT_EVENT_PAYLOAD_ALLOWLIST,
  // Payments V1 treasury refunds (commerce/treasury-refund.ts): references and hashes only
  ...TREASURY_REFUND_EVENT_PAYLOAD_ALLOWLIST,
  // Payments V1 outbound execution attempts (commerce/execution-attempt.ts): references, hashes, tokens, instants and counts only
  ...OUTBOUND_ATTEMPT_EVENT_PAYLOAD_ALLOWLIST,
  // outreach (commercial/outreach-events.ts): ids, the sealed payload hash and tokens only
  ...OUTREACH_EVENT_PAYLOAD_ALLOWLIST,
});

/**
 * Registered destinations (07: "consumer: Registered destination"). Dispatchers arrive with their owning packages. The B07
 * consumers are control-plane pipelines of the source lifecycle (design B07 §7, decision D-CTRL-2): UPLOAD_INSPECTION observes,
 * hashes, inspects, scans and promotes a reported completion; SELECTION_EVALUATION counts a bound selection; STORAGE_LIFECYCLE
 * cancels provider sessions and deletes quarantined, late and unsealed objects under generation preconditions; AUTHORITY_JOURNAL
 * appends the tombstones that must survive a database restore (14 "Minimal durable facts outside the primary restore boundary").
 * The commerce consumers are package B09's (commerce/events.ts COMMERCE_CONSUMERS); JOB_EXECUTION is package B08's (admission,
 * launch, staging, verification and publication of a job; model/execution/events.ts, D8-XPKG-7), and so are AUDIT_ORCHESTRATION
 * (an audit's PROFILE, INTERPRET and VALIDATE steps) and PLAN_VALIDATION (a plan's validation intent; model/audit/events.ts).
 */
export const CONSUMERS = ["NOTIFICATIONS", "EXECUTION_CONTROL", "UPLOAD_INSPECTION", "SELECTION_EVALUATION", "STORAGE_LIFECYCLE", "AUTHORITY_JOURNAL", "DELETION_EXECUTOR", ...COMMERCE_CONSUMERS, ...EXECUTION_CONSUMERS, ...AUDIT_CONSUMERS, ...OUTREACH_CONSUMERS] as const;
export type Consumer = (typeof CONSUMERS)[number];

export const EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: EventType; readonly consumer: Consumer }> = Object.freeze([
  { eventType: "agency.created.v1", consumer: "NOTIFICATIONS" },
  { eventType: "membership.invited.v1", consumer: "NOTIFICATIONS" },
  { eventType: "approval.created.v1", consumer: "NOTIFICATIONS" },
  { eventType: "approval.withdrawn.v1", consumer: "NOTIFICATIONS" },
  { eventType: "approval.withdrawn.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "plan.withdrawn.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "plan.superseded.v1", consumer: "EXECUTION_CONTROL" },
  // B07 source lifecycle (design B07 §9): a reported completion starts verification; every end of application acceptance
  // (cancelled, expired, rejected) schedules storage cleanup and appends its restore tombstone; a bound selection is counted; an
  // end of source authority (superseded, cancelled, expired, deleted) is tombstoned and reaches the execution consumer
  { eventType: "upload_session.completion_reported.v1", consumer: "UPLOAD_INSPECTION" },
  { eventType: "upload_session.cancelled.v1", consumer: "STORAGE_LIFECYCLE" },
  { eventType: "upload_session.cancelled.v1", consumer: "AUTHORITY_JOURNAL" },
  { eventType: "upload_session.expired.v1", consumer: "STORAGE_LIFECYCLE" },
  { eventType: "upload_session.expired.v1", consumer: "AUTHORITY_JOURNAL" },
  { eventType: "upload_session.rejected.v1", consumer: "STORAGE_LIFECYCLE" },
  { eventType: "upload_session.rejected.v1", consumer: "AUTHORITY_JOURNAL" },
  { eventType: "upload_session.rejected.v1", consumer: "NOTIFICATIONS" },
  { eventType: "dataset_revision.selection_changed.v1", consumer: "SELECTION_EVALUATION" },
  { eventType: "dataset_revision.ready_to_seal.v1", consumer: "NOTIFICATIONS" },
  { eventType: "dataset_revision.rejected.v1", consumer: "NOTIFICATIONS" },
  // a rejection is a terminal authority fact too: a restore must not bring back an INSPECTING revision whose selected input failed
  // the admission contract (B07-F8, D-RESTORE-1)
  { eventType: "dataset_revision.rejected.v1", consumer: "AUTHORITY_JOURNAL" },
  // an admission revoked under a selection or a seal reaches the execution consumer and the agency (B07-F9), and is a terminal
  // authority fact a restore applies before traffic, so a restored database never re-admits bytes whose retention ended or whose
  // generation was lost (re-check N5, D-RESTORE-1)
  { eventType: "source_file.admission_revoked.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "source_file.admission_revoked.v1", consumer: "NOTIFICATIONS" },
  { eventType: "source_file.admission_revoked.v1", consumer: "AUTHORITY_JOURNAL" },
  { eventType: "dataset_revision.sealed.v1", consumer: "NOTIFICATIONS" },
  { eventType: "dataset_revision.superseded.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "dataset_revision.superseded.v1", consumer: "AUTHORITY_JOURNAL" },
  { eventType: "dataset_revision.cancelled.v1", consumer: "STORAGE_LIFECYCLE" },
  { eventType: "dataset_revision.cancelled.v1", consumer: "AUTHORITY_JOURNAL" },
  { eventType: "dataset_revision.expired.v1", consumer: "STORAGE_LIFECYCLE" },
  { eventType: "dataset_revision.expired.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "dataset_revision.expired.v1", consumer: "AUTHORITY_JOURNAL" },
  { eventType: "dataset_revision.deleted.v1", consumer: "AUTHORITY_JOURNAL" },
  // the one contractual extension of a soft deadline is a durable fact outside the restore boundary (14; B16 CMD060, GAP-RET-10): a
  // restored database never forgets it was used, so a second one cannot be granted
  { eventType: "retention_record.extended.v1", consumer: "AUTHORITY_JOURNAL" },
  // a requested deletion is a durable authority fact (a restore never resurrects the project) and the executor's work item (B16 CMD042)
  { eventType: "project.deletion_requested.v1", consumer: "DELETION_EXECUTOR" },
  { eventType: "project.deletion_requested.v1", consumer: "AUTHORITY_JOURNAL" },
  ...COMMERCE_EVENT_SUBSCRIPTIONS,
  // processing authority (package B08 §11): admission, launch and verification to JOB_EXECUTION, a cancellation to EXECUTION_CONTROL,
  // every terminal outcome and a package's availability to the agency
  ...EXECUTION_EVENT_SUBSCRIPTIONS,
  // audit authority (package B08 §11): the audit's live phases to AUDIT_ORCHESTRATION, its outcomes to the agency, a plan's validation
  // intent to PLAN_VALIDATION
  ...AUDIT_EVENT_SUBSCRIPTIONS,
  // B10 (commercial/events.ts): COMMISSIONS learns the funds' availability and the authorization's delivery
  ...COMMERCIAL_EVENT_SUBSCRIPTIONS,
  // Payments V1 bank-transfer route (commerce/bank-route.ts): the owner and the buyer are notified
  ...BANK_ROUTE_EVENT_SUBSCRIPTIONS,
  // Payments V1 inbound credits (commerce/bank-credit.ts)
  ...BANK_CREDIT_EVENT_SUBSCRIPTIONS,
  // Payments V1 treasury refunds (commerce/treasury-refund.ts): the owner is notified
  ...TREASURY_REFUND_EVENT_SUBSCRIPTIONS,
  // Payments V1 outbound execution attempts (commerce/execution-attempt.ts): the owner is notified
  ...OUTBOUND_ATTEMPT_EVENT_SUBSCRIPTIONS,
  // outreach (commercial/outreach-events.ts): the dispatcher learns of a queued intent
  ...OUTREACH_EVENT_SUBSCRIPTIONS,
]);

export function consumersOf(eventType: EventType): ReadonlyArray<Consumer> {
  return EVENT_SUBSCRIPTIONS.filter((s) => s.eventType === eventType).map((s) => s.consumer);
}

export type SafePayloadValue = Id | Sha256Hex | string | number | boolean | ReadonlyArray<string>;
export type EventPayload = Readonly<Record<string, SafePayloadValue>>;

const TOKEN = /^[A-Z][A-Z0-9_.-]{0,63}$/;

/** An uppercase machine token (states, roles, modes, reason codes, platform version labels such as R2-INITIAL). */
export function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function isSafeScalar(v: unknown): boolean {
  if (typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0;
  if (typeof v === "string") return isUuid(v) || isSha256Hex(v) || TOKEN.test(v) || isUtcInstant(v);
  return false;
}

/**
 * Rejects a payload that carries a key outside the allowlist of its event type or a value that is not a safe reference,
 * token, count or boolean. Labels, free text, nested objects and negative numbers never enter the outbox.
 */
export function assertAllowlistedPayload(eventType: EventType, payload: EventPayload): void {
  const allowed = EVENT_PAYLOAD_ALLOWLIST[eventType];
  for (const [k, v] of Object.entries(payload)) {
    if (!allowed.includes(k)) throw new TypeError(`${eventType}: payload key ${k} is not allowlisted`);
    if (Array.isArray(v)) {
      if (!v.every((x) => typeof x === "string" && (isUuid(x) || isSha256Hex(x)))) throw new TypeError(`${eventType}: list ${k} may hold only ids or hashes`);
    } else if (!isSafeScalar(v)) {
      throw new TypeError(`${eventType}: value of ${k} is not a safe reference, token, count or boolean`);
    }
  }
}

/** payloadArtifactHash (contract DomainEvent): SHA-256 of the canonical JSON of the closed payload. */
export function payloadDigest(payload: EventPayload): Sha256Hex {
  return rawDigest(canonicalBytes(payload));
}

export const EVENT_SCHEMA_VERSION = "1";

/** What a command hands to the EventPublisher: everything except the server-minted id, time and digest. */
export interface NewDomainEvent {
  readonly aggregateKind: AggregateKind;
  readonly aggregateId: Id;
  readonly aggregateVersion: number;
  readonly agencyId: AgencyId | null;
  readonly eventType: EventType;
  readonly actor: ActorRef;
  readonly causationId: CausationId;
  readonly correlationId: CorrelationId;
  readonly payload: EventPayload;
}

/**
 * What an aggregate operation yields beside its new record: the event of the new aggregate version without the request
 * provenance (actor, causation, correlation), which the command handler adds with `withProvenance` before publishing.
 * Every aggregate function validates its payload against the allowlist at construction, so an event that reaches the
 * publisher has already been proven free of labels and free text.
 */
export type AggregateEvent = Omit<NewDomainEvent, "actor" | "causationId" | "correlationId">;

export interface EventProvenance {
  readonly actor: ActorRef;
  readonly causationId: CausationId;
  readonly correlationId: CorrelationId;
}

export function aggregateEvent(event: AggregateEvent): AggregateEvent {
  assertAllowlistedPayload(event.eventType, event.payload);
  if (!Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion < 1) throw new RangeError(`${event.eventType}: aggregate version must be a positive integer`);
  return Object.freeze({ ...event, payload: Object.freeze({ ...event.payload }) });
}

export function withProvenance(event: AggregateEvent, provenance: EventProvenance): NewDomainEvent {
  return { ...event, actor: provenance.actor, causationId: provenance.causationId, correlationId: provenance.correlationId };
}

/** The durable row: the registry DomainEvent contract plus the columns the platform adds. */
export interface DomainEventRecord extends DomainEvent {
  readonly eventId: EventId;
  readonly aggregateKind: AggregateKind;
  readonly actor: ActorRef;
  readonly payload: EventPayload;
  /** Global append order (identity column); dispatch order within a consumer, never business order across aggregates. */
  readonly sequence: number;
  readonly createdAt: UtcInstant;
}
