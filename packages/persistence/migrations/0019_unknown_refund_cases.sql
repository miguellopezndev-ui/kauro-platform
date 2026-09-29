-- 0019 — the B09 package-close review (finding B09-R1): a provider refund no local refund explains is its own case.
--
-- Authority: 15 "Operational ledger" ("Unexplained differences create a case with amount and age. They do not enter a generic
-- 'miscellaneous' account without review"), 15 "Refund policy and calculation" and 10 "Provider adapter contract" (a provider refund
-- is bound to a local refund by identity, never by amount). Design: docs/design/B09-payments-fiscal.md §4.4 and "Review findings"
-- (B09-R1).
--
-- The reconciler binds a provider refund to a local refund only by its provider refund id, the attempt's own dispatch response or the
-- platform's refund reference the request carried; any other provider refund of a capture — one made outside the platform, or one
-- that claims a refund that already completed with another — is money no local refund explains, and each is its own
-- PROVIDER_INCONSISTENCY / UNKNOWN_REFUND case with its own amount. Before this migration a case's subject was only its order, capture
-- and refund, so a second unexplained refund of the same capture — or any open inconsistency of that capture — absorbed it into an
-- open case of another amount. `provider_ref` names the provider object a case is about when no local fact holds it, it is part of the
-- one-open-case subject, it is set once, and it is only ever the object of a capture the case names.
ALTER TABLE kauro.reconciliation_cases ADD COLUMN provider_ref text CHECK (provider_ref IS NULL OR kauro.is_provider_ref(provider_ref));
ALTER TABLE kauro.reconciliation_cases ADD CONSTRAINT reconciliation_cases_provider_ref_capture CHECK (provider_ref IS NULL OR capture_id IS NOT NULL);

DROP INDEX kauro.reconciliation_cases_one_open;
CREATE UNIQUE INDEX reconciliation_cases_one_open ON kauro.reconciliation_cases (
  agency_id, kind,
  coalesce(order_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(capture_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(refund_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(provider_ref, '')
) WHERE state = 'OPEN';

DROP TRIGGER reconciliation_cases_immutable ON kauro.reconciliation_cases;
CREATE TRIGGER reconciliation_cases_immutable BEFORE UPDATE ON kauro.reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION kauro.forbid_column_change('case_id,agency_id,order_id,capture_id,refund_id,provider_ref,kind,detail_code,amount_cents,currency,evidence_hash,opened_at,created_at');
