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
-- Security status (state) is the identity boundary's, never the request handlers' (07 "Aggregate ownership": Identity owns
-- authentication references, verification and security status; 08 "Identity is not permission"; re-check finding N1): the
-- request-handler role records the identity reference it authenticated (first sight, state ACTIVE by default) and the
-- verification facts the token carries, and holds no privilege on `state` at all — a DISABLED row is lifted only by the
-- platform's security operations, never by the role it restricts. A change of `state` takes the transition lock of the
-- identity (D-TX-2): a disable issued while a command of that identity is in flight waits for the command, and a disable
-- committed first is what the authorizer reads.
CREATE TABLE kauro.identities (
  user_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v5(user_id)),
  provider           text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  subject_hash       text NOT NULL CHECK (kauro.is_sha256_hex(subject_hash)),
  state              text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'DISABLED')),
  email_verified_at  timestamptz,
  mfa_enrolled_at    timestamptz,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  UNIQUE (provider, subject_hash)
);
CREATE TRIGGER identities_touch BEFORE UPDATE ON kauro.identities FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER identities_immutable BEFORE UPDATE ON kauro.identities
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('user_id,provider,subject_hash,created_at');
CREATE TRIGGER identities_transition_lock BEFORE UPDATE OF state ON kauro.identities
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.identities', 'user_id');

-- Step-up proofs (08: high-impact actions require recent step-up; freshness is checked by the application against the
-- policy value, the row records what was obtained and when). A proof is evidence produced by the authentication boundary
-- (08 "Authentication and assurance": authentication produces the assurance facts), so only the step-up verifier role
-- (kauro_assurance) writes it; the request handlers (kauro_app) read their own proofs and can never mint one — the gate a
-- proof satisfies (CMD025 step-up) is enforced by the very role it would otherwise be protecting against.
CREATE TABLE kauro.assurance_proofs (
  proof_id        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(proof_id)),
  user_id         uuid NOT NULL REFERENCES kauro.identities (user_id),
  kind            text NOT NULL CHECK (kind IN ('STEP_UP')),
  method          text NOT NULL CHECK (method IN ('TOTP', 'WEBAUTHN', 'IDP_REAUTH')),
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL CHECK (expires_at > issued_at),
  correlation_id  uuid NOT NULL,
  created_at      timestamptz NOT NULL,
  -- binding target: an approval cites a proof of its own actor (approvals FK (actor_id, assurance_proof_ref))
  UNIQUE (user_id, proof_id)
);
CREATE INDEX assurance_proofs_by_user ON kauro.assurance_proofs (user_id, issued_at DESC);
CREATE TRIGGER assurance_proofs_append_only BEFORE UPDATE OR DELETE ON kauro.assurance_proofs
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- --- agencies -------------------------------------------------------------------------------------------------------------
CREATE TABLE kauro.agencies (
  agency_id                    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(agency_id)),
  version                      bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- named: a refusal of a request field's label maps to that field (sqlstate.ts LABEL_CONSTRAINT_FIELDS, re-check finding N6)
  display_name                 text NOT NULL CONSTRAINT agencies_display_name_label CHECK (kauro.is_label(display_name)),
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
CREATE TRIGGER agencies_initial_state BEFORE INSERT ON kauro.agencies
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_initial_state('Agency');
-- the agency state CMD009/CMD011 rely on (DRAFT or ACTIVE) is a transition subject (D-TX-2): a restriction or closure issued
-- while such a command is in flight waits for it, and commands arriving after it wait behind it (re-check finding N3)
CREATE TRIGGER agencies_transition_lock BEFORE UPDATE OF state ON kauro.agencies
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.take_transition_lock('kauro.agencies', 'agency_id');

-- The agency's state and policy acceptance are owner decisions (07 "Aggregate ownership": Agency owns the tenant's legal and
-- commercial identity, active state and policy acceptance; COMMAND_CATALOGUE CMD002 ActivateAgency and CMD043 CloseAgency are
-- AGENCY_OWNER; re-check finding N11: the database carries the role boundary of the ownership aggregates, not only the
-- application): the request-handler role changes them only as the acting session's own ACTIVE OWNER membership of the agency,
-- read after its transition lock (D-TX-2). The owner counter the membership trigger maintains is not a decision and is exempt.
CREATE OR REPLACE FUNCTION kauro.enforce_agency_authority() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  actor uuid := kauro.current_user_id();
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state AND NEW.terms_version IS NOT DISTINCT FROM OLD.terms_version
     AND NEW.privacy_agreement_version IS NOT DISTINCT FROM OLD.privacy_agreement_version AND NEW.legal_profile_ref IS NOT DISTINCT FROM OLD.legal_profile_ref THEN
    RETURN NEW;
  END IF;
  IF actor IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.memberships', OLD.agency_id::text || ':' || actor::text);
  END IF;
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM kauro.memberships m WHERE m.agency_id = OLD.agency_id AND m.user_id = actor AND m.state = 'ACTIVE' AND m.role = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: the state and agreements of agency % are changed only by its OWNER acting as itself', OLD.agency_id USING ERRCODE = 'KA010';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agencies_authority BEFORE UPDATE OF state, terms_version, privacy_agreement_version, legal_profile_ref ON kauro.agencies
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_agency_authority();

-- active_owner_count is written only by kauro.maintain_active_owner_count (D-OWN-1; R2-043; 07 "Application checks improve
-- messages but cannot be the sole protection"). An agency is born with no active owner — the founding owner's membership
-- insert counts it — and no statement a role sends can write the counter: only the UPDATE the membership trigger issues,
-- which runs one trigger level below the statement that changed the membership (pg_trigger_depth() >= 2, a level no client
-- can reach), may change it. The counter is exempt from the version rule for that reason alone; without this guard the runtime
-- role could raise it by hand and then remove the last real owner while the check still counted a phantom one.
CREATE OR REPLACE FUNCTION kauro.guard_active_owner_count() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.active_owner_count <> 0 THEN
      RAISE EXCEPTION 'IMMUTABLE_COLUMN: agency % is born with no active owner; the membership trigger counts owners', NEW.agency_id USING ERRCODE = 'KA004';
    END IF;
  ELSIF NEW.active_owner_count IS DISTINCT FROM OLD.active_owner_count AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: agencies.active_owner_count of % is maintained by the membership trigger only', OLD.agency_id USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agencies_owner_count_guard BEFORE INSERT OR UPDATE ON kauro.agencies
  FOR EACH ROW EXECUTE FUNCTION kauro.guard_active_owner_count();

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Agency', 'DRAFT');
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
  -- binding target: an approval names the acting membership of its own actor (approvals FK (agency_id, actor_membership_id,
  -- actor_id)); 08 "Foreign keys bind tenant and parent identity"
  UNIQUE (agency_id, membership_id, user_id),
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

-- Membership initial state (registry Membership machine: initial INVITED; every later state is reached through a listed edge,
-- INVITED -> ACTIVE being intended_identity_accepts). The one narrow exemption is the founding owner of CreateAgency (CMD001
-- effect "Create one draft agency and owner membership atomically"; decision D-CTX-2): the creator is the intended identity
-- and accepts implicitly, so that single membership is born ACTIVE. It is admitted only when every one of these holds — the
-- row is an ACTIVE OWNER; its identity is the session's own identity and the agency's creator; the agency is DRAFT and counts
-- no active owner yet; and the agency has no membership row at all (the founding membership is the first one). A second
-- owner, an owner for somebody else, a founding ADMIN or a founding membership of an agency that already has members is born
-- INVITED or refused.
CREATE OR REPLACE FUNCTION kauro.enforce_membership_initial_state() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  initial text;
BEGIN
  SELECT m.initial_state INTO initial FROM kauro.state_machines m WHERE m.machine = 'Membership';
  IF initial IS NULL THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: machine Membership has no seeded initial state' USING ERRCODE = 'KA008';
  END IF;
  IF NEW.state = initial THEN
    RETURN NEW;
  END IF;
  IF NEW.state = 'ACTIVE' AND NEW.role = 'OWNER' AND NEW.user_id = kauro.current_user_id()
     AND EXISTS (
       SELECT 1 FROM kauro.agencies a
       WHERE a.agency_id = NEW.agency_id AND a.created_by_user_id = NEW.user_id AND a.state = 'DRAFT' AND a.active_owner_count = 0
     )
     AND NOT EXISTS (SELECT 1 FROM kauro.memberships m WHERE m.agency_id = NEW.agency_id) THEN
    RETURN NEW; -- the founding owner of CreateAgency
  END IF;
  RAISE EXCEPTION 'UNLISTED_TRANSITION: a Membership is born %; its initial state is % (only the founding owner of a new agency is born ACTIVE)', NEW.state, initial USING ERRCODE = 'KA008';
END
$$;
CREATE TRIGGER memberships_initial_state BEFORE INSERT ON kauro.memberships
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_membership_initial_state();

-- The membership write boundary (re-check finding N11; 07 "Application checks improve messages but cannot be the sole
-- protection"; 08 "Granting a capability is itself an owner action with audit evidence", "A service account ... cannot act as a
-- human owner by putting an owner ID in a request"; 07 "Invitation acceptance binds the invited identity and intended agency").
-- Every membership row the request-handler role writes is an act of the acting session (kauro.user_id) under the authority its
-- own ACTIVE membership in that agency holds — the same rules the domain applies (packages/domain membership.ts, D-MEM-1..4):
--   * an invitation (a row born INVITED): an OWNER invites any role, an ADMIN any role but OWNER;
--   * acceptance INVITED -> ACTIVE (intended_identity_accepts): only the invited identity itself, role and assurance policy
--     unchanged, and only once an invitation of that membership with that role has been consumed (CMD004 "Atomically consume
--     the invitation and activate the intended scoped membership");
--   * expiry INVITED -> EXPIRED (invitation_deadline): only once an invitation of the membership has reached its deadline on the
--     server clock (07 "An expired invite cannot be revived by changing a browser timestamp");
--   * a role change (CMD005, AGENCY_OWNER): only an OWNER, and never on an INVITED membership (the invitation is reissued);
--   * every other change — revoking an invitation, suspension, reactivation, revocation, a new assurance policy (CMD006,
--     AGENCY_OWNER_OR_ADMIN): an OWNER, or an ADMIN on a membership that is not and does not become an OWNER (D-MEM-2).
-- The founding owner of CreateAgency is admitted by kauro.enforce_membership_initial_state; the last-owner rule stays with
-- kauro.maintain_active_owner_count. The acting session's membership is read after its transition lock (D-TX-2), so a change of
-- the actor's own authority issued meanwhile is ordered before or after this write. A refusal is KA010 (MEMBERSHIP_AUTHORITY)
-- or KA011 (INVITATION_NOT_OPEN).
CREATE OR REPLACE FUNCTION kauro.enforce_membership_authority() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  actor uuid := kauro.current_user_id();
  actor_role text;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.state IS DISTINCT FROM 'INVITED' THEN
    RETURN NEW; -- only the founding owner is born outside INVITED (enforce_membership_initial_state decides it)
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state AND NEW.role IS NOT DISTINCT FROM OLD.role
     AND NEW.assurance_policy IS NOT DISTINCT FROM OLD.assurance_policy THEN
    RETURN NEW; -- nothing an authority decides changes (the version rule and the event rule still apply)
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'INVITED' AND NEW.state = 'ACTIVE' THEN
    IF actor IS DISTINCT FROM NEW.user_id OR NEW.role IS DISTINCT FROM OLD.role OR NEW.assurance_policy IS DISTINCT FROM OLD.assurance_policy THEN
      RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: membership % is accepted only by its invited identity, as invited', NEW.membership_id USING ERRCODE = 'KA010';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.membership_invitations i
       WHERE i.agency_id = NEW.agency_id AND i.membership_id = NEW.membership_id AND i.role = NEW.role AND i.consumed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'INVITATION_NOT_OPEN: membership % has no consumed invitation for role %', NEW.membership_id, NEW.role USING ERRCODE = 'KA011';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'INVITED' AND NEW.state = 'EXPIRED' THEN
    IF NEW.role IS DISTINCT FROM OLD.role OR NEW.assurance_policy IS DISTINCT FROM OLD.assurance_policy OR NOT EXISTS (
      SELECT 1 FROM kauro.membership_invitations i
       WHERE i.agency_id = NEW.agency_id AND i.membership_id = NEW.membership_id AND i.expires_at <= now()
    ) THEN
      RAISE EXCEPTION 'INVITATION_NOT_OPEN: membership % has no invitation past its deadline', NEW.membership_id USING ERRCODE = 'KA011';
    END IF;
    RETURN NEW;
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: a membership of agency % is changed only by a member acting as itself', NEW.agency_id USING ERRCODE = 'KA010';
  END IF;
  PERFORM kauro.await_transition('kauro.memberships', NEW.agency_id::text || ':' || actor::text);
  SELECT m.role INTO actor_role FROM kauro.memberships m
   WHERE m.agency_id = NEW.agency_id AND m.user_id = actor AND m.state = 'ACTIVE';
  IF TG_OP = 'INSERT' THEN
    IF actor_role = 'OWNER' OR (actor_role = 'ADMIN' AND NEW.role <> 'OWNER') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: the acting session cannot invite a % into agency %', NEW.role, NEW.agency_id USING ERRCODE = 'KA010';
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF actor_role IS DISTINCT FROM 'OWNER' OR OLD.state = 'INVITED' THEN
      RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: the role of membership % is changed only by an OWNER of an accepted membership', NEW.membership_id USING ERRCODE = 'KA010';
    END IF;
    RETURN NEW;
  END IF;
  IF actor_role = 'OWNER' OR (actor_role = 'ADMIN' AND OLD.role <> 'OWNER' AND NEW.role <> 'OWNER') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: the acting session has no team authority over membership %', NEW.membership_id USING ERRCODE = 'KA010';
END
$$;
CREATE TRIGGER memberships_authority BEFORE INSERT OR UPDATE ON kauro.memberships
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_membership_authority();
-- the caller's membership is what every tenant command relies on (D-PIPE-1 step 5): its state and role are a transition
-- subject keyed by agency and person (D-TX-2), so a suspension, revocation or role change issued while a command of that person
-- is in flight waits for it, and one committed first is what the authorizer reads
CREATE TRIGGER memberships_transition_lock BEFORE UPDATE OF state, role ON kauro.memberships
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION kauro.take_transition_lock('kauro.memberships', 'agency_id', 'user_id');

INSERT INTO kauro.state_machines (machine, initial_state) VALUES ('Membership', 'INVITED');
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
-- The membership row (state INVITED) is the invitation; this table holds the hashed single-use token and its envelope
-- (08 "Invitation, recovery and ownership transfer": one-use, time-limited opaque tokens; stored token material is hashed; the
-- invite records agency, intended identity, role and expiry; changing the role after sending invalidates or reissues the invite).
-- The rules below are the database's half of CMD003/CMD004 (re-check finding N19): an invitation is issued for an INVITED
-- membership with exactly that membership's role, by the acting session's own ACTIVE membership with the authority to grant
-- that role (an OWNER any role, an ADMIN any role but OWNER); the membership's role cannot change while it is INVITED
-- (kauro.enforce_membership_authority), so an open invitation always names the role it would enable. An invitation closes
-- once: consumed by the invited identity itself before its deadline and unrevoked, or revoked by team authority; a closed
-- invitation never reopens and its outcome never changes.
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
  CONSTRAINT membership_invitations_one_outcome CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT membership_invitations_expiry_after_issue CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX membership_invitations_one_per_membership ON kauro.membership_invitations (membership_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE TRIGGER membership_invitations_immutable BEFORE UPDATE ON kauro.membership_invitations
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('invitation_id,agency_id,membership_id,token_hash,role,invited_by_membership_id,expires_at,created_at');

CREATE OR REPLACE FUNCTION kauro.enforce_invitation_rules() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  actor uuid := kauro.current_user_id();
  target_role text;
  target_state text;
  target_user uuid;
  inviter_role text;
  actor_role text;
BEGIN
  SELECT m.role, m.state, m.user_id INTO target_role, target_state, target_user FROM kauro.memberships m
   WHERE m.agency_id = NEW.agency_id AND m.membership_id = NEW.membership_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'INVITATION_NOT_OPEN: invitation % is issued open', NEW.invitation_id USING ERRCODE = 'KA011';
    END IF;
    IF target_state IS DISTINCT FROM 'INVITED' OR target_role IS DISTINCT FROM NEW.role THEN
      RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: invitation % must name an INVITED membership with its own role', NEW.invitation_id USING ERRCODE = 'KA010';
    END IF;
    SELECT m.role INTO inviter_role FROM kauro.memberships m
     WHERE m.agency_id = NEW.agency_id AND m.membership_id = NEW.invited_by_membership_id AND m.user_id = actor AND m.state = 'ACTIVE';
    -- coalesce: an absent inviter membership (NULL role) is a refusal, never an unknown that skips the check
    IF NOT coalesce(inviter_role = 'OWNER' OR (inviter_role = 'ADMIN' AND NEW.role <> 'OWNER'), false) THEN
      RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: invitation % is issued by the acting session''s own membership with the authority to grant %', NEW.invitation_id, NEW.role USING ERRCODE = 'KA010';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    IF NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
      RAISE EXCEPTION 'INVITATION_NOT_OPEN: invitation % is closed and its outcome never changes', OLD.invitation_id USING ERRCODE = 'KA011';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.consumed_at IS NOT NULL THEN
    IF actor IS DISTINCT FROM target_user THEN
      RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: invitation % is consumed only by its invited identity', OLD.invitation_id USING ERRCODE = 'KA010';
    END IF;
    IF OLD.expires_at <= now() OR target_state IS DISTINCT FROM 'INVITED' THEN
      RAISE EXCEPTION 'INVITATION_NOT_OPEN: invitation % is past its deadline or its membership is no longer INVITED', OLD.invitation_id USING ERRCODE = 'KA011';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    PERFORM kauro.await_transition('kauro.memberships', NEW.agency_id::text || ':' || coalesce(actor::text, ''));
    SELECT m.role INTO actor_role FROM kauro.memberships m
     WHERE m.agency_id = NEW.agency_id AND m.user_id = actor AND m.state = 'ACTIVE';
    IF NOT coalesce(actor_role = 'OWNER' OR (actor_role = 'ADMIN' AND OLD.role <> 'OWNER'), false) THEN
      RAISE EXCEPTION 'MEMBERSHIP_AUTHORITY: the acting session has no team authority over invitation %', OLD.invitation_id USING ERRCODE = 'KA010';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER membership_invitations_rules BEFORE INSERT OR UPDATE ON kauro.membership_invitations
  FOR EACH ROW EXECUTE FUNCTION kauro.enforce_invitation_rules();

-- --- row-level security ---------------------------------------------------------------------------------------------------
ALTER TABLE kauro.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.identities FORCE ROW LEVEL SECURITY;
-- the caller's own row only; the column grants below leave `state` out of every write the request handlers can make (N1)
CREATE POLICY identities_self_read ON kauro.identities FOR SELECT TO kauro_app
  USING (user_id = kauro.current_user_id());
CREATE POLICY identities_self_insert ON kauro.identities FOR INSERT TO kauro_app
  WITH CHECK (user_id = kauro.current_user_id() AND state = 'ACTIVE');
CREATE POLICY identities_self_sync ON kauro.identities FOR UPDATE TO kauro_app
  USING (user_id = kauro.current_user_id()) WITH CHECK (user_id = kauro.current_user_id());

ALTER TABLE kauro.assurance_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.assurance_proofs FORCE ROW LEVEL SECURITY;
-- a request handler reads the proofs of the identity it serves; the step-up verifier records a proof for the identity whose
-- reauthentication it verified (its context binds that identity) and reads nothing
CREATE POLICY assurance_proofs_self_read ON kauro.assurance_proofs FOR SELECT TO kauro_app
  USING (user_id = kauro.current_user_id());
CREATE POLICY assurance_proofs_verifier ON kauro.assurance_proofs FOR INSERT TO kauro_assurance
  WITH CHECK (user_id = kauro.current_user_id());

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
-- the invited identity finds its own invitation by token without a tenant context (CMD004 AcceptInvitation is VERIFIED_USER
-- with the invitation in the path): the membership it names is the caller's own (memberships_self_read shows it)
CREATE POLICY membership_invitations_invitee_read ON kauro.membership_invitations FOR SELECT TO kauro_app
  USING (EXISTS (
    SELECT 1 FROM kauro.memberships m
    WHERE m.agency_id = membership_invitations.agency_id AND m.membership_id = membership_invitations.membership_id
      AND m.user_id = kauro.current_user_id()
  ));

-- --- grants (no DELETE for request handlers anywhere: deletion is a managed lifecycle, never a request) -----------------------
-- identities: the reference and the token's verification facts, never the security status (N1)
GRANT SELECT ON kauro.identities TO kauro_app;
GRANT INSERT (user_id, provider, subject_hash, email_verified_at, mfa_enrolled_at, created_at, updated_at) ON kauro.identities TO kauro_app;
GRANT UPDATE (email_verified_at, mfa_enrolled_at, updated_at) ON kauro.identities TO kauro_app;
GRANT SELECT, INSERT, UPDATE ON kauro.agencies, kauro.memberships TO kauro_app;
-- an invitation's envelope is immutable; the request handlers only close it (consume or revoke) once
GRANT SELECT, INSERT ON kauro.membership_invitations TO kauro_app;
GRANT UPDATE (consumed_at, revoked_at) ON kauro.membership_invitations TO kauro_app;
GRANT SELECT ON kauro.assurance_proofs TO kauro_app;
GRANT INSERT ON kauro.assurance_proofs TO kauro_assurance;
