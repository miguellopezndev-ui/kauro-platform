# Order 15: authorization, roles, sellers, owner and tenant isolation

Branch `order15/security-authorization`, started from `main` at `3f6a8d32d32fe7d65888545a9b43960d97f13f53` (PR #118 merged) and rebased onto
`main` at `da68c19862f8ff0e448dac36edc34d55fa3dfef4` (PRs #119 to #123 merged; none of them touches the files below). Final SHA: the PR head.
Scope: authorization and the authentication bound to it, permissions, isolation between agencies, and the security of the existing routes.
Out of scope by the order: `cores/kauro-migration-core/` (Order 13), `cores/kauro-intelligence-core/`, `packages/reports/` and the package
reader (Order 14), and design files owned by other sessions. None of them is touched (see "Non-interference").

This report states what was verified, what failed and was repaired, and what stays pending. It does not describe how to exploit anything:
each finding names the rule that was broken, the surface, the repair and the test that proves it.

## 1. Method

1. Preflight: the route inventory (`apps/api/openapi.json`, 159 operations, held to the server's registered routes by `tools/openapi.mjs`),
   the authorizers, the persistence adapters, the RLS policies, the session boundary and the web shell.
2. Four independent read-only reviews (tenant objects; seller and owner; payments, bank and services; database roles, RLS and sessions),
   each asked for findings traced route to handler to authorizer to SQL, with the tests that cover them. Every candidate was then checked
   by a test against the real api, not accepted from the review.
3. An executable matrix over every served route (section 2), then red-first tests for each confirmed defect, the repair at the point that
   controls the access, and the regressions of the touched components.

Every test runs the real Fastify server built by the real composition root over a real PostgreSQL 17 cluster the test starts (runtime
login roles, forced RLS, the real authorizers). Providers are the labelled contract fakes the repository already uses (SIMULATED); no real
credential, no external system and no production system was used. All data is synthetic.

## 2. The access matrix

`apps/api/test/o15-access-matrix.test.ts` is the matrix. It classifies every operation of the contract into one principal class, checks the
class against the route's declared role (`x-kauro-role`), and fails when a route is added without a class. For every served route it then
sends a request whose body passes admission (built from the route's own request schema), with fresh ids and agency A in the path and in
`X-Kauro-Agency`, as each identity the class must refuse, and asserts that the refusal comes from authentication or authorization (never
from the absence of the object), with no journal entry, no event, and no table's content changed but the security facts (a digest of
every row of every table, so an update is seen as well as an insert). A control request as the
admitted identity proves no refusal is a route refusing everyone.

| Class | Routes | Who is admitted | Enforced at | Refused in the matrix |
|---|---|---|---|---|
| AGENCY | 63 | an ACTIVE membership of the agency, then the command's role | `packages/authorization/src/authorizer.ts` (`authorize`, `authorizeRead`, steps 1 to 7) inside the TENANT unit; RLS `agency_id = current_agency_id()` | anonymous, the payment service, disabled, unverified, a verified person with no role, a suspended member, a member of the other agency, the corporate owner, sellers in every state |
| KAURO_OWNER | 59 | the caller's ACTIVE `KAURO_OWNER` grant | `authorizeCorporateOwner` (`packages/application/src/commercial/authorizer.ts`), `authorizeOperator` (`packages/application/src/commerce/core/authorizer.ts`), `ownerFirst` (bank refund commands) | everyone but the owner: agency owners and members, sellers in every state, the payment service |
| SELLER_OR_OWNER | 12 | the caller's own (active or assigned) seller row, or the owner | `authorizeSeller`, `authorizeStatementSeller` then `authorizeCorporateOwner`; RLS `current_seller_id()` / `acting_seller_id()` | anonymous, the payment service, disabled, unverified, no role, agency members of either agency |
| SELLER | 4 | the caller's own seller row (ACTIVE for prospect work; any state for the payout destination; not CANDIDATE for the home) | `authorizeSeller`, `authorizeSellerSelf`, `authorizeStatementSeller` | as above, and the corporate owner |
| SERVICE / SERVICE_OR_OWNER | 6 | a verified service identity of the command's technical role in this environment (and the owner for CMD056, CMD059) | `authorizeCommercialService`, `authorizeService`, `SERVICE_ROLE_TABLE` | every person, and any other service (`o15-service-identities.test.ts`) |
| IDENTITY | 3 | any verified identity (CreateAgency, ListAgencies, AcceptInvitation) | `authorize` steps 1 to 3 | anonymous, the payment service, disabled |
| PUBLIC, PROVIDER, SESSION | 12 | no credential, a provider signature, the browser session boundary | public routes, webhook verifier, `apps/api/src/sessions.ts` | covered by `b11-public-routes`, `cmd030-payment-webhook`, `b11-sessions` |

Identities in the matrix: anonymous; the payment service's credential; a disabled identity; an unverified identity; a verified person with no
role; agency A's OWNER, VIEWER and a SUSPENDED member; agency B's OWNER; the corporate owner; sellers ACTIVE, SUSPENDED, TERMINATED and
CANDIDATE. Final run: 1,760 refusal cells, every one refused by authentication or authorization with nothing written, and every control admitted.

Object-level (BOLA) isolation is proven per object family by the per-command tests that already existed (each names a foreign and an unknown
id: cmd009 to cmd060, `b16-tenant-sweep`, `job-reads`, `audit-reads`, `source-reads`, `support-case-reads`, `commission-statement-reads`,
`ach-route-cells` for transfer instructions) and, for the routes whose foreign half had no test, by `o15-object-isolation.test.ts`.

## 3. Findings

| Id | Finding | Severity | Status |
|---|---|---|---|
| F-01 | The owner's bank refund commands (CMD032 with a destination, CMD220 to CMD225) checked the KAURO_OWNER grant only inside their payment-service unit, after reading the cited restricted evidence, locating the refund or attempt in any agency and taking the account's OUTBOUND stream lock. A person without the grant got NOT_FOUND for an unknown id and CORPORATE_ROLE_MISSING for an existing one (an existence signal across agencies), the denial fact named the agency of the located refund, and the request could queue on the owner's stream lock. | Medium (BFLA ordering, cross-tenant existence signal, lock contention) | Fixed |
| F-02 | The owner's approval naming a destination (CMD032, CMD220) did not fence the browser session in its unit (rule 16): a logout committed while the approval waited did not stop it. | Low | Fixed |
| F-03 | A verified service identity presented on another service's command was refused, but the refusal's durable fact was written in a unit of the presented service's runtime group, which those routes never bind: the answer was 422 INTEGRITY_FAILURE or 500 INTERNAL_ERROR and the attempt left no fact. | Low (audit loss, wrong answer; no effect) | Fixed |
| F-04 | Every command pipeline but the bank owner commands judged the browser session only at the transport: a logout committed while a command ran inside its unit did not stop the command. Pipelines: B06's `runCommandIn` (B06, B07, B08 and the team commands), the commerce and commercial pipeline `runCommerceCommand` (every B10, B12 and B16 owner, seller and operations command, and the agency's refund commands), the provider-effect intent of `runProviderCommand` (CMD028, CMD029), the quote pipeline (CMD027) and the two-phase source reservation (CMD013). Membership and identity changes were already fenced (D-TX-2). The first candidate repaired only `runCommandIn`; the dispatcher's review found the rest (R-01). | Low (a narrow race), inside the order's mandatory revocation criterion | Fixed |

### Repairs

- F-01: `ownerFirst` (`packages/application/src/commerce/bank/approve-destination.ts`) judges the grant in an OPERATOR unit of its own before
  anything of the command is read or locked, records the refusal in the person's own stream (no agency named), answers a unit that could not
  decide as the command's own retriable failure (never permission), and is called first by `runOwnerRefund` and by `ownerCommand`
  (`execute-refund.ts`). The definer's verdict after L1 stays the authority at the effect.
- F-02: `runOwnerRefund` fences the presented session with `judgedUnderHold` as the unit's last lock, after the source's transition and row
  locks and the writes, before the ALLOW fact and the journal commit (`kauro.payment_session_fence`, migration 0081). A journaled replay of an
  owner bank refund command is answered only under a credential that still authenticates the request. The stale "GAP" notes are replaced.
- F-03: the refusal is recorded in the command's own service group (`ownServiceContextOf` in
  `packages/application/src/commercial/statements/service.ts`; the payment service's id in `apps/api/src/payments/service-commands.ts`) and
  names the presented service as its actor.
- F-04: each person-command pipeline fences and judges the request's credential (`judgedUnderHold`) as the unit's last lock, immediately
  before its journal commit, and before answering a journaled replay: `runCommandIn` (`packages/application/src/commands/runtime.ts`),
  `runCommerceCommand` (`commerce/request/runtime.ts`, as a check registered for the committed instant, which runs after every wait of the
  work immediately before COMMIT, where the bank bodies already judged it; their hold and this one re-lock without waiting),
  T1 of `runProviderCommand` (`commerce/core/provider-effects.ts`, the authority now passed by CMD028 and CMD029; a SERVICE principal has
  none), CreateQuote (`commercial/quotes/create-quote.ts`: the answer, the replacement's intent and the replay) and ReserveUpload
  (`sources/handlers/reserve-upload.ts`: the session's issuance unit and every hand-out of the upload's bearer credential). A bearer
  credential is verified again as it stands; a cookie session's row is held FOR SHARE until COMMIT, so a logout that starts later waits for
  it. Units that only complete an effect the person already authorized (the provider protocol's T4, a replacement quote's completion) are
  not fenced: the authorization point is the fenced intent.
- Test harness: `FaultRouting` gains `Routing.unrouted` (`apps/api/test/fault-support.ts`): the refund lane's routed invocations leave the
  owner's new kauro_app grant unit on the api's own pool, unrouted and uncounted, so the cells keep routing and numbering exactly the
  command's payment-service units. Every other role still fails loudly when an invocation does not serve it.

### Red first, then green

| Finding | Test | Red on `main` | Green on the branch |
|---|---|---|---|
| F-01 | `o15-owner-first.test.ts` (existing vs unknown ids, four outsiders, seven commands; OUTBOUND stream held) | 52 differences; the outsider waited on the owner's stream | 4/4 |
| F-02 | same file, `F-02 rule 16` | 200, refund APPROVED after logout | 401, nothing approved |
| F-03 | `o15-service-identities.test.ts`; matrix cells of the payment service on CMD051, CMD053, CMD056, CMD059 | 422 / 500, no fact | 403 SERVICE_NOT_PERMITTED, one fact naming the presented service |
| F-04 | `o15-session-revocation.test.ts` (CMD009, B06 pipeline) | 201, client created after logout | 401, nothing written; a later logout waits for the COMMIT |
| F-04 (R-01) | `o15-session-revocation-commerce.test.ts` (CMD056 owner, CMD031 agency, CMD027, CMD028, CMD013) | 201 for all five, each writing its row after the logout | 401, nothing written, for all five; each commits under a live session; a logout waits for a commerce command's COMMIT |

The red runs and the full logs are kept outside the repository (`Kauro.archive\Evidence\Order15-Security`).

## 4. The owner's scenario: a seller opens Commissions

- Navigation (`apps/web/test/o15-navigation.test.ts`): the owner's menu never lists the seller's Commissions entry; a seller's narrowed menu
  holds exactly the seller's five screens, Commissions on `/ops/sales/statements` (UI36) and no owner screen; every operations route is
  served only on the operations host. The production build has no seller screen yet (UI34, UI36, UI53, UI54 are not implemented); the
  menu a seller saw switch to the owner's was the review simulator's (HD-1), repaired in PR #119 under `tools/review/private` and not
  repeated here.
- API (`o15-seller-owner.test.ts`, and the matrix for every owner route): the seller reads its own home and statement; another seller's
  statement answers exactly like an id nobody holds; an agency selector reaches nothing; its own payout approval, another's, the owner's
  finance reads, refund reviews, outreach reviews, seller registration and termination are refused CORPORATE_ROLE_MISSING with nothing
  written. SUSPENDED and TERMINATED sellers keep their home (R2-066) and reach no other seller's statement, no owner action and no prospect
  work. The owner reads both statements.
- Data: under the seller's own runtime session (OPERATOR, `kauro_app`) the other seller's statement and its items are not visible at all;
  the owner's session sees them.

## 5. Verified without change

- Tenant routes: the agency comes only from the path or `X-Kauro-Agency`; every request handler runs in a TENANT unit bound to it; the
  membership is read after its transition lock and held to the end of the unit (D-TX-2); handlers re-check the row's agency; foreign and
  unknown ids answer alike. Membership routes keyed by id (ChangeMembership, RevokeMembership) take their agency from the selector and lock
  only that agency's rows; AcceptInvitation accepts only for the invited identity.
- Commercial routes: no request field chooses the principal; owner status is a database fact read after its transition lock; dual-principal
  handlers take the owner branch only with an ACTIVE grant; prospect data policies admit an ACTIVE seller only (0089).
- Payments: quote, order, refund and transfer-instruction reads check the agency in the application and under RLS; the webhook verifies the
  signature over the raw bytes before anything is stored; step-up proofs are bound to their user and judged again at commit.
- Database: no runtime role is superuser, BYPASSRLS or table owner; every `kauro.*` table but the two state-machine catalogues has RLS
  enabled and forced; context settings are transaction-local; the session row is visible to `kauro_app` only by the hash presented.
- Sessions: `__Host-` cookie, Secure, HttpOnly, SameSite=Lax; CSRF by exact Origin, Sec-Fetch-Site and an HMAC token compared in constant
  time; no fixation; idle and absolute expiry judged under lock; ambiguous credentials refused; RS256 pinned, issuer and audience exact.

## 6. Residual risks and recommendations (not changed by this order)

Each is defense in depth or a product decision, not a reachable defect today; each is a proposal for the owner.

1. RLS trusts the transaction's context settings: tenant isolation holds because the application checks the membership first in every
   unit, not because a policy ties the agency to a membership. Proposal: a restrictive policy requiring an ACTIVE membership of the bound
   user in the bound agency, measured for cost.
2. The control-plane role can write `corporate_roles` (it provisions grants by design, 0013) and reads tenant rows when no agency is bound
   (about 31 tables, including core documents). Proposal: move grant provisioning to a dedicated role and narrow the unbound reads.
3. Three SECURITY DEFINER functions (0079, 0080, 0081) are owned by the migrator; the owner-authority function answers a verdict for any
   user id the payment service passes. Proposal: a minimal owner role, as 0077 did for route registration.
4. Sign-in accepts any unexpired ID token without an `auth_time` bound; a leaked token mints sessions until the identity is disabled.
   Proposal: a maximum sign-in age, verified against the real Identity Platform.
5. Reads (`runReadIn` and the read routes) and the content-addressed document intakes (selection manifest, decision artifact, logo) do
   not fence the session at their unit: a read already in flight when a logout commits still answers, and an intake stores a document that
   grants nothing until a fenced command cites it. Service commands are not fenced (a service identity is verified as it stands). A bearer
   credential is verified again inside the command's unit by the fence; a future bearer verifier that does network I/O should cache its keys
   so that no network call runs while the unit holds its locks.
6. `getTransferInstructions` declares no role (any ACTIVE member reads the platform's receiving bank details and the order's reference);
   CreateClient's processing authority reference is a global key (a reference already used elsewhere is refused differently from a new one);
   InviteMember answers differently for an identity with no account. All three need unguessable inputs; each is a product decision.
7. The contract-fake service authenticator is not refused by the composition outside LOCAL (no deployment binds one today). Proposal: the
   same guard the identity verifier has, before B15 binds a real one.
8. The production operations shell does not narrow its menu by principal (the session view carries none); it matters once seller screens
   ship. The api already refuses every owner read and action to a seller.

## 7. Pending external verification

Verified locally only with the repository's labelled fakes, to be verified once each provider or environment exists: the Identity Platform
(token claims, MFA, `auth_time`, revocation), the production service-identity verifier and its key management, provider webhook signatures,
signed download URLs and their expiry in the real object store, bank evidence storage, AWS deployment hosts and origins (cookie and CSP
behaviour on the real domains). None of them is declared approved by this order.

## 8. Test results

Local, Windows 11, PostgreSQL 17, on the branch before the rebase (the rebase brought no change to these packages):

- `pnpm run build` and `pnpm run verify` (generate, typecheck, architecture gate, fixture-clock lint, OpenAPI and web-client checks, the
  case matrix, every package's tests, clean-consume): exit 0. `apps/api`: 1,557 tests, 1,445 pass, 0 fail, 30 skipped and 82 todo (all
  pre-existing, each naming the seam or slice it waits for). `packages/persistence` 802/802, `packages/application` 237/237,
  `apps/web` 335/335, `packages/authorization` 12/12, every other package green.
- After the independent review's repairs: `packages/application` 237/237, `apps/web` 335/335, and the full `apps/api` run with 0 failing
  tests; four files of that run were cut off when the session that ran it ended (`source-reads`, `source-role-matrix`,
  `support-case-reads`, `transport`), and pass 16/16 when run again on the rebased branch.
- On the rebased branch: the 18 `o15-*` api tests and the 3 web navigation tests pass; the refund lane suites (`refund-generic-cells`,
  `ach-refund-cells`, `refund-generic-v1`: 222 tests) pass with the new grant unit.
- After R-01: the five pipelines' red test (`o15-session-revocation-commerce`: all five commands answered 201 and wrote after the logout)
  is green with its two controls, and the matrix's no-effect check now compares content digests; the typecheck, architecture gate,
  fixture-clock lint, `packages/application` (237/237) and the full `apps/api` suite (1,561 tests: 1,449 pass, 0 fail, 30 skipped and
  82 pre-existing todo) pass on Windows.

CI (`verify`, ubuntu-24.04 and windows-latest) runs on the PR head; its run ids are recorded on the PR.

### Independent review

A separate read-only reviewer read the change set before the PR. It found no critical or high issue and one medium: in `runOwnerRefund` the
session fence came before the source's transition and row locks, so it was not the unit's last lock. Repaired (the fence now follows the
writes), together with its low findings: a unit that cannot decide in `ownerFirst` is answered as the command's own retriable failure
instead of a 500, journaled replays of core commands and owner refund commands are fenced too, and four tests gained the controls the
reviewer asked for (no 5xx or 401 for an admitted control, own-agency controls for the upload probes, an ACTIVE seller's control for
prospect work, no restricted-store read for a refused owner command).

The dispatcher's independent review of the first candidate (`90db3715`) accepted F-01 to F-03 and returned REJECT_MATERIAL for one
finding, R-01: the session fence of F-04 existed only in B06's pipeline, while the commerce and commercial pipeline (about 36 commands,
B16's CMD056 among them) and the provider-effect intent had none; it reproduced CMD056 committing after a logout. Repaired at each
pipeline's controlling point (F-04 above), proven by a red-first test over five commands of the five pipelines; its observation O-1 (row
counts would not see an update) is closed by the content digests.

## 9. Non-interference with other orders

Files outside the order's primary paths (`packages/authorization`, `packages/persistence`, `apps/api`), kept minimal: the access decisions
of the defects live in `packages/application` (the command pipeline and the owner bank refund and service commands), so each repair is made
where the access is decided, not wrapped around it at the route.

Files touched: `packages/application/src/commands/runtime.ts`, `packages/application/src/commerce/bank/approve-destination.ts`,
`packages/application/src/commerce/bank/execute-refund.ts`, `packages/application/src/commercial/statements/service.ts`, and for the
session fence of every pipeline `packages/application/src/commerce/request/runtime.ts`, `commerce/core/provider-effects.ts`,
`commerce/request/create-payment-order.ts`, `commerce/request/capture-payment.ts`, `commercial/quotes/create-quote.ts` and
`sources/handlers/reserve-upload.ts` (all under `packages/application/src/`);
`apps/api/src/payments/service-commands.ts`, `apps/api/test/fault-support.ts`, `apps/api/test/refund-lane-support.ts`,
`apps/api/test/refund-generic-cells.test.ts`, new tests under `apps/api/test/o15-*` and `apps/web/test/o15-navigation.test.ts`, and this
report. Order 13 (PR #121) changed only `cores/`, Order 14 (PR #120) only `packages/reports/`, `packages/data-plane/test/` and one design
file, and the orders merged since (PRs #119, #122, #123) and the open AWS work (PR #124, `deploy/aws/**`) touch none of these files. No
migration, CP-01 or CP-02 contract, OpenAPI document, generated client, `docs/authority/**` or provider identity changed.
