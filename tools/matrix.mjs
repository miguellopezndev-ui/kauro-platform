// The B06 state, command and event matrix, the per-command error catalogue and the contract-test applicability record
// (re-check finding N13; prompts/B06 "Provide a complete state/command/event matrix"; registry program.json B06 work "Provide
// complete DTO/state/error contracts"; 10 "Contract tests and compatibility": "the catalogue records applicability and
// rationale", "The release includes an API compatibility report, route/schema inventory, command state matrix, error catalogue";
// 07 "Acceptance obligations": "The handoff to UI includes every state, safe field, permitted action and error").
//
//   node tools/matrix.mjs generate   writes docs/design/B06-state-command-event-matrix.md
//   node tools/matrix.mjs check      exits 1, listing every failure, when the committed document is not the generated one, an
//                                    edge of a registry or platform machine has no owner, an owner names a command the registry
//                                    does not have, an event type is not registered, a served command's edge names an event its
//                                    handler never publishes, or an applicability row cites a test that does not exist
//
// Sources (nothing in the document is written by hand except the owner table below, which the check keeps complete): the
// registry's state_transitions.json (via @kauro/contracts STATE_MACHINES, provenance-verified) and commands.json/cases.json, the
// platform machines of @kauro/domain (EndClient, Project; since B07 the source-lifecycle machines UploadSession, StoredObject,
// SourceFile, RetentionRecord; package B09's ten, D-MACH-B1..B10), EVENT_TYPES and EVENT_SUBSCRIPTIONS, the served command specs
// and their outcome catalogues of @kauro/application — B06's seven and, since mandate B07-COMMANDS served them, B07's six with the
// source reads and the selection manifest intake, and since mandate B08-COMMANDS-EXECUTION B08's two execution commands (CMD036 ExecuteProject,
// CMD037 CancelJob) with the GetJob read, whose events are read from the execution store's methods — the transition seeds of the migrations, the events each handler publishes (read
// from its source), and the api test sources the applicability rows cite. Requires the workspace to be built.
//
// Package B09's served commands and reads (decision D-REQ-B7) join the served sections from the application's served lists
// (COMMERCE_SERVED_COMMAND_IDS, COMMERCE_SERVED_READ_IDS): their specs (COMMERCE_COMMANDS), outcome catalogues
// (COMMERCE_COMMAND_OUTCOMES, COMMERCE_READ_OUTCOMES) and the events their units of work publish (COMMERCE_COMMAND_EVENTS — the
// request handler's intent and claim and the payment service's settle step through the reconciler's planners, which no handler
// source spells out; the route tests prove every event a run publishes is listed for its command).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MATRIX_PATH = join(root, "docs", "design", "B06-state-command-event-matrix.md");

function load(rel) {
  return import(pathToFileURL(join(root, rel)).href);
}

// --- who performs each edge ---------------------------------------------------------------------------------------------------
// `command`: the registry command that performs the edge (its package comes from the registry cases); `owner`: the package that
// performs an edge no registry command names, with why; `event`: the registered event type, or null when the owning package has
// not registered one yet. `initial` rows name who creates the aggregate in its initial state.

const B06_EVENTS_NOTE = "no event type registered: the owning package registers it with the edge";

/** The B07 decision that fixes each source-lifecycle platform machine (docs/design/B07-upload-source-lifecycle.md). */
const SOURCE_MACHINE_DECISIONS = { UploadSession: "D-UP-1", StoredObject: "D-OBJ-1", SourceFile: "D-FILE-1", RetentionRecord: "D-RET-2" };

export const EDGE_OWNERS = {
  Agency: {
    "(initial DRAFT)": { command: "CMD001", event: "agency.created.v1" },
    agreements_and_profile_accepted: { command: "CMD002", event: "agency.activated.v1" },
    material_risk_or_account_failure: { owner: "B16", why: "an incident or account fact of operations (CMD056 RecordIncident records it); no registry command names the restriction", event: "agency.restricted.v1" },
    restriction_remedied: { owner: "B16", why: "the reviewed remedy of the same incident; no registry command names it", event: "agency.restriction_remedied.v1" },
    owner_requests_closure: { command: "CMD043", event: "agency.closing.v1" },
    owner_abandons_setup: { command: "CMD043", event: "agency.closing.v1" },
    closure_obligations_completed: { owner: "B10", why: "the closure workflow of CMD043 once jobs, access, data and financial residuals are accounted for", event: "agency.closed.v1" },
  },
  Membership: {
    "(initial INVITED)": { command: "CMD003", event: "membership.invited.v1", note: "CMD001 creates the founding OWNER ACTIVE (membership.created.v1; decision D-CTX-2)" },
    intended_identity_accepts: { command: "CMD004", event: "membership.accepted.v1" },
    invitation_deadline: { owner: "B16", why: "the invitation's own deadline (the database admits INVITED -> EXPIRED only once expires_at has passed, re-check N19)", event: "membership.expired.v1" },
    inviter_revokes: { command: "CMD006", event: "membership.revoked.v1" },
    authorized_suspension: { owner: "B16", why: "membership authority (the CMD005/CMD006 family); no registry command names suspension", event: "membership.suspended.v1" },
    authorized_reactivation: { owner: "B16", why: "membership authority; no registry command names reactivation", event: "membership.reactivated.v1" },
    authorized_revocation: { command: "CMD006", event: "membership.revoked.v1" },
  },
  DatasetRevision: {
    "(initial DRAFT)": { command: "CMD011", event: "dataset_revision.created.v1", note: "CMD012 CreateRevision (B07) creates every later revision, with explicit lineage (D-REV-1)" },
    upload_reserved: { command: "CMD013", event: "dataset_revision.uploading.v1", note: "the first reservation, in its intent unit of work (D-RUN-2)" },
    all_uploads_completed: { command: "CMD016", event: "dataset_revision.selection_changed.v1", note: "the agency's explicit closing of the intake: CMD016 binds its selection on the UPLOADING revision once no upload of it is RESERVED, UPLOADING or VERIFYING (D-INTAKE-1, B07-F1); no observation, inspection outcome, cancellation or deadline takes it" },
    previously_admitted_inputs_selected: { command: "CMD016", event: "dataset_revision.selection_changed.v1", note: "a selection that reuses admitted files of the project binds on a DRAFT revision" },
    all_selected_inputs_admitted: { owner: "B07", why: "the SELECTION_EVALUATION consumer (control plane) records a complete evaluation of the bound selection and binds its counts", event: "dataset_revision.ready_to_seal.v1" },
    fatal_input_rejection: { owner: "B07", why: "the SELECTION_EVALUATION consumer (control plane) records an ADMISSION_FAILED evaluation of the bound selection (no silent removal)", event: "dataset_revision.rejected.v1" },
    selection_changes: { command: "CMD016", event: "dataset_revision.selection_changed.v1" },
    seal_command: { command: "CMD017", event: "dataset_revision.sealed.v1" },
    new_revision_explicitly_supersedes: { command: "CMD012", event: "dataset_revision.superseded.v1" },
    cancel_revision: { command: "CMD012", event: "dataset_revision.cancelled.v1", note: "CreateRevision cancels the mutable predecessor it replaces, with its uploads in flight (D-REV-2)" },
    retention_expires: { owner: "B07", why: "the retention sweeper (control plane): SEALED -> EXPIRED once no governing record is ACTIVE with a later effective deadline (D-RET-2); REJECTED -> EXPIRED once every intake window closed (D-RET-1)", event: "dataset_revision.expired.v1" },
    managed_cleanup_verified: { owner: "B16", why: "verified managed deletion", event: "dataset_revision.deleted.v1" },
    retention_cleanup_verified: { owner: "B16", why: "verified retention cleanup", event: "dataset_revision.deleted.v1" },
  },
  UploadSession: {
    "(initial RESERVED)": { command: "CMD013", event: "upload_session.reserved.v1", note: "the intent unit of work: quota, slot, quarantine intent and initiation anchor" },
    session_issued: { command: "CMD013", event: "upload_session.session_issued.v1", note: "the completion unit of work after the provider call, by the attempt holding the issuance fence (D-RUN-2)" },
    completion_reported: { command: "CMD014", event: "upload_session.completion_reported.v1" },
    completion_not_observed: { owner: "B07", why: "the UPLOAD_INSPECTION consumer (control plane) observes no complete object for the claim; the claim is cleared and the session stays usable until the deadline", event: "upload_session.completion_not_observed.v1" },
    inspection_admitted: { owner: "B07", why: "the UPLOAD_INSPECTION consumer (control plane): observation, inspection, scan coverage, promotion and a receipt of the current attempt (S053, S054)", event: "upload_session.admitted.v1" },
    inspection_rejected: { owner: "B07", why: "the UPLOAD_INSPECTION consumer (control plane) records a rejecting receipt of the current attempt (D-INSP-3)", event: "upload_session.rejected.v1" },
    cancel_upload: { command: "CMD015", event: "upload_session.cancelled.v1", note: "also CMD012 when it cancels a mutable predecessor's uploads" },
    reservation_expired: { owner: "B07", why: "the upload-deadline sweeper (control plane) at the application deadline, never earlier (R2-051)", event: "upload_session.expired.v1" },
    intake_deadline_reached: { owner: "B07", why: "the upload-deadline sweeper (control plane): an admitted file no sealed revision retains leaves with its intake window (D-RET-1)", event: "upload_session.expired.v1" },
  },
  StoredObject: {
    "(initial INTENDED)": { owner: "B07", why: "CMD013 registers the quarantine intent before any provider write; the control plane registers promotions and residuals found by stat or inventory (D-OBJ-1)", event: null },
    provider_object_observed: { owner: "B07", why: "a provider stat or inventory observed the generation (control plane)", event: null },
    bytes_verified: { owner: "B07", why: "the server recomputed SHA-256 over the complete generation (control plane)", event: null },
    deletion_requested: { owner: "B07", why: "the STORAGE_LIFECYCLE consumer (control plane): a tombstoned upload, a late or orphan residual, an expired intake; the deletion package (B16) requests the rest", event: null },
    deletion_confirmed: { owner: "B07", why: "the provider confirmed the deletion or the absence of the exact generation, with the residual the location read-back implies (D-OBJ-2)", event: null },
    deletion_failed: { owner: "B07", why: "a provider failure or a generation precondition failure is recorded, never a deletion (09 Early deletion: PARTIAL)", event: null },
    deletion_retried: { owner: "B07", why: "the deletion-retry sweeper (control plane)", event: null },
  },
  SourceFile: {
    "(initial ADMITTED)": { owner: "B07", why: "the UPLOAD_INSPECTION consumer admits a file only while its upload is VERIFYING under the current attempt (control plane); an aggregate since B07-F9", event: "source_file.admitted.v1" },
    admission_revoked: { owner: "B07", why: "the upload-deadline sweeper (INTAKE_EXPIRED, only for a file no seal ever included, once its intake window closed), the retention sweeper (RETENTION_EXPIRED, once no including revision holds an ACTIVE record ahead, D-RET-3) or object inventory (GENERATION_MISSING, GENERATION_CHANGED) (D-FILE-1)", event: "source_file.admission_revoked.v1" },
  },
  RetentionRecord: {
    "(initial ACTIVE)": { command: "CMD017", event: "retention_record.created.v1", note: "the UNPAID record anchored on the first seal of its bytes: hard deadline fourteen days after it, never restarted by a re-seal (D-RET-2, D-RET-3); later packages create the paid classes" },
    effective_deadline_reached: { owner: "B07", why: "the retention sweeper (control plane), never before the effective deadline", event: "retention_record.expired.v1" },
    early_deletion_requested: { command: "CMD042", event: null },
    cleanup_started: { owner: "B16", why: "managed deletion of expired data", event: null },
    cleanup_verified: { owner: "B16", why: "verified managed deletion", event: null },
    cleanup_verified_with_residuals: { owner: "B16", why: "verified managed deletion with recorded provider residuals", event: null },
  },
  Audit: {
    "(initial QUEUED)": { command: "CMD020", event: null },
    profile_worker_claims: { owner: "B08", why: "durable profile/interpret/validate orchestration", event: null },
    profile_and_candidates_complete: { owner: "B08", why: "durable orchestration", event: null },
    compiled_decisions_ready: { owner: "B08", why: "durable orchestration", event: null },
    unresolved_material_choice: { owner: "B08", why: "durable orchestration", event: null },
    capability_not_supported: { owner: "B08", why: "durable orchestration", event: null },
    complete_valid_receipt_and_current_authority: { owner: "B08", why: "durable orchestration", event: null },
    validatable_issue_needs_agency_choice: { owner: "B08", why: "durable orchestration", event: null },
    cancellation_wins: { command: "CMD021", event: null },
    absolute_deadline: { owner: "B08", why: "the audit's absolute deadline", event: null },
    fatal_integrity_error: { owner: "B08", why: "durable orchestration", event: null },
    fatal_contract_or_provider_error: { owner: "B08", why: "durable orchestration", event: null },
    fatal_contract_error: { owner: "B08", why: "durable orchestration", event: null },
  },
  Plan: {
    "(initial DRAFT)": { command: "CMD022", event: "plan.created.v1", note: "CMD023 RevisePlan (B06) creates the successor DRAFT of a revision" },
    compiled_or_edited: { command: "CMD023", event: "plan.validation_required.v1", note: "the successor of a revision; CMD022 CreatePlan (B03) compiles a first plan" },
    validation_admitted: { command: "CMD024", event: "plan.validating.v1" },
    valid_receipt: { command: "CMD024", event: "plan.validated.v1" },
    invalid_receipt_result: { command: "CMD024", event: "plan.validation_required.v1" },
    agency_approval: { command: "CMD025", event: "plan.approved.v1" },
    new_plan_revision: { command: "CMD023", event: "plan.superseded.v1" },
    withdraw_approval: { command: "CMD026", event: "plan.withdrawn.v1" },
    withdraw_plan: { owner: "B08", why: "an authorized project actor withdraws a VALIDATED plan (typed plan editing and exact approval); no registry command names it", event: "plan.withdrawn.v1" },
  },
  Job: {
    "(initial QUEUED)": { command: "CMD036", event: "processing_job.queued.v1" },
    capacity_reserved: { owner: "B08", why: "job admission", event: "processing_job.admitted.v1" },
    provider_start_observed: { owner: "B08", why: "fenced execution", event: "processing_job.running.v1" },
    complete_staging_submitted: { owner: "B08", why: "fenced staging", event: "processing_job.verifying.v1" },
    atomic_publication_accepted: { owner: "B08", why: "verification and publication", event: "processing_job.ready.v1" },
    cancel_command: { command: "CMD037", event: "processing_job.cancel_requested.v1" },
    provider_and_artifacts_reconciled: { owner: "B08", why: "cancellation reconciliation", event: "processing_job.cancelled.v1" },
    deadline_reached: { owner: "B08", why: "the job's deadline", event: "processing_job.expired.v1" },
    unrecoverable_start_error: { owner: "B08", why: "fenced execution", event: "processing_job.failed.v1" },
    fatal_resource_or_integrity_error: { owner: "B08", why: "fenced execution", event: "processing_job.failed.v1" },
    verification_failure: { owner: "B08", why: "verification", event: "processing_job.failed.v1" },
  },
  // package B09 (docs/design/B09-payments-fiscal.md §4): the provider-effect protocol of CMD028 (CREATE_ORDER), CMD029 (CAPTURE)
  // and CMD033 (REFUND) — intent, dispatch, settle — and the reconciliation of CMD030/CMD034
  PaymentAttempt: {
    "(initial PREPARED)": { command: "CMD028", event: "payment_attempt.prepared.v1", note: "CMD029 prepares CAPTURE attempts and CMD033 REFUND attempts the same way (D-PROTO-B1)" },
    dispatch_intent_committed: { command: "CMD029", event: "payment_attempt.dispatching.v1", note: "CMD028 and CMD033 commit their attempts' dispatch intent the same way" },
    cancel_before_dispatch: { owner: "B09", why: "the payment service's resume of an intent whose dispatch never committed: no provider call was possible (D-PROTO-B2)", event: "payment_attempt.cancelled_before_dispatch.v1" },
    authenticated_pending: { command: "CMD030", event: "payment_attempt.provider_pending.v1" },
    authenticated_completed: { command: "CMD030", event: "payment_attempt.confirmed.v1", note: "the dispatching command's own settle step records an authenticated response the same way" },
    ambiguous_transport_result: { owner: "B09", why: "the settle step of the provider-effect protocol classifies a timeout, reset or unreadable response (D-PROTO-B1)", event: "payment_attempt.uncertain.v1" },
    proved_no_effect: { command: "CMD034", event: "payment_attempt.failed_no_effect.v1" },
    observation_lost: { owner: "B09", why: "the payment service's watchdog past the dispatch deadline (D-PROTO-B4)", event: "payment_attempt.uncertain.v1" },
    reconciliation_completed: { command: "CMD034", event: "payment_attempt.confirmed.v1" },
    reconciliation_proves_no_effect: { command: "CMD034", event: "payment_attempt.failed_no_effect.v1" },
  },
  ImportStage: {
    "(initial PREPARED)": { owner: "B08", why: "fenced staging prepares the stage", event: null },
    verified_stage_package: { owner: "B08", why: "verification and publication", event: null },
    agency_starts_import_workflow: { owner: "B11", why: "the agency's staged import journey", event: null },
    receipt_submitted: { command: "CMD040", event: null },
    receipt_validator_claims: { owner: "B17", why: "receipt validation", event: null },
    receipt_complete: { owner: "B17", why: "receipt validation", event: null },
    receipt_missing_or_ambiguous: { owner: "B17", why: "receipt validation", event: null },
    corrected_receipt_admitted: { command: "CMD040", event: null },
    stage_requires_no_receipt_and_preparation_complete: { owner: "B08", why: "stage publication", event: null },
    approved_partial_scope_accounted: { command: "CMD041", event: null },
    retention_deadline: { owner: "B16", why: "staged retention caps", event: null },
    cancellation_wins: { owner: "B08", why: "stage cancellation", event: null },
  },
  Capability: {
    "(initial DESIGN)": { owner: "B18", why: "capability versions are created by operations (CMD058 ChangeCapability)", event: null },
    implementation_observed: { owner: "B05", why: "the implementation is observed in the platform repository", event: null },
    internal_qualification_accepted: { owner: "B17", why: "integrated capacity and target qualification", event: null },
    limited_production_gates_accepted: { owner: "B19", why: "commercial production activation", event: null },
    operating_maturity_accepted: { owner: "B20", why: "operating maturity", event: null },
    material_counterexample: { command: "CMD059", event: null },
  },
  CostGrant: {
    "(initial PREPARED)": { owner: "B03", why: "the durable audit request reserves a grant (CMD020 StartAudit)", event: null },
    // B09 funds no cost grant: the grant's own package records the owner's funding evidence (B09 open question Q-B09-9; B09-F17)
    actual_authorization_and_funding: { owner: "B03", why: "the grant package records the owner's funding evidence (the funding decision is the owner application's, B12); B09 funds no cost grant (Q-B09-9)", event: null },
    remaining_budget_unavailable: { owner: "B03", why: "bounded reservations", event: null },
    reconciliation_releases_unused_reserve: { owner: "B03", why: "reconciled reservations", event: null },
    expiry_reached: { owner: "B03", why: "the grant's expiry", event: null },
    all_effects_reconciled_and_scope_closed: { owner: "B03", why: "grant closure", event: null },
    all_effects_reconciled: { owner: "B03", why: "grant closure", event: null },
  },
  TaxDocument: {
    "(initial DRAFT)": { owner: "B09", why: "the fiscal consumer drafts the invoice of a completed capture and the credit note of a completed refund, blocked when the treatment is not reviewed (D-FISC-B1)", event: "tax_document.drafted.v1" },
    fiscal_profile_validated: { owner: "B09", why: "the fiscal consumer validates a draft whose reviewed treatment resolves; the database re-checks it (KP011, D-FISC-B1)", event: "tax_document.validated.v1" },
    issue_intent_committed: { command: "CMD035", event: "tax_document.submitting.v1" },
    authenticated_issuance: { command: "CMD035", event: "tax_document.issued.v1" },
    ambiguous_result: { command: "CMD035", event: "tax_document.uncertain.v1" },
    authenticated_rejection: { command: "CMD035", event: "tax_document.rejected.v1" },
    issued_document_found: { command: "CMD035", event: "tax_document.issued.v1" },
    no_effect_and_rejection_proved: { command: "CMD035", event: "tax_document.rejected.v1" },
    corrected_draft_version: { owner: "B09", why: "the fiscal consumer drafts the corrected successor naming the rejected document (D-FISC-B3)", event: "tax_document.corrected.v1" },
    lawful_credit_or_correction_issued: { command: "CMD035", event: "tax_document.corrected.v1", note: "the authenticated issuance of the credit note that corrects the invoice" },
  },
  CommissionLine: {
    "(initial ACCRUED_PENDING)": { owner: "B10", why: "commission accrual", event: null },
    eligibility_conditions_met: { owner: "B10", why: "commission domain", event: null },
    justified_dispute_or_funds_hold: { owner: "B10", why: "commission domain", event: null },
    hold_resolved_and_eligible: { owner: "B10", why: "commission domain", event: null },
    statement_closed: { command: "CMD051", event: null },
    settled_payout_evidence: { command: "CMD053", event: null },
    payout_blocked: { command: "CMD053", event: null },
    reconciled_refund_adjustment: { owner: "B10", why: "refund adjustments", event: null },
    full_service_reversal: { owner: "B10", why: "refund adjustments", event: null },
    further_reconciled_adjustment: { owner: "B10", why: "refund adjustments", event: null },
  },
  EndClient: {
    "(initial ACTIVE)": { command: "CMD009", event: "end_client.created.v1" },
    archive_client: { command: "CMD010", event: "end_client.archived.v1" },
  },
  Project: {
    "(initial OPEN)": { command: "CMD011", event: "project.created.v1" },
    close_project: { owner: "B08", why: "delivery closes the project; no registry command names it", event: null },
    request_deletion: { command: "CMD042", event: null },
    deletion_verified: { owner: "B16", why: "verified managed deletion", event: null },
  },
  // package B09's platform machines (decisions D-MACH-B1..B10 of docs/design/B09-payments-fiscal.md)
  Quote: {
    "(initial DRAFT)": { command: "CMD027", event: "quote.drafted.v1", note: "drafted and issued in one transaction" },
    issue_quote: { command: "CMD027", event: "quote.issued.v1" },
    withdraw_quote: { owner: "B10", why: "the quote lifecycle of the recurrence package: an authorized billing actor withdraws an offer; no registry command names it", event: "quote.withdrawn.v1" },
    accept_terms_for_checkout: { command: "CMD028", event: "quote.accepted_for_checkout.v1", note: "a replacement quote is accepted only by the payment service's re-binding of the paid capture (D-QUOTE-B6)" },
    price_expiry_reached: { owner: "B10", why: "the quote lifecycle records the price expiry (checkout already refuses an expired price as QUOTE_EXPIRED)", event: "quote.expired.v1" },
    superseding_quote_issued: { command: "CMD027", event: "quote.superseded.v1", note: "the new binding quote supersedes the previous one before it is created; a paid quote is superseded only once its purchase is closed, or by the replacement its capture is re-bound to (D-QUOTE-B4, D-QUOTE-B6)" },
  },
  PaymentOrder: {
    "(initial INTENT_CREATED)": { command: "CMD028", event: "payment_order.intent_created.v1" },
    dispatch_intent_committed: { command: "CMD028", event: "payment_order.creating.v1" },
    cancel_before_dispatch: { owner: "B09", why: "the payment service's resume of a CMD028 intent whose dispatch never committed (D-PROTO-B2)", event: "payment_order.cancelled.v1" },
    provider_order_created: { command: "CMD028", event: "payment_order.created.v1" },
    creation_proved_no_effect: { command: "CMD034", event: "payment_order.failed.v1" },
    buyer_approval_observed: { command: "CMD030", event: "payment_order.approved.v1" },
    capture_dispatch_committed: { command: "CMD029", event: "payment_order.capturing.v1" },
    capture_observed: { command: "CMD030", event: "payment_order.captured.v1", note: "CMD029's settle step and CMD034 record an observed capture the same way" },
    capture_ambiguous: { command: "CMD029", event: "payment_order.capture_uncertain.v1" },
    capture_proved_no_effect: { command: "CMD029", event: "payment_order.approved.v1" },
    capture_proved_no_effect_unapproved: { command: "CMD029", event: "payment_order.created.v1" },
    reconciliation_proves_no_capture: { command: "CMD034", event: "payment_order.approved.v1" },
    reconciliation_proves_no_capture_unapproved: { command: "CMD034", event: "payment_order.created.v1" },
    order_voided: { command: "CMD030", event: "payment_order.cancelled.v1" },
    order_expired: { command: "CMD030", event: "payment_order.expired.v1", note: "or CMD034 when a provider query shows the expiry" },
  },
  CaptureFact: {
    "(initial PENDING)": { command: "CMD030", event: "capture.pending.v1", note: "a fact is born in the status its first authenticated observation shows (D-INIT-B1); CMD029 and CMD034 record captures too" },
    provider_completed: { command: "CMD030", event: "capture.completed.v1" },
    provider_denied: { command: "CMD030", event: "capture.denied.v1" },
    provider_reversed: { command: "CMD030", event: "capture.reversed.v1", note: "from COMPLETED only: a capture first seen reversed is recorded COMPLETED, then REVERSED, in one transaction (D-PAY-B5)" },
  },
  CommercialAuthorization: {
    "(initial ACTIVE)": { command: "CMD029", event: "commercial_authorization.issued.v1", note: "or the application of the capture's webhook (CMD030) or reconciliation (CMD034), in the capture's transaction" },
    execution_admitted: { owner: "B08", why: "JOB_ADMISSION (control plane) consumes the authorization in the transaction that admits its job, bound at COMMIT to that job edge (KA081; D8-AUTH-1: CMD036 binds and does not consume)", event: "commercial_authorization.consumed.v1" },
    package_published: { owner: "B08", why: "atomic publication of the purchased package", event: "commercial_authorization.delivered.v1" },
    authority_revoked: { command: "CMD030", event: "commercial_authorization.revoked.v1", note: "a reversal; CMD033 revokes it when a completed refund leaves no service basis" },
  },
  Refund: {
    "(initial REQUESTED)": { command: "CMD031", event: "refund.requested.v1", note: "the reconciler requests EXCESS_CAPTURE and KAURO_REMEDY refunds the same way" },
    approve_refund: { command: "CMD032", event: "refund.approved.v1" },
    reject_refund: { owner: "B12", why: "the owner's finance review rejects a request with a stated code; no registry command names a rejection (open question Q-B09-3)", event: "refund.rejected.v1" },
    dispatch_intent_committed: { command: "CMD033", event: "refund.submitting.v1" },
    authorization_lapsed: { owner: "B09", why: "the reconciler, when a reversal of the capture lapses an APPROVED refund before any dispatch", event: "refund.failed.v1" },
    authenticated_completed: { command: "CMD033", event: "refund.completed.v1" },
    ambiguous_transport_result: { command: "CMD033", event: "refund.uncertain.v1" },
    proved_no_effect: { command: "CMD033", event: "refund.approved.v1" },
    provider_refused: { command: "CMD033", event: "refund.failed.v1" },
    reconciliation_completed: { command: "CMD034", event: "refund.completed.v1" },
    reconciliation_proves_no_effect: { command: "CMD034", event: "refund.approved.v1" },
    reconciliation_proves_refusal: { command: "CMD034", event: "refund.failed.v1" },
  },
  ReconciliationCase: {
    "(initial OPEN)": { command: "CMD034", event: "reconciliation_case.opened.v1", note: "CMD029 and CMD030 open cases the same way" },
    case_resolved: { owner: "B12", why: "the owner's finance review records the explaining facts or decision; no registry command names it (Q-B09-3)", event: "reconciliation_case.resolved.v1" },
  },
  PaymentRoute: {
    "(initial CONFIGURED)": { owner: "B15", why: "the payment integration configures the merchant route (owner action: merchant and KYC identity)", event: null },
    route_qualified: { owner: "B15", why: "merchant eligibility, environment, capture, refund and settlement verified with live evidence (G-PAYMENT)", event: null },
    route_suspended: { owner: "B16", why: "an incident or account fact invalidates the route", event: null },
  },
  FiscalIssuerRoute: {
    "(initial CONFIGURED)": { owner: "B15", why: "the fiscal integration configures the issuer route (owner action: fiscal identity and numbering authorization)", event: null },
    route_qualified: { owner: "B15", why: "observed or professionally confirmed legal facts, a numbering authorization and verified issuance entitlement", event: null },
    route_suspended: { owner: "B16", why: "an incident or legal fact invalidates the route", event: null },
  },
  CorporateGrant: {
    "(initial ACTIVE)": { owner: "B12", why: "the owner application provisions an individually managed corporate identity's grant (08)", event: null },
    grant_revoked: { owner: "B12", why: "the owner application revokes it", event: null },
  },
  RefundPolicy: {
    "(initial ACTIVE)": { owner: "B12", why: "a KAURO_OWNER records a standing refund policy under a fresh step-up; no registry command names it (Q-B09-3)", event: null },
    policy_retired: { owner: "B12", why: "the owner retires it", event: null },
  },
};

/** Which decision declares each platform machine (the registry machines are the registry's). */
const PLATFORM_DECISIONS = {
  EndClient: "decisions D-AGG-1, D-AGG-2",
  Project: "decisions D-AGG-1, D-AGG-2",
  Quote: "B09 decision D-MACH-B1",
  PaymentOrder: "B09 decision D-MACH-B2",
  CaptureFact: "B09 decision D-MACH-B3",
  CommercialAuthorization: "B09 decision D-MACH-B4",
  Refund: "B09 decision D-MACH-B5",
  ReconciliationCase: "B09 decision D-MACH-B6",
  PaymentRoute: "B09 decision D-MACH-B7",
  FiscalIssuerRoute: "B09 decision D-MACH-B8",
  CorporateGrant: "B09 decision D-MACH-B9",
  RefundPolicy: "B09 decision D-MACH-B10",
};

// --- the contract-test applicability record (10 "Contract tests and compatibility") -------------------------------------------
// Each cell cites tests by file and title prefix (the check proves each exists) or says why the mutation does not apply.

const MUTATIONS = ["legitimate state", "wrong role", "wrong agency", "stale version", "duplicate request", "changed-body same key", "invalid schema", "lost response", "external uncertainty"];
const IDEM = "idempotency.test.ts";
const common = {
  "duplicate request": [[IDEM, "same key + same body → 200/201 replayed:true with the original body"], [IDEM, "concurrent duplicate: two in-flight identical requests"]],
  "changed-body same key": [[IDEM, "same key + different body → 409 IDEMPOTENCY_CONFLICT and no effect"]],
  "invalid schema": [["request-validation.test.ts", "manual-10 admission order"], ["schema-boundary.test.ts", "through the served routes, schema-shaped request members are refused"]],
  "lost response": [[IDEM, "response lost after commit → retry with the same key returns the journaled result"]],
  "external uncertainty": "NOT_APPLICABLE: the command performs no external effect; every effect is rows of one database transaction, and an outbox row is dispatched later by its consumer's package (N20), whose uncertainty belongs to that consumer",
};
const ROLE_MATRIX = ["role-matrix.test.ts", "N17: every served command against every role"];
const SOURCE_ROLE_MATRIX = ["source-role-matrix.test.ts", "every source-lifecycle command against every role"];

/**
 * The mutations a B07 command meets in its own file (B07 case map): the duplicate, the changed body under one key and the lost
 * response are its RACE test's (the replay, IDEMPOTENCY_CONFLICT, a crash before or after COMMIT); the invalid schema is the shared
 * admission of every served route. External uncertainty: the command reaches no provider (CMD013, which does, has its own cell).
 */
function sourceCommon(file) {
  return {
    "duplicate request": [[file, "RACE: "]],
    "changed-body same key": [[file, "RACE: "]],
    "invalid schema": common["invalid schema"],
    "lost response": [[file, "RACE: "]],
    "external uncertainty": "NOT_APPLICABLE: the command reaches no provider; every effect is rows of one database transaction, and its outbox rows are dispatched later by the control plane's consumers (mandate B07-CONTROL), whose provider uncertainty is theirs (STORAGE_LIFECYCLE records an UNCERTAIN cancellation and reconciles it)",
  };
}

export const APPLICABILITY = {
  CMD001: {
    ...common,
    "legitimate state": [["cmd001-create-agency.test.ts", "OK: a verified identity creates one DRAFT agency"]],
    "wrong role": [["cmd001-create-agency.test.ts", "DENY: unverified identity → 403 NOT_AUTHORIZED IDENTITY_UNVERIFIED"], ROLE_MATRIX],
    "wrong agency": "NOT_APPLICABLE: CreateAgency is identity-scoped (VERIFIED_USER, no agency selector); it creates the agency it acts on",
    "stale version": "NOT_APPLICABLE: a creation command carries no expectedVersion (registry fields: displayName)",
  },
  CMD009: {
    ...common,
    "legitimate state": [["cmd009-create-client.test.ts", "OK: an OPERATOR creates a client"]],
    "wrong role": [["cmd009-create-client.test.ts", "DENY: member of another agency → 404; VIEWER → 403 ROLE_INSUFFICIENT"], ROLE_MATRIX],
    "wrong agency": [["cmd009-create-client.test.ts", "DENY: member of another agency → 404"]],
    "stale version": "NOT_APPLICABLE: a creation command carries no expectedVersion (registry fields: displayName, processingAuthorityRef)",
  },
  CMD010: {
    ...common,
    "legitimate state": [["cmd010-archive-client.test.ts", "OK: an ADMIN archives an ACTIVE client"]],
    "wrong role": [["cmd010-archive-client.test.ts", "DENY: OPERATOR → 403"], ROLE_MATRIX],
    "wrong agency": [["cmd010-archive-client.test.ts", "DENY: OPERATOR → 403; foreign client → 404"]],
    "stale version": [["cmd010-archive-client.test.ts", "DENY: OPERATOR → 403; foreign client → 404; stale expectedVersion → 409 STALE_VERSION with current"]],
  },
  CMD011: {
    ...common,
    "legitimate state": [["cmd011-create-project.test.ts", "OK: an OPERATOR creates a CLEAN project"]],
    "wrong role": [["cmd011-create-project.test.ts", "DENY: foreign/wrong role → 404/403"], ROLE_MATRIX],
    "wrong agency": [["cmd011-create-project.test.ts", "DENY: foreign/wrong role → 404/403"]],
    "stale version": "NOT_APPLICABLE: a creation command carries no expectedVersion (registry fields: mode, purpose, targetInstanceRef); the client's and agency's current state are read after their transition locks (D-TX-2)",
    "invalid schema": [...common["invalid schema"], ["request-validation.test.ts", "R2-059: POST /clients/{id}/projects with verified=true and agencyOwner=true"]],
  },
  CMD023: {
    ...common,
    "legitimate state": [["cmd023-revise-plan.test.ts", "OK: an OPERATOR revises a VALIDATED plan"]],
    "wrong role": [["cmd023-revise-plan.test.ts", "DENY: APPROVER → 403"], ROLE_MATRIX],
    "wrong agency": [["cmd023-revise-plan.test.ts", "DENY: APPROVER → 403; foreign plan → 404"]],
    "stale version": [["cmd023-revise-plan.test.ts", "RACE: two RevisePlan calls with expectedVersion 2"]],
  },
  CMD025: {
    ...common,
    "legitimate state": [["cmd025-approve-plan.test.ts", "OK: an APPROVER with a fresh step-up approves a VALIDATED plan"]],
    "wrong role": [["cmd025-approve-plan.test.ts", "DENY: OPERATOR → 403"], ROLE_MATRIX],
    "wrong agency": [["cmd025-approve-plan.test.ts", "DENY: OPERATOR → 403; foreign → 404"]],
    "stale version": [["cmd025-approve-plan.test.ts", "RACE: two approvers on one version → one 201, one 409"]],
  },
  CMD026: {
    ...common,
    "legitimate state": [["cmd026-withdraw-approval.test.ts", "OK: the approving actor withdraws"]],
    "wrong role": [["cmd026-withdraw-approval.test.ts", "DENY: VIEWER → 403; another APPROVER → 403 NOT_APPROVAL_CONTROLLER"], ROLE_MATRIX],
    "wrong agency": [["cmd026-withdraw-approval.test.ts", "DENY: VIEWER → 403; another APPROVER → 403 NOT_APPROVAL_CONTROLLER; foreign → 404"]],
    "stale version": [["cmd026-withdraw-approval.test.ts", "RACE: two withdrawals → one 200, one 409"]],
  },
  // the source lifecycle (B07, mandate B07-COMMANDS): each command's own OK / DENY / RACE tests (docs/design/B07-case-map.md), the
  // role matrix of the six commands, and the shared schema admission of every served route
  CMD012: {
    ...sourceCommon("cmd012-create-revision.test.ts"),
    "legitimate state": [["cmd012-create-revision.test.ts", "OK: an OPERATOR replaces the project's SEALED revision"], ["cmd012-create-revision.test.ts", "OK: replacing a mutable revision cancels it"]],
    "wrong role": [["cmd012-create-revision.test.ts", "DENY: VIEWER → 403 ROLE_INSUFFICIENT"], SOURCE_ROLE_MATRIX],
    "wrong agency": [["cmd012-create-revision.test.ts", "DENY: VIEWER → 403 ROLE_INSUFFICIENT; foreign project → 404"], SOURCE_ROLE_MATRIX],
    "stale version": [["cmd012-create-revision.test.ts", "RACE: two CreateRevision calls on one project version → one 201, one 409 STALE_VERSION"]],
  },
  CMD013: {
    ...sourceCommon("cmd013-reserve-upload.test.ts"),
    "legitimate state": [["cmd013-reserve-upload.test.ts", "OK: an OPERATOR reserves 1 MB on a DRAFT revision"]],
    "wrong role": [["cmd013-reserve-upload.test.ts", "DENY: VIEWER → 403"], SOURCE_ROLE_MATRIX],
    "wrong agency": [["cmd013-reserve-upload.test.ts", "DENY: VIEWER → 403; foreign revision → 404"], SOURCE_ROLE_MATRIX],
    "stale version": [["cmd013-reserve-upload.test.ts", "DENY: VIEWER → 403"]],
    "external uncertainty": [["cmd013-reserve-upload.test.ts", "RACE: identical retry → the same reservation and the session re-delivered"], ["cmd014-complete-upload.test.ts", "DENY: another member's upload → 403 UPLOAD_NOT_OWNED; RESERVED → 409 SESSION_NOT_ISSUED"]],
  },
  CMD014: {
    ...sourceCommon("cmd014-complete-upload.test.ts"),
    "legitimate state": [["cmd014-complete-upload.test.ts", "OK: the requester reports completion → 202 ACCEPTED"]],
    "wrong role": [["cmd014-complete-upload.test.ts", "DENY: another member's upload → 403 UPLOAD_NOT_OWNED"], SOURCE_ROLE_MATRIX],
    "wrong agency": [SOURCE_ROLE_MATRIX],
    "stale version": "NOT_APPLICABLE: CompleteUpload carries no expectedVersion (registry fields: providerCompletionRef); it is idempotent by upload and claim (D-SAPI-5) and serializes with CancelUpload on the revision row — RACE of cmd014-complete-upload.test.ts",
  },
  CMD015: {
    ...sourceCommon("cmd015-cancel-upload.test.ts"),
    "legitimate state": [["cmd015-cancel-upload.test.ts", "OK: the requester cancels an UPLOADING upload"]],
    "wrong role": [["cmd015-cancel-upload.test.ts", "DENY: another member → 403 UPLOAD_NOT_OWNED"], SOURCE_ROLE_MATRIX],
    "wrong agency": [["cmd015-cancel-upload.test.ts", "DENY: another member → 403 UPLOAD_NOT_OWNED; ADMITTED → 409 UPLOAD_ADMITTED; already cancelled → 409 UPLOAD_TERMINAL; foreign → 404"], SOURCE_ROLE_MATRIX],
    "stale version": [["cmd015-cancel-upload.test.ts", "RACE: two cancels on one version → one 200, one 409 STALE_VERSION"]],
  },
  CMD016: {
    ...sourceCommon("cmd016-select-input-tables.test.ts"),
    "legitimate state": [["cmd016-select-input-tables.test.ts", "OK: an OPERATOR stores a selection manifest"]],
    "wrong role": [["cmd016-select-input-tables.test.ts", "DENY: a manifest made against another inventory"], SOURCE_ROLE_MATRIX],
    "wrong agency": [["cmd016-select-input-tables.test.ts", "DENY: a manifest made against another inventory"], SOURCE_ROLE_MATRIX],
    "stale version": [["cmd016-select-input-tables.test.ts", "RACE: two selections on one version → one 200, one 409 STALE_VERSION"]],
  },
  CMD017: {
    ...sourceCommon("cmd017-seal-revision.test.ts"),
    "legitimate state": [["cmd017-seal-revision.test.ts", "OK: an OPERATOR seals a READY_TO_SEAL revision"]],
    "wrong role": [["cmd017-seal-revision.test.ts", "DENY: a revoked admission → 409 INPUT_NOT_ADMITTED"], SOURCE_ROLE_MATRIX],
    "wrong agency": [["cmd017-seal-revision.test.ts", "DENY: a revoked admission → 409 INPUT_NOT_ADMITTED"], SOURCE_ROLE_MATRIX],
    "stale version": [["cmd017-seal-revision.test.ts", "RACE: two seals on one version → one 200, one 409"]],
  },
  // package B09's request side (implementation mandate M4; docs/design/B09-case-map.md CMD028..CMD032)
  CMD028: {
    "legitimate state": [["cmd028-create-payment-order.test.ts", "OK: an AGENCY_BILLING member creates one order for an issued quote"]],
    "wrong role": [["cmd028-create-payment-order.test.ts", "DENY: a foreign tenant's quote is NOT_FOUND, a wrong role (VIEWER) is NOT_AUTHORIZED"]],
    "wrong agency": [["cmd028-create-payment-order.test.ts", "DENY: a foreign tenant's quote is NOT_FOUND"]],
    "stale version": [["cmd028-create-payment-order.test.ts", "DENY: a foreign tenant's quote is NOT_FOUND, a wrong role (VIEWER) is NOT_AUTHORIZED, and one missing prerequisite at a time — expired source, stale terms"]],
    "duplicate request": [["cmd028-create-payment-order.test.ts", "RACE: an identical retry replays the one order"]],
    "changed-body same key": [["cmd028-create-payment-order.test.ts", "RACE: an identical retry replays the one order, the same key with another termsHash is 409 IDEMPOTENCY_CONFLICT"]],
    "invalid schema": [["b09-request-side.test.ts", "B09 admission: each served payment command refuses a malformed body at the boundary"]],
    "lost response": [["cmd028-create-payment-order.test.ts", "RACE: an identical retry replays the one order"], ["cmd028-create-payment-order.test.ts", "DENY (ambiguous): a creation timeout answers 202 and the same key observes by request identity"]],
    "external uncertainty": [["cmd028-create-payment-order.test.ts", "DENY (ambiguous): a creation timeout answers 202"], ["cmd028-create-payment-order.test.ts", "D-REQ-B8: a creation the provider proved had no effect takes a new deliberate attempt"]],
  },
  CMD029: {
    "legitimate state": [["cmd029-capture-payment.test.ts", "OK: capture through the server adapter"]],
    "wrong role": [["cmd029-capture-payment.test.ts", "DENY: a foreign tenant's order is NOT_FOUND, a wrong role is NOT_AUTHORIZED"]],
    "wrong agency": [["cmd029-capture-payment.test.ts", "DENY: a foreign tenant's order is NOT_FOUND"]],
    "stale version": "NOT_APPLICABLE: CapturePayment carries no expectedVersion (registry field: providerApprovalRef); the order's state is read before its transition lock and again under it, and a capture already paid or in flight answers ALREADY_PAID or PAYMENT_PENDING with the current state",
    "duplicate request": [["cmd029-capture-payment.test.ts", "RACE: an identical retry replays"]],
    "changed-body same key": [["cmd029-capture-payment.test.ts", "RACE: an identical retry replays, the same key with another providerApprovalRef is 409 IDEMPOTENCY_CONFLICT"]],
    "invalid schema": [["b09-request-side.test.ts", "B09 admission: each served payment command refuses a malformed body at the boundary"]],
    "lost response": [["cmd029-capture-payment.test.ts", "RACE: an identical retry replays"]],
    "external uncertainty": [["cmd029-capture-payment.test.ts", "DENY: a foreign tenant's order is NOT_FOUND"], ["cmd029-capture-payment.test.ts", "RACE: an identical retry replays"]],
  },
  CMD031: {
    "legitimate state": [["cmd031-request-refund.test.ts", "OK: an AGENCY_BILLING member requests a refund of a paid project"]],
    "wrong role": [["cmd031-request-refund.test.ts", "DENY: a foreign tenant's project is NOT_FOUND, a wrong role (VIEWER) is NOT_AUTHORIZED"]],
    "wrong agency": [["cmd031-request-refund.test.ts", "DENY: a foreign tenant's project is NOT_FOUND"]],
    "stale version": "NOT_APPLICABLE: a request creates the refund and carries no expectedVersion (registry fields: reasonCode, evidenceRef); the capture it names is read after its transition lock, and a second open request is REFUND_REQUEST_OPEN",
    "duplicate request": [["cmd031-request-refund.test.ts", "RACE: an identical retry replays"]],
    "changed-body same key": [["cmd031-request-refund.test.ts", "RACE: an identical retry replays, the same key with another reasonCode is 409 IDEMPOTENCY_CONFLICT"]],
    "invalid schema": [["b09-request-side.test.ts", "B09 admission: each served payment command refuses a malformed body at the boundary"]],
    "lost response": [["cmd031-request-refund.test.ts", "RACE: an identical retry replays"]],
    "external uncertainty": "NOT_APPLICABLE: a refund request reaches no provider (customer cancellation is no permission to send PSP refunds); the provider effect belongs to CMD033 after an owner's approval",
  },
  CMD032: {
    "legitimate state": [["cmd032-approve-refund.test.ts", "OK: a KAURO_OWNER with a fresh step-up approves the remaining service"], ["cmd032-approve-refund.test.ts", "D-REF-B4: a standing policy that covers the refund as it stands authorizes the approval without a step-up"]],
    "wrong role": [["cmd032-approve-refund.test.ts", "DENY: a refund of a foreign tenant outside the grant is NOT_FOUND, a wrong role (no KAURO_OWNER grant, or the requester) is NOT_AUTHORIZED"]],
    "wrong agency": [["cmd032-approve-refund.test.ts", "DENY: a refund of a foreign tenant outside the grant is NOT_FOUND"]],
    "stale version": [["cmd032-approve-refund.test.ts", "RACE: an identical retry replays, the same key with other amounts is 409 IDEMPOTENCY_CONFLICT with no effect, a crash at the intent/commit boundary leaves the refund REQUESTED, two approvals of one version give one 200 and one 409 STALE_VERSION"]],
    "duplicate request": [["cmd032-approve-refund.test.ts", "RACE: an identical retry replays"]],
    "changed-body same key": [["cmd032-approve-refund.test.ts", "RACE: an identical retry replays, the same key with other amounts is 409 IDEMPOTENCY_CONFLICT"]],
    "invalid schema": [["b09-request-side.test.ts", "B09 admission: each served payment command refuses a malformed body at the boundary"]],
    "lost response": [["cmd032-approve-refund.test.ts", "RACE: an identical retry replays"]],
    "external uncertainty": "NOT_APPLICABLE: an approval records the immutable refund intent in one transaction and calls no provider; the provider effect and its uncertainty belong to CMD033 ExecuteRefund (the payment service)",
  },
};

// package B09's served payment commands (stage-2 mandate M3; docs/design/B09-payments-fiscal.md §8 CMD030, CMD033, CMD034)
const WEBHOOK = "cmd030-payment-webhook.test.ts";
const EXECUTE = "cmd033-execute-refund.test.ts";
const RECONCILE = "cmd034-reconcile-payment.test.ts";
const SERVICE_ADMISSION = ["b09-payment-service.test.ts", "the payment service's routes admit their requests in manual-10 order"];
APPLICABILITY.CMD030 = {
  "legitimate state": [[WEBHOOK, "OK: a verified capture event is stored once in the inbox and applied to its order"]],
  "wrong role": [[WEBHOOK, "DENY: an invalid signature (the wrong role of a sender) stores nothing but the denial"]],
  "wrong agency": [[WEBHOOK, "DENY: an invalid signature (the wrong role of a sender) stores nothing but the denial; an event of a foreign tenant's environment or an unknown provider reference is an exception"]],
  "stale version": "NOT_APPLICABLE: a provider event carries no expectedVersion; an observation older in provider chronology than the latest applied one is kept as history and changes nothing (STALE_IGNORED, D-PAY-B3)",
  "duplicate request": [[WEBHOOK, "RACE: an identical retry of a delivery is the same inbox record"]],
  "changed-body same key": [[WEBHOOK, "RACE: an identical retry of a delivery is the same inbox record, a delivery with another body under the same event id (the webhook's IDEMPOTENCY_CONFLICT) is a recorded conflict never APPLIED"]],
  "invalid schema": [SERVICE_ADMISSION],
  "lost response": [[WEBHOOK, "RACE: an identical retry of a delivery is the same inbox record, a delivery with another body under the same event id (the webhook's IDEMPOTENCY_CONFLICT) is a recorded conflict never APPLIED, a crash between the ingress commit and the application applies the record once"]],
  "external uncertainty": "NOT_APPLICABLE: the webhook performs no provider effect; an event that reports a completion without its instant is applied only after a stored provider query of its order (D-PAY-B6), and a verification that calls the provider does so before anything is stored",
};
APPLICABILITY.CMD033 = {
  "legitimate state": [[EXECUTE, "OK: the payment service executes an approved refund once"]],
  "wrong role": [[EXECUTE, "DENY: a refund of a foreign tenant is NOT_FOUND, a wrong service identity is NOT_AUTHORIZED"]],
  "wrong agency": [[EXECUTE, "DENY: a refund of a foreign tenant is NOT_FOUND"]],
  "stale version": [[EXECUTE, "DENY: a refund of a foreign tenant is NOT_FOUND, a wrong service identity is NOT_AUTHORIZED, and one missing prerequisite"]],
  "duplicate request": [[EXECUTE, "RACE: an identical retry resumes the one operation"]],
  "changed-body same key": [[EXECUTE, "RACE: an identical retry resumes the one operation, the same key with another expectedVersion is 409 IDEMPOTENCY_CONFLICT"]],
  "invalid schema": [SERVICE_ADMISSION],
  "lost response": [[EXECUTE, "RACE: an identical retry resumes the one operation, the same key with another expectedVersion is 409 IDEMPOTENCY_CONFLICT with no effect, a crash before the intent commits leaves nothing"]],
  "external uncertainty": [[EXECUTE, "DENY: a refund of a foreign tenant is NOT_FOUND, a wrong service identity is NOT_AUTHORIZED, and one missing prerequisite (not APPROVED; a reversed capture lapses it) is refused; a refund timeout stays UNCERTAIN (202)"]],
};
APPLICABILITY.CMD034 = {
  "legitimate state": [[RECONCILE, "OK: a stored provider query advances an uncertain capture to CAPTURED with its authorization"]],
  "wrong role": [[RECONCILE, "DENY: an order of a foreign tenant is NOT_FOUND, a wrong service identity is NOT_AUTHORIZED"]],
  "wrong agency": [[RECONCILE, "DENY: an order of a foreign tenant is NOT_FOUND"]],
  "stale version": "NOT_APPLICABLE: ReconcilePayment carries no expectedVersion (registry fields: observationRef); observations are ordered by provider chronology and applied once per stored artifact and subject",
  "duplicate request": [[RECONCILE, "RACE: an identical retry replays"]],
  "changed-body same key": [[RECONCILE, "RACE: an identical retry replays, the same key with another observationRef is 409 IDEMPOTENCY_CONFLICT"]],
  "invalid schema": [SERVICE_ADMISSION],
  "lost response": [[RECONCILE, "RACE: an identical retry replays, the same key with another observationRef is 409 IDEMPOTENCY_CONFLICT with no effect, a crash at the intent/commit boundary applies the artifact once on retry"]],
  "external uncertainty": "NOT_APPLICABLE: the command applies a stored, authenticated provider query and calls no provider; the uncertainty it settles is the dispatching command's (the watchdog stores the query, D-PROTO-B4)",
};

// package B08's execution commands (mandate B08-COMMANDS-EXECUTION; docs/design/B08-case-map.md CMD036 and CMD037): each command's
// own OK / DENY / RACE tests, the role matrix of the two commands and the GetJob read, and the shared schema admission of every served route
const EXECUTE_PROJECT = "cmd036-execute-project.test.ts";
const CANCEL_JOB = "cmd037-cancel-job.test.ts";
const EXECUTION_ROLE_MATRIX = ["execution-role-matrix.test.ts", "every execution command and the job read against every role"];
APPLICABILITY.CMD036 = {
  "legitimate state": [[EXECUTE_PROJECT, "OK: ExecuteProject with a live commercial authorization"]],
  "wrong role": [[EXECUTE_PROJECT, "DENY: a VIEWER or an APPROVER is 403 ROLE_INSUFFICIENT"], EXECUTION_ROLE_MATRIX],
  "wrong agency": [[EXECUTE_PROJECT, "DENY: a VIEWER or an APPROVER is 403 ROLE_INSUFFICIENT and another agency's project 404"], EXECUTION_ROLE_MATRIX],
  "stale version": "NOT_APPLICABLE: ExecuteProject carries no expectedVersion (registry fields: commercialAuthorizationId); the authorization, approval, source, target and capability are read after their transition locks (D-TX-2) and a fact that changed is refused with its own reason (AUTHORIZATION_REVOKED, PLAN_NOT_APPROVED, SOURCE_EXPIRED, TARGET_STALE, MODE_NOT_OFFERED), never with STALE_VERSION",
  "duplicate request": [[EXECUTE_PROJECT, "RACE: an identical retry replays the 202"], [EXECUTE_PROJECT, "DENY: ExecuteProject for an authorization that already has a job answers that same job"]],
  "changed-body same key": [[EXECUTE_PROJECT, "RACE: an identical retry replays the 202, the same key with another authorization is 409 IDEMPOTENCY_CONFLICT"]],
  "invalid schema": common["invalid schema"],
  "lost response": [[EXECUTE_PROJECT, "S055: the process dies after ExecuteProject commits"], [EXECUTE_PROJECT, "RACE: an identical retry replays the 202"]],
  "external uncertainty": "NOT_APPLICABLE: ExecuteProject reaches no provider — it queues one job and its outbox record, and the control plane's JOB_EXECUTION launches the worker after COMMIT; the launch uncertainty is that consumer's (mandate B08-CONTROL-EXECUTION), and S055 proves the undelivered record stays due",
};
APPLICABILITY.CMD037 = {
  "legitimate state": [[CANCEL_JOB, "OK: CancelJob on a RUNNING job answers 200"]],
  "wrong role": [[CANCEL_JOB, "DENY: a VIEWER is 403"], EXECUTION_ROLE_MATRIX],
  "wrong agency": [[CANCEL_JOB, "DENY: a VIEWER is 403, another agency's job 404"], EXECUTION_ROLE_MATRIX],
  "stale version": [[CANCEL_JOB, "DENY: a VIEWER is 403, another agency's job 404, a stale version 409 STALE_VERSION"], [CANCEL_JOB, "RACE: an identical retry replays the 200"]],
  "duplicate request": [[CANCEL_JOB, "RACE: an identical retry replays the 200"]],
  "changed-body same key": [[CANCEL_JOB, "RACE: an identical retry replays the 200, the same key with another reason is 409 IDEMPOTENCY_CONFLICT"]],
  "invalid schema": common["invalid schema"],
  "lost response": [[CANCEL_JOB, "RACE: an identical retry replays the 200"], [CANCEL_JOB, "RACE (S062): CancelJob through the route racing the publication"]],
  "external uncertainty": "NOT_APPLICABLE: CancelJob records the cancellation on the job row and calls no provider; the control plane's EXECUTION_CONTROL terminates the attempt by identity and observes until it is terminal or proved absent (mandate B08-CONTROL-EXECUTION), and a job that was published first answers JOB_ALREADY_READY (S062)",
};

// --- sources --------------------------------------------------------------------------------------------------------------------

export async function loadMatrixSources() {
  const [contracts, domain, application] = await Promise.all([load("packages/contracts/dist/src/index.js"), load("packages/domain/dist/src/index.js"), load("packages/application/dist/src/index.js")]);
  const cases = contracts.registryJson("cases.json");
  const packageOfCase = new Map(cases.map((c) => [c.id, c.package]));
  const commands = new Map(contracts.registryJson("commands.json").map((c) => [c.id, { ...c, package: packageOfCase.get(c.testIds[0]) ?? null }]));
  // the (machine, from, to) edges the migrations seed into kauro.state_transitions
  const seeded = new Set();
  const migrations = join(root, "packages", "persistence", "migrations");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrations, file), "utf8");
    for (const block of sql.matchAll(/INSERT INTO kauro\.state_transitions \(machine, from_state, to_state\) VALUES([\s\S]*?);/g)) {
      for (const t of block[1].matchAll(/\('([A-Za-z]+)', '([A-Z_]+)', '([A-Z_]+)'\)/g)) seeded.add(`${t[1]}:${t[2]}:${t[3]}`);
    }
  }
  // the events each served command's handler publishes
  const HANDLER_FILES = {
    CMD001: "commands/handlers/create-agency.ts",
    CMD009: "commands/handlers/create-client.ts",
    CMD010: "commands/handlers/archive-client.ts",
    CMD011: "commands/handlers/create-project.ts",
    CMD023: "commands/handlers/revise-plan.ts",
    CMD025: "commands/handlers/approve-plan.ts",
    CMD026: "commands/handlers/withdraw-approval.ts",
    CMD012: "sources/handlers/create-revision.ts",
    CMD013: "sources/handlers/reserve-upload.ts",
    CMD014: "sources/handlers/complete-upload.ts",
    CMD015: "sources/handlers/cancel-upload.ts",
    CMD016: "sources/handlers/select-input-tables.ts",
    CMD017: "sources/handlers/seal-revision.ts",
  };
  const published = {};
  for (const [id, file] of Object.entries(HANDLER_FILES)) {
    const text = readFileSync(join(root, "packages", "application", "src", ...file.split("/")), "utf8");
    published[id] = [...new Set([...text.matchAll(/eventType: "([a-z_.0-9]+)"/g)].map((m) => m[1]))];
  }
  // package B08's two commands (D8-API-1): the execution store writes each event in the statement that changes the job, so the events
  // are read from the store method the handler calls (queueJob for CMD036, requestCancellation for CMD037)
  const executionStore = readFileSync(join(root, "packages", "persistence", "src", "execution", "store.ts"), "utf8");
  const storeEvents = (method) => {
    const start = executionStore.indexOf(`  async ${method}(`);
    if (start < 0) throw new Error(`the execution store has no method ${method}`);
    const end = executionStore.indexOf("\n  }\n", start);
    return [...new Set([...executionStore.slice(start, end).matchAll(/"(processing_job\.[a-z_.0-9]+)"/g)].map((m) => m[1]))];
  };
  published.CMD036 = storeEvents("queueJob");
  published.CMD037 = storeEvents("requestCancellation");
  // package B09's served commands (D-REQ-B7): their specs, catalogues and published events from the application's served lists
  const specs = { ...application.B06_COMMANDS, ...application.B07_COMMANDS, ...application.EXECUTION_COMMANDS };
  const outcomes = { ...application.COMMAND_OUTCOMES };
  for (const id of application.COMMERCE_SERVED_COMMAND_IDS) {
    const c = application.COMMERCE_COMMANDS[id];
    specs[id] = { name: c.name, method: c.method, path: c.path, role: c.role, scope: c.scope, stepUpRequired: c.stepUp !== "NEVER", stepUp: c.stepUp };
    outcomes[id] = application.COMMERCE_COMMAND_OUTCOMES[id];
    published[id] = [...application.COMMERCE_COMMAND_EVENTS[id]];
  }
  const reads = { ...application.READ_ROUTES };
  const readOutcomes = { ...application.READ_OUTCOMES };
  const readViews = { ...application.READ_RESPONSES };
  for (const operationId of application.COMMERCE_SERVED_READ_IDS) {
    const r = application.COMMERCE_READ_ROUTES[operationId];
    reads[operationId] = { operationId, path: r.path, scope: r.scope, paginated: false, action: r.action, authority: r.authority };
    readOutcomes[operationId] = application.COMMERCE_READ_OUTCOMES[operationId];
    readViews[operationId] = { view: r.view };
  }
  // test titles of the api package, by file
  const testDir = join(root, "apps", "api", "test");
  const tests = {};
  for (const file of readdirSync(testDir).filter((f) => f.endsWith(".test.ts"))) {
    tests[file] = [...readFileSync(join(testDir, file), "utf8").matchAll(/^test\(\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`));
  }
  return {
    machines: [...contracts.STATE_MACHINES, ...domain.PLATFORM_STATE_MACHINES, ...domain.SOURCE_LIFECYCLE_STATE_MACHINES],
    registryMachines: new Set(contracts.STATE_MACHINES.map((m) => m.contract)),
    sourceMachines: new Set(domain.SOURCE_LIFECYCLE_STATE_MACHINES.map((m) => m.contract)),
    sourceSpecs: application.B07_COMMANDS,
    sourceOutcomes: application.SOURCE_COMMAND_OUTCOMES,
    sourceRoutes: application.SOURCE_ROUTES,
    sourceRouteOutcomes: application.SOURCE_ROUTE_OUTCOMES,
    commands,
    eventTypes: new Set(domain.EVENT_TYPES),
    subscriptions: domain.EVENT_SUBSCRIPTIONS,
    specs,
    outcomes,
    reads,
    readOutcomes,
    readViews,
    intakes: application.SOURCE_INTAKE_ROUTES,
    intakeOutcomes: application.INTAKE_OUTCOMES,
    intakeViews: application.INTAKE_RESPONSES,
    outcomesByStatus: application.outcomesByStatus,
    problemStatus: application.PROBLEM_STATUS,
    served: new Set([...application.SERVED_COMMAND_IDS, ...application.COMMERCE_SERVED_COMMAND_IDS]),
    seeded,
    published,
    tests,
    provenance: contracts.provenance(),
  };
}

// --- checking the owner table and the citations -----------------------------------------------------------------------------------

export function checkSources(s, owners = EDGE_OWNERS, applicability = APPLICABILITY) {
  const failures = [];
  for (const m of s.machines) {
    const table = owners[m.contract];
    if (!table) {
      failures.push(`machine ${m.contract} has no owner table`);
      continue;
    }
    const keys = new Set([`(initial ${m.initial})`, ...m.transitions.map((t) => t.event)]);
    for (const k of keys) if (!(k in table)) failures.push(`${m.contract}: ${k} has no owner`);
    for (const k of Object.keys(table)) if (!keys.has(k)) failures.push(`${m.contract}: the owner table names ${k}, which the machine does not list`);
  }
  for (const [machine, table] of Object.entries(owners)) {
    if (!s.machines.some((m) => m.contract === machine)) failures.push(`the owner table names machine ${machine}, which neither the registry nor the platform declares`);
    for (const [k, o] of Object.entries(table)) {
      if (o.command !== undefined && !s.commands.has(o.command)) failures.push(`${machine}: ${k} names ${o.command}, which the registry does not have`);
      if (o.command === undefined && (typeof o.owner !== "string" || typeof o.why !== "string")) failures.push(`${machine}: ${k} names neither a command nor an owner with its reason`);
      if (o.event !== null && !s.eventTypes.has(o.event)) failures.push(`${machine}: ${k} names ${o.event}, which EVENT_TYPES does not register`);
      if (o.command !== undefined && s.served.has(o.command) && o.event !== null && !s.published[o.command].includes(o.event)) failures.push(`${machine}: ${k} says ${o.command} publishes ${o.event}, which its handler never publishes`);
    }
  }
  for (const [command, row] of Object.entries(applicability)) {
    for (const mutation of MUTATIONS) {
      const cell = row[mutation];
      if (cell === undefined) failures.push(`${command}: no applicability for "${mutation}"`);
      else if (typeof cell === "string") {
        if (!cell.startsWith("NOT_APPLICABLE: ")) failures.push(`${command}: "${mutation}" is neither cited tests nor NOT_APPLICABLE with its reason`);
      } else {
        for (const [file, prefix] of cell) {
          const titles = s.tests[file];
          if (!titles) failures.push(`${command}: "${mutation}" cites ${file}, which does not exist`);
          else if (!titles.some((t) => t.startsWith(prefix))) failures.push(`${command}: "${mutation}" cites a test of ${file} starting "${prefix}", which does not exist`);
        }
      }
    }
  }
  for (const id of s.served) if (!(id in applicability)) failures.push(`${id} is served but has no applicability row`);
  // the specified source-lifecycle commands and routes (B07): each has its closed outcome catalogue before it is served
  for (const id of Object.keys(s.sourceSpecs)) if (!s.sourceOutcomes[id]) failures.push(`${id} is specified but has no outcome catalogue`);
  for (const id of Object.keys(s.sourceRoutes)) if (!s.sourceRouteOutcomes[id]) failures.push(`the source route ${id} has no outcome catalogue`);
  // since mandate B07-COMMANDS every specified B07 command is served, every source read is a served read and the intake is served
  for (const id of Object.keys(s.sourceSpecs)) if (!s.served.has(id)) failures.push(`${id} is specified but not served`);
  for (const [id, route] of Object.entries(s.sourceRoutes)) {
    if (route.method === "GET" && !(id in s.reads)) failures.push(`the source read ${id} is not a served read`);
    if (route.method === "POST" && !(id in s.intakes)) failures.push(`the source intake ${id} is not a served intake`);
  }
  return failures;
}

// --- generation -----------------------------------------------------------------------------------------------------------------

const cell = (v) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function generateMatrix(s) {
  const out = [];
  const line = (text = "") => out.push(text);
  line("# State, command and event matrix (B06, B07, B08 and B09 served)");
  line();
  line("Generated by `tools/matrix.mjs` — do not edit; `pnpm run matrix` (part of `pnpm run verify`) fails when this file is not the");
  line("generated one or when a source it is generated from changed without it. Sources: the registry's `state_transitions.json`,");
  line("`commands.json` and `cases.json` (provenance-verified, `@kauro/contracts`), the platform machines of `@kauro/domain` (EndClient");
  line("and Project; UploadSession, StoredObject, SourceFile and RetentionRecord of the source lifecycle, B07; the commerce machines of B09)");
  line("and its event registry");
  line("(`EVENT_TYPES`, `EVENT_SUBSCRIPTIONS`), the served command specs and their outcome catalogues of `@kauro/application`");
  line("(`B06_COMMANDS`, `B07_COMMANDS` and, since mandate B08-COMMANDS-EXECUTION, `EXECUTION_COMMANDS`; `COMMAND_OUTCOMES`, enforced by the api's send guard), the reads and the selection manifest");
  line("intake with theirs (`READ_ROUTES`, `READ_OUTCOMES`, `SOURCE_INTAKE_ROUTES`, `INTAKE_OUTCOMES`; B07's served by mandate B07-COMMANDS), the transition");
  line("seeds of the migrations (`kauro.state_transitions`), the events each handler publishes (read from its source) and the");
  line("owner table and applicability record of `tools/matrix.mjs`, whose every citation the check resolves. Package B09's served");
  line("commands and reads join the served sections from `COMMERCE_SERVED_COMMAND_IDS` and `COMMERCE_SERVED_READ_IDS` (decision");
  line("D-REQ-B7): their specs, catalogues (`COMMERCE_COMMAND_OUTCOMES`, `COMMERCE_READ_OUTCOMES`) and published events");
  line("(`COMMERCE_COMMAND_EVENTS`, which the route tests prove complete). Authority:");
  line("prompts/B06 \"Provide a complete state/command/event matrix\"; 10 \"Contract tests and compatibility\"; 07 \"Acceptance");
  line("obligations\". Re-check finding N13.");
  line();
  line(`Registry: commands.json \`${s.provenance.files["commands.json"]}\`, state_transitions.json \`${s.provenance.files["state_transitions.json"]}\`.`);
  line();
  line("## 1. Every edge of every machine");
  line();
  line("`Performed by` names the registry command (and the package its cases belong to) or, where no registry command names the");
  line("edge, the owning package and why. `Stored` says what the platform holds today: **route** — a served command performs it;");
  line("**database** — the schema (migrations 0001–0007 of B06, 0008 the shared aggregate-kind registry, 0009–0012 of B07, 0013–0017 of B09, 0018 of their merge, 0019–0020 of B08) stores the aggregate and seeds the edge in");
  line("`kauro.state_transitions` (every other edge is refused, SQLSTATE KA008), so the owning package's writer is admitted and");
  line("checked; **—** — the aggregate is not stored yet.");
  line();
  for (const m of s.machines) {
    const table = EDGE_OWNERS[m.contract];
    const kind = s.registryMachines.has(m.contract)
      ? "registry machine"
      : s.sourceMachines.has(m.contract)
        ? `platform machine of the source lifecycle (B07 decision ${SOURCE_MACHINE_DECISIONS[m.contract]})`
        : `platform machine (${PLATFORM_DECISIONS[m.contract] ?? "undeclared"})`;
    line(`### ${m.contract}`);
    line();
    line(`${kind}; initial ${m.initial}; terminal ${m.terminal.join(", ")}; unlisted edges: ${m.unlistedTransition}.`);
    line();
    line("| From | Event | To | Performed by | Event type | Stored |");
    line("| --- | --- | --- | --- | --- | --- |");
    const rows = [{ from: "—", event: `(initial ${m.initial})`, to: m.initial }, ...m.transitions.map((t) => ({ from: t.from, event: t.event, to: t.to }))];
    const stored = [...s.seeded].some((k) => k.startsWith(`${m.contract}:`));
    for (const r of rows) {
      const o = table[r.event];
      const by = o.command !== undefined ? `${o.command} ${s.commands.get(o.command).name} (${s.commands.get(o.command).package ?? "no package"})${o.note ? `; ${o.note}` : ""}` : `${o.owner}: ${o.why}`;
      const event = o.event ?? `— (${B06_EVENTS_NOTE})`;
      const initial = r.from === "—";
      const b06 = o.command !== undefined && s.served.has(o.command) ? "route" : stored && (initial || s.seeded.has(`${m.contract}:${r.from}:${r.to}`)) ? "database" : "—";
      line(`| ${cell(r.from)} | ${cell(r.event)} | ${cell(r.to)} | ${cell(by)} | ${cell(event)} | ${b06} |`);
    }
    line();
  }
  line("Approval has no registry machine: CMD025 ApprovePlan creates it (`approval.created.v1`); CMD026 WithdrawApproval and a");
  line("CMD023 RevisePlan of an APPROVED plan withdraw it once (`approval.withdrawn.v1`); the database keeps a live approval and an");
  line("APPROVED plan bound to each other both ways at COMMIT (SQLSTATE KA020, re-check finding N5).");
  line();
  line("## 2. The served commands");
  line();
  line("A B09 provider command's events are those of its whole run: the request handler's intent and claim and the payment service's");
  line("settle step that its call causes (D-PROTO-B5); `Step-up` of CMD032 is a fresh step-up unless a standing policy covers the refund.");
  line();
  line("| Command | Route | Role | Scope | Step-up | Edges | Events published | Outbox consumers |");
  line("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const id of s.served) {
    const spec = s.specs[id];
    const edges = [];
    for (const [machine, table] of Object.entries(EDGE_OWNERS)) for (const [event, o] of Object.entries(table)) if (o.command === id) edges.push(`${machine} ${event}`);
    const events = s.published[id];
    const consumers = [...new Set(s.subscriptions.filter((x) => events.includes(x.eventType)).map((x) => `${x.eventType} → ${x.consumer}`))];
    line(`| ${id} ${spec.name} | ${spec.method} ${cell(spec.path)} | ${spec.role} | ${spec.scope} | ${spec.stepUp === "UNLESS_STANDING_POLICY" ? "fresh, or a covering standing policy" : spec.stepUpRequired ? "fresh" : "—"} | ${cell(edges.join("; "))} | ${cell(events.join(", "))} | ${cell(consumers.join("; ") || "—")} |`);
  }
  line();
  line("## 2a. The source-lifecycle routes (B07)");
  line();
  line("Specified by `docs/design/B07-upload-source-lifecycle.md` and served by mandate B07-COMMANDS: the six commands are rows of section 2");
  line("with their catalogues in section 3 and their applicability in section 4; the reads are rows of section 5; the selection manifest");
  line("intake (D-SEL-2: content-idempotent, no journal entry) is section 5a.");
  line();
  line("| Route | Operation | Role | Success view | Authority |");
  line("| --- | --- | --- | --- | --- |");
  for (const [id, route] of Object.entries(s.sourceRoutes)) line(`| ${route.method} ${cell(route.path)} | ${id} | ${route.role} | ${route.status} ${route.view} | ${cell(route.authority)} |`);
  line();
  line("## 3. Error catalogue");
  line();
  line("Every problem a served command may answer (`COMMAND_OUTCOMES`). The api's send guard refuses any other problem on the route");
  line("(`422 INTEGRITY_FAILURE RESPONSE_CONTRACT_VIOLATION`, handed to the internal-error sink), and `apps/api/openapi.json`");
  line("documents the same entries per status (`x-kauro-outcomes`). `current`: the problem carries the current safe version and");
  line("state — always, sometimes, or never (—). Frontends branch on code and reason, never on the title.");
  line();
  for (const id of s.served) {
    const spec = s.specs[id];
    line(`### ${id} ${spec.name}`);
    line();
    line("| Status | Code | Reason | Field codes | current | Layer | Meaning |");
    line("| --- | --- | --- | --- | --- | --- | --- |");
    for (const [status, entries] of s.outcomesByStatus(s.outcomes[id])) {
      for (const e of entries) line(`| ${status} | ${e.code} | ${e.reason ?? "—"} | ${e.fieldCodes ? e.fieldCodes.join(", ") : "—"} | ${e.current ? e.current.toLowerCase() : "—"} | ${e.layer} | ${cell(e.meaning)} |`);
    }
    line();
  }
  line("## 4. Contract-test applicability (manual 10)");
  line();
  line("\"For each command, tests cover the legitimate state, wrong role, wrong agency, stale version, duplicate request, changed-body");
  line("same key, invalid schema, lost response and relevant external uncertainty. Not every command needs every mutation if the risk");
  line("is absent; the catalogue records applicability and rationale.\" Each cited test is `apps/api/test/<file>` :: its title prefix;");
  line("the check proves every citation resolves to an existing test.");
  line();
  for (const id of s.served) {
    const spec = s.specs[id];
    line(`### ${id} ${spec.name}`);
    line();
    line("| Mutation | Applicability |");
    line("| --- | --- |");
    for (const mutation of MUTATIONS) {
      const c = APPLICABILITY[id][mutation];
      line(`| ${mutation} | ${typeof c === "string" ? cell(c) : c.map(([f, p]) => `\`${f}\` :: "${cell(p)}…"`).join("<br>")} |`);
    }
    line();
  }
  line("## 5. The manual-10 reads (re-check finding N16)");
  line();
  line("Every read runs under the caller's own context and policies after the same access decision as a command (identity, and for an");
  line("agency read an ACTIVE live membership after its transition lock; every membership role reads, AGENCY_READER); a denial is a");
  line("durable security fact under the read's action token. Lists page by keyset with an opaque cursor bound to the caller, the agency,");
  line("the list, its filter and its order (`api/cursor`, KEYSET_V1). What differs by role is the projection: a team manager");
  line("(MANAGE_TEAM) sees every membership with its lifecycle times, any other member the ACTIVE team's roles; every resource view");
  line("carries the caller's permitted actions (`api/permitted-actions`). Package B09's reads (D-REQ-B7) follow the same rules: the agency");
  line("reads its quote, order and refund under the agency selector (a resource outside its scope answers NOT_FOUND like a nonexistent one),");
  line("and the corporate owner reads a refund's review through its stored operation (STORED_OPERATION; KAURO_OWNER). Package B08's GetJob");
  line("(D8-API-1) is the status path of CMD036's 202: every member reads the job of the agency, a job of another agency answers NOT_FOUND,");
  line("and the view is the job's safe progress, never a provider identity, a fence or a lease.");
  line();
  line("| Read | Route | Scope | List | Reply view | Action token | Authority |");
  line("| --- | --- | --- | --- | --- | --- | --- |");
  for (const spec of Object.values(s.reads)) {
    line(`| ${spec.operationId} | GET ${cell(spec.path)} | ${spec.scope} | ${spec.paginated ? "limit, cursor" : "—"} | ${s.readViews[spec.operationId].view} | ${spec.action} | ${cell(spec.authority)} |`);
  }
  line();
  for (const spec of Object.values(s.reads)) {
    line(`### ${spec.operationId}`);
    line();
    line("| Status | Code | Reason | Field codes | current | Layer | Meaning |");
    line("| --- | --- | --- | --- | --- | --- | --- |");
    for (const [status, entries] of s.outcomesByStatus(s.readOutcomes[spec.operationId])) {
      for (const e of entries) line(`| ${status} | ${e.code} | ${e.reason ?? "—"} | ${e.fieldCodes ? e.fieldCodes.join(", ") : "—"} | ${e.current ? e.current.toLowerCase() : "—"} | ${e.layer} | ${cell(e.meaning)} |`);
    }
    line();
  }
  line("## 5a. The document intakes (B07 D-SEL-2)");
  line();
  line("A POST that stores a closed document once per content: 201 when stored, 200 with `created: false` when the same document was");
  line("already stored; no idempotency key and no journal entry (it changes no aggregate). The access decision is a read's (an ACTIVE live");
  line("membership after its transition lock) plus the intake's own role; every denial is a durable fact under its action token.");
  line();
  line("| Intake | Route | Scope | Reply view | Action token | Authority |");
  line("| --- | --- | --- | --- | --- | --- |");
  for (const spec of Object.values(s.intakes)) line(`| ${spec.operationId} | POST ${cell(spec.path)} | ${spec.scope} | ${s.intakeViews[spec.operationId].view} | ${spec.action} | ${cell(spec.authority)} |`);
  line();
  for (const spec of Object.values(s.intakes)) {
    line(`### ${spec.operationId}`);
    line();
    line("| Status | Code | Reason | Field codes | current | Layer | Meaning |");
    line("| --- | --- | --- | --- | --- | --- | --- |");
    for (const [status, entries] of s.outcomesByStatus(s.intakeOutcomes[spec.operationId])) {
      for (const e of entries) line(`| ${status} | ${e.code} | ${e.reason ?? "—"} | ${e.fieldCodes ? e.fieldCodes.join(", ") : "—"} | ${e.current ? e.current.toLowerCase() : "—"} | ${e.layer} | ${cell(e.meaning)} |`);
    }
    line();
  }
  return out.join("\n") + "\n";
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "generate" && mode !== "check") {
    process.stderr.write("usage: node tools/matrix.mjs generate|check\n");
    process.exitCode = 2;
    return;
  }
  const s = await loadMatrixSources();
  const failures = checkSources(s);
  const text = generateMatrix(s);
  if (mode === "generate") {
    if (failures.length > 0) {
      for (const f of failures) process.stderr.write(`matrix: ${f}\n`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(MATRIX_PATH, text);
    process.stdout.write(`matrix: wrote ${MATRIX_PATH} (${s.machines.length} machines, ${s.served.size} commands)\n`);
    return;
  }
  let committed = null;
  try {
    committed = readFileSync(MATRIX_PATH, "utf8");
  } catch (e) {
    failures.push(`${MATRIX_PATH} cannot be read (${e instanceof Error ? e.message : String(e)}); run pnpm run matrix:generate`);
  }
  if (committed !== null && committed !== text) failures.push("docs/design/B06-state-command-event-matrix.md is not the generated document (run pnpm run matrix:generate)");
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`matrix: ${f}\n`);
    process.exitCode = 1;
    return;
  }
  const edges = s.machines.reduce((n, m) => n + m.transitions.length + 1, 0);
  process.stdout.write(`matrix: the document is the generated one (${s.machines.length} machines, ${edges} edges and initial states each owned, ${s.served.size} commands, ${Object.keys(s.reads).length} reads and ${Object.keys(s.intakes).length} intake with their catalogues, every applicability citation resolved)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
