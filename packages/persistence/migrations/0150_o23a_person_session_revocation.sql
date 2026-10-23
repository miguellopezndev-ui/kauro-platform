-- 0150 — O23A: the authentication boundary ends every web session of one person (reserved range 0150..0159, SPRINT-RULES).
--
-- Authority: 08 "Browser, API and cache isolation" (revocation invalidates server-side access immediately), 08 "Database isolation"
-- (RLS USING and WITH CHECK, FORCE RLS, runtime roles not owners; SECURITY DEFINER only with specific justification: none here), B06
-- D-EVID-1 (the boundary group kauro_assurance keeps the sessions), ASVS 4.0.3 V3.3.3/V3.3.4 (after a recovery or a credential change
-- every session of the person ends; the person may end every other session).
--
-- Until now kauro_assurance sees and moves only the session whose secret hash its transaction presents (web_sessions_presented). A
-- person-wide revocation needs the person's other sessions: these two policies admit them only in a transaction that binds the person
-- (kauro.user_id) AND declares the person-wide revocation (kauro.person_revocation = 'on', transaction-local, set by the boundary's
-- revoker only), and the UPDATE may only end a session (WITH CHECK revoked_at IS NOT NULL) with a person-wide reason. The column grants
-- of 0025 are unchanged (revoked_at, revoke_reason are already the boundary's), the immutability triggers still refuse every other
-- change and any change of an ended session, and no other role gains anything.

CREATE OR REPLACE FUNCTION kauro.person_revocation_bound() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT COALESCE(current_setting('kauro.person_revocation', true), '') = 'on' AND kauro.current_user_id() IS NOT NULL $$;

CREATE POLICY web_sessions_person_revocation_read ON kauro.web_sessions FOR SELECT TO kauro_assurance
  USING (kauro.person_revocation_bound() AND user_id = kauro.current_user_id());
CREATE POLICY web_sessions_person_revocation ON kauro.web_sessions FOR UPDATE TO kauro_assurance
  USING (kauro.person_revocation_bound() AND user_id = kauro.current_user_id())
  WITH CHECK (
    kauro.person_revocation_bound() AND user_id = kauro.current_user_id() AND revoked_at IS NOT NULL
    AND revoke_reason IN ('RECOVERY', 'CREDENTIAL_CHANGED', 'MFA_CHANGED', 'SIGN_OUT_EVERYWHERE', 'ACCOUNT_DISABLED')
  );
