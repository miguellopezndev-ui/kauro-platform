-- Migration 0074: B15 lane L0D KIT-DB, the database half of CMD035 IssueTaxDocument, R2-083 and R2-084 (provisional number; the
-- coordinator renumbers on merge).
--
-- docs/design/B15-B17-B18-local-plan.md section 3 (fiscal pairs M15-M21), section 4 (CMD035 intent and conclude rows), section 5 M6:
--   1. The issuer's transition half covers every column CMD035 judges (r22: the exact disjunction of OLD.c IS DISTINCT FROM NEW.c over
--      route_state, legal_fact_status, numbering_authorization_ref, entitlement_evidence_hash, qualification_evidence_hashes, valid_from
--      and valid_until), so a CMD035 holding the issuer's shared half is ordered with each of those writers (M17).
--   2. tax_documents.state is a transition subject: every state change takes the document's exclusive half (M15, M19-M21).
--   3. submit_deadline_at (stamped by the intent: kauro.effect_now() + window), fiscal_status (ACCEPTED, ACCEPTED_WITH_OBSERVATIONS),
--      verification_ref and bridge_action_ref (MANUAL_BRIDGE ACTION_PREPARED) are learned once; an issued document carries its fiscal
--      acceptance and its verification reference (R2 15:139 "A provider PDF existing does not prove DIAN acceptance").
--   4. The SUBMITTING backstop (VALIDATED -> SUBMITTING), after the profile and issuer shared halves, judged at kauro.effect_now():
--      the route gate of R2-083 (a PROVIDER_API issuer QUALIFIED with entitlement evidence, or a MANUAL_BRIDGE issuer) and the validity
--      of section 2 (issuer valid_from known and reached, valid_until not reached). 23514. The profile is the sale's version, bound at
--      VALIDATED by 0017 tax_documents_validation_guard at the tax point (saleProfileAt, B09-N5: a version recorded later never
--      unbinds it), so the backstop takes the profile half as the serializer and does not re-judge the version at the effect instant.
--   5. The FISCAL consumer receives tax_document.submitting.v1 and tax_document.issued.v1 (the reconciler and the credit-note
--      validation of M6; tax_document.uncertain.v1 is 0013's); @kauro/domain COMMERCE_EVENT_SUBSCRIPTIONS carries the same rows.

-- --- 1. the issuer's half covers every judged column -------------------------------------------------------------------------------------
DROP TRIGGER fiscal_issuers_transition_lock ON kauro.fiscal_issuers;
CREATE TRIGGER fiscal_issuers_transition_lock
  BEFORE UPDATE OF route_state, legal_fact_status, numbering_authorization_ref, entitlement_evidence_hash, qualification_evidence_hashes, valid_from, valid_until
  ON kauro.fiscal_issuers
  FOR EACH ROW WHEN (
    OLD.route_state IS DISTINCT FROM NEW.route_state
    OR OLD.legal_fact_status IS DISTINCT FROM NEW.legal_fact_status
    OR OLD.numbering_authorization_ref IS DISTINCT FROM NEW.numbering_authorization_ref
    OR OLD.entitlement_evidence_hash IS DISTINCT FROM NEW.entitlement_evidence_hash
    OR OLD.qualification_evidence_hashes IS DISTINCT FROM NEW.qualification_evidence_hashes
    OR OLD.valid_from IS DISTINCT FROM NEW.valid_from
    OR OLD.valid_until IS DISTINCT FROM NEW.valid_until
  )
  EXECUTE FUNCTION kauro.take_transition_lock('kauro.fiscal_issuers', 'issuer_ref');

-- --- 2. the document's state is a transition subject -------------------------------------------------------------------------------------
CREATE TRIGGER tax_documents_transition_lock BEFORE UPDATE OF state ON kauro.tax_documents
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION kauro.take_transition_lock('kauro.tax_documents', 'document_id');

-- --- 3. the issuance facts -------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.tax_documents
  ADD COLUMN submit_deadline_at timestamptz,
  ADD COLUMN fiscal_status text CHECK (fiscal_status IS NULL OR fiscal_status IN ('ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS')),
  ADD COLUMN verification_ref text CHECK (verification_ref IS NULL OR kauro.is_provider_ref(verification_ref)),
  ADD COLUMN bridge_action_ref text CHECK (bridge_action_ref IS NULL OR kauro.is_provider_ref(bridge_action_ref)),
  ADD CONSTRAINT tax_documents_issued_accepted CHECK (issued_at IS NULL OR (fiscal_status IS NOT NULL AND verification_ref IS NOT NULL)),
  ADD CONSTRAINT tax_documents_acceptance_only_issued CHECK ((fiscal_status IS NULL AND verification_ref IS NULL) OR issued_at IS NOT NULL),
  ADD CONSTRAINT tax_documents_deadline_after_intent CHECK (submit_deadline_at IS NULL OR state NOT IN ('DRAFT', 'VALIDATED'));
CREATE TRIGGER tax_documents_issuance_learned_once BEFORE UPDATE ON kauro.tax_documents
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('submit_deadline_at,fiscal_status,verification_ref,bridge_action_ref');

-- --- 4. the SUBMITTING backstop --------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.tax_documents_submitting_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  i record;
  t timestamptz;
BEGIN
  PERFORM kauro.await_transition('kauro.fiscal_profiles', NEW.agency_id::text);
  PERFORM kauro.await_transition('kauro.fiscal_issuers', NEW.issuer_ref::text);
  SELECT x.route_kind, x.route_state, x.entitlement_evidence_hash, x.valid_from, x.valid_until INTO i
    FROM kauro.fiscal_issuers x WHERE x.issuer_ref = NEW.issuer_ref;
  t := kauro.effect_now();
  IF i.route_kind IS NULL
     OR NOT ((i.route_kind = 'PROVIDER_API' AND i.route_state = 'QUALIFIED' AND i.entitlement_evidence_hash IS NOT NULL) OR i.route_kind = 'MANUAL_BRIDGE') THEN
    RAISE EXCEPTION 'FISCAL_PROVIDER_ENTITLEMENT_UNVERIFIED: issuer % has no qualified, entitled route', NEW.issuer_ref USING ERRCODE = '23514';
  END IF;
  IF i.valid_from IS NULL OR i.valid_from > t OR (i.valid_until IS NOT NULL AND t >= i.valid_until) THEN
    RAISE EXCEPTION 'FISCAL_ISSUER_NOT_IN_FORCE: issuer % is not in force', NEW.issuer_ref USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tax_documents_submitting_guard BEFORE UPDATE OF state ON kauro.tax_documents
  FOR EACH ROW WHEN (OLD.state = 'VALIDATED' AND NEW.state = 'SUBMITTING') EXECUTE FUNCTION kauro.tax_documents_submitting_guard();

-- --- 5. FISCAL subscriptions -----------------------------------------------------------------------------------------------------------
-- FORCE lifted inside this migration's own transaction and restored before COMMIT (0022, 0028)
ALTER TABLE kauro.commerce_event_subscriptions NO FORCE ROW LEVEL SECURITY;
INSERT INTO kauro.commerce_event_subscriptions (event_type, consumer) VALUES
  ('tax_document.submitting.v1', 'FISCAL'),
  ('tax_document.issued.v1', 'FISCAL');
ALTER TABLE kauro.commerce_event_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE EXECUTE ON FUNCTION kauro.tax_documents_submitting_guard() FROM PUBLIC;
