-- Migration 0073: B17 lane L0D KIT-DB, the database half of R2-026 target supersession, the plan-validation refusal reason (R2-018..022),
-- the vendor qualifications of S078 and the target-drift repair of the payments re-binding (M8) (provisional number; the coordinator
-- renumbers on merge).
--
-- docs/design/B15-B17-B18-local-plan.md section 2 D-R3-1 (a confirmed newer contract supersedes every confirmed, current contract of
-- its project; current(c) iff confirmed_at IS NOT NULL AND superseded_at IS NULL), section 5 M4 "DB birth" (a)-(e), M5, M8:
--   (a) a request session (kauro_app) creates a target contract only as a DRAFT: confirmed_at, superseded_at and the superseder are NULL
--       at birth (WorkspaceRepository.createDraft is the only product birth); a restrictive INSERT policy, so the oracle's fixtures keep
--       their confirmed rows;
--   (b) superseded_at and superseded_by_contract_id are learned once and together, on INSERT or UPDATE of either. superseded_at is the
--       database's instant; the superseded contract is confirmed; the superseder is another contract of the same agency, project, mode
--       and instance with a later observed_at, and it is confirmed in the same transaction (checked at COMMIT, deferred);
--   (c) target_contracts_one_current: at most one current contract per (agency, project);
--   (d) a plan is born only on a target that is not superseded, judged after the target's shared transition half (the BEFORE INSERT
--       guard awaits the half the confirmation's writer holds, 0003:262-264);
--   (e) plans.recheck_of_plan_id is learned at birth only: the re-checked plan is of the same project, its target is superseded by this
--       plan's target, and the body is the re-checked plan's body with only targetContractHash replaced.
-- Every guard raises 23514 (precedent 0050:15-32), except the RLS birth of (a) (42501, the policy).
-- plan_validations.refusal_reason: the importer-profile or digest reason of an ERROR settlement, learned once, only with result ERROR and
-- only in the settling UPDATE; the control plane (the PLAN_VALIDATION consumer) writes it.
-- vendor_qualifications: the independent acceptance evidence CMD058 resolves a capability version's qualification_evidence_hashes
-- against (R2 05:69, CMD058 precondition). Insert-only and immutable; no runtime role may insert one (D-12 produces them).
-- purchase_rebindings (M8): the reason TARGET_DRIFT_REPAIR re-binds a paid authorization to the replacement quote of a re-check plan
-- (REPAIR, no charge); the replaced authorization is revoked as TARGET_REPAIRED; the allowance ordinal is per reason, and the included
-- source replacements count only PRE_EXECUTION_SOURCE_REPLACEMENT rows.

-- --- (a) the request session's birth is a DRAFT ----------------------------------------------------------------------------------------
ALTER TABLE kauro.target_contracts
  ADD COLUMN superseded_by_contract_id uuid,
  ADD CONSTRAINT target_contracts_superseder_fk FOREIGN KEY (agency_id, superseded_by_contract_id)
    REFERENCES kauro.target_contracts (agency_id, contract_id),
  ADD CONSTRAINT target_contracts_supersession_whole CHECK ((superseded_at IS NULL) = (superseded_by_contract_id IS NULL)),
  ADD CONSTRAINT target_contracts_no_self_supersession CHECK (superseded_by_contract_id IS DISTINCT FROM contract_id);

CREATE POLICY target_contracts_tenant_birth_draft ON kauro.target_contracts AS RESTRICTIVE FOR INSERT TO kauro_app
  WITH CHECK (
    confirmed_at IS NULL AND confirmed_by_membership_id IS NULL AND confirmation_evidence_ref IS NULL
    AND superseded_at IS NULL AND superseded_by_contract_id IS NULL
  );

-- --- (b) supersession is learned once, together, with a confirmed later superseder -------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.target_contracts_supersession() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  sup record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.superseded_at IS NOT NULL OR OLD.superseded_by_contract_id IS NOT NULL THEN
      IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.superseded_by_contract_id IS DISTINCT FROM OLD.superseded_by_contract_id THEN
        RAISE EXCEPTION 'a target contract is superseded once' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.superseded_at IS NULL AND NEW.superseded_by_contract_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.superseded_at IS NULL OR NEW.superseded_by_contract_id IS NULL THEN
    RAISE EXCEPTION 'a supersession names its instant and its superseder together' USING ERRCODE = '23514';
  END IF;
  IF NEW.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'only a confirmed target contract is superseded' USING ERRCODE = '23514';
  END IF;
  SELECT t.project_id, t.mode, t.instance_id, t.observed_at INTO sup FROM kauro.target_contracts t
   WHERE t.agency_id = NEW.agency_id AND t.contract_id = NEW.superseded_by_contract_id;
  IF NOT FOUND OR sup.project_id IS DISTINCT FROM NEW.project_id OR sup.mode IS DISTINCT FROM NEW.mode
     OR sup.instance_id IS DISTINCT FROM NEW.instance_id OR NOT (sup.observed_at > NEW.observed_at) THEN
    RAISE EXCEPTION 'a target contract is superseded only by a later observation of the same agency, project, mode and instance' USING ERRCODE = '23514';
  END IF;
  NEW.superseded_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER target_contracts_supersession BEFORE INSERT OR UPDATE OF superseded_at, superseded_by_contract_id ON kauro.target_contracts
  FOR EACH ROW EXECUTE FUNCTION kauro.target_contracts_supersession();

-- at COMMIT: the superseder is confirmed, in this transaction (its confirmed_at is this transaction's server instant)
CREATE OR REPLACE FUNCTION kauro.target_contracts_superseder_confirmed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.superseded_by_contract_id IS NULL OR (TG_OP = 'UPDATE' AND OLD.superseded_by_contract_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.target_contracts t
     WHERE t.agency_id = NEW.agency_id AND t.contract_id = NEW.superseded_by_contract_id AND t.confirmed_at = kauro.server_now()
  ) THEN
    RAISE EXCEPTION 'target contract % is superseded only by a contract confirmed in the same transaction', NEW.contract_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER target_contracts_superseder_confirmed AFTER INSERT OR UPDATE OF superseded_by_contract_id ON kauro.target_contracts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.target_contracts_superseder_confirmed();

-- --- (c) one current contract per project ----------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX target_contracts_one_current ON kauro.target_contracts (agency_id, project_id)
  WHERE confirmed_at IS NOT NULL AND superseded_at IS NULL;

-- --- (d) a plan is born on a target that is not superseded -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.plans_target_not_superseded() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  target uuid;
  superseded timestamptz;
BEGIN
  SELECT t.contract_id INTO target FROM kauro.target_contracts t
   WHERE t.agency_id = NEW.agency_id AND t.project_id = NEW.project_id AND t.body_hash = NEW.target_contract_hash;
  IF target IS NULL THEN
    RETURN NEW; -- plans_target_fk refuses it
  END IF;
  PERFORM kauro.await_transition('kauro.target_contracts', target::text);
  SELECT t.superseded_at INTO superseded FROM kauro.target_contracts t WHERE t.agency_id = NEW.agency_id AND t.contract_id = target;
  IF superseded IS NOT NULL THEN
    RAISE EXCEPTION 'TARGET_STALE: plan % names target contract %, superseded', NEW.plan_id, target USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plans_target_not_superseded BEFORE INSERT ON kauro.plans
  FOR EACH ROW EXECUTE FUNCTION kauro.plans_target_not_superseded();

-- --- (e) the re-check plan of a superseded target ----------------------------------------------------------------------------------------
ALTER TABLE kauro.plans
  ADD COLUMN recheck_of_plan_id uuid,
  ADD CONSTRAINT plans_recheck_fk FOREIGN KEY (agency_id, recheck_of_plan_id) REFERENCES kauro.plans (agency_id, plan_id),
  ADD CONSTRAINT plans_no_self_recheck CHECK (recheck_of_plan_id IS DISTINCT FROM plan_id);
CREATE UNIQUE INDEX plans_recheck_once ON kauro.plans (agency_id, recheck_of_plan_id, target_contract_hash) WHERE recheck_of_plan_id IS NOT NULL;
CREATE TRIGGER plans_recheck_immutable BEFORE UPDATE ON kauro.plans
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('recheck_of_plan_id');

CREATE OR REPLACE FUNCTION kauro.plans_recheck_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  old_plan record;
  bound boolean;
BEGIN
  IF NEW.recheck_of_plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.project_id, p.target_contract_hash, p.body INTO old_plan FROM kauro.plans p
   WHERE p.agency_id = NEW.agency_id AND p.plan_id = NEW.recheck_of_plan_id;
  IF NOT FOUND OR old_plan.project_id IS DISTINCT FROM NEW.project_id THEN
    RAISE EXCEPTION 'a re-check plan re-checks a plan of its own project' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM kauro.target_contracts o JOIN kauro.target_contracts n
        ON n.agency_id = o.agency_id AND n.contract_id = o.superseded_by_contract_id
     WHERE o.agency_id = NEW.agency_id AND o.project_id = NEW.project_id AND o.body_hash = old_plan.target_contract_hash
       AND o.superseded_at IS NOT NULL AND n.project_id = NEW.project_id AND n.body_hash = NEW.target_contract_hash
  ) INTO bound;
  IF NOT bound THEN
    RAISE EXCEPTION 'a re-check plan names the contract that superseded the re-checked plan''s target' USING ERRCODE = '23514';
  END IF;
  IF (old_plan.body - 'targetContractHash') IS DISTINCT FROM (NEW.body - 'targetContractHash') THEN
    RAISE EXCEPTION 'a re-check plan carries the re-checked plan''s body with only targetContractHash replaced' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plans_recheck_birth BEFORE INSERT ON kauro.plans
  FOR EACH ROW EXECUTE FUNCTION kauro.plans_recheck_birth();
GRANT SELECT (recheck_of_plan_id) ON kauro.plans TO kauro_payment;

-- --- plan validation refusal reason ------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.plan_validations
  ADD COLUMN refusal_reason text CHECK (refusal_reason IS NULL OR kauro.is_token(refusal_reason)),
  ADD CONSTRAINT plan_validations_refusal_only_error CHECK (refusal_reason IS NULL OR result = 'ERROR');
CREATE OR REPLACE FUNCTION kauro.plan_validations_refusal_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.refusal_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a validation intent is born without a refusal reason' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.refusal_reason IS DISTINCT FROM OLD.refusal_reason AND (OLD.refusal_reason IS NOT NULL OR OLD.result IS NOT NULL) THEN
    RAISE EXCEPTION 'a refusal reason is learned once, in the settlement of its intent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plan_validations_refusal_once BEFORE INSERT OR UPDATE ON kauro.plan_validations
  FOR EACH ROW EXECUTE FUNCTION kauro.plan_validations_refusal_once();
GRANT UPDATE (refusal_reason) ON kauro.plan_validations TO kauro_control;

-- --- vendor qualifications (S078) --------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.vendor_qualifications (
  evidence_hash              text PRIMARY KEY CHECK (kauro.is_sha256_hex(evidence_hash)),
  capability_id              uuid NOT NULL REFERENCES kauro.capabilities (capability_id),
  tool                       text NOT NULL CHECK (kauro.is_label(tool)),
  profile_hash               text NOT NULL CHECK (kauro.is_sha256_hex(profile_hash)),
  -- the exact object/operation/importer/resource envelope the acceptance covered (CMD058 precondition)
  envelope                   jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  export_back_evidence_hash  text CHECK (export_back_evidence_hash IS NULL OR kauro.is_sha256_hex(export_back_evidence_hash)),
  result                     text NOT NULL CHECK (result IN ('PASS', 'FAIL')),
  recorded_at                timestamptz NOT NULL DEFAULT kauro.server_now()
);
CREATE TRIGGER vendor_qualifications_append_only BEFORE UPDATE OR DELETE ON kauro.vendor_qualifications
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER vendor_qualifications_no_truncate BEFORE TRUNCATE ON kauro.vendor_qualifications
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE OR REPLACE FUNCTION kauro.vendor_qualifications_stamp() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.recorded_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER vendor_qualifications_stamp BEFORE INSERT ON kauro.vendor_qualifications
  FOR EACH ROW EXECUTE FUNCTION kauro.vendor_qualifications_stamp();
ALTER TABLE kauro.vendor_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.vendor_qualifications FORCE ROW LEVEL SECURITY;
-- CMD058 runs in the corporate owner's OPERATOR session (0051); the control plane reads them too; nobody at runtime inserts one
CREATE POLICY vendor_qualifications_owner_read ON kauro.vendor_qualifications FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY vendor_qualifications_control_read ON kauro.vendor_qualifications FOR SELECT TO kauro_control USING (true);
GRANT SELECT ON kauro.vendor_qualifications TO kauro_app, kauro_control;

-- --- M8: the target-drift repair of a paid authorization ---------------------------------------------------------------------------------
-- KAURO_TARGET_REPAIR_V1: the lineage evidence of a drift repair is the platform digest of the replaced and the replacing target body
-- hashes, rawDigest(canonicalBytes({ domain: "KAURO_TARGET_REPAIR_V1", version: 1, payload: { oldBodyHash, newBodyHash } })) (both are
-- lowercase hex, so the canonical serialization below is exact).
CREATE OR REPLACE FUNCTION kauro.target_repair_lineage_hash(old_body_hash text, new_body_hash text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT encode(sha256(convert_to('{"domain":"KAURO_TARGET_REPAIR_V1","payload":{"newBodyHash":"' || new_body_hash || '","oldBodyHash":"' || old_body_hash || '"},"version":1}', 'UTF8')), 'hex') $$;

ALTER TABLE kauro.purchase_rebindings DROP CONSTRAINT purchase_rebindings_reason_code_check;
ALTER TABLE kauro.purchase_rebindings
  ADD CONSTRAINT purchase_rebindings_reason_code_check CHECK (reason_code IN ('PRE_EXECUTION_SOURCE_REPLACEMENT', 'TARGET_DRIFT_REPAIR'));
ALTER TABLE kauro.purchase_rebindings DROP CONSTRAINT purchase_rebindings_allowance_once;
ALTER TABLE kauro.purchase_rebindings
  ADD CONSTRAINT purchase_rebindings_allowance_once UNIQUE (agency_id, capture_id, reason_code, allowance_ordinal);

-- 0015's guard, with the reason branch: the common predicates (the replaced authorization ACTIVE under its exclusive half, the capture
-- intact and alone paying, no refund awaiting, the replacement an ISSUED replacement of the ACCEPTED_FOR_CHECKOUT quote) hold for both
-- reasons; a source replacement keeps 0015's allowance (counting only source replacements) and source lineage; a drift repair re-binds
-- only from a superseded target to the quote of the re-check plan of the paid plan, with the same revision, mode, band and terms, and
-- names the KAURO_TARGET_REPAIR_V1 lineage of the two target bodies.
CREATE OR REPLACE FUNCTION kauro.purchase_rebindings_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  f record;
  c record;
  o record;
  q_from record;
  q_to record;
  allowance integer;
  used integer;
  from_revision uuid;
  to_revision uuid;
  lineage boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.commercial_authorizations', NEW.from_authorization_id::text));
  PERFORM kauro.await_transition('kauro.capture_facts', NEW.capture_id::text);
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.capture_refunds', NEW.capture_id::text));
  SELECT a.state INTO f FROM kauro.commercial_authorizations a WHERE a.agency_id = NEW.agency_id AND a.authorization_id = NEW.from_authorization_id;
  IF f.state IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: authorization % is % (a replacement is included only before paid execution starts)', NEW.from_authorization_id, coalesce(f.state, 'not visible') USING ERRCODE = 'KP013';
  END IF;
  SELECT x.status, x.amount_cents, x.allocated_service_cents, x.allocated_tax_cents, x.excess_cents INTO c
    FROM kauro.capture_facts x WHERE x.agency_id = NEW.agency_id AND x.capture_id = NEW.capture_id;
  SELECT p.expected_amount_cents, p.expected_service_cents, p.expected_tax_cents INTO o
    FROM kauro.payment_orders p WHERE p.agency_id = NEW.agency_id AND p.order_id = NEW.order_id;
  IF c.status IS DISTINCT FROM 'COMPLETED' OR c.amount_cents <> o.expected_amount_cents OR c.excess_cents <> 0
     OR c.allocated_service_cents <> o.expected_service_cents OR c.allocated_tax_cents <> o.expected_tax_cents THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: capture % does not alone pay its purchase', NEW.capture_id USING ERRCODE = 'KP013';
  END IF;
  IF EXISTS (
    SELECT 1 FROM kauro.refunds r WHERE r.agency_id = NEW.agency_id AND r.capture_id = NEW.capture_id
       AND r.state IN ('REQUESTED', 'APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: a refund of capture % awaits review or commits; the purchase is not intact', NEW.capture_id USING ERRCODE = 'KP013';
  END IF;
  SELECT q.state, q.revision_hash, q.price_policy_version, q.plan_id, q.target_contract_hash, q.mode, q.base_service_cents, q.terms_hash INTO q_from
    FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.from_quote_id;
  SELECT q.state, q.revision_hash, q.replaces_quote_id, q.plan_id, q.target_contract_hash, q.mode, q.base_service_cents, q.terms_hash INTO q_to
    FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.to_quote_id;
  IF q_from.state IS DISTINCT FROM 'ACCEPTED_FOR_CHECKOUT' OR q_to.state IS DISTINCT FROM 'ISSUED' OR q_to.replaces_quote_id IS DISTINCT FROM NEW.from_quote_id THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: quote % is not an issued replacement of the paid quote %', NEW.to_quote_id, NEW.from_quote_id USING ERRCODE = 'KP013';
  END IF;
  IF NEW.reason_code = 'TARGET_DRIFT_REPAIR' THEN
    IF NOT EXISTS (
      SELECT 1 FROM kauro.target_contracts t
       WHERE t.agency_id = NEW.agency_id AND t.project_id = NEW.project_id AND t.body_hash = q_from.target_contract_hash AND t.superseded_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'REPLACEMENT_REFUSED: the paid quote''s target % is not superseded; a drift repair re-binds only from a superseded target', q_from.target_contract_hash USING ERRCODE = 'KP013';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.plans p WHERE p.agency_id = NEW.agency_id AND p.plan_id = q_to.plan_id AND p.recheck_of_plan_id = q_from.plan_id
    ) THEN
      RAISE EXCEPTION 'REPLACEMENT_REFUSED: quote % is not a quote of the re-check plan of the paid plan', NEW.to_quote_id USING ERRCODE = 'KP013';
    END IF;
    IF q_to.revision_hash IS DISTINCT FROM q_from.revision_hash OR q_to.mode IS DISTINCT FROM q_from.mode
       OR q_to.base_service_cents IS DISTINCT FROM q_from.base_service_cents OR q_to.terms_hash IS DISTINCT FROM q_from.terms_hash THEN
      RAISE EXCEPTION 'REPLACEMENT_REFUSED: a drift repair keeps the paid revision, mode, band and terms' USING ERRCODE = 'KP013';
    END IF;
    IF NEW.lineage_evidence_hash IS DISTINCT FROM kauro.target_repair_lineage_hash(q_from.target_contract_hash, q_to.target_contract_hash) THEN
      RAISE EXCEPTION 'REPLACEMENT_REFUSED: the lineage of a drift repair is KAURO_TARGET_REPAIR_V1 of the replaced and the replacing target bodies' USING ERRCODE = 'KP013';
    END IF;
    SELECT count(*) INTO used FROM kauro.purchase_rebindings b
     WHERE b.agency_id = NEW.agency_id AND b.capture_id = NEW.capture_id AND b.reason_code = 'TARGET_DRIFT_REPAIR';
    IF NEW.allowance_ordinal <> used + 1 THEN
      RAISE EXCEPTION 'REPLACEMENT_REFUSED: drift repair % of capture % takes the next ordinal %', NEW.rebinding_id, NEW.capture_id, used + 1 USING ERRCODE = 'KP013';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.pre_execution_replacements_included INTO allowance FROM kauro.price_policies p WHERE p.policy_version = q_from.price_policy_version;
  SELECT count(*) INTO used FROM kauro.purchase_rebindings b
   WHERE b.agency_id = NEW.agency_id AND b.capture_id = NEW.capture_id AND b.reason_code = 'PRE_EXECUTION_SOURCE_REPLACEMENT';
  IF allowance IS NULL OR used >= allowance OR NEW.allowance_ordinal <> used + 1 THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: capture % has used % of its % included source replacements', NEW.capture_id, used, coalesce(allowance, 0) USING ERRCODE = 'KP013';
  END IF;
  SELECT r.revision_id INTO from_revision FROM kauro.dataset_revisions r
   WHERE r.agency_id = NEW.agency_id AND r.project_id = NEW.project_id AND r.manifest_hash = q_from.revision_hash;
  SELECT r.revision_id INTO to_revision FROM kauro.dataset_revisions r
   WHERE r.agency_id = NEW.agency_id AND r.project_id = NEW.project_id AND r.manifest_hash = q_to.revision_hash AND r.state = 'SEALED';
  WITH RECURSIVE chain (revision_id, supersedes, depth) AS (
    SELECT r.revision_id, r.supersedes_revision_id, 0 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.revision_id = to_revision
    UNION ALL
    SELECT r.revision_id, r.supersedes_revision_id, chain.depth + 1
      FROM kauro.dataset_revisions r JOIN chain ON r.agency_id = NEW.agency_id AND r.revision_id = chain.supersedes
     WHERE chain.depth < 64
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE chain.revision_id = from_revision AND chain.depth > 0) INTO lineage;
  IF from_revision IS NULL OR to_revision IS NULL OR NOT lineage THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: the replacement source of quote % is not a sealed later revision of the replaced source', NEW.to_quote_id USING ERRCODE = 'KP013';
  END IF;
  RETURN NEW;
END
$$;

-- 0015's completeness check at COMMIT, with the reason's revocation code (SOURCE_REPLACED or TARGET_REPAIRED)
CREATE OR REPLACE FUNCTION kauro.purchase_rebindings_complete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM kauro.commercial_authorizations a
        WHERE a.agency_id = NEW.agency_id AND a.authorization_id = NEW.from_authorization_id AND a.state = 'REVOKED'
          AND a.revocation_code = CASE NEW.reason_code WHEN 'TARGET_DRIFT_REPAIR' THEN 'TARGET_REPAIRED' ELSE 'SOURCE_REPLACED' END)
     OR NOT EXISTS (
       SELECT 1 FROM kauro.quotes q
        WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.from_quote_id AND q.state = 'SUPERSEDED' AND q.superseded_by_quote_id = NEW.to_quote_id)
     OR NOT EXISTS (
       SELECT 1 FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.to_quote_id AND q.state = 'ACCEPTED_FOR_CHECKOUT')
     OR NOT EXISTS (
       SELECT 1 FROM kauro.commercial_authorizations a
        WHERE a.agency_id = NEW.agency_id AND a.rebinding_id = NEW.rebinding_id AND a.quote_id = NEW.to_quote_id AND a.capture_id = NEW.capture_id) THEN
    RAISE EXCEPTION 'REPLACEMENT_REFUSED: re-binding % is incomplete (revocation, supersession, acceptance and the replacement authorization commit together)', NEW.rebinding_id USING ERRCODE = 'KP013';
  END IF;
  RETURN NULL;
END
$$;
