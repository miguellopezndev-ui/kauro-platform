-- 0027 — the fit inquiry of a visitor without an account (B11 W5b, D-PUB-3..D-PUB-6). Numbered 0009 on the W5b branch,
-- 0024 by the B11 stage-1 integrator (D-INT1-1) and 0027 by the trunk sync (W2 0025, W4 0026, W5b 0027; D11-SYNC-1).
--
-- Authority: 02 "Intake and project boundaries" and A3 3.7 (the fit form collects business contact details, buyer type, destination,
-- approximate record band and desired timing; the buyer type never changes price or admission), 08 "Database isolation" (RLS applies
-- visibility and writes through USING and WITH CHECK; the runtime role holds only what a request handler needs), 08 "Abuse controls"
-- (an unauthenticated route is limited per client network and per contact), 07 "Outbox, inbox and event ordering" (an event carries
-- identities, not payload), 08 "Audit events and retention" (no personal data in an event or a limiter row).
--
-- An inquiry belongs to no tenant: nobody has signed in, and it names no agency, client or project. Three tables:
--   * inquiries          the inquiry itself; the runtime role may INSERT it and nothing else — it cannot read, change or delete one;
--   * inquiry_events     the event an accepted inquiry emits, `inquiry.received.v1`, whose payload is exactly the inquiry id
--                        (a table of its own: kauro.domain_events is tenant-scoped and an inquiry has no tenant);
--   * inquiry_admissions the keyed digests an inquiry was admitted under (client network, whole content, e-mail address) and the
--                        instant: the content-idempotence record (24 hours) and the two limiter counters (5 per hour per client
--                        network, 3 per day per e-mail address). Digests only: neither an address nor a text is stored here.
-- Only an accepted inquiry leaves rows; a replay, a limited request and a refusal leave none.
--
-- No reader role is granted: the package that reads inquiries (the owner queue) grants itself its own read in its own migration.
-- inquiry_admissions is not append-only by trigger: it is a counter, and a later retention job may delete rows older than the
-- longest window; the runtime role still cannot.

CREATE TABLE kauro.inquiries (
  inquiry_id     uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(inquiry_id)),
  buyer_type     text NOT NULL CHECK (buyer_type IN ('agency', 'in-house')),
  contact_name   text NOT NULL CHECK (kauro.is_label(contact_name)),
  -- stored as submitted; the admission keys compare it without regard to case
  contact_email  text NOT NULL CHECK (
    length(contact_email) BETWEEN 3 AND 254
    AND contact_email ~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
  ),
  company_name   text NOT NULL CHECK (kauro.is_label(company_name)),
  destination    text NOT NULL CHECK (destination IN ('listed-crm', 'other-crm', 'files-only', 'not-chosen')),
  record_band    text NOT NULL CHECK (record_band IN ('up-to-50000', 'up-to-150000', 'up-to-500000', 'up-to-1000000', 'over-1000000', 'not-sure')),
  timing         text NOT NULL CHECK (timing IN ('within-2-weeks', 'within-a-month', 'within-a-quarter', 'flexible')),
  -- free text: at least one visible character, line breaks and tabs allowed, every other control character refused
  description    text CHECK (
    description IS NULL
    OR (length(description) BETWEEN 1 AND 2000 AND description ~ '\S' AND description !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]')
  ),
  received_at    timestamptz NOT NULL
);

CREATE TABLE kauro.inquiry_events (
  event_id    uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(event_id)),
  event_type  text NOT NULL CHECK (event_type = 'inquiry.received.v1'),
  inquiry_id  uuid NOT NULL REFERENCES kauro.inquiries (inquiry_id),
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  -- ids only: the payload is the inquiry id and nothing else, so no name, address, company or text can ride an event
  CONSTRAINT inquiry_events_ids_only CHECK (payload = jsonb_build_object('inquiryId', inquiry_id::text)),
  CONSTRAINT inquiry_events_one_per_type UNIQUE (inquiry_id, event_type)
);
CREATE TRIGGER inquiry_events_append_only BEFORE UPDATE OR DELETE ON kauro.inquiry_events
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();

CREATE TABLE kauro.inquiry_admissions (
  inquiry_id   uuid NOT NULL REFERENCES kauro.inquiries (inquiry_id),
  kind         text NOT NULL CHECK (kind IN ('ADDRESS', 'CONTENT', 'EMAIL')),
  key_hash     text NOT NULL CHECK (kauro.is_sha256_hex(key_hash)),
  admitted_at  timestamptz NOT NULL,
  PRIMARY KEY (inquiry_id, kind)
);
-- the replay lookup and both limiter windows read the newest rows of one key
CREATE INDEX inquiry_admissions_by_key ON kauro.inquiry_admissions (kind, key_hash, admitted_at);

ALTER TABLE kauro.inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.inquiries FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.inquiry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.inquiry_events FORCE ROW LEVEL SECURITY;
ALTER TABLE kauro.inquiry_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.inquiry_admissions FORCE ROW LEVEL SECURITY;

-- a request handler with no session and no tenant writes an inquiry, its event and its keys; only the keys can be read back (the
-- replay and the limiters), and no policy shows an inquiry or an event to anyone
CREATE POLICY inquiries_public_insert ON kauro.inquiries FOR INSERT TO kauro_app WITH CHECK (true);
CREATE POLICY inquiry_events_public_insert ON kauro.inquiry_events FOR INSERT TO kauro_app WITH CHECK (true);
CREATE POLICY inquiry_admissions_public_insert ON kauro.inquiry_admissions FOR INSERT TO kauro_app WITH CHECK (true);
CREATE POLICY inquiry_admissions_public_read ON kauro.inquiry_admissions FOR SELECT TO kauro_app USING (true);

GRANT INSERT ON kauro.inquiries TO kauro_app;
GRANT INSERT ON kauro.inquiry_events TO kauro_app;
GRANT SELECT, INSERT ON kauro.inquiry_admissions TO kauro_app;
