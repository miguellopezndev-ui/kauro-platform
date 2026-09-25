-- 0004 — plan revisions, validation receipts, approvals.
--
-- Authority: 07 "Audit and plan states" (a PlanVersion is DRAFT, VALIDATION_REQUIRED, VALIDATING, VALIDATED, APPROVED,
-- SUPERSEDED or WITHDRAWN; edits create a new version; APPROVED requires a permitted actor with current assurance and exact
-- source/target/plan bindings; PlanApproval records actor identity, membership version, assurance evidence, approval time and
-- plan/source/target hashes; a later revocation does not rewrite the approval record), reference/HASHING_AND_ACCOUNTING_RULES
-- (Plan bodyHash excludes planId/version/state; the Approval hash covers the named bindings; withdrawal is a separate
-- authority event), registry contracts Plan, ValidationReceipt, Approval; registry machine Plan.
-- Decision D-PLAN-1: a plan revision is its own row (planId); RevisePlan inserts the successor and moves the predecessor to
-- SUPERSEDED; the successor names its predecessor (supersedes_plan_id) and the predecessor its successor.

-- --- plans -------------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.plans (
  plan_id                    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(plan_id)),
  agency_id                  uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                 uuid NOT NULL,
  version                    bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                      text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'VALIDATION_REQUIRED', 'VALIDATING', 'VALIDATED', 'APPROVED', 'SUPERSEDED', 'WITHDRAWN')),
  revision_hash              text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  target_contract_hash       text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  policy_hash                text NOT NULL CHECK (kauro.is_sha256_hex(policy_hash)),
  -- the closed semantic body (mappings, identities, transforms, relationships): legitimate variable closed-schema JSONB (07)
  body                       jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  body_hash                  text NOT NULL CHECK (kauro.is_sha256_hex(body_hash)),
  validation_receipt_hash    text CHECK (validation_receipt_hash IS NULL OR kauro.is_sha256_hex(validation_receipt_hash)),
  approval_id                uuid,
  supersedes_plan_id         uuid,
  superseded_by_plan_id      uuid,
  created_by_membership_id   uuid NOT NULL,
  created_at                 timestamptz NOT NULL,
  updated_at                 timestamptz NOT NULL,
  UNIQUE (agency_id, plan_id),
  -- binding targets for the approval foreign keys below: an approval can only name this plan with this exact body/source/target
  UNIQUE (agency_id, plan_id, body_hash, revision_hash, target_contract_hash),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, supersedes_plan_id) REFERENCES kauro.plans (agency_id, plan_id),
  -- the successor link is checked at commit: RevisePlan compare-and-swaps the predecessor first (the serialization point of
  -- S051) and inserts the successor afterwards in the same transaction
  FOREIGN KEY (agency_id, superseded_by_plan_id) REFERENCES kauro.plans (agency_id, plan_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT plans_validated_bind_receipt CHECK (state NOT IN ('VALIDATED', 'APPROVED') OR validation_receipt_hash IS NOT NULL),
  CONSTRAINT plans_approved_bind_approval CHECK (state <> 'APPROVED' OR approval_id IS NOT NULL),
  CONSTRAINT plans_approval_only_after_approval CHECK (approval_id IS NULL OR state IN ('APPROVED', 'WITHDRAWN', 'SUPERSEDED')),
  CONSTRAINT plans_superseded_names_successor CHECK ((state = 'SUPERSEDED') = (superseded_by_plan_id IS NOT NULL)),
  CONSTRAINT plans_no_self_lineage CHECK (supersedes_plan_id IS DISTINCT FROM plan_id AND superseded_by_plan_id IS DISTINCT FROM plan_id)
);
-- a predecessor is superseded by exactly one successor (two racing RevisePlan calls cannot both attach)
CREATE UNIQUE INDEX plans_supersedes_once ON kauro.plans (agency_id, supersedes_plan_id) WHERE supersedes_plan_id IS NOT NULL;
CREATE INDEX plans_by_project ON kauro.plans (agency_id, project_id, created_at, plan_id);
CREATE TRIGGER plans_touch BEFORE UPDATE ON kauro.plans FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER plans_version BEFORE UPDATE ON kauro.plans FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
-- semantic content is immutable: a new decision is a new revision (07: "Edits create a new version")
CREATE TRIGGER plans_immutable BEFORE UPDATE ON kauro.plans
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('plan_id,agency_id,project_id,revision_hash,target_contract_hash,policy_hash,body,body_hash,supersedes_plan_id,created_by_membership_id,created_at');
CREATE TRIGGER plans_transition BEFORE UPDATE OF state ON kauro.plans
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Plan');
CREATE TRIGGER plans_initial_state BEFORE INSERT ON kauro.plans
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Plan');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Plan', 'DRAFT');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Plan', 'DRAFT', 'VALIDATION_REQUIRED'),
  ('Plan', 'VALIDATION_REQUIRED', 'VALIDATING'),
  ('Plan', 'VALIDATING', 'VALIDATED'),
  ('Plan', 'VALIDATING', 'VALIDATION_REQUIRED'),
  ('Plan', 'VALIDATED', 'APPROVED'),
  ('Plan', 'DRAFT', 'SUPERSEDED'),
  ('Plan', 'VALIDATION_REQUIRED', 'SUPERSEDED'),
  ('Plan', 'VALIDATED', 'SUPERSEDED'),
  ('Plan', 'APPROVED', 'SUPERSEDED'),
  ('Plan', 'APPROVED', 'WITHDRAWN'),
  ('Plan', 'VALIDATED', 'WITHDRAWN');

-- --- validation receipts (immutable evidence produced by the independent validator, bound here) ---------------------------------
-- Registry ValidationReceipt: producer "MC validator", consumer "IC/domain/verifier"; "All bindings and evidence digests are
-- required, internally consistent and independently checked". 06 "Migration validation and final states": a separate authorized
-- finalizer checks the real Migration receipt. The receipt is therefore written only by the validator role (kauro_validator,
-- under the tenant context of the plan it validated); the request handlers read receipts and can never mint one, so no request
-- path can manufacture the VALID evidence that VALIDATED and APPROVED depend on. (Which component runs the validation and
-- applies the VALIDATING -> VALIDATED edge is CMD024 ValidatePlan, package B01, and the audit/validation orchestration of B08.)
CREATE TABLE kauro.validation_receipts (
  receipt_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(receipt_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  plan_id                     uuid NOT NULL,
  receipt_hash                text NOT NULL CHECK (kauro.is_sha256_hex(receipt_hash)),
  revision_hash               text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  target_contract_hash        text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  plan_hash                   text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  core_package_hash           text NOT NULL CHECK (kauro.is_sha256_hex(core_package_hash)),
  profile_evidence_hash       text NOT NULL CHECK (kauro.is_sha256_hex(profile_evidence_hash)),
  disposition_evidence_hash   text NOT NULL CHECK (kauro.is_sha256_hex(disposition_evidence_hash)),
  artifact_evidence_hash      text NOT NULL CHECK (kauro.is_sha256_hex(artifact_evidence_hash)),
  started_at                  timestamptz NOT NULL,
  completed_at                timestamptz NOT NULL CHECK (completed_at >= started_at),
  result                      text NOT NULL CHECK (result IN ('VALID', 'INVALID', 'CANCELLED', 'ERROR')),
  counts                      jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
  blocking_issue_codes        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocking_issue_codes) = 'array'),
  created_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, receipt_hash),
  -- binding target for approvals: the receipt must be for this plan with these exact subjects
  UNIQUE (agency_id, plan_id, receipt_hash, plan_hash, revision_hash, target_contract_hash),
  -- a receipt is for a plan body that exists with exactly these subjects (a receipt for different inputs cannot attach)
  FOREIGN KEY (agency_id, plan_id, plan_hash, revision_hash, target_contract_hash)
    REFERENCES kauro.plans (agency_id, plan_id, body_hash, revision_hash, target_contract_hash),
  CONSTRAINT validation_receipts_valid_has_no_blockers CHECK (result <> 'VALID' OR jsonb_array_length(blocking_issue_codes) = 0)
);
CREATE TRIGGER validation_receipts_append_only BEFORE UPDATE OR DELETE ON kauro.validation_receipts
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- The plan binds its current receipt (VALIDATED/APPROVED): a receipt of this very plan with exactly this body, source and
-- target (08 "Foreign keys bind tenant and parent identity"; D-PLAN-2). A receipt of another plan, or of other subjects,
-- cannot be named even when it exists in the same agency. The key is immediate: the plan row exists before its receipt (the
-- receipt references the plan) and the plan names the receipt only afterwards, so neither row ever waits for the other.
ALTER TABLE kauro.plans ADD CONSTRAINT plans_receipt_fk
  FOREIGN KEY (agency_id, plan_id, validation_receipt_hash, body_hash, revision_hash, target_contract_hash)
  REFERENCES kauro.validation_receipts (agency_id, plan_id, receipt_hash, plan_hash, revision_hash, target_contract_hash);

-- VALIDATED requires the complete Migration receipt (07 "Audit and plan states"; Plan machine VALIDATING -> VALIDATED is the
-- event valid_receipt: "Complete receipt and current subject/deadline/cancellation checks pass"). The key above binds the
-- receipt's identity; this guard binds its result: the receipt a plan names is VALID (and a VALID receipt carries no blocking
-- issue, validation_receipts_valid_has_no_blockers). An INVALID, CANCELLED or ERROR receipt keeps its findings on its own row
-- and never becomes the plan's binding — naming one is not the listed edge. A hash that names no receipt of this plan is left
-- to the foreign key (23503).
CREATE OR REPLACE FUNCTION kauro.plans_bind_valid_receipt() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.validation_receipt_hash IS NOT NULL AND EXISTS (
    SELECT 1 FROM kauro.validation_receipts r
    WHERE r.agency_id = NEW.agency_id AND r.plan_id = NEW.plan_id AND r.receipt_hash = NEW.validation_receipt_hash AND r.result <> 'VALID'
  ) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: plan % may bind only a VALID receipt of its own subjects', NEW.plan_id USING ERRCODE = 'KA008';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plans_bind_valid_receipt BEFORE UPDATE OF validation_receipt_hash ON kauro.plans
  FOR EACH ROW EXECUTE FUNCTION kauro.plans_bind_valid_receipt();

-- --- approvals (immutable except the single withdrawal) ---------------------------------------------------------------------------------
CREATE TABLE kauro.approvals (
  approval_id                 uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(approval_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  plan_id                     uuid NOT NULL,
  version                     bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  actor_id                    uuid NOT NULL REFERENCES kauro.identities (user_id),
  actor_membership_id         uuid NOT NULL,
  actor_membership_version    bigint NOT NULL CHECK (actor_membership_version >= 1),
  assurance_proof_ref         uuid NOT NULL,
  plan_hash                   text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  revision_hash               text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  target_contract_hash        text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  validation_receipt_hash     text NOT NULL CHECK (kauro.is_sha256_hex(validation_receipt_hash)),
  disclosures_hash            text NOT NULL CHECK (kauro.is_sha256_hex(disclosures_hash)),
  approval_hash               text NOT NULL CHECK (kauro.is_sha256_hex(approval_hash)),
  created_at                  timestamptz NOT NULL,
  withdrawn_at                timestamptz,
  withdrawn_by_membership_id  uuid,
  withdraw_reason_code        text CHECK (withdraw_reason_code IS NULL OR kauro.is_token(withdraw_reason_code)),
  updated_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, approval_id),
  UNIQUE (agency_id, approval_hash),
  -- binding target of plans_approval_fk: a plan names an approval of itself, never another plan's
  UNIQUE (agency_id, approval_id, plan_id),
  FOREIGN KEY (agency_id, plan_id) REFERENCES kauro.plans (agency_id, plan_id),
  -- 07 "PlanApproval records actor identity, membership version, assurance evidence": the three are one binding. The acting
  -- membership is the actor's own membership in this agency, and the step-up proof is a proof of that same actor
  -- (08 "Foreign keys bind tenant and parent identity"; a key check ignores the self-only policy on proofs, so a single-column
  -- key would let an approval cite, and probe, another person's proof)
  CONSTRAINT approvals_actor_membership_fk
    FOREIGN KEY (agency_id, actor_membership_id, actor_id) REFERENCES kauro.memberships (agency_id, membership_id, user_id),
  CONSTRAINT approvals_actor_proof_fk
    FOREIGN KEY (actor_id, assurance_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id),
  FOREIGN KEY (agency_id, withdrawn_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  -- exact bindings (CMD025 effect: "immutable approval for exact plan/source/target/disclosures"): the approved hashes must be
  -- the plan's own body/source/target, and the receipt must be a receipt of that same plan and subjects
  FOREIGN KEY (agency_id, plan_id, plan_hash, revision_hash, target_contract_hash)
    REFERENCES kauro.plans (agency_id, plan_id, body_hash, revision_hash, target_contract_hash),
  FOREIGN KEY (agency_id, plan_id, validation_receipt_hash, plan_hash, revision_hash, target_contract_hash)
    REFERENCES kauro.validation_receipts (agency_id, plan_id, receipt_hash, plan_hash, revision_hash, target_contract_hash),
  CONSTRAINT approvals_withdrawal_complete CHECK (
    (withdrawn_at IS NULL) = (withdrawn_by_membership_id IS NULL) AND (withdrawn_at IS NULL) = (withdraw_reason_code IS NULL)
  )
);
-- at most one live approval per plan: two racing ApprovePlan calls cannot both create authority (CMD025-RACE)
CREATE UNIQUE INDEX approvals_one_live_per_plan ON kauro.approvals (agency_id, plan_id) WHERE withdrawn_at IS NULL;
CREATE TRIGGER approvals_touch BEFORE UPDATE ON kauro.approvals FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER approvals_version BEFORE UPDATE ON kauro.approvals FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER approvals_immutable BEFORE UPDATE ON kauro.approvals
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('approval_id,agency_id,plan_id,actor_id,actor_membership_id,actor_membership_version,assurance_proof_ref,plan_hash,revision_hash,target_contract_hash,validation_receipt_hash,disclosures_hash,approval_hash,created_at');

-- withdrawal happens once and is never undone (CMD026 failure text: do not delete history)
CREATE OR REPLACE FUNCTION kauro.approvals_withdraw_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.withdrawn_at IS NOT NULL AND (
       NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
    OR NEW.withdrawn_by_membership_id IS DISTINCT FROM OLD.withdrawn_by_membership_id
    OR NEW.withdraw_reason_code IS DISTINCT FROM OLD.withdraw_reason_code) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: approval % withdrawal cannot change once recorded', OLD.approval_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER approvals_withdraw_once BEFORE UPDATE ON kauro.approvals FOR EACH ROW EXECUTE FUNCTION kauro.approvals_withdraw_once();

-- The plan names its own approval: an approval whose plan_id is this plan (the approval in turn binds this plan's exact
-- body/source/target through its own keys), never another plan's approval of different content (CMD025 effect "immutable
-- approval for exact plan/source/target/disclosures"; D-PLAN-2). The two rows reference each other, so the key is checked at
-- commit and the approval and the plan transition can be written in either order.
ALTER TABLE kauro.plans ADD CONSTRAINT plans_approval_fk
  FOREIGN KEY (agency_id, approval_id, plan_id) REFERENCES kauro.approvals (agency_id, approval_id, plan_id) DEFERRABLE INITIALLY DEFERRED;

-- --- row-level security ---------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.plans FORCE ROW LEVEL SECURITY;
CREATE POLICY plans_tenant ON kauro.plans FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.validation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.validation_receipts FORCE ROW LEVEL SECURITY;
-- request handlers read their tenant's receipts; the validator records a receipt under the tenant context of the plan it
-- validated and reads nothing
CREATE POLICY validation_receipts_tenant_read ON kauro.validation_receipts FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY validation_receipts_validator ON kauro.validation_receipts FOR INSERT TO kauro_validator
  WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY approvals_tenant ON kauro.approvals FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

-- --- grants -------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON kauro.plans, kauro.approvals TO kauro_app;
GRANT SELECT ON kauro.validation_receipts TO kauro_app;
GRANT INSERT ON kauro.validation_receipts TO kauro_validator;
