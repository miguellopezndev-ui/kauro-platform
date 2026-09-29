# B11 — Public and agency application: design

Branch `b11/design` from `main` at `ac44af6` (B05, B06, foundation 0008). Package B11 (22 "B11"): the public and agency journey on
real DTOs and commands, every screen state, keyboard/a11y, browser privacy. Gates G-UX (S066–S070, CMD044 ×3) and G-UX_AGENCY
(R2-062–R2-065, R2-134), both owned by B11 in `gates.json`. Manuals 02, 08, 10, 11, 16, 18 (+07 topology, 19 legal, reference
`UI_STATE_AND_COPY_CONTRACT`); copy under amendment A3; brand Kauro (A2). Extends B06, never forks it: pipeline order, runtime roles
and pools, journal, outbox, security facts, initial-state guards, composite FKs, closed response contracts, generated OpenAPI and
matrix, `@kauro/persistence/testing`.

Delivered here: this design, `B11-case-map.md`, `B11-mandates.json` (the source of truth for the mandates; §10 summarises), and the
pinned skeleton (commit `3abde5b`): `apps/web` (Next.js standalone, per-request CSP, `/livez`), `packages/ui` (tokens + WCAG
checks), the browser harness (Playwright + axe over a TLS edge), architecture-gate rules for client bundles, the lockfile.

## 1. Where the backend is (2026-09-29)

| routes | package | state | B11 consequence |
|---|---|---|---|
| CMD001, 009, 010, 011, 023, 025, 026; reads agencies, members, clients, project | B06 | `main` | bound in stage 2 |
| CMD012–017 + source reads | B07 | `b07/integration` (not on main) | bound after it merges (W7) |
| CMD028–034 + quote/order/refund reads | B09 | `b09/integration` (not on main) | bound after it merges (W9) |
| CMD020–022, 024, 036, 037; audit/plan/job reads | B08 (+B01/B03 cases) | not built | UI18–UI22, UI25 read DTOs are labelled fakes until B08 (§6) |
| CMD002, 027, 043 | B10 | not built | onboarding activation, quote issuance: fixtures/fakes until B10 |
| CMD003–007, 038, 042, 060 | B16 | not built | invitations, team edits, downloads, deletion, retention wait |
| CMD008, 039, reports | B13 (depends on B11) | not built | branding upload, report PDF wait; S069/S070 close PARTIAL here |
| CMD018, 019, 040, 041 | B17 | not built | target setup, staged import wait |

## 2. Decisions

| id | decision | authority / reason |
|---|---|---|
| D-STACK-1 | Pins (advisory check 2026-09-29, GitHub advisory DB + release notes): `next` **16.3.6**, `react`/`react-dom` **19.3.0**, `@types/react(-dom)` 19.3.0, `@playwright/test` **1.63.0**, `@axe-core/playwright` **4.13.0** (axe-core 4.13.0), TypeScript stays 5.9.2. 16.3.6 carries the fix of GHSA-vcvr-r3jv-pc5j (next/og RCE); ≥16.3.3 fixes GHSA-2xp9-vwfh-vxw4 and GHSA-p293-qw3h-jr36 (critical RCE); 16.3.7 (published 2026-09-29 08:54Z, a Turbopack task fix only) waits out a 7-day cooldown. React 19.3.0 is outside every react-server-dom advisory range; Playwright ≥1.55.1 fixes GHSA-7mvr-c777-76hp. W2 adds `jose` **6.2.12** to `apps/api` (no advisory in 6.x) and W-IDP-LIVE adds `firebase` at binding time. Review trigger: any advisory on these packages, or `next` 16.3.7+ after cooldown. | 07 "exact patches pinned after advisory and compatibility checks"; S26; 08 "Secrets and supply chain" |
| D-STACK-2 | Image optimizer off (`images.unoptimized`), `sharp` removed from the install (`pnpm-workspace.yaml` override `sharp: "-"`), `next/og` forbidden by the gate: the surfaces of GHSA-2xp9 (optimizer) and GHSA-vcvr (next/og) are absent, not just unused; Server Actions are refused (D-TOPO-1). Standalone server 17.5 MB. | 08 "Report rendering…no remote URLs"; GHSA-2xp9, GHSA-vcvr |
| D-STACK-3 | `next` runs through `scripts/next.mjs`: telemetry off per process, and after `build` the static assets are copied into `.next/standalone/apps/web`, the one artifact the container and the browser suite run. | no third-party data flow (08 "Audit events": analytics export is a data-flow change) |
| D-TOPO-1 | **No BFF proxy tier.** The app origin serves Next.js pages and routes `/api/v1/*` to the api at the load balancer (B14 URL map), as the reference prescribes; the browser calls same-origin `/api/v1` with the session cookie. The Next.js server renders shells only: it holds no secret and no session, never reads private data, and no RSC payload contains tenant data. "Backend for frontend" is the api's browser edge (D-AUTH-*). Rejected: Next route-handler proxy (a second authorization/idempotency surface, a secret in the web tier); Server Actions (GHSA-mq59 CSRF, GHSA-89xv SSRF, GHSA-m99w DoS; opaque endpoints) — the gate refuses `"use server"`; SSR of private data (08: RSC leak surface). | reference UI_STATE_AND_COPY_CONTRACT "Origins and navigation"; 08 "Browser, API and cache isolation" |
| D-TOPO-2 | One `apps/web` deployment serves two hosts: public origin (route group `(public)`: UI01–UI08, UI45–UI49) and app origin (`(app)`: UI09–UI32, UI50–UI52). `proxy.ts` answers 404 for the other group's paths by host (presentation, never authorization). Hosts are deployment facts (`KAURO_PUBLIC_ORIGIN`, `KAURO_APP_ORIGIN`); LOCAL serves both on one origin. Public pages read only public data (capability publication) server-side, uncached. | reference "Each origin uses its own host-bound session policy…Public marketing contains no private prefetched content" |
| D-ROUTE-1 | Tenant screens live under `/agencies/{agencyId}` + the registry route (UI13 = `/agencies/{agencyId}/projects/{id}`); UI10 is `/agencies`; UI09, UI50, UI51 keep their registry paths; UI24 is `/agencies/{agencyId}/payments/{orderId}` (the provider's return URL names the agency). The agency travels in the URL (per tab, survives refresh, deep links) and as `X-Kauro-Agency`; a deep link into another agency's resource shows the same "not available" as a missing one, never an automatic switch. `apps/web/src/screens.ts` maps every APP/PUBLIC screen id to exactly one route (test). | 11 "Browser back, refresh and direct deep links resolve through current authorization"; 08 equivalent visibility; A3 1.4 (registry routes are internal names) |
| D-AUTH-1 | Session: opaque `__Host-kauro_session` = base64url(32 random bytes); `Secure; HttpOnly; SameSite=Lax; Path=/`; `Max-Age` = absolute lifetime. Lax, not Strict, because the PayPal return and e-mail links are cross-site top-level navigations. The api stores only SHA-256 of it in `kauro.web_sessions` (W2 migration), written and read only by the authentication boundary group `kauro_assurance` (B06 D-EVID-1); `kauro_app` has no privilege on it. Idle 1 800 s (last-seen written at most once a minute), absolute 43 200 s. | 08 "Session cookies are Secure, HttpOnly, deliberate SameSite"; ASVS 4.0.3 V3.3.2 L2 (12 h / 30 min); Q-B11-2 |
| D-AUTH-2 | Identity: an `IdentityClient` port in the browser (sign-in, TOTP challenge/enrolment, e-mail verification, re-authentication). Live adapter = Identity Platform JS SDK with `inMemoryPersistence`, loaded only on `/login`, `/onboarding` and the step-up dialog; after the exchange it signs out, so no IdP token outlives the exchange and none is ever in browser storage; CSP `connect-src` gains `identitytoolkit.googleapis.com` and `securetoken.googleapis.com` on those documents only. The adapter is chosen at run time from `GET /api/v1/public/identity-config`; the api refuses to announce the contract fake outside `KAURO_ENV=LOCAL`. **BLOCKED_OWNER** (Google Cloud project, billing, Identity Platform with TOTP, 2026-10-08) → W-IDP-LIVE. | 08 "Identity Platform authenticates…TOTP"; 14 |
| D-AUTH-3 | Verification is the api's: `IdentityTokenVerifier` port (`@kauro/application`), adapter in `apps/api` with `jose`: alg RS256 only, `kid` in the key source, `iss = https://securetoken.google.com/<project>`, `aud = <project>`, `exp` future, `iat`/`auth_time` past (30 s skew), `sub` 1–128 chars, `email_verified`, `firebase.sign_in_second_factor`. Key sources: LIVE = Google's securetoken x509 set honouring Cache-Control (qualified by B15); CONTRACT_FAKE = the fake issuer's JWKS (§6), refused unless `KAURO_ENV=LOCAL`. Same verifier code in both. | 08 "Identity is not permission"; B06 I-AUTH-1, I-INT-3 |
| D-AUTH-4 | Routes (auxiliary, not catalogue commands; declared as operational routes with closed replies, served in OpenAPI): `POST /api/v1/sessions` `{idToken}` → 201 `SessionView` + cookie; `GET /api/v1/sessions/current` → 200 `SessionView` / 401; `POST /api/v1/sessions/current/revoke` → 204, cookie cleared, `Clear-Site-Data: "cache", "cookies", "storage"`, idempotent; `POST /api/v1/assurance/step-ups` `{idToken}` (auth_time ≤ 300 s, second factor) → 201 `{proofId, expiresAt}` as a B06 STEP_UP proof (`kauro_assurance`), cited as `assuranceProofRef` by CMD025/005/007/043. `SessionView` = `{userId, emailVerified, mfaEnrolled, mfaAt, stepUpFreshUntil, idleExpiresAt, absoluteExpiresAt, csrfToken}`. Every token failure is one 401 `IDENTITY_TOKEN_INVALID` (no account enumeration); an unverified e-mail is 403 `ASSURANCE_REQUIRED`/`EMAIL_NOT_VERIFIED` (the caller proved the account). | 10 "Agency and team routes"; 08 "Authentication and assurance"; UI50 "Generic failure does not enumerate accounts" |
| D-AUTH-5 | `SessionAuthenticator` implements B06's `Authenticator` from the `cookie` header (exactly one `__Host-kauro_session`); a request with both a cookie and `Authorization` is 400 `AMBIGUOUS_CREDENTIALS` (as R41). CSRF on every unsafe method authenticated by cookie, decided at authentication, before the journal reserve (no key consumed): exact `Origin` ∈ `KAURO_APP_ORIGINS` (absent Origin refused), `Sec-Fetch-Site` if present `same-origin`, and `X-Kauro-CSRF` = base64url(HMAC-SHA256(session secret, "kauro-csrf-v1")) compared in constant time → 403 `NOT_AUTHORIZED`/`ORIGIN_REJECTED` or `CSRF_TOKEN_INVALID`. `POST /sessions` needs the exact Origin too (login CSRF). No CORS header is ever sent. | 08 "CSRF…exact origin and a per-session token…CORS permits only observed application origins" |
| D-SEC-1 | Per-request CSP from `proxy.ts` (runs on every path but `_next/static`, prefetches included; the root layout refuses a document without the nonce): `default-src 'none'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; style-src-attr 'none'; img-src 'self'; font-src 'self'; connect-src 'self' [+IdP on D-AUTH-2 pages]; manifest-src 'self'; media-src/object-src/frame-src/worker-src/frame-ancestors/base-uri 'none'; form-action 'self'; upgrade-insecure-requests`. Static headers on every response: nosniff, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP/CORP same-origin, HSTS 2 y, closed Permissions-Policy. No inline `style=` anywhere (ui/web lint test). Measured: 0 violations in Chromium/Firefox/WebKit. | 08 "Report rendering…restrictive content policy"; OWASP ASVS V14.4 |
| D-SEC-2 | Architecture gate (this branch): client-bundle rules skip node-side files (`test/`, `e2e/`, `scripts/`, configs); client bundles may not declare `"use server"`/`"use cache"` nor import `next/og`; `.next` and Playwright outputs are never scanned. Every file that reads configuration from the environment lives in `apps/web/src/server/config/` and starts with `import "server-only"` (W3 adds `server-only` 0.0.1 and the gate check); the pure modules of `src/server/` (no environment, no `server-only`, e.g. `security-headers.ts`) stay importable by `next.config.ts` and `node:test`, and the config modules are exercised through the built server in the browser suite (`server-only` throws outside the react-server condition). | 07 "Architecture checks reject…server credentials in client bundles" |
| D-PRIV-1 | Browser privacy (S067): private data exists only in the page's memory — no localStorage/sessionStorage/IndexedDB/service worker/cache API, `autocomplete="off"` on customer-value fields; every api read `cache: "no-store"` (the api already answers `no-store`); every HTML answer `no-store`. On `pagehide` the private view is replaced by the loading shell (so a back/forward-cache snapshot holds nothing); on `pageshow` (persisted) or `visibilitychange` the page re-reads the session before drawing. Logout = revoke call, then `location.replace('/login')`. Agency switch = explicit clearing state, then a full document navigation (JS memory reset). App links `prefetch={false}`. Error boundaries show code + correlation id only. Measured 2026-09-29: after a cookie-clearing logout, back navigation re-fetched the `no-store` page in all three engines (none restored from bfcache). | 08 "Browser, API and cache isolation"; 11 "Navigation never exposes another agency's cached content"; UI10 |
| D-STATE-1 | Every screen derives one of the 14 shared states of the reference only from api answers; Loading first clears the previous private view and shows the active fetch; Empty explains the first useful step with a labelled synthetic example; problem `code` (never prose) drives control flow through one exhaustive table (`apps/web/src/client/states.ts`, test per stable code): AUTHENTICATION_REQUIRED → sign-in with an allowlisted return path; ASSURANCE_REQUIRED → step-up dialog keeping the draft; NOT_FOUND and NOT_AUTHORIZED → one "not available" (no existence leak); STALE_VERSION/TARGET_STALE → Stale with a comparison from `current`; PAYMENT_PENDING → Pending; PAYMENT_UNCERTAIN → Uncertain ("do not pay again"); SOURCE_EXPIRED → Expired; OPERATION_CANCELLED → Cancelled; CAPABILITY_UNAVAILABLE/agency RESTRICTED → Restricted; INTEGRITY_FAILURE → Integrity failure with support reference; 5xx/network → "Checking" then re-query (never "failed"). Success only from a COMPLETED envelope or a re-read. | reference "Shared states"; 10 "frontend control flow uses the code…An unexpected 500 does not mean a command did not commit" |
| D-OPS-1 | `OperationRunner`: one idempotency key per logical intent. Subject-bound commands derive it: UUIDv5(namespace KAURO_WEB_OPERATIONS, `CMDnnn:subjectId:subjectVersion`) — CMD028 from (quote, version), CMD029 from order, CMD025 from (plan, planHash), CMD036 from the authorization — so a double click, a lost response, a reload and a second tab reuse it and the server replays. Creation commands without a subject (CMD001, 009, 011, 044) mint a UUIDv7 when the form opens and keep it until a COMPLETED answer; the button is disabled in flight but correctness never depends on that. A lost response is retried with the same key, then the durable resource is read. | 10 "Idempotency contract…The client does not generate a new key merely because it did not receive an answer"; S066 |
| D-OPS-2 | Consequential actions are offered only from the server's `permittedActions`/`nextActions` of the subject the page just read, and send the exact version/hashes it displayed (CMD025 plan/revision/target hashes, CMD028 quote id + version). On `visibilitychange` and on return from the provider, the page re-reads the subject; a newer revision shows Stale, never an execute action. | 10 "A UI readiness flag is informative, not authority"; R2-063; UI13 |
| D-OPS-3 | Unsaved typed edits (plan mapping, enum maps) live in memory only, with a visible status of four separate facts: local edits (n unsaved), saved draft (CMD023 revision), validated, approved. In-app navigation, back and tab close with unsaved edits open a guard ("Stay", "Save draft", "Discard"); no autosave, no browser storage. | R2-064; 11 "Mapping…typed command"; D-PRIV-1 |
| D-A11Y-1 | WCAG 2.2 AA: axe (`wcag2a/2aa/21a/21aa/22aa`) on every page state a spec reaches, zero violations; keyboard-only journeys; focus to dialog heading on open, to the error summary on a refusal, back to the invoker on close; errors linked by `aria-describedby`; live-region status announcements (polite, one per durable change); 400 % zoom/320 CSS px reflow and 200 % text without horizontal scroll; `forced-colors` focus. Screen-reader evidence is a recorded reviewer pass (NVDA + Firefox, VoiceOver + Safari) on UI22, UI23/24, UI14 — automation cannot prove it. | 11 "Interaction and accessibility acceptance"; WCAG 2.2 |
| D-A11Y-2 | `ConfirmDialog` (R2-062): native `<dialog>` + `showModal()`, no `<form>` around it, every button `type="button"`, no default action; the approve control is enabled only when each high-impact disclosure (each CLEAR/merge/exclusion effect with its count) is acknowledged by its own checkbox; Enter on a checkbox or text does nothing; the server's field errors map to the effect ids they name. | reference "A hidden default or unrelated Enter key cannot approve a CLEAR…" |
| D-DS-1 | `@kauro/ui` tokens are the reference values (text #17212B, primary #0B6463 on white text, focus #005FCC, system-ui, 16 px/1.5, dense ≥14 px) plus status pairs; `tokens.css` is generated from `tokens.ts` and every text pair ≥4.5:1, every indicator ≥3:1 (tests, this branch). Light theme only at launch. Components (W1): Button, LinkButton, Field/Label/Hint/FieldError, ErrorSummary, ConfirmDialog, DataTable (header cells, row identity, sortable header buttons, keyset pagination with "n of N"), StatusBadge (icon + text), Banner, PhaseList (no percentage), Money (minor-unit string → `USD 1,295.00`, BigInt, never float), Count, CountDenominators, Deadline (`<time datetime>` + local zone name), SafeText, NavigationGuard. | reference "Visual and interaction tokens"; 11 "Design system" |
| D-DS-2 | Measured: focus #005FCC vs primary #0B6463 = 1.16:1, so the focus ring is always an outline offset 2 px over the surface (5.98:1 on white), never adjacent to a primary fill. | WCAG 1.4.11 |
| D-DS-3 | `SafeText` renders every customer or agency string (labels, names, values) as a text node inside `<bdi>`; no `dangerouslySetInnerHTML` anywhere in `apps/web`/`packages/ui` (gate-style test); values starting with `= + - @ \t \r` are shown with a visible "formula" marker, never re-exported as formulas; long values truncate with the full value in an accessible disclosure. | 08 "Report rendering treats customer strings as untrusted"; 11 "escaped…cannot execute markup or spreadsheet formulas"; S069 |
| D-COPY-1 | English only (11, D54, A3 §3): no i18n framework; copy in `apps/web/src/copy/en.ts` keyed by message id; numbers `en-US`; deadlines exact to the minute with zone; money from minor units. A copy lint test over the catalogue and public/legal sources enforces A3: required "Free data health check" (UI18 title, report title) and the CTA "Request a free data health check"; the in-house sentence exactly once, on Pricing; forbidden: "audit"/"diagnosis" for that step in customer copy, AI in any heading/title/offer/label, "AI-ready", "AI cleans", "without losing money", "works with any CRM", "compatible with", "import-ready for any CRM", "we delete duplicates", "eliminate records", savings amounts, "pays for itself", "if we find nothing", the pre-rename brand; "Prepared for import", never "Imported". Founding-discount line only while B10 reports a reservable slot (hidden until B10). | A3 §3.1–3.7; 11; 16 |
| D-LEGAL-1 | Legal pages (UI45–47) render from `apps/web/src/legal/operator-facts.json` (every fact `{value, source}` or `null`; legal name, entity type, NIT, registered address, postal contact, legal e-mail, governing law, forum, subprocessors with purpose/location/transfer basis, effective date) and versioned templates. A document with any `null` fact, or with a fact marked `REQUIRES_REVIEW` (liability, law, forum: 19), renders "This document is not published yet" with HTTP 503 and has no version: `ActivateAgency` is never offered without a published version. Version label = `terms-<effective date>-<sha256 of the rendered text, 12 hex>`; an accepted version never changes (new text = new version). Today every fact is `null` (**BLOCKED_OWNER** 2026-10-08; text review B19). | 19 "Operator decision", "instruments have version and effective date"; UI45 "No invented entity details" |
| D-SUP-1 | CMD044 CreateSupportCase is B11's only catalogue command (§5). The form warns in text ("Do not paste passwords, keys or CRM rows; use secure upload"); the server decides (bounded detector); no client-side duplicate of the detector. Agency-level cases and replies have no catalogue command (Q-B11-1): UI52 lists and shows project cases; no reply action. | 10 "Support and operations routes"; 18 |
| D-E2E-1 | Browser suite: Playwright 1.63.0 + `@axe-core/playwright` 4.13.0 in `apps/web/e2e`, `pnpm --filter @kauro/web run e2e`, one worker, no retries, `forbidOnly`. Chromium (headless shell) always; `KAURO_E2E_ENGINES=all` adds Firefox and WebKit (required for S067, S068, R2-062). Not in `verify` (browsers are a host install); the B11 integrator records its run per platform in the evidence bundle. Footprint §7. | 11 "Visual review uses the actual integrated application"; 21 |
| D-E2E-2 | Topology: TLS edge on `https://localhost:<port>` (per-run self-signed P-256 certificate from `openssl`, removed on exit) routing `/api/v1/*` to a real api process on a temporary PostgreSQL 17 (`@kauro/persistence/testing`) and the rest to the standalone server — the production URL map in miniature. TLS is required: WebKit 26.6 keeps no `Secure` cookie on `http://localhost` (measured). Lost responses are made with `route.fetch()` + `route.abort()` (server committed, page never told); interleavings by hold points and `pg_stat_activity` lock waits, never sleeps; oracle = superuser reads of the journal, events and aggregates, and the fakes' call logs. | 08; 10 "lost response"; B06 test discipline |
| D-GEN-1 | The web consumes api DTOs only through `apps/web/src/api/generated.ts`, generated from `apps/api/openapi.json` (served and `x-kauro-planned` operations) by `tools/web-client.mjs generate|check` (dependency-free; `check` joins `pnpm run verify`): types plus a closed runtime guard per schema. A reply that fails its guard is Integrity failure (version skew between the web and api deployments is caught, never rendered). | 10 "Consumer tests use the actual generated DTOs"; B06 runtime-validated responses |

## 3. `apps/web`

```
src/proxy.ts                  CSP nonce + host/group routing (D-SEC-1, D-TOPO-2)
src/server/                   pure server modules (security headers); src/server/config/: env config, server-only
src/app/(public)/…            UI01–UI08, UI45–UI49; SSR of public data only
src/app/(app)/…               UI09–UI32, UI50–UI52: shells; data via the client runtime
src/app/livez/route.ts        probe
src/client/                   "use client": api client, OperationRunner, session + privacy runtime, states, IdentityClient
src/api/generated.ts          D-GEN-1
src/screens.ts                screen id → route/title/nav (D-ROUTE-1)
src/copy/en.ts                D-COPY-1
src/legal/                    operator facts, templates, renderer (D-LEGAL-1)
test/  e2e/  scripts/         node:test; Playwright; next wrapper
```

## 4. Screen binding (URL · reads · commands · route status)

| screen | URL | binds | status |
|---|---|---|---|
| UI01–UI06, UI48 | public paths | capability publication (B11 new, public read of B06 `capabilities`), policy bands (vendored registry) | W5 |
| UI07 Contact | `/contact` | `POST /api/v1/public/inquiries` (B11 new) | W5 |
| UI08 Status | `/status` | status feed (B14/B16); until then "status information unavailable", never all-green | W5 honest state |
| UI45–47 Legal | `/legal/*` | operator facts (D-LEGAL-1) | W5; BLOCKED_OWNER |
| UI49 Unsubscribe | `/unsubscribe/{token}` | suppression command (B12/B15) | LATER B12 |
| UI50 Sign in | `/login` | sessions (W2), IdentityClient | W6 |
| UI09 Agency setup | `/onboarding` | CMD001; buyer type `POST /api/v1/agencies/{id}/buyer-type` (B11 new, A3 3.7); MFA (IdentityClient); CMD002 + billing identity | W6; CMD002 LATER B10; billing intake Q-B11-4 |
| UI10 Switcher | `/agencies` | GET /agencies, CMD001 | W6 |
| UI51 Invitation | `/invitations/{id}#token` | invitation read + CMD004 | LATER B16 (W6 builds against the fake) |
| UI11 Projects | `/agencies/{a}/projects` | `GET /api/v1/agencies/{a}/projects` (B11 new dashboard projection) | W6 |
| UI12 Clients | `/agencies/{a}/clients` | GET clients, CMD009, CMD010 | W6 |
| UI13 Overview | `…/projects/{id}` | GET project (`permittedActions`) | W6 |
| UI14–16 Sources | `…/projects/{id}/sources…` | B07 routes | W7 after B07 merges |
| UI17 Target | `…/target` | CMD018/019 | LATER B17 |
| UI18 Health check | `…/audit` | audit reads, CMD020/021 | LATER B08 (W8 against the fake) |
| UI19–21 Plan | `…/plan/*` | plan read (B08), CMD023 (main), CMD024 (B08) | W8, read via fake until B08 |
| UI22 Approval | `…/plan/approval` | plan read (B08), step-up (W2), CMD025 (main) | W8 |
| UI23 Quote | `…/purchase` | GET quote (B09), CMD027 (B10), CMD028 (B09) | W9; issuance via B09 commerce fixture until B10 |
| UI24 Payment | `…/payments/{orderId}` | GET order, CMD029 (B09) | W9 |
| UI25 Processing | `…/processing` | CMD036/037, job read | LATER B08 |
| UI26 Delivery | `…/delivery` | packages (B08/B13), CMD038 (B16), CMD039 (B13) | LATER B08/B13/B16 |
| UI27–28 Import | `…/import…` | CMD040/041 | LATER B17 |
| UI29 Data lifecycle | `…/retention` | CMD060, CMD042 | LATER B16 |
| UI30 Billing | `…/billing` | B09 reads, CMD031 | W9 (tax documents LATER B15) |
| UI31 Team | `…/team` | GET members | W6 read; edits LATER B16 |
| UI32 Settings | `…/settings` | label; CMD008 (B13); CMD043 (B10) | LATER B13/B10 |
| UI52 Support | `…/support`, `…/projects/{id}/support` | CMD044 + reads (W4) | W10 |

A LATER screen is built by a binding mandate of B11 once its routes are on `main`; until then its navigation entry is absent (not
a placeholder, 11 "Every navigation link resolves to real content or an explicitly unavailable feature").

## 5. api additions owned by B11

Each mandate numbers its migration `0009` on its own branch; the B11 integrator renumbers (README "Migration ownership").

| mandate | routes | tables / roles | notes |
|---|---|---|---|
| W2 | sessions ×3, step-ups, `GET /api/v1/public/identity-config` | `web_sessions` (session_id v7, secret_sha256 unique, user_id FK identities, created/last_seen/idle/absolute instants, revoked_at + reason); `kauro_assurance` INSERT/SELECT/UPDATE(last_seen, revoked_*) only; runtime-boundary matrix updated | D-AUTH-* |
| W4 | CMD044 `POST /api/v1/projects/{projectId}/support-cases` (201 COMPLETED, journal), `GET /api/v1/projects/{projectId}/support-cases` (keyset), `GET /api/v1/support-cases/{caseId}` | `support_cases` (agency_id, case_id v7; composite FK to projects; category, severity, state born OPEN via `state_machines` platform machine SupportCase; summary 20–4 000 chars; evidence_refs ≤10; created_by user+membership; next_review_at; version); kind `support_case` in the 0008 registry; event `support_case.opened.v1` payload {caseId, projectId, category, severity, nextReviewAt} — never the summary | role AGENCY_MEMBER = any ACTIVE membership that sees the project; severity SECURITY/PRIVACY S2, PRODUCT_DEFECT/BILLING S3, IMPORT_GUIDANCE/GENERAL S4; next review: S2 end of the next covered hour, S3/S4 17:00 America/Bogota of the next covered business day (policy `support.*`; Colombian holidays from a versioned, sourced calendar, Q-B11-5); detector refuses private keys, cloud/API keys, JWT/bearer tokens, `password=`-style pairs, long high-entropy strings and record-like text (≥3 delimited lines or ≥3 e-mail addresses) → 422 `SECRET_LIKE_CONTENT`/`RECORD_LIKE_CONTENT`, next action SECURE_UPLOAD; evidenceRefs empty until B07's upload ids are on main, then refs of the same project only |
| W5b | `GET /api/v1/public/capability-publication` (no auth, `no-store`), `POST /api/v1/public/inquiries` (no auth; exact public/app Origin; content-idempotent 24 h; limiter 5/h per client address hash, 3/day per e-mail hash) | `inquiries` (no tenant; `kauro_app` INSERT only; buyer_type agency/in-house, contact fields, destination enum, band, timing, description ≤2 000 through the W4 detector); event `inquiry.received.v1` ids only | A3 3.7 buyer type; notification e-mail BLOCKED_OWNER (Resend) |
| W6 | `GET /api/v1/agencies/{agencyId}/projects` (filters active/awaiting_agency/delivered/failed/archived), `POST /api/v1/agencies/{agencyId}/buyer-type` (OWNER, set once, content-idempotent) | `agency_buyer_types` (agency_id PK) | integration obligation for B10: CMD027 refuses a quote while the buyer type is unset |

## 6. Contract fakes (one owner each; label `CONTRACT_FAKE`, evidence class SIMULATED)

| fake | owner | what it stands for | never |
|---|---|---|---|
| `ContractFakeIdentityIssuer` (`@kauro/application/testing`) + its HTTP server (`apps/api/test/support/fake-identity-server.ts`) + the web adapter `contract-fake` of IdentityClient | W2 (issuer, server), W3 (web adapter) | Identity Platform: RS256 tokens with the documented claim shape, JWKS, password + TOTP sign-in, re-auth; test clock | served outside LOCAL; skips the api verifier |
| `ContractFakeAgencyApi` (`apps/web/e2e/support/fake-routes.ts`, edge-mounted) | W3 | planned `x-kauro-planned` operations not yet served (B08 audit/plan reads, B16 invitation read/CMD004, B10 CMD002): replies built from and checked against their planned schemas | answers a served route; counts as integrated |
| B09 `PaymentProviderAdapter`, B07 storage/scanner fakes | B09, B07 (unchanged) | PayPal, object storage, scanner | re-owned by B11 |

## 7. Browser harness footprint (measured 2026-09-29, Playwright 1.63.0)

| item | Windows 11 | WSL Ubuntu 24.04 |
|---|---|---|
| npm packages (`playwright-core` 13.5 MB, `playwright` 5.1 MB, `axe-core` 3.1 MB, `@playwright/test`, `@axe-core/playwright`) | 21.7 MB | same |
| Chromium headless shell 153.0.8010.12 | download 114.6 MiB, on disk 283 217 434 B | 114.3 MiB, 272 533 063 B |
| Firefox 155.0 | 122 MiB, 358 344 918 B | 109.5 MiB, 320 457 770 B |
| WebKit 26.6 | 59.8 MiB, 177 680 877 B | 102.3 MiB, 307 294 111 B |
| ffmpeg + winldd | 3.8 MB | 5.1 MB |
| install time (3 engines) | 34 s | 68 s |
| system packages (root) | none | Chromium 27, Firefox 63, WebKit 225 apt packages missing (`libnss3`, `libnspr4`, `libasound2t64`, fonts, `xvfb`, gstreamer…) |

Install: `pnpm --filter @kauro/web exec playwright install --only-shell chromium` (+ `firefox webkit` for `KAURO_E2E_ENGINES=all`).
Linux: the integrator installs the Chromium dependencies once as root (`playwright install-deps chromium`, 27 packages; nothing
under `/srv`); Firefox/WebKit engine suites run on Windows. Harness on this branch: 6/6 green, three engines, Windows.

## 8. Owner-blocked (BLOCKED_OWNER, 2026-10-08)

| item | blocks | built now against |
|---|---|---|
| Google Cloud project + billing + Identity Platform (TOTP, authorized domains) | live sign-in (W-IDP-LIVE), live key source (B15) | D-AUTH-3 verifier + contract-fake issuer |
| Company, DIAN/RUT facts (legal name, NIT, address, legal contact) | legal pages, terms acceptance, invoices copy | D-LEGAL-1 refusal to publish |
| Resend | inquiry/support notification e-mails (B12/B15) | outbox events with ids only |
| PayPal Business | live payment half of S066 | B09's contract fake |
| Google Workspace | support/legal mailbox in copy | copy key without an address until then |

## 9. Open questions for the authority

| id | question | working answer |
|---|---|---|
| Q-B11-1 | CMD044 is project-bound; 11 "Help" and UI52 imply agency-level cases and replies, which no catalogue command models. | project cases only, no reply action; ChangeProposal if needed |
| Q-B11-2 | Session idle/absolute lifetimes are not in the policy registry. | 1 800 s / 43 200 s (ASVS L2) |
| Q-B11-3 | Registry routes are internal names (A3 1.4); the rendered URL adds `/agencies/{agencyId}`. | D-ROUTE-1 |
| Q-B11-4 | The agency-side legal/billing identity intake of onboarding has no command (B09 fiscal profiles are operator-recorded). | onboarding shows the step as "prepared by Kauro" until B10/B15 decide |
| Q-B11-5 | "Next business day excluding local holidays" needs a holiday source. | versioned Colombian calendar with its source record |
| Q-B11-6 | S069/S070 are B11 cases but the logo pipeline (CMD008) and report PDF are B13, which depends on B11. | B11 closes them PARTIAL on its surfaces; B13 re-runs them |
| Q-B11-7 | S068 names screen readers; automation cannot prove them. | recorded reviewer pass (D-A11Y-1) |

## 10. Mandates (source: `B11-mandates.json`)

Stage 1 (parallel, from `b11/design` at this commit): **W1** ui primitives · **W2** session and identity boundary (api) · **W3** web
runtime (routes, generated client, OperationRunner, states, privacy, copy lint, agency-api fake) · **W4** CMD044 (api) · **W5a**
public pages and legal renderer · **W5b** public api (capability publication, inquiries). Stage-1 integrator **INT-1** merges into
`b11/stage-1`, renumbers migrations, verify on both platforms. Stage 2 (from `b11/stage-1`): **W6** onboarding, agencies, clients,
projects, sign-in (S067, S068, R2-134) · **W7** sources and counts (R2-065; needs B07 on main) · **W8** plan, approval (R2-062,
R2-064) · **W9** purchase and payment (S066, R2-063; needs B09 on main) · **W10** support and hostile-name/report print suites
(CMD044 UI, S069, S070). **INT-2** integrates, runs the browser suites (Windows three engines, Linux Chromium) and records the case
map. **W-IDP-LIVE** starts after the owner opens Google Cloud. Binding mandates for LATER screens start when their routes reach
`main`.

## 11. Verification on this branch

| check | platform | subject | result |
|---|---|---|---|
| `pnpm install --frozen-lockfile && pnpm run verify` | Windows 11, Node 24.14.1, pnpm 10.16.1, PostgreSQL 17 | `4cac0f3` tree (+ doc-only edits) | exit 0 in 6 m 34 s: ui 5, contracts 12, web 4, domain 54, application 55, persistence 107, authorization 11, api 117 (+1 Linux-only skip of B06), tools 30; gate 8 packages / 14 edges; openapi 14 routes; matrix; clean-consume |
| same, clean clone as WSL user `miguel`, `PGBIN=/usr/lib/postgresql/17/bin` | Ubuntu 24.04, Node 24.21.0 | `d85e322` | exit 0: same counts, api 118; clone deleted |
| `pnpm --filter @kauro/web run e2e`, `KAURO_E2E_ENGINES=all` | Windows 11 | `3abde5b` tree | 6/6 (Chromium 153, Firefox 155, WebKit 26.6) |
| cookie and back/forward probe (scratch, not committed) | Windows, three engines | — | `__Host-` cookie dropped by WebKit over http://localhost, kept over https; `no-store` page re-fetched after logout in all engines |
| `pnpm install --frozen-lockfile && pnpm run verify` (mandate W2, branch `b11/w2-session-identity`) | Windows 11, Node 24.14.1, pnpm 10.16.1, PostgreSQL 17 | `8fbcea8` | exit 0 in 7 m 18 s: ui 5, contracts 12, web 4, domain 54, application 55, persistence 107, authorization 11, api 130 (+1 Linux-only skip of B06; 13 of them `b11-sessions.test.ts`), tools 30; gate 8 packages / 14 edges; openapi 19 operations; matrix; clean-consume (11 typed entry points, `@kauro/application/testing` among them) |

## 12. Decisions register (stage-1 implementation)

Decisions the mandates took while implementing §2–§5, one or two sentences each with its authority; *deviation* marks a
departure from the text above.

| id | mandate | decision | authority |
|---|---|---|---|
| D-W2-1 | W2 | *Deviation from §5 (web_sessions columns and grants).* A session also keeps the facts its token proved at sign-in (provider and subject digest, bound to the identity row by a composite key; e-mail verification and second-factor instants) and its latest step-up (proof id, fresh-until; a key to a proof of the same person), because `kauro_assurance` reads neither `identities` nor `assurance_proofs`; it updates `last_seen_at`, `idle_expires_at`, `step_up_*` and `revoked_*` only, and sees a row only when its transaction presents that row's secret hash. | D-AUTH-1, D-AUTH-4 (SessionView); B06 D-EVID-1; 08 "Database isolation" |
| D-W2-2 | W2 | *Deviation (configuration names).* "LOCAL only" is the existing `KAURO_ENVIRONMENT=LOCAL` (the mandate says KAURO_ENV); the boundary's login is `KAURO_DB_ASSURANCE_USER`/`_PASSWORD`/`_POOL_MAX` (1–2), and the runtime and boundary pools together stay within the api's four connections. | 07 "Connection budget"; B06 R43 |
| D-W2-3 | W2 | With the session boundary configured SANDBOX and LIVE start (key source GOOGLE_X509); without it they still refuse to start (B06 I-INT-3), and LOCAL keeps its bearer file beside the cookie. Live qualification of the key source stays B15's. | D-AUTH-3; B06 I-INT-3 |
| D-W2-4 | W2 | The session routes are operational routes with closed request bodies, a body-less 204 checked like any reply, and closed outcome catalogues (`OPERATIONAL_OUTCOMES`); five reasons join the vocabulary (IDENTITY_TOKEN_INVALID, EMAIL_NOT_VERIFIED, AMBIGUOUS_CREDENTIALS, ORIGIN_REJECTED, CSRF_TOKEN_INVALID); AMBIGUOUS_CREDENTIALS enters every route's catalogue and the two CSRF refusals every command's, each an anonymous DENY fact. | D-AUTH-4, D-AUTH-5; B06 D-RESP-1, D-OUT-1, D-FACT-1 |
| D-W2-5 | W2 | Sign-in opens a session for any proven account: unknown, DISABLED and known identities get the same 201 (a DISABLED one is refused by every read and command that follows), and a sign-in that carries a session cookie ends that session (reason REPLACED). | R2-134; 08 "Error messages do not disclose that a particular agency, email ... exists"; D-PRIV-1 |
| D-W2-6 | W2 | Facts SESSION_OPEN, SESSION_REVOKE and STEP_UP_ISSUE (ALLOW in the person's stream; DENY in it, or anonymous when no person is proven), policy version B11-SESSION-1; `GET /api/v1/sessions/current`, the page's session probe, records none. | 08 "Audit events and retention"; D-PRIV-1 |
| D-W2-7 | W2 | A step-up proof is issued at the re-authentication's `auth_time` (never after now), method TOTP for a TOTP second factor and IDP_REAUTH otherwise, fresh for B06's 900 s. | D-AUTH-4; B06 D-ASSUR-1 |
| D-W2-8 | W2 | GOOGLE_X509: a document without Cache-Control max-age, unreachable or malformed makes the verifier UNAVAILABLE (a retryable 503, never a 401); an unknown kid refreshes the document at most once a minute and a failed fetch waits 5 s; `exp` has no tolerance, `iat` and `auth_time` 30 s. | D-AUTH-3; Firebase "Verify ID tokens using a third-party JWT library" |
| D-W2-9 | W2 | The issuer fake is on the new test-only subpath `@kauro/application/testing`; its HTTP server runs in-process or as a process for the e2e launcher (it writes the JWKS the api reads from `KAURO_IDENTITY_FAKE_JWKS_FILE`), refuses unknown browser origins and labels every answer CONTRACT_FAKE / SIMULATED. | §6; `architecture.rules.json` testOnlySubpaths |
