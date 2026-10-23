# Order 19A: the joint re-issue candidate of CP-01 and CP-02 (prepared, not adopted)

Branch `order19a/reissue-preparation`, started from `main` at `da68c19862f8ff0e448dac36edc34d55fa3dfef4` (Orders 16 and 17 merged, CI
`verify` green on it, run 39853592845). The candidate lives in `docs/authority/proposals/reissue-candidate/`; it is built by
`tools/reissue/reissue.mjs` and proved by `tools/test/reissue-candidate.test.mjs`.

**Nothing is adopted.** `packages/contracts/registry/`, `apps/api/openapi.json`, `apps/web/src/api/generated.ts` and
`packages/contracts/src/generated/` are byte-identical to `main` (the test pins their hashes and refuses any change), no decision,
amendment or legal text was touched, and no item was activated, re-issued or signed. Adoption is Order 19B's, only with the owner's
explicit approval of that PR at that SHA.

## 1. What the candidate is

| File | Content |
|---|---|
| `REISSUE-CANDIDATE.source.json` | Written by hand: the pinned inputs, the profiles, each item's state and who satisfies each of its conditions, the declared resolution of every place where two items meet, the two component renames, the compatibility reconciliation, the adoption gates and the residual dependencies. |
| `REISSUE-CANDIDATE.combined-delta.json` | Generated. The combined registry delta: CP-01's 14 items then CP-02's 21, each item's JSON Patch carried unchanged, with its state, class, profiles, `requires` and `dependsOn`. This is what Order 19B applies (the items of its profile, in this order). |
| `REISSUE-CANDIDATE.json` | Generated. The manifest: the bytes in force (15 files, by SHA-256), the input pins, per profile its items, the candidate registry hashes and record counts, the hash of every generated consumer, its planned operations, its compatibility summary; per item its state, decision, legal effect, conditions with their satisfiers, implementing orders and coordinated changes; the 20 resolved meeting points; the adoption gates. |
| `adoption/`, `build/` | Generated, per profile: `registry.provenance.json` (the candidate registry's hashes), `contracts/types.ts` and `contracts/schemas.json` (the authority's own generator, unchanged, run on the candidate registry), `api/openapi.json` (the served document as the candidate would have it), `web/generated.ts` (the closed web client generator's output for that document). |

No generated candidate file can pass for the authority in force: the candidate registry's provenance source begins `CANDIDATE
REISSUE-CANDIDATE-01 (<profile> profile), NOT ADOPTED; base: …` with `status: CANDIDATE_NOT_ADOPTED`, so the contracts' headers quote
it; the document carries `info.x-kauro-candidate`; the web client's first two lines say it is a candidate generated from the candidate
document (the closed generator's own header, kept unchanged below them, names `apps/api/openapi.json`); `materialize` writes the same
marked provenance.

`node tools/reissue/reissue.mjs generate` rebuilds every generated file; `check` fails when one is stale or a byte in force moved;
`materialize <adoption|build> <dir>` writes a profile's registry (with a candidate `PROVENANCE.json`), contracts, document and client
into an empty directory, for an implementing order that builds against the candidate. All three need the workspace built, like
`tools/cp02.mjs`.

**Inputs, pinned by SHA-256:** CP-01's delta (revision 3, the same pin CP-02 carries), CP-02's delta, source and OpenAPI, CP-02's
compatibility matrix without its consumer lists (they follow unrelated code), the owner resolution, CP-02's and CP-01's records. A changed
input makes the candidate refuse to build until it is re-verified.

## 2. Profiles: what Order 19B would adopt, and what stays out

| Profile | Items | Registry (records before -> after) | Served document | Compatibility |
|---|---|---|---|---|
| `adoption` | the 26 `APPROVED_AWAITING_REISSUE` items: CP-01.01–.08, .12–.14 and CP-02.01–.15 | contracts 73 -> 120, commands 64 -> 76, machines 12 -> 14, cases and requirements 441 -> 540, screens unchanged | 49 planned operations; StartAudit and RequestRetentionExtension gain their outcomes; AuditView, StartAuditRequest, RetentionExtensionView and the statement views modified | 230 changes: 183 additive, 13 text, 32 coordinated, 2 breaking |
| `build` | adoption plus the 5 `CONDITIONAL` items: CP-01.10, CP-01.11, CP-02.17, CP-02.19, CP-02.20 | contracts 73 -> 125, commands 64 -> 79, screens 55 -> 57, cases and requirements 441 -> 559 | 54 planned operations | 271 changes (a coincidence with the recorded 271 of section 5; the 11 left out are the proposed items' changes) |
| neither | the 4 `PROPOSED` items: CP-01.09 (deferred by the owner), CP-02.16, CP-02.18, CP-02.21 (B-07, B-06, B-09 undecided) | — | — | — |

**The adoption profile is the most Order 19B may adopt, not what it must.** Before any item enters the re-issue: the owner approves the
Order 19B PR at its SHA; for a CP-02 item the owner fills its row of CP-02 section 8 (empty today: Order 17 classed fifteen items approved
on earlier decisions, and CP-02 section 7.1 makes that block the adoption act); every one of the item's conditions is satisfied with
evidence by the order or gate the manifest names; the items it requires or depends on enter with it (the profile closure is tested). An
item whose conditions do not hold stays out with its state. Adoption of a value is never a deployment and never changes a legal text.

**Held by Order 19B's own exclusions.** Order 19B adopts no elevated retention and nothing `PENDING_COUNSEL`. Five adoption items
fall under those exclusions; their states stay as recorded, but each is adoptable only after the condition below has recorded evidence
(`o19bExclusions` in the source and the manifest; every item also carries `adoptableOnlyAfter`), and an item that requires one is held
with it (`adoptableOnlyWith`):

| Item | Exclusion | Adoptable only after |
|---|---|---|
| CP-01.02 | elevated retention (17 days for UNPAID, only through the one extension) | `LEGAL_PROCEDURE_C2` records LR-01's competent wording, and O21 has delivered and tested the ceiling, deletion and no resurrection |
| CP-02.04 | elevated retention (the extension reply serves the 17-day ceiling) | CP-01.02 is adoptable |
| CP-01.04, CP-01.14, CP-02.14 | `PENDING_COUNSEL` (the claim rules) | `COUNSEL_REVIEW_CP01_14` records the competent review (L-12, L-19) as CP-01.14's validation |
| CP-02.02 (requires CP-01.02), CP-02.12 (requires CP-01.14) | held with the item they require | that item is adoptable |

The test refuses a `PENDING_COUNSEL` adoption item or the writer of the retention exception left unflagged, a condition that names none
of the item's satisfiers, and a flag on an item outside the adoption profile.

**The build profile is never adopted as a whole.** It is the contract O20, O21, O22, O24, O27A and O29 build and test against with the
activation off: a CONDITIONAL item's principle and values are decided, its adoption is blocked by a named condition (PV1 and Wise for the
hold, the CRM tool facts for the reconciliation, company data and review for the Policy page, the A3 §3.2 amendment for the self-serve
free check). PROPOSED items are in neither profile: their substance is undecided, so nobody builds them yet.

**The edition label is not set by the candidate.** Each candidate registry keeps `KAVO-2026.09-R2`; Order 19B sets the new label,
`source` and `vendored_at` as one recorded act, so the adopted `policy.json` and `PROVENANCE.json` differ from the candidate's by those
fields only.

## 3. States carried, legal effect, conditions

Each item carries exactly its record's state (the test parses both records): CP-01 from the owner resolution's "In the proposal" column
(eleven `APPROVED_AWAITING_REISSUE`; CP-01.10 and CP-01.11 `CONDITIONAL`; CP-01.09 `PROPOSED`, deferred, its current UI03 text stays);
CP-02 from Order 17's classes (fifteen approved, CP-02.20 conditional, CP-02.17 and CP-02.19 blocked by an external party, three
proposed). The legal effect of the claim rules is `PENDING_COUNSEL` with no validation for CP-01.04, CP-01.14 and CP-02.14, in every
profile's registry; CP-02.12 only reads that status.

Every activation and pending condition of every item names who must satisfy it before Order 19B may activate it (the manifest's
`conditions[].by`). The implementing orders: O20 (CLEAN: CP-01.01, CP-01.03, CP-02.01, part of CP-02.03), O21 (retention: CP-01.02,
CP-02.02, CP-02.04, the hold's deletion), O22 (seller money, statements, claims, alerts: CP-01.04–.07, .13, CP-02.07–.14), O23A (consent and
preferences: CP-02.05, CP-02.06, CP-01.10's record), O24 (web: the regenerated client's consumers, UI56, UI57), O27A (the hold's proof
intake and limits, the refund notice), O29 (CP-02.19's tool facts), O15 (roles and row policies), CORE (O18A and O18B: proving keys, the
verification of a declared external id, adversarial identity fixtures, the reconciliation engine). The gates: the owner's decisions,
`COUNSEL_REVIEW_CP01_14`, `LEGAL_PROCEDURE_C2` (LR-01, LR-02, LR-05, LR-06, LR-11), O31 (company data, Wise Business), O27B (PV1), O34
(CP-01.09's final visual review) and O19B itself.

## 4. The combined delta and its conflicts

The two deltas are disjoint: no path is written by two items, no item tests a value another changes, and a nested write happens only
where the inner item depends on the outer (CP-01.07 adds `alerts.relevantProgress` inside the `alerts` CP-01.06 adds). The test proves
each rule can fail. Every place where two items meet is computed and must be declared with its resolution; there are 20: 14 appends to
the same list (cases, requirements, contracts, commands, machines, screens UI56 then UI57, and eight gates' `caseIds`), 3 sets of new keys
in the same policy object, the nested add above, and two records touched on different members (RetentionRecord by CP-01.02 and CP-01.11;
UI03 by CP-01.08 and the deferred CP-01.09). Everything is found by id or name, never by position, so a profile that leaves an item out
loses only that item's records.

**A conflict found in the served layer.** Merged into one served document, two of CP-02's component names clash with served
components of another meaning: CP-02.08's `SellerRecordView` (the owner's read of one seller) against B10's served `SellerRecordView`
(an owner-tools record), and CP-02.03's `SupportCasePage` (the agency-wide page) against the served one-project page. CP-02's own OpenAPI is a
separate document, so the clash never showed there (its web-client test merges by `Object.assign`, which would silently replace the served
component). The candidate refuses any undeclared clash and renames the proposed components, by declaration, to `OwnerSellerRecordView`
and `AgencySupportCasePage`, every reference rewritten; the registry contracts keep their names and their `x-kauro-schema-id`. The
implementing orders serve those reads under these names or other free ones.

**The binary export.** CP-02.13's statement export answers `text/csv` and `application/pdf`, which the closed web client generator does
not translate; the client is generated from a copy without that content (one recorded adaptation, the export is downloaded by URL), and
the test proves it is the only failure without it.

## 5. Compatibility revalidated: 271 + 11 = 282

The order asked for the 271-change compatibility matrix to be revalidated. 271 is the count Order 17 recorded at `abde528b`, before its
final review; that review added 11 (AuditView and RetentionView projections, nine `audit.*.v1` payloads), so `main` holds 282. Recomputed
on the candidate with every item, the matrix equals `CP-02.compatibility.json` (key, class, detail, attribution); without the 11, the
remaining 271 equal the recorded ones by digest (and by layer: 189 registry, 79 api, 3 events). Per profile, every non-additive change is
one CP-02 declares with the same class, no served projection is left behind, and the only breaks are CP-01.01's accepted
`Audit.targetContractId` and its served consequence in AuditView.

## 6. Proof

`tools/test/reissue-candidate.test.mjs`, 20 tests, each rule also run on broken copies that must fail for the rule's reason: bytes in force
(and equal to CP-02's recorded base); pinned inputs; freshness of every generated file; disjoint patches; declared conflicts; component
renames; states against both records; profile closure; satisfiers; legal effect; CP-01's decided values on each candidate registry (no
existing policy value changes, UI03 and UI07 equal the web's amended copy, nothing conditional or deferred in adoption); CP-02's commands,
cases, requirements, gates and contracts following their items, and the registry's own invariants; the served document (every served route
as it is, planned operations exactly the profile's, every reference resolves); the web clients; CP-02's examples on each candidate (and
the left-out ones not passing there); the compatibility revalidation; the items held by Order 19B's exclusions; the candidate markers; `materialize`.

## 7. Left to others

- **Dispatcher.** No catalogue order names the identity-decision handlers (CMD073–CMD076) and the RevisePlan wiring in
  `packages/application` (`UNASSIGNED_C4`); CP-01.12 and CP-02.15 cannot be activated without them. Order 19B's listed paths miss
  `apps/web/test/support/registry.ts` (CP-01.08's activation removes the UI03 and UI07 rows in the same re-issue),
  `packages/contracts/test/registry.test.ts` (its counts change: 64 -> 76 commands, 12 -> 14 machines) and `apps/web/src/api/generated.ts`.
- **Owner.** CP-02 section 8; B-03, B-06, B-07, B-09; CP-01.09 at the final visual review.
- **Counsel, legal procedure, providers.** The claim rules' legal effect; LR-01, LR-02, LR-05, LR-06, LR-11; PV1 and Wise Business;
  the B-14 tool facts.
