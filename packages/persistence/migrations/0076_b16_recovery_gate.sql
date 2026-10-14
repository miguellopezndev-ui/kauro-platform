-- 0076 — B16 lane L6: the recovery gate, the restore run and its journal application (provisional number; the coordinator renumbers).
--
-- R2 14 "External-effect recovery journal": "After restoring a backup, disable dispatch, apply current tombstones and revocations, query
-- provider payment state, rebuild safe inbox/outbox disposition and invalidate all old leases"; 09 "Deletion receipts and restoration":
-- restoration applies the tombstones, in order, before traffic. Plan conflict C2: the dispatch gate is ONE database trigger on every
-- claim table (this file), never an edit of an accepted dispatcher; the journal outside the restore boundary is a separate PostgreSQL
-- database (packages/persistence/src/journal/pg-authority-journal.ts), never a table of this one.
--
--   1. kauro.recovery_gate: one row, OPEN on a fresh database. A restore run closes it as its first statement on the restored database
--      (the migration owner, S3) and only the run that closed it opens it again, once the run is RELEASED (S8: every journal entry
--      applied, every lease invalidated, the payments reconciled with no open provider observation, the checks recorded and the
--      owner's CMD057 authorization named). The runtime groups never write it.
--   2. kauro.recovery_gate_admits() — the gate itself: a BEFORE trigger on every claim of every claim table reads the gate row
--      FOR SHARE and refuses the claim while the gate is not OPEN (KA091 B16_L6_RECOVERY_GATE, retryable): an outbox claim (->
--      CLAIMED), an inbox claim (-> PROCESSING), a lease's first claim and every takeover (a new owner or fence), a processing attempt
--      born or claimed, an audit step claimed. FOR SHARE orders each claim against the gate's UPDATE (both orders): a claim that read
--      the gate holds its share lock to its COMMIT, so S8's UPDATE waits for it, and a claim arriving while S8's UPDATE is uncommitted
--      waits and then reads what S8 committed. The control plane may take that share lock only: a column UPDATE grant of the immutable
--      gate_id and an UPDATE policy whose WITH CHECK is false (the 0047 lock-only pattern), so it can lock the row and never change it.
--   3. kauro.restore_runs (S3..S8): one row per restore candidate on the restored database; journal_through and the deletion journal
--      hash are the candidate's (S1), applied_through is the last journal entry applied in sequence (a resume starts at the next one)
--      and a failed entry is recorded with its code. The listed edges below are the only ones.
--   4. kauro.restore_applied_entries: what each journal entry did, one row per (run, journal sequence), in sequence, append-only.
--   5. kauro.restore_observations (S6): a payment identity of the journal the restored rows do not match opens a provider observation
--      with a deadline on the database clock; while any observation of the run exists the run cannot be released (a conflict pauses).
-- Only the migration owner writes 3..5, through owner policies (FORCE row security holds the owner too); no runtime role reads them.

-- --- 1. the gate ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.recovery_gate (
  gate_id     boolean PRIMARY KEY DEFAULT true CHECK (gate_id),
  state       text NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
  run_id      uuid CHECK (run_id IS NULL OR kauro.is_uuid_v7(run_id)),
  revision    bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  changed_at  timestamptz NOT NULL,
  CONSTRAINT recovery_gate_closed_by_a_run CHECK (state = 'OPEN' OR run_id IS NOT NULL)
);
INSERT INTO kauro.recovery_gate (gate_id, state, changed_at) VALUES (true, 'OPEN', kauro.server_now());
CREATE TRIGGER recovery_gate_no_delete BEFORE INSERT OR DELETE ON kauro.recovery_gate
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER recovery_gate_no_truncate BEFORE TRUNCATE ON kauro.recovery_gate
  FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
CREATE TRIGGER recovery_gate_immutable BEFORE UPDATE ON kauro.recovery_gate
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('gate_id');

CREATE TABLE kauro.restore_runs (
  run_id                 uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(run_id)),
  candidate_id           uuid NOT NULL UNIQUE CHECK (kauro.is_uuid_v7(candidate_id)),
  plan_hash              text NOT NULL CHECK (kauro.is_sha256_hex(plan_hash)),
  deletion_journal_hash  text NOT NULL CHECK (kauro.is_sha256_hex(deletion_journal_hash)),
  journal_through        bigint NOT NULL CHECK (journal_through >= 0),
  state                  text NOT NULL DEFAULT 'GATED' CHECK (state IN ('GATED', 'APPLYING', 'APPLIED', 'FENCED', 'RECONCILED', 'PAUSED', 'CHECKED', 'RELEASED')),
  applied_through        bigint NOT NULL DEFAULT 0 CHECK (applied_through >= 0),
  failed_at_entry        bigint CHECK (failed_at_entry IS NULL OR failed_at_entry >= 1),
  failure_code           text CHECK (failure_code IS NULL OR kauro.is_token(failure_code)),
  checks_hash            text CHECK (checks_hash IS NULL OR kauro.is_sha256_hex(checks_hash)),
  recovery_id            uuid CHECK (recovery_id IS NULL OR kauro.is_uuid_v7(recovery_id)),
  authorization_ref      uuid,
  revision               bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  started_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  released_at            timestamptz,
  CONSTRAINT restore_runs_within_journal CHECK (applied_through <= journal_through),
  CONSTRAINT restore_runs_failure_named CHECK ((failed_at_entry IS NULL) = (failure_code IS NULL)),
  CONSTRAINT restore_runs_failure_is_next CHECK (failed_at_entry IS NULL OR failed_at_entry = applied_through + 1),
  CONSTRAINT restore_runs_applied_whole CHECK (state IN ('GATED', 'APPLYING') OR (applied_through = journal_through AND failed_at_entry IS NULL)),
  CONSTRAINT restore_runs_checked_evidence CHECK (state NOT IN ('CHECKED', 'RELEASED') OR checks_hash IS NOT NULL),
  CONSTRAINT restore_runs_released_evidence CHECK ((state = 'RELEASED') = (released_at IS NOT NULL) AND (state <> 'RELEASED' OR (recovery_id IS NOT NULL AND authorization_ref IS NOT NULL)))
);

CREATE TABLE kauro.restore_applied_entries (
  run_id        uuid NOT NULL REFERENCES kauro.restore_runs (run_id),
  journal_seq   bigint NOT NULL CHECK (journal_seq >= 1),
  entry_id      text NOT NULL CHECK (char_length(entry_id) BETWEEN 1 AND 128),
  kind          text NOT NULL CHECK (kind IN ('TOMBSTONE', 'REVOCATION', 'EXTENSION', 'PAYMENT', 'NOTIFICATION')),
  outcome       text NOT NULL CHECK (outcome IN ('APPLIED', 'ALREADY_APPLIED', 'SUPPRESSED', 'ABSENT', 'VERIFIED', 'DEFERRED')),
  recorded_at   timestamptz NOT NULL,
  PRIMARY KEY (run_id, journal_seq)
);
CREATE TRIGGER restore_applied_entries_append_only BEFORE UPDATE OR DELETE ON kauro.restore_applied_entries
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE TABLE kauro.restore_observations (
  observation_id  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(observation_id)),
  run_id          uuid NOT NULL REFERENCES kauro.restore_runs (run_id),
  journal_seq     bigint NOT NULL CHECK (journal_seq >= 1),
  entry_id        text NOT NULL CHECK (char_length(entry_id) BETWEEN 1 AND 128),
  subject_kind    text NOT NULL CHECK (subject_kind IN ('CAPTURE', 'REFUND')),
  subject_id      uuid NOT NULL,
  mismatch        text NOT NULL CHECK (kauro.is_token(mismatch)),
  state           text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'ANSWERED', 'TIMED_OUT')),
  answer          text CHECK (answer IS NULL OR kauro.is_token(answer)),
  opened_at       timestamptz NOT NULL,
  deadline_at     timestamptz NOT NULL,
  closed_at       timestamptz,
  UNIQUE (run_id, entry_id),
  CONSTRAINT restore_observations_deadline_after_open CHECK (deadline_at > opened_at),
  CONSTRAINT restore_observations_closed CHECK ((state = 'OPEN') = (closed_at IS NULL) AND (state = 'ANSWERED') = (answer IS NOT NULL))
);
CREATE TRIGGER restore_observations_immutable BEFORE UPDATE ON kauro.restore_observations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('observation_id,run_id,journal_seq,entry_id,subject_kind,subject_id,mismatch,opened_at,deadline_at');
CREATE TRIGGER restore_observations_no_delete BEFORE DELETE ON kauro.restore_observations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- the gate's edges: closed by a run, opened only by the same run once it is RELEASED --------------------------------------------
CREATE OR REPLACE FUNCTION kauro.recovery_gate_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: the recovery gate moves one revision at a time' USING ERRCODE = 'KA002';
  END IF;
  NEW.changed_at := kauro.server_now();
  IF OLD.state = 'OPEN' AND NEW.state = 'CLOSED' THEN
    RETURN NEW; -- recovery_gate_closed_by_a_run names the run
  END IF;
  IF OLD.state = 'CLOSED' AND NEW.state = 'OPEN' THEN
    IF NEW.run_id IS DISTINCT FROM OLD.run_id OR NOT EXISTS (
      SELECT 1 FROM kauro.restore_runs r WHERE r.run_id = OLD.run_id AND r.state = 'RELEASED'
    ) THEN
      RAISE EXCEPTION 'RESTORE_RECONCILIATION: the recovery gate opens only for the run that closed it, once that run is RELEASED' USING ERRCODE = 'KA092';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'RECOVERY_GATE: % -> % is not an edge of the recovery gate (a closed gate belongs to its run)', OLD.state, NEW.state USING ERRCODE = 'KA091';
END
$$;
CREATE TRIGGER recovery_gate_guard BEFORE UPDATE ON kauro.recovery_gate
  FOR EACH ROW EXECUTE FUNCTION kauro.recovery_gate_guard();

-- --- 2. the gate on every claim -----------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.recovery_gate_admits() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  gate text;
BEGIN
  SELECT g.state INTO gate FROM kauro.recovery_gate g WHERE g.gate_id FOR SHARE;
  IF gate IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'RECOVERY_GATE: no claim on % while a restore holds the recovery gate closed', TG_TABLE_NAME USING ERRCODE = 'KA091';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER outbox_records_recovery_gate BEFORE UPDATE ON kauro.outbox_records
  FOR EACH ROW WHEN (NEW.state = 'CLAIMED' AND NEW.attempts IS DISTINCT FROM OLD.attempts) EXECUTE FUNCTION kauro.recovery_gate_admits();
CREATE TRIGGER inbox_records_recovery_gate BEFORE UPDATE ON kauro.inbox_records
  FOR EACH ROW WHEN (NEW.state = 'PROCESSING') EXECUTE FUNCTION kauro.recovery_gate_admits();
CREATE TRIGGER leases_recovery_gate_claim BEFORE INSERT ON kauro.leases
  FOR EACH ROW EXECUTE FUNCTION kauro.recovery_gate_admits();
CREATE TRIGGER leases_recovery_gate_takeover BEFORE UPDATE ON kauro.leases
  FOR EACH ROW WHEN (NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.fence IS DISTINCT FROM OLD.fence) EXECUTE FUNCTION kauro.recovery_gate_admits();
CREATE TRIGGER processing_attempts_recovery_gate_birth BEFORE INSERT ON kauro.processing_attempts
  FOR EACH ROW EXECUTE FUNCTION kauro.recovery_gate_admits();
CREATE TRIGGER processing_attempts_recovery_gate_claim BEFORE UPDATE ON kauro.processing_attempts
  FOR EACH ROW WHEN (NEW.state = 'CLAIMED' AND OLD.state IS DISTINCT FROM 'CLAIMED') EXECUTE FUNCTION kauro.recovery_gate_admits();
CREATE TRIGGER audit_steps_recovery_gate_claim BEFORE INSERT ON kauro.audit_steps
  FOR EACH ROW EXECUTE FUNCTION kauro.recovery_gate_admits();

-- --- 3. the run's edges ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.restore_runs_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.started_at := kauro.server_now();
  NEW.updated_at := NEW.started_at;
  IF NEW.state <> 'GATED' OR NEW.applied_through <> 0 OR NEW.revision <> 1 OR NEW.released_at IS NOT NULL OR NEW.failed_at_entry IS NOT NULL THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a restore run is born GATED, with nothing applied' USING ERRCODE = 'KA008';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.recovery_gate g WHERE g.gate_id AND g.state = 'CLOSED' AND g.run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'RECOVERY_GATE: a restore run is born only behind the gate it closed' USING ERRCODE = 'KA091';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER restore_runs_birth BEFORE INSERT ON kauro.restore_runs
  FOR EACH ROW EXECUTE FUNCTION kauro.restore_runs_birth();
CREATE TRIGGER restore_runs_immutable BEFORE UPDATE ON kauro.restore_runs
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('run_id,candidate_id,plan_hash,deletion_journal_hash,journal_through,started_at');
CREATE TRIGGER restore_runs_no_delete BEFORE DELETE ON kauro.restore_runs
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.restore_runs_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  edge text := OLD.state || '>' || NEW.state;
BEGIN
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'VERSION_DISCIPLINE: a restore run moves one revision at a time' USING ERRCODE = 'KA002';
  END IF;
  NEW.updated_at := kauro.server_now();
  IF OLD.state = 'RELEASED' THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a released restore run is final' USING ERRCODE = 'KA008';
  END IF;
  IF edge NOT IN ('GATED>APPLYING', 'GATED>APPLIED', 'APPLYING>APPLYING', 'APPLYING>APPLIED', 'APPLIED>FENCED', 'FENCED>RECONCILED', 'FENCED>PAUSED',
                  'PAUSED>PAUSED', 'RECONCILED>CHECKED', 'CHECKED>RELEASED') THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: % is not an edge of a restore run', edge USING ERRCODE = 'KA008';
  END IF;
  -- the journal is applied in sequence: progress never goes back, and every entry up to it has its applied row
  IF NEW.applied_through < OLD.applied_through THEN
    RAISE EXCEPTION 'RESTORE_RECONCILIATION: a restore run never un-applies a journal entry' USING ERRCODE = 'KA092';
  END IF;
  IF NEW.applied_through > OLD.applied_through AND (
    SELECT count(*) FROM kauro.restore_applied_entries a WHERE a.run_id = NEW.run_id AND a.journal_seq > OLD.applied_through AND a.journal_seq <= NEW.applied_through
  ) <> NEW.applied_through - OLD.applied_through THEN
    RAISE EXCEPTION 'RESTORE_RECONCILIATION: journal entries %..% of run % have no applied row', OLD.applied_through + 1, NEW.applied_through, NEW.run_id USING ERRCODE = 'KA092';
  END IF;
  IF NEW.state = 'RECONCILED' AND EXISTS (SELECT 1 FROM kauro.restore_observations o WHERE o.run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'RESTORE_RECONCILIATION: run % has a provider observation; a payment conflict pauses the restore', NEW.run_id USING ERRCODE = 'KA092';
  END IF;
  IF NEW.state = 'RELEASED' THEN
    NEW.released_at := kauro.server_now();
    IF NOT EXISTS (SELECT 1 FROM kauro.recovery_gate g WHERE g.gate_id AND g.state = 'CLOSED' AND g.run_id = NEW.run_id) THEN
      RAISE EXCEPTION 'RECOVERY_GATE: run % is released only while it holds the recovery gate', NEW.run_id USING ERRCODE = 'KA091';
    END IF;
  ELSIF NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: a restore run is released only on its RELEASED edge' USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER restore_runs_guard BEFORE UPDATE ON kauro.restore_runs
  FOR EACH ROW EXECUTE FUNCTION kauro.restore_runs_guard();

-- --- 4. an applied entry is the next one of a run still applying -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.restore_applied_entries_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.recorded_at := kauro.server_now();
  IF NOT EXISTS (
    SELECT 1 FROM kauro.restore_runs r
     WHERE r.run_id = NEW.run_id AND r.state IN ('GATED', 'APPLYING') AND r.applied_through = NEW.journal_seq - 1 AND NEW.journal_seq <= r.journal_through
  ) THEN
    RAISE EXCEPTION 'RESTORE_RECONCILIATION: journal entry % of run % is not the next one to apply', NEW.journal_seq, NEW.run_id USING ERRCODE = 'KA092';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER restore_applied_entries_birth BEFORE INSERT ON kauro.restore_applied_entries
  FOR EACH ROW EXECUTE FUNCTION kauro.restore_applied_entries_birth();

-- --- 5. observations: opened while the run reconciles, closed once by an answer or by its deadline on the database clock -------------
CREATE OR REPLACE FUNCTION kauro.restore_observations_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.opened_at := kauro.server_now();
  IF NEW.state <> 'OPEN' OR NEW.closed_at IS NOT NULL OR NEW.answer IS NOT NULL THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a provider observation is born OPEN' USING ERRCODE = 'KA008';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.restore_runs r WHERE r.run_id = NEW.run_id AND r.state IN ('FENCED', 'PAUSED')) THEN
    RAISE EXCEPTION 'RESTORE_RECONCILIATION: a provider observation is opened by a run reconciling its payments' USING ERRCODE = 'KA092';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER restore_observations_birth BEFORE INSERT ON kauro.restore_observations
  FOR EACH ROW EXECUTE FUNCTION kauro.restore_observations_birth();

CREATE OR REPLACE FUNCTION kauro.restore_observations_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  clock timestamptz := kauro.server_now();
BEGIN
  IF OLD.state <> 'OPEN' OR NEW.state NOT IN ('ANSWERED', 'TIMED_OUT') THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: a provider observation closes once, from OPEN' USING ERRCODE = 'KA008';
  END IF;
  -- a timeout is the database clock past the deadline, never the caller's
  IF NEW.state = 'TIMED_OUT' AND clock < OLD.deadline_at THEN
    RAISE EXCEPTION 'RESTORE_RECONCILIATION: observation % times out only at its deadline %', OLD.observation_id, OLD.deadline_at USING ERRCODE = 'KA092';
  END IF;
  NEW.closed_at := clock;
  RETURN NEW;
END
$$;
CREATE TRIGGER restore_observations_guard BEFORE UPDATE ON kauro.restore_observations
  FOR EACH ROW EXECUTE FUNCTION kauro.restore_observations_guard();

-- --- access -------------------------------------------------------------------------------------------------------------------------
ALTER TABLE kauro.recovery_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.recovery_gate FORCE ROW LEVEL SECURITY;
CREATE POLICY recovery_gate_owner ON kauro.recovery_gate FOR ALL TO kauro_owner USING (true) WITH CHECK (true);
-- the claim triggers run as the claiming role (the control plane): it reads the gate and takes its share lock, never writes it
CREATE POLICY recovery_gate_control_read ON kauro.recovery_gate FOR SELECT TO kauro_control USING (true);
CREATE POLICY recovery_gate_control_lock ON kauro.recovery_gate FOR UPDATE TO kauro_control USING (true) WITH CHECK (false);
GRANT SELECT (gate_id, state) ON kauro.recovery_gate TO kauro_control;
GRANT UPDATE (gate_id) ON kauro.recovery_gate TO kauro_control;

ALTER TABLE kauro.restore_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.restore_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_runs_owner ON kauro.restore_runs FOR ALL TO kauro_owner USING (true) WITH CHECK (true);
ALTER TABLE kauro.restore_applied_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.restore_applied_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_applied_entries_owner ON kauro.restore_applied_entries FOR ALL TO kauro_owner USING (true) WITH CHECK (true);
ALTER TABLE kauro.restore_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.restore_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY restore_observations_owner ON kauro.restore_observations FOR ALL TO kauro_owner USING (true) WITH CHECK (true);
REVOKE EXECUTE ON FUNCTION kauro.recovery_gate_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.recovery_gate_admits() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.restore_runs_birth() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.restore_runs_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.restore_applied_entries_birth() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.restore_observations_birth() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kauro.restore_observations_guard() FROM PUBLIC;
