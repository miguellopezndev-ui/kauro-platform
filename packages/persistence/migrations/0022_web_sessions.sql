-- 0022 — web sessions of the browser boundary (B11 design docs/design/B11-agency-app.md D-AUTH-1, mandate W2). Numbered 0009 on
-- the mandate's branch and renumbered 0022 by the B11 stage-1 integrator (B11 owns 0022..0024; README "Migration ownership").
--
-- Authority: 08 "Authentication and assurance" (session cookies are Secure, HttpOnly, with a deliberate SameSite policy;
-- passwords, MFA seeds, session tokens and provider credentials never leave the secure flow), 08 "Browser, API and cache
-- isolation" (revocation invalidates server-side access immediately), 08 "Database isolation" (RLS USING and WITH CHECK,
-- FORCE ROW LEVEL SECURITY; runtime roles are neither owners nor BYPASSRLS), B06 D-EVID-1 (the authentication boundary's own
-- runtime group, kauro_assurance, produces what the request handlers consume but must never write).
--
-- A session is the SHA-256 of a 32-byte secret the browser holds in the __Host-kauro_session cookie; the secret itself is never
-- stored. The table belongs to the authentication boundary alone: the request handlers (kauro_app) hold no privilege on it, so
-- no request path can read another person's session or mint one. The boundary group (kauro_assurance) opens a session for the
-- identity its transaction binds (kauro.user_id) and sees, moves or ends only the session whose secret hash its transaction
-- presents (kauro.session_sha256, set transaction-locally like the tenant context): nothing lists sessions, nothing deletes
-- them (expired rows are a retention concern of B16). A session keeps the facts its identity token proved at sign-in (the
-- verification instants, the provider and the subject digest of the identity reference it authenticates) and, for the step-up
-- page state, its latest step-up proof — the boundary may read neither the identities nor the proofs themselves.
-- Lifetimes are the application's policy (Q-B11-2: 1 800 s idle, 43 200 s absolute) and the database refuses anything longer.

CREATE OR REPLACE FUNCTION kauro.current_session_sha256() RETURNS text
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS
$$ SELECT NULLIF(current_setting('kauro.session_sha256', true), '') $$;

-- binding target: a session names the identity reference it authenticates exactly as the identity row records it
CREATE UNIQUE INDEX identities_reference ON kauro.identities (user_id, provider, subject_hash);

CREATE TABLE kauro.web_sessions (
  session_id           uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(session_id)),
  secret_sha256        text NOT NULL UNIQUE CHECK (kauro.is_sha256_hex(secret_sha256)),
  user_id              uuid NOT NULL,
  provider             text NOT NULL,
  subject_hash         text NOT NULL,
  email_verified_at    timestamptz,
  mfa_at               timestamptz,
  created_at           timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL,
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  step_up_proof_id     uuid,
  step_up_fresh_until  timestamptz,
  revoked_at           timestamptz,
  revoke_reason        text CHECK (revoke_reason IS NULL OR kauro.is_token(revoke_reason)),
  CONSTRAINT web_sessions_identity_fk FOREIGN KEY (user_id, provider, subject_hash) REFERENCES kauro.identities (user_id, provider, subject_hash),
  -- the latest step-up is a proof of this session's own person (assurance_proofs UNIQUE (user_id, proof_id))
  CONSTRAINT web_sessions_step_up_proof_fk FOREIGN KEY (user_id, step_up_proof_id) REFERENCES kauro.assurance_proofs (user_id, proof_id),
  CONSTRAINT web_sessions_absolute_lifetime CHECK (absolute_expires_at > created_at AND absolute_expires_at <= created_at + interval '43200 seconds'),
  CONSTRAINT web_sessions_idle_window CHECK (
    last_seen_at >= created_at AND idle_expires_at > last_seen_at
    AND idle_expires_at <= last_seen_at + interval '1800 seconds' AND idle_expires_at <= absolute_expires_at
  ),
  CONSTRAINT web_sessions_revocation CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT web_sessions_step_up CHECK ((step_up_proof_id IS NULL) = (step_up_fresh_until IS NULL))
);
CREATE INDEX web_sessions_by_user ON kauro.web_sessions (user_id, created_at);

-- What a session is never changes; an ended session never changes at all; last-seen only moves forward.
CREATE TRIGGER web_sessions_immutable BEFORE UPDATE ON kauro.web_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('session_id,secret_sha256,user_id,provider,subject_hash,email_verified_at,mfa_at,created_at,absolute_expires_at');

CREATE OR REPLACE FUNCTION kauro.guard_web_session_update() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: web session % was revoked; an ended session never changes', OLD.session_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: the last-seen instant of web session % only moves forward', OLD.session_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER web_sessions_update_guard BEFORE UPDATE ON kauro.web_sessions
  FOR EACH ROW EXECUTE FUNCTION kauro.guard_web_session_update();

ALTER TABLE kauro.web_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.web_sessions FORCE ROW LEVEL SECURITY;
-- the boundary opens a session for the identity its transaction binds, under the secret hash it presents
CREATE POLICY web_sessions_open ON kauro.web_sessions FOR INSERT TO kauro_assurance
  WITH CHECK (user_id = kauro.current_user_id() AND secret_sha256 = kauro.current_session_sha256());
-- and sees, moves or ends only the session whose secret hash its transaction presents
CREATE POLICY web_sessions_presented ON kauro.web_sessions FOR SELECT TO kauro_assurance
  USING (secret_sha256 = kauro.current_session_sha256());
CREATE POLICY web_sessions_presented_update ON kauro.web_sessions FOR UPDATE TO kauro_assurance
  USING (secret_sha256 = kauro.current_session_sha256()) WITH CHECK (secret_sha256 = kauro.current_session_sha256());

GRANT SELECT, INSERT ON kauro.web_sessions TO kauro_assurance;
GRANT UPDATE (last_seen_at, idle_expires_at, step_up_proof_id, step_up_fresh_until, revoked_at, revoke_reason) ON kauro.web_sessions TO kauro_assurance;
