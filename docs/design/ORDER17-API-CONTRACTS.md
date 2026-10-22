# Order 17: api contracts of the functional change (OpenAPI, commands, events, read models) and ChangeProposal CP-02

Branch `order17/api-contracts-cp02`, worktree `Kauro.archive/Worktrees/order17-api-contracts-cp02`. The final SHA is the head of this order's
PR. The proposal is `docs/authority/proposals/CP-02-API-CONTRACTS.md`; this file is the order's report: what was verified, built and
proved, what stays open, and the handoff to the orders after it.

Nothing normative was adopted: `packages/contracts/registry/` is byte-identical to its provenance, `apps/api/openapi.json` and
`apps/web/src/api/generated.ts` are unchanged, no handler, migration, screen, authorizer, RLS policy, infrastructure file, core or vendored
package was touched.

## 1. State verified

| Fact | At the start (2026-10-22) | At the end |
|---|---|---|
| `main` | `58dda63f40c2f4f3f315ebdbdc5b393d66cb8492` (merge of PR #120, Orders 13 and 14); CI `verify` run 39823650915 in progress, then green | see section 8 |
| PR #122 (Order 16) | open at `16ee3d4b` (CP-01 revision 1) | merged into `main` as `d38c00b2` (CP-01 revision 2 and the owner's resolution); this branch merged that `main` without rewriting its history |
| Orders 15 and 25 | their own worktrees (`order15-security-authorization`, `order25-aws-offline-infrastructure`) | not used, not touched |

The branch was created from `origin/main` in a worktree of its own. PR #122 was read by explicit commit (`git show <sha>:<path>`), never
copied onto this branch.

## 2. What was read

Order 16's report (§§3, 5, 7, 8, 9 and, after the resolution, §13), CP-01 (both revisions, delta and document), the proposals README and
test of PR #122, `FUNCTIONAL-CHANGE-INVENTORY.md`, `ORDER11-FUNCTIONAL-GAPS.md`, D-34, the owner decision records (ORDER11-DESIGN-DECISIONS,
ROUND2-OPS, ROUND2-WORKSPACE), A3, A5, Payments V1, the Data Processing Policy §8.3, B10's decision D10-EVT-1. The registry
(`commands.json`, `contracts.json`, `state_transitions.json`, `cases.json`, `requirements.json`, `gates.json`, `screens.json`, `policy.json`),
the served `apps/api/openapi.json`, the generators `tools/openapi.mjs`, `tools/web-client.mjs` and `packages/contracts/tools/generate.mjs`,
the application's request vocabulary, problem statuses and strict schema compiler, the domain event registry (`model/events.ts` and the
package vocabularies), and the handlers and views each item touches (StartAudit, CMD060, the statement and seller views, the outcome
catalogues).

## 3. Inventory: every O17 group

| O17 | Subject | CP-02 item | Class | Notes |
|---|---|---|---|---|
| O17-01 | CLEAN without a target contract | CP-02.01 | Approved | 400 (not 422) per CMD011's convention; section 6 |
| O17-02 | Operational reads | CP-02.03 | Approved | 13 reads, each its own contract |
| O17-03 | The five dates | CP-02.02 | Approved | never summed; the hold's tokens a declared reservation, NOT_APPLICABLE |
| O17-04 | Owner reads, seller schedule | CP-02.08 | Approved | owner scope is Order 15's |
| O17-04 | The four money figures | CP-02.09 | Approved (since CP-01.13 was decided) | collections not invoices; held and payable apart |
| O17-05 | Review request, histories, seller view | CP-02.07 | Approved | commercial transitions (D10-EVT-1) |
| O17-05 | Refusal reasons, review decision | CP-02.14 | Approved (since CP-01.04 was decided) | legal effect PENDING_COUNSEL (activation) |
| O17-06 | Retainer, offsets, balance | CP-02.10 | Approved | coordinated change of the statement reply |
| O17-07 | Alerts | CP-02.11 | Approved | material progress only (CP-01.07 as modified) |
| O17-08 | Legal status | CP-02.12 | Approved | read only |
| O17-09 | Identity groups and bulk decisions | CP-02.15 | Approved (since CP-01.12 was decided) | proven identity only by the core's keys; activation through C7 |
| O17-10 | Refund decision notice | CP-02.16 | Proposed | B-07 |
| O17-11 | Statement export; ask for outreach authorization | CP-02.13 | Approved | CSV formula neutralization |
| O17-12 | Consent evidence | CP-02.05 | Approved | Policy publication is CP-01.10's (activation) |
| O17-13 | Notification preferences | CP-02.06 | Approved | essential not optional |
| O17-14 | Extension for the free check, 17 days | CP-02.04 | Approved | coordinated change of the extension reply |
| O17-15 | Transfer proof and hold | CP-02.17 | Blocked (external) | PV1, Wise Business; values decided |
| O17-16 | Direct service by Kauro | CP-02.18 | Proposed | B-06 |
| O17-17 | Staged reconciliation | CP-02.19 | Blocked (external) | B-14 tool facts |
| O17-18 | Self-serve free check | CP-02.20 | Conditional | A3 §3.2 amendment (B-03) |
| O17-19 | Billing details at the first quote | CP-02.21 | Proposed | B-09 |

Totals: 15 approved, 1 conditional, 3 proposed, 2 blocked; 57 proposed operations (17 commands CMD065–CMD081, 40 reads), 7 served operations
modified, 54 new registry contracts and 1 extended, 2 state machines, 9 new event types, 2 subscriptions and payload changes of 12 registered
events, 133 cases with their requirements and gate entries. Detail per item: CP-02 §3 to §5.

## 4. What was delivered

| File | Content |
|---|---|
| `docs/authority/proposals/CP-02-API-CONTRACTS.md` | Change record, classes, items, the approved decisions taken inside the delegation, the six points of every non-approved item, adoption, decision block |
| `docs/authority/proposals/CP-02.api.json` | The source: contracts and their fields, commands, operations with request members, replies, outcomes and assurance, events and subscriptions, audiences and visibility, authorities with their exact words, compatibility declarations, valid and invalid examples |
| `docs/authority/proposals/CP-02.registry-delta.json` | Generated JSON Patch against the vendored registry, CP-01's format plus the class and activation of each item |
| `docs/authority/proposals/CP-02.openapi.json` | Generated proposed OpenAPI 3.1: new operations, modified served components with base hashes, every component needed |
| `docs/authority/proposals/CP-02.compatibility.json` | Generated compatibility matrix of CP-01 + CP-02 with the consumers found |
| `tools/cp02.mjs` | Generator and checker |
| `tools/test/cp02-api-contracts.test.mjs` | 15 tests, each rule also run on broken copies |
| this file | The report |

Schemas: each registry contract becomes a JSON Schema through the authority's own generator (run in a temporary directory) and an OpenAPI
component; request schemas use the served api's exact vocabulary (id, label, text, version, hash, money, instant), proved equal to served
components. Examples: 15 example sets (contracts, requests, modified requests), each with valid and invalid values and the expected
field and code, validated by the api's strict compiler.

## 5. Decisions Order 17 took, and corrections to Order 16's handoff

| Point | Order 16 said | Order 17 | Why |
|---|---|---|---|
| CLEAN with a target | `422 TARGET_NOT_APPLICABLE` | `400 INVALID_REQUEST`, reason `TARGET_NOT_APPLICABLE`; CP-01 rectified to match (revision 3) | CMD011's convention for a mode-dependent member (`TARGET_INSTANCE_REQUIRED`, `create-project.ts:54`); no new problem code |
| CRM project without a target | "still TARGET_STALE" | `400 INVALID_REQUEST TARGET_CONTRACT_REQUIRED` | today it is `400 SCHEMA_VIOLATION` (the schema requires it); same status; TARGET_STALE stays for a stale target |
| Claim events | "events for each" | commercial transitions, no domain event | D10-EVT-1 |
| Seller home additions | members of the seller home | a separate `GetSellerSchedule` read | `SellerHomeView` is a closed reply the web client validates |
| Quote and order views "link" to the dates | a link | no member; clients use `projectId` | avoids a coordinated change of two closed replies |
| Hold date kind | absent until CP-01.11 | in the vocabulary, `NOT_APPLICABLE` | F-24 (the five dates) is the owner's; widening a reply enum later would be a coordinated change |
| Direct service | `AssignDirectService` or `KAURO_DIRECT` in CMD048 | a separate command | CMD048's `sellerId` keeps its type and meaning |
| Claim refusal for `OWNER_RULE` | a versioned rule in force | also refused when the rule entered into force after the claimed facts | Order 16 §13.6.3's reading of "never retroactive" |
| Billing profile after activation (O17-19) | move it to the first quote | proposed, with an open point | no command other than CMD002 records a profile today |

## 6. Proof

`tools/test/cp02-api-contracts.test.mjs`: procedure, application (alone and after CP-01, generator in a temporary directory), CP-01 pin
and disjointness, authority (exact words in the records), correspondence (commands, operations, cases, requirements, gates, contracts,
events), authorization as represented (audiences, roles, prefixes, field visibility, assurance, the four consent notions), OpenAPI (drift,
registry fields and contracts, served shapes, collisions, base hashes, the web client generator), compatibility (declared = computed,
consumers found; served projections follow registry changes; the classifier tested on real breaks), examples. Each rule also runs on
deliberately broken copies (54 of them) and must fail for its own reason.

Failures the rules caught on the real proposal while it was built, each repaired only after it was seen failing:

| Rule | Failure | Repair |
|---|---|---|
| CP-01 pin | PR #122 moved to revision 2 (owner resolution) and the pinned hash refused it | CP-02 re-verified and updated to revision 2 (CP-02.09, .11, .14, .15, .17); after the merge of PR #122 and CP-01 revision 3, CP-02 reads CP-01 from the repository only (no branch, no git) and pins revision 3 by hash and number |
| Authorization | RecordConsent and WithdrawConsent answered `ConsentRecord`, exposing the server's `evidenceHash` to the person | they answer `ConsentView` |
| Authorization | RequestOutreachAuthorization answered the seller with the owner's `declineCode` | `SellerOutreachRequestView`, and a seller list |
| Authorization | A rule required owner commands under `/api/v1/ops`, but served owner commands sit beside their siblings (`/api/v1/sales`, `/api/v1/operations`) | the prefix rule separates owner reads (all new, `/api/v1/ops`) from owner commands |
| Correspondence | `RetentionExtension` was reachable from no operation | the modified CMD060 reply names it as its registry contract |
| Authority | L-19's words were read from `main`'s older `LAWYER_LATER.md` | PR #122 records are read at the pinned commit until it merges |
| OpenAPI | modified components referenced served components not in the document; the web client generator returns `{text, failures}` | referenced served components are copied unchanged; failures asserted empty |
| Examples | `DecideMany` without the explicit approval member passed | the approval member is required (CP-01.12: explicit human approval) |
| S088 census (`owned-cleanup.test.mjs`) | a recursive delete in `tools/cp02.mjs` changed the census PR #122 also edits | exact file-by-file cleanup, no recursive delete; the census is not edited |
| Authority (after the review) | CP-02.02's field description named CP-01.11, conditional, outside a reservation | the description points at the declared reservation |
| Authorization (after the review) | the refund notice moved to AGENCY_BILLING lived under a path the billing prefix rule did not admit | the rule admits `refunds/{refundId}`, as the served GetRefund |
| PR #122's proposal rules | its revised test requires `activation` on every item | carried into the delta; CP-02's own test requires it too |

PR #122's test (revision 2) was run against CP-02 with PR #122 merged into this branch in the working tree (not committed): CP-01's rules,
the cross-proposal path ownership, the joint generator run, CP-02's test and the S088 census: 28 tests, all green; the merge was then aborted.

## 7. Compatibility

`CP-02.compatibility.json` lists 282 changes of CP-01 + CP-02 in three layers (registry 189, served api 81, payloads of registered events
12): 229 additive (new contracts, commands, operations, cases, policy keys, relaxed request members), 16 text (registry prose), 35
coordinated, 2 breaking.

- **Breaking (CP-01.01 and its served consequence in CP-02.01):** `Audit.targetContractId` becomes optional in the registry, and its served
  projection `AuditView` (GetAudit, CancelAudit) follows. Accepted by the owner (F-01, CP-01 resolution). Consumers: the web client's
  `AuditView` type and `isAuditView` guard, the application's audit views, every `audit.*.v1` payload and its readers; all changed for
  CLEAN in the backend and web orders (C4, C9), server and web deployed together.
- **Coordinated:** the extension reply (4 members, 3 outcome meanings), the statement reply (`balance`, `RETAINER`, 6 optional item
  members), `CommissionStatement` (2 optional members), StartAudit's 2 new reasons, CreateQuote's outcome meaning (proposed item), the
  RetentionRecord class (CP-01.11, blocked), the Problem reason vocabulary, and three event payloads (`audit.queued.v1` without a target for
  CLEAN, `retention_record.extended.v1` with UNPAID, `quote.withdrawn.v1` with `withdrawalCode`). Each lists its consumers (the
  application's views, schemas and catalogues, `apps/web/src/api/generated.ts`, the domain failure reasons and payload allowlists); each
  is regenerated with the server in the same change.
- No CP-02 item removes, retypes or makes required an existing member, and no approved CP-02 item breaks a consumer.

## 8. Independent review

A separate agent, given the mandate, the records and the files but not Order 17's conclusions, reviewed the first commit (CP-01 revision
1) adversarially. It found no high-severity issue, confirmed the JSON Patch, the disjointness from CP-01, the generator runs, the money and
consent rules and the mutation tests it sampled, and simulated PR #122's merge (its test and CP-02's green). Its medium and low findings,
and what was done:

| Finding | Done |
|---|---|
| Approved items used vocabulary of CP-01 items not approved (the hold's tokens in CP-02.02; R2-RETENTION-2 without requiring CP-01.02; CP-02.05 approved on the draft Policy), and the test could not see it | CP-02.02 requires CP-01.02 and declares its reservation of the hold's tokens (`reserves`); CP-02.05 rests on the CHECKLIST's law items (C-04, C-05, C-11, C-51), the draft Policy is a PROPOSED authority; the test now refuses any mention of a non-approved CP-01 item outside `activation` or a declared reservation |
| Registry contract and served reply disagreed (CommissionStatement.balance optional vs required; the extension view vs RetentionExtension), unchecked | the stored member stays optional, described as computed by the read for every statement; each modified component names its registry contract and the test refuses a member the contract does not hold |
| Event payload changes missing from the matrix | a third layer (EVENTS), checked against the domain's allowlists, declared and attributed |
| Leaks prevented only by prose (seller alerts carrying agencies and projects; package artifacts allowing internal evidence; the refund notice readable by any member; members added to served seller replies not checked) | `SellerAlertView`, `PackageArtifactItem`, AGENCY_BILLING for the notice; the visibility rule now covers modified served replies (a seller reads an offset's refund and project by F-17) |
| Tautological tests (matrix recomputed from itself; "nothing adopted" not checking the web client) | the matrix test checks that each change is made by the item it names; the web client is regenerated from the served api and compared, and its hash is recorded |
| ChangeDecision could unify a blocked group | already closed by revision 2 (GROUP_BLOCKED) |
| CP-01.01's text still says "422 TARGET_NOT_APPLICABLE" | not CP-02's file: listed for Order 16 and the owner (section 11) |
| G-14's owner refunds list missing | `ListRefundsAcrossWorkspaces` |
| CP-02.20 silent on LR-11 | stated |
| A money amount typed as a count in an event; the contact form under an authenticated command; no check of O17 coverage | `minorUnits` (as commerce's events carry amounts); the command's source is REGISTRATION or PREFERENCES only; the test requires all nineteen groups |
| The matrix's consumer lists would make CP-02 stale on unrelated work | they are regenerated with the matrix and left out of the drift comparison |

### Final review (after the integration with `main` and CP-01 revision 3)

A second independent review, of CP-01 revision 2 as merged plus revision 3 and of CP-02's last commit against `main`'s contracts and
consumers, first answered **REJECT** with two material defects, both repaired at their root and each reproduced by a test that fails on the
defect:

| Defect | Root cause | Repair | Test that reproduces it |
|---|---|---|---|
| `Audit.targetContractId` optional in the registry while the served `AuditView` (GetAudit, CancelAudit) and the web client still required it; declared "no consumer" | consumers of a registry change were looked for only among importers of the registry type; served projections were never compared with registry changes | CP-02.01 modifies `AuditView` (BREAKING, the served consequence of CP-01.01, accepted by F-01, with migration); every `audit.*.v1` payload declared; the RetentionView projection follows CP-01.11 inside CP-02.17; consumers now include the projections' readers | `projectionGaps`: every served projection (`$comment` "Projection of registry contract X") must follow each change of X; removing the AuditView or RetentionView modification is found |
| ChangeDecision (CMD075) could unify one name-and-email candidate without the exact preview or explicit approval the owner required (CP-01.12) | the safeguard was put on the bulk command only | CMD075 requires `previewHash` and `approval`, refuses `PREVIEW_STALE`; GetDecisionPreview previews one group; an adversarial case | every command that can set `UNIFY` must require `previewHash` and the explicit approval statement; the previous CMD075 fails |

Minor points also closed: the pin's provenance label (revision 2 merged in `d38c00b2`, revision 3 on this branch); CP-01 §3.1's leftover line
on the request schema (revision 3 text). The noisy outcome-consumer lists are left as they are (they over-report, never under-report).
The re-review of the repaired commit is recorded below.

## 9. Verification and CI

See the PR description for the final runs: `pnpm run verify:fast` on this branch (tools tests, typecheck, architecture gate, fixture-clock
lint, `openapi`, `web-client`, `matrix`), `node tools/cp02.mjs check`, and CI `verify` on Linux and Windows for the final SHA.

## 10. Handoff

Every adopted item takes effect only with its `activation`; the orders below deliver it, tests first, and none may start an item before the
owner has decided it and the re-issue has adopted it with CP-01.

| Order (component) | Takes |
|---|---|
| Authorization (Order 15) | Map `AGENCY_BILLING_READER`, `AUTHENTICATED_SELF`, `ASSIGNED_SELLER`, `PUBLIC`; the owner's cross-workspace scope for `/api/v1/ops` reads; which agency roles read which operational read; who decides identity groups (floor `AGENCY_OPERATOR`); row policies for UNPAID extensions (CP-01.02) |
| Backend domain and application (C4) | Handlers and views of CP-02.01, .02, .03, .07, .08, .09, .10, .11, .12, .13, .14 (and .18, .21 if decided); the commercial transitions and the seller's e-mail under D10-EVT-1; `quote.withdrawn.v1` `withdrawalCode`; the new reasons in `FAILURE_REASONS` and the outcome catalogues; `tools/openapi.mjs` serving them; the web client regenerated with the server for every coordinated change |
| Retention and deletion (C6) | CP-02.04 with CP-01.02's activation: UNPAID soft deadline written, ceiling 17, one extension per project across classes, SQL pins and drift tests, restore never reviving data; the dates read's retention entries (CP-02.02) |
| Payments (C5) | CP-02.17 only after Wise Business and PV1 (never before); CP-02.16 if B-07 is decided |
| Cores (C7) | CP-02.15's activation: evidence classes from Migration Core's proving keys, verification of a declared authoritative external id, CRM ids and shared addresses, RevisePlan wired, adversarial fixtures; CP-02.19 after the tool facts |
| Identity (C8) | CP-02.05 and CP-02.06 with the registration flow and the provider decision (B-13); no processing authorization recorded before the Policy is published (CP-01.10) |
| Web (C9) | Screens on the adopted reads; copy for the new reasons and meanings; UI57 only after the A3 §3.2 amendment; the coordinated replies deployed with the server |
| Legal (counsel) | L-12, L-19 (claim rules: CP-02.14's legal effect), LR-01, LR-02, LR-05, LR-06 |

## 11. Pending decisions

| # | Decision | Who | Blocks |
|---|---|---|---|
| 1 | Decide each CP-02 item (CP-02 §8), in the re-issue coordinated with CP-01 | Owner | adoption of every item |
| 2 | A3 §3.2 amendment for the self-serve free check (B-03) | Owner | CP-02.20 |
| 3 | Who tells the customer a refund decision, and by when (B-07) | Owner (then counsel, LR-06) | CP-02.16 |
| 4 | Serving a customer directly (B-06) | Owner | CP-02.18 |
| 5 | Billing details at the first quote (B-09), and the route that records a profile after activation | Owner; backend | CP-02.21 |
| 6 | Wise Business, PV1 qualification and evidence | Owner, providers | CP-02.17 (and CP-01.11) |
| 7 | Data Loader and HubSpot facts (B-14) | Verification on the tools | CP-02.19 |
| 8 | Competent review of the claim rules (L-12, L-19) | Counsel | the legal effect of CP-02.14 |
| 9 | Publication of the Policy: company data, review, actual processing (CP-01.10, LR-05) | Owner, counsel | recording the processing authorization (CP-02.05) |
| 10 | Identity provider (B-13) | Owner | CP-02.05, .06 activation |
| 11 | Resolved: CP-01 revision 3 aligns CP-01.01's §3.1 with CP-02.01 (400 TARGET_NOT_APPLICABLE, 400 TARGET_CONTRACT_REQUIRED, 422 TARGET_STALE for a stale target); the owner's decision is unchanged | — | — |

## 12. No interference

Order 15 (authorization, RLS) and Order 25 (AWS) own their files; this order changed none of them, nor Migration Core, Intelligence Core,
reports or vendored packages. All CP-02 artifacts are new files (`docs/authority/proposals/CP-02*`, `tools/cp02.mjs`,
`tools/test/cp02-api-contracts.test.mjs`, this report); no file PR #122 changes was edited, so its merge and this branch integrate without
conflict. After PR #122 merged, `main` (`d38c00b2`) was merged into this branch; the only Order 16 files this order then changed are
CP-01's document and delta (revision 3, the error-contract rectification, recorded in `revisions`) and one dated note in Order 16's report
(the O17-01 row), both explicit, none silent.
