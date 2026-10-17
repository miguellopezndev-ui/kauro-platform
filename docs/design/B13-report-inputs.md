# B13 — The report's inputs from the platform's records (order 6)

Order 6 of the build program. It replaces the simulated `ReportInputsPort` of order 5 with the platform's own: every fact a B13 report
states that the package does not is read from a record the platform wrote, and verified against the hash another record holds, before
a report can be made. It adds the minimum persistence those facts lacked (migration 0095), changes no B08 mechanism, no renderer and no
PDF, and calls no cloud service. Local: no real customer data, no real legal identity.

## 1. Where it runs and what it may see

```
worker (B14 host, not built)                                control plane
  ReportingExecutionEnvelope ── ReportInputsPort.read(scope) ──▶ PlatformReportInputs (@kauro/control)
  @kauro/data-plane assembleReportFacts                          one SYSTEM unit of work, JOB_EXECUTION, bound to the job's agency
  (verifies every binding; refuses)                              kauro_control under FORCE ROW LEVEL SECURITY (D-CTRL-1)
                                                                 @kauro/persistence reportSourcesOf(uow).read(scope)
                                                                 + uow.execution.deliveryCountFacts(job)
```

- The component that renders documents (`@kauro/reports`, the data-plane stage) never opens a database connection: it receives
  `AuthorizedReportInputs`. The architecture gate forbids `@kauro/data-plane` from importing `@kauro/persistence` (adapter to adapter);
  only the control plane (an entrypoint) joins them.
- The reader decides nothing. A missing record is `null`, never an empty list, a zero or a default. Verification is in one place,
  `assembleReportFacts`, which the stage runs on every input, real or simulated.
- Every statement is keyed by the scope's agency and the job's own binding, and runs under row security bound to that agency: an
  attempt of another job, project or agency reads nothing (`FACTS_UNAVAILABLE`).
- `SIMULATED` inputs are refused by the stage unless its composition admits them (`admitSimulatedInputs`, tests only;
  `INPUTS_SIMULATED`), and the simulator's bindings are refused from any input that does not say `SIMULATED`.

## 2. Inventory: the records reused

| fact | record (table . column) | written by | verified by the assembler |
|---|---|---|---|
| scope | `processing_jobs` ⋈ `processing_attempts` on (agency, project, job) and the attempt id | B08 | the inputs name the scope they were read for (`FACTS_FOREIGN_SCOPE`) |
| job subject | `processing_jobs` (plan id and hash, approval id, revision hash, target contract hash, receipt hash, authorization id, `queued_at`) | CMD036 | every binding below is held to it |
| expected manifest | `validation_receipts.artifact_evidence_hash` of the job's VALID receipt (whole subject) | the validator | the package's manifest (`PACKAGE_BINDING_MISMATCH` in the model) |
| populations, counts | `deliveryCountFacts` — `dataset_revisions` populations and `validation_receipts.counts` (the publication's own read) | B07, the validator | `deliveryRowCountsOf` (`COUNTS_*`); the package's bytes (`DECLARED_COUNTS_MISMATCH`) |
| frozen quote, billable units | `commercial_authorizations.quote_id` → `quotes` (every member of the KAURO_QUOTE_TERMS_V1 preimage, `state`) | CMD027, B09 | §3 |
| terms version and hash | `quotes.terms_version`, `quotes.terms_hash` | CMD027 | §3 |
| the agency's acceptance | `agency_agreement_acceptances` (terms version, document hash, `accepted_at`) | CMD002 | §3 |
| issuer | `fiscal_issuers` (the quote's `issuer_ref`: jurisdiction, `legal_identity_hash`, `legal_fact_status`) and `legal_identity_snapshots.document` (new) | the control plane | §3 |
| branding | `agency_branding_versions` (new): the version in force when the job was queued | the agency's OWNER or ADMIN | §4.1 |
| findings | `audits.finding_codes` of the one audit of the job's subject (agency, project, revision hash, target contract hash) | AUDIT_ORCHESTRATION | §4.3 |
| material decisions | `approvals.disclosures_hash` of the job's approval; `plans.body` and the receipt's `physicalSourceRows`, composed again by the edition's composer | CMD025 | §4.4 |
| privacy class | the audience of a B08 package (policy, §4.2) | — | `PRIVACY_UNAUTHORIZED` |

No table was duplicated and the commercial model is untouched: the quote, the acceptance, the issuer, the audit and the approval are read
as they are.

## 3. Terms and the issuer

### 3.1 The two hashes are different documents

`quotes.terms_hash` is `structuredDigest("KAURO_QUOTE_TERMS_V1", 1, QuoteTermsPreimage)` (`@kauro/domain` pricing.ts): the quote's own
service scope, count evidence, price, discount, fiscal snapshot, amounts, validity and terms version, including the issuer it names
(`issuerRef`). `KAURO_REPORT_TERMS_SNAPSHOT_V1` (order 5) is the raw SHA-256 of `{termsVersion, issuer}`. They are not the same document,
and they cannot be made equal: a snapshot whose raw SHA-256 is a quote's terms hash would be a second preimage of SHA-256. Order 5's
control tests passed only because their fixture recorded the snapshot's hash as the quote's (`termsHash: TERMS.termsSha256`); no
production quote can. The verdict is **incompatible**, and nothing here pretends otherwise: the snapshot binding is kept for the
simulator only and refused from the platform's inputs; no recorded hash was rewritten.

### 3.2 The versioned, verifiable link (binding QUOTE_TERMS_V1)

```
quotes.terms_hash ══ KAURO_QUOTE_TERMS_V1(preimage)      recomputed from the recorded members (money as decimal strings, instants exact
       │                                                 to the microsecond as the database renders them, the same spelling CMD027 hashed)
       ├─ preimage.termsVersion ══ quotes.terms_version ── agency_agreement_acceptances (that version, accepted_at ≤ preimage.issuedAt)
       ├─ preimage.{agencyId, projectId, planId, approvalId, planHash, revisionHash, targetContractHash} ══ the scope and the job's subject
       └─ preimage.issuerRef ── fiscal_issuers.legal_identity_hash ══ SHA-256(KAURO_LEGAL_IDENTITY_V1 document)
                                                                       └─ legalName, jurisdiction (= the issuer row's), taxId → the report's issuer line
```

Refusals: no quote (`QUOTE_UNAVAILABLE`); the recorded members do not hash to the recorded hash, or another terms version
(`TERMS_UNVERIFIABLE`); a quote of another agency, project, plan, approval, source or target (`FACTS_FOREIGN_SCOPE`); a quote that no
longer governs the purchase — any state but `ACCEPTED_FOR_CHECKOUT` (`QUOTE_NOT_IN_FORCE`); no acceptance of the version at or before the
quote (`TERMS_UNAVAILABLE`); no issuer, or no document recorded for its hash (`ISSUER_UNAVAILABLE`); a document that is not the issuer's
hash, not a complete identity, of another jurisdiction, or legal facts that are not `OBSERVED` or `PROFESSIONALLY_CONFIRMED`
(`ISSUER_UNVERIFIABLE`).

The report's `termsSha256` is the quote's terms hash; its issuer is the document's. The issuer therefore cannot differ from the one the
accepted terms name (R2-070), and no brand, fixture or display name can stand in for it. The issuer line prints the registered name, the
ISO 3166-1 code of the registering state and the tax identification number (`registrationId` := `taxId`, the NIT in Colombia).

### 3.3 The legal identity document (KAURO_LEGAL_IDENTITY_V1)

`@kauro/domain` legal-identity.ts: the closed wrapper `{domain, version: 1, payload}` under the canonical profile, payload exactly
`legalName, entityType, jurisdiction, taxId, commercialRegistrationId, registeredAddress`. Each field is a recorded fact or the document is
refused: non-empty, unpadded, NFC, at most its length, none of the controls, format characters, separators or markup-significant
characters the report model refuses (so a recorded identity is always printable), no placeholder (`[NIT]`, `REQUIRES_REVIEW`, `PENDING`,
`TBD`, …), the jurisdiction ISO 3166-1 alpha-2. The bytes must be exactly the canonical form (no second spelling). The legal
representative is not in it: a person's name stays outside the platform (owner decision D-16) and no report prints it.

### 3.4 History

`fiscal_issuers.legal_identity_hash` is immutable (0013); `legal_identity_snapshots` is append-only for every role and content-addressed;
`quotes` members, `terms_hash` and `terms_version` are immutable (0014); acceptances are append-only (0028). A corrected identity is
another document, another hash and another fiscal issuer; the quotes already issued keep the identity their terms named. Nothing in this
order rewrites a term, a hash or an acceptance.

## 4. Branding, privacy, findings, decisions

### 4.1 Branding: a recorded version, pinned to the job

`kauro.agency_branding_versions` (0095): numbered 1, 2, … per agency by the database (`agency_branding_versions_contiguous`; two
concurrent recorders of one number: the primary key admits one), the instant the database's, append-only, recorded by the agency's ACTIVE
OWNER or ADMIN as itself (MANAGE_BRANDING), printable or refused at the source. A job's reports — every attempt of it — name the version
recorded at or before the job's `queued_at`; a later version is for later jobs (registry CMD008: "a new branding version for future
reports while preserving already delivered artifact identity"). The report's `brandingVersion` is `agency-branding-v<n>`. A delivered
PDF and record never change: they are generation-0 objects of their package, and a new version is a new model hash in another job.
No logo column: the stored-logo pipeline is CMD008's; an agency branding names no logo (`BRANDING_UNVERIFIABLE` if logo bytes are given).
CMD008's route is not part of this edition: until it exists (or another owner-approved path records version 1), an agency has no
branding version and its reports are refused `BRANDING_UNAVAILABLE`. The renderer's visual identity is `rendererVersion`, not branding:
a new Kauro visual identity is a new renderer version, never an edit of a delivered report.

### 4.2 Privacy class: the audience of a B08 package

Every report this path makes is carried by a B08 package, whose delivery copies CMD038 grants to members of the package's agency only
(never a seller, never another agency), and which itself holds the agency's records and their traceability. Its class is
`SECURE_DETAIL` (`B08_PACKAGE_REPORT_PRIVACY_CLASS`); the platform's inputs carrying another class are refused (`PRIVACY_UNAUTHORIZED`).
`INTERNAL_EVIDENCE` (Kauro's own) and `AGENCY_SUMMARY` (a summary for wider circulation) are other deliveries, none of which exists yet.

### 4.3 Findings

The one audit of the job's subject (audits_one_per_subject; a revision hash and a target contract hash name one row each in a project).
Its `finding_codes` are recorded with its NEEDS_DECISION or UNSUPPORTED edge; a DRAFT_READY audit recorded none, and that empty list is
the audit's own record. No audit, or more than one (`FINDINGS_UNAVAILABLE`); an audit in a state no plan comes from (`FINDINGS_UNVERIFIABLE`).

### 4.4 Material decisions

The registry's "disclosed high-impact decisions" are the disclosure set the agency approved (CMD025): one token per mapping,
`<intent>:<object>.<field>:<physical rows>`. The approval records only its hash. The control plane composes the set again with the
edition's composer (`@kauro/application` `disclosureItemsOf`) from the approved plan's body and the receipt's count; the assembler holds
it to the approval's `disclosures_hash` (`disclosuresHashOf`) and to the job's approval, plan and receipt. Any other set
(`DECISIONS_UNVERIFIABLE`), another approval's (`FACTS_FOREIGN_SCOPE`), none (`DECISIONS_UNAVAILABLE`).

## 5. Persistence added — migration 0095

| object | what | who |
|---|---|---|
| `kauro.legal_identity_snapshots` | `legal_identity_hash` (PK) = SHA-256(`document`) (`legal_identity_snapshots_content_addressed`), `recorded_at` stamped by the database; append-only, no truncate; FORCE RLS | control plane: SELECT, INSERT (two columns); nobody else |
| `kauro.agency_branding_versions` | (agency, version) PK, display name fenced, recorder's membership and person (FK), instant stamped; contiguity guard; append-only; FORCE RLS | kauro_app: INSERT as OWNER/ADMIN of the bound agency (`kauro.acting_branding_manager`), SELECT bound; control: SELECT bound |
| `quotes_control_report_read` + column SELECT | the preimage members, `state`, `terms_hash`, `terms_version`, bound to the agency | control plane |
| `agency_agreement_acceptances_control_read` + column SELECT | terms kind, version, document hash, `accepted_at` — never the person | control plane |
| `approvals.disclosures_hash` column SELECT | (`approvals_control_execution_read` already binds the agency) | control plane |

Nothing is backfilled: no legal identity and no branding is invented for an existing agency. No existing row, constraint or hash changes.
The reviewed privilege matrix (`packages/persistence/test/fixtures/runtime-boundary.json`) gains exactly these 126 lines.

## 6. Refusal codes added (`REPORT_STAGE_ERROR_CODES`)

`INPUTS_SIMULATED`, `QUOTE_UNAVAILABLE`, `QUOTE_NOT_IN_FORCE`, `ISSUER_UNAVAILABLE`, `ISSUER_UNVERIFIABLE`, `BRANDING_UNAVAILABLE`,
`BRANDING_UNVERIFIABLE`, `FINDINGS_UNAVAILABLE`, `FINDINGS_UNVERIFIABLE`, `DECISIONS_UNAVAILABLE`, `DECISIONS_UNVERIFIABLE`,
`PRIVACY_UNAUTHORIZED`. Each ends the attempt REFUSED (terminal: job FAILED, nothing delivered), as order 5's refusals do; an
infrastructure failure reading the inputs is thrown (retryable), never a refusal.

## 7. Evidence

| suite | where | what |
|---|---|---|
| assembler, unit (11) | `packages/data-plane/test/report-inputs.test.ts` | every binding verified; every alteration, absence, foreign scope, unconfirmed issuer, placeholder identity and simulated binding refused with its code; KAURO_REPORT_TERMS_SNAPSHOT_V1 vs the quote's hash; the chain to a staged PDF from platform inputs (CLEAN, Salesforce); INPUTS_SIMULATED |
| order 5's chain (30) | `packages/data-plane/test/report-delivery.test.ts` | unchanged cases, the simulator now admitted explicitly |
| 0095 on PostgreSQL 17 (4) | `packages/persistence/test/b13-report-sources.test.ts` | from a cluster at 0094 holding a CMD027 quote: no row changes; the control plane recomputes exactly CMD027's terms hash; content addressing, append-only (superuser included), completeness; branding numbering, authority, printability, the concurrent recorder, isolation; column-scoped reads |
| PlatformReportInputs on PostgreSQL 17 (9) | `apps/control/test/b13-report-inputs.test.ts` | CLEAN and Salesforce: each input equals its record, the delivered report printed from them; scope crossings; quote expired or withdrawn, terms altered, another version, acceptance missing or late; issuer without document, PENDING, OWNER_DECLARED, another jurisdiction; branding change after a delivery, a job queued before it, none at queue time; another project's disclosures and audit; counts and receipt; 12 concurrent reads and a second reader — each refusal followed to the end of its job (FAILED REFUSED, the report's code, nothing delivered) |
| order 5 on PostgreSQL 17 (12) | `apps/control/test/b13-report-delivery.test.ts`, `b13-report-lifecycle.test.ts` | unchanged cases, now through PlatformReportInputs over the platform's records instead of the oracle and the simulated snapshot |
| boundary, census | `runtime-boundary`, `b16-rls-census`, `sec-forall-policy`, `migrations` | the matrix, FORCE RLS, per-command policies, the migration list |

Evidence class: EXECUTED_LOCAL (Windows, PostgreSQL 17, Edge where a browser exists; CI on the exact commit). The legal identity used is
the labelled synthetic TEST identity (`@kauro/persistence/testing` `TEST_LEGAL_IDENTITY`); object storage and the core's staging remain
B07's and B05's contract fakes. "A record the guards would refuse" in the control suite is a superuser rewrite with the triggers off —
how the reader treats a record no runtime role could write — never a runtime write path.

## 8. What the owner still has to provide (blocked, explicitly)

The exact list, and the procedure, are in `docs/owner/LEGAL_IDENTITY_SNAPSHOT.md`: legal name, entity type, jurisdiction, NIT with check
digit, matrícula mercantil, registered address, and the professional confirmation of those facts. Until a document is recorded and a
fiscal issuer names its hash, every report is refused `ISSUER_UNAVAILABLE`. Owner decisions this order took and that the owner may revise:
the report's issuer line prints the NIT as `registrationId`; a B08 package report is `SECURE_DETAIL`; a job's branding is the version in
force when it was queued; branding versions are recorded only by CMD008 (not built), so reports are also refused `BRANDING_UNAVAILABLE`
until it, or another approved path, records one.

## 9. Still blocked until B14/B15

- Binding `ReportingExecutionEnvelope` and `PlatformReportInputs` in a deployment (B14's worker host and composition root; how the worker
  reaches the control plane's read); a deployment-pinned browser.
- Cloud object storage, the fiscal issuance route and its provider (B15); the real fiscal issuer row.
- CMD008 UpdateBranding (route, media pipeline, stored logo) and its UI.
- Replacement of a delivered package (`AVAILABLE → RETIRED`), a product decision.
