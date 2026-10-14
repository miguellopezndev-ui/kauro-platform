-- 0067 — FCG-B06-LEASE-1b (tier 1; TIME-AFTER-AWAIT, the B05 L3t clock census): claim_lease judged its caller's deadline at p_now
-- (kauro.server_now(), the transaction's start) BEFORE its FOR UPDATE, while 0054 had moved only the expiry after the row lock: a claim
-- whose wait on the lease row crossed the deadline still took the lease over (fence + 1) or renewed it, for a subject whose deadline had
-- passed. The deadline is now judged at the same instant as the expiry, GREATEST(p_now, kauro.effect_now()) read after the row lock,
-- and a claim past it is refused (KA005) before anything is written. heartbeat_lease and checkpoint_lease already judge after the lock
-- (0054) and need no deadline of their own: expires_at = LEAST(.., deadline_at) never passes the deadline, so a live lease at the judged
-- instant is within it. Replaces claim_lease of 0054 (same signature); idempotent. Provisional number (renumbered at merge).
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
  SELECT * INTO cur FROM kauro.leases WHERE resource_kind = p_kind AND resource_id = p_resource FOR UPDATE;
  -- the instant of the judgement is read after the lock wait: the deadline and the expiry are both judged at it
  judged := GREATEST(p_now, kauro.effect_now());
  IF judged >= p_deadline THEN
    RAISE EXCEPTION 'LEASE: deadline of % has passed', p_resource USING ERRCODE = 'KA005';
  END IF;
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
