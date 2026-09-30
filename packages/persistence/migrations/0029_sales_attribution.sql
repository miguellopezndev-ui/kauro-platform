-- 0029 — sellers, prospects, attribution claims and allocations, entitlements, assignments and the termination tail (package B10,
-- agency recurrence and commission domain): the corporate sales records of design §5 and the platform machines Seller, Prospect,
-- AttributionClaim, CommissionEntitlement and PayoutDestination.
--
-- Authority: 17 "Activation prerequisites", "Attribution subject", "Claim validity and conflicts", "Recurring entitlement",
-- "Assignment changes", "Termination and tail"; 12 "Seller onboarding and access lifecycle", "Prospect record", "Attribution and
-- assignment views", "Finance and cost controls" (a destination change requires step-up and a cooling/verification procedure);
-- 18 "Prospect qualification" and A3 3.7 (prospects are agencies; D58); 07 "Database representation"; 08 "Database isolation",
-- "Corporate operators and sellers use individually managed corporate identities"; registry SellerAgreement, Prospect,
-- AttributionClaim, CommissionEntitlement; policy commission (acceptedClaimDays 90, terminationOpportunityTailDays 90,
-- recurrenceCalendarMonths 12, operationalTimezone America/Bogota, calendarMonthRollover CLAMP_DAY_TO_LAST_DAY_OF_DESTINATION_MONTH,
-- windowAnchor FIRST_DURABLE_CAPTURE_CONFIRMATION); COMMERCIAL_LEDGER_WORKED_EXAMPLES 8, 11, 12, 13, 22. Design:
-- docs/design/B10-commercial-domain.md §2, §5, §8.2, §9, §10 (D10-CTX-2, D10-CTX-3, D10-SELL-1..3, D10-PROS-1, D10-CLAIM-1,
-- D10-ATTR-1, D10-ATTR-2, D10-ASSIGN-1, D10-ASSIGN-2, D10-ASSIST-1, D10-TERM-1, D10-TX-1, D10-EVT-1). This file adds tables,
-- triggers, policies and grants; it edits no B06 or B09 rule. On 0028's tables it adds two keys (binding targets) and read policies.
--
-- Principals (D10-CTX-1..3): the corporate owner and the sellers act on kauro_app in an OPERATOR session (their person bound, no
-- agency); the commission service on kauro_commission. These are corporate records: the owner reads all, a seller its own rows, the
-- commission service all it works with, and no tenant policy exists — an agency never reads attribution, seller or compensation rows.
--
-- SQLSTATE vocabulary (class KC, design §12; the stage-2 adapters translate each):
--   KC003 SHARES_NOT_WHOLE  KC005 SELLER_NOT_ACTIVATABLE  KC011 TAIL_NOT_ENUMERATED  KC016 PROSPECT_SUPPRESSED

-- --- field helpers -------------------------------------------------------------------------------------------------------------------
-- A non-empty, NULL-free, duplicate-free list of machine tokens (the activity kinds of claim evidence).
CREATE OR REPLACE FUNCTION kauro.is_token_set(v text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT cardinality(v) BETWEEN 1 AND 32 AND coalesce(array_ndims(v), 1) = 1 AND array_position(v, NULL) IS NULL
     AND cardinality(v) = (SELECT count(DISTINCT x) FROM unnest(v) AS x)
     AND NOT EXISTS (SELECT 1 FROM unnest(v) AS x WHERE NOT kauro.is_token(x))
$$;

-- The instant of a row the writer records "now" is the server's (D10-CLOCK-1): TG_ARGV are the columns that must equal
-- kauro.server_now(). Named check violation <table>_server_instant (23514).
CREATE OR REPLACE FUNCTION kauro.require_server_instant() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  new_j jsonb := to_jsonb(NEW);
  i integer;
BEGIN
  FOR i IN 0 .. TG_NARGS - 1 LOOP
    IF (new_j ->> TG_ARGV[i])::timestamptz IS DISTINCT FROM kauro.server_now() THEN
      RAISE EXCEPTION 'SERVER_INSTANT: %.% is recorded at the server''s instant', TG_TABLE_NAME, TG_ARGV[i]
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_server_instant', SCHEMA = 'kauro', TABLE = TG_TABLE_NAME;
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- --- the history of B10's corporate machines (D10-EVT-1, D10-CTX-3) ------------------------------------------------------------------
-- The sales and commission aggregates publish no domain event: their history is kauro.commercial_transitions (0028), recorded by
-- this writer's half with no agency — a corporate record's history is never readable by a tenant session, even when the row names
-- the agency it concerns. AFTER INSERT OR UPDATE OF state; TG_ARGV[0] the machine, [1] the id column, [2] the state column.
CREATE OR REPLACE FUNCTION kauro.record_corporate_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  new_j jsonb := to_jsonb(NEW);
  old_state text := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ->> TG_ARGV[2] END;
  new_state text := to_jsonb(NEW) ->> TG_ARGV[2];
BEGIN
  IF TG_OP = 'UPDATE' AND old_state IS NOT DISTINCT FROM new_state THEN
    RETURN NULL;
  END IF;
  INSERT INTO kauro.commercial_transitions (machine, subject_id, subject_version, agency_id, from_state, to_state, actor_user_id, recorded_at)
  VALUES (TG_ARGV[0], (new_j ->> TG_ARGV[1])::uuid, (new_j ->> 'version')::bigint, NULL, old_state, new_state, kauro.current_user_id(), kauro.server_now());
  RETURN NULL;
END
$$;

-- --- the platform machines of 0029 (design §8.2; @kauro/domain COMMERCIAL_PLATFORM_MACHINES; the persistence tests prove them equal)
INSERT INTO kauro.state_machines (machine, initial_state) VALUES
  ('Seller', 'CANDIDATE'),
  ('Prospect', 'RESEARCHED'),
  ('AttributionClaim', 'SUBMITTED'),
  ('CommissionEntitlement', 'ACTIVE'),
  ('PayoutDestination', 'PENDING_VERIFICATION');
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Seller', 'CANDIDATE', 'ACTIVE'),
  ('Seller', 'ACTIVE', 'SUSPENDED'),
  ('Seller', 'SUSPENDED', 'ACTIVE'),
  ('Seller', 'ACTIVE', 'TERMINATED'),
  ('Seller', 'SUSPENDED', 'TERMINATED'),
  ('Seller', 'CANDIDATE', 'TERMINATED'),
  ('Prospect', 'RESEARCHED', 'QUALIFIED'),
  ('Prospect', 'QUALIFIED', 'CONTACTED'),
  ('Prospect', 'CONTACTED', 'ENGAGED'),
  ('Prospect', 'ENGAGED', 'OPPORTUNITY'),
  ('Prospect', 'OPPORTUNITY', 'WON'),
  ('Prospect', 'RESEARCHED', 'LOST'),
  ('Prospect', 'QUALIFIED', 'LOST'),
  ('Prospect', 'CONTACTED', 'LOST'),
  ('Prospect', 'ENGAGED', 'LOST'),
  ('Prospect', 'OPPORTUNITY', 'LOST'),
  ('Prospect', 'LOST', 'RESEARCHED'),
  ('Prospect', 'RESEARCHED', 'SUPPRESSED'),
  ('Prospect', 'QUALIFIED', 'SUPPRESSED'),
  ('Prospect', 'CONTACTED', 'SUPPRESSED'),
  ('Prospect', 'ENGAGED', 'SUPPRESSED'),
  ('Prospect', 'OPPORTUNITY', 'SUPPRESSED'),
  ('Prospect', 'LOST', 'SUPPRESSED'),
  ('Prospect', 'WON', 'SUPPRESSED'),
  ('AttributionClaim', 'SUBMITTED', 'DISPUTED'),
  ('AttributionClaim', 'SUBMITTED', 'ACCEPTED'),
  ('AttributionClaim', 'DISPUTED', 'ACCEPTED'),
  ('AttributionClaim', 'SUBMITTED', 'REJECTED'),
  ('AttributionClaim', 'DISPUTED', 'REJECTED'),
  ('AttributionClaim', 'SUBMITTED', 'EXPIRED'),
  ('AttributionClaim', 'DISPUTED', 'EXPIRED'),
  ('AttributionClaim', 'ACCEPTED', 'EXPIRED'),
  ('AttributionClaim', 'ACCEPTED', 'CONVERTED'),
  ('CommissionEntitlement', 'ACTIVE', 'EXPIRED'),
  ('CommissionEntitlement', 'ACTIVE', 'TERMINATED_WITH_RESIDUAL'),
  ('CommissionEntitlement', 'ACTIVE', 'DISPUTED'),
  ('CommissionEntitlement', 'DISPUTED', 'ACTIVE'),
  ('CommissionEntitlement', 'DISPUTED', 'TERMINATED_WITH_RESIDUAL'),
  ('CommissionEntitlement', 'DISPUTED', 'EXPIRED'),
  ('CommissionEntitlement', 'TERMINATED_WITH_RESIDUAL', 'EXPIRED'),
  ('PayoutDestination', 'PENDING_VERIFICATION', 'VERIFIED'),
  ('PayoutDestination', 'PENDING_VERIFICATION', 'REJECTED'),
  ('PayoutDestination', 'VERIFIED', 'SUPERSEDED');

-- --- sellers (platform machine Seller; D10-SELL-1, D10-CTX-2) -------------------------------------------------------------------------
-- One seller per individually managed corporate identity. Born CANDIDATE by the corporate owner; ACTIVE only with the activation facts
-- of 17 "Activation prerequisites" repeated by the database (KC005) under the agreement it was activated on — its compensation
-- version, the agreement version its claims name; TERMINATED at the effective instant of a recorded termination (or, a candidate never
-- engaged, with no agreement signed). The transition subject kauro.sellers (seller): a seller's writes read its state after the shared
-- half, its transitions take the exclusive half (D10-TX-1).
CREATE TABLE kauro.sellers (
  seller_id                 uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(seller_id)),
  user_id                   uuid NOT NULL REFERENCES kauro.identities (user_id),
  display_label             text NOT NULL CHECK (kauro.is_label(display_label)),
  version                   bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                     text NOT NULL DEFAULT 'CANDIDATE' CHECK (state IN ('CANDIDATE', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
  agreement_id              uuid,
  activation_assessment_id  uuid,
  activated_by_user_id      uuid,
  activation_proof_ref      uuid,
  activated_at              timestamptz,
  terminated_at             timestamptz,
  created_by_user_id        uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  CONSTRAINT sellers_one_per_identity UNIQUE (user_id),
  -- binding target: a row naming a seller and its identity names exactly this pair
  UNIQUE (seller_id, user_id),
  -- the owner's own step-up authorized the activation (08 "High-impact actions require recent step-up")
  CONSTRAINT sellers_activation_proof_fk FOREIGN KEY (activated_by_user_id, activation_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id),
  CONSTRAINT sellers_activation_record CHECK (
    (activated_at IS NULL) = (activated_by_user_id IS NULL) AND (activated_at IS NULL) = (activation_proof_ref IS NULL)
    AND (activated_at IS NULL) = (activation_assessment_id IS NULL) AND (activated_at IS NULL) = (agreement_id IS NULL)
  ),
  CONSTRAINT sellers_activated_states CHECK (state NOT IN ('ACTIVE', 'SUSPENDED') OR activated_at IS NOT NULL),
  CONSTRAINT sellers_terminated_at CHECK ((state = 'TERMINATED') = (terminated_at IS NOT NULL))
);

-- The session's seller (D10-CTX-2): the seller row of the person an OPERATOR session binds, whatever its state (a terminated seller
-- keeps its statement access, 12 "Seller onboarding and access lifecycle"); NULL for a session bound to an agency or to no person.
-- SECURITY INVOKER: it reads through the caller's policies (sellers_self_read admits the caller's own row).
CREATE OR REPLACE FUNCTION kauro.current_seller_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT s.seller_id FROM kauro.sellers s WHERE kauro.current_agency_id() IS NULL AND s.user_id = kauro.current_user_id() $$;

-- The session's seller while it is ACTIVE: seller writes are admitted only then (D10-CTX-2).
CREATE OR REPLACE FUNCTION kauro.acting_seller_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT s.seller_id FROM kauro.sellers s WHERE kauro.current_agency_id() IS NULL AND s.user_id = kauro.current_user_id() AND s.state = 'ACTIVE' $$;

-- The corporate owner acting as itself (an OPERATOR session: its person bound, no agency) with an ACTIVE KAURO_OWNER grant (B09
-- D-CORP-B1). Never called in a kauro_commission session, which reads no corporate grant.
CREATE OR REPLACE FUNCTION kauro.acting_corporate_owner() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT kauro.current_agency_id() IS NULL AND kauro.holds_corporate_role('KAURO_OWNER') $$;

-- --- the seller's onboarding records (D10-SELL-1, D10-SELL-3) --------------------------------------------------------------------------
-- The reviewed classification of the relationship's substance (17 "Legal engagement packet": a contract label does not establish
-- the classification), the capability assessment, the confidentiality and data-handling acceptance and the verified tax
-- documentation: each a record of the corporate owner, append-only, read by the owner alone (17 "Sensitive identity, bank and tax
-- documents are stored securely with limited finance access").
CREATE TABLE kauro.seller_legal_reviews (
  review_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(review_id)),
  seller_id            uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  classification       text NOT NULL CHECK (classification IN ('INDEPENDENT_COLLABORATION', 'EMPLOYMENT', 'OTHER_REVIEWED')),
  outcome              text NOT NULL CHECK (outcome IN ('CONFIRMED', 'NOT_CONFIRMED')),
  substance_hash       text NOT NULL CHECK (kauro.is_sha256_hex(substance_hash)),
  reviewer_label       text NOT NULL CHECK (kauro.is_label(reviewer_label)),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  reviewed_at          timestamptz NOT NULL,
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at           timestamptz NOT NULL,
  -- binding target of seller_agreements_review_fk: an agreement names a review of its own seller and classification
  UNIQUE (seller_id, review_id, classification)
);

-- SellerAgreement (registry) plus the offset terms, the monthly retainer and the compensation policy version (design §5). Prepared by
-- the owner with the exact operative text (signed_terms_hash); signed once (signed_at with the signature's evidence); ended once. The
-- recurring window is the registry's twelve calendar months (policy recurrenceCalendarMonths).
CREATE TABLE kauro.seller_agreements (
  agreement_id                 uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(agreement_id)),
  seller_id                    uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  agreement_version            text NOT NULL CHECK (kauro.is_label(agreement_version)),
  classification               text NOT NULL CHECK (classification IN ('INDEPENDENT_COLLABORATION', 'EMPLOYMENT', 'OTHER_REVIEWED')),
  legal_review_id              uuid NOT NULL,
  starts_at                    timestamptz NOT NULL,
  ends_at                      timestamptz,
  first_bps                    integer NOT NULL CHECK (first_bps BETWEEN 0 AND 10000),
  repeat_bps                   integer NOT NULL CHECK (repeat_bps BETWEEN 0 AND 10000),
  recurring_months             integer NOT NULL CHECK (recurring_months = 12),
  offset_terms                 text NOT NULL CHECK (offset_terms IN ('NONE', 'SIGNED_FUTURE_OFFSET')),
  retainer_cents_per_month     bigint NOT NULL DEFAULT 0 CHECK (kauro.is_money(retainer_cents_per_month)),
  compensation_policy_version  text NOT NULL CHECK (kauro.is_label(compensation_policy_version)),
  signed_terms_hash            text NOT NULL CHECK (kauro.is_sha256_hex(signed_terms_hash)),
  signed_at                    timestamptz,
  signature_evidence_hash      text CHECK (signature_evidence_hash IS NULL OR kauro.is_sha256_hex(signature_evidence_hash)),
  version                      bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  prepared_by_user_id          uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at                   timestamptz NOT NULL,
  updated_at                   timestamptz NOT NULL,
  UNIQUE (seller_id, agreement_id),
  CONSTRAINT seller_agreements_one_per_version UNIQUE (seller_id, agreement_version),
  -- binding targets: a claim or entitlement names its seller's agreement by id and version; a share names its pool terms too
  UNIQUE (seller_id, agreement_id, agreement_version),
  CONSTRAINT seller_agreements_pool_terms UNIQUE (seller_id, agreement_id, agreement_version, first_bps, repeat_bps, recurring_months),
  CONSTRAINT seller_agreements_review_fk FOREIGN KEY (seller_id, legal_review_id, classification) REFERENCES kauro.seller_legal_reviews (seller_id, review_id, classification),
  CONSTRAINT seller_agreements_signature CHECK ((signed_at IS NULL) = (signature_evidence_hash IS NULL)),
  CONSTRAINT seller_agreements_term CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE kauro.seller_assessments (
  assessment_id        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(assessment_id)),
  seller_id            uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  outcome              text NOT NULL CHECK (outcome IN ('PASSED', 'NOT_PASSED')),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  assessed_at          timestamptz NOT NULL,
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at           timestamptz NOT NULL,
  UNIQUE (seller_id, assessment_id)
);

CREATE TABLE kauro.seller_confidentiality_acceptances (
  acceptance_id        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(acceptance_id)),
  seller_id            uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  terms_hash           text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  accepted_at          timestamptz NOT NULL,
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at           timestamptz NOT NULL
);

-- the validated requirements of the seller's profile and the evidence they are met (17 "Currency, fees and tax documentation"; Q10-9)
CREATE TABLE kauro.seller_tax_documents (
  document_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(document_id)),
  seller_id            uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  jurisdiction         text NOT NULL CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  requirements_hash    text NOT NULL CHECK (kauro.is_sha256_hex(requirements_hash)),
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  verified_at          timestamptz NOT NULL,
  verified_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at           timestamptz NOT NULL
);

ALTER TABLE kauro.sellers ADD CONSTRAINT sellers_agreement_fk FOREIGN KEY (seller_id, agreement_id) REFERENCES kauro.seller_agreements (seller_id, agreement_id);
ALTER TABLE kauro.sellers ADD CONSTRAINT sellers_assessment_fk FOREIGN KEY (seller_id, activation_assessment_id) REFERENCES kauro.seller_assessments (seller_id, assessment_id);

-- --- payout destinations (platform machine PayoutDestination; D10-SELL-2, R2-103) ------------------------------------------------------
-- A version of the seller's destination: the masked label and the digest of the account details (the details themselves are the
-- payout adapter's, B15). Written by the seller itself — the change is the seller's own fact, recorded before activation and kept
-- after termination — and VERIFIED only when the change carried the seller's own fresh step-up and an owner verifies it at least
-- 172 800 s after the change (12 "Changing a payout destination requires step-up and a cooling/verification procedure"; Q10-5): a
-- change without that proof (an unauthenticated e-mail) never verifies. One VERIFIED version per seller; a later one supersedes it.
CREATE TABLE kauro.seller_payout_destinations (
  destination_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(destination_id)),
  seller_id            uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  destination_version  integer NOT NULL CHECK (destination_version >= 1),
  masked_label         text NOT NULL CHECK (kauro.is_label(masked_label)),
  destination_digest   text NOT NULL CHECK (kauro.is_sha256_hex(destination_digest)),
  currency             text NOT NULL CHECK (currency IN ('USD', 'COP')),
  version              bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                text NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (state IN ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'SUPERSEDED')),
  changed_by_user_id   uuid NOT NULL,
  change_proof_ref     uuid,
  changed_at           timestamptz NOT NULL,
  verified_by_user_id  uuid REFERENCES kauro.identities (user_id),
  verified_at          timestamptz,
  rejected_at          timestamptz,
  superseded_at        timestamptz,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  CONSTRAINT seller_payout_destinations_one_per_version UNIQUE (seller_id, destination_version),
  -- binding target of payout_intents: an intent keeps exactly the destination version and digest it was approved with
  UNIQUE (seller_id, destination_id, destination_version, destination_digest),
  CONSTRAINT seller_payout_destinations_changer_fk FOREIGN KEY (seller_id, changed_by_user_id) REFERENCES kauro.sellers (seller_id, user_id),
  CONSTRAINT seller_payout_destinations_proof_fk FOREIGN KEY (changed_by_user_id, change_proof_ref) REFERENCES kauro.assurance_proofs (user_id, proof_id),
  CONSTRAINT seller_payout_destinations_verified_record CHECK ((verified_at IS NULL) = (verified_by_user_id IS NULL) AND (state NOT IN ('VERIFIED', 'SUPERSEDED') OR verified_at IS NOT NULL)),
  CONSTRAINT seller_payout_destinations_rejected_record CHECK ((state = 'REJECTED') = (rejected_at IS NOT NULL)),
  CONSTRAINT seller_payout_destinations_superseded_record CHECK ((state = 'SUPERSEDED') = (superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX seller_payout_destinations_one_verified ON kauro.seller_payout_destinations (seller_id) WHERE state = 'VERIFIED';

-- --- prospects (platform machine Prospect; D10-PROS-1) ---------------------------------------------------------------------------------
-- Source evidence (18 "Prospect qualification", A3 3.7, D58): a dated, lawful, agency-segment observation recorded by the caller —
-- the only segment the table admits — named by a prospect through its hash.
CREATE TABLE kauro.prospect_source_evidence (
  evidence_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(evidence_id)),
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  seller_id            uuid,
  evidence_hash        text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  source_url_digest    text NOT NULL CHECK (kauro.is_sha256_hex(source_url_digest)),
  observed_on          date NOT NULL,
  lawful_basis         text NOT NULL CHECK (kauro.is_token(lawful_basis)),
  segment              text NOT NULL CONSTRAINT prospect_source_evidence_agency_segment CHECK (segment = 'AGENCY'),
  created_at           timestamptz NOT NULL,
  CONSTRAINT prospect_source_evidence_one_per_recorder UNIQUE (recorded_by_user_id, evidence_hash),
  CONSTRAINT prospect_source_evidence_seller_fk FOREIGN KEY (seller_id, recorded_by_user_id) REFERENCES kauro.sellers (seller_id, user_id)
);

-- A restricted business contact (registry Prospect.businessContactRef "not raw details in reports"): its key (a digest of the
-- normalized contact, the suppression key) and a restricted label; the views withhold it (D10-API-1).
CREATE TABLE kauro.prospect_contacts (
  contact_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(contact_id)),
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  contact_key          text NOT NULL CHECK (kauro.is_sha256_hex(contact_key)),
  contact_label        text NOT NULL CHECK (kauro.is_label(contact_label)),
  role_label           text CHECK (role_label IS NULL OR kauro.is_label(role_label)),
  channel              text NOT NULL CHECK (kauro.is_token(channel)),
  created_at           timestamptz NOT NULL,
  UNIQUE (recorded_by_user_id, contact_id)
);

-- Born RESEARCHED, minimized and owned by the registering seller (or by nobody, registered by the owner); its organization key is
-- KAURO_PROSPECT_ORGANIZATION_V1 over the normalized business domain, one live prospect per key (PROSPECT_EXISTS); a suppressed
-- organization or contact key refuses registration however the label is spelled (KC016). Its source evidence and contact are the
-- registrar's own.
CREATE TABLE kauro.prospects (
  prospect_id              uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(prospect_id)),
  organization_label       text NOT NULL CHECK (kauro.is_label(organization_label)),
  organization_key         text NOT NULL CHECK (kauro.is_sha256_hex(organization_key)),
  business_contact_id      uuid,
  source_evidence_hash     text NOT NULL,
  jurisdiction             text NOT NULL CHECK (kauro.is_label(jurisdiction)),
  registered_by_user_id    uuid NOT NULL REFERENCES kauro.identities (user_id),
  registered_by_seller_id  uuid,
  owner_seller_id          uuid REFERENCES kauro.sellers (seller_id),
  version                  bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                    text NOT NULL DEFAULT 'RESEARCHED' CHECK (state IN ('RESEARCHED', 'QUALIFIED', 'CONTACTED', 'ENGAGED', 'OPPORTUNITY', 'WON', 'LOST', 'SUPPRESSED')),
  suppressed               boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  CONSTRAINT prospects_source_evidence_fk FOREIGN KEY (registered_by_user_id, source_evidence_hash) REFERENCES kauro.prospect_source_evidence (recorded_by_user_id, evidence_hash),
  CONSTRAINT prospects_contact_fk FOREIGN KEY (registered_by_user_id, business_contact_id) REFERENCES kauro.prospect_contacts (recorded_by_user_id, contact_id),
  CONSTRAINT prospects_registrar_fk FOREIGN KEY (registered_by_seller_id, registered_by_user_id) REFERENCES kauro.sellers (seller_id, user_id),
  -- registry Prospect.suppressed: the global no-send control is the suppressed state
  CONSTRAINT prospects_suppressed_state CHECK (suppressed = (state = 'SUPPRESSED'))
);
CREATE UNIQUE INDEX prospects_one_live_per_organization ON kauro.prospects (organization_key) WHERE state <> 'SUPPRESSED';

-- Suppression by organization key or contact key, which survives spelling and re-import (D10-PROS-1); append-only.
CREATE TABLE kauro.prospect_suppressions (
  suppression_id       uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(suppression_id)),
  key_kind             text NOT NULL CHECK (key_kind IN ('ORGANIZATION', 'CONTACT')),
  suppression_key      text NOT NULL CHECK (kauro.is_sha256_hex(suppression_key)),
  reason               text NOT NULL CHECK (kauro.is_token(reason)),
  evidence_hash        text CHECK (evidence_hash IS NULL OR kauro.is_sha256_hex(evidence_hash)),
  recorded_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  recorded_at          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL,
  CONSTRAINT prospect_suppressions_one_per_key UNIQUE (key_kind, suppression_key)
);

-- --- claims, allocations and shares (platform machine AttributionClaim; D10-CLAIM-1, D10-ATTR-1) ---------------------------------------
-- Substantive evidence of the seller's work on the prospect (17 "Attribution subject": first meaningful contact, qualified need,
-- supporting activity); named by a claim through its hash.
CREATE TABLE kauro.claim_evidence (
  evidence_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(evidence_id)),
  seller_id                    uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  prospect_id                  uuid NOT NULL REFERENCES kauro.prospects (prospect_id),
  evidence_hash                text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  source_channel               text NOT NULL CHECK (kauro.is_token(source_channel)),
  first_meaningful_contact_at  timestamptz NOT NULL,
  qualified_need_hash          text NOT NULL CHECK (kauro.is_sha256_hex(qualified_need_hash)),
  activity_kinds               text[] NOT NULL CHECK (kauro.is_token_set(activity_kinds)),
  recorded_at                  timestamptz NOT NULL,
  created_at                   timestamptz NOT NULL,
  CONSTRAINT claim_evidence_one_per_seller UNIQUE (seller_id, evidence_hash),
  UNIQUE (seller_id, prospect_id, evidence_hash),
  -- backdated notes do not create retroactive entitlement (17): the contact precedes the record
  CONSTRAINT claim_evidence_contact_precedes_record CHECK (first_meaningful_contact_at <= recorded_at)
);

-- The owner-prepared ruling on the claims of one prospect (CMD047): the agency the prospect is (its identity evidence), the ruling
-- reason (never timestamps alone, 17 "Claim validity and conflicts"), the pool terms, and — once frozen — nothing changes. One frozen
-- allocation per agency (ATTRIBUTION_EXISTS: "the pool does not become 10% for each seller"); its shares sum to exactly 10 000 bps
-- at COMMIT (KC003).
CREATE TABLE kauro.attribution_allocations (
  allocation_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(allocation_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  prospect_id             uuid NOT NULL REFERENCES kauro.prospects (prospect_id),
  identity_evidence_hash  text NOT NULL CHECK (kauro.is_sha256_hex(identity_evidence_hash)),
  ruling_reason           text NOT NULL CHECK (kauro.is_label(ruling_reason)),
  ruling_evidence_hash    text NOT NULL CHECK (kauro.is_sha256_hex(ruling_evidence_hash)),
  first_bps               integer NOT NULL CHECK (first_bps BETWEEN 0 AND 10000),
  repeat_bps              integer NOT NULL CHECK (repeat_bps BETWEEN 0 AND 10000),
  recurring_months        integer NOT NULL CHECK (recurring_months = 12),
  prepared_by_user_id     uuid NOT NULL REFERENCES kauro.identities (user_id),
  prepared_at             timestamptz NOT NULL,
  frozen_at               timestamptz,
  frozen_by_user_id       uuid REFERENCES kauro.identities (user_id),
  version                 bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  -- binding targets: a claim ruled by the allocation carries its agency and prospect; a share its pool terms
  UNIQUE (allocation_id, agency_id),
  UNIQUE (allocation_id, agency_id, prospect_id),
  CONSTRAINT attribution_allocations_pool_terms UNIQUE (allocation_id, prospect_id, first_bps, repeat_bps, recurring_months),
  CONSTRAINT attribution_allocations_frozen_record CHECK ((frozen_at IS NULL) = (frozen_by_user_id IS NULL))
);
CREATE UNIQUE INDEX attribution_allocations_one_per_agency ON kauro.attribution_allocations (agency_id) WHERE frozen_at IS NOT NULL;

-- A seller's claim on a prospect under its active agreement version with substantive evidence, born SUBMITTED with a 2160-hour
-- review deadline (policy acceptedClaimDays 90); DISPUTED in the same transaction when a conflict is found; ACCEPTED or REJECTED by a
-- frozen allocation, an accepted claim running 2160 hours from its acceptance; EXPIRED when its time passed or its seller was
-- terminated without listing it; CONVERTED at the agency's first qualifying purchase. One live claim per seller and prospect
-- (CLAIM_EXISTS). Claims of one prospect serialize on the transition subject kauro.attribution_claims (prospect) (D10-TX-1).
CREATE TABLE kauro.attribution_claims (
  claim_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(claim_id)),
  prospect_id         uuid NOT NULL REFERENCES kauro.prospects (prospect_id),
  seller_id           uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  agreement_id        uuid NOT NULL,
  agreement_version   text NOT NULL,
  evidence_hash       text NOT NULL,
  version             bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state               text NOT NULL DEFAULT 'SUBMITTED' CHECK (state IN ('SUBMITTED', 'ACCEPTED', 'DISPUTED', 'REJECTED', 'EXPIRED', 'CONVERTED')),
  submitted_at        timestamptz NOT NULL,
  review_deadline_at  timestamptz NOT NULL,
  conflict_reason     text CHECK (conflict_reason IS NULL OR kauro.is_token(conflict_reason)),
  agency_id           uuid REFERENCES kauro.agencies (agency_id),
  allocation_id       uuid,
  accepted_at         timestamptz,
  expires_at          timestamptz,
  rejected_at         timestamptz,
  lapsed_at           timestamptz,
  converted_at        timestamptz,
  decided_by_user_id  uuid REFERENCES kauro.identities (user_id),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  -- binding targets: a share names the beneficiary's claim on the allocation's prospect under its agreement; a tail entry the claim
  -- of its seller and agency
  UNIQUE (claim_id, seller_id, prospect_id, agreement_id, agreement_version),
  UNIQUE (claim_id, seller_id, agency_id),
  CONSTRAINT attribution_claims_agreement_fk FOREIGN KEY (seller_id, agreement_id, agreement_version) REFERENCES kauro.seller_agreements (seller_id, agreement_id, agreement_version),
  CONSTRAINT attribution_claims_evidence_fk FOREIGN KEY (seller_id, prospect_id, evidence_hash) REFERENCES kauro.claim_evidence (seller_id, prospect_id, evidence_hash),
  CONSTRAINT attribution_claims_allocation_fk FOREIGN KEY (allocation_id, agency_id, prospect_id) REFERENCES kauro.attribution_allocations (allocation_id, agency_id, prospect_id),
  CONSTRAINT attribution_claims_review_deadline CHECK (review_deadline_at = submitted_at + interval '2160 hours'),
  CONSTRAINT attribution_claims_acceptance_window CHECK ((accepted_at IS NULL) = (expires_at IS NULL) AND (expires_at IS NULL OR expires_at = accepted_at + interval '2160 hours')),
  CONSTRAINT attribution_claims_ruling_record CHECK (
    (allocation_id IS NULL) = (agency_id IS NULL)
    AND (state NOT IN ('ACCEPTED', 'CONVERTED') OR (accepted_at IS NOT NULL AND allocation_id IS NOT NULL))
    AND ((state = 'REJECTED') = (rejected_at IS NOT NULL)) AND (rejected_at IS NULL OR allocation_id IS NOT NULL)
    AND (accepted_at IS NULL OR rejected_at IS NULL)
  ),
  CONSTRAINT attribution_claims_lapse_record CHECK ((state = 'EXPIRED') = (lapsed_at IS NOT NULL)),
  CONSTRAINT attribution_claims_conversion_record CHECK ((state = 'CONVERTED') = (converted_at IS NOT NULL)),
  CONSTRAINT attribution_claims_dispute_record CHECK (state <> 'DISPUTED' OR conflict_reason IS NOT NULL)
);
CREATE UNIQUE INDEX attribution_claims_one_live_per_seller ON kauro.attribution_claims (seller_id, prospect_id) WHERE state IN ('SUBMITTED', 'DISPUTED', 'ACCEPTED');
CREATE INDEX attribution_claims_due ON kauro.attribution_claims (state, review_deadline_at);

-- One beneficiary of an allocation: its claim on the allocation's prospect, its share and the pool terms, which are the allocation's and
-- exactly its own signed agreement's (so two sellers' shares can never make two full pools). Written while the allocation is prepared;
-- never changed once it is frozen.
CREATE TABLE kauro.allocation_shares (
  allocation_id      uuid NOT NULL,
  seller_id          uuid NOT NULL,
  claim_id           uuid NOT NULL,
  prospect_id        uuid NOT NULL,
  agreement_id       uuid NOT NULL,
  agreement_version  text NOT NULL,
  share_bps          integer NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  first_bps          integer NOT NULL,
  repeat_bps         integer NOT NULL,
  recurring_months   integer NOT NULL,
  created_at         timestamptz NOT NULL,
  PRIMARY KEY (allocation_id, seller_id),
  CONSTRAINT allocation_shares_one_per_claim UNIQUE (allocation_id, claim_id),
  -- binding target of commission_entitlements: an entitlement is exactly one share
  CONSTRAINT allocation_shares_entitlement_binding UNIQUE (allocation_id, seller_id, claim_id, agreement_id, agreement_version, share_bps),
  CONSTRAINT allocation_shares_allocation_terms_fk FOREIGN KEY (allocation_id, prospect_id, first_bps, repeat_bps, recurring_months)
    REFERENCES kauro.attribution_allocations (allocation_id, prospect_id, first_bps, repeat_bps, recurring_months),
  CONSTRAINT allocation_shares_agreement_terms_fk FOREIGN KEY (seller_id, agreement_id, agreement_version, first_bps, repeat_bps, recurring_months)
    REFERENCES kauro.seller_agreements (seller_id, agreement_id, agreement_version, first_bps, repeat_bps, recurring_months),
  CONSTRAINT allocation_shares_claim_fk FOREIGN KEY (claim_id, seller_id, prospect_id, agreement_id, agreement_version)
    REFERENCES kauro.attribution_claims (claim_id, seller_id, prospect_id, agreement_id, agreement_version)
);

-- --- assistance agreements (D10-ASSIST-1, R2-099) --------------------------------------------------------------------------------------
-- A prospective, project-specific (or next-purchase) assistance arrangement signed before the work (17 "Recurring entitlement"; A3
-- 7.1: 400 bps by default, 1000 bps for an inbound buyer's complete closing effort): its pool applies only to a purchase whose order
-- was created after the signing, beside the acquisition pool and never reducing it. Append-only.
CREATE TABLE kauro.assistance_agreements (
  assistance_agreement_id  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(assistance_agreement_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  seller_id                uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  agreement_id             uuid NOT NULL,
  agreement_version        text NOT NULL,
  scope                    text NOT NULL CHECK (scope IN ('PROJECT', 'NEXT_PURCHASE')),
  project_id               uuid,
  rate_bps                 integer NOT NULL CHECK (rate_bps BETWEEN 1 AND 10000),
  terms_hash               text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  signed_at                timestamptz NOT NULL,
  recorded_by_user_id      uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at               timestamptz NOT NULL,
  -- binding targets: a pool, a service assignment and an entitlement name an assistance agreement of their own agency and seller
  UNIQUE (agency_id, assistance_agreement_id),
  UNIQUE (agency_id, assistance_agreement_id, seller_id),
  UNIQUE (agency_id, assistance_agreement_id, seller_id, agreement_id, agreement_version),
  CONSTRAINT assistance_agreements_agreement_fk FOREIGN KEY (seller_id, agreement_id, agreement_version) REFERENCES kauro.seller_agreements (seller_id, agreement_id, agreement_version),
  CONSTRAINT assistance_agreements_project_fk FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  CONSTRAINT assistance_agreements_scope CHECK ((scope = 'PROJECT') = (project_id IS NOT NULL))
);

-- --- entitlements (platform machine CommissionEntitlement; D10-ATTR-2, R2-094) ---------------------------------------------------------
-- ACQUISITION: one per beneficiary of the agency's frozen allocation, created by the commission service when the claim converts at the
-- agency's first qualifying purchase; its window starts at that purchase's confirmation (policy windowAnchor
-- FIRST_DURABLE_CAPTURE_CONFIRMATION: the agency's sticky first designation) and ends exclusively twelve calendar months later at
-- the same America/Bogota wall time with the day clamped (PostgreSQL's month arithmetic clamps it). ASSISTANCE: the one entitlement
-- of an assistance agreement, whose pool the commission service opens. First capture, window, share and agreement are immutable.
-- The transition subject kauro.commission_entitlements (entitlement) (D10-TX-1).
CREATE TABLE kauro.commission_entitlements (
  entitlement_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(entitlement_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  seller_id                uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  kind                     text NOT NULL CHECK (kind IN ('ACQUISITION', 'ASSISTANCE')),
  allocation_id            uuid,
  claim_id                 uuid,
  assistance_agreement_id  uuid,
  agreement_id             uuid NOT NULL,
  agreement_version        text NOT NULL,
  share_bps                integer NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  first_capture_id         uuid,
  window_starts_at         timestamptz,
  window_ends_at           timestamptz,
  version                  bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                    text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'EXPIRED', 'DISPUTED', 'TERMINATED_WITH_RESIDUAL')),
  expired_at               timestamptz,
  terminated_at            timestamptz,
  created_at               timestamptz NOT NULL,
  updated_at               timestamptz NOT NULL,
  -- binding target of commission_lines: a line names the entitlement of its beneficiary, agency and share
  UNIQUE (entitlement_id, seller_id, agency_id, share_bps),
  CONSTRAINT commission_entitlements_one_per_beneficiary UNIQUE (allocation_id, seller_id),
  CONSTRAINT commission_entitlements_one_per_assistance UNIQUE (assistance_agreement_id),
  CONSTRAINT commission_entitlements_share_fk FOREIGN KEY (allocation_id, seller_id, claim_id, agreement_id, agreement_version, share_bps)
    REFERENCES kauro.allocation_shares (allocation_id, seller_id, claim_id, agreement_id, agreement_version, share_bps),
  CONSTRAINT commission_entitlements_allocation_fk FOREIGN KEY (allocation_id, agency_id) REFERENCES kauro.attribution_allocations (allocation_id, agency_id),
  CONSTRAINT commission_entitlements_assistance_fk FOREIGN KEY (agency_id, assistance_agreement_id, seller_id, agreement_id, agreement_version)
    REFERENCES kauro.assistance_agreements (agency_id, assistance_agreement_id, seller_id, agreement_id, agreement_version),
  CONSTRAINT commission_entitlements_agreement_fk FOREIGN KEY (seller_id, agreement_id, agreement_version) REFERENCES kauro.seller_agreements (seller_id, agreement_id, agreement_version),
  CONSTRAINT commission_entitlements_kind CHECK (
    (kind = 'ACQUISITION' AND allocation_id IS NOT NULL AND claim_id IS NOT NULL AND assistance_agreement_id IS NULL
      AND first_capture_id IS NOT NULL AND window_starts_at IS NOT NULL AND window_ends_at IS NOT NULL)
    OR (kind = 'ASSISTANCE' AND allocation_id IS NULL AND claim_id IS NULL AND assistance_agreement_id IS NOT NULL AND share_bps = 10000
      AND first_capture_id IS NULL AND window_starts_at IS NULL AND window_ends_at IS NULL)
  ),
  CONSTRAINT commission_entitlements_window CHECK (
    window_ends_at IS NULL OR window_ends_at = ((window_starts_at AT TIME ZONE 'America/Bogota') + interval '12 months') AT TIME ZONE 'America/Bogota'
  ),
  CONSTRAINT commission_entitlements_expired_record CHECK ((state = 'EXPIRED') = (expired_at IS NOT NULL)),
  CONSTRAINT commission_entitlements_terminated_record CHECK (state <> 'TERMINATED_WITH_RESIDUAL' OR terminated_at IS NOT NULL)
);
CREATE INDEX commission_entitlements_by_window ON kauro.commission_entitlements (state, window_ends_at);

-- the window starts at the agency's first designation (its capture and confirmation instant; 0028's sticky row)
ALTER TABLE kauro.agency_recurrence ADD CONSTRAINT agency_recurrence_window_anchor UNIQUE (agency_id, first_capture_id, first_confirmed_at);
ALTER TABLE kauro.commission_entitlements ADD CONSTRAINT commission_entitlements_window_anchor_fk
  FOREIGN KEY (agency_id, first_capture_id, window_starts_at) REFERENCES kauro.agency_recurrence (agency_id, first_capture_id, first_confirmed_at);

-- --- assignments (D10-ASSIGN-1, D10-ASSIGN-2, R2-095) -----------------------------------------------------------------------------------
-- The compensation for the new work of an operational owner, prepared by the owner before the assignment: none, or an assistance
-- agreement. Append-only.
CREATE TABLE kauro.service_assignments (
  service_assignment_id    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(service_assignment_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  seller_id                uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  compensation             text NOT NULL CHECK (compensation IN ('NONE', 'ASSISTANCE_AGREEMENT')),
  assistance_agreement_id  uuid,
  terms_hash               text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  prepared_by_user_id      uuid NOT NULL REFERENCES kauro.identities (user_id),
  prepared_at              timestamptz NOT NULL,
  created_at               timestamptz NOT NULL,
  UNIQUE (agency_id, service_assignment_id, seller_id),
  CONSTRAINT service_assignments_assistance_fk FOREIGN KEY (agency_id, assistance_agreement_id, seller_id) REFERENCES kauro.assistance_agreements (agency_id, assistance_agreement_id, seller_id),
  CONSTRAINT service_assignments_compensation CHECK ((compensation = 'ASSISTANCE_AGREEMENT') = (assistance_agreement_id IS NOT NULL))
);

-- The agency's current operational owner, as an append-only chain: each row is "from this instant the owner is this seller (with its
-- service assignment), or nobody" and supersedes the previous row; one first row and one successor per row make one chain per
-- agency, whose last row is the current assignment (the one the sales account names). Nothing here names an allocation, a share or an
-- entitlement: an assignment has no path to the acquisition rights (R2-095; 12 "Assignment means responsibility for current
-- commercial work. Attribution means contractual compensation entitlement").
CREATE TABLE kauro.account_assignments (
  assignment_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(assignment_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  seller_id                 uuid,
  service_assignment_id     uuid,
  supersedes_assignment_id  uuid,
  reason                    text NOT NULL CHECK (reason IN ('ASSIGNED', 'UNASSIGNED', 'SELLER_TERMINATED')),
  effective_at              timestamptz NOT NULL,
  recorded_by_user_id       uuid NOT NULL REFERENCES kauro.identities (user_id),
  created_at                timestamptz NOT NULL,
  UNIQUE (agency_id, assignment_id),
  CONSTRAINT account_assignments_service_fk FOREIGN KEY (agency_id, service_assignment_id, seller_id) REFERENCES kauro.service_assignments (agency_id, service_assignment_id, seller_id),
  CONSTRAINT account_assignments_supersedes_fk FOREIGN KEY (agency_id, supersedes_assignment_id) REFERENCES kauro.account_assignments (agency_id, assignment_id),
  CONSTRAINT account_assignments_one_successor UNIQUE (supersedes_assignment_id),
  CONSTRAINT account_assignments_not_self CHECK (supersedes_assignment_id IS DISTINCT FROM assignment_id),
  CONSTRAINT account_assignments_owner CHECK ((reason = 'ASSIGNED') = (seller_id IS NOT NULL) AND (seller_id IS NULL) = (service_assignment_id IS NULL))
);
CREATE UNIQUE INDEX account_assignments_one_first ON kauro.account_assignments (agency_id) WHERE supersedes_assignment_id IS NULL;

-- One sales account per agency, versioned (CMD048's CAS), naming the current assignment; it moves one step along the chain at a time.
CREATE TABLE kauro.sales_accounts (
  agency_id              uuid PRIMARY KEY REFERENCES kauro.agencies (agency_id),
  version                bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  current_assignment_id  uuid NOT NULL,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  CONSTRAINT sales_accounts_current_fk FOREIGN KEY (agency_id, current_assignment_id) REFERENCES kauro.account_assignments (agency_id, assignment_id)
);

-- --- termination and the enumerated tail (D10-TERM-1, R2-100) ---------------------------------------------------------------------------
-- The owner's prepared manifest of the seller's active opportunities: the accepted claims handed over at termination (17
-- "Termination and tail": "The termination schedule names each covered opportunity and end instant"). Append-only.
CREATE TABLE kauro.termination_manifests (
  manifest_id          uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(manifest_id)),
  seller_id            uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  claim_ids            uuid[] NOT NULL CHECK (kauro.is_distinct_uuid_set(claim_ids) AND cardinality(claim_ids) <= 10000),
  manifest_hash        text NOT NULL CHECK (kauro.is_sha256_hex(manifest_hash)),
  prepared_by_user_id  uuid NOT NULL REFERENCES kauro.identities (user_id),
  prepared_at          timestamptz NOT NULL,
  created_at           timestamptz NOT NULL,
  UNIQUE (seller_id, manifest_id)
);

-- The seller's termination: its prepared terms (CMD050's terminationTermsRef) and, once effective, its instant, the manifest it
-- enumerated and the owner who terminated. One effective termination per seller.
CREATE TABLE kauro.seller_terminations (
  termination_id         uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(termination_id)),
  seller_id              uuid NOT NULL REFERENCES kauro.sellers (seller_id),
  terms_hash             text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  prepared_by_user_id    uuid NOT NULL REFERENCES kauro.identities (user_id),
  prepared_at            timestamptz NOT NULL,
  manifest_id            uuid,
  effective_at           timestamptz,
  terminated_by_user_id  uuid REFERENCES kauro.identities (user_id),
  version                bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  -- binding target of termination_tail_entries: an entry names the termination, its seller and its effective instant
  UNIQUE (termination_id, seller_id, effective_at),
  CONSTRAINT seller_terminations_manifest_fk FOREIGN KEY (seller_id, manifest_id) REFERENCES kauro.termination_manifests (seller_id, manifest_id),
  CONSTRAINT seller_terminations_effective_record CHECK ((effective_at IS NULL) = (manifest_id IS NULL) AND (effective_at IS NULL) = (terminated_by_user_id IS NULL))
);
CREATE UNIQUE INDEX seller_terminations_one_effective ON kauro.seller_terminations (seller_id) WHERE effective_at IS NOT NULL;

-- One tail entry per enumerated opportunity: an ACCEPTED, unexpired claim of the terminated seller, listed in its manifest, whose
-- agency has no qualifying purchase (KC011), ending 2160 hours after the termination's effective instant (policy
-- terminationOpportunityTailDays 90). Append-only.
CREATE TABLE kauro.termination_tail_entries (
  termination_id  uuid NOT NULL,
  claim_id        uuid NOT NULL,
  seller_id       uuid NOT NULL,
  agency_id       uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  effective_at    timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  created_at      timestamptz NOT NULL,
  PRIMARY KEY (termination_id, claim_id),
  CONSTRAINT termination_tail_entries_termination_fk FOREIGN KEY (termination_id, seller_id, effective_at) REFERENCES kauro.seller_terminations (termination_id, seller_id, effective_at),
  CONSTRAINT termination_tail_entries_claim_fk FOREIGN KEY (claim_id, seller_id, agency_id) REFERENCES kauro.attribution_claims (claim_id, seller_id, agency_id),
  CONSTRAINT termination_tail_entries_tail_hours CHECK (ends_at = effective_at + interval '2160 hours')
);
CREATE INDEX termination_tail_entries_by_claim ON kauro.termination_tail_entries (claim_id);

-- --- bookkeeping, immutability and the listed edges -------------------------------------------------------------------------------
CREATE TRIGGER sellers_touch BEFORE UPDATE ON kauro.sellers FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER sellers_version BEFORE UPDATE ON kauro.sellers FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER sellers_immutable BEFORE UPDATE ON kauro.sellers
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('seller_id,user_id,created_by_user_id,created_at');
CREATE TRIGGER sellers_learned_once BEFORE UPDATE ON kauro.sellers
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('activation_assessment_id,activated_by_user_id,activation_proof_ref,activated_at,terminated_at');
CREATE TRIGGER sellers_transition BEFORE UPDATE OF state ON kauro.sellers FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Seller');
CREATE TRIGGER sellers_initial_state BEFORE INSERT ON kauro.sellers FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Seller');
CREATE TRIGGER sellers_transition_lock BEFORE UPDATE OF state ON kauro.sellers
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.sellers', 'seller_id');
CREATE TRIGGER sellers_history AFTER INSERT OR UPDATE OF state ON kauro.sellers
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('Seller', 'seller_id', 'state');
CREATE TRIGGER sellers_no_delete BEFORE DELETE ON kauro.sellers FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER sellers_no_truncate BEFORE TRUNCATE ON kauro.sellers FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER seller_agreements_touch BEFORE UPDATE ON kauro.seller_agreements FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER seller_agreements_version BEFORE UPDATE ON kauro.seller_agreements FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER seller_agreements_immutable BEFORE UPDATE ON kauro.seller_agreements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('agreement_id,seller_id,agreement_version,classification,legal_review_id,starts_at,first_bps,repeat_bps,recurring_months,offset_terms,retainer_cents_per_month,compensation_policy_version,signed_terms_hash,prepared_by_user_id,created_at');
CREATE TRIGGER seller_agreements_learned_once BEFORE UPDATE ON kauro.seller_agreements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('signed_at,signature_evidence_hash,ends_at');
CREATE TRIGGER seller_agreements_no_delete BEFORE DELETE ON kauro.seller_agreements FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_agreements_no_truncate BEFORE TRUNCATE ON kauro.seller_agreements FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER seller_payout_destinations_touch BEFORE UPDATE ON kauro.seller_payout_destinations FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER seller_payout_destinations_version BEFORE UPDATE ON kauro.seller_payout_destinations FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER seller_payout_destinations_immutable BEFORE UPDATE ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('destination_id,seller_id,destination_version,masked_label,destination_digest,currency,changed_by_user_id,change_proof_ref,changed_at,created_at');
CREATE TRIGGER seller_payout_destinations_learned_once BEFORE UPDATE ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('verified_by_user_id,verified_at,rejected_at,superseded_at');
CREATE TRIGGER seller_payout_destinations_transition BEFORE UPDATE OF state ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('PayoutDestination');
CREATE TRIGGER seller_payout_destinations_initial_state BEFORE INSERT ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('PayoutDestination');
CREATE TRIGGER seller_payout_destinations_server_instant BEFORE INSERT ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('changed_at');
CREATE TRIGGER seller_payout_destinations_history AFTER INSERT OR UPDATE OF state ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('PayoutDestination', 'destination_id', 'state');
CREATE TRIGGER seller_payout_destinations_no_delete BEFORE DELETE ON kauro.seller_payout_destinations FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_payout_destinations_no_truncate BEFORE TRUNCATE ON kauro.seller_payout_destinations FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER prospects_touch BEFORE UPDATE ON kauro.prospects FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER prospects_version BEFORE UPDATE ON kauro.prospects FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER prospects_immutable BEFORE UPDATE ON kauro.prospects
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('prospect_id,organization_label,organization_key,business_contact_id,source_evidence_hash,jurisdiction,registered_by_user_id,registered_by_seller_id,created_at');
CREATE TRIGGER prospects_transition BEFORE UPDATE OF state ON kauro.prospects FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Prospect');
CREATE TRIGGER prospects_initial_state BEFORE INSERT ON kauro.prospects FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Prospect');
CREATE TRIGGER prospects_history AFTER INSERT OR UPDATE OF state ON kauro.prospects
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('Prospect', 'prospect_id', 'state');
CREATE TRIGGER prospects_no_delete BEFORE DELETE ON kauro.prospects FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER prospects_no_truncate BEFORE TRUNCATE ON kauro.prospects FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER attribution_allocations_touch BEFORE UPDATE ON kauro.attribution_allocations FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER attribution_allocations_version BEFORE UPDATE ON kauro.attribution_allocations FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER attribution_allocations_immutable BEFORE UPDATE ON kauro.attribution_allocations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('allocation_id,agency_id,prospect_id,identity_evidence_hash,ruling_reason,ruling_evidence_hash,first_bps,repeat_bps,recurring_months,prepared_by_user_id,prepared_at,created_at');
CREATE TRIGGER attribution_allocations_learned_once BEFORE UPDATE ON kauro.attribution_allocations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('frozen_at,frozen_by_user_id');
CREATE TRIGGER attribution_allocations_no_delete BEFORE DELETE ON kauro.attribution_allocations FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER attribution_allocations_no_truncate BEFORE TRUNCATE ON kauro.attribution_allocations FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER attribution_claims_touch BEFORE UPDATE ON kauro.attribution_claims FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER attribution_claims_version BEFORE UPDATE ON kauro.attribution_claims FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER attribution_claims_immutable BEFORE UPDATE ON kauro.attribution_claims
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('claim_id,prospect_id,seller_id,agreement_id,agreement_version,evidence_hash,submitted_at,review_deadline_at,created_at');
CREATE TRIGGER attribution_claims_learned_once BEFORE UPDATE ON kauro.attribution_claims
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('conflict_reason,agency_id,allocation_id,accepted_at,expires_at,rejected_at,lapsed_at,converted_at,decided_by_user_id');
CREATE TRIGGER attribution_claims_transition BEFORE UPDATE OF state ON kauro.attribution_claims FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('AttributionClaim');
CREATE TRIGGER attribution_claims_initial_state BEFORE INSERT ON kauro.attribution_claims FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('AttributionClaim');
CREATE TRIGGER attribution_claims_server_instant BEFORE INSERT ON kauro.attribution_claims FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('submitted_at');
CREATE TRIGGER attribution_claims_history AFTER INSERT OR UPDATE OF state ON kauro.attribution_claims
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('AttributionClaim', 'claim_id', 'state');
CREATE TRIGGER attribution_claims_no_delete BEFORE DELETE ON kauro.attribution_claims FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER attribution_claims_no_truncate BEFORE TRUNCATE ON kauro.attribution_claims FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER commission_entitlements_touch BEFORE UPDATE ON kauro.commission_entitlements FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER commission_entitlements_version BEFORE UPDATE ON kauro.commission_entitlements FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER commission_entitlements_immutable BEFORE UPDATE ON kauro.commission_entitlements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('entitlement_id,agency_id,seller_id,kind,allocation_id,claim_id,assistance_agreement_id,agreement_id,agreement_version,share_bps,first_capture_id,window_starts_at,window_ends_at,created_at');
CREATE TRIGGER commission_entitlements_learned_once BEFORE UPDATE ON kauro.commission_entitlements
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('expired_at,terminated_at');
CREATE TRIGGER commission_entitlements_transition BEFORE UPDATE OF state ON kauro.commission_entitlements
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('CommissionEntitlement');
CREATE TRIGGER commission_entitlements_initial_state BEFORE INSERT ON kauro.commission_entitlements
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('CommissionEntitlement');
CREATE TRIGGER commission_entitlements_transition_lock BEFORE UPDATE OF state ON kauro.commission_entitlements
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.commission_entitlements', 'entitlement_id');
CREATE TRIGGER commission_entitlements_history AFTER INSERT OR UPDATE OF state ON kauro.commission_entitlements
  FOR EACH ROW EXECUTE FUNCTION kauro.record_corporate_transition('CommissionEntitlement', 'entitlement_id', 'state');
CREATE TRIGGER commission_entitlements_no_delete BEFORE DELETE ON kauro.commission_entitlements FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER commission_entitlements_no_truncate BEFORE TRUNCATE ON kauro.commission_entitlements FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER sales_accounts_touch BEFORE UPDATE ON kauro.sales_accounts FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER sales_accounts_version BEFORE UPDATE ON kauro.sales_accounts FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER sales_accounts_immutable BEFORE UPDATE ON kauro.sales_accounts FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('agency_id,created_at');
CREATE TRIGGER sales_accounts_no_delete BEFORE DELETE ON kauro.sales_accounts FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER sales_accounts_no_truncate BEFORE TRUNCATE ON kauro.sales_accounts FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

CREATE TRIGGER seller_terminations_touch BEFORE UPDATE ON kauro.seller_terminations FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER seller_terminations_version BEFORE UPDATE ON kauro.seller_terminations FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER seller_terminations_immutable BEFORE UPDATE ON kauro.seller_terminations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('termination_id,seller_id,terms_hash,prepared_by_user_id,prepared_at,created_at');
CREATE TRIGGER seller_terminations_learned_once BEFORE UPDATE ON kauro.seller_terminations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('manifest_id,effective_at,terminated_by_user_id');
CREATE TRIGGER seller_terminations_no_delete BEFORE DELETE ON kauro.seller_terminations FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_terminations_no_truncate BEFORE TRUNCATE ON kauro.seller_terminations FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- the append-only records of this file
CREATE TRIGGER seller_legal_reviews_append_only BEFORE UPDATE OR DELETE ON kauro.seller_legal_reviews FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_legal_reviews_no_truncate BEFORE TRUNCATE ON kauro.seller_legal_reviews FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_assessments_append_only BEFORE UPDATE OR DELETE ON kauro.seller_assessments FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_assessments_no_truncate BEFORE TRUNCATE ON kauro.seller_assessments FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_confidentiality_acceptances_append_only BEFORE UPDATE OR DELETE ON kauro.seller_confidentiality_acceptances FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_confidentiality_acceptances_no_truncate BEFORE TRUNCATE ON kauro.seller_confidentiality_acceptances FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_tax_documents_append_only BEFORE UPDATE OR DELETE ON kauro.seller_tax_documents FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER seller_tax_documents_no_truncate BEFORE TRUNCATE ON kauro.seller_tax_documents FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER prospect_source_evidence_append_only BEFORE UPDATE OR DELETE ON kauro.prospect_source_evidence FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER prospect_source_evidence_no_truncate BEFORE TRUNCATE ON kauro.prospect_source_evidence FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER prospect_contacts_append_only BEFORE UPDATE OR DELETE ON kauro.prospect_contacts FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER prospect_contacts_no_truncate BEFORE TRUNCATE ON kauro.prospect_contacts FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER prospect_suppressions_append_only BEFORE UPDATE OR DELETE ON kauro.prospect_suppressions FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER prospect_suppressions_no_truncate BEFORE TRUNCATE ON kauro.prospect_suppressions FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER prospect_suppressions_server_instant BEFORE INSERT ON kauro.prospect_suppressions FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('recorded_at');
CREATE TRIGGER claim_evidence_append_only BEFORE UPDATE OR DELETE ON kauro.claim_evidence FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER claim_evidence_no_truncate BEFORE TRUNCATE ON kauro.claim_evidence FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER claim_evidence_server_instant BEFORE INSERT ON kauro.claim_evidence FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('recorded_at');
CREATE TRIGGER allocation_shares_append_only BEFORE UPDATE OR DELETE ON kauro.allocation_shares FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER allocation_shares_no_truncate BEFORE TRUNCATE ON kauro.allocation_shares FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER assistance_agreements_append_only BEFORE UPDATE OR DELETE ON kauro.assistance_agreements FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER assistance_agreements_no_truncate BEFORE TRUNCATE ON kauro.assistance_agreements FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER assistance_agreements_server_instant BEFORE INSERT ON kauro.assistance_agreements FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('signed_at');
CREATE TRIGGER service_assignments_append_only BEFORE UPDATE OR DELETE ON kauro.service_assignments FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER service_assignments_no_truncate BEFORE TRUNCATE ON kauro.service_assignments FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER account_assignments_append_only BEFORE UPDATE OR DELETE ON kauro.account_assignments FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER account_assignments_no_truncate BEFORE TRUNCATE ON kauro.account_assignments FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER account_assignments_server_instant BEFORE INSERT ON kauro.account_assignments FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('effective_at');
CREATE TRIGGER termination_manifests_append_only BEFORE UPDATE OR DELETE ON kauro.termination_manifests FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER termination_manifests_no_truncate BEFORE TRUNCATE ON kauro.termination_manifests FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER termination_tail_entries_append_only BEFORE UPDATE OR DELETE ON kauro.termination_tail_entries FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER termination_tail_entries_no_truncate BEFORE TRUNCATE ON kauro.termination_tail_entries FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- --- the seller's edges (D10-SELL-1, D10-TERM-1) -----------------------------------------------------------------------------------
-- seller_activated and seller_reinstated (and any change of the agreement a seller acts under): the activation facts of 17
-- "Activation prerequisites", each read as the owner's session sees it — a signed agreement in force, a legal review confirming its
-- classification, a passed assessment, a confidentiality acceptance, a VERIFIED destination, verified tax documentation, and an ACTIVE
-- identity with a verified e-mail and MFA (after its transition lock) — and, at the first activation, the owner acting as itself with
-- its own fresh step-up at the server's instant. SELLER_NOT_ACTIVATABLE (KC005), naming what is missing.
CREATE OR REPLACE FUNCTION kauro.sellers_activation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  missing text[] := ARRAY[]::text[];
  agreement record;
  has_agreement boolean;
BEGIN
  IF NEW.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'SELLER_NOT_ACTIVATABLE: seller % changes the agreement it acts under only with an activation', OLD.seller_id USING ERRCODE = 'KC005';
  END IF;
  PERFORM kauro.await_transition('kauro.identities', NEW.user_id::text);
  SELECT a.signed_at, a.ends_at, r.outcome INTO agreement
    FROM kauro.seller_agreements a
    JOIN kauro.seller_legal_reviews r ON r.seller_id = a.seller_id AND r.review_id = a.legal_review_id AND r.classification = a.classification
   WHERE a.seller_id = NEW.seller_id AND a.agreement_id = NEW.agreement_id;
  has_agreement := FOUND;
  IF NOT has_agreement OR agreement.signed_at IS NULL OR (agreement.ends_at IS NOT NULL AND agreement.ends_at <= kauro.server_now()) THEN
    missing := array_append(missing, 'SIGNED_AGREEMENT');
  END IF;
  IF NOT has_agreement OR agreement.outcome IS DISTINCT FROM 'CONFIRMED' THEN
    missing := array_append(missing, 'CONFIRMING_LEGAL_REVIEW');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.seller_assessments s WHERE s.seller_id = NEW.seller_id AND s.assessment_id = NEW.activation_assessment_id AND s.outcome = 'PASSED') THEN
    missing := array_append(missing, 'PASSED_ASSESSMENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.seller_confidentiality_acceptances c WHERE c.seller_id = NEW.seller_id) THEN
    missing := array_append(missing, 'CONFIDENTIALITY_ACCEPTANCE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.seller_payout_destinations d WHERE d.seller_id = NEW.seller_id AND d.state = 'VERIFIED') THEN
    missing := array_append(missing, 'VERIFIED_DESTINATION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.seller_tax_documents t WHERE t.seller_id = NEW.seller_id) THEN
    missing := array_append(missing, 'TAX_DOCUMENTATION');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.identities i WHERE i.user_id = NEW.user_id AND i.state = 'ACTIVE' AND i.email_verified_at IS NOT NULL AND i.mfa_enrolled_at IS NOT NULL
  ) THEN
    missing := array_append(missing, 'VERIFIED_IDENTITY_WITH_MFA');
  END IF;
  IF OLD.state = 'CANDIDATE' AND (
       NEW.activated_by_user_id IS DISTINCT FROM kauro.current_user_id() OR NEW.activated_at IS DISTINCT FROM kauro.server_now()
       OR NOT EXISTS (
         SELECT 1 FROM kauro.assurance_proofs p
          WHERE p.user_id = NEW.activated_by_user_id AND p.proof_id = NEW.activation_proof_ref AND p.kind = 'STEP_UP'
            AND p.issued_at <= kauro.server_now() AND p.expires_at > kauro.server_now()
       )) THEN
    missing := array_append(missing, 'OWNER_STEP_UP');
  END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'SELLER_NOT_ACTIVATABLE: seller % lacks %', OLD.seller_id, array_to_string(missing, ', ') USING ERRCODE = 'KC005';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sellers_activation_guard BEFORE UPDATE ON kauro.sellers
  FOR EACH ROW WHEN ((NEW.state = 'ACTIVE' AND OLD.state IS DISTINCT FROM 'ACTIVE') OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id)
  EXECUTE FUNCTION kauro.sellers_activation_guard();

-- seller_terminated: at the effective instant of the seller's recorded termination (CMD050); candidate_not_engaged: a candidate with no
-- signed agreement. Named check violation sellers_termination_recorded (23514).
CREATE OR REPLACE FUNCTION kauro.sellers_termination_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.terminated_at IS DISTINCT FROM kauro.server_now()
     OR (OLD.state = 'CANDIDATE' AND EXISTS (SELECT 1 FROM kauro.seller_agreements a WHERE a.seller_id = OLD.seller_id AND a.signed_at IS NOT NULL))
     OR (OLD.state <> 'CANDIDATE' AND NOT EXISTS (
           SELECT 1 FROM kauro.seller_terminations t WHERE t.seller_id = OLD.seller_id AND t.effective_at = NEW.terminated_at)) THEN
    RAISE EXCEPTION 'TERMINATION: seller % is terminated at its recorded termination''s effective instant (a candidate: with no signed agreement)', OLD.seller_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'sellers_termination_recorded', SCHEMA = 'kauro', TABLE = 'sellers';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sellers_termination_guard BEFORE UPDATE OF state ON kauro.sellers
  FOR EACH ROW WHEN (NEW.state = 'TERMINATED' AND OLD.state IS DISTINCT FROM 'TERMINATED') EXECUTE FUNCTION kauro.sellers_termination_guard();

-- A termination becomes effective once, at the server's instant, by the owner acting as itself, with the manifest it enumerates.
-- Named check violation seller_terminations_effective (23514).
CREATE OR REPLACE FUNCTION kauro.seller_terminations_effective() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.effective_at IS DISTINCT FROM kauro.server_now() OR NEW.terminated_by_user_id IS DISTINCT FROM kauro.current_user_id() THEN
    RAISE EXCEPTION 'TERMINATION: termination % becomes effective at the server''s instant by the session''s owner', OLD.termination_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'seller_terminations_effective', SCHEMA = 'kauro', TABLE = 'seller_terminations';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER seller_terminations_effective BEFORE UPDATE OF effective_at ON kauro.seller_terminations
  FOR EACH ROW WHEN (OLD.effective_at IS NULL AND NEW.effective_at IS NOT NULL) EXECUTE FUNCTION kauro.seller_terminations_effective();

-- --- the destination's edges (D10-SELL-2, R2-103) --------------------------------------------------------------------------------------
-- A change is the seller's own, recorded at the server's instant; a step-up it cites is fresh at that instant (named check violation
-- seller_payout_destinations_step_up, 23514).
CREATE OR REPLACE FUNCTION kauro.seller_payout_destinations_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.change_proof_ref IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kauro.assurance_proofs p
     WHERE p.user_id = NEW.changed_by_user_id AND p.proof_id = NEW.change_proof_ref AND p.kind = 'STEP_UP'
       AND p.issued_at <= NEW.changed_at AND p.expires_at > NEW.changed_at
  ) THEN
    RAISE EXCEPTION 'DESTINATION_CHANGE: the step-up cited by a destination change of seller % is not the changer''s fresh proof', NEW.seller_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'seller_payout_destinations_step_up', SCHEMA = 'kauro', TABLE = 'seller_payout_destinations';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER seller_payout_destinations_change BEFORE INSERT ON kauro.seller_payout_destinations
  FOR EACH ROW EXECUTE FUNCTION kauro.seller_payout_destinations_change();

-- destination_verified: the change carried the seller's own step-up, and the verification is the session's person's (the owner, by
-- policy), not the changer, at the server's instant at least 172 800 s after the change. destination_rejected and
-- destination_superseded are recorded at the server's instant; a superseded version gives way to a later VERIFIED version of the same
-- seller (checked at COMMIT). Named check violation seller_payout_destinations_verification (23514).
CREATE OR REPLACE FUNCTION kauro.seller_payout_destinations_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (NEW.state = 'VERIFIED' AND (
        OLD.change_proof_ref IS NULL
        OR NEW.verified_by_user_id IS DISTINCT FROM kauro.current_user_id() OR NEW.verified_by_user_id = OLD.changed_by_user_id
        OR NEW.verified_at IS DISTINCT FROM kauro.server_now() OR NEW.verified_at < OLD.changed_at + interval '172800 seconds'))
     OR (NEW.state = 'REJECTED' AND NEW.rejected_at IS DISTINCT FROM kauro.server_now())
     OR (NEW.state = 'SUPERSEDED' AND NEW.superseded_at IS DISTINCT FROM kauro.server_now()) THEN
    RAISE EXCEPTION 'DESTINATION_VERIFICATION: destination % of seller % is verified only with the seller''s own step-up at the change and an owner verification at least 172800 s later', OLD.destination_version, OLD.seller_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'seller_payout_destinations_verification', SCHEMA = 'kauro', TABLE = 'seller_payout_destinations';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER seller_payout_destinations_edge BEFORE UPDATE OF state ON kauro.seller_payout_destinations
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.seller_payout_destinations_edge();

CREATE OR REPLACE FUNCTION kauro.seller_payout_destinations_superseded_by_later() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.seller_payout_destinations d WHERE d.seller_id = NEW.seller_id AND d.destination_version > NEW.destination_version AND d.state = 'VERIFIED'
  ) THEN
    RAISE EXCEPTION 'DESTINATION_VERIFICATION: destination % of seller % is superseded only by a later VERIFIED version', NEW.destination_version, NEW.seller_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'seller_payout_destinations_verification', SCHEMA = 'kauro', TABLE = 'seller_payout_destinations';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER seller_payout_destinations_superseded_by_later AFTER UPDATE OF state ON kauro.seller_payout_destinations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'SUPERSEDED') EXECUTE FUNCTION kauro.seller_payout_destinations_superseded_by_later();

-- --- suppression (D10-PROS-1, CMD045) -------------------------------------------------------------------------------------------------
-- A prospect whose organization key, or whose business contact's key, is suppressed is refused however its label is spelled
-- (PROSPECT_SUPPRESSED, KC016). The suppressions are read by every owner and seller session (prospect_suppressions_read).
CREATE OR REPLACE FUNCTION kauro.prospects_not_suppressed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM kauro.prospect_suppressions s WHERE s.key_kind = 'ORGANIZATION' AND s.suppression_key = NEW.organization_key)
     OR EXISTS (
       SELECT 1 FROM kauro.prospect_contacts c JOIN kauro.prospect_suppressions s ON s.key_kind = 'CONTACT' AND s.suppression_key = c.contact_key
        WHERE c.recorded_by_user_id = NEW.registered_by_user_id AND c.contact_id = NEW.business_contact_id
     ) THEN
    RAISE EXCEPTION 'PROSPECT_SUPPRESSED: the organization or business contact of this prospect is suppressed' USING ERRCODE = 'KC016';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER prospects_not_suppressed BEFORE INSERT ON kauro.prospects FOR EACH ROW EXECUTE FUNCTION kauro.prospects_not_suppressed();

-- --- the claim's edges (D10-CLAIM-1, D10-ATTR-1, D10-TX-1) ------------------------------------------------------------------------------
-- The claims of one prospect serialize: a claim's birth and every state change take the exclusive half of kauro.attribution_claims
-- (prospect), so two sellers' claims of one prospect are ordered and the later one sees the earlier (CMD046-RACE).
CREATE OR REPLACE FUNCTION kauro.take_claims_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM pg_advisory_xact_lock(kauro.transition_key('kauro.attribution_claims', NEW.prospect_id::text));
  RETURN NEW;
END
$$;
CREATE TRIGGER attribution_claims_claims_lock BEFORE INSERT OR UPDATE OF state ON kauro.attribution_claims
  FOR EACH ROW EXECUTE FUNCTION kauro.take_claims_lock();

-- a claim's birth: its seller ACTIVE — read after the seller's transition lock — and acting under exactly the agreement it names
-- (its activated agreement version). Named check violation attribution_claims_active_agreement (23514).
CREATE OR REPLACE FUNCTION kauro.attribution_claims_claimant() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.await_transition('kauro.sellers', NEW.seller_id::text);
  IF NOT EXISTS (SELECT 1 FROM kauro.sellers s WHERE s.seller_id = NEW.seller_id AND s.state = 'ACTIVE' AND s.agreement_id = NEW.agreement_id) THEN
    RAISE EXCEPTION 'CLAIMANT: a claim of seller % needs the seller ACTIVE under the agreement it names', NEW.seller_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attribution_claims_active_agreement', SCHEMA = 'kauro', TABLE = 'attribution_claims';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attribution_claims_claimant BEFORE INSERT ON kauro.attribution_claims FOR EACH ROW EXECUTE FUNCTION kauro.attribution_claims_claimant();

-- claim_accepted (checked at COMMIT; SHARES_NOT_WHOLE, KC003): the claim names a frozen allocation of its prospect, whose shares name
-- it, frozen at the claim's acceptance instant. claim_rejected (checked at COMMIT; named check violation attribution_claims_ruling,
-- 23514): the ruling allocation is frozen at the rejection instant and gives the claim no share.
CREATE OR REPLACE FUNCTION kauro.attribution_claims_ruled() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  claim record;
  frozen timestamptz;
BEGIN
  SELECT c.state, c.allocation_id, c.accepted_at, c.rejected_at INTO claim FROM kauro.attribution_claims c WHERE c.claim_id = NEW.claim_id;
  SELECT a.frozen_at INTO frozen FROM kauro.attribution_allocations a WHERE a.allocation_id = claim.allocation_id;
  IF claim.state = 'ACCEPTED' AND (frozen IS NULL OR claim.accepted_at IS DISTINCT FROM frozen
       OR NOT EXISTS (SELECT 1 FROM kauro.allocation_shares s WHERE s.allocation_id = claim.allocation_id AND s.claim_id = NEW.claim_id)) THEN
    RAISE EXCEPTION 'SHARES_NOT_WHOLE: claim % is accepted only by the frozen allocation whose shares name it', NEW.claim_id USING ERRCODE = 'KC003';
  END IF;
  IF claim.state = 'REJECTED' AND (frozen IS NULL OR claim.rejected_at IS DISTINCT FROM frozen
       OR EXISTS (SELECT 1 FROM kauro.allocation_shares s WHERE s.allocation_id = claim.allocation_id AND s.claim_id = NEW.claim_id)) THEN
    RAISE EXCEPTION 'RULING: claim % is rejected only by a frozen allocation that rules against it', NEW.claim_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attribution_claims_ruling', SCHEMA = 'kauro', TABLE = 'attribution_claims';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER attribution_claims_ruled AFTER UPDATE OF state ON kauro.attribution_claims
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state IN ('ACCEPTED', 'REJECTED')) EXECUTE FUNCTION kauro.attribution_claims_ruled();

-- claim_lapsed: a SUBMITTED or DISPUTED claim past its review deadline; an ACCEPTED claim past its end — its termination tail's end
-- when it was enumerated, otherwise its acceptance window; or any open claim of a terminated seller that its termination did not
-- enumerate. first_purchase_confirmed: the agency's first qualifying purchase was confirmed before the claim's end and the claim was
-- submitted before that purchase's order (17 "A claim must be submitted before the first paid order"); read in the agency the
-- commission service adopted (fail closed otherwise). Both at the server's instant. Named check violations attribution_claims_lapse
-- and attribution_claims_conversion (23514).
CREATE OR REPLACE FUNCTION kauro.attribution_claims_ending() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  tail_end timestamptz;
  seller_state text;
  first record;
BEGIN
  SELECT max(t.ends_at) INTO tail_end FROM kauro.termination_tail_entries t WHERE t.claim_id = OLD.claim_id;
  IF NEW.state = 'EXPIRED' THEN
    SELECT s.state INTO seller_state FROM kauro.sellers s WHERE s.seller_id = OLD.seller_id;
    IF NEW.lapsed_at IS DISTINCT FROM kauro.server_now() OR NOT (
         (OLD.state IN ('SUBMITTED', 'DISPUTED') AND OLD.review_deadline_at <= kauro.server_now())
         OR (OLD.state = 'ACCEPTED' AND coalesce(tail_end, OLD.expires_at) <= kauro.server_now())
         OR (seller_state = 'TERMINATED' AND tail_end IS NULL)) THEN
      RAISE EXCEPTION 'LAPSE: claim % lapses only past its deadline or unlisted at its seller''s termination', OLD.claim_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'attribution_claims_lapse', SCHEMA = 'kauro', TABLE = 'attribution_claims';
    END IF;
  ELSE
    SELECT r.first_confirmed_at, q.order_created_at INTO first
      FROM kauro.agency_recurrence r JOIN kauro.qualifying_purchases q ON q.agency_id = r.agency_id AND q.authorization_id = r.first_authorization_id
     WHERE r.agency_id = OLD.agency_id;
    IF NOT FOUND OR NEW.converted_at IS DISTINCT FROM kauro.server_now()
       OR first.first_confirmed_at >= coalesce(tail_end, OLD.expires_at) OR OLD.submitted_at >= first.order_created_at THEN
      RAISE EXCEPTION 'CONVERSION: claim % converts at its agency''s first qualifying purchase confirmed before the claim''s end, the claim before that purchase''s order', OLD.claim_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'attribution_claims_conversion', SCHEMA = 'kauro', TABLE = 'attribution_claims';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attribution_claims_ending BEFORE UPDATE OF state ON kauro.attribution_claims
  FOR EACH ROW WHEN (NEW.state IN ('EXPIRED', 'CONVERTED') AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.attribution_claims_ending();

-- a converted claim created the entitlement of its beneficiary in the same transaction (checked at COMMIT; named check violation
-- attribution_claims_conversion, 23514)
CREATE OR REPLACE FUNCTION kauro.attribution_claims_converted_entitlement() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.commission_entitlements e WHERE e.claim_id = NEW.claim_id AND e.seller_id = NEW.seller_id AND e.kind = 'ACQUISITION') THEN
    RAISE EXCEPTION 'CONVERSION: claim % converts with the entitlement of its beneficiary', NEW.claim_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attribution_claims_conversion', SCHEMA = 'kauro', TABLE = 'attribution_claims';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER attribution_claims_converted_entitlement AFTER UPDATE OF state ON kauro.attribution_claims
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.state = 'CONVERTED') EXECUTE FUNCTION kauro.attribution_claims_converted_entitlement();

-- --- the allocation (D10-ATTR-1, R2-097; KC003) -----------------------------------------------------------------------------------------
-- A share is written while its allocation is prepared, never after the freeze (SHARES_NOT_WHOLE, KC003).
CREATE OR REPLACE FUNCTION kauro.allocation_shares_while_prepared() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM kauro.attribution_allocations a WHERE a.allocation_id = NEW.allocation_id AND a.frozen_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SHARES_NOT_WHOLE: the shares of frozen allocation % never change', NEW.allocation_id USING ERRCODE = 'KC003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER allocation_shares_while_prepared BEFORE INSERT ON kauro.allocation_shares FOR EACH ROW EXECUTE FUNCTION kauro.allocation_shares_while_prepared();

-- the freeze: by the session's person (the owner, by policy) at the server's instant; at COMMIT the frozen allocation's shares sum to
-- exactly 10 000 bps, each under its beneficiary's signed agreement in force, and every claim they name is ACCEPTED at the freeze
-- (SHARES_NOT_WHOLE, KC003)
CREATE OR REPLACE FUNCTION kauro.attribution_allocations_freeze() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.frozen_at IS DISTINCT FROM kauro.server_now() OR NEW.frozen_by_user_id IS DISTINCT FROM kauro.current_user_id() THEN
    RAISE EXCEPTION 'SHARES_NOT_WHOLE: allocation % is frozen at the server''s instant by the session''s owner', OLD.allocation_id USING ERRCODE = 'KC003';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER attribution_allocations_freeze BEFORE UPDATE OF frozen_at ON kauro.attribution_allocations
  FOR EACH ROW WHEN (OLD.frozen_at IS NULL AND NEW.frozen_at IS NOT NULL) EXECUTE FUNCTION kauro.attribution_allocations_freeze();

CREATE OR REPLACE FUNCTION kauro.attribution_allocations_whole() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  allocation record;
BEGIN
  SELECT a.allocation_id, a.frozen_at INTO allocation FROM kauro.attribution_allocations a WHERE a.allocation_id = NEW.allocation_id;
  IF allocation.frozen_at IS NULL THEN
    RETURN NULL;
  END IF;
  IF (SELECT coalesce(sum(s.share_bps), 0) FROM kauro.allocation_shares s WHERE s.allocation_id = allocation.allocation_id) <> 10000
     OR EXISTS (
       SELECT 1 FROM kauro.allocation_shares s JOIN kauro.seller_agreements g ON g.seller_id = s.seller_id AND g.agreement_id = s.agreement_id
        WHERE s.allocation_id = allocation.allocation_id AND (g.signed_at IS NULL OR (g.ends_at IS NOT NULL AND g.ends_at <= allocation.frozen_at))
     )
     OR EXISTS (
       SELECT 1 FROM kauro.allocation_shares s JOIN kauro.attribution_claims c ON c.claim_id = s.claim_id
        WHERE s.allocation_id = allocation.allocation_id
          AND (c.allocation_id IS DISTINCT FROM allocation.allocation_id OR c.accepted_at IS DISTINCT FROM allocation.frozen_at)
     ) THEN
    RAISE EXCEPTION 'SHARES_NOT_WHOLE: frozen allocation % must give exactly 10000 bps to accepted claims under signed agreements', allocation.allocation_id USING ERRCODE = 'KC003';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER attribution_allocations_whole AFTER UPDATE OF frozen_at ON kauro.attribution_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.frozen_at IS NOT NULL) EXECUTE FUNCTION kauro.attribution_allocations_whole();
CREATE CONSTRAINT TRIGGER allocation_shares_whole AFTER INSERT ON kauro.allocation_shares
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.attribution_allocations_whole();

-- --- the entitlement's birth and edges (D10-ATTR-2, R2-094) ---------------------------------------------------------------------------
-- An ACQUISITION entitlement is a share of a frozen allocation, and its claim converts in the same transaction (checked at COMMIT);
-- named check violation commission_entitlements_conversion (23514).
CREATE OR REPLACE FUNCTION kauro.commission_entitlements_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.kind = 'ACQUISITION' AND NOT EXISTS (
    SELECT 1 FROM kauro.attribution_allocations a JOIN kauro.attribution_claims c ON c.allocation_id = a.allocation_id
     WHERE a.allocation_id = NEW.allocation_id AND a.frozen_at IS NOT NULL AND c.claim_id = NEW.claim_id AND c.state = 'CONVERTED'
  ) THEN
    RAISE EXCEPTION 'CONVERSION: entitlement % is a share of a frozen allocation whose claim converts with it', NEW.entitlement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_entitlements_conversion', SCHEMA = 'kauro', TABLE = 'commission_entitlements';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER commission_entitlements_birth AFTER INSERT ON kauro.commission_entitlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.commission_entitlements_birth();

-- window_ended: the window's exclusive end has passed; seller_terminated: the beneficiary is TERMINATED; each at the server's instant.
-- Named check violation commission_entitlements_edge (23514).
CREATE OR REPLACE FUNCTION kauro.commission_entitlements_edge() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (NEW.state = 'EXPIRED' AND (OLD.window_ends_at IS NULL OR OLD.window_ends_at > kauro.server_now() OR NEW.expired_at IS DISTINCT FROM kauro.server_now()))
     OR (NEW.state = 'TERMINATED_WITH_RESIDUAL' AND (
           NEW.terminated_at IS DISTINCT FROM kauro.server_now()
           OR NOT EXISTS (SELECT 1 FROM kauro.sellers s WHERE s.seller_id = OLD.seller_id AND s.state = 'TERMINATED'))) THEN
    RAISE EXCEPTION 'ENTITLEMENT_EDGE: entitlement % expires only after its window and keeps its residual only at its seller''s termination', OLD.entitlement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_entitlements_edge', SCHEMA = 'kauro', TABLE = 'commission_entitlements';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER commission_entitlements_edge BEFORE UPDATE OF state ON kauro.commission_entitlements
  FOR EACH ROW WHEN (NEW.state IN ('EXPIRED', 'TERMINATED_WITH_RESIDUAL') AND OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.commission_entitlements_edge();

-- --- the assignment chain (D10-ASSIGN-2) ---------------------------------------------------------------------------------------------
-- A new assignment is the agency's current one at COMMIT (the sales account names it), and the sales account moves one step along the
-- chain at a time. Named check violation account_assignments_current (23514).
CREATE OR REPLACE FUNCTION kauro.account_assignments_current() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM kauro.sales_accounts a WHERE a.agency_id = NEW.agency_id AND a.current_assignment_id = NEW.assignment_id) THEN
    RAISE EXCEPTION 'ASSIGNMENT: assignment % is the current assignment of its agency''s sales account', NEW.assignment_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_assignments_current', SCHEMA = 'kauro', TABLE = 'account_assignments';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER account_assignments_current AFTER INSERT ON kauro.account_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.account_assignments_current();

CREATE OR REPLACE FUNCTION kauro.sales_accounts_current() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM kauro.account_assignments a WHERE a.assignment_id = NEW.current_assignment_id AND a.supersedes_assignment_id IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND NEW.current_assignment_id IS DISTINCT FROM OLD.current_assignment_id AND NOT EXISTS (
           SELECT 1 FROM kauro.account_assignments a WHERE a.assignment_id = NEW.current_assignment_id AND a.supersedes_assignment_id = OLD.current_assignment_id)) THEN
    RAISE EXCEPTION 'ASSIGNMENT: the sales account of agency % names its first assignment, then each successor in turn', NEW.agency_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_assignments_current', SCHEMA = 'kauro', TABLE = 'sales_accounts';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER sales_accounts_current BEFORE INSERT OR UPDATE ON kauro.sales_accounts FOR EACH ROW EXECUTE FUNCTION kauro.sales_accounts_current();

-- --- the tail (D10-TERM-1, R2-100; KC011) ---------------------------------------------------------------------------------------------
-- A tail entry is an opportunity the termination enumerated: listed in its manifest, an ACCEPTED claim of the terminated seller on
-- that agency, unexpired at the effective instant, whose agency has no qualifying purchase (TAIL_NOT_ENUMERATED, KC011). The owner's
-- session reads the purchases (qualifying_purchases_owner_read).
CREATE OR REPLACE FUNCTION kauro.termination_tail_entries_enumerated() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM kauro.seller_terminations t JOIN kauro.termination_manifests m ON m.manifest_id = t.manifest_id
        WHERE t.termination_id = NEW.termination_id AND t.seller_id = NEW.seller_id AND NEW.claim_id = ANY (m.claim_ids)
     )
     OR NOT EXISTS (
       SELECT 1 FROM kauro.attribution_claims c
        WHERE c.claim_id = NEW.claim_id AND c.seller_id = NEW.seller_id AND c.agency_id = NEW.agency_id AND c.state = 'ACCEPTED' AND c.expires_at > NEW.effective_at
     )
     OR EXISTS (SELECT 1 FROM kauro.qualifying_purchases q WHERE q.agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'TAIL_NOT_ENUMERATED: claim % is no enumerated, accepted and unexpired opportunity of an agency without a purchase', NEW.claim_id USING ERRCODE = 'KC011';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER termination_tail_entries_enumerated BEFORE INSERT ON kauro.termination_tail_entries
  FOR EACH ROW EXECUTE FUNCTION kauro.termination_tail_entries_enumerated();

-- --- row-level security (FORCE everywhere; corporate policies only, D10-CTX-3; no DELETE grant) ------------------------------------------
ALTER TABLE kauro.sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.sellers FORCE ROW LEVEL SECURITY;
CREATE POLICY sellers_owner_read ON kauro.sellers FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY sellers_owner_record ON kauro.sellers FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND created_by_user_id = kauro.current_user_id());
CREATE POLICY sellers_owner_update ON kauro.sellers FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
-- a seller's own row (never through kauro.current_seller_id(), which reads this table)
CREATE POLICY sellers_self_read ON kauro.sellers FOR SELECT TO kauro_app USING (kauro.current_agency_id() IS NULL AND user_id = kauro.current_user_id());
CREATE POLICY sellers_commission_read ON kauro.sellers FOR SELECT TO kauro_commission USING (true);

ALTER TABLE kauro.seller_legal_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.seller_legal_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_legal_reviews_owner_read ON kauro.seller_legal_reviews FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY seller_legal_reviews_owner_record ON kauro.seller_legal_reviews FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());

ALTER TABLE kauro.seller_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.seller_agreements FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_agreements_owner_read ON kauro.seller_agreements FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY seller_agreements_owner_record ON kauro.seller_agreements FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND prepared_by_user_id = kauro.current_user_id());
CREATE POLICY seller_agreements_owner_update ON kauro.seller_agreements FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY seller_agreements_seller_read ON kauro.seller_agreements FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY seller_agreements_commission_read ON kauro.seller_agreements FOR SELECT TO kauro_commission USING (true);

ALTER TABLE kauro.seller_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.seller_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_assessments_owner_read ON kauro.seller_assessments FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY seller_assessments_owner_record ON kauro.seller_assessments FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());

ALTER TABLE kauro.seller_confidentiality_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.seller_confidentiality_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_confidentiality_acceptances_owner_read ON kauro.seller_confidentiality_acceptances FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY seller_confidentiality_acceptances_owner_record ON kauro.seller_confidentiality_acceptances FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());

ALTER TABLE kauro.seller_tax_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.seller_tax_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_tax_documents_owner_read ON kauro.seller_tax_documents FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY seller_tax_documents_owner_record ON kauro.seller_tax_documents FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND verified_by_user_id = kauro.current_user_id());

ALTER TABLE kauro.seller_payout_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.seller_payout_destinations FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_payout_destinations_owner_read ON kauro.seller_payout_destinations FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY seller_payout_destinations_owner_update ON kauro.seller_payout_destinations FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY seller_payout_destinations_seller_read ON kauro.seller_payout_destinations FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
-- the seller's own change, in any state: a candidate needs a verified destination to be activated and a departed seller keeps its
-- payment route (17 "Termination and tail")
CREATE POLICY seller_payout_destinations_seller_change ON kauro.seller_payout_destinations FOR INSERT TO kauro_app
  WITH CHECK (seller_id = kauro.current_seller_id() AND changed_by_user_id = kauro.current_user_id());

ALTER TABLE kauro.prospect_source_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.prospect_source_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY prospect_source_evidence_owner_read ON kauro.prospect_source_evidence FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY prospect_source_evidence_self_read ON kauro.prospect_source_evidence FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND recorded_by_user_id = kauro.current_user_id());
CREATE POLICY prospect_source_evidence_record ON kauro.prospect_source_evidence FOR INSERT TO kauro_app
  WITH CHECK (recorded_by_user_id = kauro.current_user_id() AND ((seller_id IS NOT NULL AND seller_id = kauro.acting_seller_id()) OR (seller_id IS NULL AND kauro.acting_corporate_owner())));

ALTER TABLE kauro.prospect_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.prospect_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY prospect_contacts_owner_read ON kauro.prospect_contacts FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY prospect_contacts_self_read ON kauro.prospect_contacts FOR SELECT TO kauro_app
  USING (kauro.current_agency_id() IS NULL AND recorded_by_user_id = kauro.current_user_id());
CREATE POLICY prospect_contacts_record ON kauro.prospect_contacts FOR INSERT TO kauro_app
  WITH CHECK (recorded_by_user_id = kauro.current_user_id() AND (kauro.acting_seller_id() IS NOT NULL OR kauro.acting_corporate_owner()));

ALTER TABLE kauro.prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.prospects FORCE ROW LEVEL SECURITY;
CREATE POLICY prospects_owner_read ON kauro.prospects FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY prospects_owner_update ON kauro.prospects FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
-- a seller reads the prospects it registered or owns
CREATE POLICY prospects_seller_read ON kauro.prospects FOR SELECT TO kauro_app
  USING (registered_by_seller_id = kauro.current_seller_id() OR owner_seller_id = kauro.current_seller_id());
-- CMD045: an ACTIVE seller registers a prospect it then owns; the owner registers one owned by nobody or by a seller it names
CREATE POLICY prospects_register ON kauro.prospects FOR INSERT TO kauro_app
  WITH CHECK (
    registered_by_user_id = kauro.current_user_id()
    AND ((registered_by_seller_id IS NOT NULL AND registered_by_seller_id = kauro.acting_seller_id() AND owner_seller_id = registered_by_seller_id)
         OR (registered_by_seller_id IS NULL AND kauro.acting_corporate_owner()))
  );

ALTER TABLE kauro.prospect_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.prospect_suppressions FORCE ROW LEVEL SECURITY;
-- suppression applies across every seller and channel (12 "Outreach workspace"): every owner and seller session reads it
CREATE POLICY prospect_suppressions_read ON kauro.prospect_suppressions FOR SELECT TO kauro_app
  USING (kauro.current_seller_id() IS NOT NULL OR kauro.acting_corporate_owner());
CREATE POLICY prospect_suppressions_record ON kauro.prospect_suppressions FOR INSERT TO kauro_app
  WITH CHECK (recorded_by_user_id = kauro.current_user_id() AND (kauro.acting_seller_id() IS NOT NULL OR kauro.acting_corporate_owner()));

ALTER TABLE kauro.claim_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.claim_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_evidence_owner_read ON kauro.claim_evidence FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY claim_evidence_seller_read ON kauro.claim_evidence FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY claim_evidence_seller_record ON kauro.claim_evidence FOR INSERT TO kauro_app WITH CHECK (seller_id = kauro.acting_seller_id());

ALTER TABLE kauro.attribution_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.attribution_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY attribution_allocations_owner_read ON kauro.attribution_allocations FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY attribution_allocations_owner_prepare ON kauro.attribution_allocations FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND prepared_by_user_id = kauro.current_user_id() AND frozen_at IS NULL);
CREATE POLICY attribution_allocations_owner_freeze ON kauro.attribution_allocations FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner() AND frozen_at IS NULL) WITH CHECK (kauro.acting_corporate_owner());
-- a seller reads the frozen allocations that give it a share (its attribution subject, window and split; 12 "Attribution and
-- assignment views")
CREATE POLICY attribution_allocations_seller_read ON kauro.attribution_allocations FOR SELECT TO kauro_app
  USING (frozen_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM kauro.allocation_shares s WHERE s.allocation_id = attribution_allocations.allocation_id AND s.seller_id = kauro.current_seller_id()));
CREATE POLICY attribution_allocations_commission_read ON kauro.attribution_allocations FOR SELECT TO kauro_commission USING (true);

ALTER TABLE kauro.attribution_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.attribution_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY attribution_claims_owner_read ON kauro.attribution_claims FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY attribution_claims_owner_rule ON kauro.attribution_claims FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner() AND (decided_by_user_id IS NULL OR decided_by_user_id = kauro.current_user_id()));
CREATE POLICY attribution_claims_seller_read ON kauro.attribution_claims FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
-- CMD046: an ACTIVE seller submits its own claim, and writes it DISPUTED in the same transaction when a conflict is found
CREATE POLICY attribution_claims_seller_submit ON kauro.attribution_claims FOR INSERT TO kauro_app
  WITH CHECK (seller_id = kauro.acting_seller_id() AND state = 'SUBMITTED');
CREATE POLICY attribution_claims_seller_conflict ON kauro.attribution_claims FOR UPDATE TO kauro_app
  USING (seller_id = kauro.acting_seller_id() AND state = 'SUBMITTED') WITH CHECK (seller_id = kauro.acting_seller_id() AND state IN ('SUBMITTED', 'DISPUTED'));
CREATE POLICY attribution_claims_commission ON kauro.attribution_claims FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.allocation_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.allocation_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY allocation_shares_owner_read ON kauro.allocation_shares FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY allocation_shares_owner_prepare ON kauro.allocation_shares FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY allocation_shares_seller_read ON kauro.allocation_shares FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY allocation_shares_commission_read ON kauro.allocation_shares FOR SELECT TO kauro_commission USING (true);

ALTER TABLE kauro.assistance_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.assistance_agreements FORCE ROW LEVEL SECURITY;
CREATE POLICY assistance_agreements_owner_read ON kauro.assistance_agreements FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY assistance_agreements_owner_record ON kauro.assistance_agreements FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());
CREATE POLICY assistance_agreements_seller_read ON kauro.assistance_agreements FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY assistance_agreements_commission_read ON kauro.assistance_agreements FOR SELECT TO kauro_commission USING (true);

ALTER TABLE kauro.commission_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY commission_entitlements_owner_read ON kauro.commission_entitlements FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY commission_entitlements_owner_update ON kauro.commission_entitlements FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY commission_entitlements_seller_read ON kauro.commission_entitlements FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY commission_entitlements_commission ON kauro.commission_entitlements FOR ALL TO kauro_commission USING (true) WITH CHECK (true);

ALTER TABLE kauro.service_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.service_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY service_assignments_owner_read ON kauro.service_assignments FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY service_assignments_owner_prepare ON kauro.service_assignments FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND prepared_by_user_id = kauro.current_user_id());
CREATE POLICY service_assignments_seller_read ON kauro.service_assignments FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());

ALTER TABLE kauro.account_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.account_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY account_assignments_owner_read ON kauro.account_assignments FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY account_assignments_owner_assign ON kauro.account_assignments FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND recorded_by_user_id = kauro.current_user_id());
CREATE POLICY account_assignments_seller_read ON kauro.account_assignments FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());

ALTER TABLE kauro.sales_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.sales_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_accounts_owner_read ON kauro.sales_accounts FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY sales_accounts_owner_open ON kauro.sales_accounts FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY sales_accounts_owner_update ON kauro.sales_accounts FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());

ALTER TABLE kauro.termination_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.termination_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY termination_manifests_owner_read ON kauro.termination_manifests FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY termination_manifests_owner_prepare ON kauro.termination_manifests FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND prepared_by_user_id = kauro.current_user_id());

ALTER TABLE kauro.seller_terminations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.seller_terminations FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_terminations_owner_read ON kauro.seller_terminations FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY seller_terminations_owner_prepare ON kauro.seller_terminations FOR INSERT TO kauro_app
  WITH CHECK (kauro.acting_corporate_owner() AND prepared_by_user_id = kauro.current_user_id() AND effective_at IS NULL);
CREATE POLICY seller_terminations_owner_effect ON kauro.seller_terminations FOR UPDATE TO kauro_app
  USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY seller_terminations_seller_read ON kauro.seller_terminations FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id() AND effective_at IS NOT NULL);

ALTER TABLE kauro.termination_tail_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.termination_tail_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY termination_tail_entries_owner_read ON kauro.termination_tail_entries FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY termination_tail_entries_owner_record ON kauro.termination_tail_entries FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY termination_tail_entries_seller_read ON kauro.termination_tail_entries FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
CREATE POLICY termination_tail_entries_commission_read ON kauro.termination_tail_entries FOR SELECT TO kauro_commission USING (true);

-- --- policies on 0028 and B06 tables (additive; nothing existing is edited) ---------------------------------------------------------
-- the history of the corporate machines has no agency: the owner and the sellers record it through their rows' triggers (the
-- insert itself is admitted only one trigger level below a client's statement, commercial_transitions_recorded_by_trigger)
CREATE POLICY commercial_transitions_corporate_record ON kauro.commercial_transitions FOR INSERT TO kauro_app
  WITH CHECK (agency_id IS NULL AND (kauro.current_seller_id() IS NOT NULL OR kauro.acting_corporate_owner()));
-- the owner reads which agencies have a qualifying purchase (the tail guard, KC011; the owner's commercial views)
CREATE POLICY qualifying_purchases_owner_read ON kauro.qualifying_purchases FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
-- the owner reads the identities of sellers (KC005 repeats "a verified identity with MFA"), never another person's
CREATE POLICY identities_owner_reads_sellers ON kauro.identities FOR SELECT TO kauro_app
  USING (kauro.acting_corporate_owner() AND EXISTS (SELECT 1 FROM kauro.sellers s WHERE s.user_id = identities.user_id));

-- --- grants (no DELETE for any runtime role) -----------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON kauro.sellers TO kauro_app;
GRANT UPDATE (version, state, agreement_id, activation_assessment_id, activated_by_user_id, activation_proof_ref, activated_at, terminated_at, updated_at) ON kauro.sellers TO kauro_app;
GRANT SELECT ON kauro.sellers TO kauro_commission;
GRANT SELECT, INSERT ON kauro.seller_legal_reviews, kauro.seller_assessments, kauro.seller_confidentiality_acceptances, kauro.seller_tax_documents TO kauro_app;
GRANT SELECT, INSERT ON kauro.seller_agreements TO kauro_app;
GRANT UPDATE (version, signed_at, signature_evidence_hash, ends_at, updated_at) ON kauro.seller_agreements TO kauro_app;
GRANT SELECT ON kauro.seller_agreements TO kauro_commission;
GRANT SELECT, INSERT ON kauro.seller_payout_destinations TO kauro_app;
GRANT UPDATE (version, state, verified_by_user_id, verified_at, rejected_at, superseded_at, updated_at) ON kauro.seller_payout_destinations TO kauro_app;
GRANT SELECT, INSERT ON kauro.prospect_source_evidence, kauro.prospect_contacts, kauro.prospect_suppressions, kauro.claim_evidence TO kauro_app;
GRANT SELECT, INSERT ON kauro.prospects TO kauro_app;
GRANT UPDATE (version, state, suppressed, owner_seller_id, updated_at) ON kauro.prospects TO kauro_app;
GRANT SELECT, INSERT ON kauro.attribution_allocations TO kauro_app;
GRANT UPDATE (version, frozen_at, frozen_by_user_id, updated_at) ON kauro.attribution_allocations TO kauro_app;
GRANT SELECT ON kauro.attribution_allocations TO kauro_commission;
GRANT SELECT, INSERT ON kauro.attribution_claims TO kauro_app;
GRANT UPDATE (version, state, conflict_reason, agency_id, allocation_id, accepted_at, expires_at, rejected_at, lapsed_at, decided_by_user_id, updated_at) ON kauro.attribution_claims TO kauro_app;
GRANT SELECT ON kauro.attribution_claims TO kauro_commission;
GRANT UPDATE (version, state, lapsed_at, converted_at, updated_at) ON kauro.attribution_claims TO kauro_commission;
GRANT SELECT, INSERT ON kauro.allocation_shares TO kauro_app;
GRANT SELECT ON kauro.allocation_shares TO kauro_commission;
GRANT SELECT, INSERT ON kauro.assistance_agreements TO kauro_app;
GRANT SELECT ON kauro.assistance_agreements TO kauro_commission;
GRANT SELECT ON kauro.commission_entitlements TO kauro_app;
GRANT UPDATE (version, state, terminated_at, updated_at) ON kauro.commission_entitlements TO kauro_app;
GRANT SELECT, INSERT ON kauro.commission_entitlements TO kauro_commission;
GRANT UPDATE (version, state, expired_at, updated_at) ON kauro.commission_entitlements TO kauro_commission;
GRANT SELECT, INSERT ON kauro.service_assignments, kauro.account_assignments TO kauro_app;
GRANT SELECT, INSERT ON kauro.sales_accounts TO kauro_app;
GRANT UPDATE (version, current_assignment_id, updated_at) ON kauro.sales_accounts TO kauro_app;
GRANT SELECT, INSERT ON kauro.termination_manifests, kauro.termination_tail_entries TO kauro_app;
GRANT SELECT ON kauro.termination_tail_entries TO kauro_commission;
GRANT SELECT, INSERT ON kauro.seller_terminations TO kauro_app;
GRANT UPDATE (version, manifest_id, effective_at, terminated_by_user_id, updated_at) ON kauro.seller_terminations TO kauro_app;
