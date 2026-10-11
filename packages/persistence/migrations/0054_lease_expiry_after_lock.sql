-- 0054 — FCG-B06-LEASE-1 (tier 1): a lease's expiry is judged at the database clock AFTER the lock wait (TIME-AFTER-AWAIT).
-- claim_lease received p_now (kauro.server_now(), the transaction's start) evaluated before its FOR UPDATE, and heartbeat_lease and
-- checkpoint_lease compared expires_at with p_now in the statement that waits on the row: an owner whose wait on its lease row crossed the
-- expiry renewed an ended lease (06 "A stale worker cannot renew"). The three functions now judge expiry at
-- GREATEST(p_now, kauro.effect_now()), read after the row lock: a caller's instant can only be later than the database's, never earlier.
-- claim_lease: a lease that ended during the wait is a takeover at fence + 1 (leases_guard checks the checkpoint), never a renewal;
-- heartbeat_lease / checkpoint_lease: NULL (fenced out). The values written still derive from p_now (LEAST(p_now + ttl, deadline) only
-- shortens), but a takeover is written at the judged instant (leases_guard refuses a heartbeat earlier than the ended expiry). Replaces the functions of 0006 (same signatures); idempotent.
CREATE OR REPLACE FUNCTION kauro.claim_lease(
  p_kind text, p_resource uuid, p_owner uuid, p_ttl_seconds integer, p_deadline timestamptz, p_subject text, p_cost_authority uuid, p_checkpoint text, p_now timestamptz
) RETURNS kauro.leases
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  cur kauro.leases;
  judged timestamptz;
BEGIN
  IF p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'LEASE: ttl must be positive' USING ERRCODE = 'KA005';
  END IF;
  IF p_now >= p_deadline THEN
    RAISE EXCEPTION 'LEASE: deadline of % has passed', p_resource USING ERRCODE = 'KA005';
  END IF;
  SELECT * INTO cur FROM kauro.leases WHERE resource_kind = p_kind AND resource_id = p_resource FOR UPDATE;
  -- the instant of the judgement is read after the lock wait
  judged := GREATEST(p_now, kauro.effect_now());
  IF NOT FOUND THEN
    INSERT INTO kauro.leases (resource_kind, resource_id, owner_id, fence, expires_at, heartbeat_at, cancel_version, deadline_at, subject_hash, cost_authority_id, checkpoint_hash, created_at, updated_at)
    VALUES (p_kind, p_resource, p_owner, 1, LEAST(p_now + make_interval(secs => p_ttl_seconds), p_deadline), p_now, 0, p_deadline, p_subject, p_cost_authority, p_checkpoint, p_now, p_now)
    RETURNING * INTO cur;
    RETURN cur;
  END IF;
  IF cur.expires_at > judged THEN
    IF cur.owner_id <> p_owner THEN
      RETURN cur; -- HELD by a live owner
    END IF;
    -- the live holder renews under its fence; a re-claim that lacks the checkpoint it holds, or names another, is a restart
    IF cur.checkpoint_hash IS NOT NULL AND p_checkpoint IS NULL THEN
      RAISE EXCEPTION 'RESUME_WITHOUT_CHECKPOINT: the holder of % has checkpoint %, a re-claim must name it', p_resource, cur.checkpoint_hash USING ERRCODE = 'KA005';
    END IF;
    IF p_checkpoint IS DISTINCT FROM cur.checkpoint_hash THEN
      RAISE EXCEPTION 'CHECKPOINT_MISMATCH: the holder of % re-claims from % but the stored checkpoint is %', p_resource, p_checkpoint, coalesce(cur.checkpoint_hash, 'none') USING ERRCODE = 'KA005';
    END IF;
    UPDATE kauro.leases
       SET expires_at = LEAST(p_now + make_interval(secs => p_ttl_seconds), deadline_at), heartbeat_at = p_now,
           deadline_at = p_deadline, subject_hash = p_subject, cost_authority_id = p_cost_authority
     WHERE resource_kind = p_kind AND resource_id = p_resource
     RETURNING * INTO cur;
    RETURN cur;
  END IF;
  -- expired: a resume by a new attempt, the former owner's own included (fence + 1; leases_guard checks the checkpoint)
  UPDATE kauro.leases
     SET owner_id = p_owner, fence = fence + 1,
         expires_at = LEAST(judged + make_interval(secs => p_ttl_seconds), deadline_at), heartbeat_at = judged,
         deadline_at = p_deadline, subject_hash = p_subject, cost_authority_id = p_cost_authority, checkpoint_hash = p_checkpoint
   WHERE resource_kind = p_kind AND resource_id = p_resource
   RETURNING * INTO cur;
  RETURN cur;
END
$$;

-- Heartbeat under the fence the caller holds; NULL when fenced out or when the lease ended (at the database clock, after the row lock).
CREATE OR REPLACE FUNCTION kauro.heartbeat_lease(p_kind text, p_resource uuid, p_owner uuid, p_fence bigint, p_ttl_seconds integer, p_now timestamptz)
  RETURNS kauro.leases
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  cur kauro.leases;
BEGIN
  PERFORM 1 FROM kauro.leases WHERE resource_kind = p_kind AND resource_id = p_resource FOR UPDATE;
  UPDATE kauro.leases
     SET expires_at = LEAST(p_now + make_interval(secs => p_ttl_seconds), deadline_at), heartbeat_at = p_now
   WHERE resource_kind = p_kind AND resource_id = p_resource AND owner_id = p_owner AND fence = p_fence
     AND expires_at > GREATEST(p_now, kauro.effect_now())
   RETURNING * INTO cur;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN cur;
END
$$;

-- Store a checkpoint identity under the fence the caller holds; NULL when fenced out or when the lease ended (same judgement).
CREATE OR REPLACE FUNCTION kauro.checkpoint_lease(p_kind text, p_resource uuid, p_owner uuid, p_fence bigint, p_checkpoint text, p_now timestamptz)
  RETURNS kauro.leases
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  cur kauro.leases;
BEGIN
  PERFORM 1 FROM kauro.leases WHERE resource_kind = p_kind AND resource_id = p_resource FOR UPDATE;
  UPDATE kauro.leases
     SET checkpoint_hash = p_checkpoint, heartbeat_at = p_now
   WHERE resource_kind = p_kind AND resource_id = p_resource AND owner_id = p_owner AND fence = p_fence
     AND expires_at > GREATEST(p_now, kauro.effect_now())
   RETURNING * INTO cur;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN cur;
END
$$;
