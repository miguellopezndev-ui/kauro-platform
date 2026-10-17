# @kauro/data-plane

The platform's own bounded parsers of untrusted source files (layer `adapter`: it implements ports of `@kauro/application`;
design `docs/design/B07-upload-source-lifecycle.md`, mandate B07-DATA-PLANE). They are not providers: they are always real, in
tests too (S024 is decided by them). Every parse of an untrusted file runs in an isolated child process (decision D-ISO-1).

- `IsolatedContainerInspector` — `ContainerInspectorPort` (04 inspectContainer; 09 "Completion and inspection", "Scanner
  coverage"). Streams the exact generation into its own directory of the attempt scratch, computing SHA-256 over every byte and
  stopping at the per-file bound; detects the format from the bytes (never from the declaration); inspects an OOXML workbook
  through a hardened ZIP reader (names, duplicates after NFC and case folding, symlinks, encryption, local headers, contiguous
  layout, declared and produced expansion under 1 GiB per part, 20 GiB total and the ratio bound) and a hardened XML scanner (no
  DTD, no entity but the predefined ones, depth and token bounds), refuses active content and external relationships (a worksheet
  hyperlink is disclosed, never followed), and reports the worksheet inventory (visibility, formulas and their caches, merged
  cells, hidden rows and columns, positional columns with label states); inspects a CSV's encoding, dialect, line endings and every
  record. The result carries the expected scan parts (the container at its verified length and every part at its verified expanded
  length), the parser profile (`parserProfileHashOfInspection`), the checks completed and the `InspectionIsolation` evidence.
- `IsolatedSelectionEvaluator` — `SelectionEvaluatorPort` (design §12.2; 03 "Count the correct population"). Re-checks the
  manifest against the admitted files, re-verifies each file's bytes, and counts physical rows, logical records per projection,
  billable units and association edges exactly, with distinct keys and shared strings spilled to the attempt scratch (bounded
  memory). Formulas are inert: the stored cache is the value.
- `IsolatedTablePreviewReader` — the bounded preview of an admitted table (D-SAPI-7: 20 rows × 50 columns × 200 characters).
- `runIsolated` / `sandboxFlags` — the isolation: `node --permission` with read access to this package's code and the attempt
  input, write access to the attempt scratch only, no child processes, workers, addons or WASI; a preload replaces every network
  entry point by a recording refusal (Node 24's permission model does not govern the network) and counts the permission model's
  refusals. The OS-level egress denial of a production worker host is LATER: B15, and is not claimed here.
- `rejectionClassOfScan`, `rejectionClassOfInspection` — the receipt's rejection class (D-INSP-3).

The attempt envelope of a processing attempt (design `docs/design/B08-audit-approval-jobs.md` D8-STG-1..5, mandate
B08-WORKER-HOST), real in tests too:

- `AttemptScratchStore` — `ScratchStore` (kauro-migration-core 3.0.0's host contract "1.0.0"): one directory per attempt, a byte
  quota checked before any byte lands, a SHA-256 per segment; SCRATCH_EXHAUSTED, SHORT_WRITE and CORRUPT_INTERMEDIATE are distinct
  terminal causes; cleanup removes exactly that directory and never follows a link (`removeAttemptScratch` for the janitor).
- `FencedArtifactWriter` — `ArtifactWriter`: names only inside the capability's staging prefix, spools into the scratch quota,
  writes through a resumable session with the generation-0 precondition, re-reads the exact generation, then writes the
  KAURO_STAGED_MANIFEST_V1 object once; a failed close, short write or read-back mismatch is never a staged artifact.
- `GenerationSourceReader` — `SourceReader`: exactly the sealed ACCEPTED generations of the capability, digest and length
  re-verified on every pass.

`@kauro/data-plane/testing` is test-only (architecture rule `testOnlySubpaths`): the single labelled contract fake of
`MalwareScannerPort`, `ContractFakeMalwareScanner` — CONTRACT FAKE, evidence class SIMULATED, `contract-fake-*` tokens in every
record, bound by no composition root. It models the engine's hazards (skips with exit code 0, a spent scan budget, timeouts,
encrypted and failing parts, the EICAR token, stale or future signatures, configuration drift) and reads its scan instant from the
database clock the caller binds (D-INSP-4). The real engine is LATER: B15.

`@kauro/data-plane/testing/worker-host` is test-only as well: `ContractFakeWorkerHost`, the single labelled contract fake of
`WorkerHostPort` (B08-WORKER-HOST; SIMULATED, `contract-fake-worker-host*` tokens). A local executor running the bound
`ExecutionEnvelopePort` inside the real envelope above, with create-by-identity, scripted ambiguous launches and creation
horizon, heartbeats, termination of one identity, crashes at hold points, a worker surviving its termination and VM, disk and cost
reports. It is a subpath of its own because `@kauro/data-plane/testing` is B07's closed inventory. The real host is LATER: B14.

Tests (`test/`): `container-inspection.test.ts` (S024 corpus, D-ISO-1 negative controls, inventory, CSV facts, preview),
`scan-coverage.test.ts` (S054 with the fake, on a real PostgreSQL 17 clock), `selection-evaluation.test.ts` (exact counts against
an independent counter; hidden worksheets; inert formulas), `attempt-scratch.test.ts` and `fenced-artifact-writer.test.ts`
(S035), `worker-host-fake.test.ts` (S056, S075).

The report stage (B13 x B08; `docs/design/B13-report-delivery.md`, `src/report/`): `ReportingExecutionEnvelope` wraps the core's
`ExecutionEnvelopePort` and, when the core completed, produces the PDF report of the package it staged and stages the PDF and its record
(`report-pdf`, `report-record`) through the attempt's own `FencedArtifactWriter` before the host writes the staged manifest, so B08's
read-back, verification, delivery copies and publication carry the report with the package and refuse it for the same reasons. The
platform's facts come from a `ReportInputsPort` (the issuer only from a terms snapshot whose hash the platform recorded; counts must be
BOUND); `@kauro/data-plane/testing` has its labelled simulator (`SimulatedReportInputs`, SIMULATED). `report-delivery.test.ts` covers the
chain and its failures (a real sandboxed Chromium where a browser exists; CI requires it).
