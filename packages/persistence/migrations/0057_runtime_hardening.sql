-- 0057 — SEC-DEPTH-PROVENANCE A1/R1/R2 (tier 1; provisional number, renumbered at merge): the runtime principals stay outside the
-- guard-execution boundary (P2). Runtime groups, their logins and PUBLIC lose TEMPORARY and CREATE on the database (a pg_temp function
-- or table is a place a session could shadow an unqualified name), PUBLIC loses CREATE on schema public and EXECUTE on every kauro
-- trigger function, and the pg_parameter_acl grants of SET / ALTER SYSTEM to PUBLIC or a runtime principal are revoked where this role
-- may (SDP-19: database ownership is not enough; the RDS master is not assumed superuser). The migration then FAILS - and so records
-- no ledger row - when any of the P2 conditions still holds: a runtime principal (a group, a login that inherits one, or PUBLIC) keeps
-- TEMPORARY or CREATE on the database or CREATE on a schema, holds SET on session_replication_role (replica mode skips ordinary,
-- constraint and foreign-key triggers), owns an object of kauro or kauro_meta, or can EXECUTE a SECURITY DEFINER routine of kauro,
-- kauro_meta or public other than the one justified exception (kauro.register_bank_payment_route, migration 0046: owner-owned,
-- fixed body, pinned search_path, no dynamic SQL, CONFIGURED rows only).
-- Superusers are the trusted computing base and are never counted as runtime principals.
DO $hardening$
DECLARE
  db      text := pg_catalog.current_database();
  groups  text[] := ARRAY['kauro_app', 'kauro_control', 'kauro_assurance', 'kauro_validator', 'kauro_ingress', 'kauro_payment', 'kauro_commission'];
  grp     text;
  r       record;
  found   text;
  allowed regprocedure := 'kauro.register_bank_payment_route(uuid, text, text, uuid, text, text)'::regprocedure;
BEGIN
  EXECUTE pg_catalog.format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM PUBLIC', db);
  FOREACH grp IN ARRAY groups LOOP
    EXECUTE pg_catalog.format('REVOKE TEMPORARY, CREATE ON DATABASE %I FROM %I', db, grp);
  END LOOP;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  -- the trigger functions of kauro and kauro_meta: nobody needs EXECUTE to have a trigger fire, and a direct call is not a route
  FOR r IN
    SELECT p.oid::regprocedure AS sig FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('kauro', 'kauro_meta') AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE pg_catalog.format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
  END LOOP;
  -- parameter grants (SET / ALTER SYSTEM) to PUBLIC or a runtime principal, where this role holds the grant option
  FOR r IN
    SELECT DISTINCT pa.parname, a.grantee, a.privilege_type
      FROM pg_catalog.pg_parameter_acl pa, LATERAL pg_catalog.aclexplode(pa.paracl) a
     WHERE a.privilege_type IN ('SET', 'ALTER SYSTEM')
       AND (a.grantee = 0 OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid = a.grantee AND NOT x.rolsuper
            AND EXISTS (SELECT 1 FROM pg_catalog.unnest(groups) g WHERE pg_catalog.pg_has_role(x.oid, g, 'USAGE'))))
  LOOP
    BEGIN
      IF r.grantee = 0 THEN
        EXECUTE pg_catalog.format('REVOKE %s ON PARAMETER %I FROM PUBLIC', r.privilege_type, r.parname);
      ELSE
        EXECUTE pg_catalog.format('REVOKE %s ON PARAMETER %I FROM %I', r.privilege_type, r.parname, (SELECT rolname FROM pg_catalog.pg_roles WHERE oid = r.grantee));
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- not ours to revoke: the check below fails the migration if the grant still stands
    END;
  END LOOP;

  -- the checks (P2): every runtime principal = a runtime group or a non-superuser role that inherits one
  CREATE TEMP TABLE runtime_principals ON COMMIT DROP AS
    SELECT x.oid AS role_oid, x.rolname FROM pg_catalog.pg_roles x
     WHERE NOT x.rolsuper AND EXISTS (SELECT 1 FROM pg_catalog.unnest(groups) g WHERE x.rolname = g OR pg_catalog.pg_has_role(x.oid, g, 'USAGE'));
  IF (SELECT pg_catalog.count(*) FROM runtime_principals p WHERE p.rolname = ANY(groups)) <> pg_catalog.cardinality(groups) THEN
    RAISE EXCEPTION 'SEC-DEPTH: a runtime group is missing (0057 expects %)', groups USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.string_agg(p.rolname || ' ' || k.k, ', ') INTO found FROM runtime_principals p
    CROSS JOIN (VALUES ('TEMPORARY'), ('CREATE')) AS k(k)
   WHERE pg_catalog.has_database_privilege(p.role_oid, db, k.k);
  IF found IS NOT NULL THEN RAISE EXCEPTION 'SEC-DEPTH: a runtime principal still holds a database privilege (%)', found USING ERRCODE = '42501'; END IF;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_database d, LATERAL pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
        WHERE d.datname = db AND a.grantee = 0 AND a.privilege_type IN ('TEMPORARY', 'CREATE')) THEN
    RAISE EXCEPTION 'SEC-DEPTH: PUBLIC still holds TEMPORARY or CREATE on the database' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.string_agg(p.rolname || ' on ' || s.nspname, ', ') INTO found FROM runtime_principals p
    JOIN pg_catalog.pg_namespace s ON pg_catalog.has_schema_privilege(p.role_oid, s.oid, 'CREATE');
  IF found IS NOT NULL THEN RAISE EXCEPTION 'SEC-DEPTH: a runtime principal holds CREATE on a schema (%)', found USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace s, LATERAL pg_catalog.aclexplode(COALESCE(s.nspacl, pg_catalog.acldefault('n', s.nspowner))) a
              WHERE a.grantee = 0 AND a.privilege_type = 'CREATE') THEN
    RAISE EXCEPTION 'SEC-DEPTH: PUBLIC holds CREATE on a schema' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.string_agg(p.rolname, ', ') INTO found FROM runtime_principals p
   WHERE pg_catalog.has_parameter_privilege(p.role_oid, 'session_replication_role', 'SET');
  IF found IS NOT NULL OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_parameter_acl pa, LATERAL pg_catalog.aclexplode(pa.paracl) a
        WHERE pa.parname = 'session_replication_role' AND a.grantee = 0 AND a.privilege_type IN ('SET', 'ALTER SYSTEM')) THEN
    RAISE EXCEPTION 'SEC-DEPTH: SET on session_replication_role is held by PUBLIC or a runtime principal (%)', COALESCE(found, 'PUBLIC') USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.string_agg(DISTINCT p.rolname || ' owns ' || o.what, ', ') INTO found FROM runtime_principals p
    JOIN (
      SELECT c.relowner AS owner_oid, 'relation ' || c.relname AS what FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('kauro', 'kauro_meta')
      UNION ALL SELECT f.proowner, 'function ' || f.proname FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace WHERE n.nspname IN ('kauro', 'kauro_meta')
      UNION ALL SELECT t.typowner, 'type ' || t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname IN ('kauro', 'kauro_meta')
      UNION ALL SELECT n.nspowner, 'schema ' || n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('kauro', 'kauro_meta')
    ) o ON o.owner_oid = p.role_oid;
  IF found IS NOT NULL THEN RAISE EXCEPTION 'SEC-DEPTH: a runtime principal owns a kauro object (%)', found USING ERRCODE = '42501'; END IF;

  SELECT pg_catalog.string_agg(DISTINCT f.oid::regprocedure::text || ' to ' || COALESCE(p.rolname, 'PUBLIC'), ', ') INTO found
    FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace
    CROSS JOIN LATERAL (
      SELECT x.rolname FROM runtime_principals x WHERE pg_catalog.has_function_privilege(x.role_oid, f.oid, 'EXECUTE')
      UNION ALL
      SELECT NULL::name WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
    ) p(rolname)
   WHERE f.prosecdef AND n.nspname IN ('kauro', 'kauro_meta', 'public') AND f.oid <> allowed::oid;
  IF found IS NOT NULL THEN RAISE EXCEPTION 'SEC-DEPTH: a runtime principal can execute a SECURITY DEFINER routine (%)', found USING ERRCODE = '42501'; END IF;
END
$hardening$;
