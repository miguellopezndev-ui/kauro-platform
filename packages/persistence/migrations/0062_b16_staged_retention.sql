-- Migration 0062 (provisional number; the coordinator renumbers at merge): the PAID_STAGED retention deadlines of a staged CRM import
-- workflow (package B16 lane L7, cases R2-054 and R2-055, gate G-DELETE; mandate B16-REST-PLAN §5 C7).
--
-- Authority: 09 "Retention schedule" (staged CRM import source and stage artifacts: "Stage workflow expires twenty-one days after first
-- stage release and no later than thirty days after capture", then at most seven days for final delivery) and 09 "Quotes, reuploads and
-- retention" ("Stage continuation ends at the earlier of first release plus twenty-one days and capture plus thirty days ... If final
-- preparation completes while that workflow authority is valid, final download access may last up to seven days after completion but
-- still ends no later than capture plus thirty days ... A late receipt cannot create the final-delivery allowance after workflow expiry";
-- "Opening a report, polling progress ... does not extend retention"; "The hard ... thirty-day staged capture caps remain unchanged");
-- 09 "A staged workflow waiting legitimately for agency import is not an eight-hour running job": a window holds no lease, job or slot.
--
-- kauro.staged_retention_windows: one window per staged workflow (agency, plan), anchored on the COMPLETED capture that paid it. Every
-- instant is the database's (D-CLOCK-1): the birth takes the capture instant from the capture fact (the earlier of the provider's
-- completion and Kauro's first observation: never later than either, so the cap is never late), never from the writer; the first
-- release and the final completion are stamped kauro.server_now() whatever the writer supplied, and judged against kauro.effect_now()
-- after the row lock (a writer that waited across a deadline is refused at the instant it acts). Anchors are learned once: a retry, a
-- replay or a later stage's release keeps the first; the deadline columns are always recomputed from the anchors, so no writer, retry
-- or re-read moves one, and the capture instant and the hard cap never change (forbid_column_change, KA004).
--   hard_deadline           = captured_at + 30 d
--   continuation_deadline   = least(first_released_at + 21 d, hard_deadline)
--   final_download_deadline = least(final_completed_at + 7 d, hard_deadline), only when the completion precedes the continuation deadline
-- No runtime writer exists yet (0052 header: the stage rows are the stage compiler's, written by a fixture): the request and control roles
-- read the window under the tenant policy and write nothing; a stage-release writer (unassigned in program.json) will be granted its
-- columns in its own migration. kauro.staged_retention_phase / _current / _due are the read model (phase, governing deadline, the
-- remaining microseconds that are shown, never an automatic extension) and the deletion reconciler's discovery.
-- Raised: KA072 LIFECYCLE_BINDING (a birth without its capture, a release after the hard cap, a completion before release or at/after the
-- continuation deadline), KA004 IMMUTABLE_COLUMN.

CREATE TABLE kauro.staged_retention_windows (
  window_id                uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(window_id)),
  agency_id                uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id               uuid NOT NULL,
  plan_id                  uuid NOT NULL,
  capture_id               uuid NOT NULL,
  captured_at              timestamptz NOT NULL,
  hard_deadline            timestamptz NOT NULL,
  first_released_at        timestamptz,
  continuation_deadline    timestamptz,
  final_completed_at       timestamptz,
  final_download_deadline  timestamptz,
  created_at               timestamptz NOT NULL,
  UNIQUE (agency_id, window_id),
  UNIQUE (agency_id, plan_id),
  UNIQUE (agency_id, capture_id),
  FOREIGN KEY (agency_id, project_id) REFERENCES kauro.projects (agency_id, project_id),
  FOREIGN KEY (agency_id, plan_id) REFERENCES kauro.plans (agency_id, plan_id),
  FOREIGN KEY (agency_id, capture_id) REFERENCES kauro.capture_facts (agency_id, capture_id),
  CONSTRAINT staged_retention_hard_cap CHECK (hard_deadline = captured_at + interval '2592000 seconds'),
  CONSTRAINT staged_retention_continuation CHECK (
    (first_released_at IS NULL AND continuation_deadline IS NULL)
    OR (first_released_at IS NOT NULL AND first_released_at >= captured_at AND first_released_at < hard_deadline
        AND continuation_deadline = least(first_released_at + interval '1814400 seconds', hard_deadline))
  ),
  CONSTRAINT staged_retention_final CHECK (
    (final_completed_at IS NULL AND final_download_deadline IS NULL)
    OR (final_completed_at IS NOT NULL AND first_released_at IS NOT NULL AND final_completed_at >= first_released_at
        AND final_completed_at < continuation_deadline
        AND final_download_deadline = least(final_completed_at + interval '604800 seconds', hard_deadline))
  )
);

-- birth: the capture fact of this project's plan, COMPLETED; the window starts unreleased
CREATE OR REPLACE FUNCTION kauro.staged_retention_windows_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  captured timestamptz;
BEGIN
  SELECT least(c.provider_completed_at, c.first_observed_at) INTO captured
    FROM kauro.capture_facts c
    JOIN kauro.payment_orders o ON o.agency_id = c.agency_id AND o.order_id = c.order_id
    JOIN kauro.quotes q ON q.agency_id = o.agency_id AND q.quote_id = o.quote_id
   WHERE c.agency_id = NEW.agency_id AND c.capture_id = NEW.capture_id AND c.status = 'COMPLETED'
     AND o.project_id = NEW.project_id AND q.project_id = NEW.project_id AND q.plan_id = NEW.plan_id;
  IF captured IS NULL THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: a staged retention window is anchored on a COMPLETED capture of its own project and plan (capture %)', NEW.capture_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.first_released_at IS NOT NULL OR NEW.final_completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: a staged retention window is born unreleased (window %)', NEW.window_id USING ERRCODE = 'KA072';
  END IF;
  NEW.captured_at := captured;
  NEW.hard_deadline := captured + interval '2592000 seconds';
  NEW.continuation_deadline := NULL;
  NEW.final_download_deadline := NULL;
  NEW.created_at := kauro.server_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER staged_retention_windows_birth BEFORE INSERT ON kauro.staged_retention_windows
  FOR EACH ROW EXECUTE FUNCTION kauro.staged_retention_windows_birth();

-- the anchors are learned once on the server clock, judged after the row lock on the effect clock; the deadlines follow from them
CREATE OR REPLACE FUNCTION kauro.staged_retention_windows_deadlines() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  acting timestamptz := kauro.effect_now();
  stamp timestamptz := kauro.server_now();
  continuation timestamptz;
BEGIN
  IF OLD.first_released_at IS NOT NULL THEN
    NEW.first_released_at := OLD.first_released_at;
  ELSIF NEW.first_released_at IS NOT NULL THEN
    IF acting >= OLD.hard_deadline THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: staged workflow % passed its hard deadline % (capture + 30 d) at %: no stage is released', OLD.window_id, OLD.hard_deadline, acting USING ERRCODE = 'KA072';
    END IF;
    IF stamp < OLD.captured_at THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: staged workflow % is released no earlier than its capture %', OLD.window_id, OLD.captured_at USING ERRCODE = 'KA072';
    END IF;
    NEW.first_released_at := stamp;
  END IF;
  continuation := CASE WHEN NEW.first_released_at IS NULL THEN NULL ELSE least(NEW.first_released_at + interval '1814400 seconds', OLD.hard_deadline) END;
  IF OLD.final_completed_at IS NOT NULL THEN
    NEW.final_completed_at := OLD.final_completed_at;
  ELSIF NEW.final_completed_at IS NOT NULL THEN
    IF continuation IS NULL THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: staged workflow % completes its final delivery only after its first stage release', OLD.window_id USING ERRCODE = 'KA072';
    END IF;
    IF acting >= continuation THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: staged workflow % expired at % (acting at %): a late completion creates no final-delivery allowance', OLD.window_id, continuation, acting USING ERRCODE = 'KA072';
    END IF;
    NEW.final_completed_at := stamp;
  END IF;
  NEW.continuation_deadline := continuation;
  NEW.final_download_deadline := CASE WHEN NEW.final_completed_at IS NULL THEN NULL ELSE least(NEW.final_completed_at + interval '604800 seconds', OLD.hard_deadline) END;
  RETURN NEW;
END
$$;
CREATE TRIGGER staged_retention_windows_deadlines BEFORE UPDATE ON kauro.staged_retention_windows
  FOR EACH ROW EXECUTE FUNCTION kauro.staged_retention_windows_deadlines();
CREATE TRIGGER staged_retention_windows_immutable BEFORE UPDATE ON kauro.staged_retention_windows
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('window_id,agency_id,project_id,plan_id,capture_id,captured_at,hard_deadline,created_at');
CREATE TRIGGER staged_retention_windows_no_delete BEFORE DELETE ON kauro.staged_retention_windows
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- read model ------------------------------------------------------------------------------------------------------------------------
-- The phase of a window at `at_instant`: the governing deadline is the final download's once completed, else the continuation's once released,
-- else the hard cap; at the deadline it is EXPIRED (never one microsecond late), before it open with the exact remaining microseconds.
CREATE OR REPLACE FUNCTION kauro.staged_retention_phase(w kauro.staged_retention_windows, at_instant timestamptz,
                                                         OUT phase text, OUT governing_deadline timestamptz, OUT remaining_micros bigint)
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog AS
$$
  SELECT CASE WHEN at_instant < d THEN p ELSE 'EXPIRED' END,
         d,
         CASE WHEN at_instant < d THEN (extract(epoch FROM d - at_instant) * 1000000)::bigint ELSE 0::bigint END
    FROM (SELECT CASE WHEN w.final_completed_at IS NOT NULL THEN 'FINAL_DOWNLOAD_OPEN'
                      WHEN w.first_released_at IS NOT NULL THEN 'CONTINUATION_OPEN'
                      ELSE 'AWAITING_RELEASE' END AS p,
                 coalesce(w.final_download_deadline, w.continuation_deadline, w.hard_deadline) AS d) x
$$;

-- The phase now, on the server's clock (kauro.effect_now()): never a caller's instant. Row security applies (invoker).
CREATE OR REPLACE FUNCTION kauro.staged_retention_current(window_ref uuid)
  RETURNS TABLE (window_id uuid, phase text, governing_deadline timestamptz, remaining_micros bigint)
  LANGUAGE sql VOLATILE SET search_path = pg_catalog AS
$$
  SELECT x.window_id, (s).phase, (s).governing_deadline, (s).remaining_micros
    FROM (SELECT w.window_id, kauro.staged_retention_phase(w, kauro.effect_now()) AS s FROM kauro.staged_retention_windows w WHERE w.window_id = window_ref) x
$$;

-- The windows whose governing deadline is reached on the server's clock, earliest first (the deletion reconciler's discovery). A stage
-- waiting for the agency does not hold its window: the deadline keeps running and the window is due at it.
CREATE OR REPLACE FUNCTION kauro.staged_retention_due(max_rows integer)
  RETURNS TABLE (window_id uuid, agency_id uuid, governing_deadline timestamptz)
  LANGUAGE sql VOLATILE SET search_path = pg_catalog AS
$$
  SELECT x.window_id, x.agency_id, x.d
    FROM (SELECT w.window_id, w.agency_id, coalesce(w.final_download_deadline, w.continuation_deadline, w.hard_deadline) AS d FROM kauro.staged_retention_windows w) x
   WHERE x.d <= kauro.effect_now()
   ORDER BY x.d, x.window_id
   LIMIT least(greatest(max_rows, 1), 1000)
$$;

ALTER TABLE kauro.staged_retention_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.staged_retention_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY staged_retention_windows_tenant_read ON kauro.staged_retention_windows FOR SELECT TO kauro_app USING (agency_id = kauro.current_agency_id());
GRANT SELECT ON kauro.staged_retention_windows TO kauro_app;
