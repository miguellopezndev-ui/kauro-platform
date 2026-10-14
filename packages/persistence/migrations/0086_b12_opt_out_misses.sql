-- B12 lane L-ACT (provisional number 0086; the coordinator renumbers at integration): the public opt-out's miss limiter
-- (plan docs/design/B12-outreach-plan.md "Public opt-out", ADV-34, D-B12O-13). Only token lookups that MISS are counted, per client network
-- (the digest of the network, never the address), stamped and judged at kauro.effect_now(): the 21st miss in 60 s answers 429. A valid token
-- is never counted. Append-only; the outreach service (kauro_outreach) inserts and counts, nobody else reads.
CREATE TABLE kauro.outreach_opt_out_misses (
  miss_id         uuid PRIMARY KEY CHECK (kauro.is_uuid_v7(miss_id)),
  network_digest  text NOT NULL CHECK (kauro.is_sha256_hex(network_digest)),
  missed_at       timestamptz NOT NULL
);
CREATE INDEX outreach_opt_out_misses_by_network ON kauro.outreach_opt_out_misses (network_digest, missed_at DESC);

CREATE OR REPLACE FUNCTION kauro.outreach_opt_out_misses_birth() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS
$$
BEGIN
  NEW.missed_at := kauro.effect_now();
  RETURN NEW;
END
$$;
CREATE TRIGGER outreach_opt_out_misses_birth BEFORE INSERT ON kauro.outreach_opt_out_misses FOR EACH ROW EXECUTE FUNCTION kauro.outreach_opt_out_misses_birth();
CREATE TRIGGER outreach_opt_out_misses_append_only BEFORE UPDATE OR DELETE ON kauro.outreach_opt_out_misses FOR EACH ROW EXECUTE FUNCTION kauro.forbid_change();
REVOKE EXECUTE ON FUNCTION kauro.outreach_opt_out_misses_birth() FROM PUBLIC;

ALTER TABLE kauro.outreach_opt_out_misses ENABLE ROW LEVEL SECURITY;
ALTER TABLE kauro.outreach_opt_out_misses FORCE ROW LEVEL SECURITY;
CREATE POLICY outreach_opt_out_misses_read ON kauro.outreach_opt_out_misses FOR SELECT TO kauro_outreach USING (true);
CREATE POLICY outreach_opt_out_misses_record ON kauro.outreach_opt_out_misses FOR INSERT TO kauro_outreach WITH CHECK (true);
GRANT SELECT, INSERT ON kauro.outreach_opt_out_misses TO kauro_outreach;
