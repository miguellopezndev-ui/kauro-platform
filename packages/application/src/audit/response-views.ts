/**
 * Closed response views of the audit package (B08; docs/design/B08-audit-approval-jobs.md §12, D8-API-1), declared exactly as B06, B07 and
 * the execution package declare their own (api/response-schemas, decision D-RESP-1 of B06): a view that projects a registry contract
 * (Audit) takes every selected member from the generated registry bundle, may only narrow it by adding a keyword, keeps what the registry
 * requires required, and lists every registry member it does not select as withheld with the reason. Every object is closed.
 *
 * The AuditView is the safe progress of an audit (10 "Responses and safe errors": never a provider identity, a prompt or a customer
 * value): the sealed source and the target are named by id only, the grant by its classification and state, the pending decisions and the
 * unsupported capabilities by stable finding codes.
 */
import { RESPONSE_FIELD_VOCABULARY, VIEW_MEMBER_KIT, type ViewDefinition } from "../api/view-kit.js";
import { AUDIT_GRANT_CLASSES, AUDIT_RESOURCE_ACTIONS, IMPORT_STAGE_ACTIONS, TARGET_CONTRACT_ACTIONS } from "./views.js";
import { COST_GRANT_STATES, DECISION_ARTIFACT_KINDS } from "@kauro/domain";

const { ID, HASH, UTC } = RESPONSE_FIELD_VOCABULARY;
const { registry, platform, NARROW_ID } = VIEW_MEMBER_KIT;

/** A finding or reason code: a token the database's kauro.is_token admits (^[A-Z][A-Z0-9_]{2,63}$). */
const TOKEN = Object.freeze({ type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" });
/** A finding list: the database bounds it at 64 entries (audits_finding_codes_bounded). */
const FINDINGS = Object.freeze({ type: "array", maxItems: 64, items: TOKEN });

const AUDIT_ACTIONS_SCHEMA = Object.freeze({ type: "array", maxItems: AUDIT_RESOURCE_ACTIONS.length, items: { type: "string", enum: [...AUDIT_RESOURCE_ACTIONS] } });
const AUDIT_ACTIONS_DESCRIPTION =
  "The audit commands the caller may issue on this audit, derived server-side from the caller's role and the audit's state (CancelAudit while it is live, CreatePlan once it needs a decision); informative, never authority (B06 D-PERM-1).";

/** The success reply of each audit command: CMD020 and CMD024 answer B06's ACCEPTED envelope; CMD021 the audit; CMD022 the plan it created. */
export const AUDIT_COMMAND_RESPONSES = Object.freeze({
  CMD018: { status: 201, view: "TargetContractView" },
  CMD019: { status: 200, view: "TargetContractView" },
  CMD040: { status: 200, view: "ImportStageView" },
  CMD041: { status: 200, view: "ImportStageView" },
  CMD020: { status: 202, view: null },
  CMD021: { status: 200, view: "AuditView" },
  CMD022: { status: 201, view: "PlanView" },
  CMD024: { status: 202, view: null },
} as const);

export const AUDIT_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "TargetContractView",
    description:
      "A target contract version (B17: CMD018's and CMD019's answer): its CRM mode, instance and importer bindings, the digest of its immutable body, the observation and confirmation instants and its version; the metadata objects stay in the contract, never in the view.",
    contract: "TargetContract",
    withheld: {
      objects: "The complete observed metadata is the contract's body: the view names it by bodyHash and objectCount; it is data the importer consumes, never a customer value of this reply.",
    },
    members: {
      contractId: registry(true, NARROW_ID),
      projectId: platform(true, ID, "The project the contract was observed for."),
      mode: registry(true),
      instanceId: registry(true, NARROW_ID),
      importerProfileId: registry(true, NARROW_ID),
      importerVersion: registry(true),
      bodyHash: registry(true),
      observedAt: registry(true),
      confirmedAt: registry(false),
      authorityEvidenceHash: registry(true),
      capabilityVersion: registry(true),
      version: platform(true, { type: "integer", minimum: 1 }, "The contract's version: 1 as a DRAFT, 2 once confirmed (CMD019's expectedVersion)."),
      state: platform(true, { type: "string", enum: ["DRAFT", "CONFIRMED", "SUPERSEDED"] }, "DRAFT until the agency confirms this exact body, CONFIRMED afterwards, SUPERSEDED once a later contract replaced it."),
      objectCount: platform(true, { type: "integer", minimum: 0 }, "How many target objects the stored body describes."),
      permittedActions: platform(true, { type: "array", maxItems: TARGET_CONTRACT_ACTIONS.length, items: { type: "string", enum: [...TARGET_CONTRACT_ACTIONS] } }, "The commands the caller may issue on this contract, derived server-side from the caller's role and the contract's state; informative, never authority (B06 D-PERM-1)."),
    },
  },
  {
    name: "ImportStageView",
    description:
      "An import stage (B17: CMD040's answer and CMD041's): its dependency order, target object and operation, state, exact package and deadline, and the summary of its latest validated receipt; the stage's source identities and the receipt's source-to-target mapping stay in the stage and the receipt, never in the view.",
    contract: "ImportStage",
    withheld: {},
    members: {
      stageId: registry(true, NARROW_ID),
      projectId: registry(true, NARROW_ID),
      sequence: registry(true),
      objectApiName: registry(true),
      operation: registry(true),
      state: registry(true),
      parentStageIds: registry(true),
      packageHash: registry(true),
      receiptRequired: registry(true),
      expiresAt: registry(true),
      version: platform(true, { type: "integer", minimum: 1 }, "The stage's version (CMD041's expectedVersion): every receipt revision and the continuation advance it."),
      receiptRevision: platform(false, { type: "integer", minimum: 1 }, "The latest validated receipt revision of the stage: a correction is a new revision, never an overwrite."),
      receiptResult: platform(false, { type: "string", enum: ["COMPLETE", "PARTIAL_ACCOUNTED", "NEEDS_CORRECTION"] }, "What the latest receipt concluded: every identity matched, a fully accounted partition with explicit failures, or unresolved identities that block the child edges needing them."),
      identityMappingHash: platform(false, HASH, "The KAURO_STAGE_IDENTITY_MAPPING_V1 digest of the latest validated receipt: what CMD041's validatedReceiptHash names."),
      matchedRows: platform(false, { type: "integer", minimum: 0 }, "Source identities mapped unambiguously to a target identity."),
      failedRows: platform(false, { type: "integer", minimum: 0 }, "Source identities the receipt reports as explicitly failed."),
      unresolvedRows: platform(false, { type: "integer", minimum: 0 }, "Source identities missing, named twice or mapped to a target identity another source also claims."),
      continuedAt: platform(false, UTC, "When the approver recorded the continuation (the database's instant); absent before."),
      permittedActions: platform(true, { type: "array", maxItems: IMPORT_STAGE_ACTIONS.length, items: { type: "string", enum: [...IMPORT_STAGE_ACTIONS] } }, "The commands the caller may issue on this stage, derived server-side from the caller's role and the stage's state; informative, never authority (B06 D-PERM-1)."),
    },
  },
  {
    name: "AuditView",
    description:
      "An audit's safe progress (10 \"Long work returns 202 with operationId, current state, status URL and allowed polling guidance\"; design B08 §12): its durable phase, deadlines, grant classification and state, pending decisions or unsupported capabilities and its draft plan — never a provider identity, a prompt, the sealed source's or the target's hash or a customer value.",
    contract: "Audit",
    withheld: {
      interpretationDeadline:
        "Served as the optional interpretationDeadlineAt: the registry requires the deadline, but an audit that has not reached INTERPRETING has none yet (it is stamped once, by the database, at the first INTERPRETING).",
    },
    members: {
      auditId: registry(true, NARROW_ID),
      revisionId: registry(true, NARROW_ID),
      targetContractId: registry(true, NARROW_ID),
      state: registry(true),
      version: registry(true),
      startedAt: registry(true),
      interpretationDeadlineAt: platform(false, UTC, "No new semantic dispatch after this instant (the first INTERPRETING plus the interpretation window); absent until the audit reaches INTERPRETING and kept afterwards."),
      absoluteDeadline: registry(true),
      grantId: registry(true, NARROW_ID),
      grantClass: platform(true, { type: "string", enum: [...AUDIT_GRANT_CLASSES] }, "How the audit's grant is classified: FREE_AUDIT, carved from the platform's funded pool (D8-GRANT-1); never the pool's identity or the funding authorization."),
      grantState: platform(true, { type: "string", enum: [...COST_GRANT_STATES] }, "The audit grant's state (PREPARED, AUTHORIZED, EXHAUSTED, EXPIRED or CLOSED)."),
      candidateManifestHash: registry(false),
      cancelVersion: registry(true),
      pendingDecisions: platform(false, FINDINGS, "The decisions the customer owes, as stable finding codes (NEEDS_DECISION only); never a column name or a cell value."),
      unsupportedCapabilities: platform(false, FINDINGS, "The capabilities the audit could not plan, as stable finding codes (UNSUPPORTED only)."),
      terminalReason: platform(false, TOKEN, "The classified cause of a FAILED, EXPIRED or CANCELLED audit."),
      draftPlanId: platform(false, ID, "The system draft plan a DRAFT_READY audit published."),
      permittedActions: platform(true, AUDIT_ACTIONS_SCHEMA, AUDIT_ACTIONS_DESCRIPTION),
    },
  },
  {
    name: "DecisionArtifactIntakeView",
    description: "The decision-artifact intake (D8-PLAN-1): stored once per audit, kind and document; the same document again answers the stored artifact with created false.",
    contract: null,
    withheld: {},
    members: {
      artifactRef: platform(true, ID, "The artifact reference CMD022 and CMD023 name (candidateDecisionArtifactRef, decisionPatchArtifactRef)."),
      auditId: platform(true, ID, "The audit it decides on."),
      kind: platform(true, { type: "string", enum: [...DECISION_ARTIFACT_KINDS] }, "CANDIDATE_DECISIONS (CMD022) or DECISION_PATCH (CMD023)."),
      contentHash: platform(true, HASH, "KAURO_DECISION_ARTIFACT_V1 digest of the kind and the document: the artifact's content identity."),
      created: platform(true, { type: "boolean" }, "False when the same document was already stored for this audit."),
    },
  },
] satisfies ReadonlyArray<ViewDefinition>);
