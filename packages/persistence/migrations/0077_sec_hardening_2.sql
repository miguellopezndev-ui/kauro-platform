-- 0077 — SEC-HARDENING-2 (tier 1; provisional number, renumbered on rebase by tools/renumber-migration.mjs) + B-LIFETIME-2 BL2-F1/F2.
-- SH2-F1 (R2 08 "Database isolation": SECURITY DEFINER functions require "minimal owner privileges"): the one justified definer,
-- kauro.register_bank_payment_route (0046), moves from the migrator (which owns every kauro table) to the NOLOGIN role
-- kauro_route_registrar, which holds only what the registration reads and writes:
--   USAGE on schema kauro; INSERT of the ten columns 0046 inserts into kauro.payment_routes; SELECT of corporate_roles(user_id, role,
--   state) (the caller's grant); SELECT on kauro.state_machines (the one non-internal INSERT trigger of payment_routes,
--   payment_routes_initial_state -> kauro.enforce_initial_state('PaymentRoute'), reads it; census of pg_trigger at build: the other
--   four triggers are BEFORE UPDATE; the CHECKs call kauro.is_uuid_v7 and kauro.is_sha256_hex, executable by PUBLIC, and the unique
--   and foreign-key checks run as the table owner). A future INSERT trigger reading another table needs a grant here: the configure
--   cells (SH2-C2, apps/api ACH configure cells) go red at once.
-- The two registration policies keep their names and move to the registrar; the corporate-roles read is narrowed to the caller's own
-- rows. The migrator stays the registrar's only member, WITH INHERIT TRUE (a policy TO a role applies to its inheriting members, so a
-- registration that entered the function before this commit still passes after it; INHERIT FALSE also breaks every later CREATE OR
-- REPLACE of the function) and SET TRUE (needed to make the registrar the owner).
-- Production (RDS, B14-R1/R3): the migrator needs CREATEROLE, or B14 pre-creates kauro_route_registrar in exactly the shape checked
-- below (NOLOGIN, no attribute, member of nothing, the migrator its only member WITH INHERIT TRUE, SET TRUE); otherwise this file
-- fails with a message naming the fix.
-- SH2-F2 (R2 08 "Runtime roles are not owners, superusers or BYPASSRLS"; 14_CLOUD:57 "only required database roles"): the file fails
-- when a runtime principal (the 0060 definition) is a member of any role that is neither itself nor a runtime group; the pool refuses
-- such a login at acquire (pool.ts).
-- BL2-F1 (R2 06 :11 immutable evidence, :92 conflicting input): a recorded audit step's outcome, evidence hash and class are fixed.
-- BL2-F2 (template rule 22): TRUNCATE of the event log, alone or by cascade, is refused (KA004).
-- Error codes: 42501 and KA004 only (existing).

-- 1. the registrar role, created or checked
DO $registrar$
DECLARE
  r       record;
  me      record;
  shape   text;
BEGIN
  SELECT x.oid, x.rolcanlogin, x.rolsuper, x.rolbypassrls, x.rolcreaterole, x.rolcreatedb, x.rolreplication INTO r
    FROM pg_catalog.pg_roles x WHERE x.rolname = 'kauro_route_registrar';
  IF NOT FOUND THEN
    SELECT x.rolsuper, x.rolcreaterole INTO me FROM pg_catalog.pg_roles x WHERE x.rolname = current_user;
    IF NOT (me.rolsuper OR me.rolcreaterole) THEN
      RAISE EXCEPTION 'HARDENING: kauro_route_registrar does not exist and % cannot create it (no CREATEROLE); B14 pre-creates it NOLOGIN, member of nothing, with the migrator its only member WITH INHERIT TRUE, SET TRUE', current_user
        USING ERRCODE = '42501';
    END IF;
    CREATE ROLE kauro_route_registrar NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT;
  ELSE
    shape := pg_catalog.format('login=%s superuser=%s bypassrls=%s createrole=%s createdb=%s replication=%s member_of=[%s] members=[%s]',
      r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
      (SELECT pg_catalog.string_agg(m.roleid::regrole::text, ',') FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid),
      (SELECT pg_catalog.string_agg(DISTINCT m.member::regrole::text, ',') FROM pg_catalog.pg_auth_members m WHERE m.roleid = r.oid));
    IF r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid = m.member WHERE m.roleid = r.oid AND u.rolname <> current_user) THEN
      RAISE EXCEPTION 'HARDENING: kauro_route_registrar has shape %', shape USING ERRCODE = '42501';
    END IF;
  END IF;
END
$registrar$;

-- 2. the migrator inherits the registrar (policies) and may become it (ownership)
DO $membership$
BEGIN
  IF NOT (pg_catalog.pg_has_role(current_user, 'kauro_route_registrar', 'USAGE') AND pg_catalog.pg_has_role(current_user, 'kauro_route_registrar', 'SET')) THEN
    GRANT kauro_route_registrar TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$membership$;

-- 3. exactly what the registration needs
GRANT USAGE ON SCHEMA kauro TO kauro_route_registrar;
GRANT INSERT (route_id, provider, environment, merchant_ref, payee_digest, currency, integration_class, state, created_at, updated_at) ON kauro.payment_routes TO kauro_route_registrar;
GRANT SELECT (user_id, role, state) ON kauro.corporate_roles TO kauro_route_registrar;
GRANT SELECT ON kauro.state_machines TO kauro_route_registrar;

-- 4. the ownership transfer (a non-superuser needs SET on the new owner and the new owner CREATE on the schema, lent for it only)
GRANT CREATE ON SCHEMA kauro TO kauro_route_registrar;
ALTER FUNCTION kauro.register_bank_payment_route(uuid, text, text, uuid, text, text) OWNER TO kauro_route_registrar;
REVOKE CREATE ON SCHEMA kauro FROM kauro_route_registrar;

-- 5. the two registration policies, same names, now the registrar's; the grant read narrowed to the caller's own rows
ALTER POLICY payment_routes_register_bank ON kauro.payment_routes TO kauro_route_registrar;
ALTER POLICY corporate_roles_register_bank_read ON kauro.corporate_roles TO kauro_route_registrar
  USING (user_id = NULLIF(pg_catalog.current_setting('kauro.user_id', true), '')::uuid);

-- 6. the function's ACL, re-asserted (an ownership change keeps it; idempotent)
REVOKE ALL ON FUNCTION kauro.register_bank_payment_route(uuid, text, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kauro.register_bank_payment_route(uuid, text, text, uuid, text, text) TO kauro_app;

-- 7. SH2-F2: no runtime principal is a member of a non-runtime role
DO $runtime_membership$
DECLARE
  groups  text[] := ARRAY['kauro_app', 'kauro_control', 'kauro_assurance', 'kauro_validator', 'kauro_ingress', 'kauro_payment', 'kauro_commission'];
  p_name  text;
  b_name  text;
BEGIN
  -- the runtime principals of 0060: a runtime group or a non-superuser role that inherits one
  WITH runtime_principals AS (
    SELECT x.oid AS role_oid, x.rolname FROM pg_catalog.pg_roles x
     WHERE NOT x.rolsuper AND EXISTS (SELECT 1 FROM pg_catalog.unnest(groups) g WHERE x.rolname = g OR pg_catalog.pg_has_role(x.oid, g, 'USAGE'))
  )
  SELECT p.rolname, b.rolname INTO p_name, b_name
    FROM runtime_principals p JOIN pg_catalog.pg_roles b
      ON b.oid <> p.role_oid AND b.rolname <> ALL (groups) AND pg_catalog.pg_has_role(p.role_oid, b.oid, 'MEMBER')
   ORDER BY p.rolname, b.rolname
   LIMIT 1;
  IF p_name IS NOT NULL THEN
    RAISE EXCEPTION 'HARDENING: runtime role % is a member of non-runtime role %', p_name, b_name USING ERRCODE = '42501';
  END IF;
END
$runtime_membership$;

-- 8. BL2-F1: a recorded step's outcome and evidence are fixed. BEFORE triggers fire by name: audit_steps_immutable < _learned_once <
-- _record_once < _workflow, so this refuses before audit_steps_workflow (0023) would move recorded_at.
CREATE OR REPLACE FUNCTION kauro.audit_steps_record_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  IF NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash OR NEW.evidence_class IS DISTINCT FROM OLD.evidence_class THEN
    RAISE EXCEPTION 'IMMUTABLE: audit step % was recorded at %; its outcome and evidence are fixed', OLD.step_id, OLD.recorded_at USING ERRCODE = 'KA004';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER audit_steps_record_once BEFORE UPDATE ON kauro.audit_steps
  FOR EACH ROW WHEN (OLD.outcome IS NOT NULL) EXECUTE FUNCTION kauro.audit_steps_record_once();
REVOKE EXECUTE ON FUNCTION kauro.audit_steps_record_once() FROM PUBLIC;

-- 9. BL2-F2: the event log is never truncated (a cascade would empty the outbox, inbox and ledger that reference it)
CREATE TRIGGER domain_events_no_truncate BEFORE TRUNCATE ON kauro.domain_events FOR EACH STATEMENT EXECUTE FUNCTION kauro.forbid_change();
