# CP-02: api contracts of the functional change (commands, read models, events, OpenAPI, cases and gates)

Prepared by Order 17 on 2026-10-22 against registry edition `KAVO-2026.09-R2` (the hashes of `packages/contracts/registry/PROVENANCE.json`)
and the served api `apps/api/openapi.json` at `main` `58dda63f`, integrated with `main` `d38c00b2` (PR #122 merged). It is the complement
of CP-01 revision 3 (revision 2 carries the owner's resolution of 2026-10-22, `docs/authority/decisions/2026-10-22-CP-01-OWNER-RESOLUTION.md`;
revision 3 is Order 17's rectification of CP-01.01's error contract, section 4 below): component C3 of
`docs/design/FUNCTIONAL-CHANGE-INVENTORY.md`, the handoff of `docs/design/ORDER16-FUNCTIONAL-GOVERNANCE.md` §7 and §13. The order's report
is `docs/design/ORDER17-API-CONTRACTS.md`.

**State: not adopted.** The vendored registry, `apps/api/openapi.json`, the generated web client and every handler are unchanged. Nothing
here is authority until the owner decides an item (section 8) and the authority re-issue adopts it, together with CP-01, in one re-issue;
an adopted item takes effect only with its `activation`.

## Files

| File | What it is |
|---|---|
| `CP-02.api.json` | The source, written by hand: items, contracts, commands, operations, outcomes, events, audiences, examples, compatibility declarations, the authorities each item cites with their exact words. |
| `CP-02.registry-delta.json` | Generated. Each item's registry change as JSON Patch (`test`, `add`, `replace`), CP-01's format and rules, written against the vendored bytes. |
| `CP-02.openapi.json` | Generated. The proposed operations (none served), the served operations and components CP-02 modifies (each with the hash of the served component it was written against), and every component they need. |
| `CP-02.compatibility.json` | Generated. Every change of CP-01 + CP-02 against the registry and the served api, classified, attributed and, when it can affect a consumer, with the consumers found in the code. |
| `tools/cp02.mjs` | `generate`, `check`, `explain`. |
| `tools/test/cp02-api-contracts.test.mjs` | The proof (section 6). |

`node tools/cp02.mjs generate` rebuilds the three generated files; `check` fails when a committed one differs. Both need the workspace built.

**Dependency on CP-01.** CP-02's adoption needs CP-01's registry changes (`requires` per item). CP-02 reads CP-01's delta from this
repository only and refuses any bytes whose SHA-256 is not `54d1c7062f1329bde0562f5980aebe26f38291704f7c4b85db362ce0d243665d` or whose
revision is not 3: if CP-01 changes, CP-02 is re-verified against it, never silently. The rule worked twice: CP-02 was first written against
revision 1 (`a2133dd9…`); the owner's resolution produced revision 2 (`a0148e42…`), the pin refused it and CP-02 was updated (CP-02.09, .11,
.14, .15 and .17); revision 3 changed only CP-01's prose and `revisions`, and the pin was moved in the same commit with every test passing.
CP-02 never states CP-01's operations again and never touches a path CP-01 changes; `tools/test/change-proposals.test.mjs` checks that
across proposals and runs the generator on both together.

## 1. Change record

| Field | Content |
|---|---|
| Observed reason | The decisions CP-01 records, and the reads the owner's screens need under the standing delegation, have no api contract: no command, read, event, case or gate carries them (FG F-01 to F-34, G-01 to G-14; Order 16 §7, §13). |
| Evidence and its limits | Each item cites its decision records with the exact words (`authorities` in the source; the test reads every one). Code facts were read at `58dda63f`; nothing was run against a database. No legal opinion is given. |
| Alternatives considered | Per item (sections 4 and 5). Generally: new members on closed served views were avoided where a new read serves (SellerHomeView, QuoteView); where the change belongs on a served view (the retention extension, the statement) it is declared COORDINATED with its consumers. |
| Chosen behavior | Section 3 and the delta. |
| Rejected | Writing CP-02 in the vendored registry or `apps/api/openapi.json` (D-34 §1.3); domain events for B10 corporate aggregates (D10-EVT-1: claims and outreach requests are commercial transitions); a public read that reveals the budget; identity proved by name and e-mail (CP-01.12 as the owner modified it). |
| Deferred | The items classed CONDITIONAL, PROPOSED and BLOCKED_EXTERNAL (section 5), registered for a later version without holding back the approved ones. |
| Impacted ids | 54 new registry contracts and one extended (CommissionStatement); commands CMD065–CMD081 (17); text of CMD041, CMD002, CMD027 (proposed and blocked items only); state machines ClaimReview, OutreachAuthorizationRequest; screen UI57 (conditional); 132 cases with their requirements; gates' case lists. No existing contract field is removed, retyped or made required by CP-02. |
| Producers and consumers | Producer: the authority re-issue. Consumers: `@kauro/contracts` (regenerated), the application's request and response schemas and outcome catalogues, `apps/api/openapi.json`, `apps/web/src/api/generated.ts`, the domain event registry, its payload allowlists and migrations; the consumers of each coordinated change are listed in `CP-02.compatibility.json` (found in the code at each generation, left out of the drift comparison so unrelated work never makes CP-02 stale). |
| Security and privacy | Audiences and field visibility per identity are part of the contract (section 2) and tested; the effective authorization, roles, RLS and the cross-workspace owner scope are Order 15's. No read exposes a cell value, a provider identifier, a tombstone or the free-check budget. Consent, processing authorization, session and step-up are four distinct things (CP-02.05). |
| Price and commission | None to prices. Commission: reads of figures CP-01.05 and CP-01.13 define, the retainer and offset items on the statement, the closed refusal; no rate or rule changes. |
| Data migrations | None at adoption. The implementing orders add append-only migrations (event types, aggregate kinds, tables for reviews, refusals, consents, preferences, requests, identity decisions) with their tests first. |
| Migration and transition | Prospective. Existing statements read their balance from their own items; existing audits keep their target; issued quotes keep their terms; accrued obligations are never removed. |
| Rollback limits | A contract can be withdrawn prospectively; records written under it (consents, reviews, refusals, identity decisions) stay as evidence. |
| Activation | Every item lists in `activation` what must be implemented, tested or published before the adopted item takes effect (README of PR #122): adoption is not deployment. |
| Implementation mandate | The orders after 17 by component (Order 17 report, section 10): C4 backend, C5 payments, C6 retention, C7 cores, C8 identity, C9 web, with Order 15 for authorization. Handlers and screens are not part of CP-02. |
| Owner action | Decide each item (section 8); decide the points of section 5. |

## 2. Classes, rules, audiences

| Class | Delta status (CP-01's vocabulary) | Meaning |
|---|---|---|
| `APPROVED_AWAITING_REISSUE` | `APPROVED_AWAITING_REISSUE` | Substance decided; every CP-01 item it requires is approved. Waits for the re-issue and takes effect with its `activation`. |
| `CONDITIONAL` | `CONDITIONAL` | Principle decided; an owner act, a CP-01 item not approved, or a dependent component is missing. |
| `PROPOSED` | `PROPOSED` | A recommendation; the owner has not decided the substance. |
| `BLOCKED_EXTERNAL` | `CONDITIONAL` | Not adoptable even with the owner's decision until counsel, the accountant, Wise or the CRM tool facts answer. |

The class is a member of each item beside CP-01's status, so the proposals test of PR #122 accepts CP-02 as it is (run against its rules
at `f5422605`, including the cross-proposal path ownership and the joint generator run); the README of `docs/authority/proposals/` gains the
fourth class once both PRs are on `main`.

Rules used, beside CP-01 §2: an approved item may cite only approved decisions and require only approved CP-01 items; a read of data the
platform holds, for identities that may already see it, is a design decision under A5's standing delegation; a new member on a closed
served reply is a coordinated change (server and web client regenerated together), declared with its consumers.

Audiences (`identities` in the source): `AGENCY`, `AGENCY_BILLING`, `SELLER` (own records only), `KAURO_OWNER`, `SELF`, `PUBLIC`. For each,
the source lists the fields that must never be reachable from its replies (a seller never reads `reasonCode`, `evidenceRef`, `note`, a
decline code or another seller's id; an agency never reads seller or commission data, provider identifiers or tombstones; the person never
reads the server's evidence hash; the public never reads an id, a count or money) and the route prefix it lives under. New role tokens
(`AGENCY_BILLING_READER`, `AUTHENTICATED_SELF`, `ASSIGNED_SELLER`, `PUBLIC`) are declared for Order 15 to map; nothing here grants them.

## 3. Items

| Item | O17 | Class | Requires | Registry | Api |
|---|---|---|---|---|---|
| CP-02.01 | O17-01 | APPROVED_AWAITING_REISSUE | CP-01.01 | 5 acceptance cases | StartAudit: `targetContractId` optional; reasons TARGET_CONTRACT_REQUIRED, TARGET_NOT_APPLICABLE |
| CP-02.02 | O17-03 | APPROVED_AWAITING_REISSUE | CP-01.02 | ProjectDate, ProjectDates (the hold's tokens reserved for CP-02.17) | GetProjectDates |
| CP-02.03 | O17-02 | APPROVED_AWAITING_REISSUE | — | 14 read contracts | 13 reads: project summary, board, clients, findings, estimate, activity, billing profile, billing documents, package, support cases, deletion records, refunds, the owner's refunds across workspaces |
| CP-02.04 | O17-14 | APPROVED_AWAITING_REISSUE | CP-01.02 | RetentionExtension | RequestRetentionExtension reply states class and ceiling; three outcome meanings |
| CP-02.05 | O17-12 | APPROVED_AWAITING_REISSUE | — | ConsentRecord, ConsentView; CMD065, CMD066 | RecordConsent, WithdrawConsent, ListMyConsents, ListConsentEvidence |
| CP-02.06 | O17-13 | APPROVED_AWAITING_REISSUE | — | 3 contracts; CMD067 | SetNotificationPreferences, GetMyNotificationPreferences |
| CP-02.07 | O17-05 | APPROVED_AWAITING_REISSUE | — | 4 contracts; CMD068 | RequestClaimReview, ListMyClaims, GetMyClaimHistory, GetClaimHistory |
| CP-02.08 | O17-04 | APPROVED_AWAITING_REISSUE | — | 7 contracts | ListSellers, GetSellerRecord, ListCustomers, ListStatementsByPeriod, ListClaimsAcrossSellers, GetSellerSchedule |
| CP-02.09 | O17-04 | APPROVED_AWAITING_REISSUE | CP-01.13 | SellerMoneySummary | ListSellerMoney, GetMyMoney |
| CP-02.10 | O17-06 | APPROVED_AWAITING_REISSUE | CP-01.05 | StatementBalance, StatementBalanceItem; CommissionStatement gains two optional members | GetCommissionStatement reply: `balance`, RETAINER, offset basis |
| CP-02.11 | O17-07 | APPROVED_AWAITING_REISSUE | CP-01.06, CP-01.07 | AlertCondition, Alert, SellerAlertView | ListOwnerAlerts, ListMyAlerts (inactivity from material progress only) |
| CP-02.12 | O17-08 | APPROVED_AWAITING_REISSUE | CP-01.14 | PolicyLegalStatus | ListPolicyLegalStatus |
| CP-02.13 | O17-11 | APPROVED_AWAITING_REISSUE | — | 3 contracts; CMD069, CMD070; machine OutreachAuthorizationRequest | ExportCommissionStatement (CSV, PDF), RequestOutreachAuthorization, DeclineOutreachAuthorizationRequest, two lists |
| CP-02.14 | O17-05 | APPROVED_AWAITING_REISSUE | CP-01.04, CP-01.14 | ClaimRefusal; CMD071, CMD072; machine ClaimReview | RefuseAttribution (evidence always, note for OTHER, a rule in force for OWNER_RULE), DecideClaimReview; legal effect PENDING_COUNSEL |
| CP-02.15 | O17-09 | APPROVED_AWAITING_REISSUE | CP-01.12 | 3 contracts; CMD073–CMD076 | ListIdentityGroups, GetDecisionPreview, ListIdentityDecisionRecords, ApplyProvenIdentity, DecideMany, ChangeDecision, UndoBatch; activation through the core (C7) |
| CP-02.16 | O17-10 | PROPOSED | — | RefundDecisionNotice; CMD077 | RecordRefundNoticeSent, GetRefundDecisionNotice |
| CP-02.17 | O17-15 | BLOCKED_EXTERNAL | CP-01.11 | TransferProof; CMD078 | RecordTransferProof |
| CP-02.18 | O17-16 | PROPOSED | — | DirectServiceAssignment; CMD079 | AssignDirectService |
| CP-02.19 | O17-17 | BLOCKED_EXTERNAL | — | 2 contracts; CMD080; CMD041 effect text | GetImportStageReconciliation, ChooseKeptRecordId |
| CP-02.20 | O17-18 | CONDITIONAL | CP-01.03 | 2 contracts; CMD081; screen UI57 | GetFreeCheckAvailability (public), RecordFreeCheckEligibility |
| CP-02.21 | O17-19 | PROPOSED | — | CMD002 and CMD027 precondition text | ActivateAgency: `billingProfileRef` optional; CreateQuote outcome meaning |

Totals: 15 approved, 1 conditional, 3 proposed, 2 blocked by an external party; 57 proposed operations (17 commands, 40 reads); 5 served
operations modified (StartAudit, RequestRetentionExtension, GetCommissionStatement, ActivateAgency, CreateQuote); 54 new registry contracts,
1 extended; 9 new event types, 2 new subscriptions and 3 payload changes of registered events; 2 state machines.

Every item carries positive, negative and adversarial acceptance cases (written as registry cases with their requirements and gates);
every command carries the registry's own OK, DENY and RACE cases.

## 4. Approved items: what Order 17 decided inside the delegation, and why

- **CLEAN (CP-02.01).** The project's mode decides; no request member chooses the branch. CP-01 revision 2 named the refusal "422
  TARGET_NOT_APPLICABLE" and said a CRM project without a target is "still TARGET_STALE"; CP-01 revision 3 now states the contract below,
  so the two records agree. Order 17 keeps `TARGET_NOT_APPLICABLE` as the reason
  but answers `400 INVALID_REQUEST`, as CMD011 does for `TARGET_INSTANCE_REQUIRED` (the repository's convention for a mode-dependent member),
  and answers a missing CRM target `400 INVALID_REQUEST TARGET_CONTRACT_REQUIRED`: today it is `400 SCHEMA_VIOLATION`, so no client that
  branches on status sees a change. `TARGET_STALE` stays for a target that is given but not current. The closed request schema cannot say
  "required unless CLEAN" (the strict validator has no conditional keywords and the mode is not a request member), so the handler enforces it.
- **Dates (CP-02.02).** One entry per date kind, each with its rule, anchor, state and the action and role available; `governingRetentionKind`
  points at the date that deletes the data and nothing adds two dates. The hold's kind is in the vocabulary (the five dates are the owner's
  F-24) and is `NOT_APPLICABLE` until CP-02.17: the item declares that reservation (`reserves`: the tokens, CP-01.11, CP-02.17 and why), so
  activating the hold never widens a closed reply. The retention label it shows is CP-01.02's, which it requires. Quote and order views get
  no link member: their clients reach the dates by `projectId`, so no closed reply changes.
- **Workspace reads (CP-02.03).** Each read is a registry contract of its own (no aggregate exposed whole): `RefundListItem` leaves
  `providerRefundId` out, `DeletionRecordItem` the tombstone, `FindingExampleRef` points at a cell the existing PreviewTable reads under its
  own authorization instead of carrying a value; `PackageArtifactItem` has no role or privacy class for internal evidence. The estimate says
  `ESTIMATE` and reserves nothing. The owner's refunds page (G-14) has its own read across workspaces.
- **Extension (CP-02.04).** The reply states the record's class, the ceiling and which ceiling applied (17 days from sealing for UNPAID,
  never more); three outcome tokens keep their names with a new meaning (declared COORDINATED: the web copy follows).
- **Consent (CP-02.05).** A consent record per act, kind and channel; marketing per channel as POL 8.3 lists them (e-mail, call, SMS,
  messaging); withdrawable here only for marketing (revoking the processing authorization is a claim under the rights procedure, Decreto
  1074 art. 2.2.2.25.2.6, CHECKLIST C-11). The approval rests on the law items of the CHECKLIST (C-04, C-05, C-11, C-51), not on the draft
  Policy. The public contact form records its consent through its own route, not this authenticated command. The person's
  own view leaves the server's evidence hash out; the owner reads the proof for a rights request or an authority. Recording the processing
  authorization needs a published Policy version (CP-01.10, LR-05): until then the command refuses `DOCUMENT_VERSION_NOT_PUBLISHED`.
- **Preferences (CP-02.06).** Essential topics cannot be disabled; marketing is not a topic.
- **Claims (CP-02.07, CP-02.08, CP-02.14).** The seller's request for a review, both histories and, since the owner approved CP-01.04's
  content on 2026-10-22, the refusal with a closed code: evidence on every refusal, a note for `OTHER`, and for `OWNER_RULE` a versioned
  rule that was in force when the claimed facts happened (Order 16's reading of "never retroactive": a later rule is refused,
  `OWNER_RULE_NOT_IN_FORCE`). The legal effect on sellers stays `PENDING_COUNSEL` (CP-01.14, L-12, L-19): an activation condition, not a
  reason to hold the contract back. Order 16 asked for "events for each" claim command; B10's decision D10-EVT-1 says corporate aggregates
  publish no domain event, so these are commercial transitions, and the seller's e-mail goes out from that transaction (handoff C4). The
  seller's schedule is a new read: `SellerHomeView` is closed and validated by the web client, so new members there would be a coordinated
  change for nothing.
- **Seller money (CP-02.09).** The four figures of OPS-1 with the periods the owner fixed in CP-01.13 (month of the confirmed capture; month
  the refund happened, never rewriting an earlier period); pending is split into held and payable, the amount states CP-01.13 keeps apart.
- **Statements (CP-02.10).** `RETAINER` items carry the retainer accrual's line as `lineId`, so `lineId` stays required on the served item
  view; the balance is optional in the stored record (older statements have none) and computed by the read for every statement from its
  own items; an accrued obligation is never removed. The seller reads which refund and project an offset comes from (F-17, OPS-4).
- **Alerts (CP-02.11).** Inactivity counts only from the material acts of `alerts.relevantProgress` (CP-01.07 as the owner modified it);
  the excluded acts never reset it, and nothing moves a retention, legal or quote date. `INACTIVE` alerts carry `lastMaterialProgressAt`.
  A seller's alerts are `SellerAlertView`: claim subjects only, no agency, enforced by the contract rather than by a rule.
- **Export and outreach request (CP-02.13).** The CSV neutralizes formula prefixes; a request to authorize outreach is neither an
  authorization nor a recipient's consent, and the seller's view of it omits the owner's decline code.
- **Identity (CP-02.15).** Follows CP-01.12 as the owner modified it: `PROVEN_IDENTITY` only from Migration Core's proving keys (a source
  record id within one identity space; an authoritative external id once the core verifies it, which it does not do yet: until then
  `EXTERNAL_ID_NOT_VERIFIED`); equal normalized e-mail and full name is a `CANDIDATE`, never proof, decided by a person with DecideMany
  (at most 100 groups, the exact preview hash and an explicit approval member); nothing is folded to manufacture a proof; the five blocking
  conflicts refuse; every decision is recorded with decision, evidence, person, version and effect. `ApplyDemonstratedBatch` of the first
  draft became `ApplyProvenIdentity`. The evidence classes, the verification and RevisePlan are the core's (C7): activation, not adoption.

## 5. Conditional, proposed and blocked items

Each states (1) the condition that unlocks it, (2) the contract (in the delta and the OpenAPI), (3) rules, states and errors (in the
source and the OpenAPI outcomes), (4) compatibility and migration, (5) cases, (6) why it cannot be adopted yet.

| Item | (1) Unlocks when | (4) Compatibility and migration | (5) Cases | (6) Why not yet |
|---|---|---|---|---|
| CP-02.16 refund notice | The owner decides B-07; counsel words the promise (LR-06), not blocking the contract | New contract, command and two subscriptions (ADDITIVE); the notice is billing information (AGENCY_BILLING) | sent and recorded; approval never implies a message; wrong party refused | Who tells the customer and by when is a customer promise the owner has not made |
| CP-02.17 transfer proof | Wise Business enabled and the ACH route qualified with real evidence (PV1 §2); CP-01.11's pending points; counsel reviews LR-02. The values are the owner's since 2026-10-22: five US banking days (FedACH calendar), the earlier of that and 24 days from sealing, owner review from the third unpaid hold in 90 days, step-up | New command (ADDITIVE); RetentionRecord gains the hold class (CP-01.11, COORDINATED) | one bounded hold with its effective end; abuse (two orders, new quote, late proof, mismatch, races); the third unpaid hold needs the owner; never execution | The owner blocked activation on PV1: the matching rule depends on evidence the route has not shown yet |
| CP-02.18 direct service | The owner decides B-06 | A separate command keeps CMD048's `sellerId` meaning (ADDITIVE) | rights kept; no retroactive date; owner only with step-up | It changes a seller's compensation; undecided |
| CP-02.19 staged reconciliation | The Data Loader and HubSpot facts are verified on the real tools (B-14); the cores deliver the engine | New read and command (ADDITIVE); CMD041 effect text (TEXT) | proved IDs only; no guessed link; ID outside the evidence refused | Whether result files can prove an ID depends on what the tools write |
| CP-02.20 self-serve free check | The owner signs the A3 §3.2 amendment (B-03); the Terms' "exhausted" changes only through LR-11 | New public read, command, screen UI57 (ADDITIVE) | eligible person reaches upload; paused offers no upload; the public read leaks nothing | A3 §3.2 in force binds the call to action to the fit form; a drawn screen does not approve a route |
| CP-02.21 billing at first quote | The owner decides B-09; the route that records a profile after activation is named | ActivateAgency request member becomes optional (ADDITIVE); CreateQuote outcome meaning (COORDINATED) | activation without profile; no quote without one; another agency's profile never used | It changes what activation requires; undecided, and today a profile reaches the agency only through CMD002 |

A screen in the review never authorizes anything: the prototypes are evidence of design, not of approval. The owner's resolution of
2026-10-22 decided CP-01's items only; B-03, B-06, B-07, B-09 and the tool facts of B-14 stay open.

## 6. Proof

`tools/test/cp02-api-contracts.test.mjs` (15 tests, 50 broken copies). Every rule runs on the proposal and on deliberately broken copies,
and each broken copy must fail for the rule's own reason:

1. procedure: every O17 group has an item; ids, the four classes and their statuses, approvals, activation, open points, unlock and reason
   for every non-approved item, the three kinds of acceptance case, the change record lists each item with its class and a decision row,
   test-before-replace, no remove, no path changed by two items;
2. application: base hashes equal PROVENANCE and the files on disk; CP-02 applies alone and after CP-01; every record and key is kept; ids
   stay unique; the contracts generator accepts both results in a temporary directory; the vendored registry is unchanged afterwards;
3. CP-01: the pinned bytes, and no CP-02 operation on a path CP-01 changes;
4. authority: every cited decision exists in its record with the cited words; every id cited anywhere in an item is a recorded decision,
   a CP-01 item or a CP-02 item; an approved item cites only approved decisions, requires only approved CP-01 items, depends only on
   approved CP-02 items, and mentions a non-approved CP-01 item only in its activation or in a declared reservation;
5. correspondence: command ↔ operation ↔ registry command with its three cases; case ↔ requirement ↔ gate; every new contract used by an
   operation; events new, named after their aggregate, payloads of safe kinds only, consumers registered, produced by a declaring
   operation; a command without an event only as a D10-EVT-1 commercial transition; subscriptions not already present;
6. authorization: declared audiences and roles, route prefixes, forbidden fields reachable from each reply per audience (new operations and
   the members CP-02 adds to served replies), step-up for money or step-up rules, and the four consent notions kept apart;
7. OpenAPI: committed files equal the generated ones; request members are the registry fields; replies are the registry contracts; every
   reference resolves; parameters and shapes are the served api's; no served route or operationId collides; modified components were
   written against the served bytes and add only members of their registry contract; the web client generator translates the result, and
   the committed web client is still the one generated from the served api alone;
8. compatibility: every change that can affect a consumer (registry, served api, payloads of registered events) is declared with the computed
   class, a migration, and for a break the approved decision that accepted it; each is attributed to the item that really makes it; the
   classifier is itself tested on real breaks;
9. examples: valid examples pass and invalid ones fail with the expected field and code under the api's strict validator.

## 7. Adoption with CP-01

1. The owner decides, in section 8 here and in CP-01's decision block, the items to adopt. Only `APPROVED_AWAITING_REISSUE` items whose
   `requires` are adopted with them may be adopted; the others stay registered.
2. The re-issue applies CP-01's decided items, then CP-02's, to the registry, records the new edition and hashes in PROVENANCE, and
   regenerates `@kauro/contracts`. Items left out are rebased by `node tools/cp02.mjs generate` on the new edition for the next version.
3. Each adopted item takes effect only with its `activation`, delivered by the implementing orders, tests first: serve the operations
   (tools/openapi.mjs moves them into `paths`), regenerate `apps/api/openapi.json` and `apps/web/src/api/generated.ts`, add the reasons to
   `FAILURE_REASONS` and the outcome catalogues, the event types and aggregate kinds to the domain registry and its migrations; the
   coordinated changes are deployed server and web together.
4. The adopted items become `ADOPTED` with the provenance hash, and this test is extended to check them against the registry.

## 8. Owner's decision

| Item | Decision (adopt / reject / change) | Date | Owner's words |
|---|---|---|---|
| CP-02.01 | | | |
| CP-02.02 | | | |
| CP-02.03 | | | |
| CP-02.04 | | | |
| CP-02.05 | | | |
| CP-02.06 | | | |
| CP-02.07 | | | |
| CP-02.08 | | | |
| CP-02.09 | | | |
| CP-02.10 | | | |
| CP-02.11 | | | |
| CP-02.12 | | | |
| CP-02.13 | | | |
| CP-02.14 | | | |
| CP-02.15 | | | |
| CP-02.16 | | | |
| CP-02.17 | | | |
| CP-02.18 | | | |
| CP-02.19 | | | |
| CP-02.20 | | | |
| CP-02.21 | | | |
