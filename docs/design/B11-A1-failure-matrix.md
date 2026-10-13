# B11 lane A1 failure-mode matrix (SetBuyerType, ListProjects)

Source rows: SCREENS-PLAN section 3, rows "A1 SetBuyerType" and "A1 ListProjects" (traces A1-T1, A1-T2). Template and columns:
`docs/design/FAILURE-MATRIX-TEMPLATE.md`. Every **C** cell names its test as `file :: "exact title"`; each test fails on the base
a474494 (no route, no table) and passes on this lane (red-proof in the commit message).

Tests: `B` = `apps/api/test/b11-buyer-type.test.ts`, `L` = `apps/api/test/b11-list-projects.test.ts`.

## CMD101 SetBuyerType (POST /api/v1/agencies/{agencyId}/buyer-type, AGENCY_OWNER, migration 0062)

One tenant transaction: membership lock, journal reserve, the agency row FOR NO KEY UPDATE, agency DRAFT or ACTIVE, the recorded row
(same value 200, other value 409 BUYER_TYPE_ALREADY_SET), INSERT agency_buyer_types v1, agency_buyer_type.recorded.v1, journal 201.

| Cell | Status | Proof |
|---|---|---|
| RACE (A1-T1) | **C** two owners, both orders, the second waits at the agency row and is 409 BUYER_TYPE_ALREADY_SET naming the first's type; one row, no 500 | B :: "RACE: two owners record different buyer types in both orders; one row, the second is BUYER_TYPE_ALREADY_SET, no 500" |
| TIMEOUT | **C** a lock wait past the statement timeout is 503 CAPACITY_UNAVAILABLE at the bound, nothing written; the same key then records once | B :: "TIMEOUT: a lock wait past the statement timeout writes nothing and the same key succeeds once" |
| EXPIRY | **N/A** A3 3.7 sets no window for the answer | — |
| CRASH-BEFORE | **C** a crash at the journal commit leaves no row, event or journal entry; the same key records once | B :: "CRASH-BEFORE: a crash at the journal commit leaves no row, event or journal entry, and the same key records it once" |
| CRASH-AFTER | **C** the answer lost after COMMIT leaves the recorded type; the same key replays the committed 201 | B :: "CRASH-AFTER: an answer lost after COMMIT leaves the recorded type, and the same key replays the committed 201" |
| RETRY | **C** identical replay = same bytes; same key other body = IDEMPOTENCY_CONFLICT; a new key with the same value = 200 content-idempotent, nothing written | B :: "RETRY: an identical replay answers the same bytes, the same key with another body is IDEMPOTENCY_CONFLICT, and a new key is idempotent on the content" |
| REVOCATION (A1-T2) | **C** closure (CMD043) and SetBuyerType in both orders on the agency row; after CLOSING it is 409 AGENCY_NOT_OPEN and nothing is written; role: non-member 404, VIEWER 403 | B :: "REVOCATION: closure and buyer type in both orders; after CLOSING no buyer type is written"; B :: "OK/DENY: OWNER only; a non-member 404, a VIEWER 403, a body without forEconomicActivity=true 400" |
| PARTIAL | **C** the event write failing after the row insert rolls back row and journal entry; the same key records once | B :: "PARTIAL: the event write failing after the row insert rolls back the row and the journal entry, and the same key records it once" |
| Consumers | **C** CMD027 BUYER_TYPE_UNSET until recorded, then issues; CMD047 reads it in the owner's context (in-house IN_HOUSE_NOT_ATTRIBUTABLE, agency accepted) | B :: "E2E: CreateQuote is BUYER_TYPE_UNSET until the owner records the buyer type through the api, then issues the quote"; B :: "E2E: AcceptAttribution reads the recorded type in the corporate owner's context — in-house is IN_HOUSE_NOT_ATTRIBUTABLE, agency is accepted" |

## ListProjects (GET /api/v1/agencies/{agencyId}/projects?filter=, keyset pages)

| Cell | Status | Proof |
|---|---|---|
| RACE | **N/A** one statement in one snapshot | — |
| TIMEOUT | **C** a read waiting on kauro.projects past the statement timeout is 503 CAPACITY_UNAVAILABLE at the bound; the next read answers | L :: "TIMEOUT: a dashboard read waiting past the statement timeout is 503 CAPACITY_UNAVAILABLE, and the next read answers" |
| EXPIRY, CRASH-BEFORE, CRASH-AFTER, RETRY | **N/A** a read writes nothing | — |
| REVOCATION | **C** a non-member is 404 NOT_A_MEMBER; unknown filter or member 400 SCHEMA_VIOLATION; a VIEWER reads | L :: "DENY: a non-member is 404 NOT_A_MEMBER, an unknown filter or query member is 400 SCHEMA_VIOLATION, and a VIEWER reads the dashboard" |
| PARTIAL | **C** keyset pages of a filter cover it exactly once; a cursor is bound to its filter and caller | L :: "PARTIAL: keyset pages of a filter cover it exactly once, and a cursor is bound to its filter" |
| Content (UI11) | **C** client, mode, revision, phase, required action, deadline and last activity from durable facts, five filters | L :: "UI11: the dashboard shows client, mode, revision, phase, required action and deadline with the five R2 filters, labels from durable facts only" |

## GAP

- SEC-DEPTH (`tools/test/sec-guard-reads.test.mjs`): fails only because migration 0062 exists while the planned section 3c chain names
  0062 for `commercial_authorizations_first_assignment` and the execution-capacity cells. 0062 is provisional; the integrator renumbers
  it at merge (`tools/renumber-migration.mjs`). Migration 0062 adds no guard trigger that reads another table, so no section 3b cell is due.
