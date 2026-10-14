-- Migration 0090: B17 lane L7 TARGET-REBIND, the drift repair's terms predicate of the payments re-binding guard (provisional number; the
-- coordinator renumbers on merge).
--
-- docs/design/B15-B17-B18-local-plan.md section 5 M8 (R2-026 REPAIR): a drift repair keeps the paid revision, mode, band and terms. 0084
-- compared the quotes' terms_hash, which is KAURO_QUOTE_TERMS_V1 over the quote's own identity (quoteId, planId, approvalId,
-- targetContractHash, issuedAt; domain commerce/pricing.ts quoteTermsHash), so two quotes never share it and no production drift repair
-- could pass (the 0084 cell forged an equal hash with triggers off). The terms a repair keeps are the terms version, with the money
-- members already pinned to the paid quote by 0014 quotes_replacement_terms_fk; every other predicate of 0084 is unchanged.

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
  SELECT q.state, q.revision_hash, q.price_policy_version, q.plan_id, q.target_contract_hash, q.mode, q.base_service_cents, q.terms_version INTO q_from
    FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.from_quote_id;
  SELECT q.state, q.revision_hash, q.replaces_quote_id, q.plan_id, q.target_contract_hash, q.mode, q.base_service_cents, q.terms_version INTO q_to
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
       OR q_to.base_service_cents IS DISTINCT FROM q_from.base_service_cents OR q_to.terms_version IS DISTINCT FROM q_from.terms_version THEN
      RAISE EXCEPTION 'REPLACEMENT_REFUSED: a drift repair keeps the paid revision, mode, band and terms version' USING ERRCODE = 'KP013';
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
