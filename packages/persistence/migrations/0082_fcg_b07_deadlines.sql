-- Migration 0082: CLOCK-SWEEP-B07 lane L2, FCG-B07-DEADLINES (provisional number; the coordinator renumbers on merge).
--
-- D-CLOCK-1 judged at the effect (docs/design/B07-clock-sweep-plan.md sec. 4): a deadline that refuses an effect is judged against the
-- server's instant of the effect statement (kauro.effect_now(), 0038), never against the transaction's start (kauro.server_now()), so
-- a transaction that began before a deadline cannot apply its effect after it.
--   1. kauro.upload_sessions_window_clock (0009:528): the acceptance edge (UPLOADING, VERIFYING, ADMITTED) is refused once
--      kauro.effect_now() reaches the application deadline. Every lifecycle stamp stays the transaction time, and the EXPIRED edge stays
--      on the transaction time: CHECK 0009:464 needs expired_at (= server_now) >= application_expires_at, so expiry stays monotone.
--   2. kauro.dataset_revisions_sealed_subject (0011:565), read at the deferred COMMIT: a seal is refused once the fourteen days of its
--      bytes' first seal end at or before kauro.effect_now() of COMMIT. effect_now >= sealed_at always, so this subsumes the old predicate;
--      the rest of the body is unchanged.
-- Both are CREATE OR REPLACE with the triggers of 0009/0011 unchanged; the refusal stays KA072 (LIFECYCLE_BINDING, D-CS-1).

-- 0009's body with the acceptance edge judged at the effect statement: nothing is accepted once kauro.effect_now() reaches the
-- deadline (09 "Resumable session security"), and nothing expires before the transaction time reaches it (09 "Upload reservation").
-- The trigger upload_sessions_window_clock (0009) keeps its name and timing.
CREATE OR REPLACE FUNCTION kauro.upload_sessions_window_clock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at IS DISTINCT FROM clock THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: upload % is created at the server''s transaction time, not %', NEW.upload_id, NEW.created_at USING ERRCODE = 'KA072';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.session_issued_at IS DISTINCT FROM OLD.session_issued_at AND NEW.session_issued_at IS DISTINCT FROM clock)
     OR (NEW.completion_reported_at IS DISTINCT FROM OLD.completion_reported_at AND NEW.completion_reported_at IS NOT NULL AND NEW.completion_reported_at IS DISTINCT FROM clock)
     OR (NEW.completion_observed_at IS DISTINCT FROM OLD.completion_observed_at AND NEW.completion_observed_at IS DISTINCT FROM clock)
     OR (NEW.completion_not_observed_at IS DISTINCT FROM OLD.completion_not_observed_at AND NEW.completion_not_observed_at IS DISTINCT FROM clock)
     OR (NEW.inspection_claimed_at IS DISTINCT FROM OLD.inspection_claimed_at AND NEW.inspection_claimed_at IS DISTINCT FROM clock)
     OR (NEW.admitted_at IS DISTINCT FROM OLD.admitted_at AND NEW.admitted_at IS DISTINCT FROM clock)
     OR (NEW.rejected_at IS DISTINCT FROM OLD.rejected_at AND NEW.rejected_at IS DISTINCT FROM clock)
     OR (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at AND NEW.cancelled_at IS DISTINCT FROM clock)
     OR (NEW.expired_at IS DISTINCT FROM OLD.expired_at AND NEW.expired_at IS DISTINCT FROM clock)
     OR (NEW.provider_cancellation_at IS DISTINCT FROM OLD.provider_cancellation_at AND NEW.provider_cancellation_at IS NOT NULL AND NEW.provider_cancellation_at IS DISTINCT FROM clock) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: upload % records a lifecycle instant other than the server''s transaction time', OLD.upload_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state IN ('UPLOADING', 'VERIFYING', 'ADMITTED') AND kauro.effect_now() >= OLD.application_expires_at THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: upload % passed its application deadline; acceptance is refused after expiry', OLD.upload_id USING ERRCODE = 'KA072';
    END IF;
    IF NEW.state = 'EXPIRED' AND clock < OLD.application_expires_at THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: upload % expires no earlier than its application deadline', OLD.upload_id USING ERRCODE = 'KA072';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 0011's body (the deferred constraint trigger dataset_revisions_sealed_subject, unchanged) with the closed window of the bytes judged
-- at COMMIT's effect instant: a seal whose bytes' fourteen days end at or before kauro.effect_now() is refused (a record born expired,
-- D-RET-2, D-RET-3, B07-F5), even when the transaction began before that end.
CREATE OR REPLACE FUNCTION kauro.dataset_revisions_sealed_subject() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  included integer;
  included_bytes bigint;
  first_seal timestamptz;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM kauro.sealed_manifests m
    WHERE m.agency_id = NEW.agency_id AND m.revision_id = NEW.revision_id AND m.manifest_hash = NEW.manifest_hash
      AND m.projection_hash = NEW.projection_hash AND m.selection_hash = NEW.selection_hash AND m.evaluation_hash = NEW.evaluation_hash
      AND m.sealed_at = NEW.sealed_at
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % has no matching sealed manifest', NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  SELECT count(*), coalesce(sum(bytes), 0) INTO included, included_bytes
    FROM kauro.sealed_revision_files WHERE agency_id = NEW.agency_id AND revision_id = NEW.revision_id AND disposition = 'INCLUDED';
  IF included <> NEW.sealed_file_count OR included_bytes <> NEW.sealed_bytes THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % names % included files (% bytes) but froze % (% bytes)', NEW.revision_id, included, included_bytes, NEW.sealed_file_count, NEW.sealed_bytes USING ERRCODE = 'KA072';
  END IF;
  IF EXISTS (
    SELECT f ->> 'fileId', f ->> 'disposition' FROM kauro.selection_manifests m, jsonb_array_elements(m.body -> 'files') f
     WHERE m.agency_id = NEW.agency_id AND m.selection_manifest_id = NEW.selection_manifest_id
    EXCEPT
    SELECT s.file_id::text, CASE s.disposition WHEN 'INCLUDED' THEN 'INCLUDE' ELSE 'EXCLUDE' END FROM kauro.sealed_revision_files s
     WHERE s.agency_id = NEW.agency_id AND s.revision_id = NEW.revision_id
  ) OR EXISTS (
    SELECT s.file_id::text, CASE s.disposition WHEN 'INCLUDED' THEN 'INCLUDE' ELSE 'EXCLUDE' END FROM kauro.sealed_revision_files s
     WHERE s.agency_id = NEW.agency_id AND s.revision_id = NEW.revision_id
    EXCEPT
    SELECT f ->> 'fileId', f ->> 'disposition' FROM kauro.selection_manifests m, jsonb_array_elements(m.body -> 'files') f
     WHERE m.agency_id = NEW.agency_id AND m.selection_manifest_id = NEW.selection_manifest_id
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the sealed file set of revision % is not the dispositions of its selection', NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.retention_anchors a
     WHERE a.agency_id = NEW.agency_id AND a.revision_id = NEW.revision_id AND a.anchor_kind = 'REVISION_SEALED' AND a.occurred_at = NEW.sealed_at
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % has no REVISION_SEALED anchor at its seal', NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  -- the first seal of the bytes: the earliest real seal (D-SEAL-1, kauro.is_real_seal) of any revision that included any file this
  -- seal includes (this one included, which is SEALED at its manifest's instant now)
  SELECT min(m.sealed_at) INTO first_seal
    FROM kauro.sealed_revision_files s
    JOIN kauro.sealed_revision_files o ON o.agency_id = s.agency_id AND o.file_id = s.file_id AND o.disposition = 'INCLUDED'
    JOIN kauro.sealed_manifests m ON m.agency_id = o.agency_id AND m.revision_id = o.revision_id
   WHERE s.agency_id = NEW.agency_id AND s.revision_id = NEW.revision_id AND s.disposition = 'INCLUDED'
     AND kauro.is_real_seal(o.agency_id, o.revision_id);
  -- policy retention.unpaidDaysHardFromSeal = 14; a day is an exact 86400-second duration (HASHING "Retention formulas")
  IF first_seal IS NULL OR first_seal + interval '1209600 seconds' <= kauro.effect_now() THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the retention window of the bytes of revision % closed before this seal; reuse needs a new upload', NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.retention_records r JOIN kauro.retention_anchors a ON a.agency_id = r.agency_id AND a.anchor_id = r.anchor_id
     WHERE r.agency_id = NEW.agency_id AND r.revision_id = NEW.revision_id AND r.class = 'UNPAID' AND a.anchor_kind = 'REVISION_SEALED'
       AND a.project_id = NEW.project_id AND a.occurred_at = first_seal AND r.hard_deadline = first_seal + interval '1209600 seconds'
       AND EXISTS (
         SELECT 1 FROM kauro.sealed_revision_files o JOIN kauro.sealed_revision_files s ON s.agency_id = o.agency_id AND s.file_id = o.file_id
          WHERE o.agency_id = a.agency_id AND o.revision_id = a.revision_id AND o.disposition = 'INCLUDED'
            AND s.revision_id = NEW.revision_id AND s.disposition = 'INCLUDED'
       )
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: sealed revision % has no UNPAID retention record anchored on the first seal of its bytes', NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  RETURN NULL;
END
$$;
