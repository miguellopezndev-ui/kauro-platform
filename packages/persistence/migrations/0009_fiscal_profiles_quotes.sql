-- 0009 — fiscal profiles, quotes and price eligibility snapshots (package B09).
--
-- Authority: 07 "Quote and checkout states" (Quote is DRAFT, ISSUED, ACCEPTED_FOR_CHECKOUT, EXPIRED, SUPERSEDED or WITHDRAWN;
-- issued monetary terms are immutable; a changed price, quantity, discount or tax creates a new quote; the pricing rule version
-- and source count evidence are part of the subject), 16 "Quote calculation" (units and mode, base band, one non-stacking
-- discount rounded once in minor units, net service, validated tax treatment, total and currency; the quote records pricing
-- version, quantity evidence, discount facts, tax profile, legal issuer, source/plan/target hashes, expiry and
-- dataAvailableUntil), 16 "Recurrence decision" and "Founding incentive", 15 "FiscalProfile" (unknown facts remain unresolved
-- and block affected fiscal claims; no default tax rate substitutes for actual applicability), reference/
-- HASHING_AND_ACCOUNTING_RULES "Exact money" (rounded = floor((B x r + 5000) / 10000) for a nonnegative basis B and rate r in
-- basis points) and "Price and recurrence snapshots", registry contracts Quote, PriceEligibilitySnapshot, FiscalProfile.
-- Decisions D-QUOTE-B1..B4, D-FISC-B1..B2 in docs/design/B09-payments-fiscal.md.

-- --- fiscal profiles (reviewed, immutable versions; D-FISC-B1) --------------------------------------------------------------------
-- One row per reviewed version of the tax facts between the operator (fiscal issuer) and one purchasing agency. The treatment
-- is a reviewed conclusion only: REVIEW_REQUIRED is the explicit unknown and carries no rule, so nothing downstream can
-- compute a tax from it (R2-128: export exemption is never inferred from currency or an email address). A correction is a new
-- row that supersedes the previous one; the only change a row admits is its supersession, once.
CREATE TABLE kauro.fiscal_profiles (
  profile_id              uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(profile_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  operator_legal_ref      uuid NOT NULL REFERENCES kauro.fiscal_issuers (issuer_ref),
  -- the actual purchaser identity (the agency's legal/billing profile, Agency.legalProfileRef; its store is the billing
  -- profile package's, so this is an opaque reference here)
  customer_legal_ref      uuid NOT NULL,
  service_classification  text NOT NULL CHECK (service_classification ~ '^[A-Z][A-Z0-9_.-]{1,63}$'),
  territory               text NOT NULL CHECK (territory ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
  tax_treatment           text NOT NULL CHECK (tax_treatment IN ('REVIEW_REQUIRED', 'DOMESTIC_TAXABLE', 'EXEMPT_EXPORT', 'OTHER_REVIEWED')),
  -- the reviewed computation rule: UNRESOLVED (no rule), RATE_HALF_UP (one rate in basis points, rounded half up once at the
  -- document boundary), ZERO_REVIEWED (a reviewed zero); a rule outside this list needs a schema change, never a default
  tax_rule                text NOT NULL CHECK (tax_rule IN ('UNRESOLVED', 'RATE_HALF_UP', 'ZERO_REVIEWED')),
  tax_rate_bps            integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  evidence_hash           text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  export_evidence_hash    text CHECK (export_evidence_hash IS NULL OR kauro.is_sha256_hex(export_evidence_hash)),
  reviewed_by_ref         uuid,
  valid_from              timestamptz NOT NULL,
  valid_until             timestamptz,
  supersedes_profile_id   uuid,
  superseded_at           timestamptz,
  created_at              timestamptz NOT NULL,
  UNIQUE (agency_id, profile_id),
  -- binding target for quotes: a quote snapshots exactly the treatment and rule of the profile it names
  UNIQUE (agency_id, profile_id, tax_treatment, tax_rule, tax_rate_bps),
  FOREIGN KEY (agency_id, supersedes_profile_id) REFERENCES kauro.fiscal_profiles (agency_id, profile_id),
  CONSTRAINT fiscal_profiles_treatment_rule CHECK (
       (tax_treatment = 'REVIEW_REQUIRED' AND tax_rule = 'UNRESOLVED' AND tax_rate_bps = 0)
    OR (tax_treatment = 'DOMESTIC_TAXABLE' AND tax_rule = 'RATE_HALF_UP' AND tax_rate_bps > 0)
    OR (tax_treatment = 'EXEMPT_EXPORT' AND tax_rule = 'ZERO_REVIEWED' AND tax_rate_bps = 0 AND export_evidence_hash IS NOT NULL)
    OR (tax_treatment = 'OTHER_REVIEWED' AND ((tax_rule = 'RATE_HALF_UP' AND tax_rate_bps > 0) OR (tax_rule = 'ZERO_REVIEWED' AND tax_rate_bps = 0)))
  ),
  CONSTRAINT fiscal_profiles_reviewed_names_reviewer CHECK (tax_treatment = 'REVIEW_REQUIRED' OR reviewed_by_ref IS NOT NULL),
  CONSTRAINT fiscal_profiles_validity CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT fiscal_profiles_no_self_lineage CHECK (supersedes_profile_id IS DISTINCT FROM profile_id)
);
-- exactly one current version per agency; a successor supersedes a predecessor once
CREATE UNIQUE INDEX fiscal_profiles_one_current ON kauro.fiscal_profiles (agency_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX fiscal_profiles_supersedes_once ON kauro.fiscal_profiles (agency_id, supersedes_profile_id) WHERE supersedes_profile_id IS NOT NULL;
CREATE TRIGGER fiscal_profiles_immutable BEFORE UPDATE ON kauro.fiscal_profiles
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('profile_id,agency_id,operator_legal_ref,customer_legal_ref,service_classification,territory,tax_treatment,tax_rule,tax_rate_bps,evidence_hash,export_evidence_hash,reviewed_by_ref,valid_from,valid_until,supersedes_profile_id,created_at');

CREATE OR REPLACE FUNCTION kauro.fiscal_profiles_supersede_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: fiscal profile % supersession cannot change once recorded', OLD.profile_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fiscal_profiles_supersede_once BEFORE UPDATE ON kauro.fiscal_profiles FOR EACH ROW EXECUTE FUNCTION kauro.fiscal_profiles_supersede_once();

-- --- binding targets B09 adds to B06 tables -------------------------------------------------------------------------------------
-- A quote prices one plan revision of one project under the live approval of that same plan: the pairs are bound by keys, not
-- by an application check (07 "Application checks improve messages but cannot be the sole protection").
ALTER TABLE kauro.plans ADD CONSTRAINT plans_binding_project UNIQUE (agency_id, plan_id, project_id);
ALTER TABLE kauro.approvals ADD CONSTRAINT approvals_binding_plan UNIQUE (agency_id, approval_id, plan_id);

-- --- quotes (D-QUOTE-B1..B4) ------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.quotes (
  quote_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(quote_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                uuid NOT NULL,
  -- the approved plan revision and the live approval the quote prices ("Priced approved scope"; CMD028 "approval remains exact")
  plan_id                   uuid NOT NULL,
  approval_id               uuid NOT NULL,
  version                   bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                     text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT', 'EXPIRED', 'SUPERSEDED', 'WITHDRAWN')),
  revision_hash             text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  plan_hash                 text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  target_contract_hash      text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  billable_units            bigint NOT NULL CHECK (billable_units > 0),
  mode                      text NOT NULL CHECK (mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  price_policy_version      text NOT NULL CHECK (price_policy_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  discount_policy_version   text NOT NULL CHECK (discount_policy_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  base_service_cents        bigint NOT NULL CHECK (kauro.is_money(base_service_cents) AND base_service_cents > 0),
  discount_bps              integer NOT NULL CHECK (discount_bps BETWEEN 0 AND 10000),
  discount_cents            bigint NOT NULL CHECK (kauro.is_money(discount_cents)),
  service_cents             bigint NOT NULL CHECK (kauro.is_money(service_cents)),
  fiscal_profile_id         uuid NOT NULL,
  -- REVIEW_REQUIRED is absent on purpose: incomplete tax facts block issuance (CMD027 failure; R2-082)
  tax_treatment             text NOT NULL CHECK (tax_treatment IN ('DOMESTIC_TAXABLE', 'EXEMPT_EXPORT', 'OTHER_REVIEWED')),
  tax_rule                  text NOT NULL CHECK (tax_rule IN ('RATE_HALF_UP', 'ZERO_REVIEWED')),
  tax_rate_bps              integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_cents                 bigint NOT NULL CHECK (kauro.is_money(tax_cents)),
  total_cents               bigint NOT NULL CHECK (kauro.is_money(total_cents) AND total_cents > 0),
  currency                  text NOT NULL CHECK (currency IN ('USD')),
  eligibility_snapshot_id   uuid NOT NULL,
  terms_hash                text NOT NULL CHECK (kauro.is_sha256_hex(terms_hash)),
  terms_version             text NOT NULL CHECK (terms_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  issued_at                 timestamptz NOT NULL,
  expires_at                timestamptz NOT NULL,
  source_available_until    timestamptz NOT NULL,
  superseded_by_quote_id    uuid,
  created_by_membership_id  uuid NOT NULL,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  UNIQUE (agency_id, quote_id),
  -- binding targets: a payment order charges exactly the quoted total, currency and terms; the eligibility snapshot applies
  -- exactly the quoted discount for this project at the issuance instant under the quoted discount policy
  UNIQUE (agency_id, quote_id, total_cents, currency, terms_hash),
  UNIQUE (agency_id, quote_id, discount_bps, project_id, issued_at, discount_policy_version),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, plan_id, project_id) REFERENCES kauro.plans (agency_id, plan_id, project_id),
  FOREIGN KEY (agency_id, plan_id, plan_hash, revision_hash, target_contract_hash)
    REFERENCES kauro.plans (agency_id, plan_id, body_hash, revision_hash, target_contract_hash),
  FOREIGN KEY (agency_id, approval_id, plan_id) REFERENCES kauro.approvals (agency_id, approval_id, plan_id),
  FOREIGN KEY (agency_id, fiscal_profile_id, tax_treatment, tax_rule, tax_rate_bps)
    REFERENCES kauro.fiscal_profiles (agency_id, profile_id, tax_treatment, tax_rule, tax_rate_bps),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  FOREIGN KEY (agency_id, superseded_by_quote_id) REFERENCES kauro.quotes (agency_id, quote_id) DEFERRABLE INITIALLY DEFERRED,
  -- exact minor-unit arithmetic (R2-077): the discount is rounded once from the undiscounted base, service = base - discount
  CONSTRAINT quotes_discount_arithmetic CHECK (discount_cents = (base_service_cents * discount_bps + 5000) / 10000),
  CONSTRAINT quotes_service_arithmetic CHECK (service_cents = base_service_cents - discount_cents),
  -- the tax comes from the reviewed rule of the named profile, rounded once; a reviewed zero is zero
  CONSTRAINT quotes_tax_rule CHECK (
       (tax_rule = 'ZERO_REVIEWED' AND tax_rate_bps = 0 AND tax_cents = 0)
    OR (tax_rule = 'RATE_HALF_UP' AND tax_rate_bps > 0 AND tax_cents = (service_cents * tax_rate_bps + 5000) / 10000)
  ),
  CONSTRAINT quotes_total_arithmetic CHECK (total_cents = service_cents + tax_cents),
  CONSTRAINT quotes_validity CHECK (expires_at > issued_at),
  CONSTRAINT quotes_superseded_names_successor CHECK ((state = 'SUPERSEDED') = (superseded_by_quote_id IS NOT NULL)),
  CONSTRAINT quotes_no_self_lineage CHECK (superseded_by_quote_id IS DISTINCT FROM quote_id)
);
-- one open, not yet accepted offer per project: a new binding quote supersedes the previous one explicitly
CREATE UNIQUE INDEX quotes_one_issued_per_project ON kauro.quotes (agency_id, project_id) WHERE state = 'ISSUED';
CREATE INDEX quotes_by_project ON kauro.quotes (agency_id, project_id, created_at, quote_id);
CREATE TRIGGER quotes_touch BEFORE UPDATE ON kauro.quotes FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER quotes_version BEFORE UPDATE ON kauro.quotes FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
-- issued terms are immutable (Quote invariant "terms are immutable once issued")
CREATE TRIGGER quotes_immutable BEFORE UPDATE ON kauro.quotes
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('quote_id,agency_id,project_id,plan_id,approval_id,revision_hash,plan_hash,target_contract_hash,billable_units,mode,price_policy_version,discount_policy_version,base_service_cents,discount_bps,discount_cents,service_cents,fiscal_profile_id,tax_treatment,tax_rule,tax_rate_bps,tax_cents,total_cents,currency,eligibility_snapshot_id,terms_hash,terms_version,issued_at,expires_at,source_available_until,created_by_membership_id,created_at');
CREATE TRIGGER quotes_transition BEFORE UPDATE OF state ON kauro.quotes
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Quote');
CREATE CONSTRAINT TRIGGER quotes_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.quotes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('quote', 'quote_id');

-- Quote machine (platform, D-QUOTE-B2; 07 lists the states, the registry has no machine): an accepted quote leaves the live
-- set only by expiry, supersession or withdrawal, each guarded in the application by "no capture completed, in flight or
-- uncertain" (16 "releases it only after proving that no capture is in flight or uncertain").
INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Quote', 'DRAFT', 'ISSUED'),
  ('Quote', 'DRAFT', 'WITHDRAWN'),
  ('Quote', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT'),
  ('Quote', 'ISSUED', 'EXPIRED'),
  ('Quote', 'ISSUED', 'SUPERSEDED'),
  ('Quote', 'ISSUED', 'WITHDRAWN'),
  ('Quote', 'ACCEPTED_FOR_CHECKOUT', 'EXPIRED'),
  ('Quote', 'ACCEPTED_FOR_CHECKOUT', 'SUPERSEDED'),
  ('Quote', 'ACCEPTED_FOR_CHECKOUT', 'WITHDRAWN');

-- --- price eligibility snapshots (D-QUOTE-B3) ---------------------------------------------------------------------------------------
-- The frozen recurrence and founding facts of one quote, evaluated once at its issuance instant (reference/HASHING
-- "Evaluate the 365-day lookback at one server issuance instant and persist the exact eligible set"). Append-only: "A price
-- snapshot cannot change after capture because later history changes".
CREATE TABLE kauro.price_eligibility_snapshots (
  snapshot_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(snapshot_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  quote_id                uuid NOT NULL,
  project_id              uuid NOT NULL,
  as_of                   timestamptz NOT NULL,
  lookback_starts_at      timestamptz NOT NULL,
  qualifying_project_ids  uuid[] NOT NULL,
  qualifying_count        integer NOT NULL CHECK (qualifying_count >= 0),
  repeat_discount_bps     integer NOT NULL CHECK (repeat_discount_bps BETWEEN 0 AND 10000),
  -- the atomic founding reservation (16 "Founding incentive"); its store belongs to the recurrence package (B10), which adds
  -- the foreign key when it creates that table
  founding_slot_ref       uuid,
  founding_discount_bps   integer NOT NULL CHECK (founding_discount_bps BETWEEN 0 AND 10000),
  applied_discount_bps    integer NOT NULL CHECK (applied_discount_bps BETWEEN 0 AND 10000),
  policy_version          text NOT NULL CHECK (policy_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  created_at              timestamptz NOT NULL,
  UNIQUE (agency_id, snapshot_id),
  UNIQUE (agency_id, snapshot_id, quote_id),
  UNIQUE (agency_id, quote_id),
  FOREIGN KEY (agency_id, quote_id, applied_discount_bps, project_id, as_of, policy_version)
    REFERENCES kauro.quotes (agency_id, quote_id, discount_bps, project_id, issued_at, discount_policy_version),
  CONSTRAINT price_eligibility_distinct_set CHECK (kauro.is_distinct_uuid_set(qualifying_project_ids)),
  CONSTRAINT price_eligibility_count_is_set_size CHECK (qualifying_count = cardinality(qualifying_project_ids)),
  -- the current project is excluded from its own denominator (16 "Recurrence decision")
  CONSTRAINT price_eligibility_excludes_current CHECK (NOT (project_id = ANY (qualifying_project_ids))),
  CONSTRAINT price_eligibility_lookback CHECK (lookback_starts_at = as_of - interval '365 days'),
  CONSTRAINT price_eligibility_founding_binding CHECK ((founding_slot_ref IS NULL) = (founding_discount_bps = 0)),
  -- discounts select the maximum eligible rate, never a sum (policy pricing.discountCombination MAX_NOT_STACKED)
  CONSTRAINT price_eligibility_max_not_stacked CHECK (applied_discount_bps = GREATEST(repeat_discount_bps, founding_discount_bps)),
  -- the R2-INITIAL rule (policy pricing.repeatTiers 0/1/10/25 -> 0/500/1000/1500 bps, foundingDiscountBps 2500); a later
  -- policy version brings its own rule in its own migration
  CONSTRAINT price_eligibility_r2_initial_tiers CHECK (
    policy_version <> 'R2-INITIAL'
    OR (repeat_discount_bps = CASE WHEN qualifying_count = 0 THEN 0 WHEN qualifying_count < 10 THEN 500 WHEN qualifying_count < 25 THEN 1000 ELSE 1500 END
        AND founding_discount_bps IN (0, 2500))
  )
);
CREATE TRIGGER price_eligibility_snapshots_append_only BEFORE UPDATE OR DELETE ON kauro.price_eligibility_snapshots
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- every quote carries its own snapshot (checked at commit: the quote row is written first, the snapshot names it)
ALTER TABLE kauro.quotes ADD CONSTRAINT quotes_eligibility_snapshot_fk
  FOREIGN KEY (agency_id, eligibility_snapshot_id, quote_id) REFERENCES kauro.price_eligibility_snapshots (agency_id, snapshot_id, quote_id)
  DEFERRABLE INITIALLY DEFERRED;

-- --- row-level security -------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.fiscal_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.fiscal_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_profiles_read ON kauro.fiscal_profiles FOR SELECT TO kauro_app USING (kauro.in_commerce_scope(agency_id));
-- a reviewed version is recorded by a corporate operator in the finance scope of that agency, or by the control plane
CREATE POLICY fiscal_profiles_operator_insert ON kauro.fiscal_profiles FOR INSERT TO kauro_app
  WITH CHECK (kauro.current_principal() = 'OPERATOR' AND agency_id = kauro.current_finance_agency_id());
CREATE POLICY fiscal_profiles_operator_supersede ON kauro.fiscal_profiles FOR UPDATE TO kauro_app
  USING (kauro.current_principal() = 'OPERATOR' AND agency_id = kauro.current_finance_agency_id())
  WITH CHECK (kauro.current_principal() = 'OPERATOR' AND agency_id = kauro.current_finance_agency_id());
CREATE POLICY fiscal_profiles_control ON kauro.fiscal_profiles FOR ALL TO kauro_control USING (true) WITH CHECK (true);

ALTER TABLE kauro.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY quotes_commerce ON kauro.quotes FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

ALTER TABLE kauro.price_eligibility_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.price_eligibility_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY price_eligibility_snapshots_commerce ON kauro.price_eligibility_snapshots FOR ALL TO kauro_app
  USING (kauro.in_commerce_scope(agency_id)) WITH CHECK (kauro.in_commerce_scope(agency_id));

-- --- grants -------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON kauro.fiscal_profiles TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.fiscal_profiles TO kauro_control;
GRANT SELECT, INSERT, UPDATE ON kauro.quotes TO kauro_app;
GRANT SELECT, INSERT ON kauro.price_eligibility_snapshots TO kauro_app;
