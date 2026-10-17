-- Migration 0094 — the business contact's key on the prospect (order 4, independent review finding F2; owner decision of 2026-10-17, option A).
--
-- R2-130 derives a prospect's effective suppression from the registry (docs/design/B12-outreach-plan.md D-B12O-12a): a suppression of its organization
-- key or of its business contact's key. The contact key lived only on kauro.prospect_contacts, which a seller reads only for the contacts it recorded
-- itself (prospect_contacts_self_read, 0089): a seller assigned a prospect the owner registered could not link it to a CONTACT suppression, so its reader
-- showed RESEARCHED while the owner's showed SUPPRESSED. The prospect now carries the key of its own business contact:
--   1. kauro.prospects.business_contact_key: the contact_key of the business contact its registrar recorded; NULL exactly when it names no contact.
--   2. Integrity held by the database: the composite foreign key (registered_by_user_id, business_contact_id, business_contact_key) ->
--      kauro.prospect_contacts (recorded_by_user_id, contact_id, contact_key) admits only that contact's own key, and prospects_contact_key_present ties
--      the key's nullability to business_contact_id's (a prospect without a contact carries no key, one with a contact always carries its key).
--   3. Derived, never supplied: a BEFORE INSERT trigger copies the key from the contact row as the inserting session reads it (the registrar's own row:
--      prospects_register admits only registered_by_user_id = the session's person) and refuses any supplied value (prospects_contact_key_derived).
--   4. Immutable like business_contact_id: kauro.forbid_column_change (KA004) for every role; kauro_app's column UPDATE grant (0029) never names it and
--      kauro_outreach holds SELECT only.
--   5. The backfill copies the key of every existing prospect from its own contact row. A prospect whose contact row cannot be found, or that already
--      carries another key, fails the migration with the count and the first ids, and nothing is written: no key is ever invented. The backfill runs as
--      the owner with FORCE ROW LEVEL SECURITY and the version, touch and KA098-W triggers of kauro.prospects suspended inside this one transaction
--      (ALTER TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other session observes the suspension); all are restored before the constraints validate
--      every row. A backfilled key is no business change: no version step, no updated_at, no transition row.
-- No policy of kauro.prospect_contacts changes, no grant is added, no SECURITY DEFINER routine is created. Idempotent.

ALTER TABLE kauro.prospects ADD COLUMN IF NOT EXISTS business_contact_key text;

-- the referenced key of the composite foreign key (contact_id alone is the primary key: the triple is unique by construction)
ALTER TABLE kauro.prospects DROP CONSTRAINT IF EXISTS prospects_contact_key_fk;
ALTER TABLE kauro.prospects DROP CONSTRAINT IF EXISTS prospects_contact_key_present;
ALTER TABLE kauro.prospect_contacts DROP CONSTRAINT IF EXISTS prospect_contacts_key_of_contact;
ALTER TABLE kauro.prospect_contacts ADD CONSTRAINT prospect_contacts_key_of_contact UNIQUE (recorded_by_user_id, contact_id, contact_key);
-- this migration's own triggers are created again at its end (a re-run backfills before the key becomes immutable)
DROP TRIGGER IF EXISTS prospects_business_contact_key ON kauro.prospects;
DROP TRIGGER IF EXISTS prospects_contact_key_immutable ON kauro.prospects;

-- --- the backfill (owner, this transaction only) -----------------------------------------------------------------------------------------
ALTER TABLE kauro.prospects NO FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.prospect_contacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.prospects DISABLE TRIGGER prospects_touch;
ALTER TABLE kauro.prospects DISABLE TRIGGER prospects_version;
ALTER TABLE kauro.prospects DISABLE TRIGGER prospects_suppression_columns;

DO $$
DECLARE
  n bigint;
  sample text;
BEGIN
  SELECT count(*) INTO n FROM kauro.prospects p
   WHERE (p.business_contact_id IS NULL AND p.business_contact_key IS NOT NULL)
      OR (p.business_contact_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM kauro.prospect_contacts c
             WHERE c.recorded_by_user_id = p.registered_by_user_id AND c.contact_id = p.business_contact_id
               AND (p.business_contact_key IS NULL OR p.business_contact_key = c.contact_key)));
  IF n > 0 THEN
    SELECT string_agg(x.prospect_id::text, ', ') INTO sample FROM (
      SELECT p.prospect_id FROM kauro.prospects p
       WHERE (p.business_contact_id IS NULL AND p.business_contact_key IS NOT NULL)
          OR (p.business_contact_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM kauro.prospect_contacts c
                 WHERE c.recorded_by_user_id = p.registered_by_user_id AND c.contact_id = p.business_contact_id
                   AND (p.business_contact_key IS NULL OR p.business_contact_key = c.contact_key)))
       ORDER BY p.prospect_id LIMIT 20) x;
    RAISE EXCEPTION 'PROSPECT_CONTACT_KEY_BACKFILL: % prospect(s) name a business contact their registrar never recorded or carry a key that is not their contact''s; nothing was backfilled (first ids: %)', n, sample
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END
$$;

UPDATE kauro.prospects p SET business_contact_key = c.contact_key
  FROM kauro.prospect_contacts c
 WHERE p.business_contact_key IS NULL AND c.recorded_by_user_id = p.registered_by_user_id AND c.contact_id = p.business_contact_id;

ALTER TABLE kauro.prospects ENABLE TRIGGER prospects_suppression_columns;
ALTER TABLE kauro.prospects ENABLE TRIGGER prospects_version;
ALTER TABLE kauro.prospects ENABLE TRIGGER prospects_touch;
ALTER TABLE kauro.prospect_contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.prospects FORCE ROW LEVEL SECURITY;

-- --- the constraints (validated over every row, the backfilled ones included) ----------------------------------------------------------
ALTER TABLE kauro.prospects ADD CONSTRAINT prospects_contact_key_present CHECK ((business_contact_id IS NULL) = (business_contact_key IS NULL));
ALTER TABLE kauro.prospects ADD CONSTRAINT prospects_contact_key_fk FOREIGN KEY (registered_by_user_id, business_contact_id, business_contact_key)
  REFERENCES kauro.prospect_contacts (recorded_by_user_id, contact_id, contact_key);

-- --- derived at birth, immutable after ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kauro.prospects_business_contact_key() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
DECLARE
  k text;
BEGIN
  IF NEW.business_contact_key IS NOT NULL THEN
    RAISE EXCEPTION 'PROSPECT_CONTACT_KEY: a prospect''s business contact key is copied from its contact, never supplied'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'prospects_contact_key_derived', SCHEMA = 'kauro', TABLE = 'prospects';
  END IF;
  IF NEW.business_contact_id IS NOT NULL THEN
    -- the registrar's own contact (prospects_register: registered_by_user_id is the session's person); a contact it cannot read leaves the key NULL,
    -- which prospects_contact_key_present refuses
    SELECT c.contact_key INTO k FROM kauro.prospect_contacts c WHERE c.recorded_by_user_id = NEW.registered_by_user_id AND c.contact_id = NEW.business_contact_id;
    NEW.business_contact_key := k;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kauro.prospects_business_contact_key() FROM PUBLIC;
CREATE TRIGGER prospects_business_contact_key BEFORE INSERT ON kauro.prospects FOR EACH ROW EXECUTE FUNCTION kauro.prospects_business_contact_key();
CREATE TRIGGER prospects_contact_key_immutable BEFORE UPDATE ON kauro.prospects
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('business_contact_key');
