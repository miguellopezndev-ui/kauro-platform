-- Order 20 (stage A, built against the O19A re-issue candidate; activation OFF by default in the api): "Clean your data" (CLEAN) runs the
-- free check, plan, approval and quote with no target contract (CP-01.01, CP-02.01). The api takes the CLEAN branch only when its
-- candidate activation is switched on (KAURO_CANDIDATE_CLEAN_NO_TARGET, LOCAL only until Order 19B adopts the candidate); this migration only
-- lets the database hold that shape, and only for a CLEAN project with the one canonical CLEAN hash:
--   (a) kauro.clean_only_target_hash(): the KAURO_PLAN_BODY_V1 structured digest of {"cleanOnlyTarget":true}, the hash the Intelligence
--       adapter's plan compiler binds for a CLEAN_ONLY draft (packages/domain CLEAN_ONLY_TARGET_HASH; apps/api o20-clean-candidate proves they agree);
--   (b) audits: target_contract_id may be NULL for exactly that shape (audits_clean_binding); the composite target foreign key is MATCH SIMPLE
--       and so skips a NULL id; one CLEAN audit per (agency, revision) for good, as audits_one_per_subject is for a target; the workflow guard
--       awaits and reads no target for a CLEAN audit and refuses a NULL target on any other project;
--   (c) plans: the target foreign key moves to a generated column that is NULL for the CLEAN hash (so a CRM plan keeps its foreign key, and a
--       CLEAN plan needs no target row), and plans_clean_binding refuses the CLEAN hash unless the project has a CLEAN audit (one with no target, which (b)
--       admits on a CLEAN project only; the project mode is immutable): read through audits, which both writers of a plan (kauro_app,
--       kauro_control) may read, never through projects. Approvals, validations,
--       receipts and quotes bind the plan's hash through their existing foreign keys to the plan; nothing else changes.
-- Nothing here creates a target row, an artificial CRM target or a default: a CRM project without a confirmed, current target is refused as before.

-- --- (a) the canonical CLEAN hash ----------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.clean_only_target_hash() RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT '4967d6b115867326fe46014b17e2ec50ae55b85fd31681eec57aab0c00658492'::text $$;
REVOKE EXECUTE ON FUNCTION kauro.clean_only_target_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.clean_only_target_hash() TO kauro_app, kauro_control;

-- --- (b) audits --------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.audits ALTER COLUMN target_contract_id DROP NOT NULL;
ALTER TABLE kauro.audits ADD CONSTRAINT audits_clean_binding
  CHECK (target_contract_id IS NOT NULL OR target_contract_hash = '4967d6b115867326fe46014b17e2ec50ae55b85fd31681eec57aab0c00658492');
CREATE UNIQUE INDEX audits_one_clean_per_revision ON kauro.audits (agency_id, revision_id) WHERE target_contract_id IS NULL;

CREATE OR REPLACE FUNCTION kauro.audits_workflow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
  g record;
  s record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- the sealed revision and the confirmed, current target after their shared transition locks (B06 D-TX-2): a supersession or an
    -- expiry in flight is ordered before the audit (and read) or after it (and then cancels it through EXECUTION_CONTROL)
    PERFORM kauro.await_transition('kauro.dataset_revisions', NEW.revision_id::text);
    -- O20: a CLEAN audit names no target contract and binds the canonical CLEAN hash (audits_clean_binding); it awaits and reads no target
    IF NEW.target_contract_id IS NOT NULL THEN
      PERFORM kauro.await_transition('kauro.target_contracts', NEW.target_contract_id::text);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.revision_id = NEW.revision_id AND r.state = 'SEALED') THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: revision % is not SEALED and is audited by nobody', NEW.revision_id USING ERRCODE = 'KA081';
    END IF;
    IF NEW.target_contract_id IS NULL THEN
      IF NEW.target_contract_hash IS DISTINCT FROM kauro.clean_only_target_hash()
         OR NOT EXISTS (SELECT 1 FROM kauro.projects p WHERE p.agency_id = NEW.agency_id AND p.project_id = NEW.project_id AND p.mode = 'CLEAN') THEN
        RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % names no target contract, which only a CLEAN project with the canonical CLEAN hash may', NEW.audit_id USING ERRCODE = 'KA081';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM kauro.target_contracts t
       WHERE t.agency_id = NEW.agency_id AND t.contract_id = NEW.target_contract_id AND t.confirmed_at IS NOT NULL AND t.superseded_at IS NULL
    ) THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: target contract % is not confirmed and current', NEW.target_contract_id USING ERRCODE = 'KA081';
    END IF;
    -- R2-044: the audit is funded by an AUTHORIZED, unexpired AUDIT grant of its agency — whose ceiling its pool holds since its
    -- authorization — with room under its ceiling; sealing funds nothing (D8-GRANT-1)
    SELECT c.grant_kind, c.state, c.expires_at, c.ceiling_cents, c.reserved_cents, c.reconciled_spend_cents INTO g
      FROM kauro.cost_grants c WHERE c.agency_id = NEW.agency_id AND c.grant_id = NEW.grant_id;
    IF NOT FOUND OR g.grant_kind <> 'AUDIT' OR g.state <> 'AUTHORIZED' OR g.expires_at <= clock
       OR g.reserved_cents + g.reconciled_spend_cents >= g.ceiling_cents THEN
      RAISE EXCEPTION 'NO_FUNDED_GRANT: audit % commits only with a reservation on an AUTHORIZED, unexpired grant with room under its ceiling', NEW.audit_id USING ERRCODE = 'KA083';
    END IF;
    IF NEW.version <> 1 OR NEW.fence <> 0 OR NEW.cancel_version <> 0 OR NEW.cancel_actor_kind IS NOT NULL OR NEW.profile_evidence_hash IS NOT NULL
       OR NEW.candidate_manifest_hash IS NOT NULL OR NEW.draft_plan_id IS NOT NULL OR NEW.terminal_reason IS NOT NULL OR jsonb_array_length(NEW.finding_codes) <> 0 THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is born QUEUED at version 1 with nothing claimed or recorded', NEW.audit_id USING ERRCODE = 'KA081';
    END IF;
    NEW.started_at := clock;
    NEW.absolute_deadline_at := clock + interval '86400 seconds';
    NEW.interpretation_deadline_at := NULL;
    NEW.profiling_at := NULL; NEW.interpreting_at := NULL; NEW.validating_at := NULL; NEW.terminal_at := NULL;
    NEW.created_at := clock;
    NEW.updated_at := clock;
    RETURN NEW;
  END IF;

  NEW.updated_at := clock;
  IF NEW.fence IS DISTINCT FROM OLD.fence AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % takes its fence through its steps only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;
  -- the cancellation version moves exactly with cancellation_wins, by one (D8-CANCEL-1)
  IF NEW.state = 'CANCELLED' AND OLD.state IS DISTINCT FROM 'CANCELLED' THEN
    IF NEW.cancel_version <> OLD.cancel_version + 1 OR NEW.cancel_actor_kind IS NULL THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: cancellation_wins of audit % records its actor and cancel version %', OLD.audit_id, OLD.cancel_version + 1 USING ERRCODE = 'KA081';
    END IF;
  ELSIF NEW.cancel_version IS DISTINCT FROM OLD.cancel_version THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: the cancellation version of audit % moves only with cancellation_wins', OLD.audit_id USING ERRCODE = 'KA081';
  END IF;
  -- what an edge records is recorded with that edge only
  IF (NEW.profile_evidence_hash IS DISTINCT FROM OLD.profile_evidence_hash OR NEW.candidate_manifest_hash IS DISTINCT FROM OLD.candidate_manifest_hash
      OR NEW.interpretation_deadline_at IS DISTINCT FROM OLD.interpretation_deadline_at)
     AND NOT (OLD.state = 'PROFILING' AND NEW.state = 'INTERPRETING') THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % records its profile evidence with profile_and_candidates_complete only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.draft_plan_id IS DISTINCT FROM OLD.draft_plan_id AND NOT (OLD.state = 'VALIDATING' AND NEW.state = 'DRAFT_READY') THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % names its draft with DRAFT_READY only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF NEW.finding_codes IS DISTINCT FROM OLD.finding_codes AND NOT (NEW.state IN ('NEEDS_DECISION', 'UNSUPPORTED') AND OLD.state IS DISTINCT FROM NEW.state) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % records its findings with NEEDS_DECISION or UNSUPPORTED only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.finding_codes) f WHERE jsonb_typeof(f) <> 'string' OR NOT kauro.is_token(f #>> '{}')) THEN
    RAISE EXCEPTION 'AUDIT_FENCE: audit % names its findings as tokens only', OLD.audit_id USING ERRCODE = 'KA080';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state IN ('DRAFT_READY', 'NEEDS_DECISION', 'UNSUPPORTED', 'FAILED', 'CANCELLED', 'EXPIRED') THEN
      NEW.terminal_at := clock;
    END IF;
    IF NEW.state = 'EXPIRED' THEN
      -- absolute_deadline on the server clock, never early (D8-DL-1)
      IF clock < OLD.absolute_deadline_at THEN
        RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % reaches its absolute deadline no earlier than it', OLD.audit_id USING ERRCODE = 'KA081';
      END IF;
    ELSIF NEW.state <> 'CANCELLED' THEN
      -- every orchestration edge before the absolute deadline (D8-AUD-4), from the step of its kind under the audit's current fence
      IF clock >= OLD.absolute_deadline_at THEN
        RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % is past its absolute deadline; only absolute_deadline remains', OLD.audit_id USING ERRCODE = 'KA081';
      END IF;
      SELECT st.kind, st.outcome INTO s FROM kauro.audit_steps st WHERE st.agency_id = OLD.agency_id AND st.audit_id = OLD.audit_id AND st.fence = OLD.fence;
      IF NOT coalesce(
           (OLD.state = 'QUEUED' AND NEW.state = 'PROFILING' AND s.kind = 'PROFILE' AND s.outcome IS NULL)
        OR (OLD.state = 'PROFILING' AND s.kind = 'PROFILE' AND s.outcome = CASE NEW.state WHEN 'INTERPRETING' THEN 'COMPLETED' ELSE NEW.state END)
        OR (OLD.state = 'INTERPRETING' AND s.kind = 'INTERPRET' AND s.outcome = CASE NEW.state WHEN 'VALIDATING' THEN 'COMPILED' ELSE NEW.state END)
        OR (OLD.state = 'VALIDATING' AND s.kind = 'VALIDATE' AND s.outcome = CASE NEW.state WHEN 'DRAFT_READY' THEN 'VALID' ELSE NEW.state END),
        false
      ) THEN
        RAISE EXCEPTION 'AUDIT_FENCE: audit % moves % -> % only from the step recorded under its current fence %', OLD.audit_id, OLD.state, NEW.state, OLD.fence USING ERRCODE = 'KA080';
      END IF;
      IF NEW.state = 'PROFILING' THEN
        NEW.profiling_at := clock;
      ELSIF NEW.state = 'INTERPRETING' THEN
        IF NEW.profile_evidence_hash IS NULL OR NEW.candidate_manifest_hash IS NULL THEN
          RAISE EXCEPTION 'AUDIT_FENCE: audit % interprets only with its profile evidence and complete candidate manifest', OLD.audit_id USING ERRCODE = 'KA080';
        END IF;
        NEW.interpreting_at := clock;
        NEW.interpretation_deadline_at := least(clock + interval '1200 seconds', OLD.absolute_deadline_at);
      ELSIF NEW.state = 'VALIDATING' THEN
        NEW.validating_at := clock;
      END IF;
    END IF;
    IF (NEW.state IN ('FAILED', 'CANCELLED', 'EXPIRED')) <> (NEW.terminal_reason IS NOT NULL) THEN
      RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % names the reason of a failure, a cancellation or an expiry, and of nothing else', OLD.audit_id USING ERRCODE = 'KA081';
    END IF;
  ELSIF NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason THEN
    RAISE EXCEPTION 'AUDIT_AUTHORITY: audit % records its terminal reason with its terminal edge', OLD.audit_id USING ERRCODE = 'KA081';
  END IF;
  RETURN NEW;
END
$$;

-- --- (c) plans -------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.plans ADD COLUMN target_binding_hash text GENERATED ALWAYS AS (
  CASE WHEN target_contract_hash = '4967d6b115867326fe46014b17e2ec50ae55b85fd31681eec57aab0c00658492' THEN NULL ELSE target_contract_hash END
) STORED;
ALTER TABLE kauro.plans DROP CONSTRAINT plans_target_fk;
ALTER TABLE kauro.plans ADD CONSTRAINT plans_target_fk FOREIGN KEY (agency_id, project_id, target_binding_hash) REFERENCES kauro.target_contracts (agency_id, project_id, body_hash);

CREATE OR REPLACE FUNCTION kauro.plans_clean_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.target_contract_hash = kauro.clean_only_target_hash()
     AND NOT EXISTS (SELECT 1 FROM kauro.audits a WHERE a.agency_id = NEW.agency_id AND a.project_id = NEW.project_id AND a.target_contract_id IS NULL) THEN
    RAISE EXCEPTION 'TARGET_STALE: plan % binds the canonical CLEAN hash outside a CLEAN project', NEW.plan_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE EXECUTE ON FUNCTION kauro.plans_clean_binding() FROM PUBLIC;
CREATE TRIGGER plans_clean_binding BEFORE INSERT ON kauro.plans
  FOR EACH ROW EXECUTE FUNCTION kauro.plans_clean_binding();
