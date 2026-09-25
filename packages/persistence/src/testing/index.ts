/**
 * @kauro/persistence/testing — the test-only surface of the persistence package: the temporary PostgreSQL 17 cluster
 * (initdb/pg_ctl on a free 127.0.0.1 port, the migrations applied as the owner, one login role in each runtime group:
 * kauro_app, kauro_control, kauro_assurance and kauro_validator), the harness of verified pools and fixtures written through
 * the adapters and the evidence recorders, and the deterministic interleaving helpers (lock-wait observation, barrier).
 *
 * It is a separate export subpath so that no production import graph carries process-spawning test code: the package's
 * main entry (`@kauro/persistence`) exports none of it, and the architecture gate refuses an import of this subpath from any
 * production source file (architecture.rules.json `testOnlySubpaths`). Tests of this package and of the entrypoints import
 * it; nothing is ever wired into a deployment.
 */
export { startTemporaryPostgres, ROLES } from "./temporary-postgres.js";
export type { TemporaryPostgres, StartOptions, LoginRole } from "./temporary-postgres.js";
export { start as startHarness, waitForLockWait, settlesOrWaits, backendPid, barrier, CAPABILITY_PUBLICATION_PATH } from "./harness.js";
export type { Harness, AgencyFixture, CapabilityPublicationState, LockObservation } from "./harness.js";
