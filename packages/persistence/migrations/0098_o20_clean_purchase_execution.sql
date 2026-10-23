-- Order 20, second increment (built against the O19A re-issue candidate; the api reaches it only with KAURO_CANDIDATE_CLEAN_NO_TARGET on): a
-- CLEAN quote (migration 0097: it binds kauro.clean_only_target_hash() and no target contract) can be paid and executed. The two guards that
-- required a confirmed, current target row for every purchase and every published package accept, for mode CLEAN only, exactly the canonical
-- CLEAN hash instead; every other mode, and a CLEAN purchase bound to a real target (in-force data), is judged as before. Both bodies are
-- 0015's and 0024's unchanged except that one condition. The mode and the hash are the immutable columns of the authorization and the job
-- (their composite foreign keys carry them from the quote), so no request chooses the branch.

CREATE OR REPLACE FUNCTION kauro.commercial_authorizations_require_capture() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  c record;
  o record;
  subject_ok boolean;
  revision uuid;
  contract uuid;
  replaced uuid;
BEGIN
  -- the shared halves of what the issuance relies on without changing it, in the platform's lock order (design §6.2)
  PERFORM kauro.await_transition('kauro.agencies', NEW.agency_id::text);
  PERFORM kauro.await_transition('kauro.capabilities', NEW.mode);
  PERFORM kauro.await_transition('kauro.approvals', NEW.approval_id::text);
  SELECT r.revision_id INTO revision FROM kauro.dataset_revisions r
   WHERE r.agency_id = NEW.agency_id AND r.project_id = NEW.project_id AND r.manifest_hash = NEW.revision_hash;
  IF revision IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.dataset_revisions', revision::text);
  END IF;
  SELECT t.contract_id INTO contract FROM kauro.target_contracts t
   WHERE t.agency_id = NEW.agency_id AND t.project_id = NEW.project_id AND t.body_hash = NEW.target_contract_hash;
  IF contract IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.target_contracts', contract::text);
  END IF;
  PERFORM kauro.await_transition('kauro.quotes', NEW.quote_id::text);
  PERFORM kauro.await_transition('kauro.capture_facts', NEW.capture_id::text);

  SELECT f.status, f.amount_cents, f.allocated_service_cents, f.allocated_tax_cents, f.excess_cents INTO c
    FROM kauro.capture_facts f WHERE f.agency_id = NEW.agency_id AND f.capture_id = NEW.capture_id AND f.order_id = NEW.order_id;
  SELECT p.expected_amount_cents, p.expected_service_cents, p.expected_tax_cents INTO o
    FROM kauro.payment_orders p WHERE p.agency_id = NEW.agency_id AND p.order_id = NEW.order_id AND p.quote_id = NEW.order_quote_id;
  IF c.status IS DISTINCT FROM 'COMPLETED' OR o.expected_amount_cents IS NULL
     OR c.amount_cents <> o.expected_amount_cents OR c.allocated_service_cents <> o.expected_service_cents
     OR c.allocated_tax_cents <> o.expected_tax_cents OR c.excess_cents <> 0 THEN
    RAISE EXCEPTION 'AUTHORITY_WITHOUT_CAPTURE: capture % does not alone pay the obligation of order %', NEW.capture_id, NEW.order_id USING ERRCODE = 'KP004';
  END IF;
  IF NEW.rebinding_id IS NOT NULL THEN
    -- a re-bound entitlement: the recorded allocation of this capture to this replacement quote exists, and the authorization it
    -- replaces is already revoked in this transaction (one live entitlement per purchase; D-QUOTE-B6)
    SELECT b.from_authorization_id INTO replaced FROM kauro.purchase_rebindings b
     WHERE b.agency_id = NEW.agency_id AND b.rebinding_id = NEW.rebinding_id AND b.capture_id = NEW.capture_id AND b.to_quote_id = NEW.quote_id;
    IF replaced IS NULL OR NOT EXISTS (
      SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = NEW.agency_id AND a.authorization_id = replaced AND a.state = 'REVOKED'
    ) THEN
      RAISE EXCEPTION 'AUTHORITY_WITHOUT_CAPTURE: authorization % names no re-binding of capture % to quote %', NEW.authorization_id, NEW.capture_id, NEW.quote_id USING ERRCODE = 'KP004';
    END IF;
  END IF;
  SELECT
    EXISTS (SELECT 1 FROM kauro.quotes q WHERE q.agency_id = NEW.agency_id AND q.quote_id = NEW.quote_id AND q.state = 'ACCEPTED_FOR_CHECKOUT')
    AND EXISTS (SELECT 1 FROM kauro.approvals a WHERE a.agency_id = NEW.agency_id AND a.approval_id = NEW.approval_id AND a.withdrawn_at IS NULL)
    AND EXISTS (SELECT 1 FROM kauro.agencies g WHERE g.agency_id = NEW.agency_id AND g.state = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.revision_id = revision AND r.state = 'SEALED')
    -- O20: a CLEAN purchase binds the canonical CLEAN hash and no target contract (CP-02.01); any other needs its confirmed, current target
    AND ((NEW.mode = 'CLEAN' AND NEW.target_contract_hash = kauro.clean_only_target_hash())
         OR EXISTS (SELECT 1 FROM kauro.target_contracts t WHERE t.agency_id = NEW.agency_id AND t.contract_id = contract AND t.confirmed_at IS NOT NULL AND t.superseded_at IS NULL))
    AND EXISTS (SELECT 1 FROM kauro.capabilities k WHERE k.capability_id = NEW.capability_id AND k.state IN ('AVAILABLE_LIMITED', 'AVAILABLE'))
  INTO subject_ok;
  IF NOT subject_ok THEN
    RAISE EXCEPTION 'AUTHORITY_WITHOUT_CAPTURE: the purchased subject of quote % no longer binds (quote, approval, agency, source, target or capability)', NEW.quote_id USING ERRCODE = 'KP004';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION kauro.package_versions_publication_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  j record;
  t record;
  ok boolean;
  revision uuid;
  contract uuid;
BEGIN
  SELECT x.* INTO j FROM kauro.processing_jobs x WHERE x.agency_id = NEW.agency_id AND x.job_id = NEW.job_id;
  SELECT y.state, y.fence INTO t FROM kauro.processing_attempts y WHERE y.agency_id = NEW.agency_id AND y.attempt_id = NEW.attempt_id;
  IF t.state IS DISTINCT FROM 'COMMITTED' OR NOT kauro.attempt_owns_lease(NEW.job_id, NEW.attempt_id, t.fence) THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: package % is published only by the lease''s current owner, committed with it', NEW.package_version_id USING ERRCODE = 'KA080';
  END IF;
  -- the shared halves of every fact the publication relies on, in the platform's lock order (D8-LOCK-1)
  PERFORM kauro.await_transition('kauro.projects', j.project_id::text);
  PERFORM kauro.await_transition('kauro.agencies', j.agency_id::text);
  PERFORM kauro.await_transition('kauro.capabilities', j.mode);
  PERFORM kauro.await_transition('kauro.approvals', j.approval_id::text);
  SELECT r.revision_id INTO revision FROM kauro.dataset_revisions r WHERE r.agency_id = j.agency_id AND r.project_id = j.project_id AND r.manifest_hash = j.revision_hash;
  IF revision IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.dataset_revisions', revision::text);
    PERFORM kauro.await_transition('kauro.source_files', s.file_id::text)
       FROM kauro.sealed_revision_files s
      WHERE s.agency_id = j.agency_id AND s.revision_id = revision AND s.disposition = 'INCLUDED'
      ORDER BY s.file_id;
  END IF;
  SELECT c.contract_id INTO contract FROM kauro.target_contracts c WHERE c.agency_id = j.agency_id AND c.project_id = j.project_id AND c.body_hash = j.target_contract_hash;
  IF contract IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.target_contracts', contract::text);
  END IF;
  SELECT
    j.state = 'READY' AND j.published_package_id = NEW.package_version_id AND j.cancel_version = 0 AND j.ready_at = kauro.server_now()
    AND EXISTS (SELECT 1 FROM kauro.commercial_authorizations a WHERE a.agency_id = j.agency_id AND a.authorization_id = j.authorization_id
                 AND a.state = 'DELIVERED' AND a.job_ref = j.job_id AND a.delivered_at = kauro.server_now())
    AND EXISTS (SELECT 1 FROM kauro.approvals p WHERE p.agency_id = j.agency_id AND p.approval_id = j.approval_id AND p.withdrawn_at IS NULL)
    AND EXISTS (SELECT 1 FROM kauro.plans p WHERE p.agency_id = j.agency_id AND p.plan_id = j.plan_id AND p.state = 'APPROVED' AND p.approval_id = j.approval_id)
    AND EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = j.agency_id AND r.revision_id = revision AND r.state = 'SEALED')
    AND NOT EXISTS (
      SELECT 1 FROM kauro.sealed_revision_files s JOIN kauro.source_files f ON f.agency_id = s.agency_id AND f.file_id = s.file_id
       WHERE s.agency_id = j.agency_id AND s.revision_id = revision AND s.disposition = 'INCLUDED' AND f.state <> 'ADMITTED'
    )
    -- O20: a CLEAN job binds the canonical CLEAN hash and no target contract (CP-02.01)
    AND ((j.mode = 'CLEAN' AND j.target_contract_hash = kauro.clean_only_target_hash())
         OR EXISTS (SELECT 1 FROM kauro.target_contracts c WHERE c.agency_id = j.agency_id AND c.contract_id = contract AND c.confirmed_at IS NOT NULL AND c.superseded_at IS NULL))
    AND EXISTS (SELECT 1 FROM kauro.capabilities k WHERE k.capability_id = j.capability_id AND k.state IN ('AVAILABLE_LIMITED', 'AVAILABLE'))
    AND EXISTS (SELECT 1 FROM kauro.agencies g WHERE g.agency_id = j.agency_id AND g.state = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM kauro.projects p WHERE p.agency_id = j.agency_id AND p.project_id = j.project_id AND p.state = 'OPEN')
  INTO ok;
  IF NOT coalesce(ok, false) THEN
    RAISE EXCEPTION 'EXECUTION_AUTHORITY: package % is published only under the current authority of its job (entitlement, cancellation, approval, source and its files'' admission, target, capability, agency, project)', NEW.package_version_id USING ERRCODE = 'KA081';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.package_verifications v
     WHERE v.agency_id = NEW.agency_id AND v.verification_id = NEW.verification_id AND v.package_version_id = NEW.package_version_id AND v.result = 'VALID'
  ) OR NOT kauro.readbacks_complete(NEW.agency_id, NEW.attempt_id, NEW.package_version_id)
     OR NOT EXISTS (
    SELECT 1 FROM kauro.retention_anchors x JOIN kauro.dataset_revisions d ON d.agency_id = x.agency_id AND d.revision_id = x.revision_id
     WHERE x.agency_id = NEW.agency_id AND x.anchor_kind = 'PACKAGE_AVAILABLE' AND d.project_id = NEW.project_id AND d.revision_id = revision
  ) THEN
    RAISE EXCEPTION 'PUBLICATION_EVIDENCE: package % is published only with its VALID verification, every staging and delivery read-back equal and its PACKAGE_AVAILABLE anchor', NEW.package_version_id USING ERRCODE = 'KA084';
  END IF;
  RETURN NULL;
END
$$;

GRANT EXECUTE ON FUNCTION kauro.clean_only_target_hash() TO kauro_payment;
