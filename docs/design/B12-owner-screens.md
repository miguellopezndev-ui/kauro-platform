# B12 owner screens, lane 1: OPS origin, bank route (O1) and inbound credits (O2)

Base `origin/main` 8354d7be. Plan source: `.kauro/mandates/SCREENS-PLAN.md` section 5 (D-SCR-1, O1, O2 requirements a-e). O3 (refund queue)
and O4 (settlement) are other lanes. R2 anchors: 14_CLOUD:55 ("API and private operations routes have distinct authentication and
authorization even if they share a load balancer"); R2-067 "Show unknown/unavailable balances and liabilities; no optimistic spendable
cash card"; registry UI39 "Company finance", primary copy "Separate collections, cash and obligations."; rule 1b (the owner finishes the
route and the credit queue by himself, no agent step).

## Decisions
- **D-B12S-1 OPS origin (D-SCR-1).** `Origin` gains `OPS`. The 15 OPS screens are mapped at `/ops` + registry route (UI33 is `/ops`, UI39
  `/ops/finance`), never tenant, never anonymous. `KAURO_OPS_ORIGIN` is a third https origin, distinct from the other two; a split
  deployment without it serves no OPS screen (404 on every host), never on the app host. LOCAL serves all three groups. The ops host also
  serves the sign-in screen UI50 (the session cookie is host-bound), and `safeReturnPath` admits an OPS route. Pages live in `app/(ops)`.
- **D-B12S-2 owner evidence upload (GAP-API-8).** `POST /api/v1/operations/bank-accounts/{accountRef}/evidence-artifacts`
  (`uploadBankEvidenceArtifact`, KAURO_OWNER). Body `{ mediaType, contentBase64, evidenceHash }`: the decoded bytes are at most 524,288 and
  at least 1; `evidenceHash` must equal the SHA-256 of the decoded bytes (HASH_MISMATCH otherwise, before any store call); the media type
  is one of `application/json`, `application/pdf`, `text/csv` and the bytes must look like it (a PDF starts `%PDF-`, JSON parses to an
  object, CSV is UTF-8 without NUL): ARTIFACT_TYPE_MISMATCH. The restricted store's `put` is content-addressed (same bytes, same
  reference), so the route is not journaled: OPERATIONAL_WIRE `NONE`, CSRF, KAURO_OWNER. The owner is authorized in an OPERATOR unit of
  work before any store call; the bytes are stored under the provider-call bound outside every transaction (the evidence port's rule: no
  call inside a database transaction); then a second OPERATOR unit re-authorizes the owner and judges the caller's credential as fenced in
  that unit (`judgedUnderHold`, rule 16) before the reply. The store's own record binds the account: an artifact the store holds for
  another account (same bytes stored earlier) is refused UNKNOWN_EVIDENCE, never answered as this account's. An uploaded artifact grants nothing: every command that cites it re-reads it by
  hash, classifies it, binds its account and judges the owner's step-up at its own COMMIT. No step-up for the upload itself.
- **D-B12S-3 credit queue read (GAP-API-9).** `GET /api/v1/operations/bank-credits?state=&limit=&cursor=` (`listBankCredits`,
  KAURO_OWNER): the credits in one state (default MATCH_REVIEW), oldest first, keyset on `(created_at, bank_credit_id)`, limit 1..100
  (default 25), the cursor sealed by the api's cursor key and bound to the operation, the caller and the state. Items are the credit view
  (no account or routing number exists in it). Operational routes gain a closed `query` declaration documented in the OpenAPI document.
- **D-B12S-4 reference path values (O2 b).** A path parameter named `*Ref` admits the server's REF pattern `[A-Za-z0-9._:-]{1,128}`
  (bank-route-routes.ts REF_PATH), documented per parameter; the web client admits it for exactly those names and refuses the dot
  segments `.` and `..` (they would leave the route). Every other parameter keeps the UUID-safe pattern.
- **D-B12S-5 screens.** UI39 page `/ops/finance` draws two owner sections: the bank route (`?route=` names it; configure, verify, enable,
  disable, replace details) and the credit queue (`?state=`, `?credit=`; enter, confirm, attribute). Commands run under the runner:
  subject keys `(routeId|creditId, version)`, form keys for configure and enter. Every command's `authorizationRef` is one K0 step-up
  proof (O2 e). Evidence files are uploaded first and only their returned `artifactRef`/`evidenceHash` are cited. An absent fee is
  "Unknown", never 0. Gap: there is no list of routes (GAP-API-13); the route id travels in the address after configure.

## Failure matrix (template columns; C = cell with its test, N/A with reason)
| row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| U upload (GAP-API-8) | C U-RACE | C U-TIMEOUT | N/A: an artifact has no deadline; the citing command judges DETAILS_EXPIRED and the step-up | C U-DENY (no store call before the owner is authorized) | C U-RETRY (an answer lost after the put: the same bytes answer the same reference; the orphan grants nothing) | C U-RETRY | C U-DENY (revoked grant: 403, store untouched); mid-flight: the reply is judged under the fenced credential; the citing command re-authorizes | C U-LIMITS (hash, size, type refused before the store call) |
| L list (GAP-API-9) | C L-KEYSET (a credit that leaves the state between pages is not repeated, none is skipped) | N/A: one bounded statement (limit <= 100) in one unit; an outage is the server's shared 503 (web RETRY_LATER, W-READ row) | N/A no deadline | N/A read | N/A read | C L-KEYSET (the same cursor answers the same page) | C L-DENY (non-owner 403; another caller's or state's cursor refused) | C L-KEYSET (last page has no cursor) |
| O1/O2 web commands | C W-KEYS (double activation sends once) | C W-KEYS (lost answer: same key) | C W-STEPUP (expired proof is STEP_UP, form kept) | N/A browser writes nothing durable | C W-KEYS (reload derives the same key) | C W-KEYS | C W-DENY (403 clears the view) | C W-UPLOAD (configure is sent only after the upload answered) |

Test titles (files under apps/api/test, apps/web/test, tools/test):
- `apps/api/test/b12-owner-evidence.test.ts` :: "U-OK: the owner uploads a bank artifact and a route is configured from the returned reference and hash"
- same :: "U-LIMITS: a hash that is not the bytes', an empty or oversized artifact and bytes that are not the declared type are refused before the store is called"
- same :: "U-DENY: a person without KAURO_OWNER, a revoked grant and no credential are refused and the store is never called"
- same :: "U-RETRY: the same bytes uploaded twice, and concurrently, answer one reference; a lost answer is retried safely"
- same :: "U-TIMEOUT: a store that does not answer within the provider-call bound is CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE and retryable"
- same :: "L-KEYSET: the queue lists one state oldest first in keyset pages; a credit that leaves the state is not repeated and none is skipped"
- same :: "L-DENY: the queue is owner-only and a cursor continues only its own caller and state"
- `packages/application/test/response-schemas.test.ts` :: "B12: the owner evidence upload and the credit queue are declared operational routes, and no owner credit read carries an account or routing number"
- `tools/test/openapi.test.mjs` :: "B12: a Ref path parameter is documented with the REF pattern, and the credit queue documents its closed query"
- `apps/web/test/api-client.test.ts` :: "D-B12S-4: a Ref path value admits the server's REF characters and never a dot segment; other parameters keep the UUID-safe pattern"
- `apps/web/test/host-routing.test.ts` :: "D-SCR-1: the OPS screens answer only on the ops host, a split deployment without it serves none, and sign-in is served on the ops host"
- `apps/web/test/owner-finance-screens.test.ts` :: "O1: the route shows its state, version and evidence hash, never an account number, and offers only the commands its state permits"
- same :: "O1/GAP-API-8: configure uploads the details file first, then sends the returned reference and hash under one form key; a refused upload sends nothing"
- same :: "O1 W-KEYS: verify, enable and disable run under the route version's key; a double activation sends once and a lost answer replays the same key"
- same :: "O2: the queue lists one state with keyset pages, an absent fee is Unknown and never zero, and an empty queue says so"
- same :: "O2/CMD211-212: confirm and attribute run under the credit version's key with one step-up proof each; an expired proof is the STEP_UP state that keeps the form"
- same :: "O2/CMD210: enter uploads the bank artifact first, then sends the typed facts with the returned reference and hash under one form key and one step-up proof"
- same :: "O2 DENY: a 403 clears the queue and the credit"

## Case map (B12)
| case | coverage in this lane | remaining |
|---|---|---|
| R2-067 | PARTIAL: O2 shows an absent fee as Unknown, the credit view never claims settlement; `owner-finance-screens.test.ts` O2 title | balances, liabilities and settlement are O4 (PV1-SETTLE) |
| G-UX_PRIVATE (owner projections) | PARTIAL (EXECUTED_LOCAL): owner-only reads and upload (`b12-owner-evidence.test.ts` L-DENY, U-DENY); no account number in a read (`response-schemas.test.ts` B12 title; `owner-finance-screens.test.ts` O1, O2); the OPS screens only on the ops host (`host-routing.test.ts` D-SCR-1) | seller projections R2-066, R2-068 are later B12 lanes |
