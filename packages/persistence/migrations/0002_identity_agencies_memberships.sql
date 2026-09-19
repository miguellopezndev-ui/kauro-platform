-- 0002 — identities, assurance proofs, agencies, memberships, invitations.
--
-- Authority: 07 "Aggregate ownership" (Identity owns authentication references, verification and security status; Agency
-- owns tenant identity, state and policy acceptance; Membership owns role, invitation and revocation), 07 "Agency and
-- membership states" (the last active owner cannot remove their own ownership without a successor or the closure
-- procedure; concurrent owner removals lock or otherwise serialize the ownership invariant), 08 "Authentication and
-- assurance", 08 "Invitation, recovery and ownership transfer" (one-use time-limited tokens, stored hashed),
-- 08 "Database isolation" (RLS USING and WITH CHECK, FORCE ROW LEVEL SECURITY, composite foreign keys),
-- registry contracts Agency, Membership; registry machines Agency, Membership.

-- --- identities ---------------------------------------------------------------------------------------------------------
-- The identity reference of an authenticated person. user_id is UUIDv5(provider, subject) minted by the server
-- (@kauro/domain identityUserId); the raw provider subject never enters the database, only its digest.
CREATE TABLE kauro.identities (
  user_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v5(user_id)),
  provider           text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  subject_hash       text NOT NULL CHECK (kauro.is_sha256_hex(subject_hash)),
  state              text NOT NULL CHECK (state IN ('ACTIVE', 'DISABLED')),
  email_verified_at  timestamptz,
  mfa_enrolled_at    timestamptz,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  UNIQUE (provider, subject_hash)
);
CREATE TRIGGER identities_touch BEFORE UPDATE ON kauro.identities FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER identities_immutable BEFORE UPDATE ON kauro.identities
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('user_id,provider,subject_hash,created_at');

-- Step-up proofs (08: high-impact actions require recent step-up; freshness is checked by the application against the
-- policy value, the row records what was obtained and when).
CREATE TABLE kauro.assurance_proofs (
  proof_id        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(proof_id)),
  user_id         uuid NOT NULL REFERENCES kauro.identities (user_id),
  kind            text NOT NULL CHECK (kind IN ('STEP_UP')),
  method          text NOT NULL CHECK (method IN ('TOTP', 'WEBAUTHN', 'IDP_REAUTH')),
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL CHECK (expires_at > issued_at),
  correlation_id  uuid NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX assurance_proofs_by_user ON kauro.assurance_proofs (user_id, issued_at DESC);
CREATE TRIGGER assurance_proofs_append_only BEFORE UPDATE OR DELETE ON kauro.assurance_proofs
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- agencies -------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.agencies (
  agency_id                    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(agency_id)),
  version                      bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  display_name                 text NOT NULL CHECK (kauro.is_label(display_name)),
  state                        text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT', 'ACTIVE', 'RESTRICTED', 'CLOSING', 'CLOSED')),
  legal_profile_ref            uuid,
  terms_version                text CHECK (terms_version IS NULL OR kauro.is_label(terms_version)),
  privacy_agreement_version    text CHECK (privacy_agreement_version IS NULL OR kauro.is_label(privacy_agreement_version)),
  first_qualifying_capture_id  uuid,
  created_by_user_id           uuid NOT NULL REFERENCES kauro.identities (user_id),
  -- maintained by kauro.maintain_active_owner_count; the row lock taken by its UPDATE serializes owner removals (R2-043)
  active_owner_count           integer NOT NULL DEFAULT 0 CHECK (active_owner_count >= 0),
  created_at                   timestamptz NOT NULL,
  updated_at                   timestamptz NOT NULL,
  -- Agency machine DRAFT -> ACTIVE guard: legal/billing profile and required agreement versions are present.
  CONSTRAINT agencies_activation_requires_agreements CHECK (
    state NOT IN ('ACTIVE', 'RESTRICTED')
    OR (terms_version IS NOT NULL AND privacy_agreement_version IS NOT NULL AND legal_profile_ref IS NOT NULL)
  )
);
-- D-CMD-1: one DRAFT agency per creating identity; the structural half of the creation abuse limit (08 "Abuse controls":
-- a user cannot obtain a second tenant by retrying) and the race closer for two different-key creations.
CREATE UNIQUE INDEX agencies_one_draft_per_creator ON kauro.agencies (created_by_user_id) WHERE state = 'DRAFT';
CREATE INDEX agencies_by_creator ON kauro.agencies (created_by_user_id, created_at);

CREATE TRIGGER agencies_touch BEFORE UPDATE ON kauro.agencies FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER agencies_version BEFORE UPDATE ON kauro.agencies
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump('active_owner_count');
CREATE TRIGGER agencies_immutable BEFORE UPDATE ON kauro.agencies
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('agency_id,created_by_user_id,created_at');
CREATE TRIGGER agencies_transition BEFORE UPDATE OF state ON kauro.agencies
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Agency');

INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Agency', 'DRAFT', 'ACTIVE'),
  ('Agency', 'ACTIVE', 'RESTRICTED'),
  ('Agency', 'RESTRICTED', 'ACTIVE'),
  ('Agency', 'ACTIVE', 'CLOSING'),
  ('Agency', 'RESTRICTED', 'CLOSING'),
  ('Agency', 'DRAFT', 'CLOSING'),
  ('Agency', 'CLOSING', 'CLOSED');

-- --- memberships ------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.memberships (
  membership_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(membership_id)),
  agency_id         uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  user_id           uuid NOT NULL REFERENCES kauro.identities (user_id),
  role              text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'OPERATOR', 'APPROVER', 'VIEWER', 'BILLING')),
  state             text NOT NULL CHECK (state IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED')),
  version           bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  assurance_policy  text NOT NULL CHECK (kauro.is_label(assurance_policy)),
  accepted_at       timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  UNIQUE (agency_id, membership_id),
  CONSTRAINT memberships_active_requires_acceptance CHECK (state NOT IN ('ACTIVE', 'SUSPENDED') OR accepted_at IS NOT NULL),
  CONSTRAINT memberships_revoked_requires_time CHECK ((state = 'REVOKED') = (revoked_at IS NOT NULL))
);
-- one live membership per person per agency (INVITED, ACTIVE or SUSPENDED); revoked/expired rows keep history
CREATE UNIQUE INDEX memberships_one_live_per_user ON kauro.memberships (agency_id, user_id)
  WHERE state IN ('INVITED', 'ACTIVE', 'SUSPENDED');
CREATE INDEX memberships_by_user ON kauro.memberships (user_id, state);
CREATE INDEX memberships_owners ON kauro.memberships (agency_id) WHERE role = 'OWNER' AND state = 'ACTIVE';

CREATE TRIGGER memberships_touch BEFORE UPDATE ON kauro.memberships FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER memberships_version BEFORE UPDATE ON kauro.memberships FOR EACH ROW EXECUTE FUNCTION kauro.enforce_version_bump();
CREATE TRIGGER memberships_immutable BEFORE UPDATE ON kauro.memberships
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('membership_id,agency_id,user_id,created_at');
CREATE TRIGGER memberships_transition BEFORE UPDATE OF state ON kauro.memberships
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_listed_transition('Membership');

INSERT INTO kauro.state_transitions (machine, from_state, to_state) VALUES
  ('Membership', 'INVITED', 'ACTIVE'),
  ('Membership', 'INVITED', 'EXPIRED'),
  ('Membership', 'INVITED', 'REVOKED'),
  ('Membership', 'ACTIVE', 'SUSPENDED'),
  ('Membership', 'SUSPENDED', 'ACTIVE'),
  ('Membership', 'ACTIVE', 'REVOKED'),
  ('Membership', 'SUSPENDED', 'REVOKED');

-- Last-owner protection (07 "Agency and membership states"; R2-043). The trigger applies the delta of "is an active owner"
-- to agencies.active_owner_count. That UPDATE takes the agency row lock, so two concurrent removals serialize: the second
-- re-reads the committed count and is refused with KA001 when no active owner would remain outside the closure procedure.
CREATE OR REPLACE FUNCTION kauro.maintain_active_owner_count() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  delta        integer := 0;
  remaining    integer;
  agency_state text;
  target       uuid := coalesce(NEW.agency_id, OLD.agency_id);
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.role = 'OWNER' AND OLD.state = 'ACTIVE' THEN delta := delta - 1; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.role = 'OWNER' AND NEW.state = 'ACTIVE' THEN delta := delta + 1; END IF;
  IF delta = 0 THEN RETURN NULL; END IF;
  UPDATE kauro.agencies
     SET active_owner_count = active_owner_count + delta
   WHERE agency_id = target
   RETURNING active_owner_count, state INTO remaining, agency_state;
  IF remaining IS NULL THEN
    RAISE EXCEPTION 'CONTEXT: agency % is not visible in this transaction', target USING ERRCODE = 'KA006';
  END IF;
  IF delta < 0 AND remaining < 1 AND agency_state NOT IN ('CLOSING', 'CLOSED') THEN
    RAISE EXCEPTION 'LAST_OWNER_PROTECTED: agency % would keep no active owner', target USING ERRCODE = 'KA001';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER memberships_owner_count AFTER INSERT OR UPDATE OR DELETE ON kauro.memberships
  FOR EACH ROW EXECUTE FUNCTION kauro.maintain_active_owner_count();

-- --- invitations ----------------------------------------------------------------------------------------------------------
-- The membership row (state INVITED) is the invitation; this table holds the hashed single-use token and its envelope.
CREATE TABLE kauro.membership_invitations (
  invitation_id             uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(invitation_id)),
  agency_id                 uuid NOT NULL,
  membership_id             uuid NOT NULL,
  token_hash                text NOT NULL UNIQUE CHECK (kauro.is_sha256_hex(token_hash)),
  role                      text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'OPERATOR', 'APPROVER', 'VIEWER', 'BILLING')),
  invited_by_membership_id  uuid NOT NULL,
  expires_at                timestamptz NOT NULL,
  consumed_at               timestamptz,
  revoked_at                timestamptz,
  created_at                timestamptz NOT NULL,
  FOREIGN KEY (agency_id, membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  FOREIGN KEY (agency_id, invited_by_membership_id) REFERENCES kauro.memberships (agency_id, membership_id),
  CONSTRAINT membership_invitations_one_outcome CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX membership_invitations_one_per_membership ON kauro.membership_invitations (membership_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE TRIGGER membership_invitations_immutable BEFORE UPDATE ON kauro.membership_invitations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('invitation_id,agency_id,membership_id,token_hash,role,invited_by_membership_id,expires_at,created_at');

-- --- row-level security ---------------------------------------------------------------------------------------------------
ALTER TABLE kauro.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.identities FORCE ROW LEVEL SECURITY;
CREATE POLICY identities_self ON kauro.identities FOR ALL TO kauro_app
  USING (user_id = kauro.current_user_id()) WITH CHECK (user_id = kauro.current_user_id());

ALTER TABLE kauro.assurance_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.assurance_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY assurance_proofs_self ON kauro.assurance_proofs FOR ALL TO kauro_app
  USING (user_id = kauro.current_user_id()) WITH CHECK (user_id = kauro.current_user_id());

ALTER TABLE kauro.agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.agencies FORCE ROW LEVEL SECURITY;
CREATE POLICY agencies_tenant ON kauro.agencies FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
-- GET /agencies lists only actual memberships (10): a caller sees the agencies where they hold a live membership.
CREATE POLICY agencies_member_read ON kauro.agencies FOR SELECT TO kauro_app
  USING (EXISTS (
    SELECT 1 FROM kauro.memberships m
    WHERE m.agency_id = agencies.agency_id AND m.user_id = kauro.current_user_id() AND m.state IN ('ACTIVE', 'SUSPENDED')
  ));

ALTER TABLE kauro.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant ON kauro.memberships FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
-- a person always sees their own memberships (that is how the server derives membership; 08 TenantScope invariant)
CREATE POLICY memberships_self_read ON kauro.memberships FOR SELECT TO kauro_app
  USING (user_id = kauro.current_user_id());

ALTER TABLE kauro.membership_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.membership_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_invitations_tenant ON kauro.membership_invitations FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());

-- --- grants (no DELETE for request handlers anywhere: deletion is a managed lifecycle, never a request) -----------------------
GRANT SELECT, INSERT, UPDATE ON kauro.identities, kauro.agencies, kauro.memberships, kauro.membership_invitations TO kauro_app;
GRANT SELECT, INSERT ON kauro.assurance_proofs TO kauro_app;
