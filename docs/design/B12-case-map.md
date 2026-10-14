# B12 — case map

Every case of package B12 (`node tools/package-brief.mjs B12`: 20 cases, gate G-UX_PRIVATE) with the lane that demonstrates it
(docs/design/B12-outreach-plan.md §1, §9) and its status. Lane K1 (the kit) builds the database backstop every lane relies on
(migration 0072, provisional number; `packages/persistence/test/b12-outreach-migrations.test.ts`): no case is demonstrated by K1 alone,
so every row is OPEN to its lane, and the last column names the K1 guard the lane's test will reach through the API.

`tools/test/b12-case-map.test.mjs` reads this file: every B12 case of the registry (`packages/contracts/registry/program.json`)
appears exactly once, every status is DONE or OPEN with a named B12 lane, and every cited title occurs verbatim in its cited file.

Status classes: **DONE EXECUTED_LOCAL** — the cited tests demonstrate the whole case against the real API, PostgreSQL 17 and the runtime
roles. **OPEN -> <lane>** — the lane that owns the case, with its target class (SIMULATED: the provider fakes of the kit, live halves
PART(B15/B19)).

Totals: 20 cases — 0 DONE, 20 OPEN.

| case | registry expectation | tests | status | what the check observes |
|---|---|---|---|---|
| R2-066 | Expose only their financial statement/support route, never customer CRM or new prospect tools. | none yet | OPEN -> L-HOME NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): none at the database (the projection is the lane's); the web half is PART(B12-WEB) |
| R2-067 | Show unknown/unavailable balances and liabilities; no optimistic spendable cash card. | none yet | OPEN -> B12-OWNER-SCREENS-2 NOT_EXECUTED; target PARTIAL | K1 database backstop (migration 0072): none at the database (owner screens, plan §7) |
| R2-068 | State remains DRAFT; no activity log or KPI claims a delivered email. | none yet | OPEN -> L-DRAFT NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): draft edges of plan A2b (KA096): a draft leaves DRAFT only with its intent; KC036 (a) |
| R2-129 | Record SEND_UNCERTAIN and require scoped reconciliation; do not resend automatically or claim inbox delivery. | none yet | OPEN -> L-SEND NOT_EXECUTED; target EXECUTED_LOCAL + SIMULATED; live PART(B15/B19) | K1 database backstop (migration 0072): SEND_UNCERTAIN edges, KC029 unreconciled uncertainty, KC036 (b)(c) accepted evidence never reopened |
| R2-130 | Current suppression blocks the send; a sealed campaign grant cannot override a later refusal. | none yet | OPEN -> L-SEND NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): L8 X of the suppression key; prospects_not_suppressed takes L8 S; KC032 stop fact |
| R2-131 | Reject the route despite valid API credentials and spare quota; preserve the draft for a genuinely permitted channel. | none yet | OPEN -> L-SEND NOT_EXECUTED; target EXECUTED_LOCAL + SIMULATED | K1 database backstop (migration 0072): KC028 no outreach intent on RESEND_TRANSACTIONAL |
| R2-132 | Stop future dispatch for that sender, preserve uncertain/past activity and never borrow the owner identity. | none yet | OPEN -> L-SEND NOT_EXECUTED; target EXECUTED_LOCAL + SIMULATED | K1 database backstop (migration 0072): sender edges under L7 X (KA096), KC031 at every intent of a sender not VERIFIED |
| R2-135 | Show superseded status and current safe resource; prevent its use in a new approved draft while preserving historical records. | none yet | OPEN -> L-DRAFT NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): KC033 (a) superseded resource, (b) capability not offered; one CURRENT version per family |
| CMD061-OK | Create a versioned DRAFT and content binding; no external message is sent. | none yet | OPEN -> L-DRAFT NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): KA095 (c) seller sender on an assigned prospect, (d) content binding, (f) contact key; drafts born DRAFT v1 |
| CMD061-DENY | Wrong assignment or unsupported claims reject without revealing the contact or creating send authority. No unauthorized committed state or external effect. | none yet | OPEN -> L-DRAFT NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): KA095 (c)(d)(f); a pending sender never sends (KC031 at the intent) |
| CMD061-RACE | Create a versioned DRAFT and content binding; no external message is sent. Preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority. | none yet | OPEN -> L-DRAFT NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): L6 X of the resource family and L10 X of the draft asserted by T2 (KA096 LOCK_NOT_HELD) |
| CMD062-OK | Commit one revocable bounded grant; record the actual permission without inventing standing consent. | none yet | OPEN -> L-AUTH NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): one grant per review (U1), window clamped to effect_now and <= 14 days, sealed hashes of the review's drafts |
| CMD062-DENY | Expired, empty, excessive or ungrounded grants reject and cannot activate a send queue. No unauthorized committed state or external effect. | none yet | OPEN -> L-AUTH NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): KC035 expired / other proof / moved draft / no review row; KA095 (b)(e); KC030 empty or > 14 day window |
| CMD062-RACE | Commit one revocable bounded grant; record the actual permission without inventing standing consent. Preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority. | none yet | OPEN -> L-AUTH NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): U1 outreach_authorizations_one_per_review (23505); L4g X of a revocation asserted |
| CMD063-OK | Commit one fenced send intent; persist provider acceptance or explicit uncertainty and never infer delivery. | none yet | OPEN -> L-SEND NOT_EXECUTED; target EXECUTED_LOCAL + SIMULATED | K1 database backstop (migration 0072): T3 counts at the intent birth and the claim, judged at effect_now; claim stamps uncertain_after = submitted_at + 37 s |
| CMD063-DENY | Cancellation, opt-out or changed content blocks dispatch; uncertain provider acceptance requires reconciliation before any repeat. No unauthorized committed state or external effect. | none yet | OPEN -> L-SEND NOT_EXECUTED; target EXECUTED_LOCAL + SIMULATED | K1 database backstop (migration 0072): T3 KC028..KC037 (route, policy, sender, grant, cap and cadence, resources, pause, calendar), KC036 already sent |
| CMD063-RACE | Commit one fenced send intent; persist provider acceptance or explicit uncertainty and never infer delivery. Preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority. | none yet | OPEN -> L-SEND NOT_EXECUTED; target EXECUTED_LOCAL + SIMULATED | K1 database backstop (migration 0072): T2 locks L3/L4/L4g/L10 asserted per edge (KA096 LOCK_NOT_HELD); intent edges and claim columns (KA096) |
| CMD064-OK | Append deduplicated evidence-backed commercial activity and stop follow-up after refusal, reply, bounce or suppression. | none yet | OPEN -> L-ACT NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): activities recorded with their locks per kind; a COMPLAINT after an OPT_OUT is a second activity, one registry row |
| CMD064-DENY | Unsupported delivered/replied claims reject; duplicate external identity cannot count twice. No unauthorized committed state or external effect. | none yet | OPEN -> L-ACT NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): KA097 provider reference, inbound reference, service-only kinds, no future occurredAt; KA098 non-owner suppression scope |
| CMD064-RACE | Append deduplicated evidence-backed commercial activity and stop follow-up after refusal, reply, bounce or suppression. Preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority. | none yet | OPEN -> L-ACT NOT_EXECUTED; target EXECUTED_LOCAL | K1 database backstop (migration 0072): U2 unique indexes of sales_activities; L8 X of the suppression key asserted |

## Kit K2 notes (shared contracts landed once; decisions K2-1 .. K2-6)

- K2-1 Journal identity. command_journal.operation accepts `^CMD[0-9]{3}$` or exactly one name of the explicit list in migration 0072's tail
  (domain B12_OPERATIONS: 11 outreach operations and 13 producer operations). No pattern is widened and the registry is not edited.
- K2-2 Registered routes. CMD061..CMD064 (registry rows, gate G-UX_PRIVATE, idempotency REQUIRED) and the 11 outreach operations of plan companion
  section R are in contracts, request and response schemas, outcomes, served lists, composition and the generated openapi.json and web client, each bound
  to a NOT_BUILT stub. Five reads: GetOutreachDraft, GetOutreachReview, ListSalesActivities, GetOutreachMetrics, GetSalesResource.
  The matrix applicability rows of these commands read PLACEHOLDER-B12-NOT-BUILT in the handler-dependent cells; the serving lane replaces them with its tests.
- K2-3 CMD062 also carries assuranceProofRef (the registry lists no proof field). The plan binds the review to the owner's step-up and judges it at commit; the
  proof travels in the body like every other step-up command's.
- K2-4 contentRef and the content binding are the 64-hex content address of kauro.outreach_contents, not a UUID. RecordProspectSource and RecordProspectContact
  take the prospect in the path (/api/v1/ops/prospects/{prospectId}/sources and /contacts). ListSalesActivities is a bounded (200), non-paginated read by prospect.
  The source segment enum is AGENCY or COMPANY (D-33) although the 0029 check allows AGENCY only: L-SOURCE migrates that check.
- K2-5 Publish step-up. PublishSalesResource is an owner command with a fresh step-up, as plan companion section R states. R2 08 "Authentication and assurance"
  lists the step-up actions ("ownership transfer, payment destination change, privileged grant, significant refund, seller payout approval, destructive data
  decision and production control") and does not list resource publication; R2 12 "Resources and training" says only "Each has version, effective date and
  owner. Retired copy cannot be used to promise an old feature." Decision: keep the plan's step-up. It is stricter than R2 and costs one reauthentication on a
  rare owner act; publishing the copy sellers quote is an authority act. If the owner wants it relaxed, drop `stepUp` and `assuranceProofRef` for this command only.
- K2-6 RLS rule 21a (incident RLS-POLICY-NAMES-RELATION). The eight B12 policies that named another relation call kauro.outreach_* PL/pgSQL functions
  (STABLE, SECURITY INVOKER, search_path = pg_catalog, early return); packages/persistence/test/sec-policy-relations.test.ts is the pg_depend census, FROZEN empty
  (TODO-BATCH: the coordinator merges it with batch A's identical census).
- GAPS left for lanes: the 13 producer operations (L-OWNER) have names in the journal CHECK and the TS union but no route, spec or schema (no designed wire
  shape); GetSellerHome (L-HOME) and the public opt-out routes (L-ACT) are not registered.
- K2-7 Lists are bounded (minItems, maxItems) but not uniqueItems: the generated web client does not translate that keyword, so a handler refuses a repeated
  allowedContentHashes, draftIds or capabilityIds entry itself (the lane's DENY cell).
