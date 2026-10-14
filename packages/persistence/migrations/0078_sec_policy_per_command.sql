-- Migration 0078 — SEC defence in depth, lane OWNER-POLICY-FORALL-2: a
-- row-security policy names exactly the commands its role is granted. 102 kauro policies were FOR ALL for a runtime role that holds
-- no DELETE (and for most no UPDATE either): the privilege system denied the write, but the policy already said yes, so a grant widened
-- by one mistaken GRANT would have opened the row without any policy review. Each such policy becomes one policy per command the role
-- holds (table or column privilege): <name>_read FOR SELECT, <name>_record FOR INSERT, <name>_amend FOR UPDATE, with the predicate of
-- the FOR ALL policy (USING for SELECT, WITH CHECK for INSERT, both for UPDATE; a FOR ALL without WITH CHECK checks with its USING).
-- Behaviour is unchanged: the policies are permissive and per command the union equals the old one for every granted command.
-- Not touched: leases_control (kauro_control holds SELECT, INSERT, UPDATE and DELETE on kauro.leases: FOR ALL is exact) and
-- outbox_records_owner_bank / outbox_records_owner_route (lane OWNER-OUTBOX-POLICY, migration 0072). Idempotent.
DROP POLICY IF EXISTS agencies_tenant ON kauro.agencies;
DROP POLICY IF EXISTS agencies_tenant_read ON kauro.agencies;
DROP POLICY IF EXISTS agencies_tenant_record ON kauro.agencies;
DROP POLICY IF EXISTS agencies_tenant_amend ON kauro.agencies;
CREATE POLICY agencies_tenant_read ON kauro.agencies FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY agencies_tenant_record ON kauro.agencies FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY agencies_tenant_amend ON kauro.agencies FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS agency_buyer_types_tenant ON kauro.agency_buyer_types;
DROP POLICY IF EXISTS agency_buyer_types_tenant_read ON kauro.agency_buyer_types;
DROP POLICY IF EXISTS agency_buyer_types_tenant_record ON kauro.agency_buyer_types;
CREATE POLICY agency_buyer_types_tenant_read ON kauro.agency_buyer_types FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY agency_buyer_types_tenant_record ON kauro.agency_buyer_types FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS agency_execution_capacity_tenant ON kauro.agency_execution_capacity;
DROP POLICY IF EXISTS agency_execution_capacity_tenant_read ON kauro.agency_execution_capacity;
DROP POLICY IF EXISTS agency_execution_capacity_tenant_record ON kauro.agency_execution_capacity;
DROP POLICY IF EXISTS agency_execution_capacity_tenant_amend ON kauro.agency_execution_capacity;
CREATE POLICY agency_execution_capacity_tenant_read ON kauro.agency_execution_capacity FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY agency_execution_capacity_tenant_record ON kauro.agency_execution_capacity FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY agency_execution_capacity_tenant_amend ON kauro.agency_execution_capacity FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS agency_recurrence_payment ON kauro.agency_recurrence;
DROP POLICY IF EXISTS agency_recurrence_payment_read ON kauro.agency_recurrence;
DROP POLICY IF EXISTS agency_recurrence_payment_record ON kauro.agency_recurrence;
DROP POLICY IF EXISTS agency_recurrence_payment_amend ON kauro.agency_recurrence;
CREATE POLICY agency_recurrence_payment_read ON kauro.agency_recurrence FOR SELECT TO kauro_payment USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY agency_recurrence_payment_record ON kauro.agency_recurrence FOR INSERT TO kauro_payment WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY agency_recurrence_payment_amend ON kauro.agency_recurrence FOR UPDATE TO kauro_payment USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS attribution_claims_commission ON kauro.attribution_claims;
DROP POLICY IF EXISTS attribution_claims_commission_read ON kauro.attribution_claims;
DROP POLICY IF EXISTS attribution_claims_commission_amend ON kauro.attribution_claims;
CREATE POLICY attribution_claims_commission_read ON kauro.attribution_claims FOR SELECT TO kauro_commission USING (true);
CREATE POLICY attribution_claims_commission_amend ON kauro.attribution_claims FOR UPDATE TO kauro_commission USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bank_credits_service ON kauro.bank_credits;
DROP POLICY IF EXISTS bank_credits_service_read ON kauro.bank_credits;
DROP POLICY IF EXISTS bank_credits_service_record ON kauro.bank_credits;
DROP POLICY IF EXISTS bank_credits_service_amend ON kauro.bank_credits;
CREATE POLICY bank_credits_service_read ON kauro.bank_credits FOR SELECT TO kauro_payment USING (true);
CREATE POLICY bank_credits_service_record ON kauro.bank_credits FOR INSERT TO kauro_payment WITH CHECK (true);
CREATE POLICY bank_credits_service_amend ON kauro.bank_credits FOR UPDATE TO kauro_payment USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bank_review_cases_service ON kauro.bank_review_cases;
DROP POLICY IF EXISTS bank_review_cases_service_read ON kauro.bank_review_cases;
DROP POLICY IF EXISTS bank_review_cases_service_record ON kauro.bank_review_cases;
DROP POLICY IF EXISTS bank_review_cases_service_amend ON kauro.bank_review_cases;
CREATE POLICY bank_review_cases_service_read ON kauro.bank_review_cases FOR SELECT TO kauro_payment USING (true);
CREATE POLICY bank_review_cases_service_record ON kauro.bank_review_cases FOR INSERT TO kauro_payment WITH CHECK (true);
CREATE POLICY bank_review_cases_service_amend ON kauro.bank_review_cases FOR UPDATE TO kauro_payment USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bank_route_participants_owner ON kauro.bank_route_participants;
DROP POLICY IF EXISTS bank_route_participants_owner_read ON kauro.bank_route_participants;
DROP POLICY IF EXISTS bank_route_participants_owner_record ON kauro.bank_route_participants;
CREATE POLICY bank_route_participants_owner_read ON kauro.bank_route_participants FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY bank_route_participants_owner_record ON kauro.bank_route_participants FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());

DROP POLICY IF EXISTS bank_route_versions_owner ON kauro.bank_route_versions;
DROP POLICY IF EXISTS bank_route_versions_owner_read ON kauro.bank_route_versions;
DROP POLICY IF EXISTS bank_route_versions_owner_record ON kauro.bank_route_versions;
DROP POLICY IF EXISTS bank_route_versions_owner_amend ON kauro.bank_route_versions;
CREATE POLICY bank_route_versions_owner_read ON kauro.bank_route_versions FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY bank_route_versions_owner_record ON kauro.bank_route_versions FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY bank_route_versions_owner_amend ON kauro.bank_route_versions FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());

DROP POLICY IF EXISTS bank_routes_owner ON kauro.bank_routes;
DROP POLICY IF EXISTS bank_routes_owner_read ON kauro.bank_routes;
DROP POLICY IF EXISTS bank_routes_owner_record ON kauro.bank_routes;
DROP POLICY IF EXISTS bank_routes_owner_amend ON kauro.bank_routes;
CREATE POLICY bank_routes_owner_read ON kauro.bank_routes FOR SELECT TO kauro_app USING (kauro.acting_corporate_owner());
CREATE POLICY bank_routes_owner_record ON kauro.bank_routes FOR INSERT TO kauro_app WITH CHECK (kauro.acting_corporate_owner());
CREATE POLICY bank_routes_owner_amend ON kauro.bank_routes FOR UPDATE TO kauro_app USING (kauro.acting_corporate_owner()) WITH CHECK (kauro.acting_corporate_owner());

DROP POLICY IF EXISTS bank_source_freezes_service ON kauro.bank_source_freezes;
DROP POLICY IF EXISTS bank_source_freezes_service_read ON kauro.bank_source_freezes;
DROP POLICY IF EXISTS bank_source_freezes_service_record ON kauro.bank_source_freezes;
CREATE POLICY bank_source_freezes_service_read ON kauro.bank_source_freezes FOR SELECT TO kauro_payment USING (true);
CREATE POLICY bank_source_freezes_service_record ON kauro.bank_source_freezes FOR INSERT TO kauro_payment WITH CHECK (true);

DROP POLICY IF EXISTS bank_transfer_instructions_payment ON kauro.bank_transfer_instructions;
DROP POLICY IF EXISTS bank_transfer_instructions_payment_read ON kauro.bank_transfer_instructions;
DROP POLICY IF EXISTS bank_transfer_instructions_payment_amend ON kauro.bank_transfer_instructions;
CREATE POLICY bank_transfer_instructions_payment_read ON kauro.bank_transfer_instructions FOR SELECT TO kauro_payment USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY bank_transfer_instructions_payment_amend ON kauro.bank_transfer_instructions FOR UPDATE TO kauro_payment USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS bank_transfer_instructions_tenant ON kauro.bank_transfer_instructions;
DROP POLICY IF EXISTS bank_transfer_instructions_tenant_read ON kauro.bank_transfer_instructions;
DROP POLICY IF EXISTS bank_transfer_instructions_tenant_record ON kauro.bank_transfer_instructions;
CREATE POLICY bank_transfer_instructions_tenant_read ON kauro.bank_transfer_instructions FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY bank_transfer_instructions_tenant_record ON kauro.bank_transfer_instructions FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS banking_calendars_commission ON kauro.banking_calendars;
DROP POLICY IF EXISTS banking_calendars_commission_read ON kauro.banking_calendars;
DROP POLICY IF EXISTS banking_calendars_commission_record ON kauro.banking_calendars;
CREATE POLICY banking_calendars_commission_read ON kauro.banking_calendars FOR SELECT TO kauro_commission USING (true);
CREATE POLICY banking_calendars_commission_record ON kauro.banking_calendars FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS capabilities_control ON kauro.capabilities;
DROP POLICY IF EXISTS capabilities_control_read ON kauro.capabilities;
DROP POLICY IF EXISTS capabilities_control_record ON kauro.capabilities;
DROP POLICY IF EXISTS capabilities_control_amend ON kauro.capabilities;
CREATE POLICY capabilities_control_read ON kauro.capabilities FOR SELECT TO kauro_control USING (true);
CREATE POLICY capabilities_control_record ON kauro.capabilities FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY capabilities_control_amend ON kauro.capabilities FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS capture_facts_payment ON kauro.capture_facts;
DROP POLICY IF EXISTS capture_facts_payment_read ON kauro.capture_facts;
DROP POLICY IF EXISTS capture_facts_payment_record ON kauro.capture_facts;
DROP POLICY IF EXISTS capture_facts_payment_amend ON kauro.capture_facts;
CREATE POLICY capture_facts_payment_read ON kauro.capture_facts FOR SELECT TO kauro_payment USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY capture_facts_payment_record ON kauro.capture_facts FOR INSERT TO kauro_payment WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY capture_facts_payment_amend ON kauro.capture_facts FOR UPDATE TO kauro_payment USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS capture_funds_observations_commission ON kauro.capture_funds_observations;
DROP POLICY IF EXISTS capture_funds_observations_commission_read ON kauro.capture_funds_observations;
DROP POLICY IF EXISTS capture_funds_observations_commission_record ON kauro.capture_funds_observations;
CREATE POLICY capture_funds_observations_commission_read ON kauro.capture_funds_observations FOR SELECT TO kauro_commission USING (true);
CREATE POLICY capture_funds_observations_commission_record ON kauro.capture_funds_observations FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS command_journal_commission ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_commission_read ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_commission_record ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_commission_amend ON kauro.command_journal;
CREATE POLICY command_journal_commission_read ON kauro.command_journal FOR SELECT TO kauro_commission USING (((agency_id IS NULL) AND (actor_kind = 'SERVICE'::text) AND (actor_id = ANY (ARRAY['commission-service'::text, 'finance-service'::text]))));
CREATE POLICY command_journal_commission_record ON kauro.command_journal FOR INSERT TO kauro_commission WITH CHECK (((agency_id IS NULL) AND (actor_kind = 'SERVICE'::text) AND (actor_id = ANY (ARRAY['commission-service'::text, 'finance-service'::text]))));
CREATE POLICY command_journal_commission_amend ON kauro.command_journal FOR UPDATE TO kauro_commission USING (((agency_id IS NULL) AND (actor_kind = 'SERVICE'::text) AND (actor_id = ANY (ARRAY['commission-service'::text, 'finance-service'::text])))) WITH CHECK (((agency_id IS NULL) AND (actor_kind = 'SERVICE'::text) AND (actor_id = ANY (ARRAY['commission-service'::text, 'finance-service'::text]))));

DROP POLICY IF EXISTS command_journal_operations ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_operations_read ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_operations_record ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_operations_amend ON kauro.command_journal;
CREATE POLICY command_journal_operations_read ON kauro.command_journal FOR SELECT TO kauro_commission USING (((agency_id IS NULL) AND (actor_kind = 'SERVICE'::text) AND (actor_id = 'operations-service'::text)));
CREATE POLICY command_journal_operations_record ON kauro.command_journal FOR INSERT TO kauro_commission WITH CHECK (((agency_id IS NULL) AND (actor_kind = 'SERVICE'::text) AND (actor_id = 'operations-service'::text)));
CREATE POLICY command_journal_operations_amend ON kauro.command_journal FOR UPDATE TO kauro_commission USING (((agency_id IS NULL) AND (actor_kind = 'SERVICE'::text) AND (actor_id = 'operations-service'::text))) WITH CHECK (((agency_id IS NULL) AND (actor_kind = 'SERVICE'::text) AND (actor_id = 'operations-service'::text)));

DROP POLICY IF EXISTS command_journal_payment ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_payment_read ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_payment_record ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_payment_amend ON kauro.command_journal;
CREATE POLICY command_journal_payment_read ON kauro.command_journal FOR SELECT TO kauro_payment USING (((agency_id = kauro.current_agency_id()) AND (actor_kind = 'SERVICE'::text)));
CREATE POLICY command_journal_payment_record ON kauro.command_journal FOR INSERT TO kauro_payment WITH CHECK (((agency_id = kauro.current_agency_id()) AND (actor_kind = 'SERVICE'::text)));
CREATE POLICY command_journal_payment_amend ON kauro.command_journal FOR UPDATE TO kauro_payment USING (((agency_id = kauro.current_agency_id()) AND (actor_kind = 'SERVICE'::text))) WITH CHECK (((agency_id = kauro.current_agency_id()) AND (actor_kind = 'SERVICE'::text)));

DROP POLICY IF EXISTS command_journal_tenant ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_tenant_read ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_tenant_record ON kauro.command_journal;
DROP POLICY IF EXISTS command_journal_tenant_amend ON kauro.command_journal;
CREATE POLICY command_journal_tenant_read ON kauro.command_journal FOR SELECT TO kauro_app USING ((((agency_id IS NOT NULL) AND (agency_id = kauro.current_agency_id())) OR ((agency_id IS NULL) AND (actor_kind = 'USER'::text) AND (actor_id = (kauro.current_user_id())::text))));
CREATE POLICY command_journal_tenant_record ON kauro.command_journal FOR INSERT TO kauro_app WITH CHECK ((((agency_id IS NOT NULL) AND (agency_id = kauro.current_agency_id())) OR ((agency_id IS NULL) AND (actor_kind = 'USER'::text) AND (actor_id = (kauro.current_user_id())::text))));
CREATE POLICY command_journal_tenant_amend ON kauro.command_journal FOR UPDATE TO kauro_app USING ((((agency_id IS NOT NULL) AND (agency_id = kauro.current_agency_id())) OR ((agency_id IS NULL) AND (actor_kind = 'USER'::text) AND (actor_id = (kauro.current_user_id())::text)))) WITH CHECK ((((agency_id IS NOT NULL) AND (agency_id = kauro.current_agency_id())) OR ((agency_id IS NULL) AND (actor_kind = 'USER'::text) AND (actor_id = (kauro.current_user_id())::text))));

DROP POLICY IF EXISTS commercial_transitions_commission ON kauro.commercial_transitions;
DROP POLICY IF EXISTS commercial_transitions_commission_read ON kauro.commercial_transitions;
DROP POLICY IF EXISTS commercial_transitions_commission_record ON kauro.commercial_transitions;
CREATE POLICY commercial_transitions_commission_read ON kauro.commercial_transitions FOR SELECT TO kauro_commission USING (((agency_id IS NULL) OR (agency_id = kauro.current_agency_id())));
CREATE POLICY commercial_transitions_commission_record ON kauro.commercial_transitions FOR INSERT TO kauro_commission WITH CHECK (((agency_id IS NULL) OR (agency_id = kauro.current_agency_id())));

DROP POLICY IF EXISTS commission_adjustments_commission ON kauro.commission_adjustments;
DROP POLICY IF EXISTS commission_adjustments_commission_read ON kauro.commission_adjustments;
DROP POLICY IF EXISTS commission_adjustments_commission_record ON kauro.commission_adjustments;
CREATE POLICY commission_adjustments_commission_read ON kauro.commission_adjustments FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_adjustments_commission_record ON kauro.commission_adjustments FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS commission_entitlements_commission ON kauro.commission_entitlements;
DROP POLICY IF EXISTS commission_entitlements_commission_read ON kauro.commission_entitlements;
DROP POLICY IF EXISTS commission_entitlements_commission_record ON kauro.commission_entitlements;
DROP POLICY IF EXISTS commission_entitlements_commission_amend ON kauro.commission_entitlements;
CREATE POLICY commission_entitlements_commission_read ON kauro.commission_entitlements FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_entitlements_commission_record ON kauro.commission_entitlements FOR INSERT TO kauro_commission WITH CHECK (true);
CREATE POLICY commission_entitlements_commission_amend ON kauro.commission_entitlements FOR UPDATE TO kauro_commission USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS commission_holds_commission ON kauro.commission_holds;
DROP POLICY IF EXISTS commission_holds_commission_read ON kauro.commission_holds;
DROP POLICY IF EXISTS commission_holds_commission_record ON kauro.commission_holds;
DROP POLICY IF EXISTS commission_holds_commission_amend ON kauro.commission_holds;
CREATE POLICY commission_holds_commission_read ON kauro.commission_holds FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_holds_commission_record ON kauro.commission_holds FOR INSERT TO kauro_commission WITH CHECK (true);
CREATE POLICY commission_holds_commission_amend ON kauro.commission_holds FOR UPDATE TO kauro_commission USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS commission_lines_commission ON kauro.commission_lines;
DROP POLICY IF EXISTS commission_lines_commission_read ON kauro.commission_lines;
DROP POLICY IF EXISTS commission_lines_commission_record ON kauro.commission_lines;
DROP POLICY IF EXISTS commission_lines_commission_amend ON kauro.commission_lines;
CREATE POLICY commission_lines_commission_read ON kauro.commission_lines FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_lines_commission_record ON kauro.commission_lines FOR INSERT TO kauro_commission WITH CHECK (true);
CREATE POLICY commission_lines_commission_amend ON kauro.commission_lines FOR UPDATE TO kauro_commission USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS commission_noncash_settlements_commission ON kauro.commission_noncash_settlements;
DROP POLICY IF EXISTS commission_noncash_settlements_commission_read ON kauro.commission_noncash_settlements;
DROP POLICY IF EXISTS commission_noncash_settlements_commission_record ON kauro.commission_noncash_settlements;
CREATE POLICY commission_noncash_settlements_commission_read ON kauro.commission_noncash_settlements FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_noncash_settlements_commission_record ON kauro.commission_noncash_settlements FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS commission_offset_releases_commission ON kauro.commission_offset_releases;
DROP POLICY IF EXISTS commission_offset_releases_commission_read ON kauro.commission_offset_releases;
DROP POLICY IF EXISTS commission_offset_releases_commission_record ON kauro.commission_offset_releases;
CREATE POLICY commission_offset_releases_commission_read ON kauro.commission_offset_releases FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_offset_releases_commission_record ON kauro.commission_offset_releases FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS commission_offsets_commission ON kauro.commission_offsets;
DROP POLICY IF EXISTS commission_offsets_commission_read ON kauro.commission_offsets;
DROP POLICY IF EXISTS commission_offsets_commission_record ON kauro.commission_offsets;
CREATE POLICY commission_offsets_commission_read ON kauro.commission_offsets FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_offsets_commission_record ON kauro.commission_offsets FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS commission_periods_commission ON kauro.commission_periods;
DROP POLICY IF EXISTS commission_periods_commission_read ON kauro.commission_periods;
DROP POLICY IF EXISTS commission_periods_commission_record ON kauro.commission_periods;
DROP POLICY IF EXISTS commission_periods_commission_amend ON kauro.commission_periods;
CREATE POLICY commission_periods_commission_read ON kauro.commission_periods FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_periods_commission_record ON kauro.commission_periods FOR INSERT TO kauro_commission WITH CHECK (true);
CREATE POLICY commission_periods_commission_amend ON kauro.commission_periods FOR UPDATE TO kauro_commission USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS commission_pools_commission ON kauro.commission_pools;
DROP POLICY IF EXISTS commission_pools_commission_read ON kauro.commission_pools;
DROP POLICY IF EXISTS commission_pools_commission_record ON kauro.commission_pools;
DROP POLICY IF EXISTS commission_pools_commission_amend ON kauro.commission_pools;
CREATE POLICY commission_pools_commission_read ON kauro.commission_pools FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_pools_commission_record ON kauro.commission_pools FOR INSERT TO kauro_commission WITH CHECK (true);
CREATE POLICY commission_pools_commission_amend ON kauro.commission_pools FOR UPDATE TO kauro_commission USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS commission_statements_commission ON kauro.commission_statements;
DROP POLICY IF EXISTS commission_statements_commission_read ON kauro.commission_statements;
DROP POLICY IF EXISTS commission_statements_commission_record ON kauro.commission_statements;
DROP POLICY IF EXISTS commission_statements_commission_amend ON kauro.commission_statements;
CREATE POLICY commission_statements_commission_read ON kauro.commission_statements FOR SELECT TO kauro_commission USING (true);
CREATE POLICY commission_statements_commission_record ON kauro.commission_statements FOR INSERT TO kauro_commission WITH CHECK (true);
CREATE POLICY commission_statements_commission_amend ON kauro.commission_statements FOR UPDATE TO kauro_commission USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS compensation_guard_reviews_commission ON kauro.compensation_guard_reviews;
DROP POLICY IF EXISTS compensation_guard_reviews_commission_read ON kauro.compensation_guard_reviews;
DROP POLICY IF EXISTS compensation_guard_reviews_commission_record ON kauro.compensation_guard_reviews;
CREATE POLICY compensation_guard_reviews_commission_read ON kauro.compensation_guard_reviews FOR SELECT TO kauro_commission USING (true);
CREATE POLICY compensation_guard_reviews_commission_record ON kauro.compensation_guard_reviews FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS corporate_roles_control ON kauro.corporate_roles;
DROP POLICY IF EXISTS corporate_roles_control_read ON kauro.corporate_roles;
DROP POLICY IF EXISTS corporate_roles_control_record ON kauro.corporate_roles;
DROP POLICY IF EXISTS corporate_roles_control_amend ON kauro.corporate_roles;
CREATE POLICY corporate_roles_control_read ON kauro.corporate_roles FOR SELECT TO kauro_control USING (true);
CREATE POLICY corporate_roles_control_record ON kauro.corporate_roles FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY corporate_roles_control_amend ON kauro.corporate_roles FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS dataset_revisions_tenant ON kauro.dataset_revisions;
DROP POLICY IF EXISTS dataset_revisions_tenant_read ON kauro.dataset_revisions;
DROP POLICY IF EXISTS dataset_revisions_tenant_record ON kauro.dataset_revisions;
DROP POLICY IF EXISTS dataset_revisions_tenant_amend ON kauro.dataset_revisions;
CREATE POLICY dataset_revisions_tenant_read ON kauro.dataset_revisions FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY dataset_revisions_tenant_record ON kauro.dataset_revisions FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY dataset_revisions_tenant_amend ON kauro.dataset_revisions FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS dispatch_liabilities_control ON kauro.dispatch_liabilities;
DROP POLICY IF EXISTS dispatch_liabilities_control_read ON kauro.dispatch_liabilities;
DROP POLICY IF EXISTS dispatch_liabilities_control_record ON kauro.dispatch_liabilities;
DROP POLICY IF EXISTS dispatch_liabilities_control_amend ON kauro.dispatch_liabilities;
CREATE POLICY dispatch_liabilities_control_read ON kauro.dispatch_liabilities FOR SELECT TO kauro_control USING (true);
CREATE POLICY dispatch_liabilities_control_record ON kauro.dispatch_liabilities FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY dispatch_liabilities_control_amend ON kauro.dispatch_liabilities FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS domain_events_commission ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_commission_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_commission_record ON kauro.domain_events;
CREATE POLICY domain_events_commission_read ON kauro.domain_events FOR SELECT TO kauro_commission USING (((agency_id = kauro.current_agency_id()) AND (aggregate_kind = ANY (ARRAY['quote'::text, 'agency'::text]))));
CREATE POLICY domain_events_commission_record ON kauro.domain_events FOR INSERT TO kauro_commission WITH CHECK (((agency_id = kauro.current_agency_id()) AND (((aggregate_kind = 'quote'::text) AND (event_type = 'quote.expired.v1'::text)) OR ((aggregate_kind = 'agency'::text) AND (event_type = 'agency.first_purchase_designated.v1'::text)))));

DROP POLICY IF EXISTS domain_events_finance ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_finance_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_finance_record ON kauro.domain_events;
CREATE POLICY domain_events_finance_read ON kauro.domain_events FOR SELECT TO kauro_app USING ((kauro.in_finance_scope(agency_id) AND (aggregate_kind = ANY (ARRAY['quote'::text, 'payment_order'::text, 'payment_attempt'::text, 'capture'::text, 'commercial_authorization'::text, 'refund'::text, 'tax_document'::text, 'reconciliation_case'::text]))));
CREATE POLICY domain_events_finance_record ON kauro.domain_events FOR INSERT TO kauro_app WITH CHECK ((kauro.in_finance_scope(agency_id) AND (aggregate_kind = ANY (ARRAY['quote'::text, 'payment_order'::text, 'payment_attempt'::text, 'capture'::text, 'commercial_authorization'::text, 'refund'::text, 'tax_document'::text, 'reconciliation_case'::text]))));

DROP POLICY IF EXISTS domain_events_owner_bank ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_owner_bank_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_owner_bank_record ON kauro.domain_events;
CREATE POLICY domain_events_owner_bank_read ON kauro.domain_events FOR SELECT TO kauro_app USING (((agency_id IS NULL) AND (aggregate_kind = ANY (ARRAY['bank_credit'::text, 'statement_import'::text])) AND kauro.acting_corporate_owner()));
CREATE POLICY domain_events_owner_bank_record ON kauro.domain_events FOR INSERT TO kauro_app WITH CHECK (((agency_id IS NULL) AND (aggregate_kind = ANY (ARRAY['bank_credit'::text, 'statement_import'::text])) AND (split_part(event_type, '.'::text, 1) = aggregate_kind) AND kauro.acting_corporate_owner()));

DROP POLICY IF EXISTS domain_events_owner_route ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_owner_route_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_owner_route_record ON kauro.domain_events;
CREATE POLICY domain_events_owner_route_read ON kauro.domain_events FOR SELECT TO kauro_app USING (((agency_id IS NULL) AND (aggregate_kind = 'bank_route'::text) AND kauro.acting_corporate_owner()));
CREATE POLICY domain_events_owner_route_record ON kauro.domain_events FOR INSERT TO kauro_app WITH CHECK (((agency_id IS NULL) AND (aggregate_kind = 'bank_route'::text) AND (split_part(event_type, '.'::text, 1) = 'bank_route'::text) AND kauro.acting_corporate_owner()));

DROP POLICY IF EXISTS domain_events_payment ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_record ON kauro.domain_events;
CREATE POLICY domain_events_payment_read ON kauro.domain_events FOR SELECT TO kauro_payment USING (((agency_id = kauro.current_agency_id()) AND (aggregate_kind = ANY (ARRAY['quote'::text, 'payment_order'::text, 'payment_attempt'::text, 'capture'::text, 'commercial_authorization'::text, 'refund'::text, 'tax_document'::text, 'reconciliation_case'::text]))));
CREATE POLICY domain_events_payment_record ON kauro.domain_events FOR INSERT TO kauro_payment WITH CHECK (((agency_id = kauro.current_agency_id()) AND (aggregate_kind = ANY (ARRAY['quote'::text, 'payment_order'::text, 'payment_attempt'::text, 'capture'::text, 'commercial_authorization'::text, 'refund'::text, 'tax_document'::text, 'reconciliation_case'::text]))));

DROP POLICY IF EXISTS domain_events_payment_bank ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_bank_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_bank_record ON kauro.domain_events;
CREATE POLICY domain_events_payment_bank_read ON kauro.domain_events FOR SELECT TO kauro_payment USING (((agency_id IS NULL) AND (aggregate_kind = ANY (ARRAY['bank_credit'::text, 'statement_import'::text]))));
CREATE POLICY domain_events_payment_bank_record ON kauro.domain_events FOR INSERT TO kauro_payment WITH CHECK (((agency_id IS NULL) AND (aggregate_kind = ANY (ARRAY['bank_credit'::text, 'statement_import'::text])) AND (split_part(event_type, '.'::text, 1) = aggregate_kind)));

DROP POLICY IF EXISTS domain_events_payment_bank_order ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_bank_order_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_payment_bank_order_record ON kauro.domain_events;
CREATE POLICY domain_events_payment_bank_order_read ON kauro.domain_events FOR SELECT TO kauro_payment USING (((agency_id = kauro.current_agency_id()) AND (aggregate_kind = 'bank_transfer_instruction'::text)));
CREATE POLICY domain_events_payment_bank_order_record ON kauro.domain_events FOR INSERT TO kauro_payment WITH CHECK (((agency_id = kauro.current_agency_id()) AND (aggregate_kind = 'bank_transfer_instruction'::text) AND (event_type = 'bank_transfer_instruction.order_state_changed.v1'::text)));

DROP POLICY IF EXISTS domain_events_tenant ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_tenant_read ON kauro.domain_events;
DROP POLICY IF EXISTS domain_events_tenant_record ON kauro.domain_events;
CREATE POLICY domain_events_tenant_read ON kauro.domain_events FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY domain_events_tenant_record ON kauro.domain_events FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS end_clients_tenant ON kauro.end_clients;
DROP POLICY IF EXISTS end_clients_tenant_read ON kauro.end_clients;
DROP POLICY IF EXISTS end_clients_tenant_record ON kauro.end_clients;
DROP POLICY IF EXISTS end_clients_tenant_amend ON kauro.end_clients;
CREATE POLICY end_clients_tenant_read ON kauro.end_clients FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY end_clients_tenant_record ON kauro.end_clients FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY end_clients_tenant_amend ON kauro.end_clients FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS execution_capacity_control ON kauro.execution_capacity;
DROP POLICY IF EXISTS execution_capacity_control_read ON kauro.execution_capacity;
DROP POLICY IF EXISTS execution_capacity_control_amend ON kauro.execution_capacity;
CREATE POLICY execution_capacity_control_read ON kauro.execution_capacity FOR SELECT TO kauro_control USING (true);
CREATE POLICY execution_capacity_control_amend ON kauro.execution_capacity FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS execution_correlations_service ON kauro.execution_correlations;
DROP POLICY IF EXISTS execution_correlations_service_read ON kauro.execution_correlations;
DROP POLICY IF EXISTS execution_correlations_service_record ON kauro.execution_correlations;
CREATE POLICY execution_correlations_service_read ON kauro.execution_correlations FOR SELECT TO kauro_payment USING (true);
CREATE POLICY execution_correlations_service_record ON kauro.execution_correlations FOR INSERT TO kauro_payment WITH CHECK (true);

DROP POLICY IF EXISTS execution_offer_outcomes_service ON kauro.execution_offer_outcomes;
DROP POLICY IF EXISTS execution_offer_outcomes_service_read ON kauro.execution_offer_outcomes;
DROP POLICY IF EXISTS execution_offer_outcomes_service_record ON kauro.execution_offer_outcomes;
CREATE POLICY execution_offer_outcomes_service_read ON kauro.execution_offer_outcomes FOR SELECT TO kauro_payment USING (true);
CREATE POLICY execution_offer_outcomes_service_record ON kauro.execution_offer_outcomes FOR INSERT TO kauro_payment WITH CHECK (true);

DROP POLICY IF EXISTS execution_offers_service ON kauro.execution_offers;
DROP POLICY IF EXISTS execution_offers_service_read ON kauro.execution_offers;
DROP POLICY IF EXISTS execution_offers_service_record ON kauro.execution_offers;
CREATE POLICY execution_offers_service_read ON kauro.execution_offers FOR SELECT TO kauro_payment USING (true);
CREATE POLICY execution_offers_service_record ON kauro.execution_offers FOR INSERT TO kauro_payment WITH CHECK (true);

DROP POLICY IF EXISTS fiscal_issuers_control ON kauro.fiscal_issuers;
DROP POLICY IF EXISTS fiscal_issuers_control_read ON kauro.fiscal_issuers;
DROP POLICY IF EXISTS fiscal_issuers_control_record ON kauro.fiscal_issuers;
DROP POLICY IF EXISTS fiscal_issuers_control_amend ON kauro.fiscal_issuers;
CREATE POLICY fiscal_issuers_control_read ON kauro.fiscal_issuers FOR SELECT TO kauro_control USING (true);
CREATE POLICY fiscal_issuers_control_record ON kauro.fiscal_issuers FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY fiscal_issuers_control_amend ON kauro.fiscal_issuers FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS fiscal_profiles_finance ON kauro.fiscal_profiles;
DROP POLICY IF EXISTS fiscal_profiles_finance_read ON kauro.fiscal_profiles;
DROP POLICY IF EXISTS fiscal_profiles_finance_record ON kauro.fiscal_profiles;
DROP POLICY IF EXISTS fiscal_profiles_finance_amend ON kauro.fiscal_profiles;
CREATE POLICY fiscal_profiles_finance_read ON kauro.fiscal_profiles FOR SELECT TO kauro_app USING (kauro.in_finance_scope(agency_id));
CREATE POLICY fiscal_profiles_finance_record ON kauro.fiscal_profiles FOR INSERT TO kauro_app WITH CHECK ((kauro.in_finance_scope(agency_id) AND ((reviewed_by_user_id IS NULL) OR (reviewed_by_user_id = kauro.current_user_id()))));
CREATE POLICY fiscal_profiles_finance_amend ON kauro.fiscal_profiles FOR UPDATE TO kauro_app USING (kauro.in_finance_scope(agency_id)) WITH CHECK ((kauro.in_finance_scope(agency_id) AND ((reviewed_by_user_id IS NULL) OR (reviewed_by_user_id = kauro.current_user_id()))));

DROP POLICY IF EXISTS inbox_records_control ON kauro.inbox_records;
DROP POLICY IF EXISTS inbox_records_control_read ON kauro.inbox_records;
DROP POLICY IF EXISTS inbox_records_control_record ON kauro.inbox_records;
DROP POLICY IF EXISTS inbox_records_control_amend ON kauro.inbox_records;
CREATE POLICY inbox_records_control_read ON kauro.inbox_records FOR SELECT TO kauro_control USING (true);
CREATE POLICY inbox_records_control_record ON kauro.inbox_records FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY inbox_records_control_amend ON kauro.inbox_records FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ledger_entries_payment ON kauro.ledger_entries;
DROP POLICY IF EXISTS ledger_entries_payment_read ON kauro.ledger_entries;
DROP POLICY IF EXISTS ledger_entries_payment_record ON kauro.ledger_entries;
CREATE POLICY ledger_entries_payment_read ON kauro.ledger_entries FOR SELECT TO kauro_payment USING ((((agency_id IS NOT NULL) AND (agency_id = kauro.current_agency_id())) OR ((agency_id IS NULL) AND (kauro.current_agency_id() IS NULL))));
CREATE POLICY ledger_entries_payment_record ON kauro.ledger_entries FOR INSERT TO kauro_payment WITH CHECK ((((agency_id IS NOT NULL) AND (agency_id = kauro.current_agency_id())) OR ((agency_id IS NULL) AND (kauro.current_agency_id() IS NULL))));

DROP POLICY IF EXISTS membership_invitations_tenant ON kauro.membership_invitations;
DROP POLICY IF EXISTS membership_invitations_tenant_read ON kauro.membership_invitations;
DROP POLICY IF EXISTS membership_invitations_tenant_record ON kauro.membership_invitations;
DROP POLICY IF EXISTS membership_invitations_tenant_amend ON kauro.membership_invitations;
CREATE POLICY membership_invitations_tenant_read ON kauro.membership_invitations FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY membership_invitations_tenant_record ON kauro.membership_invitations FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY membership_invitations_tenant_amend ON kauro.membership_invitations FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS memberships_tenant ON kauro.memberships;
DROP POLICY IF EXISTS memberships_tenant_read ON kauro.memberships;
DROP POLICY IF EXISTS memberships_tenant_record ON kauro.memberships;
DROP POLICY IF EXISTS memberships_tenant_amend ON kauro.memberships;
CREATE POLICY memberships_tenant_read ON kauro.memberships FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY memberships_tenant_record ON kauro.memberships FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY memberships_tenant_amend ON kauro.memberships FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS object_hold_releases_tenant ON kauro.object_hold_releases;
DROP POLICY IF EXISTS object_hold_releases_tenant_read ON kauro.object_hold_releases;
DROP POLICY IF EXISTS object_hold_releases_tenant_record ON kauro.object_hold_releases;
DROP POLICY IF EXISTS object_hold_releases_tenant_amend ON kauro.object_hold_releases;
CREATE POLICY object_hold_releases_tenant_read ON kauro.object_hold_releases FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY object_hold_releases_tenant_record ON kauro.object_hold_releases FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY object_hold_releases_tenant_amend ON kauro.object_hold_releases FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS object_holds_tenant ON kauro.object_holds;
DROP POLICY IF EXISTS object_holds_tenant_read ON kauro.object_holds;
DROP POLICY IF EXISTS object_holds_tenant_record ON kauro.object_holds;
DROP POLICY IF EXISTS object_holds_tenant_amend ON kauro.object_holds;
CREATE POLICY object_holds_tenant_read ON kauro.object_holds FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY object_holds_tenant_record ON kauro.object_holds FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY object_holds_tenant_amend ON kauro.object_holds FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS outbound_execution_attempts_service ON kauro.outbound_execution_attempts;
DROP POLICY IF EXISTS outbound_execution_attempts_service_read ON kauro.outbound_execution_attempts;
DROP POLICY IF EXISTS outbound_execution_attempts_service_record ON kauro.outbound_execution_attempts;
DROP POLICY IF EXISTS outbound_execution_attempts_service_amend ON kauro.outbound_execution_attempts;
CREATE POLICY outbound_execution_attempts_service_read ON kauro.outbound_execution_attempts FOR SELECT TO kauro_payment USING (true);
CREATE POLICY outbound_execution_attempts_service_record ON kauro.outbound_execution_attempts FOR INSERT TO kauro_payment WITH CHECK (true);
CREATE POLICY outbound_execution_attempts_service_amend ON kauro.outbound_execution_attempts FOR UPDATE TO kauro_payment USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS outbox_records_control ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_control_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_control_record ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_control_amend ON kauro.outbox_records;
CREATE POLICY outbox_records_control_read ON kauro.outbox_records FOR SELECT TO kauro_control USING (true);
CREATE POLICY outbox_records_control_record ON kauro.outbox_records FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY outbox_records_control_amend ON kauro.outbox_records FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS outbox_records_finance ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_finance_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_finance_record ON kauro.outbox_records;
CREATE POLICY outbox_records_finance_read ON kauro.outbox_records FOR SELECT TO kauro_app USING ((EXISTS ( SELECT 1
   FROM kauro.domain_events e
  WHERE ((e.event_id = outbox_records.event_id) AND kauro.in_finance_scope(e.agency_id)))));
CREATE POLICY outbox_records_finance_record ON kauro.outbox_records FOR INSERT TO kauro_app WITH CHECK ((EXISTS ( SELECT 1
   FROM kauro.domain_events e
  WHERE ((e.event_id = outbox_records.event_id) AND kauro.in_finance_scope(e.agency_id)))));

DROP POLICY IF EXISTS outbox_records_payment ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_payment_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_payment_record ON kauro.outbox_records;
CREATE POLICY outbox_records_payment_read ON kauro.outbox_records FOR SELECT TO kauro_payment USING ((EXISTS ( SELECT 1
   FROM kauro.domain_events e
  WHERE ((e.event_id = outbox_records.event_id) AND (e.agency_id = kauro.current_agency_id())))));
CREATE POLICY outbox_records_payment_record ON kauro.outbox_records FOR INSERT TO kauro_payment WITH CHECK ((EXISTS ( SELECT 1
   FROM kauro.domain_events e
  WHERE ((e.event_id = outbox_records.event_id) AND (e.agency_id = kauro.current_agency_id())))));

DROP POLICY IF EXISTS outbox_records_payment_bank ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_payment_bank_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_payment_bank_record ON kauro.outbox_records;
CREATE POLICY outbox_records_payment_bank_read ON kauro.outbox_records FOR SELECT TO kauro_payment USING ((EXISTS ( SELECT 1
   FROM kauro.domain_events e
  WHERE ((e.event_id = outbox_records.event_id) AND (e.agency_id IS NULL) AND (e.aggregate_kind = ANY (ARRAY['bank_credit'::text, 'statement_import'::text]))))));
CREATE POLICY outbox_records_payment_bank_record ON kauro.outbox_records FOR INSERT TO kauro_payment WITH CHECK ((EXISTS ( SELECT 1
   FROM kauro.domain_events e
  WHERE ((e.event_id = outbox_records.event_id) AND (e.agency_id IS NULL) AND (e.aggregate_kind = ANY (ARRAY['bank_credit'::text, 'statement_import'::text]))))));

DROP POLICY IF EXISTS outbox_records_tenant ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_tenant_read ON kauro.outbox_records;
DROP POLICY IF EXISTS outbox_records_tenant_record ON kauro.outbox_records;
CREATE POLICY outbox_records_tenant_read ON kauro.outbox_records FOR SELECT TO kauro_app USING ((EXISTS ( SELECT 1
   FROM kauro.domain_events e
  WHERE ((e.event_id = outbox_records.event_id) AND (e.agency_id = kauro.current_agency_id())))));
CREATE POLICY outbox_records_tenant_record ON kauro.outbox_records FOR INSERT TO kauro_app WITH CHECK ((EXISTS ( SELECT 1
   FROM kauro.domain_events e
  WHERE ((e.event_id = outbox_records.event_id) AND (e.agency_id = kauro.current_agency_id())))));

DROP POLICY IF EXISTS payment_attempts_payment ON kauro.payment_attempts;
DROP POLICY IF EXISTS payment_attempts_payment_read ON kauro.payment_attempts;
DROP POLICY IF EXISTS payment_attempts_payment_record ON kauro.payment_attempts;
DROP POLICY IF EXISTS payment_attempts_payment_amend ON kauro.payment_attempts;
CREATE POLICY payment_attempts_payment_read ON kauro.payment_attempts FOR SELECT TO kauro_payment USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY payment_attempts_payment_record ON kauro.payment_attempts FOR INSERT TO kauro_payment WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY payment_attempts_payment_amend ON kauro.payment_attempts FOR UPDATE TO kauro_payment USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS payment_routes_control ON kauro.payment_routes;
DROP POLICY IF EXISTS payment_routes_control_read ON kauro.payment_routes;
DROP POLICY IF EXISTS payment_routes_control_record ON kauro.payment_routes;
DROP POLICY IF EXISTS payment_routes_control_amend ON kauro.payment_routes;
CREATE POLICY payment_routes_control_read ON kauro.payment_routes FOR SELECT TO kauro_control USING (true);
CREATE POLICY payment_routes_control_record ON kauro.payment_routes FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY payment_routes_control_amend ON kauro.payment_routes FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS payout_intents_commission ON kauro.payout_intents;
DROP POLICY IF EXISTS payout_intents_commission_read ON kauro.payout_intents;
DROP POLICY IF EXISTS payout_intents_commission_amend ON kauro.payout_intents;
CREATE POLICY payout_intents_commission_read ON kauro.payout_intents FOR SELECT TO kauro_commission USING (true);
CREATE POLICY payout_intents_commission_amend ON kauro.payout_intents FOR UPDATE TO kauro_commission USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS payout_reconciliations_commission ON kauro.payout_reconciliations;
DROP POLICY IF EXISTS payout_reconciliations_commission_read ON kauro.payout_reconciliations;
DROP POLICY IF EXISTS payout_reconciliations_commission_record ON kauro.payout_reconciliations;
CREATE POLICY payout_reconciliations_commission_read ON kauro.payout_reconciliations FOR SELECT TO kauro_commission USING (true);
CREATE POLICY payout_reconciliations_commission_record ON kauro.payout_reconciliations FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS plans_tenant ON kauro.plans;
DROP POLICY IF EXISTS plans_tenant_read ON kauro.plans;
DROP POLICY IF EXISTS plans_tenant_record ON kauro.plans;
DROP POLICY IF EXISTS plans_tenant_amend ON kauro.plans;
CREATE POLICY plans_tenant_read ON kauro.plans FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY plans_tenant_record ON kauro.plans FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY plans_tenant_amend ON kauro.plans FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS pool_liability_gates_control ON kauro.pool_liability_gates;
DROP POLICY IF EXISTS pool_liability_gates_control_read ON kauro.pool_liability_gates;
DROP POLICY IF EXISTS pool_liability_gates_control_record ON kauro.pool_liability_gates;
DROP POLICY IF EXISTS pool_liability_gates_control_amend ON kauro.pool_liability_gates;
CREATE POLICY pool_liability_gates_control_read ON kauro.pool_liability_gates FOR SELECT TO kauro_control USING (true);
CREATE POLICY pool_liability_gates_control_record ON kauro.pool_liability_gates FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY pool_liability_gates_control_amend ON kauro.pool_liability_gates FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS price_eligibility_snapshots_tenant ON kauro.price_eligibility_snapshots;
DROP POLICY IF EXISTS price_eligibility_snapshots_tenant_read ON kauro.price_eligibility_snapshots;
DROP POLICY IF EXISTS price_eligibility_snapshots_tenant_record ON kauro.price_eligibility_snapshots;
CREATE POLICY price_eligibility_snapshots_tenant_read ON kauro.price_eligibility_snapshots FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY price_eligibility_snapshots_tenant_record ON kauro.price_eligibility_snapshots FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS processing_authorities_tenant ON kauro.processing_authorities;
DROP POLICY IF EXISTS processing_authorities_tenant_read ON kauro.processing_authorities;
DROP POLICY IF EXISTS processing_authorities_tenant_record ON kauro.processing_authorities;
CREATE POLICY processing_authorities_tenant_read ON kauro.processing_authorities FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY processing_authorities_tenant_record ON kauro.processing_authorities FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS projects_tenant ON kauro.projects;
DROP POLICY IF EXISTS projects_tenant_read ON kauro.projects;
DROP POLICY IF EXISTS projects_tenant_record ON kauro.projects;
DROP POLICY IF EXISTS projects_tenant_amend ON kauro.projects;
CREATE POLICY projects_tenant_read ON kauro.projects FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY projects_tenant_record ON kauro.projects FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY projects_tenant_amend ON kauro.projects FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS provider_event_exceptions_payment ON kauro.provider_event_exceptions;
DROP POLICY IF EXISTS provider_event_exceptions_payment_read ON kauro.provider_event_exceptions;
DROP POLICY IF EXISTS provider_event_exceptions_payment_record ON kauro.provider_event_exceptions;
CREATE POLICY provider_event_exceptions_payment_read ON kauro.provider_event_exceptions FOR SELECT TO kauro_payment USING ((((agency_id IS NULL) AND (kauro.current_agency_id() IS NULL)) OR (agency_id = kauro.current_agency_id())));
CREATE POLICY provider_event_exceptions_payment_record ON kauro.provider_event_exceptions FOR INSERT TO kauro_payment WITH CHECK ((((agency_id IS NULL) AND (kauro.current_agency_id() IS NULL)) OR (agency_id = kauro.current_agency_id())));

DROP POLICY IF EXISTS provider_observations_payment ON kauro.provider_observations;
DROP POLICY IF EXISTS provider_observations_payment_read ON kauro.provider_observations;
DROP POLICY IF EXISTS provider_observations_payment_record ON kauro.provider_observations;
CREATE POLICY provider_observations_payment_read ON kauro.provider_observations FOR SELECT TO kauro_payment USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY provider_observations_payment_record ON kauro.provider_observations FOR INSERT TO kauro_payment WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS purchase_completions_commission ON kauro.purchase_completions;
DROP POLICY IF EXISTS purchase_completions_commission_read ON kauro.purchase_completions;
DROP POLICY IF EXISTS purchase_completions_commission_record ON kauro.purchase_completions;
CREATE POLICY purchase_completions_commission_read ON kauro.purchase_completions FOR SELECT TO kauro_commission USING (true);
CREATE POLICY purchase_completions_commission_record ON kauro.purchase_completions FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS purchase_rebindings_payment ON kauro.purchase_rebindings;
DROP POLICY IF EXISTS purchase_rebindings_payment_read ON kauro.purchase_rebindings;
DROP POLICY IF EXISTS purchase_rebindings_payment_record ON kauro.purchase_rebindings;
CREATE POLICY purchase_rebindings_payment_read ON kauro.purchase_rebindings FOR SELECT TO kauro_payment USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY purchase_rebindings_payment_record ON kauro.purchase_rebindings FOR INSERT TO kauro_payment WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS qualifying_purchases_payment ON kauro.qualifying_purchases;
DROP POLICY IF EXISTS qualifying_purchases_payment_read ON kauro.qualifying_purchases;
DROP POLICY IF EXISTS qualifying_purchases_payment_record ON kauro.qualifying_purchases;
CREATE POLICY qualifying_purchases_payment_read ON kauro.qualifying_purchases FOR SELECT TO kauro_payment USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY qualifying_purchases_payment_record ON kauro.qualifying_purchases FOR INSERT TO kauro_payment WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS quote_issuances_tenant ON kauro.quote_issuances;
DROP POLICY IF EXISTS quote_issuances_tenant_read ON kauro.quote_issuances;
DROP POLICY IF EXISTS quote_issuances_tenant_record ON kauro.quote_issuances;
CREATE POLICY quote_issuances_tenant_read ON kauro.quote_issuances FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY quote_issuances_tenant_record ON kauro.quote_issuances FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS refund_destinations_service ON kauro.refund_destinations;
DROP POLICY IF EXISTS refund_destinations_service_read ON kauro.refund_destinations;
DROP POLICY IF EXISTS refund_destinations_service_record ON kauro.refund_destinations;
CREATE POLICY refund_destinations_service_read ON kauro.refund_destinations FOR SELECT TO kauro_payment USING (true);
CREATE POLICY refund_destinations_service_record ON kauro.refund_destinations FOR INSERT TO kauro_payment WITH CHECK (true);

DROP POLICY IF EXISTS refund_policies_control ON kauro.refund_policies;
DROP POLICY IF EXISTS refund_policies_control_read ON kauro.refund_policies;
DROP POLICY IF EXISTS refund_policies_control_record ON kauro.refund_policies;
DROP POLICY IF EXISTS refund_policies_control_amend ON kauro.refund_policies;
CREATE POLICY refund_policies_control_read ON kauro.refund_policies FOR SELECT TO kauro_control USING (true);
CREATE POLICY refund_policies_control_record ON kauro.refund_policies FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY refund_policies_control_amend ON kauro.refund_policies FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS request_journal_control ON kauro.request_journal;
DROP POLICY IF EXISTS request_journal_control_read ON kauro.request_journal;
DROP POLICY IF EXISTS request_journal_control_record ON kauro.request_journal;
DROP POLICY IF EXISTS request_journal_control_amend ON kauro.request_journal;
CREATE POLICY request_journal_control_read ON kauro.request_journal FOR SELECT TO kauro_control USING (true);
CREATE POLICY request_journal_control_record ON kauro.request_journal FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY request_journal_control_amend ON kauro.request_journal FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS restore_candidates_control ON kauro.restore_candidates;
DROP POLICY IF EXISTS restore_candidates_control_read ON kauro.restore_candidates;
DROP POLICY IF EXISTS restore_candidates_control_record ON kauro.restore_candidates;
CREATE POLICY restore_candidates_control_read ON kauro.restore_candidates FOR SELECT TO kauro_control USING (true);
CREATE POLICY restore_candidates_control_record ON kauro.restore_candidates FOR INSERT TO kauro_control WITH CHECK (true);

DROP POLICY IF EXISTS revision_quota_control ON kauro.revision_quota;
DROP POLICY IF EXISTS revision_quota_control_read ON kauro.revision_quota;
DROP POLICY IF EXISTS revision_quota_control_record ON kauro.revision_quota;
DROP POLICY IF EXISTS revision_quota_control_amend ON kauro.revision_quota;
CREATE POLICY revision_quota_control_read ON kauro.revision_quota FOR SELECT TO kauro_control USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY revision_quota_control_record ON kauro.revision_quota FOR INSERT TO kauro_control WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY revision_quota_control_amend ON kauro.revision_quota FOR UPDATE TO kauro_control USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS revision_quota_tenant ON kauro.revision_quota;
DROP POLICY IF EXISTS revision_quota_tenant_read ON kauro.revision_quota;
DROP POLICY IF EXISTS revision_quota_tenant_record ON kauro.revision_quota;
DROP POLICY IF EXISTS revision_quota_tenant_amend ON kauro.revision_quota;
CREATE POLICY revision_quota_tenant_read ON kauro.revision_quota FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY revision_quota_tenant_record ON kauro.revision_quota FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY revision_quota_tenant_amend ON kauro.revision_quota FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS sealed_manifests_tenant ON kauro.sealed_manifests;
DROP POLICY IF EXISTS sealed_manifests_tenant_read ON kauro.sealed_manifests;
DROP POLICY IF EXISTS sealed_manifests_tenant_record ON kauro.sealed_manifests;
CREATE POLICY sealed_manifests_tenant_read ON kauro.sealed_manifests FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY sealed_manifests_tenant_record ON kauro.sealed_manifests FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS sealed_revision_files_tenant ON kauro.sealed_revision_files;
DROP POLICY IF EXISTS sealed_revision_files_tenant_read ON kauro.sealed_revision_files;
DROP POLICY IF EXISTS sealed_revision_files_tenant_record ON kauro.sealed_revision_files;
CREATE POLICY sealed_revision_files_tenant_read ON kauro.sealed_revision_files FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY sealed_revision_files_tenant_record ON kauro.sealed_revision_files FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS security_events_control ON kauro.security_events;
DROP POLICY IF EXISTS security_events_control_read ON kauro.security_events;
DROP POLICY IF EXISTS security_events_control_record ON kauro.security_events;
CREATE POLICY security_events_control_read ON kauro.security_events FOR SELECT TO kauro_control USING (true);
CREATE POLICY security_events_control_record ON kauro.security_events FOR INSERT TO kauro_control WITH CHECK (true);

DROP POLICY IF EXISTS seller_credit_entries_commission ON kauro.seller_credit_entries;
DROP POLICY IF EXISTS seller_credit_entries_commission_read ON kauro.seller_credit_entries;
DROP POLICY IF EXISTS seller_credit_entries_commission_record ON kauro.seller_credit_entries;
CREATE POLICY seller_credit_entries_commission_read ON kauro.seller_credit_entries FOR SELECT TO kauro_commission USING (true);
CREATE POLICY seller_credit_entries_commission_record ON kauro.seller_credit_entries FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS service_agreement_versions_control ON kauro.service_agreement_versions;
DROP POLICY IF EXISTS service_agreement_versions_control_read ON kauro.service_agreement_versions;
DROP POLICY IF EXISTS service_agreement_versions_control_record ON kauro.service_agreement_versions;
DROP POLICY IF EXISTS service_agreement_versions_control_amend ON kauro.service_agreement_versions;
CREATE POLICY service_agreement_versions_control_read ON kauro.service_agreement_versions FOR SELECT TO kauro_control USING (true);
CREATE POLICY service_agreement_versions_control_record ON kauro.service_agreement_versions FOR INSERT TO kauro_control WITH CHECK (true);
CREATE POLICY service_agreement_versions_control_amend ON kauro.service_agreement_versions FOR UPDATE TO kauro_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS settlements_payment ON kauro.settlements;
DROP POLICY IF EXISTS settlements_payment_read ON kauro.settlements;
DROP POLICY IF EXISTS settlements_payment_record ON kauro.settlements;
CREATE POLICY settlements_payment_read ON kauro.settlements FOR SELECT TO kauro_payment USING (true);
CREATE POLICY settlements_payment_record ON kauro.settlements FOR INSERT TO kauro_payment WITH CHECK (true);

DROP POLICY IF EXISTS statement_coverage_service ON kauro.statement_coverage;
DROP POLICY IF EXISTS statement_coverage_service_read ON kauro.statement_coverage;
DROP POLICY IF EXISTS statement_coverage_service_record ON kauro.statement_coverage;
CREATE POLICY statement_coverage_service_read ON kauro.statement_coverage FOR SELECT TO kauro_payment USING (true);
CREATE POLICY statement_coverage_service_record ON kauro.statement_coverage FOR INSERT TO kauro_payment WITH CHECK (true);

DROP POLICY IF EXISTS statement_imports_service ON kauro.statement_imports;
DROP POLICY IF EXISTS statement_imports_service_read ON kauro.statement_imports;
DROP POLICY IF EXISTS statement_imports_service_record ON kauro.statement_imports;
CREATE POLICY statement_imports_service_read ON kauro.statement_imports FOR SELECT TO kauro_payment USING (true);
CREATE POLICY statement_imports_service_record ON kauro.statement_imports FOR INSERT TO kauro_payment WITH CHECK (true);

DROP POLICY IF EXISTS statement_items_commission ON kauro.statement_items;
DROP POLICY IF EXISTS statement_items_commission_read ON kauro.statement_items;
DROP POLICY IF EXISTS statement_items_commission_record ON kauro.statement_items;
CREATE POLICY statement_items_commission_read ON kauro.statement_items FOR SELECT TO kauro_commission USING (true);
CREATE POLICY statement_items_commission_record ON kauro.statement_items FOR INSERT TO kauro_commission WITH CHECK (true);

DROP POLICY IF EXISTS statement_lines_service ON kauro.statement_lines;
DROP POLICY IF EXISTS statement_lines_service_read ON kauro.statement_lines;
DROP POLICY IF EXISTS statement_lines_service_record ON kauro.statement_lines;
DROP POLICY IF EXISTS statement_lines_service_amend ON kauro.statement_lines;
CREATE POLICY statement_lines_service_read ON kauro.statement_lines FOR SELECT TO kauro_payment USING (true);
CREATE POLICY statement_lines_service_record ON kauro.statement_lines FOR INSERT TO kauro_payment WITH CHECK (true);
CREATE POLICY statement_lines_service_amend ON kauro.statement_lines FOR UPDATE TO kauro_payment USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS storage_location_policies_control ON kauro.storage_location_policies;
DROP POLICY IF EXISTS storage_location_policies_control_read ON kauro.storage_location_policies;
DROP POLICY IF EXISTS storage_location_policies_control_record ON kauro.storage_location_policies;
CREATE POLICY storage_location_policies_control_read ON kauro.storage_location_policies FOR SELECT TO kauro_control USING (true);
CREATE POLICY storage_location_policies_control_record ON kauro.storage_location_policies FOR INSERT TO kauro_control WITH CHECK (true);

DROP POLICY IF EXISTS support_cases_tenant ON kauro.support_cases;
DROP POLICY IF EXISTS support_cases_tenant_read ON kauro.support_cases;
DROP POLICY IF EXISTS support_cases_tenant_record ON kauro.support_cases;
CREATE POLICY support_cases_tenant_read ON kauro.support_cases FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY support_cases_tenant_record ON kauro.support_cases FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS target_contracts_tenant ON kauro.target_contracts;
DROP POLICY IF EXISTS target_contracts_tenant_read ON kauro.target_contracts;
DROP POLICY IF EXISTS target_contracts_tenant_record ON kauro.target_contracts;
DROP POLICY IF EXISTS target_contracts_tenant_amend ON kauro.target_contracts;
CREATE POLICY target_contracts_tenant_read ON kauro.target_contracts FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY target_contracts_tenant_record ON kauro.target_contracts FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY target_contracts_tenant_amend ON kauro.target_contracts FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS tax_documents_payment ON kauro.tax_documents;
DROP POLICY IF EXISTS tax_documents_payment_read ON kauro.tax_documents;
DROP POLICY IF EXISTS tax_documents_payment_record ON kauro.tax_documents;
DROP POLICY IF EXISTS tax_documents_payment_amend ON kauro.tax_documents;
CREATE POLICY tax_documents_payment_read ON kauro.tax_documents FOR SELECT TO kauro_payment USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY tax_documents_payment_record ON kauro.tax_documents FOR INSERT TO kauro_payment WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY tax_documents_payment_amend ON kauro.tax_documents FOR UPDATE TO kauro_payment USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS treasury_refunds_service ON kauro.treasury_refunds;
DROP POLICY IF EXISTS treasury_refunds_service_read ON kauro.treasury_refunds;
DROP POLICY IF EXISTS treasury_refunds_service_record ON kauro.treasury_refunds;
DROP POLICY IF EXISTS treasury_refunds_service_amend ON kauro.treasury_refunds;
CREATE POLICY treasury_refunds_service_read ON kauro.treasury_refunds FOR SELECT TO kauro_payment USING (true);
CREATE POLICY treasury_refunds_service_record ON kauro.treasury_refunds FOR INSERT TO kauro_payment WITH CHECK (true);
CREATE POLICY treasury_refunds_service_amend ON kauro.treasury_refunds FOR UPDATE TO kauro_payment USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS upload_capacity_control ON kauro.upload_capacity;
DROP POLICY IF EXISTS upload_capacity_control_read ON kauro.upload_capacity;
DROP POLICY IF EXISTS upload_capacity_control_record ON kauro.upload_capacity;
DROP POLICY IF EXISTS upload_capacity_control_amend ON kauro.upload_capacity;
CREATE POLICY upload_capacity_control_read ON kauro.upload_capacity FOR SELECT TO kauro_control USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY upload_capacity_control_record ON kauro.upload_capacity FOR INSERT TO kauro_control WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY upload_capacity_control_amend ON kauro.upload_capacity FOR UPDATE TO kauro_control USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS upload_capacity_tenant ON kauro.upload_capacity;
DROP POLICY IF EXISTS upload_capacity_tenant_read ON kauro.upload_capacity;
DROP POLICY IF EXISTS upload_capacity_tenant_record ON kauro.upload_capacity;
DROP POLICY IF EXISTS upload_capacity_tenant_amend ON kauro.upload_capacity;
CREATE POLICY upload_capacity_tenant_read ON kauro.upload_capacity FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY upload_capacity_tenant_record ON kauro.upload_capacity FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY upload_capacity_tenant_amend ON kauro.upload_capacity FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));

DROP POLICY IF EXISTS upload_sessions_tenant ON kauro.upload_sessions;
DROP POLICY IF EXISTS upload_sessions_tenant_read ON kauro.upload_sessions;
DROP POLICY IF EXISTS upload_sessions_tenant_record ON kauro.upload_sessions;
DROP POLICY IF EXISTS upload_sessions_tenant_amend ON kauro.upload_sessions;
CREATE POLICY upload_sessions_tenant_read ON kauro.upload_sessions FOR SELECT TO kauro_app USING ((agency_id = kauro.current_agency_id()));
CREATE POLICY upload_sessions_tenant_record ON kauro.upload_sessions FOR INSERT TO kauro_app WITH CHECK ((agency_id = kauro.current_agency_id()));
CREATE POLICY upload_sessions_tenant_amend ON kauro.upload_sessions FOR UPDATE TO kauro_app USING ((agency_id = kauro.current_agency_id())) WITH CHECK ((agency_id = kauro.current_agency_id()));
