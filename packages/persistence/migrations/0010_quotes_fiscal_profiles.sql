-- 0010 — known price policies, fiscal profiles, quotes and price-eligibility snapshots (package B09).
--
-- Authority: 16 "Price schedule", "Recurrence decision", "Founding incentive", "Quote calculation" (calculation order: billable
-- units and mode → base band → the single highest eligible discount, never a sum → the discount rounded once in minor units →
-- net service → the reviewed tax treatment → total), registry policy pricing (R2-INITIAL: bands, repeat tiers, founding rate,
-- quoteDays 14, repeatLookbackDays 365, MAX_NOT_STACKED) and money (USD, minor unit 2, HALF_UP_ON_NONNEGATIVE_RATIONAL),
-- reference/HASHING_AND_ACCOUNTING_RULES "Exact money" (rounded = floor((B x r + 5000) / 10000)) and "Price and recurrence
-- snapshots", 07 "Quote and checkout states" (a quote freezes terms; price expiry and source availability are separate dates),
-- 15 "FiscalProfile" (reviewed versions; unknown facts remain unresolved and block affected fiscal claims; no treatment is
-- inferred from an email, a currency or an address), registry contracts FiscalProfile, Quote, PriceEligibilitySnapshot.
-- reference/HASHING_AND_ACCOUNTING_RULES "Retention formulas" (UTC instants; a duration day is exactly 86400 seconds), 07 "Quote
-- and checkout states" (a fourteen-day price lifetime does not extend source retention), COMMERCIAL_LEDGER_WORKED_EXAMPLES §16
-- and §18. Design: docs/design/B09-payments-fiscal.md (D-QUOTE-B1..B7, D-FISC-B1, D-FISC-B2, D-MONEY-B1, D-BIND-B1, D-TIME-B1).

-- --- exact arithmetic of the pricing policy (the database re-checks what the domain computes; D-MONEY-B1) --------------------------
-- The platform's one rounding primitive for a non-negative basis and a rate in basis points, computed in numeric so no product
-- can overflow (2^53 x 10000 exceeds bigint): div() of non-negative operands is the floor.
CREATE OR REPLACE FUNCTION kauro.round_half_up_bps(basis bigint, bps integer) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT div(basis::numeric * bps + 5000, 10000)::bigint $$;

-- The R2-INITIAL base band of a mode for a number of billable units (registry policy pricing.bands), or NULL when there is
-- nothing to sell: zero units, or units beyond the last band (the future schedule is not an offer). The persistence test proves
-- this table equals the vendored registry band by band.
CREATE OR REPLACE FUNCTION kauro.r2_initial_base_cents(mode text, units bigint) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT CASE
    WHEN units < 1 OR units > 1000000 THEN NULL
    WHEN units <= 50000 THEN CASE mode WHEN 'CLEAN' THEN 69500 WHEN 'HUBSPOT' THEN 129500 WHEN 'SALESFORCE' THEN 149500 END
    WHEN units <= 150000 THEN CASE mode WHEN 'CLEAN' THEN 109500 WHEN 'HUBSPOT' THEN 199500 WHEN 'SALESFORCE' THEN 229500 END
    WHEN units <= 500000 THEN CASE mode WHEN 'CLEAN' THEN 179500 WHEN 'HUBSPOT' THEN 299500 WHEN 'SALESFORCE' THEN 349500 END
    ELSE CASE mode WHEN 'CLEAN' THEN 269500 WHEN 'HUBSPOT' THEN 449500 WHEN 'SALESFORCE' THEN 499500 END
  END::bigint
$$;

-- The R2-INITIAL recurrence tier of a count of prior qualifying projects (registry policy pricing.repeatTiers: 0 / 1-9 / 10-24 / 25+).
CREATE OR REPLACE FUNCTION kauro.r2_initial_repeat_bps(qualifying integer) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog AS
$$ SELECT CASE WHEN qualifying >= 25 THEN 1500 WHEN qualifying >= 10 THEN 1000 WHEN qualifying >= 1 THEN 500 ELSE 0 END $$;

-- --- known price policies (B09-F10; D-QUOTE-B5) -----------------------------------------------------------------------------------------
-- A quote and its eligibility snapshot name the price policy they were priced under; only a policy this table knows can be named
-- (foreign keys), so no quote can escape the schedule's CHECKs by naming an unknown version. The rows are migration-owned
-- reference data mirrored from the vendored registry policy (the persistence test proves R2-INITIAL equal to policy.pricing and
-- policy.retention); a later policy is a later migration's INSERT, reviewed with its CHECK arm. Durations are exact seconds
-- (reference/HASHING "Retention formulas": a duration day is 86400 seconds, D-TIME-B1): quote_seconds = quoteDays × 86400,
-- repeat_lookback_seconds = repeatLookbackDays × 86400, unpaid_source_hard_seconds = retention.unpaidDaysHardFromSeal × 86400
-- (the latest instant a quote may promise its sealed source stays available), pre_execution_replacements_included =
-- customerPreExecutionSourceReplacementsIncluded (the one included source replacement a paid purchase may be re-bound to, 16
-- "Scope changes and credits"; D-QUOTE-B6). Append-only; readable by the request handlers and the payment service; no runtime
-- role writes it.
CREATE TABLE kauro.price_policies (
  policy_version                       text PRIMARY KEY CHECK (policy_version ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  quote_seconds                        integer NOT NULL CHECK (quote_seconds > 0),
  repeat_lookback_seconds              integer NOT NULL CHECK (repeat_lookback_seconds > 0),
  founding_discount_bps                integer NOT NULL CHECK (founding_discount_bps BETWEEN 0 AND 10000),
  pre_execution_replacements_included  integer NOT NULL CHECK (pre_execution_replacements_included >= 0),
  unpaid_source_hard_seconds           integer NOT NULL CHECK (unpaid_source_hard_seconds > 0)
);
INSERT INTO kauro.price_policies (policy_version, quote_seconds, repeat_lookback_seconds, founding_discount_bps, pre_execution_replacements_included, unpaid_source_hard_seconds)
  VALUES ('R2-INITIAL', 1209600, 31536000, 2500, 1, 1209600);
CREATE TRIGGER price_policies_append_only BEFORE UPDATE OR DELETE ON kauro.price_policies FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER price_policies_no_truncate BEFORE TRUNCATE ON kauro.price_policies FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
ALTER TABLE kauro.price_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.price_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY price_policies_read ON kauro.price_policies FOR SELECT TO kauro_app, kauro_payment USING (true);
GRANT SELECT ON kauro.price_policies TO kauro_app, kauro_payment;

-- --- binding keys on B06 tables (D-BIND-B1) ----------------------------------------------------------------------------------------------
-- Composite foreign keys bind tenant and parent identity (08 "Database isolation"; 07 "Composite foreign keys ... prevent a
-- project in one agency from referencing another agency's revision, quote, package or client"). The commerce aggregates copy the
-- exact subject they were sold or authorized for — plan, approval, mode, capability — and these keys make every copy the
-- original's: additive UNIQUE targets on B06 tables, no B06 column or rule changes.
ALTER TABLE kauro.plans ADD CONSTRAINT plans_project_binding UNIQUE (agency_id, plan_id, project_id);
ALTER TABLE kauro.projects ADD CONSTRAINT projects_mode_binding UNIQUE (agency_id, project_id, mode);
ALTER TABLE kauro.projects ADD CONSTRAINT projects_capability_binding UNIQUE (agency_id, project_id, mode, capability_id, capability_version);
ALTER TABLE kauro.approvals ADD CONSTRAINT approvals_hash_binding UNIQUE (agency_id, approval_id, approval_hash);
ALTER TABLE kauro.command_journal ADD CONSTRAINT command_journal_agency_binding UNIQUE (agency_id, entry_id);

-- --- fiscal profiles (D-FISC-B1) ---------------------------------------------------------------------------------------------------------
-- A reviewed version per row (15 "FiscalProfile": "Reviewed version identity"; "Unknown facts remain unresolved and block
-- affected fiscal claims"). REVIEW_REQUIRED is the explicit unknown and carries no rule; every other treatment names its rule, its
-- rate, its reviewer and — for an exempt export — the reviewed export facts (R2-128: never inferred from a currency or a foreign
-- email; R2-082: no guessed zero VAT). A new version supersedes the current one exactly once, in the same transaction. The current
-- profile is a transition subject (B06 D-TX-2) keyed by the agency: a quote issuance or a fiscal validation in flight is ordered
-- before or after a re-review, never interleaved with it.
--
-- Writers: a corporate owner in the agency's finance scope (kauro.in_finance_scope: an OPERATOR context with an ACTIVE KAURO_OWNER
-- grant; D-CTX-B2). Readers: the agency (its quotes show the tax status), the finance scope, and the payment service in the adopted
-- agency (the fiscal document drafter).
CREATE TABLE kauro.fiscal_profiles (
  profile_id              uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(profile_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  operator_legal_ref      uuid NOT NULL REFERENCES kauro.fiscal_issuers (issuer_ref),
  customer_legal_ref      uuid NOT NULL,
  service_classification  text NOT NULL CHECK (kauro.is_label(service_classification)),
  territory               text NOT NULL CHECK (kauro.is_label(territory)),
  tax_treatment           text NOT NULL CHECK (tax_treatment IN ('REVIEW_REQUIRED', 'DOMESTIC_TAXABLE', 'EXEMPT_EXPORT', 'OTHER_REVIEWED')),
  tax_rule                text NOT NULL CHECK (tax_rule IN ('UNRESOLVED', 'RATE_HALF_UP', 'ZERO_REVIEWED')),
  tax_rate_bps            integer NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  evidence_hash           text NOT NULL CHECK (kauro.is_sha256_hex(evidence_hash)),
  export_evidence_hash    text CHECK (export_evidence_hash IS NULL OR kauro.is_sha256_hex(export_evidence_hash)),
  reviewed_by_user_id     uuid REFERENCES kauro.identities (user_id),
  valid_from              timestamptz NOT NULL,
  valid_until             timestamptz,
  supersedes_profile_id   uuid,
  superseded_at           timestamptz,
  created_at              timestamptz NOT NULL,
  UNIQUE (agency_id, profile_id),
  -- binding target of quotes_fiscal_fk: a quote's tax snapshot is exactly its profile's reviewed rule and issuer
  CONSTRAINT fiscal_profiles_snapshot_binding UNIQUE (agency_id, profile_id, operator_legal_ref, tax_treatment, tax_rule, tax_rate_bps),
  FOREIGN KEY (agency_id, supersedes_profile_id) REFERENCES kauro.fiscal_profiles (agency_id, profile_id),
  -- the explicit unknown carries no rule; a reviewed treatment carries its rule, rate and reviewer
  CONSTRAINT fiscal_profiles_treatment_rule CHECK (
    (tax_treatment = 'REVIEW_REQUIRED' AND tax_rule = 'UNRESOLVED' AND tax_rate_bps = 0)
    OR (tax_treatment = 'DOMESTIC_TAXABLE' AND tax_rule = 'RATE_HALF_UP' AND tax_rate_bps BETWEEN 1 AND 10000)
    OR (tax_treatment = 'EXEMPT_EXPORT' AND tax_rule = 'ZERO_REVIEWED' AND tax_rate_bps = 0)
    OR (tax_treatment = 'OTHER_REVIEWED' AND ((tax_rule = 'RATE_HALF_UP' AND tax_rate_bps BETWEEN 1 AND 10000) OR (tax_rule = 'ZERO_REVIEWED' AND tax_rate_bps = 0)))
  ),
  CONSTRAINT fiscal_profiles_reviewed_names_reviewer CHECK (tax_treatment = 'REVIEW_REQUIRED' OR reviewed_by_user_id IS NOT NULL),
  -- an exempt export stands on reviewed export facts, never on a currency or an email address (R2-128)
  CONSTRAINT fiscal_profiles_export_evidence CHECK ((tax_treatment = 'EXEMPT_EXPORT') = (export_evidence_hash IS NOT NULL)),
  CONSTRAINT fiscal_profiles_validity CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT fiscal_profiles_no_self_lineage CHECK (supersedes_profile_id IS DISTINCT FROM profile_id)
);
-- one current (unsuperseded) profile per agency, and a profile is superseded by exactly one successor
CREATE UNIQUE INDEX fiscal_profiles_one_current ON kauro.fiscal_profiles (agency_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX fiscal_profiles_supersedes_once ON kauro.fiscal_profiles (agency_id, supersedes_profile_id) WHERE supersedes_profile_id IS NOT NULL;
CREATE TRIGGER fiscal_profiles_immutable BEFORE UPDATE ON kauro.fiscal_profiles
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('profile_id,agency_id,operator_legal_ref,customer_legal_ref,service_classification,territory,tax_treatment,tax_rule,tax_rate_bps,evidence_hash,export_evidence_hash,reviewed_by_user_id,valid_from,valid_until,supersedes_profile_id,created_at');

CREATE OR REPLACE FUNCTION kauro.fiscal_profiles_supersede_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: fiscal profile % was already superseded', OLD.profile_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fiscal_profiles_supersede_once BEFORE UPDATE ON kauro.fiscal_profiles FOR EACH ROW EXECUTE FUNCTION kauro.fiscal_profiles_supersede_once();
-- the current profile is a transition subject of its agency (D-TX-2): superseding it takes the exclusive half
CREATE TRIGGER fiscal_profiles_transition_lock BEFORE UPDATE OF superseded_at ON kauro.fiscal_profiles
  FOR EACH ROW WHEN (OLD.superseded_at IS DISTINCT FROM NEW.superseded_at) EXECUTE FUNCTION kauro.take_transition_lock('kauro.fiscal_profiles', 'agency_id');

-- --- quotes (platform machine Quote, decision D-MACH-B1) ------------------------------------------------------------------------------------
-- The immutable commercial terms of one purchase (07 "Aggregate ownership": Quote owns immutable commercial terms). Created and
-- issued by CreateQuote (CMD027, the recurrence package B10) in one transaction — born DRAFT (version 1) and moved along
-- issue_quote to ISSUED (version 2) — and accepted for checkout by CreatePaymentOrder (CMD028). Every amount is re-checked here:
-- the discount is rounded once from the base, service = base - discount, the tax is the reviewed rule's, total = service + tax;
-- under the R2-INITIAL policy the base is the registry band of the mode and units and the price expires exactly 1,209,600
-- seconds (fourteen duration days) after issuance. The subject columns are the approved plan's own (composite keys), the tax
-- snapshot is the fiscal profile's own, and the discount is the eligibility snapshot's applied rate, evaluated at the quote's own
-- issuance instant (checked at COMMIT: the snapshot names the quote and its as_of is the quote's issued_at).
--
-- Only a known price policy can be named (price_policies; B09-F10). The source a quote promises is a SEALED revision of its
-- project, sealed no later than the issuance, and its promised availability (dataAvailableUntil, 16 "Quote calculation") lies
-- after the issuance, no later than the price expiry (07: "A fourteen-day price lifetime does not extend seven-day source
-- retention") and no later than the policy's hard cap from the seal (quotes_source_binding; the exact effective deadline comes
-- from the source lifecycle's retention record through the SourceAvailabilityReader port, D-QUOTE-B7). Interval arithmetic is in
-- exact hours or seconds, never in days on timestamptz, so no session TimeZone moves a boundary (B09-F12, D-TIME-B1).
--
-- A replacement quote (replaces_quote_id; D-QUOTE-B6) re-binds a paid purchase to a replacement revision under the one included
-- pre-execution source replacement (16 "Scope changes and credits"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18): it carries exactly the
-- replaced quote's commercial terms (same project, mode, policy, band, discount, service, tax rule and amounts: the composite key
-- quotes_replacement_terms_fk), is never paid again (no order may name it) and is accepted only by the payment service's
-- re-binding of the paid capture (purchase_rebindings, 0011).
CREATE TABLE kauro.quotes (
  quote_id                  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(quote_id)),
  agency_id                 uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id                uuid NOT NULL,
  plan_id                   uuid NOT NULL,
  approval_id               uuid NOT NULL,
  version                   bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  state                     text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT', 'EXPIRED', 'SUPERSEDED', 'WITHDRAWN')),
  revision_hash             text NOT NULL CHECK (kauro.is_sha256_hex(revision_hash)),
  plan_hash                 text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  target_contract_hash      text NOT NULL CHECK (kauro.is_sha256_hex(target_contract_hash)),
  billable_units            bigint NOT NULL CHECK (billable_units >= 1),
  mode                      text NOT NULL CHECK (mode IN ('CLEAN', 'HUBSPOT', 'SALESFORCE')),
  price_policy_version      text NOT NULL REFERENCES kauro.price_policies (policy_version),
  discount_policy_version   text NOT NULL REFERENCES kauro.price_policies (policy_version),
  base_service_cents        bigint NOT NULL CHECK (kauro.is_money(base_service_cents) AND base_service_cents > 0),
  discount_bps              integer NOT NULL CHECK (discount_bps BETWEEN 0 AND 10000),
  discount_cents            bigint NOT NULL CHECK (kauro.is_money(discount_cents)),
  service_cents             bigint NOT NULL CHECK (kauro.is_money(service_cents)),
  fiscal_profile_id         uuid NOT NULL,
  issuer_ref                uuid NOT NULL,
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
  replaces_quote_id         uuid,
  created_by_membership_id  uuid NOT NULL,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  UNIQUE (agency_id, quote_id),
  CONSTRAINT quotes_project_binding UNIQUE (agency_id, quote_id, project_id),
  -- binding target of payment_orders_quote_fk: an order charges exactly the quote's accepted terms and amounts
  CONSTRAINT quotes_order_binding UNIQUE (agency_id, quote_id, project_id, approval_id, terms_hash, total_cents, service_cents, tax_cents, currency),
  -- binding target of commercial_authorizations_quote_fk: an authorization names exactly the quoted subject
  CONSTRAINT quotes_authorization_binding UNIQUE (agency_id, quote_id, project_id, plan_id, approval_id, plan_hash, revision_hash, target_contract_hash, mode, billable_units),
  -- binding target of quotes_replacement_terms_fk: a replacement carries exactly the replaced purchase's commercial terms
  CONSTRAINT quotes_replacement_terms UNIQUE (agency_id, quote_id, project_id, mode, price_policy_version, discount_policy_version, base_service_cents, discount_bps, discount_cents, service_cents, tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency),
  FOREIGN KEY (agency_id, project_id, mode) REFERENCES kauro.projects (agency_id, project_id, mode),
  -- the quoted plan is a plan of this project, with exactly its body, source and target; the approval is that plan's
  FOREIGN KEY (agency_id, plan_id, project_id) REFERENCES kauro.plans (agency_id, plan_id, project_id),
  CONSTRAINT quotes_plan_subject_fk FOREIGN KEY (agency_id, plan_id, plan_hash, revision_hash, target_contract_hash)
    REFERENCES kauro.plans (agency_id, plan_id, body_hash, revision_hash, target_contract_hash),
  FOREIGN KEY (agency_id, approval_id, plan_id) REFERENCES kauro.approvals (agency_id, approval_id, plan_id),
  CONSTRAINT quotes_fiscal_fk FOREIGN KEY (agency_id, fiscal_profile_id, issuer_ref, tax_treatment, tax_rule, tax_rate_bps)
    REFERENCES kauro.fiscal_profiles (agency_id, profile_id, operator_legal_ref, tax_treatment, tax_rule, tax_rate_bps),
  FOREIGN KEY (agency_id, created_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  FOREIGN KEY (agency_id, superseded_by_quote_id) REFERENCES kauro.quotes (agency_id, quote_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT quotes_replacement_terms_fk FOREIGN KEY (agency_id, replaces_quote_id, project_id, mode, price_policy_version, discount_policy_version, base_service_cents, discount_bps, discount_cents, service_cents, tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency)
    REFERENCES kauro.quotes (agency_id, quote_id, project_id, mode, price_policy_version, discount_policy_version, base_service_cents, discount_bps, discount_cents, service_cents, tax_treatment, tax_rule, tax_rate_bps, tax_cents, total_cents, currency),
  -- 16 "Quote calculation": the discount rounded once from the base, service after it, the reviewed tax, the total
  CONSTRAINT quotes_discount_arithmetic CHECK (discount_cents = kauro.round_half_up_bps(base_service_cents, discount_bps)),
  CONSTRAINT quotes_service_arithmetic CHECK (service_cents = base_service_cents - discount_cents),
  CONSTRAINT quotes_tax_arithmetic CHECK (
    (tax_rule = 'RATE_HALF_UP' AND tax_rate_bps BETWEEN 1 AND 10000 AND tax_cents = kauro.round_half_up_bps(service_cents, tax_rate_bps))
    OR (tax_rule = 'ZERO_REVIEWED' AND tax_rate_bps = 0 AND tax_cents = 0)
  ),
  CONSTRAINT quotes_total_arithmetic CHECK (total_cents = service_cents + tax_cents),
  -- the registry schedule the quote says it priced with (R2-INITIAL): the band of the mode and units, a discount the policy can
  -- produce (a repeat tier or the founding rate), and the price expiry of exactly quoteDays x 86400 s (336 hours: an interval in
  -- hours never follows a daylight-saving change of the session's TimeZone, as '14 days' would; B09-F12)
  CONSTRAINT quotes_r2_initial_schedule CHECK (
    price_policy_version <> 'R2-INITIAL'
    OR (base_service_cents = coalesce(kauro.r2_initial_base_cents(mode, billable_units), -1)
        AND discount_bps IN (0, 500, 1000, 1500, 2500)
        AND expires_at = issued_at + interval '336 hours')
  ),
  CONSTRAINT quotes_expiry_after_issue CHECK (expires_at > issued_at),
  -- the source a quote promises is available after its issuance and never beyond its price expiry (07; B09-F10)
  CONSTRAINT quotes_source_window CHECK (source_available_until > issued_at AND source_available_until <= expires_at),
  CONSTRAINT quotes_superseded_names_successor CHECK ((state = 'SUPERSEDED') = (superseded_by_quote_id IS NOT NULL)),
  CONSTRAINT quotes_no_self_lineage CHECK (superseded_by_quote_id IS DISTINCT FROM quote_id AND replaces_quote_id IS DISTINCT FROM quote_id)
);
-- one live quote per project (a new binding quote supersedes the previous one before it is created; S060, 16 "Quote calculation");
-- a replacement quote counts once it is accepted — while it is drafted or issued the paid quote it replaces is still the live one,
-- and the re-binding supersedes that quote before it accepts the replacement (D-QUOTE-B6)
CREATE UNIQUE INDEX quotes_one_live_per_project ON kauro.quotes (agency_id, project_id)
  WHERE (replaces_quote_id IS NULL AND state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT')) OR state = 'ACCEPTED_FOR_CHECKOUT';
-- at most one pending replacement of a paid quote
CREATE UNIQUE INDEX quotes_one_pending_replacement ON kauro.quotes (agency_id, replaces_quote_id)
  WHERE replaces_quote_id IS NOT NULL AND state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT');
CREATE UNIQUE INDEX quotes_one_snapshot ON kauro.quotes (eligibility_snapshot_id);
CREATE INDEX quotes_by_project ON kauro.quotes (agency_id, project_id, created_at);
CREATE TRIGGER quotes_touch BEFORE UPDATE ON kauro.quotes FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER quotes_version BEFORE UPDATE ON kauro.quotes FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER quotes_immutable BEFORE UPDATE ON kauro.quotes
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('quote_id,agency_id,project_id,plan_id,approval_id,revision_hash,plan_hash,target_contract_hash,billable_units,mode,price_policy_version,discount_policy_version,base_service_cents,discount_bps,discount_cents,service_cents,fiscal_profile_id,issuer_ref,tax_treatment,tax_rule,tax_rate_bps,tax_cents,total_cents,currency,eligibility_snapshot_id,terms_hash,terms_version,issued_at,expires_at,source_available_until,replaces_quote_id,created_by_membership_id,created_at');
CREATE TRIGGER quotes_transition BEFORE UPDATE OF state ON kauro.quotes
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Quote');
CREATE TRIGGER quotes_initial_state BEFORE INSERT ON kauro.quotes
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Quote');
-- checkout and capture rely on the quote's state without changing it (CMD028 on an accepted quote, CMD029, authorization
-- issuance): a quote's state is a transition subject (D-TX-2), so an expiry, supersession or withdrawal waits for a checkout or a
-- capture intent in flight and is then checked against what it committed (quotes_release_guard, migration 0012)
CREATE TRIGGER quotes_transition_lock BEFORE UPDATE OF state ON kauro.quotes
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.quotes', 'quote_id');
CREATE CONSTRAINT TRIGGER quotes_event_per_version AFTER INSERT OR UPDATE OF version ON kauro.quotes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kauro.require_event_for_version('quote', 'quote_id');

-- The source binding (B09-F10, D-QUOTE-B7): the quoted revision hash is a revision of the quote's project that is SEALED, sealed
-- no later than the issuance, and the promised availability is no later than the policy's hard cap from that seal
-- (retention.unpaidDaysHardFromSeal; reference/HASHING "Retention formulas": the unpaid source's soft deadline is capped at
-- fourteen days after sealing). Only B06 columns are read (dataset_revisions.state, manifest_hash, sealed_at): the retention
-- record of the source lifecycle (package B07) is not referenced here (FOUNDATION D-AGGK-5); its exact effective deadline reaches
-- the issuer through the SourceAvailabilityReader port, and the integrator binds the two when both packages are on main (design
-- §15 "Integration obligations").
CREATE OR REPLACE FUNCTION kauro.quotes_source_binding() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  sealed timestamptz;
  hard_seconds integer;
BEGIN
  SELECT r.sealed_at INTO sealed FROM kauro.dataset_revisions r
   WHERE r.agency_id = NEW.agency_id AND r.project_id = NEW.project_id AND r.manifest_hash = NEW.revision_hash AND r.state = 'SEALED';
  SELECT p.unpaid_source_hard_seconds INTO hard_seconds FROM kauro.price_policies p WHERE p.policy_version = NEW.price_policy_version;
  -- an unknown policy is refused by the foreign key on price_policy_version (23503), not by this binding
  IF sealed IS NULL OR sealed > NEW.issued_at
     OR (hard_seconds IS NOT NULL AND NEW.source_available_until > sealed + make_interval(secs => hard_seconds::double precision)) THEN
    RAISE EXCEPTION 'SOURCE_BINDING: quote % promises a source that is not a sealed revision of its project available until the promised instant', NEW.quote_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_source_binding', SCHEMA = 'kauro', TABLE = 'quotes';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quotes_source_binding BEFORE INSERT ON kauro.quotes FOR EACH ROW EXECUTE FUNCTION kauro.quotes_source_binding();

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Quote', 'DRAFT');
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

-- the quote is an aggregate kind of the shared registry (foundation 0008, D-AGGK-1; D-EVT-B1)
INSERT INTO kauro.aggregate_kinds (aggregate_kind, table_name, id_column, owner_package) VALUES ('quote', 'quotes', 'quote_id', 'B09');

-- --- price eligibility snapshots (D-QUOTE-B2) ---------------------------------------------------------------------------------------------
-- The recurrence and founding facts a quote was priced with, frozen at issuance (reference/HASHING "Price and recurrence
-- snapshots": "Evaluate the 365-day lookback at one server issuance instant and persist the exact eligible set"; registry
-- PriceEligibilitySnapshot: "Complete prior distinct paid/non-fully-refunded project set", "Must equal that unique set size",
-- "Exact 365-day boundary", "Maximum eligible rate without stacking"). Which projects qualify is the recurrence package's
-- decision (B10: first-project designation, commission windows); the database guarantees the shape — a distinct set of other
-- projects of the same agency, the count equal to its size, the tier of that count, the exact boundary (8760 hours: 365 duration
-- days, time-zone independent, B09-F12) and the maximum (never the sum) of the two rates — under a known policy, and binds the
-- quote's discount to the applied rate and the snapshot's as_of to the quote's issued_at (quotes_snapshot_fk). Append-only.
CREATE TABLE kauro.price_eligibility_snapshots (
  snapshot_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(snapshot_id)),
  agency_id               uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  quote_id                uuid NOT NULL,
  project_id              uuid NOT NULL,
  as_of                   timestamptz NOT NULL,
  lookback_starts_at      timestamptz NOT NULL,
  qualifying_project_ids  uuid[] NOT NULL CHECK (kauro.is_distinct_uuid_set(qualifying_project_ids) AND cardinality(qualifying_project_ids) <= 100000),
  qualifying_count        integer NOT NULL CHECK (qualifying_count >= 0),
  repeat_discount_bps     integer NOT NULL CHECK (repeat_discount_bps BETWEEN 0 AND 10000),
  founding_slot_ref       uuid,
  founding_discount_bps   integer NOT NULL CHECK (founding_discount_bps BETWEEN 0 AND 10000),
  applied_discount_bps    integer NOT NULL CHECK (applied_discount_bps BETWEEN 0 AND 10000),
  policy_version          text NOT NULL REFERENCES kauro.price_policies (policy_version),
  created_at              timestamptz NOT NULL,
  UNIQUE (quote_id),
  -- binding target of quotes_snapshot_fk: the quote's discount is the snapshot's applied rate under its policy, evaluated at the
  -- quote's own issuance instant
  CONSTRAINT price_eligibility_snapshots_quote_binding UNIQUE (agency_id, snapshot_id, quote_id, applied_discount_bps, policy_version, as_of),
  FOREIGN KEY (agency_id, quote_id, project_id) REFERENCES kauro.quotes (agency_id, quote_id, project_id),
  CONSTRAINT price_eligibility_snapshots_count CHECK (qualifying_count = cardinality(qualifying_project_ids)),
  CONSTRAINT price_eligibility_snapshots_not_self CHECK (NOT (project_id = ANY (qualifying_project_ids))),
  CONSTRAINT price_eligibility_snapshots_max_not_stacked CHECK (applied_discount_bps = greatest(repeat_discount_bps, founding_discount_bps)),
  CONSTRAINT price_eligibility_snapshots_founding_slot CHECK ((founding_discount_bps > 0) = (founding_slot_ref IS NOT NULL)),
  CONSTRAINT price_eligibility_snapshots_r2_initial CHECK (
    policy_version <> 'R2-INITIAL'
    OR (repeat_discount_bps = kauro.r2_initial_repeat_bps(qualifying_count)
        AND founding_discount_bps IN (0, 2500)
        AND lookback_starts_at = as_of - interval '8760 hours')
  ),
  CONSTRAINT price_eligibility_snapshots_lookback CHECK (lookback_starts_at < as_of)
);
CREATE TRIGGER price_eligibility_snapshots_append_only BEFORE UPDATE OR DELETE ON kauro.price_eligibility_snapshots
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- every qualifying project is another project of the same agency (an array cannot carry a foreign key)
CREATE OR REPLACE FUNCTION kauro.price_eligibility_projects_bound() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.qualifying_project_ids) AS q(project_id)
     WHERE NOT EXISTS (SELECT 1 FROM kauro.projects p WHERE p.agency_id = NEW.agency_id AND p.project_id = q.project_id)
  ) THEN
    RAISE EXCEPTION 'CONTEXT: an eligibility snapshot of agency % names a project that is not one of its own', NEW.agency_id USING ERRCODE = 'KA006';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER price_eligibility_snapshots_projects_bound BEFORE INSERT ON kauro.price_eligibility_snapshots
  FOR EACH ROW EXECUTE FUNCTION kauro.price_eligibility_projects_bound();

-- the quote names its snapshot and the snapshot names its quote: the key is checked at COMMIT (either can be written first); the
-- snapshot's as_of is the quote's issuance instant (reference/HASHING "at one server issuance instant"; B09-F10)
ALTER TABLE kauro.quotes ADD CONSTRAINT quotes_snapshot_fk
  FOREIGN KEY (agency_id, eligibility_snapshot_id, quote_id, discount_bps, discount_policy_version, issued_at)
  REFERENCES kauro.price_eligibility_snapshots (agency_id, snapshot_id, quote_id, applied_discount_bps, policy_version, as_of) DEFERRABLE INITIALLY DEFERRED;

-- --- row-level security -------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.fiscal_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.fiscal_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_profiles_tenant_read ON kauro.fiscal_profiles FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
-- a reviewed version is recorded by the corporate owner of the finance scope, as itself (the reviewer is the session's person)
CREATE POLICY fiscal_profiles_finance ON kauro.fiscal_profiles FOR ALL TO kauro_app
  USING (kauro.in_finance_scope(agency_id))
  WITH CHECK (kauro.in_finance_scope(agency_id) AND (reviewed_by_user_id IS NULL OR reviewed_by_user_id = kauro.current_user_id()));
CREATE POLICY fiscal_profiles_payment_read ON kauro.fiscal_profiles FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());

-- The agency issues (CMD027, B10) and accepts (CMD028) its own quotes; it never accepts a replacement quote, which only the
-- payment service's re-binding of the paid capture accepts (quotes_payment_rebinding, 0011; D-QUOTE-B6).
ALTER TABLE kauro.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY quotes_tenant_read ON kauro.quotes FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
CREATE POLICY quotes_tenant_issue ON kauro.quotes FOR INSERT TO kauro_app WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY quotes_tenant_update ON kauro.quotes FOR UPDATE TO kauro_app
  USING (agency_id = kauro.current_agency_id())
  WITH CHECK (agency_id = kauro.current_agency_id() AND NOT (state = 'ACCEPTED_FOR_CHECKOUT' AND replaces_quote_id IS NOT NULL));
CREATE POLICY quotes_finance_read ON kauro.quotes FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY quotes_payment_read ON kauro.quotes FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());

ALTER TABLE kauro.price_eligibility_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.price_eligibility_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY price_eligibility_snapshots_tenant ON kauro.price_eligibility_snapshots FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY price_eligibility_snapshots_payment_read ON kauro.price_eligibility_snapshots FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());

-- --- grants ---------------------------------------------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON kauro.fiscal_profiles TO kauro_app;
GRANT UPDATE (superseded_at) ON kauro.fiscal_profiles TO kauro_app;
GRANT SELECT ON kauro.fiscal_profiles TO kauro_payment;
GRANT SELECT, INSERT, UPDATE ON kauro.quotes TO kauro_app;
GRANT SELECT ON kauro.quotes TO kauro_payment;
GRANT SELECT, INSERT ON kauro.price_eligibility_snapshots TO kauro_app;
GRANT SELECT ON kauro.price_eligibility_snapshots TO kauro_payment;
