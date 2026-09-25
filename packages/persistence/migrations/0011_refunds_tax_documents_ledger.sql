-- 0011 — refunds, tax documents, the operational ledger, settlements, reconciliation cases and provider event exceptions
-- (package B09).
--
-- Authority: 15 "Refund policy and calculation" (a customer request is not permission for an arbitrary provider transfer; a
-- partial refund names the service component and allocates tax consistently; the total refunded cannot exceed the confirmed
-- captured amount minus earlier refunds and relevant reversals; concurrent refund requests serialize that invariant; a refund
-- intent is durable before dispatch; a timeout is reconciled by provider refund identity), 15 "TaxDocument state machine" and
-- "FiscalProfile" (a timeout after issuance is reconciled before another document is created; duplicate fiscal invoices are
-- prevented by local unique references and provider observation; refunds create the legally appropriate credit document and
-- relationship to the original; original issued facts are not overwritten), 15 "Operational ledger" (every posting carries
-- event, source, amount/currency, effective and observed dates, policy version and reversal relationship; corrections add
-- reversing entries; deleting a row to fix a balance is prohibited; unexplained differences create a case with amount and age),
-- 15 "Settlement and withdrawal" (captured, held, withdrawn and bank-available funds are distinct), reference/HASHING_AND_
-- ACCOUNTING_RULES "Ledger posting and reconciliation" (each balanced transaction balances within its currency), registry
-- contracts Refund, TaxDocument, LedgerEntry, Settlement, registry machine TaxDocument. Decisions D-REF-B1..B5, D-FISC-B3..B5,
-- D-LEDGER-B1..B3, D-CASE-B1 in docs/design/B09-payments-fiscal.md.

ALTER TABLE kauro.fiscal_profiles ADD CONSTRAINT fiscal_profiles_binding_treatment UNIQUE (agency_id, profile_id, tax_treatment);

-- --- refunds (D-REF-B1..B5) ----------------------------------------------------------------------------------------------------------
-- A refund names one capture. The request (CMD031) records the purchased terms, the delivery phase and the server's proposal
-- of the refundable service/tax (visible, never self-approved); the approval (CMD032) records the authorized amounts and the
-- authorization — a fresh step-up of the approving owner or a standing policy that applies — as an immutable intent; execution
-- (CMD033) submits it once per reconciled provider identity. An excess capture (R2-140) is returned as its own refund whose
-- only component is the excess: it never reduces the service basis or needs a credit note.
CREATE TABLE kauro.refunds (
  refund_id                   uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(refund_id)),
  agency_id                   uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                  uuid NOT NULL,
  order_id                    uuid NOT NULL,
  capture_id                  uuid NOT NULL,
  version                     bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                       text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED', 'APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED', 'FAILED', 'REJECTED')),
  origin                      text NOT NULL CHECK (origin IN ('CUSTOMER_REQUEST', 'EXCESS_CAPTURE', 'KAURO_REMEDY')),
  reason_code                 text NOT NULL CHECK (kauro.is_token(reason_code)),
  -- the request: evidence, purchased terms, delivery phase at request time, the proposal shown for review
  evidence_ref                uuid,
  terms_hash                  text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  delivery_phase              text NOT NULL CHECK (delivery_phase IN ('PRE_EXECUTION', 'DURING_EXECUTION', 'POST_DELIVERY', 'NO_AUTHORIZATION')),
  proposed_service_cents      bigint NOT NULL CHECK (kauro.is_money(proposed_service_cents)),
  proposed_tax_cents          bigint NOT NULL CHECK (kauro.is_money(proposed_tax_cents)),
  proposed_excess_cents       bigint NOT NULL CHECK (kauro.is_money(proposed_excess_cents)),
  requested_by_membership_id  uuid,
  requested_at                timestamptz NOT NULL,
  -- the approval: the immutable refund intent (Refund.serviceCents, taxCents, authorizationHash)
  service_cents               bigint CHECK (service_cents IS NULL OR kauro.is_money(service_cents)),
  tax_cents                   bigint CHECK (tax_cents IS NULL OR kauro.is_money(tax_cents)),
  excess_cents                bigint CHECK (excess_cents IS NULL OR kauro.is_money(excess_cents)),
  authorization_kind          text CHECK (authorization_kind IS NULL OR authorization_kind IN ('OWNER_STEP_UP', 'STANDING_POLICY')),
  authorization_proof_ref     uuid REFERENCES kauro.assurance_proofs (proof_id),
  authorization_policy_id     uuid REFERENCES kauro.refund_policies (policy_id),
  authorization_hash          text CHECK (authorization_hash IS NULL OR kauro.is_sha256_hex(authorization_hash)),
  effects_hash                text CHECK (effects_hash IS NULL OR kauro.is_sha256_hex(effects_hash)),
  credit_note_required        boolean,
  approved_by_user_id         uuid REFERENCES kauro.identities (user_id),
  approved_at                 timestamptz,
  -- a review that declines the request
  rejected_reason             text CHECK (rejected_reason IS NULL OR kauro.is_token(rejected_reason)),
  rejected_by_user_id         uuid REFERENCES kauro.identities (user_id),
  rejected_at                 timestamptz,
  -- the reconciled effect
  provider_refund_id          text CHECK (provider_refund_id IS NULL OR provider_refund_id ~ '^[A-Za-z0-9._:-]{1,256}$'),
  evidence_hash               text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  completed_at                timestamptz,
  failed_reason               text CHECK (failed_reason IS NULL OR kauro.is_token(failed_reason)),
  created_at                  timestamptz NOT NULL,
  updated_at                  timestamptz NOT NULL,
  UNIQUE (agency_id, refund_id),
  UNIQUE (agency_id, refund_id, order_id),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  FOREIGN KEY (agency_id, requested_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT refunds_origin_request CHECK (origin <> 'CUSTOMER_REQUEST' OR (requested_by_membership_id IS NOT NULL AND evidence_ref IS NOT NULL)),
  -- an excess return carries only the excess; a service refund never carries excess
  CONSTRAINT refunds_excess_only CHECK (
       (origin = 'EXCESS_CAPTURE' AND proposed_service_cents = 0 AND proposed_tax_cents = 0 AND coalesce(service_cents, 0) = 0 AND coalesce(tax_cents, 0) = 0)
    OR (origin <> 'EXCESS_CAPTURE' AND proposed_excess_cents = 0 AND coalesce(excess_cents, 0) = 0)
  ),
  CONSTRAINT refunds_approval_binding CHECK (
       (state IN ('REQUESTED', 'REJECTED') AND service_cents IS NULL AND tax_cents IS NULL AND excess_cents IS NULL AND authorization_kind IS NULL
        AND authorization_hash IS NULL AND effects_hash IS NULL AND credit_note_required IS NULL AND approved_by_user_id IS NULL AND approved_at IS NULL)
    OR (state NOT IN ('REQUESTED', 'REJECTED') AND service_cents IS NOT NULL AND tax_cents IS NOT NULL AND excess_cents IS NOT NULL
        AND authorization_kind IS NOT NULL AND authorization_hash IS NOT NULL AND effects_hash IS NOT NULL AND credit_note_required IS NOT NULL
        AND approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND service_cents + tax_cents + excess_cents > 0)
  ),
  CONSTRAINT refunds_authorization_ref CHECK (
    (authorization_kind = 'OWNER_STEP_UP') = (authorization_proof_ref IS NOT NULL)
    AND (authorization_kind = 'STANDING_POLICY') = (authorization_policy_id IS NOT NULL)
  ),
  CONSTRAINT refunds_rejection_binding CHECK (
    (state = 'REJECTED') = (rejected_reason IS NOT NULL) AND (rejected_reason IS NULL) = (rejected_at IS NULL) AND (rejected_reason IS NULL) = (rejected_by_user_id IS NULL)
  ),
  CONSTRAINT refunds_completion_binding CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL) AND (state <> 'COMPLETED' OR (provider_refund_id IS NOT NULL AND evidence_hash IS NOT NULL))),
  CONSTRAINT refunds_failure_binding CHECK ((state = 'FAILED') = (failed_reason IS NOT NULL))
);
-- one request under review per capture (a request is reviewed, not spammed; the balance invariant is the capture's)
CREATE UNIQUE INDEX refunds_one_requested_per_capture ON kauro.refunds (agency_id, capture_id) WHERE state = 'REQUESTED';
CREATE INDEX refunds_by_project ON kauro.refunds (agency_id, project_id, created_at, refund_id);
CREATE TRIGGER refunds_touch BEFORE UPDATE ON kauro.refunds FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER refunds_version BEFORE UPDATE ON kauro.refunds FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER refunds_immutable BEFORE UPDATE ON kauro.refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('refund_id,agency_id,project_id,order_id,capture_id,origin,reason_code,evidence_ref,terms_hash,delivery_phase,proposed_service_cents,proposed_tax_cents,proposed_excess_cents,requested_by_membership_id,requested_at,created_at');
CREATE TRIGGER refunds_transition BEFORE UPDATE OF state ON kauro.refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Refund');
CREATE CONSTRAINT TRIGGER refunds_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('refund', 'refund_id');

-- the approved intent and the reconciled effect are recorded once (CMD032 effect "immutable refund intent")
CREATE OR REPLACE FUNCTION kauro.refunds_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.approved_at IS NOT NULL AND (
       NEW.service_cents IS DISTINCT FROM OLD.service_cents OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents OR NEW.excess_cents IS DISTINCT FROM OLD.excess_cents
    OR NEW.authorization_kind IS DISTINCT FROM OLD.authorization_kind OR NEW.authorization_proof_ref IS DISTINCT FROM OLD.authorization_proof_ref
    OR NEW.authorization_policy_id IS DISTINCT FROM OLD.authorization_policy_id OR NEW.authorization_hash IS DISTINCT FROM OLD.authorization_hash
    OR NEW.effects_hash IS DISTINCT FROM OLD.effects_hash OR NEW.credit_note_required IS DISTINCT FROM OLD.credit_note_required
    OR NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: refund % intent is immutable once approved', OLD.refund_id USING ERRCODE = 'KA004';
  END IF;
  IF OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: refund % provider identity cannot change once observed', OLD.refund_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER refunds_once BEFORE UPDATE ON kauro.refunds FOR EACH ROW EXECUTE FUNCTION kauro.refunds_once();

-- Refund ceiling (15 "The total refunded cannot exceed the confirmed captured amount minus earlier refunds and relevant
-- reversals. Concurrent refund requests serialize that invariant"): an approved, in-flight or completed refund commits its
-- components against its capture. The capture row is locked first, so two approvals of one capture serialize; the second is
-- refused with KA010 when the remaining component would go negative, and a capture that is not COMPLETED accepts no new
-- commitment. A refund that fails or is rejected releases its commitment.
CREATE OR REPLACE FUNCTION kauro.maintain_capture_refunds() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  was_committed  boolean := TG_OP = 'UPDATE' AND OLD.state IN ('APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED');
  now_committed  boolean := NEW.state IN ('APPROVED', 'SUBMITTING', 'UNCERTAIN', 'COMPLETED');
  d_service      bigint := 0;
  d_tax          bigint := 0;
  d_excess       bigint := 0;
  cap            record;
BEGIN
  IF was_committed THEN
    d_service := d_service - OLD.service_cents; d_tax := d_tax - OLD.tax_cents; d_excess := d_excess - OLD.excess_cents;
  END IF;
  IF now_committed THEN
    d_service := d_service + NEW.service_cents; d_tax := d_tax + NEW.tax_cents; d_excess := d_excess + NEW.excess_cents;
  END IF;
  IF d_service = 0 AND d_tax = 0 AND d_excess = 0 THEN RETURN NULL; END IF;
  SELECT status, allocated_service_cents, allocated_tax_cents, excess_cents, refunded_service_cents, refunded_tax_cents, refunded_excess_cents
    INTO cap FROM kauro.capture_facts WHERE agency_id = NEW.agency_id AND capture_id = NEW.capture_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTEXT: capture % is not visible in this transaction', NEW.capture_id USING ERRCODE = 'KA006';
  END IF;
  IF now_committed AND NOT was_committed AND cap.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_CAPTURE: capture % is % and accepts no refund commitment', NEW.capture_id, cap.status USING ERRCODE = 'KA010';
  END IF;
  IF cap.refunded_service_cents + d_service > cap.allocated_service_cents
     OR cap.refunded_tax_cents + d_tax > cap.allocated_tax_cents
     OR cap.refunded_excess_cents + d_excess > cap.excess_cents THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_CAPTURE: refund % exceeds the remaining refundable components of capture %', NEW.refund_id, NEW.capture_id USING ERRCODE = 'KA010';
  END IF;
  UPDATE kauro.capture_facts
     SET refunded_service_cents = refunded_service_cents + d_service,
         refunded_tax_cents = refunded_tax_cents + d_tax,
         refunded_excess_cents = refunded_excess_cents + d_excess
   WHERE agency_id = NEW.agency_id AND capture_id = NEW.capture_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER refunds_capture_commitment AFTER INSERT OR UPDATE OF state ON kauro.refunds
  FOR EACH ROW EXECUTE FUNCTION kauro.maintain_capture_refunds();

-- Refund machine (platform, D-REF-B2; the registry lists the states, not a machine): an attempt that proves no effect returns
-- the refund to APPROVED under the same authorization (a new deliberate attempt, never a blind retry); FAILED is the terminal
-- lapse of the authorization and releases the commitment.
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Refund', 'REQUESTED', 'APPROVED'),
  ('Refund', 'REQUESTED', 'REJECTED'),
  ('Refund', 'APPROVED', 'SUBMITTING'),
  ('Refund', 'SUBMITTING', 'COMPLETED'),
  ('Refund', 'SUBMITTING', 'UNCERTAIN'),
  ('Refund', 'SUBMITTING', 'APPROVED'),
  ('Refund', 'UNCERTAIN', 'COMPLETED'),
  ('Refund', 'UNCERTAIN', 'APPROVED'),
  ('Refund', 'APPROVED', 'FAILED');

-- refund attempts name their refund (the attempt table predates this one)
ALTER TABLE kauro.payment_attempts ADD CONSTRAINT payment_attempts_refund_fk
  FOREIGN KEY (agency_id, refund_id, order_id) REFERENCES kauro.refunds (agency_id, refund_id, order_id);

-- --- tax documents (registry TaxDocument; D-FISC-B3..B5) -------------------------------------------------------------------------------
-- The local fiscal document and its issuance lifecycle. B09 drafts an INVOICE when a capture completes and a CREDIT_NOTE when a
-- refund completes, and validates a draft only against a reviewed treatment (R2-128: a REVIEW_REQUIRED treatment blocks
-- issuance while the capture reconciliation stands). Issuance through the fiscal adapter or the manual bridge (CMD035) belongs
-- to the fiscal integration package (B15); its edges are listed here with the registry.
CREATE TABLE kauro.tax_documents (
  document_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(document_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id                uuid NOT NULL,
  capture_id              uuid NOT NULL,
  refund_id               uuid,
  kind                    text NOT NULL CHECK (kind IN ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  version                 bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                   text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'VALIDATED', 'SUBMITTING', 'UNCERTAIN', 'ISSUED', 'REJECTED', 'CORRECTED')),
  fiscal_profile_id       uuid NOT NULL,
  issuer_ref              uuid NOT NULL REFERENCES kauro.fiscal_issuers (issuer_ref),
  -- the treatment of the named profile at drafting (REVIEW_REQUIRED keeps the draft blocked)
  tax_treatment           text NOT NULL CHECK (tax_treatment IN ('REVIEW_REQUIRED', 'DOMESTIC_TAXABLE', 'EXEMPT_EXPORT', 'OTHER_REVIEWED')),
  service_cents           bigint NOT NULL CHECK (kauro.is_money(service_cents)),
  tax_cents               bigint NOT NULL CHECK (kauro.is_money(tax_cents)),
  currency                text NOT NULL CHECK (currency IN ('USD')),
  corrects_document_id    uuid,
  supersedes_document_id  uuid,
  -- why a DRAFT cannot be validated (FISCAL_TREATMENT_UNREVIEWED, FISCAL_PROFILE_NOT_EFFECTIVE, ...): an explicit blocker
  blocked_reason          text CHECK (blocked_reason IS NULL OR kauro.is_token(blocked_reason)),
  issue_request_hash      text CHECK (issue_request_hash IS NULL OR kauro.is_sha256_hex(issue_request_hash)),
  provider_document_id    text CHECK (provider_document_id IS NULL OR provider_document_id ~ '^[A-Za-z0-9._:-]{1,256}$'),
  legal_number            text CHECK (legal_number IS NULL OR legal_number ~ '^[A-Z0-9][A-Z0-9-]{0,63}$'),
  rejection_reason        text CHECK (rejection_reason IS NULL OR kauro.is_token(rejection_reason)),
  evidence_hash           text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  issued_at               timestamptz,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  UNIQUE (agency_id, document_id),
  FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  FOREIGN KEY (agency_id, refund_id, order_id) REFERENCES kauro.refunds (agency_id, refund_id, order_id),
  FOREIGN KEY (agency_id, fiscal_profile_id, tax_treatment) REFERENCES kauro.fiscal_profiles (agency_id, profile_id, tax_treatment),
  FOREIGN KEY (agency_id, corrects_document_id) REFERENCES kauro.tax_documents (agency_id, document_id),
  FOREIGN KEY (agency_id, supersedes_document_id) REFERENCES kauro.tax_documents (agency_id, document_id),
  CONSTRAINT tax_documents_note_corrects_original CHECK ((kind = 'INVOICE') = (corrects_document_id IS NULL)),
  CONSTRAINT tax_documents_credit_note_names_refund CHECK (kind <> 'CREDIT_NOTE' OR refund_id IS NOT NULL),
  CONSTRAINT tax_documents_invoice_has_no_refund CHECK (kind <> 'INVOICE' OR refund_id IS NULL),
  -- no guessed zero VAT and no issuance past an unreviewed treatment (R2-082, R2-128)
  CONSTRAINT tax_documents_reviewed_before_validation CHECK (state = 'DRAFT' OR (tax_treatment <> 'REVIEW_REQUIRED' AND blocked_reason IS NULL)),
  CONSTRAINT tax_documents_blocked_only_as_draft CHECK (blocked_reason IS NULL OR state = 'DRAFT'),
  CONSTRAINT tax_documents_unreviewed_is_blocked CHECK (tax_treatment <> 'REVIEW_REQUIRED' OR blocked_reason IS NOT NULL),
  CONSTRAINT tax_documents_export_has_no_tax CHECK (tax_treatment <> 'EXEMPT_EXPORT' OR tax_cents = 0),
  CONSTRAINT tax_documents_submission_identity CHECK (state NOT IN ('SUBMITTING', 'UNCERTAIN', 'ISSUED') OR issue_request_hash IS NOT NULL),
  -- a provider PDF is not acceptance: ISSUED means the legal number and the fiscal/provider acceptance were observed (15)
  CONSTRAINT tax_documents_issued_evidence CHECK (
    state <> 'ISSUED' OR (provider_document_id IS NOT NULL AND legal_number IS NOT NULL AND evidence_hash IS NOT NULL AND issued_at IS NOT NULL)
  ),
  -- a CORRECTED document keeps what it was: an issued legal record or a rejection
  CONSTRAINT tax_documents_corrected_history CHECK (state <> 'CORRECTED' OR rejection_reason IS NOT NULL OR (legal_number IS NOT NULL AND issued_at IS NOT NULL)),
  CONSTRAINT tax_documents_rejection_reason CHECK (state <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CONSTRAINT tax_documents_no_self_lineage CHECK (corrects_document_id IS DISTINCT FROM document_id AND supersedes_document_id IS DISTINCT FROM document_id)
);
-- duplicate fiscal documents are prevented by local unique references (15 "TaxDocument state machine")
CREATE UNIQUE INDEX tax_documents_legal_number ON kauro.tax_documents (issuer_ref, legal_number) WHERE legal_number IS NOT NULL;
CREATE UNIQUE INDEX tax_documents_provider_identity ON kauro.tax_documents (issuer_ref, provider_document_id) WHERE provider_document_id IS NOT NULL;
CREATE UNIQUE INDEX tax_documents_one_live_invoice_per_capture ON kauro.tax_documents (agency_id, capture_id)
  WHERE kind = 'INVOICE' AND state NOT IN ('REJECTED', 'CORRECTED');
CREATE UNIQUE INDEX tax_documents_one_live_credit_note_per_refund ON kauro.tax_documents (agency_id, refund_id)
  WHERE kind = 'CREDIT_NOTE' AND state NOT IN ('REJECTED', 'CORRECTED');
CREATE UNIQUE INDEX tax_documents_corrected_once ON kauro.tax_documents (agency_id, supersedes_document_id) WHERE supersedes_document_id IS NOT NULL;
CREATE INDEX tax_documents_by_order ON kauro.tax_documents (agency_id, order_id, created_at, document_id);
CREATE TRIGGER tax_documents_touch BEFORE UPDATE ON kauro.tax_documents FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER tax_documents_version BEFORE UPDATE ON kauro.tax_documents FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER tax_documents_immutable BEFORE UPDATE ON kauro.tax_documents
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('document_id,agency_id,order_id,capture_id,refund_id,kind,service_cents,currency,corrects_document_id,supersedes_document_id,created_at');
CREATE TRIGGER tax_documents_transition BEFORE UPDATE OF state ON kauro.tax_documents
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('TaxDocument');
CREATE CONSTRAINT TRIGGER tax_documents_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.tax_documents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('tax_document', 'document_id');

-- A draft is the only mutable form: while it is DRAFT it may be re-pointed at the reviewed profile, issuer and tax the review
-- produced (and its blocker may change); from VALIDATED on the treatment, issuer and amounts are fixed. Issued facts and the
-- submission identity are never overwritten ("Original issued facts are not overwritten").
CREATE OR REPLACE FUNCTION kauro.tax_documents_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.state <> 'DRAFT' AND (NEW.fiscal_profile_id IS DISTINCT FROM OLD.fiscal_profile_id OR NEW.issuer_ref IS DISTINCT FROM OLD.issuer_ref
     OR NEW.tax_treatment IS DISTINCT FROM OLD.tax_treatment OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: tax document % treatment and amounts are fixed once validated', OLD.document_id USING ERRCODE = 'KA004';
  END IF;
  IF (OLD.issue_request_hash IS NOT NULL AND NEW.issue_request_hash IS DISTINCT FROM OLD.issue_request_hash)
     OR (OLD.provider_document_id IS NOT NULL AND NEW.provider_document_id IS DISTINCT FROM OLD.provider_document_id)
     OR (OLD.legal_number IS NOT NULL AND NEW.legal_number IS DISTINCT FROM OLD.legal_number)
     OR (OLD.issued_at IS NOT NULL AND NEW.issued_at IS DISTINCT FROM OLD.issued_at)
     OR (OLD.rejection_reason IS NOT NULL AND NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason)
     OR (OLD.state NOT IN ('DRAFT') AND OLD.evidence_hash IS NOT NULL AND NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: tax document % issuance facts are recorded once', OLD.document_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tax_documents_once BEFORE UPDATE ON kauro.tax_documents FOR EACH ROW EXECUTE FUNCTION kauro.tax_documents_once();

-- TaxDocument: exactly the registry machine (reference/TRANSITIONS_AND_EVENT_EFFECTS "TaxDocument")
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('TaxDocument', 'DRAFT', 'VALIDATED'),
  ('TaxDocument', 'VALIDATED', 'SUBMITTING'),
  ('TaxDocument', 'SUBMITTING', 'ISSUED'),
  ('TaxDocument', 'SUBMITTING', 'UNCERTAIN'),
  ('TaxDocument', 'SUBMITTING', 'REJECTED'),
  ('TaxDocument', 'UNCERTAIN', 'ISSUED'),
  ('TaxDocument', 'UNCERTAIN', 'REJECTED'),
  ('TaxDocument', 'REJECTED', 'CORRECTED'),
  ('TaxDocument', 'ISSUED', 'CORRECTED');

-- --- operational ledger (append-only; D-LEDGER-B1..B3) ------------------------------------------------------------------------------------
-- One balanced posting set per source domain event and currency: the event id is the idempotency identity of the posting
-- ("Idempotent source event"; a replayed provider event produces no second event, so no second posting). Corrections are
-- reversing entries that name what they reverse, once.
CREATE TABLE kauro.ledger_entries (
  entry_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(entry_id)),
  agency_id          uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  event_id           uuid NOT NULL REFERENCES kauro.domain_events (event_id),
  line_no            integer NOT NULL CHECK (line_no BETWEEN 1 AND 64),
  -- versioned operational classification (15 "Operational ledger"; reference/HASHING "keep at least the following account
  -- classes distinct"); the accountant maps them to the statutory chart
  account_code       text NOT NULL CHECK (account_code IN (
                       'PSP_RECEIVABLE', 'PSP_HELD', 'PSP_AVAILABLE', 'BANK_IN_TRANSIT', 'BANK_CASH', 'CONTRACT_LIABILITY',
                       'SERVICE_REVENUE', 'TAX_PAYABLE', 'CUSTOMER_OVERPAYMENT', 'REFUND_PAYABLE', 'PROCESSOR_EXPENSE',
                       'COMMISSION_PAYABLE', 'COMMISSION_EXPENSE', 'OWNER_CONTRIBUTION', 'OWNER_DISTRIBUTION')),
  account_version    text NOT NULL CHECK (account_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  direction          text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_cents       bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  currency           text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- the economic source: a capture, a refund, a provider fee, a chargeback/reversal, a settlement movement, or a CORRECTION
  -- that reverses one earlier entry
  source_kind        text NOT NULL CHECK (source_kind IN ('CAPTURE', 'REFUND', 'FEE', 'CHARGEBACK', 'SETTLEMENT', 'CORRECTION')),
  source_ref         uuid NOT NULL,
  reverses_entry_id  uuid,
  effective_at       timestamptz NOT NULL,
  posted_at          timestamptz NOT NULL,
  evidence_hash      text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  policy_version     text NOT NULL CHECK (policy_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  UNIQUE (agency_id, entry_id),
  UNIQUE (event_id, line_no),
  FOREIGN KEY (agency_id, reverses_entry_id) REFERENCES kauro.ledger_entries (agency_id, entry_id),
  CONSTRAINT ledger_entries_no_self_reversal CHECK (reverses_entry_id IS DISTINCT FROM entry_id),
  CONSTRAINT ledger_entries_correction_names_original CHECK ((source_kind = 'CORRECTION') = (reverses_entry_id IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_entries_reversed_once ON kauro.ledger_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX ledger_entries_by_source ON kauro.ledger_entries (agency_id, source_kind, source_ref, posted_at);
CREATE INDEX ledger_entries_by_account ON kauro.ledger_entries (agency_id, account_code, posted_at, entry_id);
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON kauro.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- every posting set balances within its currency at commit ("Each balanced transaction balances within its currency")
CREATE OR REPLACE FUNCTION kauro.ledger_entries_balanced() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  net bigint;
BEGIN
  SELECT coalesce(sum(CASE WHEN direction = 'DEBIT' THEN amount_cents ELSE -amount_cents END), 0) INTO net
    FROM kauro.ledger_entries WHERE event_id = NEW.event_id AND currency = NEW.currency;
  IF net <> 0 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: postings of event % in % are off by %', NEW.event_id, NEW.currency, net USING ERRCODE = 'KA009';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER ledger_entries_balance AFTER INSERT ON kauro.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.ledger_entries_balanced();

-- --- settlements (platform observations; D-LEDGER-B3) -------------------------------------------------------------------------------------
-- Balance-level provider and bank observations of one merchant route: captured gross, fees, held, withdrawn and
-- bank-available funds stay distinct observed facts. A bank-available amount needs bank evidence: a provider balance or a
-- submitted withdrawal is never coerced to available cash (CMD034 failure; R2-085).
CREATE TABLE kauro.settlements (
  settlement_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(settlement_id)),
  route_id                uuid NOT NULL REFERENCES kauro.payment_routes (route_id),
  provider_balance_ref    uuid NOT NULL,
  currency                text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_cents             bigint NOT NULL CHECK (kauro.is_money(gross_cents)),
  fee_cents               bigint NOT NULL CHECK (kauro.is_money(fee_cents)),
  held_cents              bigint NOT NULL CHECK (kauro.is_money(held_cents)),
  withdrawn_cents         bigint NOT NULL CHECK (kauro.is_money(withdrawn_cents)),
  bank_available_cents    bigint NOT NULL CHECK (kauro.is_money(bank_available_cents)),
  bank_evidence_hash      text CHECK (bank_evidence_hash IS NULL OR kauro.is_sha256_hex(bank_evidence_hash)),
  fx_rate                 text CHECK (fx_rate IS NULL OR fx_rate ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$'),
  period_start            timestamptz NOT NULL,
  period_end              timestamptz NOT NULL,
  observed_at             timestamptz NOT NULL,
  evidence_hash           text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  created_at              timestamptz NOT NULL,
  UNIQUE (route_id, provider_balance_ref, observed_at),
  CONSTRAINT settlements_bank_evidence CHECK (bank_available_cents = 0 OR bank_evidence_hash IS NOT NULL),
  CONSTRAINT settlements_period CHECK (period_end > period_start AND observed_at >= period_start)
);
CREATE TRIGGER settlements_append_only BEFORE UPDATE OR DELETE ON kauro.settlements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- reconciliation cases (D-CASE-B1) ------------------------------------------------------------------------------------------------------
-- The visible, owned case for every unexplained money difference or unresolved effect of one agency's payment: never a generic
-- "miscellaneous" balance (15 "Operational ledger"; "Exhausting retries leaves a visible case with the exact unresolved effect").
CREATE TABLE kauro.reconciliation_cases (
  case_id        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(case_id)),
  agency_id      uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  order_id       uuid,
  capture_id     uuid,
  refund_id      uuid,
  kind           text NOT NULL CHECK (kind IN ('AMOUNT_MISMATCH', 'UNDERPAYMENT', 'EXCESS_CAPTURE', 'CAPTURE_WITHOUT_VALID_SUBJECT', 'UNCERTAIN_EFFECT', 'UNRECOGNIZED_PROVIDER_STATE', 'PROVIDER_INCONSISTENCY', 'REVERSAL', 'FEE_MISMATCH')),
  version        bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state          text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'RESOLVED')),
  detail_code    text NOT NULL CHECK (kauro.is_token(detail_code)),
  amount_cents   bigint CHECK (amount_cents IS NULL OR kauro.is_money(amount_cents)),
  currency       text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  opened_at      timestamptz NOT NULL,
  resolved_at    timestamptz,
  resolution     text CHECK (resolution IS NULL OR kauro.is_token(resolution)),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  UNIQUE (agency_id, case_id),
  FOREIGN KEY (agency_id, order_id) REFERENCES kauro.payment_orders (agency_id, order_id),
  FOREIGN KEY (agency_id, capture_id) REFERENCES kauro.capture_facts (agency_id, capture_id),
  FOREIGN KEY (agency_id, refund_id) REFERENCES kauro.refunds (agency_id, refund_id),
  CONSTRAINT reconciliation_cases_subject CHECK (order_id IS NOT NULL OR capture_id IS NOT NULL OR refund_id IS NOT NULL),
  CONSTRAINT reconciliation_cases_amount_currency CHECK ((amount_cents IS NULL) = (currency IS NULL)),
  CONSTRAINT reconciliation_cases_resolution CHECK ((state = 'RESOLVED') = (resolved_at IS NOT NULL) AND (resolved_at IS NULL) = (resolution IS NULL))
);
-- one open case per subject and kind: a repeated observation adds history to the open case instead of opening another
CREATE UNIQUE INDEX reconciliation_cases_one_open ON kauro.reconciliation_cases (agency_id, kind, coalesce(capture_id, refund_id, order_id)) WHERE state = 'OPEN';
CREATE TRIGGER reconciliation_cases_touch BEFORE UPDATE ON kauro.reconciliation_cases FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER reconciliation_cases_version BEFORE UPDATE ON kauro.reconciliation_cases FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER reconciliation_cases_immutable BEFORE UPDATE ON kauro.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('case_id,agency_id,order_id,capture_id,refund_id,kind,detail_code,amount_cents,currency,evidence_hash,opened_at,created_at');
CREATE TRIGGER reconciliation_cases_transition BEFORE UPDATE OF state ON kauro.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('ReconciliationCase');
CREATE CONSTRAINT TRIGGER reconciliation_cases_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.reconciliation_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('reconciliation_case', 'case_id');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES ('ReconciliationCase', 'OPEN', 'RESOLVED');

-- --- provider event exceptions (platform; D-CASE-B1) -------------------------------------------------------------------------------------
-- An authenticated provider event that cannot be applied to any order of any agency — an unknown provider reference, another
-- payee, another currency, an unrecognized status — is kept for the owner's finance review with the inbox row that carried it
-- (REJECTED or IGNORED). It never becomes a capture fact or an authorization (S058, CMD030-DENY).
CREATE TABLE kauro.provider_event_exceptions (
  exception_id    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(exception_id)),
  inbox_id        uuid NOT NULL UNIQUE REFERENCES kauro.inbox_records (inbox_id),
  provider        text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  environment     text NOT NULL CHECK (environment IN ('LOCAL', 'SANDBOX', 'LIVE')),
  kind            text NOT NULL CHECK (kind IN ('UNKNOWN_PROVIDER_REFERENCE', 'WRONG_PAYEE', 'WRONG_CURRENCY', 'UNRECOGNIZED_PROVIDER_STATE')),
  provider_ref    text CHECK (provider_ref IS NULL OR provider_ref ~ '^[A-Za-z0-9._:-]{1,256}$'),
  amount_cents    bigint CHECK (amount_cents IS NULL OR kauro.is_money(amount_cents)),
  currency        text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  evidence_hash   text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  observed_at     timestamptz NOT NULL,
  resolved_at     timestamptz,
  resolution      text CHECK (resolution IS NULL OR kauro.is_token(resolution)),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  CONSTRAINT provider_event_exceptions_resolution CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE TRIGGER provider_event_exceptions_touch BEFORE UPDATE ON kauro.provider_event_exceptions FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER provider_event_exceptions_immutable BEFORE UPDATE ON kauro.provider_event_exceptions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('exception_id,inbox_id,provider,environment,kind,provider_ref,amount_cents,currency,evidence_hash,observed_at,created_at');

-- --- row-level security -------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY refunds_commerce ON kauro.refunds FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

ALTER TABLE kauro.tax_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.tax_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_documents_commerce ON kauro.tax_documents FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

ALTER TABLE kauro.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_entries_commerce ON kauro.ledger_entries FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));
-- the owner's company-finance projection reads every agency's postings through the control plane (UI39)
CREATE POLICY ledger_entries_control ON kauro.ledger_entries FOR SELECT TO kauro_control USING (true);

ALTER TABLE kauro.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY settlements_service ON kauro.settlements FOR ALL TO kauro_app
  USING (kauro.current_principal() = 'SERVICE') WITH CHECK (kauro.current_principal() = 'SERVICE');
CREATE POLICY settlements_operator_read ON kauro.settlements FOR SELECT TO kauro_app USING (kauro.current_principal() = 'OPERATOR');
CREATE POLICY settlements_control ON kauro.settlements FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.reconciliation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.reconciliation_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_cases_commerce ON kauro.reconciliation_cases FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

ALTER TABLE kauro.provider_event_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.provider_event_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_event_exceptions_service_write ON kauro.provider_event_exceptions FOR INSERT TO kauro_app
  WITH CHECK (kauro.current_principal() = 'SERVICE');
CREATE POLICY provider_event_exceptions_read ON kauro.provider_event_exceptions FOR SELECT TO kauro_app
  USING (kauro.current_principal() IN ('SERVICE', 'OPERATOR'));
CREATE POLICY provider_event_exceptions_control ON kauro.provider_event_exceptions FOR ALL TO kauro_control USING (true) WITH CHECK (true);

-- --- grants -----------------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON kauro.refunds, kauro.tax_documents, kauro.reconciliation_cases TO kauro_app;
GRANT SELECT, INSERT ON kauro.ledger_entries, kauro.settlements, kauro.provider_event_exceptions TO kauro_app;
GRANT SELECT ON kauro.ledger_entries TO kauro_control;
GRANT SELECT, INSERT ON kauro.settlements TO kauro_control;
GRANT SELECT, INSERT, UPDATE ON kauro.provider_event_exceptions TO kauro_control;
