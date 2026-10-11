# Amendment A5 — library packages share their platform commands with B08

Status: adopted 2026-10-01 under the owner's standing delegation of design decisions (2026-09-25, confirmed 2026-09-28); the
owner is informed in the daily report of 2026-10-01 and may revoke it. Triggers: Codex re-check of Migration Core 2.0.3
(`fix/mc-203-m4` 605a9f2, finding B01-R9 "CMD024's transactional product operation remains absent") and Codex re-check of
Intelligence Core B03 (`ic/b03-integration` b3dde76, finding B03-R1 "durable platform command closure remains missing").

## Problem

`reference/ACCEPTANCE_SCENARIOS.md` assigns ValidatePlan (CMD024-OK/DENY/RACE) to package B01 (Migration Core) and StartAudit,
CancelAudit and CreatePlan (CMD020, CMD021, CMD022, each OK/DENY/RACE) to package B03 (Intelligence Core). The command catalogue
gives each of these commands a tenant, a role, an aggregate version, an idempotency key, a committed record and crash recovery
at the intent/commit boundary. Both cores are libraries without a database, tenants or roles; those live in the platform, whose
handlers for all four commands belong to B08 (its prompt lists CMD020, CMD021, CMD022 and CMD024 in its command inventory). No
core commit can execute the transactional half, and a core document cannot reassign authority cases.

## Rule

1. Each of the twelve cases (CMD020-*, CMD021-*, CMD022-*, CMD024-*) has two halves, both required before the case is EXECUTED:
   - **Core half (semantic):** through the public API of the clean installed core package (MC for CMD024, IC for
     CMD020-022), the case's deterministic behaviour holds — for CMD024 full-data validation with a complete receipt and
     evidence hashes, invalid receipts never VALID; for CMD020-022 audit start/cancel/plan compilation with complete accounting,
     bounded budgets and no partial effect on refusal; identical input gives identical output. Oracle and verification text of
     the case unchanged.
   - **B08 half (transactional):** tenant and role checks, aggregate version, idempotent retry, conflicting same-key request,
     crash at the intent/commit boundary, the record persisted exactly once in PostgreSQL, no unauthorized committed state or
     external effect.
2. The core package's case map records these cases as PARTIAL naming B08, as A4 allows for every case whose remainder belongs to
   a later package. The core package can be accepted with those rows; a case becomes EXECUTED only when B08 lands its half
   against the released core package.
3. Gates G-MC-SEMANTICS and G-IC-KERNEL keep the core half; the B08 half is checked at B08's package close.
4. Nothing else changes: the 441 cases, the commands, contracts and the vendored registry stay byte-identical; this file is the
   record of the split until the next authority re-issue folds it into the scenarios.
