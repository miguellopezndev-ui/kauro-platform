-- 0044: preserve transaction instants by retrying an older ledger waiter (R2-046).
-- The platform ledger serializes admissions. A transaction that began before the
-- admission it waited for must restart so all its rows still share server_now().
ALTER TABLE kauro.execution_capacity ADD COLUMN last_admission_at timestamptz;

CREATE OR REPLACE FUNCTION kauro.processing_jobs_ledgers() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  old_holds text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.holds ELSE 'NONE' END;
  d_live integer := (CASE WHEN NEW.holds <> 'NONE' THEN 1 ELSE 0 END) - (CASE WHEN old_holds <> 'NONE' THEN 1 ELSE 0 END);
  d_waiting integer := (CASE WHEN NEW.holds = 'WAITING' THEN 1 ELSE 0 END) - (CASE WHEN old_holds = 'WAITING' THEN 1 ELSE 0 END);
  d_active integer := (CASE WHEN NEW.holds = 'ACTIVE' THEN 1 ELSE 0 END) - (CASE WHEN old_holds = 'ACTIVE' THEN 1 ELSE 0 END);
  admitted boolean := old_holds = 'BACKLOG' AND NEW.holds = 'WAITING';
BEGIN
  IF d_live <> 0 OR admitted THEN
    INSERT INTO kauro.agency_execution_capacity (agency_id, live_jobs, updated_at) VALUES (NEW.agency_id, 0, now())
    ON CONFLICT (agency_id) DO NOTHING;
    IF admitted THEN
      -- the admission (the control plane's edge) is the only writer of the agency's last admission
      UPDATE kauro.agency_execution_capacity SET live_jobs = live_jobs + d_live, last_admitted_at = kauro.server_now(), updated_at = now()
       WHERE agency_id = NEW.agency_id;
    ELSE
      UPDATE kauro.agency_execution_capacity SET live_jobs = live_jobs + d_live, updated_at = now() WHERE agency_id = NEW.agency_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: the execution ledger of agency % is not visible in this transaction', NEW.agency_id USING ERRCODE = 'KA082';
    END IF;
  END IF;
  IF d_waiting <> 0 OR d_active <> 0 THEN
    UPDATE kauro.execution_capacity SET waiting_jobs = waiting_jobs + d_waiting, active_jobs = active_jobs + d_active,
      last_admission_at = CASE WHEN admitted THEN kauro.server_now() ELSE last_admission_at END, updated_at = now() WHERE ledger_id = 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: the platform execution ledger is not visible in this transaction' USING ERRCODE = 'KA082';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- Same invoker security and row lock as the existing capacity ledger functions.
-- Read the committed row version after waiting, before selecting any candidate.
CREATE OR REPLACE FUNCTION kauro.lock_execution_ledger() RETURNS void
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS
$$
DECLARE
  last_admission timestamptz;
BEGIN
  SELECT last_admission_at INTO last_admission
    FROM kauro.execution_capacity WHERE ledger_id = 1 FOR UPDATE;
  IF last_admission IS NOT NULL AND last_admission >= kauro.server_now() THEN
    RAISE EXCEPTION 'R2-046: transaction started before or at the last admission; retry the ledger lock in a fresh transaction'
      USING ERRCODE = '40001';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION kauro.lock_execution_ledger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.lock_execution_ledger() TO kauro_control;

-- The platform's last admission is written only by the admission itself (kauro.processing_jobs_ledgers, one trigger level deep)
-- and only forward: a direct UPDATE by a runtime role (kauro_control holds table-wide UPDATE since 0021) can neither stall every
-- admission (a future value) nor switch the R2-046 check off (NULL), and an admission that is not strictly later than the last
-- one is refused even on a path that skipped lock_execution_ledger (adversary 4528c9c ADV-1/ADV-2).
CREATE OR REPLACE FUNCTION kauro.execution_capacity_last_admission_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.last_admission_at IS DISTINCT FROM OLD.last_admission_at THEN
    -- the value must be THIS transaction's instant: trigger depth alone is no provenance (a runtime login may create a pg_temp
    -- trigger function; Codex p0-admission r1), but no path can then write anything but "now" — which only makes an older
    -- waiter retry — never a future instant that stalls every admission, nor NULL, nor a step back
    -- ... and an admission really happened in this transaction (a job admitted at this instant; adversary 49ff1ce ADV-4)
    IF pg_trigger_depth() < 2 OR NEW.last_admission_at IS NULL OR NEW.last_admission_at <> kauro.server_now()
       OR (OLD.last_admission_at IS NOT NULL AND NEW.last_admission_at <= OLD.last_admission_at)
       OR NOT EXISTS (SELECT 1 FROM kauro.processing_jobs j WHERE j.admitted_at = kauro.server_now()) THEN
      RAISE EXCEPTION 'CAPACITY_LEDGER: the platform last admission moves only forward, by an admission (R2-046)' USING ERRCODE = 'KA082';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER execution_capacity_last_admission_guard BEFORE UPDATE ON kauro.execution_capacity
  FOR EACH ROW EXECUTE FUNCTION kauro.execution_capacity_last_admission_guard();

-- The same provenance gap in the agency's fair-order key (0021:393, analogous path of the same finding): depth alone let a
-- pg_temp trigger write any instant, e.g. one in the past to move an agency ahead. Faithful copy of 0021's guard (its only
-- definition) plus: the new value must be this transaction's server instant, strictly later, set by an admission of the agency.
CREATE OR REPLACE FUNCTION kauro.agency_execution_capacity_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  -- moved only forward, to this transaction's instant, and only by an admission of one of THIS agency's jobs in this transaction:
  -- an old open transaction cannot pull an agency ahead, and no transaction can push a competitor back without admitting it
  -- (adversary 49ff1ce ADV-4)
  IF NEW.last_admitted_at IS DISTINCT FROM OLD.last_admitted_at
     AND (pg_trigger_depth() < 2 OR NEW.last_admitted_at IS DISTINCT FROM kauro.server_now()
          OR (OLD.last_admitted_at IS NOT NULL AND NEW.last_admitted_at <= OLD.last_admitted_at)
          OR NOT EXISTS (SELECT 1 FROM kauro.processing_jobs j WHERE j.agency_id = NEW.agency_id AND j.admitted_at = kauro.server_now())) THEN
    RAISE EXCEPTION 'CAPACITY_LEDGER: the last admission of agency % is recorded by its admissions only', OLD.agency_id USING ERRCODE = 'KA082';
  END IF;
  RETURN NEW;
END
$$;
