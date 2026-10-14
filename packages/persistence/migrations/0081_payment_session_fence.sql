-- Migration 0081: the session fence of the bank owner commands (Payments V1, lane L-REFUND; FAILURE-MATRIX-TEMPLATE rule 16, PV1R-07 r4).
-- Provisional number (renumbered at merge by tools/renumber-migration.mjs).
--
-- Every bank owner command (F2, X1, X4, G2, G3, X3) runs its units of work as the payment service (kauro_payment), in SERVICE contexts that
-- bind no person (kauro.current_user_id() is NULL), so 0047's request fence (policies TO kauro_app over the session the transaction presents
-- for the person it binds) cannot serve them. Rule 16 requires the effect to be judged under the lock a revocation conflicts with, inside the
-- effect's own transaction: kauro.payment_session_fence(secret_sha256, user) locks FOR SHARE the one session row whose secret hash the caller
-- presents for that person and returns only its liveness columns, as the locking statement returned them (it reads no clock: the caller reads
-- its clock after the lock was granted and judges the row). Every writer of the row (revoke, resume touch, step-up: FOR UPDATE first) then
-- waits until the payment transaction ends.
--
-- SECURITY DEFINER (the fourth definer of the schema; 0046, 0079 and 0080 are the others), justified: kauro_payment gets no privilege on
-- kauro.web_sessions at all (no table or column grant, no policy), only EXECUTE on this function. Inside it FORCE ROW LEVEL SECURITY applies
-- to the function owner: the two policies below admit the owner to exactly the row whose hash the function itself binds transaction-locally
-- (kauro.session_sha256, the GUC 0025 and 0047 use), and the UPDATE policy's WITH CHECK (false) refuses every new row, so the owner's
-- policies lock and read, never change. search_path pinned; REVOKE FROM PUBLIC; EXECUTE to kauro_payment only.
-- Idempotent where PostgreSQL allows it; never edits an earlier migration.

DROP POLICY IF EXISTS web_sessions_payment_fence_read ON kauro.web_sessions;
CREATE POLICY web_sessions_payment_fence_read ON kauro.web_sessions FOR SELECT TO CURRENT_USER
  USING (secret_sha256 = kauro.current_session_sha256());
DROP POLICY IF EXISTS web_sessions_payment_fence_lock ON kauro.web_sessions;
CREATE POLICY web_sessions_payment_fence_lock ON kauro.web_sessions FOR UPDATE TO CURRENT_USER
  USING (secret_sha256 = kauro.current_session_sha256()) WITH CHECK (false);

CREATE OR REPLACE FUNCTION kauro.payment_session_fence(p_secret_sha256 text, p_user uuid)
  RETURNS TABLE (revoked_at timestamptz, idle_expires_at timestamptz, absolute_expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF p_secret_sha256 IS NULL OR p_user IS NULL OR NOT kauro.is_sha256_hex(p_secret_sha256) THEN
    RAISE EXCEPTION 'INTEGRITY: the session fence locks one presented session (a SHA-256 hex) of one person' USING ERRCODE = '22023';
  END IF;
  -- the hash the owner's policies admit, bound for this transaction only (it ends with the unit's COMMIT or ROLLBACK)
  PERFORM pg_catalog.set_config('kauro.session_sha256', p_secret_sha256, true);
  RETURN QUERY SELECT s.revoked_at, s.idle_expires_at, s.absolute_expires_at FROM kauro.web_sessions s
    WHERE s.secret_sha256 = p_secret_sha256 AND s.user_id = p_user FOR SHARE;
END
$$;
REVOKE ALL ON FUNCTION kauro.payment_session_fence(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.payment_session_fence(text, uuid) TO kauro_payment;
