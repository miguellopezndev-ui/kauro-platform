-- Migration 0135: Order 27A, the database half of the pending-payment hold of CP-01.11 (status CONDITIONAL; activation blocked by PV1).
--
-- The rules live in @kauro/domain o27a-pending-hold.ts; this table is the abuse control CP-01.11 asks to be held by the database itself
-- ("hold uniqueness in the database and the owner review from the third hold ended unpaid in 90 days", pending point C10):
--   1. one hold per quote and one per sealed set (the dataset revision the quote prices), ever: never renewable, whatever its state;
--   2. the proof matches the quote: route ACH, USD, the quote's exact total; the sealed set is the quote's own sealed revision, with its
--      recorded seal instant; a step-up proof is named;
--   3. the dates: the ceiling is exactly 576 hours after the seal; the effective end is never after the ceiling nor before acceptance;
--   4. the third hold: a hold granted while the agency already has two holds ended unpaid in the rolling 90 days before the server's
--      clock names the owner's review, or it is refused;
--   5. a hold is never a payment and never authorizes execution (constant columns, checked); its acceptance is stamped by the server;
--      it changes only ACTIVE -> PAID or ACTIVE -> ENDED_UNPAID, once, at the server's clock; it is never deleted.
--
-- ACTIVATION OFF: no runtime role may write the table. kauro_app and kauro_control may only read under row security (the agency its own
-- holds, the corporate owner all of them). The order that activates CP-01.11 (after O19B adopts CP-02.17 and PV1 holds) adds the write
-- grant and policy; until then nothing in the platform can create a hold.

CREATE TABLE IF NOT EXISTS kauro.pending_payment_holds (
  hold_id                 uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(hold_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  quote_id                uuid NOT NULL,
  project_id              uuid NOT NULL,
  sealed_revision_id      uuid NOT NULL,
  sealed_at               timestamptz NOT NULL,
  route                   text NOT NULL CHECK (route = 'ACH'),
  proof_currency          text NOT NULL CHECK (proof_currency = 'USD'),
  proof_amount_cents      bigint NOT NULL CHECK (kauro.is_money(proof_amount_cents) AND proof_amount_cents > 0),
  proof_reference         text NOT NULL CHECK (kauro.is_label(proof_reference)),
  proof_sent_at           timestamptz NOT NULL,
  proof_evidence_hash     text NOT NULL CHECK (kauro.is_sha256_hex(proof_evidence_hash)),
  presented_by_user_id    uuid NOT NULL,
  step_up_proof_ref       uuid NOT NULL,
  accepted_at             timestamptz NOT NULL,
  calendar_version        text NOT NULL CHECK (kauro.is_label(calendar_version)),
  business_days_end_at    timestamptz NOT NULL,
  ceiling_at              timestamptz NOT NULL,
  effective_end_at        timestamptz NOT NULL,
  owner_review_ref        uuid,
  is_payment              boolean NOT NULL DEFAULT false CHECK (NOT is_payment),
  authorizes_execution    boolean NOT NULL DEFAULT false CHECK (NOT authorizes_execution),
  state                   text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'PAID', 'ENDED_UNPAID')),
  ended_at                timestamptz,
  version                 bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  CONSTRAINT pending_payment_holds_one_per_quote UNIQUE (quote_id),
  CONSTRAINT pending_payment_holds_one_per_sealed_set UNIQUE (agency_id, sealed_revision_id),
  CONSTRAINT pending_payment_holds_quote_fk FOREIGN KEY (agency_id, quote_id, project_id) REFERENCES kauro.quotes (agency_id, quote_id, project_id),
  CONSTRAINT pending_payment_holds_revision_fk FOREIGN KEY (agency_id, sealed_revision_id) REFERENCES kauro.dataset_revisions (agency_id, revision_id),
  CONSTRAINT pending_payment_holds_ceiling CHECK (ceiling_at = sealed_at + interval '576 hours'),
  CONSTRAINT pending_payment_holds_effective_end CHECK (effective_end_at <= ceiling_at AND effective_end_at > accepted_at AND business_days_end_at > accepted_at),
  CONSTRAINT pending_payment_holds_sent_before_acceptance CHECK (proof_sent_at <= accepted_at),
  CONSTRAINT pending_payment_holds_ended CHECK ((state = 'ACTIVE') = (ended_at IS NULL))
);
CREATE INDEX IF NOT EXISTS pending_payment_holds_ended_unpaid ON kauro.pending_payment_holds (agency_id, ended_at) WHERE state = 'ENDED_UNPAID';

-- the acceptance at the server's clock, the proof against the quote and its sealed revision, and the third-hold rule
CREATE OR REPLACE FUNCTION kauro.pending_payment_holds_admit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  q record;
  r record;
  prior integer;
BEGIN
  NEW.accepted_at := kauro.server_now();
  NEW.created_at := NEW.accepted_at;
  NEW.updated_at := NEW.accepted_at;
  NEW.state := 'ACTIVE';
  NEW.ended_at := NULL;
  NEW.version := 1;
  SELECT total_cents, currency, revision_hash, state INTO q FROM kauro.quotes WHERE agency_id = NEW.agency_id AND quote_id = NEW.quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PENDING_HOLD: quote % is not a quote of agency %', NEW.quote_id, NEW.agency_id USING ERRCODE = '23503';
  END IF;
  IF q.currency <> NEW.proof_currency OR q.total_cents <> NEW.proof_amount_cents THEN
    RAISE EXCEPTION 'PENDING_HOLD: the proof does not carry the quote''s exact amount and currency' USING ERRCODE = '23514';
  END IF;
  SELECT manifest_hash, state, sealed_at INTO r FROM kauro.dataset_revisions WHERE agency_id = NEW.agency_id AND revision_id = NEW.sealed_revision_id;
  IF NOT FOUND OR r.state NOT IN ('SEALED', 'SUPERSEDED') OR r.manifest_hash IS DISTINCT FROM q.revision_hash OR r.sealed_at IS DISTINCT FROM NEW.sealed_at THEN
    RAISE EXCEPTION 'PENDING_HOLD: the sealed set is not the quote''s own sealed revision at its recorded seal' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO prior FROM kauro.pending_payment_holds h
   WHERE h.agency_id = NEW.agency_id AND h.state = 'ENDED_UNPAID' AND h.ended_at > NEW.accepted_at - interval '90 days';
  IF prior >= 2 AND NEW.owner_review_ref IS NULL THEN
    RAISE EXCEPTION 'PENDING_HOLD: % holds ended unpaid in the rolling 90 days; this hold needs the owner''s review', prior USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.pending_payment_holds_admit() FROM PUBLIC;
DROP TRIGGER IF EXISTS pending_payment_holds_admit ON kauro.pending_payment_holds;
CREATE TRIGGER pending_payment_holds_admit BEFORE INSERT ON kauro.pending_payment_holds FOR EACH ROW EXECUTE FUNCTION kauro.pending_payment_holds_admit();

-- one ending, at the server's clock; nothing else ever changes
CREATE OR REPLACE FUNCTION kauro.pending_payment_holds_end() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.state <> 'ACTIVE' OR NEW.state NOT IN ('PAID', 'ENDED_UNPAID') THEN
    RAISE EXCEPTION 'PENDING_HOLD: a hold ends once, from ACTIVE to PAID or ENDED_UNPAID (% -> %)', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'ended_at', 'version', 'updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'ended_at', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'PENDING_HOLD: only the state of a hold changes' USING ERRCODE = '23514';
  END IF;
  NEW.ended_at := kauro.server_now();
  IF NEW.state = 'ENDED_UNPAID' AND NEW.ended_at < OLD.effective_end_at THEN
    RAISE EXCEPTION 'PENDING_HOLD: a hold ends unpaid only at its effective end' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := NEW.ended_at;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.pending_payment_holds_end() FROM PUBLIC;
DROP TRIGGER IF EXISTS pending_payment_holds_end ON kauro.pending_payment_holds;
CREATE TRIGGER pending_payment_holds_end BEFORE UPDATE ON kauro.pending_payment_holds FOR EACH ROW EXECUTE FUNCTION kauro.pending_payment_holds_end();
DROP TRIGGER IF EXISTS pending_payment_holds_no_delete ON kauro.pending_payment_holds;
CREATE TRIGGER pending_payment_holds_no_delete BEFORE DELETE ON kauro.pending_payment_holds FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS pending_payment_holds_no_truncate ON kauro.pending_payment_holds;
CREATE TRIGGER pending_payment_holds_no_truncate BEFORE TRUNCATE ON kauro.pending_payment_holds FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

ALTER TABLE kauro.pending_payment_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.pending_payment_holds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pending_payment_holds_tenant_read ON kauro.pending_payment_holds;
DROP POLICY IF EXISTS pending_payment_holds_owner_read ON kauro.pending_payment_holds;
CREATE POLICY pending_payment_holds_tenant_read ON kauro.pending_payment_holds FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY pending_payment_holds_owner_read ON kauro.pending_payment_holds FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
GRANT SELECT ON kauro.pending_payment_holds TO kauro_app;
-- no INSERT, UPDATE or DELETE grant to any runtime role: the activation is OFF (see the header)
