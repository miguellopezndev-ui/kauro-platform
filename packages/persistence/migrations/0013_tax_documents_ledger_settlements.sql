-- 0013 — fiscal documents, the operational ledger and settlement observations (package B09).
--
-- Authority: 07 "Aggregate ownership" (TaxDocument owns fiscal issuance and correction, independently from payment
-- confirmation), 15 "FiscalProfile" (unknown facts block affected fiscal claims), "Accounting integration decision" (a verified
-- provider API or a lawful manual-assisted bridge; a provider PDF is not fiscal acceptance), "Operational ledger" (immutable
-- events and balanced monetary allocations; corrections are reversals plus new entries), "Settlement and bank availability"
-- (withdrawn funds are not bank cash until an observed statement shows them), reference/HASHING_AND_ACCOUNTING_RULES "Ledger
-- posting and reconciliation" (each balanced transaction balances within its currency; a replayed refund webhook does not post
-- another refund), registry contracts TaxDocument, LedgerEntry, Settlement; registry machine TaxDocument; scenarios R2-128, R2-078,
-- R2-140. Design: docs/design/B09-payments-fiscal.md (D-FISC-B1..B5, D-LEDGER-B1..B4, D-SETTLE-B1).

-- --- fiscal documents (registry machine TaxDocument) ------------------------------------------------------------------------------------
-- The fiscal document of a sale (INVOICE of a capture), of a refund (CREDIT_NOTE correcting the invoice) or of an upward
-- correction (DEBIT_NOTE; no B09 flow creates one). Drafted by the fiscal consumer from the reconciled financial event with the
-- collected amounts and the agency's current reviewed profile; a draft whose treatment is not reviewed, not effective, not the one
-- the sale was priced with, or whose issuer facts are unconfirmed stays DRAFT with the concrete blocker (R2-128: never an
-- exemption inferred from a currency or an email; the capture's reconciliation is unaffected). DRAFT -> VALIDATED is re-checked
-- here (KP011); issuance (CMD035, the fiscal integration package B15) submits once and records the legal number only on
-- authenticated acceptance. Rejections are never overwritten: a corrected draft names its predecessor.
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
  issuer_ref              uuid NOT NULL,
  tax_treatment           text NOT NULL CHECK (tax_treatment IN ('REVIEW_REQUIRED', 'DOMESTIC_TAXABLE', 'EXEMPT_EXPORT', 'OTHER_REVIEWED')),
  tax_rule                text NOT NULL CHECK (tax_rule IN ('UNRESOLVED', 'RATE_HALF_UP', 'ZERO_REVIEWED')),
  tax_rate_bps            integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  service_cents           bigint NOT NULL CHECK (kauro.is_money(service_cents)),
  tax_cents               bigint NOT NULL CHECK (kauro.is_money(tax_cents)),
  currency                text NOT NULL CHECK (currency IN ('USD')),
  corrects_document_id    uuid,
  supersedes_document_id  uuid,
  blocked_reason          text CHECK (blocked_reason IS NULL OR blocked_reason IN ('FISCAL_TREATMENT_UNREVIEWED', 'FISCAL_PROFILE_NOT_EFFECTIVE', 'FISCAL_TREATMENT_CHANGED', 'FISCAL_ISSUER_MISMATCH', 'ISSUER_FACTS_UNCONFIRMED')),
  issue_request_hash      text CHECK (issue_request_hash IS NULL OR kauro.is_sha256_hex(issue_request_hash)),
  provider_document_id    text CHECK (provider_document_id IS NULL OR kauro.is_provider_ref(provider_document_id)),
  legal_number            text CHECK (legal_number IS NULL OR legal_number ~ '^[A-Za-z0-9./:-]{1,64}$'),
  rejection_code          text CHECK (rejection_code IS NULL OR kauro.is_token(rejection_code)),
  evidence_hash           text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  issued_at               timestamptz,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  UNIQUE (agency_id, document_id),
  CONSTRAINT tax_documents_capture_binding UNIQUE (agency_id, document_id, capture_id),
  FOREIGN KEY (agency_id, capture_id, order_id) REFERENCES kauro.capture_facts (agency_id, capture_id, order_id),
  CONSTRAINT tax_documents_refund_fk FOREIGN KEY (agency_id, refund_id, order_id, capture_id) REFERENCES kauro.refunds (agency_id, refund_id, order_id, capture_id),
  -- the document's fiscal snapshot is exactly its profile's issuer and reviewed (or explicitly unresolved) rule
  CONSTRAINT tax_documents_fiscal_fk FOREIGN KEY (agency_id, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps)
    REFERENCES kauro.fiscal_profiles (agency_id, profile_id, operator_legal_ref, tax_treatment, tax_rule, tax_rate_bps),
  -- a correction and a corrected draft stay within the same capture's documents
  CONSTRAINT tax_documents_corrects_fk FOREIGN KEY (agency_id, corrects_document_id, capture_id) REFERENCES kauro.tax_documents (agency_id, document_id, capture_id),
  CONSTRAINT tax_documents_supersedes_fk FOREIGN KEY (agency_id, supersedes_document_id, capture_id) REFERENCES kauro.tax_documents (agency_id, document_id, capture_id),
  CONSTRAINT tax_documents_kind_subject CHECK (
    (kind = 'INVOICE' AND refund_id IS NULL AND corrects_document_id IS NULL)
    OR (kind = 'CREDIT_NOTE' AND refund_id IS NOT NULL AND corrects_document_id IS NOT NULL)
    OR (kind = 'DEBIT_NOTE' AND refund_id IS NULL AND corrects_document_id IS NOT NULL)
  ),
  -- an unreviewed treatment is a blocked draft, never a document that moves on (R2-082, R2-128)
  CONSTRAINT tax_documents_unreviewed_blocks CHECK (tax_treatment <> 'REVIEW_REQUIRED' OR (state = 'DRAFT' AND blocked_reason IS NOT NULL)),
  CONSTRAINT tax_documents_blocked_only_draft CHECK (blocked_reason IS NULL OR state = 'DRAFT'),
  CONSTRAINT tax_documents_submission_named CHECK (state IN ('DRAFT', 'VALIDATED') OR issue_request_hash IS NOT NULL),
  -- a legal number exists only after authenticated issuance (15: a provider PDF is not fiscal acceptance)
  CONSTRAINT tax_documents_issuance CHECK (
    (legal_number IS NULL) = (issued_at IS NULL) AND (issued_at IS NULL OR (provider_document_id IS NOT NULL AND evidence_hash IS NOT NULL))
    AND (state <> 'ISSUED' OR issued_at IS NOT NULL)
  ),
  CONSTRAINT tax_documents_rejection CHECK (state <> 'REJECTED' OR rejection_code IS NOT NULL),
  CONSTRAINT tax_documents_no_self_lineage CHECK (corrects_document_id IS DISTINCT FROM document_id AND supersedes_document_id IS DISTINCT FROM document_id)
);
-- one live invoice per capture and one live credit note per refund: a rejected document (and its corrected predecessor chain)
-- leaves room for its corrected successor, an issued one — even after a credit note corrected it — never for a second
CREATE UNIQUE INDEX tax_documents_one_invoice_per_capture ON kauro.tax_documents (agency_id, capture_id)
  WHERE kind = 'INVOICE' AND state <> 'REJECTED' AND NOT (state = 'CORRECTED' AND issued_at IS NULL);
CREATE UNIQUE INDEX tax_documents_one_credit_note_per_refund ON kauro.tax_documents (agency_id, refund_id)
  WHERE kind = 'CREDIT_NOTE' AND state <> 'REJECTED' AND NOT (state = 'CORRECTED' AND issued_at IS NULL);
CREATE UNIQUE INDEX tax_documents_legal_number ON kauro.tax_documents (issuer_ref, legal_number) WHERE legal_number IS NOT NULL;
CREATE UNIQUE INDEX tax_documents_provider_identity ON kauro.tax_documents (issuer_ref, provider_document_id) WHERE provider_document_id IS NOT NULL;
CREATE UNIQUE INDEX tax_documents_supersedes_once ON kauro.tax_documents (agency_id, supersedes_document_id) WHERE supersedes_document_id IS NOT NULL;
CREATE INDEX tax_documents_blocked ON kauro.tax_documents (agency_id, created_at) WHERE state = 'DRAFT' AND blocked_reason IS NOT NULL;
CREATE TRIGGER tax_documents_touch BEFORE UPDATE ON kauro.tax_documents FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER tax_documents_version BEFORE UPDATE ON kauro.tax_documents FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER tax_documents_immutable BEFORE UPDATE ON kauro.tax_documents
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('document_id,agency_id,order_id,capture_id,refund_id,kind,service_cents,currency,corrects_document_id,supersedes_document_id,created_at');
CREATE TRIGGER tax_documents_learned_once BEFORE UPDATE ON kauro.tax_documents
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('issue_request_hash,provider_document_id,legal_number,rejection_code,evidence_hash,issued_at');

-- a draft is re-pointed at a re-reviewed profile only while it is a draft (TaxDocumentRepository.redraft); from VALIDATED on, the
-- fiscal snapshot and the amounts are the ones issued
CREATE OR REPLACE FUNCTION kauro.tax_documents_draft_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (NEW.fiscal_profile_id, NEW.issuer_ref, NEW.tax_treatment, NEW.tax_rule, NEW.tax_rate_bps, NEW.tax_cents, NEW.blocked_reason)
       IS DISTINCT FROM (OLD.fiscal_profile_id, OLD.issuer_ref, OLD.tax_treatment, OLD.tax_rule, OLD.tax_rate_bps, OLD.tax_cents, OLD.blocked_reason)
     AND NOT (OLD.state = 'DRAFT' AND NEW.state = 'DRAFT')
     AND NOT (OLD.state = 'DRAFT' AND NEW.state = 'VALIDATED' AND NEW.blocked_reason IS NULL
              AND (NEW.fiscal_profile_id, NEW.issuer_ref, NEW.tax_treatment, NEW.tax_rule, NEW.tax_rate_bps, NEW.tax_cents)
                  IS NOT DISTINCT FROM (OLD.fiscal_profile_id, OLD.issuer_ref, OLD.tax_treatment, OLD.tax_rule, OLD.tax_rate_bps, OLD.tax_cents)) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: tax document % fiscal snapshot changes only while it is a draft', OLD.document_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tax_documents_draft_only BEFORE UPDATE ON kauro.tax_documents FOR EACH ROW EXECUTE FUNCTION kauro.tax_documents_draft_only();

-- DRAFT -> VALIDATED ("Actual operator/customer/tax/numbering fields pass reviewed rules"; commerce/fiscal resolveFiscalTreatment),
-- read after the transition locks of the agency's profile versions and of the issuer route. FISCAL_VALIDATION_REFUSED (KP011):
--  * the document's profile is the version in force at the tax point (D-FISC-B4; B09-F4): its validity window covers the tax point
--    and it had not been superseded by then — a re-review recorded after the sale does not make the sale's invoice unvalidatable,
--    and a version recorded later is effective for the tax point only if its own window covers it; "current" is required only of
--    a new quote (quotableTaxRule) and of a new draft's choice;
--  * the treatment is reviewed, the issuer's legal facts observed or professionally confirmed with a numbering authorization;
--  * an INVOICE carries the collected amounts (the capture's allocation) and the rule the sale was priced with; its tax point is
--    the capture's completion;
--  * a CREDIT_NOTE carries the completed refund's approved components and exactly the fiscal snapshot of the invoice it corrects,
--    which is ISSUED (15 "Refunds or price corrections create the legally appropriate credit/debit document and relationship to the
--    original"; D-FISC-B5; B09-F16): it corrects the sale, so its profile is judged at the sale's tax point;
--  * a DEBIT_NOTE is refused: no flow of this package defines its basis (an upward price correction is a new accepted scope, 15
--    "Price and source expiry races"; its fiscal treatment is the integration package's, B15; Q-B09-18).
CREATE OR REPLACE FUNCTION kauro.tax_documents_validation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  tax_point timestamptz;
  ok boolean;
BEGIN
  PERFORM kauro.await_transition('kauro.fiscal_profiles', NEW.agency_id::text);
  PERFORM kauro.await_transition('kauro.fiscal_issuers', NEW.issuer_ref::text);
  SELECT f.provider_completed_at INTO tax_point FROM kauro.capture_facts f WHERE f.agency_id = NEW.agency_id AND f.capture_id = NEW.capture_id;
  IF NEW.kind = 'INVOICE' THEN
    SELECT EXISTS (
      SELECT 1 FROM kauro.capture_facts f JOIN kauro.payment_orders o ON o.agency_id = f.agency_id AND o.order_id = f.order_id
               JOIN kauro.quotes q ON q.agency_id = o.agency_id AND q.quote_id = o.quote_id
       WHERE f.agency_id = NEW.agency_id AND f.capture_id = NEW.capture_id AND f.status IN ('COMPLETED', 'REVERSED')
         AND f.allocated_service_cents = NEW.service_cents AND f.allocated_tax_cents = NEW.tax_cents
         AND q.tax_treatment = NEW.tax_treatment AND q.tax_rule = NEW.tax_rule AND q.tax_rate_bps = NEW.tax_rate_bps
    ) INTO ok;
  ELSIF NEW.kind = 'CREDIT_NOTE' THEN
    SELECT EXISTS (
      SELECT 1 FROM kauro.refunds r
       WHERE r.agency_id = NEW.agency_id AND r.refund_id = NEW.refund_id AND r.state = 'COMPLETED'
         AND r.approved_service_cents = NEW.service_cents AND r.approved_tax_cents = NEW.tax_cents
    ) AND EXISTS (
      SELECT 1 FROM kauro.tax_documents d
       WHERE d.agency_id = NEW.agency_id AND d.document_id = NEW.corrects_document_id AND d.kind = 'INVOICE' AND d.state = 'ISSUED'
         AND d.fiscal_profile_id = NEW.fiscal_profile_id AND d.issuer_ref = NEW.issuer_ref
         AND d.tax_treatment = NEW.tax_treatment AND d.tax_rule = NEW.tax_rule AND d.tax_rate_bps = NEW.tax_rate_bps
    ) INTO ok;
  ELSE
    ok := false;
  END IF;
  IF NOT coalesce(ok, false) OR tax_point IS NULL OR NEW.tax_treatment = 'REVIEW_REQUIRED' OR NEW.blocked_reason IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM kauro.fiscal_profiles p JOIN kauro.fiscal_issuers i ON i.issuer_ref = p.operator_legal_ref
     WHERE p.agency_id = NEW.agency_id AND p.profile_id = NEW.fiscal_profile_id
       AND p.valid_from <= tax_point AND (p.valid_until IS NULL OR p.valid_until > tax_point)
       AND (p.superseded_at IS NULL OR p.superseded_at > tax_point)
       AND i.legal_fact_status IN ('OBSERVED', 'PROFESSIONALLY_CONFIRMED') AND i.numbering_authorization_ref IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FISCAL_VALIDATION_REFUSED: tax document % does not pass the reviewed rules', OLD.document_id USING ERRCODE = 'KP011';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tax_documents_validation_guard BEFORE UPDATE OF state ON kauro.tax_documents
  FOR EACH ROW WHEN (OLD.state = 'DRAFT' AND NEW.state = 'VALIDATED') EXECUTE FUNCTION kauro.tax_documents_validation_guard();

-- -> CORRECTED: from REJECTED, "a new draft with explicit lineage is created" (a document supersedes it); from ISSUED, "actual valid
-- correction document exists" (an issued document corrects it). Neither overwrites the original record.
CREATE OR REPLACE FUNCTION kauro.tax_documents_correction_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (OLD.state = 'REJECTED' AND NOT EXISTS (
        SELECT 1 FROM kauro.tax_documents d WHERE d.agency_id = OLD.agency_id AND d.supersedes_document_id = OLD.document_id))
     OR (OLD.state = 'ISSUED' AND NOT EXISTS (
        SELECT 1 FROM kauro.tax_documents d WHERE d.agency_id = OLD.agency_id AND d.corrects_document_id = OLD.document_id AND d.state = 'ISSUED')) THEN
    RAISE EXCEPTION 'FISCAL_VALIDATION_REFUSED: tax document % is corrected only by an actual successor or correction document', OLD.document_id USING ERRCODE = 'KP011';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tax_documents_correction_guard BEFORE UPDATE OF state ON kauro.tax_documents
  FOR EACH ROW WHEN (NEW.state = 'CORRECTED' AND OLD.state IS DISTINCT FROM 'CORRECTED') EXECUTE FUNCTION kauro.tax_documents_correction_guard();
CREATE TRIGGER tax_documents_transition BEFORE UPDATE OF state ON kauro.tax_documents
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('TaxDocument');
CREATE TRIGGER tax_documents_initial_state BEFORE INSERT ON kauro.tax_documents
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('TaxDocument');
CREATE CONSTRAINT TRIGGER tax_documents_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.tax_documents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('tax_document', 'document_id');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('TaxDocument', 'DRAFT');
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

INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('tax_document', 'tax_documents', 'document_id', 'B09');

-- --- settlement observations (platform; D-SETTLE-B1) -------------------------------------------------------------------------------------
-- An observed provider balance of a merchant route for a period (registry Settlement): gross, fees, held, withdrawn, and what an
-- observed bank statement shows as actually available — never derived from a provider balance or a capture status (CMD034
-- failure; R2-085 belongs to the settlement integration, B15). Platform-level: no agency. Append-only.
CREATE TABLE kauro.settlements (
  settlement_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(settlement_id)),
  route_id               uuid NOT NULL REFERENCES kauro.payment_routes (route_id),
  provider_balance_ref   uuid NOT NULL,
  currency               text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_cents            bigint NOT NULL CHECK (kauro.is_money(gross_cents)),
  fee_cents              bigint NOT NULL CHECK (kauro.is_money(fee_cents)),
  held_cents             bigint NOT NULL CHECK (kauro.is_money(held_cents)),
  withdrawn_cents        bigint NOT NULL CHECK (kauro.is_money(withdrawn_cents)),
  bank_available_cents   bigint NOT NULL CHECK (kauro.is_money(bank_available_cents)),
  bank_evidence_hash     text CHECK (bank_evidence_hash IS NULL OR kauro.is_sha256_hex(bank_evidence_hash)),
  fx_rate                numeric CHECK (fx_rate IS NULL OR fx_rate > 0),
  period_start           timestamptz NOT NULL,
  period_end             timestamptz NOT NULL,
  observed_at            timestamptz NOT NULL,
  evidence_hash          text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  created_at             timestamptz NOT NULL,
  UNIQUE (route_id, provider_balance_ref, observed_at),
  CONSTRAINT settlements_period CHECK (period_end > period_start),
  -- bank cash is what an observed statement shows, out of what was withdrawn (15; 21 "never grade from a screenshot")
  CONSTRAINT settlements_bank_evidence CHECK (bank_available_cents = 0 OR bank_evidence_hash IS NOT NULL),
  CONSTRAINT settlements_bank_within_withdrawn CHECK (bank_available_cents <= withdrawn_cents)
);
CREATE TRIGGER settlements_append_only BEFORE UPDATE OR DELETE ON kauro.settlements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- the operational ledger (D-LEDGER-B1..B3) ---------------------------------------------------------------------------------------------
-- Balanced postings of reconciled money movements only. A posting set has exactly one source — the domain event that records the
-- movement (a capture completed, the provider's fee, a refund completed, a chargeback) or a settlement observation — and that
-- source is its idempotency identity (registry LedgerEntry.eventId "Idempotent source event"): UNIQUE (event_id, line_no), so a
-- replayed delivery posts nothing new. Each set balances within its currency at COMMIT (KP001); a correction is a reversal entry
-- (same account, amount and currency, opposite direction, once) plus a new entry, never an edit. Append-only. An event-sourced
-- posting belongs to the event's agency; a settlement posting to none.
--
-- 15 "Operational ledger": "Every posting includes event ID, source object, amount/currency, effective date, observed date,
-- policy version and reversal relationship if applicable. Corrections add reversing/adjusting entries" (B09-F15, D-LEDGER-B4):
-- effective_at is the economic date of the movement, observed_at the instant the platform observed the fact it posts (never after
-- the posting), posted_at the instant of the posting. The source kind names the event that may source it
-- (ledger_entries_source_event): CAPTURE a capture's completion, FEE a fee learned after it (capture.fee_observed.v1), FUNDS a
-- change of the provider's availability of the captured funds (capture.funds_observed.v1: PSP_HELD to PSP_AVAILABLE), CHARGEBACK a
-- reversal, REFUND a refund's completion, CORRECTION the reviewed resolution of a reconciliation case
-- (reconciliation_case.resolved.v1: the decision whose reversing and adjusting entries correct an event-sourced posting) or a
-- settlement observation's own correction; SETTLEMENT a settlement observation.
ALTER TABLE kauro.domain_events ADD CONSTRAINT domain_events_agency_binding UNIQUE (event_id, agency_id);

CREATE TABLE kauro.ledger_entries (
  entry_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(entry_id)),
  agency_id         uuid REFERENCES kauro.agencies (agency_id),
  domain_event_id   uuid,
  settlement_id     uuid REFERENCES kauro.settlements (settlement_id),
  event_id          uuid GENERATED ALWAYS AS (coalesce(domain_event_id, settlement_id)) STORED,
  line_no           integer NOT NULL CHECK (line_no BETWEEN 1 AND 64),
  account_code      text NOT NULL CHECK (account_code IN ('PSP_RECEIVABLE', 'PSP_HELD', 'PSP_AVAILABLE', 'BANK_IN_TRANSIT', 'BANK_CASH', 'CONTRACT_LIABILITY', 'SERVICE_REVENUE', 'TAX_PAYABLE', 'CUSTOMER_OVERPAYMENT', 'REFUND_PAYABLE', 'PROCESSOR_EXPENSE', 'COMMISSION_PAYABLE', 'COMMISSION_EXPENSE', 'OWNER_CONTRIBUTION', 'OWNER_DISTRIBUTION')),
  account_version   text NOT NULL CHECK (account_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  direction         text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_cents      bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_kind       text NOT NULL CHECK (source_kind IN ('CAPTURE', 'REFUND', 'FEE', 'FUNDS', 'CHARGEBACK', 'SETTLEMENT', 'CORRECTION')),
  source_ref        uuid NOT NULL,
  reverses_entry_id uuid REFERENCES kauro.ledger_entries (entry_id),
  effective_at      timestamptz NOT NULL,
  observed_at       timestamptz NOT NULL,
  posted_at         timestamptz NOT NULL,
  evidence_hash     text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  policy_version    text NOT NULL CHECK (policy_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  UNIQUE (event_id, line_no),
  CONSTRAINT ledger_entries_event_fk FOREIGN KEY (domain_event_id, agency_id) REFERENCES kauro.domain_events (event_id, agency_id),
  CONSTRAINT ledger_entries_one_source CHECK ((domain_event_id IS NULL) <> (settlement_id IS NULL)),
  CONSTRAINT ledger_entries_source_scope CHECK (
    (domain_event_id IS NOT NULL AND agency_id IS NOT NULL AND source_kind <> 'SETTLEMENT')
    OR (settlement_id IS NOT NULL AND agency_id IS NULL AND source_kind IN ('SETTLEMENT', 'CORRECTION'))
  ),
  CONSTRAINT ledger_entries_observed_before_posting CHECK (observed_at <= posted_at)
);
CREATE UNIQUE INDEX ledger_entries_reversed_once ON kauro.ledger_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX ledger_entries_by_source ON kauro.ledger_entries (source_kind, source_ref);
CREATE INDEX ledger_entries_by_agency ON kauro.ledger_entries (agency_id, posted_at) WHERE agency_id IS NOT NULL;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON kauro.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- a reversal entry mirrors the entry it reverses (same account, amount and currency, the opposite direction)
CREATE OR REPLACE FUNCTION kauro.ledger_entries_reversal_mirrors() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.ledger_entries e
     WHERE e.entry_id = NEW.reverses_entry_id AND e.account_code = NEW.account_code AND e.amount_cents = NEW.amount_cents
       AND e.currency = NEW.currency AND e.direction <> NEW.direction AND e.agency_id IS NOT DISTINCT FROM NEW.agency_id
  ) THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: entry % does not mirror the entry % it reverses', NEW.entry_id, NEW.reverses_entry_id USING ERRCODE = 'KP001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ledger_entries_reversal_mirrors BEFORE INSERT ON kauro.ledger_entries
  FOR EACH ROW WHEN (NEW.reverses_entry_id IS NOT NULL) EXECUTE FUNCTION kauro.ledger_entries_reversal_mirrors();

-- an event-sourced posting's source kind names the event it records (D-LEDGER-B4): the ledger never posts a movement from an
-- event that did not record it — a correction is sourced by the reviewed resolution of its case (B09-F15)
CREATE OR REPLACE FUNCTION kauro.ledger_entries_source_event() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  source_type text;
BEGIN
  SELECT e.event_type INTO source_type FROM kauro.domain_events e WHERE e.event_id = NEW.domain_event_id AND e.agency_id = NEW.agency_id;
  IF source_type IS DISTINCT FROM (CASE NEW.source_kind
       WHEN 'CAPTURE' THEN 'capture.completed.v1'
       WHEN 'FEE' THEN 'capture.fee_observed.v1'
       WHEN 'FUNDS' THEN 'capture.funds_observed.v1'
       WHEN 'CHARGEBACK' THEN 'capture.reversed.v1'
       WHEN 'REFUND' THEN 'refund.completed.v1'
       WHEN 'CORRECTION' THEN 'reconciliation_case.resolved.v1'
     END) THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: a % posting cannot be sourced by event % (%)', NEW.source_kind, NEW.domain_event_id, coalesce(source_type, 'not visible') USING ERRCODE = 'KP001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ledger_entries_source_event BEFORE INSERT ON kauro.ledger_entries
  FOR EACH ROW WHEN (NEW.domain_event_id IS NOT NULL) EXECUTE FUNCTION kauro.ledger_entries_source_event();

-- each posting set balances within its currency and records one source (kind and reference), checked at COMMIT
CREATE OR REPLACE FUNCTION kauro.ledger_entries_balanced() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (SELECT coalesce(sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_cents ELSE -e.amount_cents END), 0)
        FROM kauro.ledger_entries e WHERE e.event_id = NEW.event_id AND e.currency = NEW.currency) <> 0 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: the posting set of % does not balance in %', NEW.event_id, NEW.currency USING ERRCODE = 'KP001';
  END IF;
  IF (SELECT count(DISTINCT (e.source_kind, e.source_ref, e.agency_id)) FROM kauro.ledger_entries e WHERE e.event_id = NEW.event_id) <> 1 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: the posting set of % mixes sources', NEW.event_id USING ERRCODE = 'KP001';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON kauro.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.ledger_entries_balanced();

-- --- row-level security ------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.tax_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.tax_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_documents_tenant_read ON kauro.tax_documents FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY tax_documents_finance_read ON kauro.tax_documents FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
-- the fiscal consumer drafts and validates in the adopted agency (issuance, CMD035, is the fiscal integration package's; Q-B09-6)
CREATE POLICY tax_documents_payment ON kauro.tax_documents FOR ALL TO kauro_payment
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY settlements_payment ON kauro.settlements FOR ALL TO kauro_payment USING (true) WITH CHECK (true);
CREATE POLICY settlements_owner_read ON kauro.settlements FOR SELECT TO kauro_app USING (kauro.holds_corporate_role('KAURO_OWNER'));
CREATE POLICY settlements_control_read ON kauro.settlements FOR SELECT TO kauro_control USING (true);

ALTER TABLE kauro.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.ledger_entries FORCE ROW LEVEL SECURITY;
-- the ledger poster posts the events of the agency it adopted, and platform-level settlement postings only with no agency adopted
CREATE POLICY ledger_entries_payment ON kauro.ledger_entries FOR ALL TO kauro_payment
  USING ((agency_id IS NOT NULL AND agency_id = kauro.current_agency_id()) OR (agency_id IS NULL AND kauro.current_agency_id() IS NULL))
  WITH CHECK ((agency_id IS NOT NULL AND agency_id = kauro.current_agency_id()) OR (agency_id IS NULL AND kauro.current_agency_id() IS NULL));
CREATE POLICY ledger_entries_finance_read ON kauro.ledger_entries FOR SELECT TO kauro_app
  USING (kauro.in_finance_scope(agency_id) OR (agency_id IS NULL AND kauro.holds_corporate_role('KAURO_OWNER')));

-- --- grants -------------------------------------------------------------------------------------------------------------------------------
GRANT SELECT ON kauro.tax_documents TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.tax_documents TO kauro_payment;
GRANT SELECT, INSERT ON kauro.settlements TO kauro_payment;
GRANT SELECT ON kauro.settlements TO kauro_app, kauro_control;
GRANT SELECT, INSERT ON kauro.ledger_entries TO kauro_payment;
GRANT SELECT ON kauro.ledger_entries TO kauro_app;
