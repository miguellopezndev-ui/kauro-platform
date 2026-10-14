-- Migration 0089 (provisional number; the coordinator renumbers at merge): B12 lane L-HOME, R2-066 and GAP-HO-1.
--
-- A TERMINATED (or SUSPENDED) seller keeps its home, its statements and its support route (12 "Seller onboarding and access lifecycle",
-- 17 "Termination and tail"), but it must see no prospect data: no prospect, contact, source evidence, suppression, draft, intent,
-- activity or sender row. Until now the prospect-data read policies named kauro.current_seller_id() (the seller row in any state) or the
-- recorder's user id, so a terminated seller still read what it had recorded. They now require kauro.acting_seller_id() (the session's
-- seller while ACTIVE). The owner's policies are untouched. The statement, payout, claim and assignment policies keep current_seller_id():
-- a terminated seller reads its own money records. acting_seller_id() reads the seller row after the caller's transition lock (L1), so a
-- CMD050 committed before the read gives zero rows and one committed after gives the rows (GAP-HO-1).

-- the four prospect-data policies of 0029
ALTER POLICY prospects_seller_read ON kauro.prospects
  USING (registered_by_seller_id = kauro.acting_seller_id() OR owner_seller_id = kauro.acting_seller_id());
ALTER POLICY prospect_source_evidence_self_read ON kauro.prospect_source_evidence
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND recorded_by_user_id = kauro.current_user_id());
ALTER POLICY prospect_contacts_self_read ON kauro.prospect_contacts
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND recorded_by_user_id = kauro.current_user_id());
ALTER POLICY prospect_suppressions_read ON kauro.prospect_suppressions
  USING (kauro.acting_seller_id() IS NOT NULL OR kauro.acting_corporate_owner());

-- every B12 table a seller reads by its own user id or by the prospect it owns (0072)
ALTER POLICY prospect_contact_addresses_self_read ON kauro.prospect_contact_addresses
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND recorded_by_user_id = kauro.current_user_id());
ALTER POLICY sender_identities_self_read ON kauro.sender_identities
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND user_id = kauro.current_user_id());
ALTER POLICY outreach_drafts_author_read ON kauro.outreach_drafts
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND author_user_id = kauro.current_user_id());
ALTER POLICY outreach_authorizations_sender_read ON kauro.outreach_authorizations
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND kauro.outreach_sender_owned(sender_id));
ALTER POLICY outreach_authorization_hashes_sender_read ON kauro.outreach_authorization_hashes
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND kauro.outreach_draft_authored(draft_id, true));
ALTER POLICY outreach_send_intents_person_read ON kauro.outreach_send_intents
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND person_user_id = kauro.current_user_id());
ALTER POLICY outreach_send_intents_prospect_read ON kauro.outreach_send_intents
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND kauro.outreach_prospect_visible(prospect_id));
ALTER POLICY sales_activities_recorder_read ON kauro.sales_activities
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND recorded_by_user_id = kauro.current_user_id());
ALTER POLICY sales_activities_prospect_read ON kauro.sales_activities
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND kauro.outreach_prospect_visible(prospect_id));
ALTER POLICY sales_activities_person_read ON kauro.sales_activities
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND kauro.outreach_intent_of_person(intent_id));
ALTER POLICY outreach_provider_warnings_person_read ON kauro.outreach_provider_warnings
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND person_user_id = kauro.current_user_id());
ALTER POLICY outreach_send_evidence_person_read ON kauro.outreach_send_evidence
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND kauro.outreach_intent_of_person(intent_id));
ALTER POLICY outreach_send_evidence_prospect_read ON kauro.outreach_send_evidence
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND kauro.outreach_intent_visible(intent_id));
ALTER POLICY outreach_diagnoses_person_read ON kauro.outreach_diagnoses
  USING (kauro.current_agency_id() IS NULL AND kauro.acting_seller_id() IS NOT NULL AND person_user_id = kauro.current_user_id());
