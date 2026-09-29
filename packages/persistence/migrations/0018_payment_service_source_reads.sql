-- 0018 — the B07 + B09 merge: the payment service's read of the source lifecycle's retention.
--
-- Authority: 07 "A fourteen-day price lifetime does not extend seven-day source retention", 09 "Quotes, reuploads and retention"
-- (a quote displays dataAvailableUntil and checkout rechecks it), 08 "Database isolation" (runtime identities hold only the
-- privileges they need; row security binds the tenant). Design: docs/design/B07-B09-merge.md (decision D-MERGE-3); B07 design §17
-- item 5, B09 design §15 item 5 and D-QUOTE-B7 (a quoted source's availability is the source lifecycle's retention record, read
-- through the platform's SourceAvailabilityReader), D-INT2-B4 (the payment service's replies project a quote the way the agency's
-- reads do: CMD028's and CMD029's conclusive answers carry the quote's checkout readiness, built in the payment service's SERVICE
-- unit of work).
--
-- kauro_payment reads, of the retention records of the one agency it adopted (kauro.agency_id; B09 D-SCOPE-B1), exactly the columns
-- that answer "available until when": the record's identity, its revision, its state and its two deadlines — never its anchor, its
-- policy, its client or its residuals — and it writes nothing. This file references only the objects of B07's 0012 and B09's 0013
-- (the payment service's runtime group); it adds no table, no function and no kind.
GRANT SELECT (retention_id, agency_id, revision_id, state, effective_deadline, hard_deadline) ON kauro.retention_records TO kauro_payment;
CREATE POLICY retention_records_payment_read ON kauro.retention_records FOR SELECT TO kauro_payment USING (agency_id = kauro.current_agency_id());
