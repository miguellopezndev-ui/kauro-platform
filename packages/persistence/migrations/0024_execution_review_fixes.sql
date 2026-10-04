-- 0024 — B08 package-close review fixes (Codex review of b08/land f49ca76; findings B08-R1, B08-R2, B08-R4): the publication guard
-- reads the admission of the job's INCLUDED sealed files, and an attempt's cleanup is a bounded series of passes that ends CLEANED
-- only with the host's resource report answered.
--
-- A new migration after 0023 rather than an edit of 0022 in place (decision D8-REV-1): B08's migrations are already renumbered on
-- b08/land (D8-LAND-1) and the review pinned 0022 at f49ca76; nothing is deployed, so the change is only ordering. B11 and B10 move
-- one number on at their landings (B11 0025–0028, B10 0029 onward).
--
-- Authority: 07 "Staging and publication transaction" (publication under the current authority, the last atomic check), 09 "Derived
-- data and worker scratch" (an external janitor cleans exact owned resources and records cost and result), scenarios S035, S056,
-- S062, S075, CMD036-DENY. Design: docs/design/B08-audit-approval-jobs.md §5, §7, §17 (decisions D8-REV-1..4).
--
-- SQLSTATE: KA080 a cleanup pass after the attempt's CLEANED record or past its bound; KA081 a publication whose source lost the
-- admission of an included file.

-- --- B08-R1: the publication guard reads the admission of the revision's INCLUDED sealed files (D8-REV-2) --------------------------------
-- 0022's guard, unchanged but for the source: after the revision's shared transition lock it takes the shared transition halves of
-- the revision's INCLUDED files in file order (revokeAdmission takes the file's exclusive half first, B07 D-FILE-1), and the source
-- is current only while the revision is SEALED AND none of those files has lost its admission. A revocation that commits first
-- refuses the publication at COMMIT; one that comes later waits for the publication, whose job is then READY and no longer relies
-- on the file (the package was published under authority that held at that instant, 07 "the last atomic check").
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
    AND EXISTS (SELECT 1 FROM kauro.target_contracts c WHERE c.agency_id = j.agency_id AND c.contract_id = contract AND c.confirmed_at IS NOT NULL AND c.superseded_at IS NULL)
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

-- --- B08-R2 and B08-R4: an attempt's cleanup is a bounded series of passes (D8-REV-3, D8-REV-4) -------------------------------------------
-- 0022 kept one append-only record per attempt, so a PARTIAL pass (a transient scratch-removal failure) or a pass without the host's
-- resource report was final. Now each pass appends its own record, numbered by the database: pass n + 1 only after a PARTIAL pass n,
-- never after CLEANED, at most five (KA080). CLEANED needs the objects and the scratch gone, a certain termination and the host's
-- report answered (REPORTED, or NOT_FOUND: the host knows nothing of the identity); a report that could not be obtained
-- (UNAVAILABLE) leaves the pass PARTIAL for the next one. The records stay append-only. Nothing is deployed: 0022's table holds no
-- rows when this runs, so the new columns' defaults only satisfy ALTER TABLE and are then dropped.
ALTER TABLE kauro.attempt_cleanups DROP CONSTRAINT attempt_cleanups_one_per_attempt;
ALTER TABLE kauro.attempt_cleanups DROP CONSTRAINT attempt_cleanups_cleaned;
ALTER TABLE kauro.attempt_cleanups
  ADD COLUMN pass smallint NOT NULL DEFAULT 1 CONSTRAINT attempt_cleanups_pass_bound CHECK (pass BETWEEN 1 AND 5),
  ADD COLUMN resource_report text NOT NULL DEFAULT 'NOT_FOUND' CHECK (resource_report IN ('REPORTED', 'NOT_FOUND', 'UNAVAILABLE'));
ALTER TABLE kauro.attempt_cleanups ALTER COLUMN pass DROP DEFAULT, ALTER COLUMN resource_report DROP DEFAULT;
ALTER TABLE kauro.attempt_cleanups
  ADD CONSTRAINT attempt_cleanups_one_per_pass UNIQUE (attempt_id, pass),
  ADD CONSTRAINT attempt_cleanups_resource_report CHECK ((resource_report = 'REPORTED') = (machine_type IS NOT NULL)),
  ADD CONSTRAINT attempt_cleanups_cleaned CHECK (result <> 'CLEANED' OR (scratch_deleted AND termination_result <> 'UNCERTAIN' AND resource_report <> 'UNAVAILABLE'));

CREATE OR REPLACE FUNCTION kauro.attempt_cleanups_pass() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  last record;
BEGIN
  SELECT c.pass, c.result INTO last FROM kauro.attempt_cleanups c WHERE c.agency_id = NEW.agency_id AND c.attempt_id = NEW.attempt_id ORDER BY c.pass DESC LIMIT 1;
  IF last.pass IS NULL THEN
    NEW.pass := 1;
    RETURN NEW;
  END IF;
  IF last.result = 'CLEANED' THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % is already CLEANED', NEW.attempt_id USING ERRCODE = 'KA080';
  END IF;
  IF last.pass >= 5 THEN
    RAISE EXCEPTION 'EXECUTION_FENCE: attempt % has used its five cleanup passes', NEW.attempt_id USING ERRCODE = 'KA080';
  END IF;
  NEW.pass := last.pass + 1;
  RETURN NEW;
END
$$;
CREATE TRIGGER attempt_cleanups_pass BEFORE INSERT ON kauro.attempt_cleanups
  FOR EACH ROW EXECUTE FUNCTION kauro.attempt_cleanups_pass();
