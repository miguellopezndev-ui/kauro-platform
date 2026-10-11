-- 0048 — B10-T1-b gaps D (RACE, EXPIRY) and L2 (RACE): the commission service's effect COMMIT is fenced by the dispatcher's lease
-- (PROVISIONAL number, renumbered at merge by tools/renumber-migration.mjs).
--
-- Authority: B10 failure matrix rows D (durable delivery claims) and L2 (settle of deliveries), B06 D-LEASE-1 / D-LEASE-3 (a claim
-- creates a monotonically increasing fence; an old live worker cannot publish after another owner advances it).
--
-- A COMMISSIONS effect runs in a SERVICE unit of work of kauro_commission, which until now could not see the dispatcher's lease: an
-- effect whose dispatcher lost the lease mid-effect committed all the same. kauro_commission now locks and reads the liveness of the one
-- lease kind it is fenced by (OUTBOX_DISPATCH), never changes it: the effect's last statement takes the lease row FOR SHARE under
-- (owner, fence, not expired) and the unit rolls back when no row answers. The share lock holds the row until COMMIT, so a takeover
-- (claim_lease's UPDATE) waits for the effect's COMMIT: it cannot interleave between the guard and the COMMIT. PostgreSQL requires
-- UPDATE on one column for SELECT ... FOR SHARE: the grant names resource_id, which leases_immutable refuses to change, and the UPDATE
-- policy's WITH CHECK (false) refuses every new row. No function, no SECURITY DEFINER, no table-level grant, no INSERT/DELETE.
CREATE POLICY leases_commission_read ON kauro.leases FOR SELECT TO kauro_commission
  USING (resource_kind = 'OUTBOX_DISPATCH');
CREATE POLICY leases_commission_lock ON kauro.leases FOR UPDATE TO kauro_commission
  USING (resource_kind = 'OUTBOX_DISPATCH') WITH CHECK (false);
GRANT SELECT (resource_kind, resource_id, owner_id, fence, expires_at) ON kauro.leases TO kauro_commission;
GRANT UPDATE (resource_id) ON kauro.leases TO kauro_commission;
