# B13 — CMD008 UpdateBranding and the logo's safe media pipeline (order 7)

Order 7 of the build program. It builds the registry command CMD008 UpdateBranding on the branding versions of migration 0095 and the
report binding of order 6, adds the stored logo the 0095 header left to it ("the stored-logo pipeline is CMD008's"), and makes a job's
report print the logo its bound version names. It changes no B08 mechanism, no renderer, no PDF layout and no report of a delivered
package; it calls no cloud service and takes no new dependency. Everything here is validated locally with synthetic images.

## 1. The contract (registry, quoted)

`CMD008 UpdateBranding — POST /api/v1/agencies/{agencyId}/branding — AGENCY_OWNER_OR_ADMIN`, fields `expectedVersion: version`,
`displayName: label`, `logoArtifactRef: id`; idempotency REQUIRED; state check TRANSACTIONAL_EXPECTED_VERSION_WHEN_SUPPLIED_PLUS_STORED_AUTHORITY.
Precondition: "The logo passed the safe media pipeline; branding rights and tenant scope are confirmed." Effect: "Create a new branding
version for future reports while preserving already delivered artifact identity." Failure: "Unsafe SVG/script, invalid media or a
foreign artifact reject; no remote image fetch from arbitrary URLs." Cases CMD008-OK / -DENY / -RACE, S069.

## 2. Decisions

| id | decision | why |
|---|---|---|
| D-BR-1 | `expectedVersion` is the **agency's** version (Agency.version). CMD008 locks the agency row, checks it (STALE_VERSION with the current safe version), and moves it by one with `agency.branding_versioned.v1`. | The route names the agency aggregate (`aggregateParam: agencyId`), the version vocabulary starts at 1 (a first branding has no branding version to name), and every agency version carries its event (0005 `agencies_event_per_version`). Two requests naming one version: the second waits on the row lock and is STALE — one branding version, never two. |
| D-BR-2 | The branding version's number is the agency's latest plus one, read under the agency lock; 0095's guard (`agency_branding_versions_contiguous`) and primary key still refuse any other. | The database stays the authority on numbering; the handler never relies on the unique index for its answer. |
| D-BR-3 | `logoArtifactRef` is optional: absent, the version names no logo. | An agency without a logo still brands its reports; the field's presence in the registry does not force one. |
| D-BR-4 | The logo enters through a **logo intake**, `POST /api/v1/agencies/{agencyId}/branding/logos` (AGENCY_OWNER_OR_ADMIN, X-Kauro-Agency): not a registry command — it changes no aggregate, grants nothing until CMD008 names it, takes no journal entry and is content-idempotent (201 stored, 200 the same image again). | B07's selection manifest intake (D-SEL-2) is the template: `logoArtifactRef` is a reference to an artifact the agency already handed over, as `selectionManifestRef` is. The order allows the admission step "as part of the safe flow". |
| D-BR-5 | The logo travels as its bytes, base64 in the JSON body, with the uploader's SHA-256 and `rightsConfirmed: true`; never a URL. The body bound (1 MiB) is unchanged; the route raises only the parser's string bound to exactly the base64 of 512 KiB (B12 D-B12S-2's evidence upload is the precedent). | No member can carry a URL, so nothing can be fetched (S069: no SSRF). `rightsConfirmed` is the registry's "branding rights confirmed", under the terms of service 15.3. |
| D-BR-6 | **PNG only.** The pipeline decodes PNG fully and writes a new PNG; a JPEG is refused `LOGO_FORMAT_UNSUPPORTED`. | The report model admits PNG and JPEG, but the platform has no JPEG decoder and takes no new dependency for one; a JPEG stored without decoding would not have "passed the safe media pipeline". Revisable by the owner (a vetted decoder would add JPEG behind the same re-encoding). |
| D-BR-7 | The stored logo lives in PostgreSQL (`kauro.agency_branding_logos`, bytea ≤ 512 KiB), not in object storage. | The api binds no object store in any edition; `ObjectStoragePort` has no direct write (browser-held resumable sessions only); `kauro.stored_objects` names a project, a logo is the agency's. The database already keeps content-addressed documents of this size (`selection_manifests`, `legal_identity_snapshots`). No second file platform is invented; if B15 binds an object store, the same SHA-256 can name a PROFILE-zone object. |
| D-BR-8 | The brand name is refused (`BRANDING_NAME_UNPRINTABLE`) unless both the report model's fence (`safeText`, 120 characters) and 0095's `agency_branding_versions_printable` admit it. | A recorded name is always one a report prints; a refusal names its cause before any write. |

## 3. The safe media pipeline (`@kauro/domain` branding.ts `admitLogo`)

1. Bounded first: more than 512 KiB is `LOGO_TOO_LARGE` before anything parses the bytes.
2. A PNG or nothing: the signature; every chunk's length, type (four letters) and CRC-32; IHDR first (1..2048 pixels a side —
   `LOGO_DIMENSIONS_OUT_OF_RANGE` —, a valid depth and colour type, deflate, standard filter, interlace 0 or Adam7); PLTE and tRNS only
   where the colour type admits them; consecutive IDAT; IEND last and empty, nothing after it. An unknown critical chunk is
   `LOGO_MALFORMED`; an animation (acTL/fcTL/fdAT) is `LOGO_FORMAT_UNSUPPORTED`. SVG, HTML, XML, script, JPEG, GIF, WebP and renamed files
   fail at the signature (`LOGO_FORMAT_UNSUPPORTED`): no other format is ever parsed.
3. Decoded: the image data is inflated as one complete zlib stream (Adler-32 checked, nothing after it; review BR-001) with its output
   bounded by the exact size IHDR implies (a decompression bomb stops at that bound), every scanline unfiltered, every palette index
   checked, a tRNS key compared at the image's bit depth (its unused high bits masked; review BR-002), 1/2/4/8/16-bit samples brought
   to 8-bit RGBA.
4. Written again: a new PNG of the pixels only — IHDR, IDAT, IEND, 8-bit RGB(A) — so text, EXIF, ICC, timestamps, private chunks and
   trailing bytes never survive. Bounded again (512 KiB) and named by the SHA-256 of the new bytes.

The intake also refuses a hash that is not the received bytes', and a base64 that is not their canonical spelling
(`LOGO_DIGEST_MISMATCH`). CMD008 re-reads a named logo and requires it to decode as the pipeline's PNG of its recorded size
(`LOGO_MALFORMED`, INTEGRITY_FAILURE otherwise). The renderer (`@kauro/reports` checkedLogo) checks the bytes once more against the hash,
signature, size and pixels before it embeds them as the document's only image (`data:` URL; CSP `img-src data:`).

## 4. Persistence — migration 0096

| object | what | who |
|---|---|---|
| `kauro.agency_branding_logos` | (agency, logo id) PK; one row per (agency, SHA-256); `logo_sha256` = SHA-256(`content`) (`agency_branding_logos_content_addressed`); `media_type = image/png`; width/height 1..2048 and equal to IHDR's (`agency_branding_logos_png`: the signature and IHDR first); content 57..524288 bytes; recorder's membership and person (FK); `recorded_at` stamped by `kauro.server_now()`; append-only, no truncate; FORCE RLS | kauro_app: INSERT (nine columns) as the ACTIVE OWNER or ADMIN of the bound agency (`kauro.acting_branding_manager`, 0095), SELECT bound; kauro_control: SELECT bound |
| `kauro.agency_branding_versions.logo_id` | nullable; `(agency_id, logo_id)` → `agency_branding_logos` (`agency_branding_versions_logo_fk`): a version can name only its own agency's logo, whatever a request says | kauro_app: INSERT (the column) |
| `agency.branding_versioned.v1` | registered event type (payload: agencyId, brandingVersion, logoId, logoSha256, byMembershipId — never the name) | — |

No existing row changes, nothing is backfilled. The reviewed privilege matrix gains exactly these 44 lines; the clock census one site
(`agency_branding_logos_stamp#S1`, owner B13).

## 5. The report (order 6 unchanged, the logo added)

`PgReportSources.read` returns the bound version with the logo it names and the logo's bytes (`brandingLogo`), read in the control
plane's SYSTEM unit bound to the job's agency. `PlatformReportInputs` passes them as `AGENCY_BRANDING_V1 { …, logo: {logoId, sha256,
mediaType} }` and `logo`; `assembleReportFacts` refuses bytes that are not the named SHA-256 (`BRANDING_UNVERIFIABLE`), a named logo
without bytes (`BRANDING_UNAVAILABLE`), a malformed record (`FACTS_MALFORMED`) and bytes for a version naming none
(`BRANDING_UNVERIFIABLE`). The binding rule of order 6 is untouched: a job's reports print the version bound at its first report (the
latest recorded at or before `queued_at` that is committed then) and never another; a version recorded later is for later jobs; a
delivered PDF and record never change. The issuer line stays the legal identity document's (R2-070): no brand, name or logo replaces it.

Because a version's instant is its transaction's (`server_now()`), a CMD008 that began before a job was queued and commits before the
job's first report is that job's version; one that commits after the first report is not. Both orders are tested through the real
handler (§6); in each the binding, once made, never moves.

## 6. Evidence

| suite | where | what |
|---|---|---|
| pipeline, unit (6) | `packages/domain/test/branding.test.ts` | PNG admitted and written again (metadata dropped, pixels kept, fixed point); palette+tRNS, 2-bit, 16-bit, grey+alpha, Adam7; tRNS keys at every greyscale depth and truecolour 8/16 bits against hand-written pixels (BR-002); SVG/HTML/script/JPEG/GIF/WebP/URL/empty refused at the signature; 27 forged or broken PNGs, each defect alone (unfinished zlib streams and data after them among them, BR-001); size, side, zero side, a 200 MiB bomb refused at its bound; an upload under 512 KiB whose pixels written again exceed it refused by the output fence (BR-003) |
| 0096 on PostgreSQL 17 (4) | `packages/persistence/test/b13-branding-logos.test.ts` | upgrade from 0095 (versions unchanged, no logo invented, event registered); OWNER/ADMIN store once per content, other roles, borrowed membership and another agency refused; content addressing, PNG header, sizes, media type, SVG under its own hash refused whoever writes; append-only for every role; isolation; a version naming another agency's logo refused by the foreign key |
| CMD008 through the api (7) | `apps/api/test/cmd008-update-branding.test.ts` | OK (OWNER with logo, ADMIN without, event, journal, earlier version untouched); DENY roles and tenants (OPERATOR, APPROVER, VIEWER, BILLING, suspended ADMIN, unverified, another agency's owner, an active seller, the corporate owner — on the command and the intake); DENY preconditions (stale version, ten unprintable names, another agency's logo, an unknown id, extra members); DENY media (SVG, HTML, script, JPEG, renamed SVG, animated PNG, bad CRC, trailing bytes, truncated, bomb, 4096 px, hash and encoding mismatches, URL, other formats, rights unconfirmed, > 512 KiB; `fetch` never called); RACE (two changes of one version, identical retry, same key other body, crash before COMMIT, response lost after COMMIT); storage failure on either write leaves nothing partial; isolation and a CLOSING agency |
| assembler, unit | `packages/data-plane/test/report-inputs.test.ts` | the logo binding: named bytes printed, other/missing bytes and malformed records refused |
| the report on PostgreSQL 17 (3) | `apps/control/test/b13-branding.test.ts` | through the product's handlers: a version recorded with a synthetic logo is bound by a later job and its delivered report embeds exactly the stored PNG (the HTML the engine printed is the one the record names; one image, no URL; issuer line kept); CMD008 open while a job is queued and first read (binds 1, keeps 1); CMD008 begun before the queueing, open at the first read and committed after it — eligible by its instant — never replaces the bound version (binds 2, keeps 2; BR-004); CMD008 committing between queueing and first read (binds 4, keeps 4); later versions for later jobs; a delivered report's bytes, generations and record unchanged by later versions |
| contracts, generators | `command-contracts`, `json-schema`, `outcome-catalogue`, `request-validation`, `response-contract`, `schema-boundary`, `runtime-boundary`, `migrations`, `b05-clock-gates`, `tools/test/openapi` | registry fields, closed schemas, catalogues, route inventory (+2 POST), validator ids, privilege matrix, migration list, clock census, OpenAPI inventory; `apps/api/openapi.json`, `apps/web/src/api/generated.ts` and the matrix regenerated by their generators |

With a Chromium-family browser present, the control case prints a real PDF (`engineId chromium/test`): page 1 carries one 96×32 image
XObject and the text "Prepared by Synthetic Branded Agency" beside the synthetic issuer line. `KAURO_B13_EVIDENCE_DIR` makes the case
write that PDF, its HTML, the stored logo and an evidence record.

The acceptance ledger (`docs/acceptance/case-maps/B13.json`) is not changed: B13 has no case map yet (orders 5 and 6 did not claim
ledger evidence either); claiming CMD008-OK/-DENY/-RACE there needs the independent review id of this order.

## 7. Not in this order

- The branding UI (agency settings screen) and the definitive Kauro visual identity (a renderer version, never an edit of a report).
- JPEG logos (D-BR-6), colours and other brand assets.
- Abuse bounds on the number of stored logos per agency (each is ≤ 512 KiB and needs an OWNER or ADMIN; the platform-wide request limits apply).
- Everything order 6 lists as blocked: the owner's legal identity (every report is still refused ISSUER_UNAVAILABLE until it is recorded),
  B14's worker host and composition root binding `PlatformReportInputs`, B15's object storage and fiscal issuance.
