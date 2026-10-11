-- Migration 0054: offsets are claims that yield; commission line locks have one order; noncash settlement is durable
-- (package B10, lane B10-OFFSET, docs/design/B10-OFFSET.md r11: D10-NEG-4, D10-NEG-6, D10-NEG-7; G-ORD-1; OFF-C11).
--
-- Never edits 0030, 0031 or 0036: it ALTERs and CREATE OR REPLACEs. Idempotent.
--
--   1. G-ORD-1: kauro.commission_lock_line_rows / kauro.take_commission_line_subject, the only way a commission line row or subject is
--      locked. A transaction blocks only inside its first B10 lock call (flag off); every later call is re-entrant or non-blocking
--      (KC027 COMMISSION_LOCK_ORDER). The flag is the transaction-scoped shared advisory marker (class 1100100027, key 0): once any
--      B10 lock is taken nothing can turn it off. kauro_app locks through the lock-only path (UPDATE (created_at) + a FOR UPDATE policy
--      WITH CHECK (false)): no SECURITY DEFINER (OFF-C11).
--   2. The fences (line state, hold INSERT or resolution, payout admission) re-issued over the two functions.
--   3. Offsets as claims: the settled-source and live-amount guard, releases (append-only), yield on holds, decreases and HELD.
--   4. Noncash settlement (OFF-R7): one row per statement, its admissible guard and the frozen statement and lines.

-- --- uuid v7 for the rows the database itself writes (releases, credit entries) -----------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.new_uuid_v7() RETURNS uuid
  LANGUAGE sql VOLATILE SET search_path = pg_catalog AS
$$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid()) placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) from 3) from 1 for 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;
GRANT EXECUTE ON FUNCTION kauro.new_uuid_v7() TO kauro_commission, kauro_app;

-- --- 1. G-ORD-1: the two lock functions -----------------------------------------------------------------------------------------------
-- "flag on": this backend holds the B10 lock-order marker (a transaction-level shared advisory lock; pg_advisory_unlock* releases only
-- session-level locks, so a transaction-level marker ends at COMMIT or ROLLBACK).
CREATE OR REPLACE FUNCTION kauro.commission_lines_locked() RETURNS boolean
  LANGUAGE sql VOLATILE SET search_path = pg_catalog AS
$$
  SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks
                  WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
                    AND classid = 1100100027::oid AND objid = 0::oid AND objsubid = 2 AND mode = 'ShareLock')
$$;

CREATE OR REPLACE FUNCTION kauro.commission_lock_line_rows(lines uuid[], row_mode text, subject_mode text DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
DECLARE
  flag boolean := kauro.commission_lines_locked();
  want uuid[];
  got uuid[] := ARRAY[]::uuid[];
  l uuid;
  k bigint;
BEGIN
  IF row_mode IS NULL OR row_mode NOT IN ('UPDATE', 'KEY SHARE') THEN
    RAISE EXCEPTION 'commission_lock_line_rows: row mode % is not UPDATE or KEY SHARE', row_mode USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF subject_mode IS NOT NULL AND subject_mode NOT IN ('EXCLUSIVE', 'SHARE') THEN
    RAISE EXCEPTION 'commission_lock_line_rows: subject mode % is not EXCLUSIVE or SHARE', subject_mode USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO want FROM unnest(lines) AS x WHERE x IS NOT NULL;
  IF want IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(1100100027, 0);
  BEGIN
    FOR l IN EXECUTE format('SELECT line_id FROM kauro.commission_lines WHERE line_id = ANY($1) ORDER BY line_id FOR %s%s', row_mode, CASE WHEN flag THEN ' NOWAIT' ELSE '' END) USING want
    LOOP
      got := got || l;
    END LOOP;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'COMMISSION_LOCK_ORDER: a commission line row is held by another transaction after this transaction took its first B10 lock' USING ERRCODE = 'KC027';
  END;
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'COMMISSION_LINE_NOT_FOUND: % of % commission lines are not visible to this session', cardinality(want) - cardinality(got), cardinality(want) USING ERRCODE = 'KC022';
  END IF;
  IF subject_mode IS NOT NULL THEN
    FOREACH l IN ARRAY want LOOP
      k := kauro.transition_key('kauro.commission_lines', l::text);
      IF flag THEN
        IF NOT (CASE subject_mode WHEN 'EXCLUSIVE' THEN pg_try_advisory_xact_lock(k) ELSE pg_try_advisory_xact_lock_shared(k) END) THEN
          RAISE EXCEPTION 'COMMISSION_LOCK_ORDER: the subject of commission line % is held by another transaction after this transaction took its first B10 lock', l USING ERRCODE = 'KC027';
        END IF;
      ELSIF subject_mode = 'EXCLUSIVE' THEN
        PERFORM pg_advisory_xact_lock(k);
      ELSE
        PERFORM pg_advisory_xact_lock_shared(k);
      END IF;
    END LOOP;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION kauro.take_commission_line_subject(line uuid, subject_mode text) RETURNS void
  LANGUAGE sql VOLATILE SET search_path = pg_catalog AS
$$ SELECT kauro.commission_lock_line_rows(ARRAY[line], 'KEY SHARE', subject_mode) $$;

REVOKE ALL ON FUNCTION kauro.commission_lines_locked() FROM PUBLIC;
REVOKE ALL ON FUNCTION kauro.commission_lock_line_rows(uuid[], text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION kauro.take_commission_line_subject(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.commission_lines_locked() TO kauro_app, kauro_commission;
GRANT EXECUTE ON FUNCTION kauro.commission_lock_line_rows(uuid[], text, text) TO kauro_app, kauro_commission;
GRANT EXECUTE ON FUNCTION kauro.take_commission_line_subject(uuid, text) TO kauro_app, kauro_commission;

-- the lock-only path of kauro_app (CMD052 approves as the acting owner; B12's owner hold commands later): created_at is immutable
-- (0030), the policy's WITH CHECK (false) lets the owner lock the lines it reads and update none. A seller or agency session locks none.
GRANT UPDATE (created_at) ON kauro.commission_lines TO kauro_app;
DROP POLICY IF EXISTS commission_lines_owner_lock ON kauro.commission_lines;
CREATE POLICY commission_lines_owner_lock ON kauro.commission_lines FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (false);

-- --- 2. the fences over the two functions --------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.take_commission_line_lock() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.take_commission_line_subject(NEW.line_id, 'EXCLUSIVE');
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION kauro.commission_lines_line_fence() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.take_commission_line_subject(OLD.line_id, 'EXCLUSIVE');
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS commission_lines_line_fence ON kauro.commission_lines;
CREATE TRIGGER commission_lines_line_fence BEFORE UPDATE OF state ON kauro.commission_lines
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.commission_lines_line_fence();

-- a hold INSERT takes its line's subject before the foreign key's KEY SHARE: the row, then the subject, every time
CREATE OR REPLACE FUNCTION kauro.commission_holds_lock_order() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.take_commission_line_subject(NEW.line_id, 'EXCLUSIVE');
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS commission_holds_lock_order ON kauro.commission_holds;
CREATE TRIGGER commission_holds_lock_order BEFORE INSERT ON kauro.commission_holds
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_holds_lock_order();

-- --- releases: the append-only record of claims returned to their source (OFF-R2, OFF-R8) ----------------------------------------------
-- A release shrinks the live amount of an offset; the offset row itself never changes. `applying_statement_id` is set by the guard to the
-- statement whose PAYABLE item of the receiving line counted the claim, or NULL (an unapplied claim).
CREATE TABLE IF NOT EXISTS kauro.commission_offset_releases (
  release_id            uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(release_id)),
  offset_id             uuid NOT NULL,
  seller_id             uuid NOT NULL,
  amount_cents          bigint NOT NULL CHECK (kauro.is_money(amount_cents) AND amount_cents > 0),
  cause                 text NOT NULL CHECK (cause IN ('HOLD_OPENED', 'ENTITLEMENT_DECREASED', 'LINE_HELD', 'STATEMENT_COMPOSED', 'PAYMENT_CANCELLED', 'POSITION_SHRANK')),
  applying_statement_id uuid,
  recorded_at           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL,
  CONSTRAINT commission_offset_releases_offset_fk FOREIGN KEY (offset_id, seller_id) REFERENCES kauro.commission_offsets (offset_id, seller_id)
);
CREATE INDEX IF NOT EXISTS commission_offset_releases_by_offset ON kauro.commission_offset_releases (offset_id);

DROP TRIGGER IF EXISTS commission_offset_releases_append_only ON kauro.commission_offset_releases;
CREATE TRIGGER commission_offset_releases_append_only BEFORE UPDATE OR DELETE ON kauro.commission_offset_releases FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS commission_offset_releases_no_truncate ON kauro.commission_offset_releases;
CREATE TRIGGER commission_offset_releases_no_truncate BEFORE TRUNCATE ON kauro.commission_offset_releases FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS commission_offset_releases_server_instant ON kauro.commission_offset_releases;
CREATE TRIGGER commission_offset_releases_server_instant BEFORE INSERT ON kauro.commission_offset_releases FOR EACH ROW EXECUTE FUNCTION kauro.require_server_instant('recorded_at');

ALTER TABLE kauro.commission_offset_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_offset_releases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commission_offset_releases_owner_read ON kauro.commission_offset_releases;
CREATE POLICY commission_offset_releases_owner_read ON kauro.commission_offset_releases FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
DROP POLICY IF EXISTS commission_offset_releases_seller_read ON kauro.commission_offset_releases;
CREATE POLICY commission_offset_releases_seller_read ON kauro.commission_offset_releases FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
DROP POLICY IF EXISTS commission_offset_releases_commission ON kauro.commission_offset_releases;
CREATE POLICY commission_offset_releases_commission ON kauro.commission_offset_releases FOR ALL TO kauro_commission USING (true) WITH CHECK (true);
GRANT SELECT ON kauro.commission_offset_releases TO kauro_app;
GRANT SELECT, INSERT ON kauro.commission_offset_releases TO kauro_commission;
-- the owner hold INSERT (B12 dispute-hold command; the kit opens holds as the owner) yields in its own COMMIT: only the cause HOLD_OPENED
GRANT INSERT ON kauro.commission_offset_releases TO kauro_app;
DROP POLICY IF EXISTS commission_offset_releases_owner_hold ON kauro.commission_offset_releases;
CREATE POLICY commission_offset_releases_owner_hold ON kauro.commission_offset_releases FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner() AND cause = 'HOLD_OPENED');

-- --- the settled state of a line and its claims (pure reads; callers hold the locks) -----------------------------------------------
-- noncash settlement rows (OFF-R7): created here so the helpers below can name them
CREATE TABLE IF NOT EXISTS kauro.commission_noncash_settlements (
  settlement_id    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(settlement_id)),
  statement_id     uuid NOT NULL,
  seller_id        uuid NOT NULL,
  statement_version bigint NOT NULL CHECK (statement_version >= 1),
  cutoff_hash      text NOT NULL CHECK (kauro.is_sha256_hex(cutoff_hash)),
  pay_date         date NOT NULL,
  evidence         jsonb NOT NULL,
  evidence_digest  text NOT NULL CHECK (kauro.is_sha256_hex(evidence_digest)),
  settled_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL,
  CONSTRAINT commission_noncash_settlements_one_per_statement UNIQUE (statement_id),
  CONSTRAINT commission_noncash_settlements_statement_fk FOREIGN KEY (statement_id, seller_id) REFERENCES kauro.commission_statements (statement_id, seller_id)
);

-- a line is a settled source when it was paid in cash (PAID, ADJUSTED) or is PAYABLE through a noncash-settled statement
CREATE OR REPLACE FUNCTION kauro.commission_line_settled(p_line uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT l.state IN ('PAID', 'ADJUSTED')
         OR (l.state = 'PAYABLE' AND EXISTS (SELECT 1 FROM kauro.commission_noncash_settlements n WHERE n.statement_id = l.payable_statement_id))
    FROM kauro.commission_lines l WHERE l.line_id = p_line
$$;

-- A_in: the cents of claims against the line that were applied by its settled PAYABLE item (cash PAID statement or noncash settlement)
CREATE OR REPLACE FUNCTION kauro.commission_line_applied_in(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT coalesce(sum(i.offset_cents), 0)::bigint
    FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
   WHERE i.line_id = p_line AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE'
     AND (s.state = 'PAID' OR EXISTS (SELECT 1 FROM kauro.commission_noncash_settlements n WHERE n.statement_id = s.statement_id))
$$;

-- live claims against a line (amount less releases) and live claims from a line
CREATE OR REPLACE FUNCTION kauro.commission_line_claims_in(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT coalesce(sum(o.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = o.offset_id), 0)), 0)::bigint
    FROM kauro.commission_offsets o WHERE o.against_line_id = p_line
$$;
CREATE OR REPLACE FUNCTION kauro.commission_line_claims_out(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT coalesce(sum(o.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = o.offset_id), 0)), 0)::bigint
    FROM kauro.commission_offsets o WHERE o.negative_line_id = p_line
$$;

-- cap(R) = max(0, E - P - H): what an unapplied receiving line can still pay, H its OPEN holds
CREATE OR REPLACE FUNCTION kauro.commission_line_cap(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT greatest(0, l.cumulative_entitlement_cents - coalesce(l.paid_cents, 0)
                     - coalesce((SELECT sum(h.amount_cents) FROM kauro.commission_holds h WHERE h.line_id = l.line_id AND h.state = 'OPEN'), 0))::bigint
    FROM kauro.commission_lines l WHERE l.line_id = p_line
$$;

-- pos(N) = P + A_in(N) - E: what the line was settled beyond its entitlement (a negative balance when positive)
CREATE OR REPLACE FUNCTION kauro.commission_line_position(p_line uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS
$$
  SELECT (coalesce(l.paid_cents, 0) + kauro.commission_line_applied_in(l.line_id) - l.cumulative_entitlement_cents)::bigint
    FROM kauro.commission_lines l WHERE l.line_id = p_line
$$;

-- --- release guard (BEFORE INSERT): the receiving line's row, then its subject, before live is read ------------------------------------
CREATE OR REPLACE FUNCTION kauro.commission_offset_releases_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  o record;
  live bigint;
  line_state text;
  applying uuid;
  applying_paid boolean;
BEGIN
  SELECT x.against_line_id, x.amount_cents INTO o FROM kauro.commission_offsets x WHERE x.offset_id = NEW.offset_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  PERFORM kauro.commission_lock_line_rows(ARRAY[o.against_line_id], 'KEY SHARE', 'EXCLUSIVE');
  live := o.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = NEW.offset_id), 0);
  IF NEW.amount_cents > live THEN
    RAISE EXCEPTION 'OFFSET_RELEASE: release of % cents exceeds the % live cents of offset %', NEW.amount_cents, live, NEW.offset_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offset_releases_within_live', SCHEMA = 'kauro', TABLE = 'commission_offset_releases';
  END IF;
  SELECT l.state INTO line_state FROM kauro.commission_lines l WHERE l.line_id = o.against_line_id;
  SELECT s.statement_id, (s.state = 'PAID' OR EXISTS (SELECT 1 FROM kauro.commission_noncash_settlements n WHERE n.statement_id = s.statement_id))
    INTO applying, applying_paid
    FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
   WHERE i.line_id = o.against_line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.state <> 'CORRECTED'
   ORDER BY s.created_at, s.statement_id LIMIT 1;
  IF line_state IN ('PAID', 'ADJUSTED') OR coalesce(applying_paid, false) THEN
    RAISE EXCEPTION 'OFFSET_RELEASE: offset % is settled (its receiving line was paid or settled noncash); a settled claim is never released', NEW.offset_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offset_releases_settled', SCHEMA = 'kauro', TABLE = 'commission_offset_releases';
  END IF;
  NEW.applying_statement_id := applying;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS commission_offset_releases_guard ON kauro.commission_offset_releases;
CREATE TRIGGER commission_offset_releases_guard BEFORE INSERT ON kauro.commission_offset_releases
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_offset_releases_guard();

-- at COMMIT: a release of an applied claim stands only when its applying statement is CORRECTED (no live payout), never when it settled
CREATE OR REPLACE FUNCTION kauro.commission_offset_releases_applied() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  s record;
BEGIN
  SELECT x.state, EXISTS (SELECT 1 FROM kauro.commission_noncash_settlements n WHERE n.statement_id = x.statement_id) AS noncash,
         EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = x.statement_id AND p.state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'SETTLED')) AS live_intent
    INTO s FROM kauro.commission_statements x WHERE x.statement_id = NEW.applying_statement_id;
  IF s.state = 'PAID' OR s.noncash THEN
    RAISE EXCEPTION 'OFFSET_RELEASE: the statement % that applied offset % settled in the same transaction', NEW.applying_statement_id, NEW.offset_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offset_releases_settled', SCHEMA = 'kauro', TABLE = 'commission_offset_releases';
  END IF;
  IF s.state IS DISTINCT FROM 'CORRECTED' OR s.live_intent THEN
    RAISE EXCEPTION 'OFFSET_RELEASE: an applied claim of offset % is released only with its applying statement % superseded (CORRECTED, no live payout)', NEW.offset_id, NEW.applying_statement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offset_releases_applied', SCHEMA = 'kauro', TABLE = 'commission_offset_releases';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS commission_offset_releases_applied ON kauro.commission_offset_releases;
CREATE CONSTRAINT TRIGGER commission_offset_releases_applied AFTER INSERT ON kauro.commission_offset_releases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.applying_statement_id IS NOT NULL) EXECUTE FUNCTION kauro.commission_offset_releases_applied();

-- --- yield: a write that lowers cap(R) below claims(R) releases the excess, newest offset first (OFF-R8) ------------------------------
-- Only an unapplied receiving line yields: a PAYABLE line's applied claims are frozen until their application is cancelled.
CREATE OR REPLACE FUNCTION kauro.commission_offsets_release_excess(p_line uuid, p_excess bigint, p_cause text) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
DECLARE
  o record;
  remaining bigint := p_excess;
  take bigint;
BEGIN
  FOR o IN
    SELECT x.offset_id, x.seller_id, x.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = x.offset_id), 0) AS live
      FROM kauro.commission_offsets x WHERE x.against_line_id = p_line
     ORDER BY x.recorded_at DESC, x.offset_id DESC
  LOOP
    EXIT WHEN remaining <= 0;
    CONTINUE WHEN o.live <= 0;
    take := least(o.live, remaining);
    INSERT INTO kauro.commission_offset_releases (release_id, offset_id, seller_id, amount_cents, cause, recorded_at, created_at)
      VALUES (kauro.new_uuid_v7(), o.offset_id, o.seller_id, take, p_cause, kauro.server_now(), now());
    remaining := remaining - take;
  END LOOP;
  RETURN p_excess - remaining;
END
$$;
GRANT EXECUTE ON FUNCTION kauro.commission_offsets_release_excess(uuid, bigint, text) TO kauro_commission, kauro_app;

CREATE OR REPLACE FUNCTION kauro.commission_offsets_yield(p_line uuid, p_cause text) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
DECLARE
  st text;
  excess bigint;
BEGIN
  PERFORM kauro.take_commission_line_subject(p_line, 'EXCLUSIVE');
  SELECT l.state INTO st FROM kauro.commission_lines l WHERE l.line_id = p_line;
  IF st IS NULL OR st NOT IN ('ACCRUED_PENDING', 'ELIGIBLE', 'HELD', 'VOID') THEN
    RETURN 0;
  END IF;
  excess := kauro.commission_line_claims_in(p_line) - kauro.commission_line_cap(p_line);
  IF excess <= 0 THEN
    RETURN 0;
  END IF;
  RETURN kauro.commission_offsets_release_excess(p_line, excess, p_cause);
END
$$;
GRANT EXECUTE ON FUNCTION kauro.commission_offsets_yield(uuid, text) TO kauro_commission, kauro_app;

CREATE OR REPLACE FUNCTION kauro.commission_holds_offsets_yield() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.state = 'OPEN' THEN
    PERFORM kauro.commission_offsets_yield(NEW.line_id, 'HOLD_OPENED');
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS commission_holds_offsets_yield ON kauro.commission_holds;
CREATE TRIGGER commission_holds_offsets_yield AFTER INSERT ON kauro.commission_holds
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_holds_offsets_yield();

CREATE OR REPLACE FUNCTION kauro.commission_lines_offsets_yield() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.commission_offsets_yield(NEW.line_id,
    CASE WHEN NEW.cumulative_entitlement_cents < OLD.cumulative_entitlement_cents THEN 'ENTITLEMENT_DECREASED' ELSE 'LINE_HELD' END);
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS commission_lines_offsets_yield ON kauro.commission_lines;
CREATE TRIGGER commission_lines_offsets_yield AFTER UPDATE OF cumulative_entitlement_cents, state ON kauro.commission_lines
  FOR EACH ROW WHEN (NEW.cumulative_entitlement_cents < OLD.cumulative_entitlement_cents OR (NEW.state = 'HELD' AND OLD.state IS DISTINCT FROM 'HELD'))
  EXECUTE FUNCTION kauro.commission_lines_offsets_yield();

-- --- the offset guard, re-issued: a settled source, live claims, ELIGIBLE receiving line, capacity (D10-NEG-4) -----------------------
CREATE OR REPLACE FUNCTION kauro.commission_offsets_authorized() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  negative record;
  against record;
  terms record;
BEGIN
  PERFORM kauro.commission_lock_line_rows(ARRAY[NEW.negative_line_id, NEW.against_line_id], 'KEY SHARE', 'EXCLUSIVE');
  SELECT e.agreement_id INTO negative
    FROM kauro.commission_lines l JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id WHERE l.line_id = NEW.negative_line_id;
  SELECT g.offset_terms, g.signed_at INTO terms FROM kauro.seller_agreements g WHERE g.seller_id = NEW.seller_id AND g.agreement_id = NEW.agreement_id;
  IF NEW.agreement_id IS DISTINCT FROM negative.agreement_id OR terms.offset_terms IS DISTINCT FROM 'SIGNED_FUTURE_OFFSET' OR terms.signed_at IS NULL THEN
    RAISE EXCEPTION 'OFFSET_NOT_AUTHORIZED: seller % has no signed future-offset terms for line %', NEW.seller_id, NEW.negative_line_id USING ERRCODE = 'KC017';
  END IF;
  SELECT l.state INTO against FROM kauro.commission_lines l WHERE l.line_id = NEW.against_line_id;
  IF against.state IS DISTINCT FROM 'ELIGIBLE' THEN
    RAISE EXCEPTION 'OFFSET: line % is not ELIGIBLE; an offset is admitted only against an ELIGIBLE line', NEW.against_line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offsets_applicable', SCHEMA = 'kauro', TABLE = 'commission_offsets';
  END IF;
  IF NOT kauro.commission_line_settled(NEW.negative_line_id)
     OR NEW.amount_cents > kauro.commission_line_position(NEW.negative_line_id) - kauro.commission_line_claims_out(NEW.negative_line_id)
     OR NEW.amount_cents > kauro.commission_line_cap(NEW.against_line_id) - kauro.commission_line_claims_in(NEW.against_line_id) THEN
    RAISE EXCEPTION 'OFFSET: offset of line % against line % exceeds the negative position or the later line capacity', NEW.negative_line_id, NEW.against_line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_offsets_amount', SCHEMA = 'kauro', TABLE = 'commission_offsets';
  END IF;
  RETURN NEW;
END
$$;

-- --- payout admission: one first lock call over the statement's payable lines (OFF-R2-02 adds CREDIT lines in 0055) --------------------
CREATE OR REPLACE FUNCTION kauro.payout_lines_blocked(p_statement_id uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS
$$
DECLARE
  blocked uuid;
BEGIN
  SELECT l.line_id INTO blocked
    FROM kauro.commission_lines l
   WHERE l.line_id IN (SELECT i.line_id FROM kauro.statement_items i WHERE i.statement_id = p_statement_id AND i.disposition = 'PAYABLE' AND i.line_id IS NOT NULL)
     AND (l.state <> 'PAYABLE'
          OR l.payable_statement_id IS DISTINCT FROM p_statement_id
          OR EXISTS (SELECT 1 FROM kauro.commission_holds h
                      WHERE h.line_id = l.line_id AND h.state = 'OPEN'
                        AND NOT EXISTS (SELECT 1 FROM kauro.statement_items w WHERE w.statement_id = p_statement_id AND w.hold_id = h.hold_id))
          OR (SELECT o.funds_state FROM kauro.capture_funds_observations o
               WHERE o.agency_id = l.agency_id AND o.capture_id = l.capture_id ORDER BY o.capture_version DESC LIMIT 1) IS DISTINCT FROM 'AVAILABLE')
   ORDER BY l.line_id
   LIMIT 1;
  RETURN blocked;
END
$$;
GRANT EXECUTE ON FUNCTION kauro.payout_lines_blocked(uuid) TO kauro_app, kauro_commission;

CREATE OR REPLACE FUNCTION kauro.payout_lines_unpayable(p_statement_id uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS
$$
BEGIN
  PERFORM kauro.commission_lock_line_rows(
    ARRAY(SELECT DISTINCT i.line_id FROM kauro.statement_items i WHERE i.statement_id = p_statement_id AND i.disposition = 'PAYABLE' AND i.line_id IS NOT NULL),
    'KEY SHARE', 'SHARE');
  RETURN kauro.payout_lines_blocked(p_statement_id);
END
$$;
GRANT EXECUTE ON FUNCTION kauro.payout_lines_unpayable(uuid) TO kauro_app, kauro_commission;

-- --- noncash settlement (OFF-R7) -----------------------------------------------------------------------------------------------------
ALTER TABLE kauro.commission_noncash_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.commission_noncash_settlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commission_noncash_settlements_owner_read ON kauro.commission_noncash_settlements;
CREATE POLICY commission_noncash_settlements_owner_read ON kauro.commission_noncash_settlements FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
DROP POLICY IF EXISTS commission_noncash_settlements_seller_read ON kauro.commission_noncash_settlements;
CREATE POLICY commission_noncash_settlements_seller_read ON kauro.commission_noncash_settlements FOR SELECT TO kauro_app USING (seller_id = kauro.current_seller_id());
DROP POLICY IF EXISTS commission_noncash_settlements_commission ON kauro.commission_noncash_settlements;
CREATE POLICY commission_noncash_settlements_commission ON kauro.commission_noncash_settlements FOR ALL TO kauro_commission USING (true) WITH CHECK (true);
GRANT SELECT ON kauro.commission_noncash_settlements TO kauro_app;
GRANT SELECT, INSERT ON kauro.commission_noncash_settlements TO kauro_commission;
DROP TRIGGER IF EXISTS commission_noncash_settlements_append_only ON kauro.commission_noncash_settlements;
CREATE TRIGGER commission_noncash_settlements_append_only BEFORE UPDATE OR DELETE ON kauro.commission_noncash_settlements FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
DROP TRIGGER IF EXISTS commission_noncash_settlements_no_truncate ON kauro.commission_noncash_settlements;
CREATE TRIGGER commission_noncash_settlements_no_truncate BEFORE TRUNCATE ON kauro.commission_noncash_settlements FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();

-- admissible: the statement row FOR UPDATE, its item lines' rows KEY SHARE ascending and their EXCLUSIVE subjects (ADV-OFF-4), then reads
CREATE OR REPLACE FUNCTION kauro.commission_noncash_settlements_admissible() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  s record;
  lines uuid[];
  items jsonb;
  mismatch uuid;
  digest text;
BEGIN
  PERFORM 1 FROM kauro.commission_statements x WHERE x.statement_id = NEW.statement_id FOR UPDATE;
  lines := ARRAY(SELECT DISTINCT i.line_id FROM kauro.statement_items i WHERE i.statement_id = NEW.statement_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE');
  PERFORM kauro.commission_lock_line_rows(lines, 'KEY SHARE', 'EXCLUSIVE');
  SELECT x.state, x.seller_id, x.payable_cents, x.pay_date, x.version, x.cutoff_hash INTO s FROM kauro.commission_statements x WHERE x.statement_id = NEW.statement_id;
  IF s.state IS DISTINCT FROM 'ISSUED' OR s.payable_cents IS DISTINCT FROM 0 OR cardinality(lines) = 0
     OR s.pay_date > (kauro.server_now() AT TIME ZONE 'America/Bogota')::date
     OR kauro.payout_lines_blocked(NEW.statement_id) IS NOT NULL THEN
    RAISE EXCEPTION 'NONCASH_SETTLEMENT: statement % is not an ISSUED all-offset statement due for noncash settlement', NEW.statement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_noncash_settlements_admissible', SCHEMA = 'kauro', TABLE = 'commission_noncash_settlements';
  END IF;
  SELECT jsonb_agg(jsonb_build_object(
           'item_id', i.item_id, 'line_id', i.line_id, 'offset_cents', i.offset_cents,
           'offsets', coalesce((SELECT jsonb_agg(jsonb_build_object('offset_id', o.offset_id, 'live_cents', o.live) ORDER BY o.offset_id)
                                  FROM (SELECT x.offset_id, x.amount_cents - coalesce((SELECT sum(r.amount_cents) FROM kauro.commission_offset_releases r WHERE r.offset_id = x.offset_id), 0) AS live
                                          FROM kauro.commission_offsets x WHERE x.against_line_id = i.line_id) o WHERE o.live > 0), '[]'::jsonb)
         ) ORDER BY i.item_id)
    INTO items FROM kauro.statement_items i WHERE i.statement_id = NEW.statement_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE';
  SELECT i.line_id INTO mismatch FROM kauro.statement_items i
   WHERE i.statement_id = NEW.statement_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE'
     AND i.offset_cents IS DISTINCT FROM kauro.commission_line_claims_in(i.line_id) LIMIT 1;
  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'NONCASH_SETTLEMENT: line % applied offset cents differ from its live claims', mismatch
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_noncash_settlements_admissible', SCHEMA = 'kauro', TABLE = 'commission_noncash_settlements';
  END IF;
  digest := encode(sha256(convert_to(items::text || '|' || s.cutoff_hash || '|' || s.pay_date::text, 'UTF8')), 'hex');
  IF NEW.evidence_digest IS NOT NULL AND NEW.evidence_digest <> digest THEN
    RAISE EXCEPTION 'NONCASH_SETTLEMENT: evidence digest does not match the statement applied offsets'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_noncash_settlements_admissible', SCHEMA = 'kauro', TABLE = 'commission_noncash_settlements';
  END IF;
  NEW.seller_id := s.seller_id;
  NEW.statement_version := s.version;
  NEW.cutoff_hash := s.cutoff_hash;
  NEW.pay_date := s.pay_date;
  NEW.evidence := items;
  NEW.evidence_digest := digest;
  NEW.settled_at := kauro.server_now();
  NEW.created_at := now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS commission_noncash_settlements_admissible ON kauro.commission_noncash_settlements;
CREATE TRIGGER commission_noncash_settlements_admissible BEFORE INSERT ON kauro.commission_noncash_settlements
  FOR EACH ROW EXECUTE FUNCTION kauro.commission_noncash_settlements_admissible();

-- a noncash-settled statement refuses every state change; its lines refuse every state edge and payable-owner change (adjustments pass)
CREATE OR REPLACE FUNCTION kauro.commission_statements_noncash_frozen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF EXISTS (SELECT 1 FROM kauro.commission_noncash_settlements n WHERE n.statement_id = OLD.statement_id) THEN
    RAISE EXCEPTION 'NONCASH_SETTLEMENT: statement % is settled noncash and frozen', OLD.statement_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_statements_noncash_frozen', SCHEMA = 'kauro', TABLE = 'commission_statements';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS commission_statements_noncash_frozen ON kauro.commission_statements;
CREATE TRIGGER commission_statements_noncash_frozen BEFORE UPDATE OF state ON kauro.commission_statements
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION kauro.commission_statements_noncash_frozen();

CREATE OR REPLACE FUNCTION kauro.commission_lines_noncash_frozen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF OLD.state = 'PAYABLE' AND EXISTS (SELECT 1 FROM kauro.commission_noncash_settlements n WHERE n.statement_id = OLD.payable_statement_id) THEN
    RAISE EXCEPTION 'NONCASH_SETTLEMENT: line % is payable through a noncash-settled statement and frozen', OLD.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'commission_lines_noncash_frozen', SCHEMA = 'kauro', TABLE = 'commission_lines';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS commission_lines_noncash_frozen ON kauro.commission_lines;
CREATE TRIGGER commission_lines_noncash_frozen BEFORE UPDATE OF state, payable_statement_id ON kauro.commission_lines
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.payable_statement_id IS DISTINCT FROM NEW.payable_statement_id) EXECUTE FUNCTION kauro.commission_lines_noncash_frozen();
