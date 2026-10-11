-- 0047 — PV1 L-ROUTE PV1R-07 r4: the session fence (PROVISIONAL number, renumbered at merge by tools/renumber-migration.mjs).
--
-- Authority: 08 "Browser, API and cache isolation" (revocation invalidates server-side access immediately), 08 "Database isolation"
-- (RLS USING and WITH CHECK, FORCE RLS, runtime roles not owners, SECURITY DEFINER only with specific justification), B06 D-EVID-1
-- (request handlers consume the assurance group's output, never write it), B11 D-AUTH-1 (amended: docs/design/B11-agency-app.md),
-- docs/review/pv1-route-pv1r07-design.md §3.1.
--
-- kauro_app locks and reads the liveness of the one session its own transaction presents (kauro.session_sha256, set transaction-locally)
-- for the identity it binds (kauro.user_id); it never changes it. PostgreSQL requires UPDATE on one column for SELECT ... FOR SHARE: the
-- grant names session_id, which web_sessions_immutable refuses to change, and the UPDATE policy's WITH CHECK (false) refuses every new row.
-- No function, no SECURITY DEFINER, no table-level grant, no INSERT/DELETE.
CREATE POLICY web_sessions_request_read ON kauro.web_sessions FOR SELECT TO kauro_app
  USING (secret_sha256 = kauro.current_session_sha256() AND user_id = kauro.current_user_id());
CREATE POLICY web_sessions_request_lock ON kauro.web_sessions FOR UPDATE TO kauro_app
  USING (secret_sha256 = kauro.current_session_sha256() AND user_id = kauro.current_user_id()) WITH CHECK (false);
GRANT SELECT (secret_sha256, user_id, revoked_at, idle_expires_at, absolute_expires_at) ON kauro.web_sessions TO kauro_app;
GRANT UPDATE (session_id) ON kauro.web_sessions TO kauro_app;
