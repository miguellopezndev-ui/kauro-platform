# B13 x B08 — Report delivery: design

Fourth part of B13 (after the model, the HTML and the PDF) and the first that touches B08. It puts the PDF report of a package into the
chain B08 already has for the package's files — staging, read-back, verification, delivery copies, publication — without changing any of
B08's mechanisms. Order 5 of the build program. Local and synthetic: no cloud, no real data, no deployment.

## 1. Where B13 joins B08, and why that point keeps B08's contracts

B08's worker writes only through the attempt's `FencedArtifactWriter`; whatever the writer closed and re-read is named by the staged
manifest, and from the manifest on **B08 treats every artifact the same**: the control plane reads each back by exact generation, the
verifier compares the set with the authority the platform supplies, each is copied to the delivery location and read back again, and
the publication transaction (`D8-PUB-2`) is the only edge that makes the package downloadable. The attempt's fence, its cancellation
channel, the revocation of a package whose authority was lost, retention and the janitor are all properties of those artifacts.

So the report is staged **inside the attempt, as two more artifacts** (`report-pdf`, `report-record`), after the core staged the package
and before the host writes the staged manifest. Nothing is added to the schema, the roles, the pipeline, the verifier port or the
publication guard: B08 verifies and delivers the report because it is in the manifest, and refuses it for every reason it refuses a
package file. A second place to publish (a step after verification, or a separate report store) was rejected: staged rows are accepted
only from the lease's current attempt while RUNNING (KA080), so it would need a migration, and it would give the report a delivery
path that B08's fencing and revocation do not cover.

`ReportingExecutionEnvelope` (`@kauro/data-plane`) wraps the core's `ExecutionEnvelopePort`:

```
core.execute (stages the package)  →  readStagedPackage  →  readMigrationPackage  →  buildReportModel  →  generateReportPdf
   →  StagedReportPdfPublisher (store, read back, record)  →  host writes the staged manifest  →  [B08] submit, verify, copy, publish
```

Where the host (B14's, not built) binds the envelope, and which engine, page size and locale it uses, is its composition.

## 2. Components

| piece | package | role |
|---|---|---|
| `isGeneratedReportPdf`, `reportPdfProblems`; `ReportPdf` and its identity frozen, bytes copied from the engine | `@kauro/reports` | a publisher accepts only a PDF `generateReportPdf` returned, and only while its bytes still hash to its identity |
| `ReportInputsPort`, `AuthorizedReportInputs` (each fact in its binding), `assembleReportFacts`; the simulator's terms snapshot (`termsSnapshotBytesOf`, `readTermsSnapshot`) | `@kauro/data-plane` `report/facts.ts` | the platform's facts for one report, verified (§3; order 6: `B13-report-inputs.md`) |
| `PlatformReportInputs` | `@kauro/control` `execution/report-inputs.ts` | the platform's port: the records of `@kauro/persistence` `reportSourcesOf`, in the control plane's bound SYSTEM unit (order 6) |
| `StagedReportPdfPublisher` (implements `ReportPdfPublisher`), `reportPdfObjectNameOf` | `report/publisher.ts` | stores the PDF through the attempt's writer, reads it back, then records it (§4) |
| `ReportPdfRecord`, `readReportPdfRecord`, `reportRecordProblems` | `report/record.ts` | the canonical document that says which PDF a package carries and whose it is |
| `readStagedPackage`, `produceStagedReport`, `ReportingExecutionEnvelope` | `report/stage.ts` | the chain, and its join with the attempt |
| `ReportStageError` (closed codes) | `report/errors.ts` | a refusal never quotes package content |
| `SimulatedReportInputs`, `simulatedReportInputsOf`, `simulatedTermsOf` | `@kauro/data-plane/testing` | the labelled simulator of the inputs (SIMULATED); test-only |

Reused unchanged from B08: `FencedArtifactWriter` (generation-0 precondition, scratch quota, fence and cancellation checks, read-back by
generation), `readStagedManifest`, the staging/verification/copy/publication steps of `JobPipeline`, the store and its guards, CMD038.
One export was added to `MigrationCoreAdapter` (`PACKAGE_MANIFEST_ROLE`, the constant it already used) so the stage finds the package's
manifest by the role the adapter gives it.

## 3. The platform's facts (`ReportInputsPort`)

`buildReportModel` takes `PlatformFacts` as untrusted data. `assembleReportFacts` is what makes them the platform's: the port answers,
for the attempt's scope (agency, project, job, attempt), only what the platform recorded.

| fact | source | refused when |
|---|---|---|
| expected manifest hash | the validation receipt the job is bound to (`artifactEvidenceHash`) | the package's manifest differs (`PACKAGE_BINDING_MISMATCH`) |
| `declaredCounts` → `countsBinding: BOUND` | `deliveryRowCountsOf` over the sealed revision's populations and the receipt's counts — the rule the publication itself applies | no counts (`COUNTS_UNAVAILABLE`), populations and receipt disagree (`COUNTS_MISMATCH`), unresolved decisions (`COUNTS_UNRESOLVED`), or the package's bytes do not prove them (`DECLARED_COUNTS_MISMATCH`). **A delivered report is never UNBOUND.** |
| billable units, quote id | the frozen quote | differ from the sealed populations (`DECLARED_COUNTS_MISMATCH`) |
| terms version and hash | the frozen quote (`terms_version`, `terms_hash` = KAURO_QUOTE_TERMS_V1 of its preimage, recomputed; order 6) | altered, another version, not accepted by the agency, the quote not in force (`TERMS_UNVERIFIABLE`, `TERMS_UNAVAILABLE`, `QUOTE_NOT_IN_FORCE`) |
| issuer | order 6: the KAURO_LEGAL_IDENTITY_V1 document whose SHA-256 is the `legal_identity_hash` of the fiscal issuer the quote's preimage names (`B13-report-inputs.md` §3). The order-5 terms snapshot is the simulator's binding only: its raw hash can never be a quote's terms hash | absent or unverifiable (`ISSUER_UNAVAILABLE`, `ISSUER_UNVERIFIABLE`); unsafe text (`FACTS_MALFORMED`) |
| branding, privacy class, finding and decision ids | order 6: the agency's branding version in force when the job was queued (bound once per job), the audience of a B08 package (SECURE_DETAIL), the subject's audit findings, the approval's disclosure set held to its hash | `BRANDING_*`, `PRIVACY_UNAUTHORIZED`, `FINDINGS_*`, `DECISIONS_*` |
| `reportId`, `packageId` | `rpt-<jobId>`, `pkg-<attemptId>` (the package version row is minted after the worker ran) | — |
| scope | the inputs name the scope they were read for | any of the four ids differs (`FACTS_FOREIGN_SCOPE`) |

Neither a brand nor an appearance fixture supplies the issuer or the terms: `Branding` has no field for them and the assembler reads
them from the issuer's legal identity document the quote's terms name (order 6). This closes R2-070's missing binding of the issuer to
the terms **for this path**: the terms hash binds `issuerRef`, the issuer's recorded hash binds the document, so the issuer cannot differ
from the one the accepted terms name.

## 4. Generated, stored, verified, published

| stage | what exists | where it is claimed | by whom |
|---|---|---|---|
| generated | `ReportPdf` (`storage: "NOT_PERSISTED"`) | memory | `generateReportPdf` |
| stored | the PDF as a closed staged artifact, read back by the writer | the attempt's staging prefix | `FencedArtifactWriter` |
| verified | the generation read again by itself and hashed against `identity.pdfSha256`, whatever the writer concluded | same | `StagedReportPdfPublisher` |
| recorded | `report-record` staged **only after** the verification: scope, the whole identity, the PDF's object and generation, `stage: STAGED_VERIFIED` | same | `StagedReportPdfPublisher` |
| published | the package AVAILABLE and the copies downloadable | the delivery location | B08's publication transaction — nothing here claims it |

`pdfSha256` is the `sha256` column of the PDF's staged and delivery rows (B08 records it); everything else the identity says, and whose
the report is, is the record, which B08 copies, hashes into the delivery manifest, revokes and retains with the rest.

Publisher rules: a look-alike `ReportPdf`, a PDF whose bytes changed after generation, a PDF of another report, package or model, and a
publisher whose scope is not the writer's are refused before anything is written. The PDF is written once under a name derived from the
report and the PDF's hash, never over anything: a name that already holds a generation this writer did not write is refused and left as
it is (`OBJECT_NOT_THIS_WRITERS`). One PDF per attempt, however many publishers exist: the writer's own closed artifacts are the record
(`REPORT_ALREADY_STAGED`). The same PDF published again, or concurrently, returns the same staged artifacts after verifying again.

Failure classes. *Refusals* about the report's content or the platform's records end the attempt `REFUSED`, which B08 already treats as
terminal (job FAILED, no manifest, no package); the package files already staged stay in the prefix as evidence for the janitor. *An
uncertain read-back, a browser that cannot print (`PDF_ENGINE_FAILED`: it may be temporary; B08's three attempts bound it), or any infrastructure failure,* is thrown: the host reports a retryable error, the lease is taken over and the next
attempt produces its own report in its own prefix. A stored PDF that does not read back as written (`STORED_BYTES_DIFFER`) is a refusal.
A storage failure while the writer closes the PDF or the record is the writer's latched `ARTIFACT_CLOSE_FAILED`/`READBACK_MISMATCH`, which B08 classifies as terminal for every staged artifact (S035, `TERMINAL_CAUSES`); the report inherits that classification exactly as the package's files have it, and changing it would alter a B08 mechanism, so it is left as it is (residual risk, §7). Publication is serialized per attempt writer, however many publishers share it. A cancellation or fence seen between steps ends the attempt `CANCELLED`/`FENCED` before the engine runs or before anything is stored.

A retry inside one attempt is idempotent only for the same `ReportPdf`: Chromium's output is not deterministic, so regenerating inside
the same attempt would be another PDF and is refused. B08 never restarts an attempt (a takeover is a new attempt, fence + 1, new prefix),
so no adoption of an earlier attempt's PDF exists or is needed.

## 5. Presentation is not content

The renderer is the one accepted in `main` (`rendererVersion` is part of the model and of its hash). A different layout is a different
renderer version, therefore a different model hash, a different PDF and a different delivery: nothing a later version does can change a
published PDF, its record or its identity, because published objects are only ever created (generation-0) and the new version is another
job's artifact. `review/visual-v1-prototypes` is not imported.

## 6. Evidence

Layer 1 — `packages/data-plane/test/report-delivery.test.ts` (30 cases), over the real attempt envelope and B07's storage fake, with
real Chromium where a browser exists (CI requires it): the CLEAN and Salesforce packages end to end; manifest mismatch; a package that does
not verify; counts missing, inconsistent or unsupported by the bytes; terms and issuer unverifiable; failed or invalid printing; stored
bytes truncated, altered, another report's, replaced behind the writer, or unreadable; an interrupted upload; duplicate, concurrent and
retried publication; another agency, project, job or attempt; fence and cancellation at three points; storage failures at each
object; a corrected report keeping the first; the record read back strictly.

Layer 2 — `apps/control/test/b13-report-delivery.test.ts` and `b13-report-lifecycle.test.ts` (12 cases), on a real PostgreSQL 17 through
B08's own control plane: both packages delivered by B08's steps with the PDF and record among the delivery copies, each read back; nine
refusals ending the job FAILED with nothing delivered; the PDF tampered between worker and control plane (S061); reversal (R2-045),
cancellation (CMD037) and a stale attempt (S056) with the report in the package; the worker killed while printing and while storing; the
control plane dying in verification and a delivery copy whose answer is lost; a corrected version keeping the first delivery; CMD038
granting the delivered PDF to its agency only and refusing every unpublished package.

| case | evidence |
|---|---|
| chain, storage, read-back, record, B08 steps | EXECUTED_LOCAL (Windows; PostgreSQL 17; Edge 155 sandboxed); CI on the exact commit |
| object storage, worker host, Migration core staging | SIMULATED — contract fakes of their owners; the packages themselves are the core's own acceptance packages (EXECUTED_LOCAL bytes) |
| terms, issuer, branding, privacy class, finding and decision ids | order 6: the platform's records through `PlatformReportInputs` (EXECUTED_LOCAL); the legal identity used in tests is the labelled synthetic TEST identity |

## 7. Not connected, and what is left

- **The issuer's legal identity**: order 6 added its store (migration 0095) and the platform's port; no document is recorded (the owner
  has not provided the facts: `docs/owner/LEGAL_IDENTITY_SNAPSHOT.md`), so every report is refused `ISSUER_UNAVAILABLE` until one is.
- **A composition root** that binds `ReportingExecutionEnvelope` in a worker (B14) and a deployment-pinned browser; the cloud storage and
  host remain B14/B15.
- **The database-backed `ReportInputsPort`** exists (order 6, `PlatformReportInputs`); binding it for a deployed worker is B14's.
- **Replacement of a delivered package** (`AVAILABLE → RETIRED`, "LATER B13" in the B08 machine) is not performed; a corrected report is
  another job's package and the first delivery stays AVAILABLE. Deciding which one supersedes the other is a product decision.
- Branding versions have a store (0095) but no writer route yet (CMD008); privacy class, findings and decisions come from records (order 6).
- A transient storage outage while a report artifact is being written fails the job as it does for any staged artifact (B08 S035); a retryable class for writer failures would be a B08 change.
- The report is read in memory (`readMigrationPackage`); a package larger than `DEFAULT_MAX_PACKAGE_BYTES` (256 MiB) is refused
  (`PACKAGE_TOO_LARGE`), not truncated.
