-- 0020 — the B07 package-close re-check (finding B07-R1, PARTIALLY_FIXED at 6b670e3): the provider hold that binds a seal's accepted
-- generations from its observation through its commit and for the retention of the sealed bytes.
--
-- Authority: 09 "Storage zones and object registry" (generation preconditions prevent overwrite), 09 "Accepted immutability and
-- sealing" (ACCEPTED contains immutable admitted source generations; SealRevision records the accepted object references), 09 "Soft
-- delete, versioning and holds" (a hold requires authority, reason, applicable scope, start, expiry, review owner and permitted
-- access; retention locks are not enabled casually because they can prevent lawful early deletion), 07 "Transaction discipline" (no
-- transaction spans an external call; application checks cannot be the sole protection), S053 and CMD017 ("a changed generation ...
-- leaves no executable sealed revision"). Design: docs/design/B07-upload-source-lifecycle.md D-HOLD-1..D-HOLD-3, §11 CMD017, §12.5.
--
-- Before its unit of work, SealRevision places a TEMPORARY hold (Cloud Storage objects.patch {temporaryHold: true} with
-- ifGenerationMatch) on the exact accepted generation of every included file, through ObjectStoragePort; while held, the provider
-- refuses to replace or delete that generation, so the generation the seal commits is the one the provider still holds. The hold is a
-- provider effect across a transaction boundary, so it is recorded like one (the intent before the call, D-RUN-2's discipline):
--
--   INTENDED   recorded before the provider call, by the seal's request handler, bounded: attempt_expires_at = intended_at + 900 s;
--   SEALED     in the seal's own transaction, once its sealed file set names the file at that generation (before the bound);
--   CLOSED     the attempt ended without sealing: REFUSED by the request handler that placed it (a refused or failed seal), or
--              ABANDONED by the control plane once its bound passed (a crash between the hold and the commit);
--   RELEASING  the provider release is decided — only when nothing needs the hold any more (no attempt of the object is INTENDED, and
--              no seal retains it: its file's admission ended), and while any row of the object is RELEASING no new hold is intended;
--   RELEASED   the provider answered (RELEASED, or ABSENT: that generation is not live any more).
--
-- An intent and a release decision of the same object serialize on the object's hold lock (a transaction-level advisory lock the guard
-- itself takes, so no writer can skip it), and each reads the other's committed result: no release is decided while an attempt is
-- INTENDED (its placement may still land) or a seal retains the hold. A seal and a close change one row under its row lock and need no
-- object lock: a seal's hold is INTENDED (committed) until its own transaction commits, which already keeps every release decision
-- away. A hold is a flag on the provider's generation, not a count: one release covers every row of the object, and it is refused
-- while any holder still needs it. Rows are never deleted: they are the evidence of what was held, for whom, why, from when and until
-- when.
--
-- The release (the second re-check of B07-R1, PARTIALLY_FIXED at 77d5fa6: several callers could carry out the same release, one
-- answer recorded them all, and a delayed older release then cleared a newer seal's hold — the provider's hold is a flag with no
-- incarnation, and no database fence reaches a provider call):
--
--   CLAIMED    a decided release is carried out by exactly one caller: kauro.object_hold_releases records its claim (release_id, the
--              fence token; the object's claims numbered 1, 2, …) with a bound (claim_expires_at = claimed_at + 900 s) before which
--              the claimant issues its provider call, bounded by the provider call timeout; no second claim of the object is taken
--              while one is live, and a lapsed, unanswered claim is claimed again by the next caller (a new token);
--   ANSWERED   only the object's latest claim is answered, once, by its claimant, and in the same transaction every RELEASING hold of
--              the object is RELEASED naming that claim (released_by) — a superseded claimant's answer is refused (KA071);
--   IN FLIGHT  a provider call cannot be fenced by the database, so a claim may still land at the provider until it is answered or
--              until in_flight_until = claim_expires_at + 10 s (PROVIDER_CALL_TIMEOUT_MS): no hold of the object is intended before
--              then (KA071), so no earlier release can clear a hold placed after the intent.
--
-- After its commit the seal re-asserts every sealed hold at the provider (the idempotent placement under the generation precondition,
-- then a re-observation of the generation and its hold flag; a hold missing on the live generation is placed again) and records what it
-- found in kauro.object_hold_reassertions (HELD, or GENERATION_NOT_LIVE); OBJECT_INVENTORY re-asserts a sealed hold whose re-assertion
-- was never recorded past the attempt bound, or found the generation not live, and hands a generation that is not live to its
-- revocation (GENERATION_CHANGED, GENERATION_MISSING) — never a silent success.

-- the binding target: a hold names exactly the file's accepted object at its accepted generation, in the file's project
ALTER TABLE kauro.source_files ADD CONSTRAINT source_files_accepted_generation UNIQUE (agency_id, project_id, file_id, accepted_object_id, provider_generation);

-- the release claims (decision D-HOLD-3): one row per claim, in claim order per object, answered at most once
CREATE TABLE kauro.object_hold_releases (
  -- the fence token: only the caller that recorded this claim carries the release out and records its answer
  release_id        uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(release_id)),
  agency_id         uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  object_id         uuid NOT NULL,
  generation        text NOT NULL CHECK (kauro.is_generation(generation)),
  -- 1, 2, … per object: the latest claim is the only one that may be answered
  sequence          integer NOT NULL CHECK (sequence >= 1),
  claimed_at        timestamptz NOT NULL,
  -- the claimant issues its provider call before it (HOLD_RELEASE_CLAIM_SECONDS); another caller may claim the release after it
  claim_expires_at  timestamptz NOT NULL,
  -- no provider call of this claim can land after it (the claim's bound + PROVIDER_CALL_TIMEOUT_MS): the intent guard waits for it
  in_flight_until   timestamptz NOT NULL,
  answered_at       timestamptz,
  release_result    text CHECK (release_result IS NULL OR release_result IN ('RELEASED', 'ABSENT')),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  UNIQUE (object_id, sequence),
  FOREIGN KEY (agency_id, object_id, generation) REFERENCES kauro.stored_objects (agency_id, object_id, generation),
  CONSTRAINT object_hold_releases_claim_bound CHECK (claim_expires_at = claimed_at + interval '900 seconds'),
  CONSTRAINT object_hold_releases_in_flight_bound CHECK (in_flight_until = claim_expires_at + interval '10 seconds'),
  CONSTRAINT object_hold_releases_answer CHECK ((answered_at IS NULL) = (release_result IS NULL))
);
CREATE INDEX object_hold_releases_unanswered ON kauro.object_hold_releases (object_id, in_flight_until) WHERE answered_at IS NULL;
CREATE TRIGGER object_hold_releases_touch BEFORE UPDATE ON kauro.object_hold_releases FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER object_hold_releases_immutable BEFORE UPDATE ON kauro.object_hold_releases
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('release_id,agency_id,object_id,generation,sequence,claimed_at,claim_expires_at,in_flight_until,created_at');
CREATE TRIGGER object_hold_releases_append_only BEFORE DELETE ON kauro.object_hold_releases FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE TABLE kauro.object_holds (
  hold_id               uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(hold_id)),
  -- one seal attempt (one request's execution) places the holds of every included file under one attempt id
  attempt_id            uuid NOT NULL CHECK (kauro.is_uuid_v7(attempt_id)),
  agency_id             uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  project_id            uuid NOT NULL,
  -- the revision whose seal placed the hold (authority: CMD017 of that revision)
  revision_id           uuid NOT NULL,
  file_id               uuid NOT NULL,
  object_id             uuid NOT NULL,
  generation            text NOT NULL CHECK (kauro.is_generation(generation)),
  -- a temporary hold, never an event-based one: it does not interact with a bucket retention policy (decision D-HOLD-1)
  hold_kind             text NOT NULL CHECK (hold_kind = 'TEMPORARY'),
  reason                text NOT NULL CHECK (reason = 'SEAL_INTEGRITY'),
  -- the acting person whose seal placed it (the request handler's current user)
  placed_by_user_id     uuid NOT NULL,
  state                 text NOT NULL CHECK (state IN ('INTENDED', 'SEALED', 'CLOSED', 'RELEASING', 'RELEASED')),
  intended_at           timestamptz NOT NULL,
  attempt_expires_at    timestamptz NOT NULL,
  sealed_at             timestamptz,
  closed_at             timestamptz,
  close_reason          text CHECK (close_reason IS NULL OR close_reason IN ('REFUSED', 'ABANDONED')),
  release_requested_at  timestamptz,
  released_at           timestamptz,
  release_result        text CHECK (release_result IS NULL OR release_result IN ('RELEASED', 'ABSENT')),
  -- the release claim whose claimant recorded the provider's answer (D-HOLD-3)
  released_by           uuid REFERENCES kauro.object_hold_releases (release_id),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  UNIQUE (attempt_id, object_id),
  -- the revision is bound by the intent guard (READY_TO_SEAL, same agency and project) and by the SEALED edge (its sealed file set),
  -- not by a foreign key: a seal in flight holds its revision row FOR UPDATE (it writes manifest_hash, a key column), and the key check
  -- of a concurrent attempt's intent would wait on that row for the whole seal instead of on the revision lock its own unit of work takes
  FOREIGN KEY (agency_id, project_id, file_id, object_id, generation) REFERENCES kauro.source_files (agency_id, project_id, file_id, accepted_object_id, provider_generation),
  FOREIGN KEY (agency_id, object_id, generation) REFERENCES kauro.stored_objects (agency_id, object_id, generation),
  -- the attempt's bound (decision D-HOLD-2: longer than a seal's provider calls and unit of work, far shorter than any retention)
  CONSTRAINT object_holds_attempt_bound CHECK (attempt_expires_at = intended_at + interval '900 seconds'),
  CONSTRAINT object_holds_sealed_fact CHECK (state <> 'SEALED' OR sealed_at IS NOT NULL),
  CONSTRAINT object_holds_closed_fact CHECK ((closed_at IS NULL) = (close_reason IS NULL) AND (state <> 'CLOSED' OR closed_at IS NOT NULL)),
  CONSTRAINT object_holds_sealed_or_closed CHECK (sealed_at IS NULL OR closed_at IS NULL),
  CONSTRAINT object_holds_release_requested CHECK (state NOT IN ('RELEASING', 'RELEASED') OR release_requested_at IS NOT NULL),
  CONSTRAINT object_holds_released_fact CHECK ((state = 'RELEASED') = (released_at IS NOT NULL AND release_result IS NOT NULL AND released_by IS NOT NULL))
);
CREATE INDEX object_holds_by_object ON kauro.object_holds (object_id, state);
CREATE INDEX object_holds_by_attempt ON kauro.object_holds (attempt_id);
CREATE INDEX object_holds_open_attempts ON kauro.object_holds (attempt_expires_at) WHERE state = 'INTENDED';
CREATE INDEX object_holds_releasable ON kauro.object_holds (state, object_id) WHERE state IN ('SEALED', 'CLOSED', 'RELEASING');
CREATE TRIGGER object_holds_touch BEFORE UPDATE ON kauro.object_holds FOR EACH ROW EXECUTE FUNCTION kauro.touch_updated_at();
CREATE TRIGGER object_holds_immutable BEFORE UPDATE ON kauro.object_holds
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('hold_id,attempt_id,agency_id,project_id,revision_id,file_id,object_id,generation,hold_kind,reason,placed_by_user_id,intended_at,attempt_expires_at,created_at');
CREATE TRIGGER object_holds_append_only BEFORE DELETE ON kauro.object_holds FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

-- the object's hold lock: an intent and a release decision of one object's holds are ordered on it (the guards take it themselves)
CREATE OR REPLACE FUNCTION kauro.lock_object_holds(object uuid) RETURNS void
  LANGUAGE sql VOLATILE STRICT SET search_path = pg_catalog AS
$$ SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.object_holds', object::text)) $$;

-- Whether the provider hold of an object is still needed (read after the object's hold lock): an attempt of it is INTENDED (its
-- placement may still land), or a seal retains it (a SEALED row while its file's admission stands — the admission ends with the
-- bytes' retention, D-RET-3, or with the generation itself).
CREATE OR REPLACE FUNCTION kauro.object_hold_needed(object uuid) RETURNS boolean
  LANGUAGE sql STABLE STRICT SET search_path = pg_catalog AS
$$
  SELECT EXISTS (SELECT 1 FROM kauro.object_holds h WHERE h.object_id = object AND h.state = 'INTENDED')
      OR EXISTS (
           SELECT 1 FROM kauro.object_holds h JOIN kauro.source_files f ON f.agency_id = h.agency_id AND f.file_id = h.file_id
            WHERE h.object_id = object AND h.state = 'SEALED' AND f.state = 'ADMITTED'
         )
$$;

-- the intent: born INTENDED at the server's instant, for an ADMITTED file of a READY_TO_SEAL revision whose accepted object is not
-- being deleted, and never while a release of the object may still land at the provider (it would undo the placement): a hold of it
-- RELEASING, or a claim of it neither answered nor past its in_flight_until (D-HOLD-3)
CREATE OR REPLACE FUNCTION kauro.object_holds_intent_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.lock_object_holds(NEW.object_id);
  IF NEW.state <> 'INTENDED' THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: an object hold is born INTENDED, not %', NEW.state USING ERRCODE = 'KA008';
  END IF;
  IF NEW.intended_at IS DISTINCT FROM kauro.server_now() THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the hold % is intended at the server''s transaction time', NEW.hold_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.sealed_at IS NOT NULL OR NEW.closed_at IS NOT NULL OR NEW.release_requested_at IS NOT NULL OR NEW.released_at IS NOT NULL OR NEW.release_result IS NOT NULL THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: an intended hold records no later fact' USING ERRCODE = 'KA072';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.source_files f WHERE f.agency_id = NEW.agency_id AND f.file_id = NEW.file_id AND f.state = 'ADMITTED') THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the hold % names file % whose admission does not stand', NEW.hold_id, NEW.file_id USING ERRCODE = 'KA072';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.stored_objects o WHERE o.agency_id = NEW.agency_id AND o.object_id = NEW.object_id AND o.zone = 'ACCEPTED' AND o.state IN ('PRESENT', 'VERIFIED')) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the hold % names object % that is not a present accepted generation', NEW.hold_id, NEW.object_id USING ERRCODE = 'KA072';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.dataset_revisions r WHERE r.agency_id = NEW.agency_id AND r.project_id = NEW.project_id AND r.revision_id = NEW.revision_id AND r.state = 'READY_TO_SEAL') THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the hold % names revision % that is not ready to seal', NEW.hold_id, NEW.revision_id USING ERRCODE = 'KA072';
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.object_holds h WHERE h.object_id = NEW.object_id AND h.state = 'RELEASING') THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: a release of the holds of object % is being carried out', NEW.object_id USING ERRCODE = 'KA071';
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.object_hold_releases r WHERE r.object_id = NEW.object_id AND r.answered_at IS NULL AND r.in_flight_until > kauro.server_now()) THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: a release of the hold of object % may still land at the provider', NEW.object_id USING ERRCODE = 'KA071';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER object_holds_intent_guard BEFORE INSERT ON kauro.object_holds FOR EACH ROW EXECUTE FUNCTION kauro.object_holds_intent_guard();

-- the listed edges and the facts each records once, at the server's instant; a release decision after the object's hold lock
CREATE OR REPLACE FUNCTION kauro.object_holds_transition_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at)
     OR (OLD.closed_at IS NOT NULL AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.close_reason IS DISTINCT FROM OLD.close_reason))
     OR (OLD.release_requested_at IS NOT NULL AND NEW.release_requested_at IS DISTINCT FROM OLD.release_requested_at)
     OR (OLD.released_at IS NOT NULL AND (NEW.released_at IS DISTINCT FROM OLD.released_at OR NEW.release_result IS DISTINCT FROM OLD.release_result OR NEW.released_by IS DISTINCT FROM OLD.released_by)) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: the facts of hold % are set once', OLD.hold_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  IF NOT ((OLD.state = 'INTENDED' AND NEW.state IN ('SEALED', 'CLOSED'))
          OR (OLD.state IN ('SEALED', 'CLOSED') AND NEW.state = 'RELEASING')
          OR (OLD.state = 'RELEASING' AND NEW.state = 'RELEASED')) THEN
    RAISE EXCEPTION 'UNLISTED_TRANSITION: ObjectHold % -> % is not a listed edge', OLD.state, NEW.state USING ERRCODE = 'KA008';
  END IF;
  IF NEW.state = 'SEALED' THEN
    -- the seal that commits it: its sealed file set names this file at this generation (bound at COMMIT to the seal, D-SEAL-1),
    -- and the attempt is within its bound (after it, the control plane may have abandoned and released it)
    IF NEW.sealed_at IS DISTINCT FROM kauro.server_now() THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: hold % is sealed at the server''s transaction time', OLD.hold_id USING ERRCODE = 'KA072';
    END IF;
    IF kauro.server_now() >= OLD.attempt_expires_at THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: hold % is past its attempt bound', OLD.hold_id USING ERRCODE = 'KA072';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM kauro.sealed_revision_files s
       WHERE s.agency_id = OLD.agency_id AND s.revision_id = OLD.revision_id AND s.file_id = OLD.file_id AND s.disposition = 'INCLUDED' AND s.provider_generation = OLD.generation
    ) THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: hold % is sealed only with a sealed file set that includes its generation', OLD.hold_id USING ERRCODE = 'KA072';
    END IF;
  ELSIF NEW.state = 'CLOSED' THEN
    IF NEW.closed_at IS DISTINCT FROM kauro.server_now() OR NEW.close_reason IS NULL THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: hold % is closed at the server''s transaction time with a reason', OLD.hold_id USING ERRCODE = 'KA072';
    END IF;
    IF NEW.close_reason = 'ABANDONED' AND kauro.server_now() < OLD.attempt_expires_at THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: hold % is abandoned only once its attempt bound passed', OLD.hold_id USING ERRCODE = 'KA072';
    END IF;
  ELSIF NEW.state = 'RELEASING' THEN
    IF NEW.release_requested_at IS DISTINCT FROM kauro.server_now() THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: the release of hold % is requested at the server''s transaction time', OLD.hold_id USING ERRCODE = 'KA072';
    END IF;
    PERFORM kauro.lock_object_holds(OLD.object_id);
    IF kauro.object_hold_needed(OLD.object_id) THEN
      RAISE EXCEPTION 'FENCE_DISCIPLINE: the hold of object % is still needed (an attempt in flight or a seal retaining it)', OLD.object_id USING ERRCODE = 'KA071';
    END IF;
  ELSIF NEW.state = 'RELEASED' THEN
    IF NEW.released_at IS DISTINCT FROM kauro.server_now() OR NEW.release_result IS NULL THEN
      RAISE EXCEPTION 'LIFECYCLE_BINDING: the release of hold % is recorded at the server''s transaction time with the provider''s answer', OLD.hold_id USING ERRCODE = 'KA072';
    END IF;
    -- only under the claim its claimant answered in this very transaction, with this answer (the claim's own guard answers only the
    -- object's latest claim, once): a caller that holds no claim, or a superseded one, records nothing (D-HOLD-3)
    IF NOT EXISTS (
      SELECT 1 FROM kauro.object_hold_releases r
       WHERE r.release_id = NEW.released_by AND r.agency_id = OLD.agency_id AND r.object_id = OLD.object_id AND r.generation = OLD.generation
         AND r.answered_at = kauro.server_now() AND r.release_result = NEW.release_result
    ) THEN
      RAISE EXCEPTION 'FENCE_DISCIPLINE: hold % is released only under the claim of its release answered in this transaction', OLD.hold_id USING ERRCODE = 'KA071';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER object_holds_transition_guard BEFORE UPDATE ON kauro.object_holds FOR EACH ROW EXECUTE FUNCTION kauro.object_holds_transition_guard();

-- a claim: taken at the server's instant after the object's hold lock, only for a decided release (a hold of the object RELEASING at
-- that generation), numbered next in the object's order, and never while another claim of the object is live (exactly one caller)
CREATE OR REPLACE FUNCTION kauro.object_hold_releases_claim_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.lock_object_holds(NEW.object_id);
  IF NEW.claimed_at IS DISTINCT FROM kauro.server_now() THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the release claim % is taken at the server''s transaction time', NEW.release_id USING ERRCODE = 'KA072';
  END IF;
  IF NEW.answered_at IS NOT NULL OR NEW.release_result IS NOT NULL THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: a release claim is born unanswered' USING ERRCODE = 'KA072';
  END IF;
  IF NEW.sequence IS DISTINCT FROM (SELECT coalesce(max(r.sequence), 0) + 1 FROM kauro.object_hold_releases r WHERE r.object_id = NEW.object_id) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the release claims of object % are numbered in claim order', NEW.object_id USING ERRCODE = 'KA072';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM kauro.object_holds h WHERE h.agency_id = NEW.agency_id AND h.object_id = NEW.object_id AND h.generation = NEW.generation AND h.state = 'RELEASING') THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: a release of object % is claimed only once it is decided', NEW.object_id USING ERRCODE = 'KA072';
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.object_hold_releases r WHERE r.object_id = NEW.object_id AND r.answered_at IS NULL AND r.claim_expires_at > kauro.server_now()) THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: the release of object % is claimed by another caller', NEW.object_id USING ERRCODE = 'KA071';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER object_hold_releases_claim_guard BEFORE INSERT ON kauro.object_hold_releases FOR EACH ROW EXECUTE FUNCTION kauro.object_hold_releases_claim_guard();

-- an answer: set once, at the server's instant, after the object's hold lock, and only on the object's latest claim — the claimant's
-- (a superseded claim's answer is refused: its caller no longer holds the release)
CREATE OR REPLACE FUNCTION kauro.object_hold_releases_answer_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.answered_at IS NOT NULL AND (NEW.answered_at IS DISTINCT FROM OLD.answered_at OR NEW.release_result IS DISTINCT FROM OLD.release_result) THEN
    RAISE EXCEPTION 'IMMUTABLE_COLUMN: the answer of release claim % is set once', OLD.release_id USING ERRCODE = 'KA004';
  END IF;
  IF NEW.answered_at IS NOT DISTINCT FROM OLD.answered_at AND NEW.release_result IS NOT DISTINCT FROM OLD.release_result THEN
    RETURN NEW;
  END IF;
  PERFORM kauro.lock_object_holds(OLD.object_id);
  IF NEW.answered_at IS DISTINCT FROM kauro.server_now() OR NEW.release_result IS NULL THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: release claim % is answered at the server''s transaction time with the provider''s answer', OLD.release_id USING ERRCODE = 'KA072';
  END IF;
  IF EXISTS (SELECT 1 FROM kauro.object_hold_releases r WHERE r.object_id = OLD.object_id AND r.sequence > OLD.sequence) THEN
    RAISE EXCEPTION 'FENCE_DISCIPLINE: release claim % was superseded by a later claim of object %', OLD.release_id, OLD.object_id USING ERRCODE = 'KA071';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER object_hold_releases_answer_guard BEFORE UPDATE ON kauro.object_hold_releases FOR EACH ROW EXECUTE FUNCTION kauro.object_hold_releases_answer_guard();

-- the re-assertions of sealed holds (decision D-HOLD-2): append-only evidence, each of a SEALED hold at its own generation
CREATE TABLE kauro.object_hold_reassertions (
  reassertion_id  uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(reassertion_id)),
  hold_id         uuid NOT NULL REFERENCES kauro.object_holds (hold_id),
  agency_id       uuid NOT NULL REFERENCES kauro.agencies (agency_id),
  object_id       uuid NOT NULL,
  generation      text NOT NULL CHECK (kauro.is_generation(generation)),
  -- HELD: the generation is the live one and the provider reports it held; GENERATION_NOT_LIVE: another generation, or none
  result          text NOT NULL CHECK (result IN ('HELD', 'GENERATION_NOT_LIVE')),
  -- the seal after its commit (a request handler), or OBJECT_INVENTORY (the control plane): row security binds each to its role
  reasserted_by   text NOT NULL CHECK (reasserted_by IN ('SEAL', 'OBJECT_INVENTORY')),
  observed_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX object_hold_reassertions_by_hold ON kauro.object_hold_reassertions (hold_id, observed_at);
CREATE TRIGGER object_hold_reassertions_append_only BEFORE UPDATE OR DELETE ON kauro.object_hold_reassertions FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE OR REPLACE FUNCTION kauro.object_hold_reassertions_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.observed_at IS DISTINCT FROM kauro.server_now() THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: the re-assertion % is recorded at the server''s transaction time', NEW.reassertion_id USING ERRCODE = 'KA072';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM kauro.object_holds h
     WHERE h.hold_id = NEW.hold_id AND h.agency_id = NEW.agency_id AND h.object_id = NEW.object_id AND h.generation = NEW.generation AND h.state = 'SEALED'
  ) THEN
    RAISE EXCEPTION 'LIFECYCLE_BINDING: a re-assertion names a SEALED hold at its own generation, not hold %', NEW.hold_id USING ERRCODE = 'KA072';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER object_hold_reassertions_guard BEFORE INSERT ON kauro.object_hold_reassertions FOR EACH ROW EXECUTE FUNCTION kauro.object_hold_reassertions_guard();

-- --- row-level security and grants ------------------------------------------------------------------------------------------------
-- The seal's request handler intends, seals and closes (REFUSED) the holds of its own attempt as the acting person, and releases what
-- nothing needs any more; the control plane, bound to the agency, abandons an attempt past its bound and releases (D-HOLD-3). No
-- column holds customer text: unbound, the control plane discovers due holds across tenants.
ALTER TABLE kauro.object_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.object_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY object_holds_tenant ON kauro.object_holds FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY object_holds_tenant_placer ON kauro.object_holds AS RESTRICTIVE FOR INSERT TO kauro_app
  WITH CHECK (placed_by_user_id = kauro.current_user_id());
CREATE POLICY object_holds_tenant_edges ON kauro.object_holds AS RESTRICTIVE FOR UPDATE TO kauro_app
  USING (true) WITH CHECK (state IN ('SEALED', 'CLOSED', 'RELEASING', 'RELEASED') AND (state <> 'CLOSED' OR close_reason = 'REFUSED'));
CREATE POLICY object_holds_control_read ON kauro.object_holds FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY object_holds_control_update ON kauro.object_holds FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id())
  WITH CHECK (agency_id = kauro.current_agency_id() AND state IN ('CLOSED', 'RELEASING', 'RELEASED') AND (state <> 'CLOSED' OR close_reason = 'ABANDONED'));

GRANT SELECT, INSERT ON kauro.object_holds TO kauro_app;
GRANT SELECT ON kauro.object_holds TO kauro_control;
GRANT UPDATE (state, sealed_at, closed_at, close_reason, release_requested_at, released_at, release_result, released_by, updated_at) ON kauro.object_holds TO kauro_app, kauro_control;

-- A release is claimed and answered by whichever runtime carries it out — a request handler releasing its own refused attempt, the
-- control plane everything else — each for its own agency (the claim is the fence, not the role); the control plane discovers lapsed
-- claims unbound. A re-assertion is the seal's (request handler) or OBJECT_INVENTORY's (control plane), each only its own.
ALTER TABLE kauro.object_hold_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.object_hold_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY object_hold_releases_tenant ON kauro.object_hold_releases FOR ALL TO kauro_app
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY object_hold_releases_control_read ON kauro.object_hold_releases FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY object_hold_releases_control_insert ON kauro.object_hold_releases FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id());
CREATE POLICY object_hold_releases_control_update ON kauro.object_hold_releases FOR UPDATE TO kauro_control
  USING (agency_id = kauro.current_agency_id()) WITH CHECK (agency_id = kauro.current_agency_id());
GRANT SELECT, INSERT ON kauro.object_hold_releases TO kauro_app, kauro_control;
GRANT UPDATE (answered_at, release_result, updated_at) ON kauro.object_hold_releases TO kauro_app, kauro_control;

ALTER TABLE kauro.object_hold_reassertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.object_hold_reassertions FORCE ROW LEVEL SECURITY;
CREATE POLICY object_hold_reassertions_tenant_read ON kauro.object_hold_reassertions FOR SELECT TO kauro_app
  USING (agency_id = kauro.current_agency_id());
CREATE POLICY object_hold_reassertions_tenant_insert ON kauro.object_hold_reassertions FOR INSERT TO kauro_app
  WITH CHECK (agency_id = kauro.current_agency_id() AND reasserted_by = 'SEAL');
CREATE POLICY object_hold_reassertions_control_read ON kauro.object_hold_reassertions FOR SELECT TO kauro_control
  USING (kauro.current_agency_id() IS NULL OR agency_id = kauro.current_agency_id());
CREATE POLICY object_hold_reassertions_control_insert ON kauro.object_hold_reassertions FOR INSERT TO kauro_control
  WITH CHECK (agency_id = kauro.current_agency_id() AND reasserted_by = 'OBJECT_INVENTORY');
GRANT SELECT, INSERT ON kauro.object_hold_reassertions TO kauro_app, kauro_control;
