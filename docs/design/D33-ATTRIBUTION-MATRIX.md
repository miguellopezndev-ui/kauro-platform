# D-33 attribution and prospect admission: failure-mode matrix

Owner decision D-33 (2026-10-13): Kauro prospects and sells to agencies and to companies; a company opportunity a seller sourced is
attributable under the same commercial rules as an agency. This matrix covers the two transitions whose admission changes. Nothing
else in either transition changes: lock order, journal, CAS, deadlines, evidence, suppression, pool rules and the database checks stay.

Inventory rows: R12 (prospect segment AGENCY only: migration 0029 CHECK, vocabulary, CMD045 handler) and R13 (CMD047
IN_HOUSE_NOT_ATTRIBUTABLE and its BUYER_TYPE_UNSET twin, whose only stated justification was "an acceptance before it could bind an
in-house tenant", design D10-ATTR-1). Kept: R14 (CreateQuote refuses an unset buyer type), R15 (economic-activity declaration, D-30),
R16 (the buyer type never changes price, discount or admission).

## Changes

| id | change | kept around it |
|---|---|---|
| D33-PROS-1 | `prospect_source_evidence.segment` admits `AGENCY` and `COMPANY` (new append-only migration `d33_company_prospects`, constraint `prospect_source_evidence_segment`); `COMMERCIAL_VOCABULARY.prospectSegments` = `AGENCY`, `COMPANY`; CMD045 accepts the caller's own evidence of either segment | the caller's own evidence and contact (SOURCE_EVIDENCE_INVALID), lawful basis and dated source digest (NOT NULL columns), suppression by organization and contact key (PROSPECT_SUPPRESSED), one live prospect per organization key (PROSPECT_EXISTS), any other segment refused by the database (23514) |
| D33-ATTR-1 | CMD047 no longer reads the buyer type: an in-house tenant and a tenant whose type is not yet recorded are attributable like an agency; the reasons IN_HOUSE_NOT_ATTRIBUTABLE (retired) and CMD047's BUYER_TYPE_UNSET leave the CMD047 catalogue | owner only, CAS, review deadline on the database clock (CLAIM_EXPIRED, judged again before the writes and at COMMIT, KC021), SUBMITTED or DISPUTED only, allocation on this prospect and unfrozen, shares exactly 10 000 bps (KC003), one frozen allocation per agency (ATTRIBUTION_EXISTS), no payment order before the claim (CLAIM_AFTER_FIRST_ORDER) |
| D33-COPY-1 | the "in-house sentence exactly once on Pricing" lint is retired; eligibility lines of the public copy name any customer, not only an agency | every other copy rule (no savings promise, no compatibility claim, AI sentence, brand, founding line) |

## Matrix

| transition | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| CMD045 RegisterProspect from COMPANY evidence (D33-PROS-1) | unchanged: two registrations of one organization key, either segment, meet the live-prospect unique index; one wins, the other PROSPECT_EXISTS (the segment is not part of the key, so an AGENCY and a COMPANY record of one domain cannot both be live). Existing CMD045-RACE test | unchanged: no port call; a statement timeout writes nothing (B06 pipeline) | N/A: evidence carries `observed_on`; no deadline is evaluated at registration (unchanged) | unchanged: a crash before COMMIT leaves no prospect (CMD045-RACE crash cell) | unchanged: the journaled 201 replays | unchanged: identical retry replays, other body IDEMPOTENCY_CONFLICT | unchanged: a suppression of the organization or contact key refuses either segment (PROSPECT_SUPPRESSED); a CANDIDATE or TERMINATED seller is 403 | N/A: one INSERT; the database refuses a third segment value at the evidence INSERT (23514), so no prospect can stand on an unknown segment |
| CMD047 AcceptAttribution without the buyer-type gate (D33-ATTR-1) | unchanged: two acceptances for one agency serialize on the agency lock; one frozen allocation, the other ATTRIBUTION_EXISTS, for any buyer type (CMD047-RACE). A SetBuyerType racing an acceptance no longer matters: no acceptance reads the type, so its order cannot change the outcome | removed: the BuyerTypeReader call (and its BUYER_TMO port-timeout gap of B10-failure-matrix row CMD047) is gone, so the call-out cannot time out; the remaining reads are in-transaction | unchanged: review deadline at `kauro.effect_now()` before and after the share locks, and at COMMIT (KC021) | unchanged: crash before COMMIT leaves the claim SUBMITTED and the allocation unfrozen | unchanged: the journaled 200 replays | unchanged: replay byte-for-byte; same key other allocation IDEMPOTENCY_CONFLICT | unchanged: a seller terminated or an agreement changed is fenced by 0049; the owner grant is read after its lock. New consideration: the buyer type recorded after acceptance cannot revoke an attribution (it never could for AGENCY; now for neither) | unchanged: freeze, ACCEPTED and REJECTED rows in one transaction; the deferred KC003 sum check |
| CreateQuote by buyer type (R14/R16, unchanged; guard only) | N/A: no change | N/A | N/A | N/A | N/A | N/A | N/A | N/A: the type is copied into the quote snapshot, never priced; test "E2E (D-33): an agency buyer and an in-house buyer ... same price" pins it |

## Tests (tests first; red proof on the tests-only commit)

- `packages/persistence/test/b10-sales-migrations.test.ts` CMD045 database row: AGENCY and COMPANY admitted, IN_HOUSE, END_CLIENT, CONSUMER refused by `prospect_source_evidence_segment`.
- `apps/api/test/cmd045-register-prospect.test.ts` OK (company prospect through the route) and DENY (another seller's COMPANY evidence, suppression of a company key).
- `apps/api/test/cmd047-accept-attribution.test.ts` OK (D-33): unset and IN_HOUSE tenants accepted, the port not asked; the kept refusals stay in the DENY rows.
- `apps/api/test/b11-buyer-type.test.ts` E2E: a company prospect registered from COMPANY evidence, its claim accepted for a recorded in-house tenant; and equal quotes for agency and in-house buyers.
- `packages/domain/test/commercial-rules.test.ts` the reason registry without IN_HOUSE_NOT_ATTRIBUTABLE.
- `apps/web/test/copy-lint.test.ts`, `public-copy.test.ts`, `public-pages.test.ts`: the retired lint rule no longer refuses company copy; the eligibility lines name any customer.
