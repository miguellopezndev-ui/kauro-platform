// The execution world with B13's report stage in the worker (B13 x B08; docs/design/B13-report-delivery.md §6): the world's worker host
// runs ReportingExecutionEnvelope over a core that stages a real Migration Core 3.1.0 acceptance package, so every job of this world
// delivers a package and the PDF report of that package through B08's own steps — staging, read-back, verification, delivery copies,
// publication — on a real PostgreSQL 17.
//
// REAL: the report chain, the attempt's envelope, B08's control plane and store, the PDF engine where a browser exists, and the report's
// inputs — read by the platform's own ReportInputsPort (PlatformReportInputs, order 6) in the control plane's bound SYSTEM unit of work
// from the platform's records: the validation receipt's manifest hash, the sealed revision's populations and the receipt's counts (through
// the store function the publication itself uses), the frozen quote with its KAURO_QUOTE_TERMS_V1 preimage, the agency's acceptance of its
// terms version, the fiscal issuer and its legal identity document, the agency's branding version, the subject's audit findings and the
// approval's disclosure set (the edition's composer over the plan and the receipt).
// SYNTHETIC — the legal identity document is the labelled TEST identity of @kauro/persistence/testing (no record holds the owner's yet).
// CONTRACT FAKE — SIMULATED: B07's object storage and the Migration core's staging (an acceptance package replayed through the writer,
// as MigrationCoreAdapter stages one). The superuser connection is the oracle only.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionEnvelopePort, ExecutionOutcome, HostIo, StagedArtifact } from "@kauro/application";
import type { RowCounts, Sha256Hex } from "@kauro/contracts";
import { ChromiumPdfEngine, ReportingExecutionEnvelope, findChromiumExecutable, type AuthorizedReportInputs, type ReportInputsPort, type ReportRenderConfig, type ReportScope } from "@kauro/data-plane";
import type { AuditId, AuditStepId } from "@kauro/domain";
import { TEST_LEGAL_IDENTITY, acceptReportAgreements, publishReportAgreements, recordBranding, recordIssuerOfIdentity, recordLegalIdentity } from "@kauro/persistence/testing";
import { AGENCY_DECISION_REQUIRED } from "../../src/audit/orchestration.js";
import { PlatformReportInputs } from "../../src/execution/report-inputs.js";
import { openAuditWorld, type AuditWorld } from "./audit-world.js";
import { ids, startExecutionWorld, type AuditSubject, type ExecutionWorld, type ReportFixture, type TestClockExecutionUnits } from "./execution-world.js";

export type PackageName = "A-clean-multi-object" | "D-salesforce";
type Engine = ConstructorParameters<typeof ReportingExecutionEnvelope>[0]["engine"];

// compiled to apps/control/dist/test/support: five levels up is the repository root
const FIXTURES = fileURLToPath(new URL("../../../../../packages/reports/test/fixtures/mc-3.1.0/", import.meta.url));

export function loadPackage(name: PackageName): Map<string, Uint8Array> {
  const dir = join(FIXTURES, name);
  const files = new Map<string, Uint8Array>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(relative(dir, full).split(sep).join("/"), new Uint8Array(readFileSync(full)));
    }
  };
  walk(dir);
  return files;
}

export const sha256 = (v: string | Uint8Array): Sha256Hex => createHash("sha256").update(v).digest("hex");

/** MigrationCoreAdapter's `roleOf`, mirrored (the adapter keeps it private): the area of a package file decides its staged role. */
export function packageRoleOf(file: string): string {
  if (file === "manifest.json") return "package-manifest";
  const map: Record<string, string> = { "01_IMPORT": "import", "02_EXCEPTIONS": "exceptions", "03_TRACEABILITY": "traceability", "04_DOCUMENTATION": "documentation" };
  return map[file.split("/")[0] ?? ""] ?? "package-file";
}

/**
 * What the platform's records say about an acceptance package: the core's own manifest hash, and the counts the package proves (read
 * once through the report model with the quote left to the package's own logical records, as B13's tests take their oracle).
 */
export const PACKAGE_RECORDS: Readonly<Record<PackageName, { readonly expectedManifestSha256: Sha256Hex; readonly counts: RowCounts; readonly packageDigest: string; readonly files: number }>> = Object.freeze({
  // manifestSha256 and packageDigest: the core's own acceptance.json and an independent implementation of its package digest (reports/test/support/fixtures.ts)
  "A-clean-multi-object": {
    expectedManifestSha256: "9979ff952e8d078c6c9f3b971dfb033f5d22dee1c7fb38e26162f47165f7b2ea",
    packageDigest: "36022380c955e6b3ae1f7a27e6ddd161ccfedce015fe201c9a1ae74348511683",
    files: 30,
    counts: { physicalSourceRows: 19, logicalSourceRecords: 15, billableSourceUnits: 15, associationEdges: 12, emittedRepresentatives: 19, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: 27 },
  },
  "D-salesforce": {
    expectedManifestSha256: "c88a1306f8cbb5a5f344f3608e1a7f3769a53caa40d4cfa4c414f739e77f7a75",
    packageDigest: "280dab9ff34d386bfcd5e605f99b9fe572c197b2b6eeb5952e7dcde4de2c22e2",
    files: 30,
    counts: { physicalSourceRows: 19, logicalSourceRecords: 15, billableSourceUnits: 15, associationEdges: 12, emittedRepresentatives: 15, mergedNonSurvivors: 0, rejected: 0, withheld: 4, unresolved: 0, emittedArtifactRows: 23 },
  },
});

export const TERMS_VERSION = "TERMS-2026-01";
/** The issuer every report of this world names: the labelled synthetic identity its fiscal issuer's legal identity hash is the hash of. */
export const ISSUER = TEST_LEGAL_IDENTITY;
/** The branding version every agency of this world records before it queues anything. */
export const BRAND = "Synthetic Test Agency";

/** The fixture a purchase needs to deliver `name`: the package's counts and the manifest hash its receipt binds. */
export function reportFixtureOf(name: PackageName, overrides: Partial<ReportFixture> = {}): ReportFixture {
  const record = PACKAGE_RECORDS[name];
  return { counts: record.counts, expectedManifestSha256: record.expectedManifestSha256, ...overrides };
}

/** What one agency's jobs do in this world: which package the core stages, and how the report is printed. */
export interface ReportScenario {
  readonly packageName: PackageName;
  /** Prints the report; default: the real Chromium engine where a browser exists, else a scripted PDF. */
  readonly engine?: () => Engine;
  readonly rendererVersion?: string;
  /** Edits the platform's inputs after they were read from the database (a test of a record that is missing or wrong). */
  readonly inputs?: (read: AuthorizedReportInputs | null) => AuthorizedReportInputs | null;
  /** Runs after the core staged and before the report is made (the worker's moment between package and report). */
  readonly afterCore?: (io: HostIo, staged: readonly StagedArtifact[]) => Promise<void>;
}

const browser = findChromiumExecutable(process.env["KAURO_PDF_BROWSER"] ?? null);
const required = process.env["KAURO_REQUIRE_PDF_ENGINE"] === "1";

export const hasBrowser = browser !== null;

export function defaultEngine(): Engine {
  if (browser !== null) return new ChromiumPdfEngine({ executablePath: browser }, "chromium/test");
  if (required) throw new Error("KAURO_REQUIRE_PDF_ENGINE=1 but no Chromium-family browser was found (set KAURO_PDF_BROWSER)");
  return {
    engineId: "scripted/1",
    print: async (request) => new TextEncoder().encode(`%PDF-1.7\n% ${sha256(request.html)}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${"% filler\n".repeat(40)}trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`),
  };
}

/** The core's side of an attempt: stages the acceptance package of the agency's scenario through the writer, as the adapter does. */
function coreOf(scenarios: Map<string, ReportScenario>): ExecutionEnvelopePort {
  return {
    async execute(subject, io): Promise<ExecutionOutcome> {
      const scenario = scenarios.get(subject.agencyId);
      if (scenario === undefined) throw new Error(`no report scenario for agency ${subject.agencyId}`);
      const files = loadPackage(scenario.packageName);
      const staged: StagedArtifact[] = [];
      for (const path of [...files.keys()].sort()) {
        const handle = io.writer.open(packageRoleOf(path), sha256(path));
        await handle.write(files.get(path) as Uint8Array);
        staged.push(await handle.close());
      }
      await scenario.afterCore?.(io, staged);
      return { evidenceClass: "SIMULATED", terminalCause: "COMPLETED", stagedArtifacts: staged, reconciliationSummary: { ok: true }, resourceMetrics: { peakMemoryBytes: 0, peakScratchBytes: 0, wallClockMs: 0 } };
    },
  };
}

/** The platform's ReportInputsPort over the world's units, and a scenario's edit of what it read (a record missing or wrong). */
function inputsOf(units: TestClockExecutionUnits, scenarios: Map<string, ReportScenario>): ReportInputsPort {
  const platform = new PlatformReportInputs({ units, ids });
  return {
    async read(scope: ReportScope): Promise<AuthorizedReportInputs | null> {
      const read = await platform.read(scope);
      const edit = scenarios.get(scope.agencyId)?.inputs;
      return edit === undefined ? read : edit(read);
    },
  };
}

export interface ReportWorld extends ExecutionWorld {
  readonly scenarios: Map<string, ReportScenario>;
  /** Registers the scenario of an agency's jobs. */
  scenario(agency: { readonly agencyId: string }, scenario: ReportScenario): void;
  /** What each job's report stage answered the host, by job id (the last attempt's; a thrown error records nothing). */
  readonly outcomes: Map<string, ExecutionOutcome>;
}

export const RENDER: ReportRenderConfig = { pageSize: "LETTER", locale: "en-US", rendererVersion: "renderer-1.0.0" };

export async function startReportWorld(tag: string): Promise<ReportWorld> {
  const scenarios = new Map<string, ReportScenario>();
  const outcomes = new Map<string, ExecutionOutcome>();
  let self: ExecutionWorld | null = null;
  let audits: AuditWorld | null = null;
  /** The subject's audit, taken through its steps to NEEDS_DECISION with its finding, as AUDIT_ORCHESTRATION records it (the plan is the agency's). */
  const audited = async (subject: AuditSubject): Promise<void> => {
    audits ??= await openAuditWorld(self as ExecutionWorld);
    const a = audits;
    const { audit } = await a.start(subject);
    const auditId = audit.auditId as AuditId;
    const agencyId = subject.agency.agencyId;
    const profile = await a.control(agencyId, (uow) => uow.audits.claimStep(auditId, "PROFILE", ids.next() as AuditStepId));
    await a.control(agencyId, (uow) => uow.audits.recordStep(profile.step.stepId, { outcome: "COMPLETED", evidenceHash: sha256(`profile-${auditId}`), evidenceClass: "SIMULATED" }));
    await a.control(agencyId, (uow) => uow.audits.advanceAudit(auditId, profile.audit.version, { to: "INTERPRETING", profileEvidenceHash: sha256(`profile-${auditId}`), candidateManifestHash: sha256(`candidates-${auditId}`) }));
    const interpret = await a.control(agencyId, (uow) => uow.audits.claimStep(auditId, "INTERPRET", ids.next() as AuditStepId));
    await a.control(agencyId, (uow) => uow.audits.recordStep(interpret.step.stepId, { outcome: "NEEDS_DECISION", evidenceHash: null, evidenceClass: "SIMULATED" }));
    const decided = await a.control(agencyId, (uow) => uow.audits.advanceAudit(auditId, interpret.audit.version, { to: "NEEDS_DECISION", findingCodes: [AGENCY_DECISION_REQUIRED] }));
    if (decided.kind !== "APPLIED") throw new Error(`the subject's audit ${auditId} did not reach NEEDS_DECISION (${decided.kind})`);
  };
  const world = await startExecutionWorld(tag, {
    // the issuer the quotes name: a qualified route whose legal identity hash is the recorded synthetic identity's
    issuer: async (h) => recordIssuerOfIdentity(h, (await recordLegalIdentity(h, ISSUER)).legalIdentityHash),
    // each agency accepts the published terms the quotes name and records its branding before it queues anything
    onAgency: async (h, agency) => {
      await acceptReportAgreements(h, agency, await publishReportAgreements(h, { terms: TERMS_VERSION }));
      await recordBranding(h, agency, BRAND);
    },
    onSubject: audited,
    envelope: (parts) =>
      ({
        async execute(subject, io): Promise<ExecutionOutcome> {
          const scenario = scenarios.get(subject.agencyId);
          const envelope = new ReportingExecutionEnvelope({
            inner: coreOf(scenarios),
            storage: parts.storage,
            inputs: inputsOf(parts.units, scenarios),
            engine: scenario?.engine?.() ?? defaultEngine(),
            render: { ...RENDER, rendererVersion: scenario?.rendererVersion ?? RENDER.rendererVersion },
          });
          const outcome = await envelope.execute(subject, io);
          outcomes.set(subject.jobId, outcome);
          return outcome;
        },
      }) satisfies ExecutionEnvelopePort,
  });
  self = world;
  return Object.assign(world, {
    scenarios,
    outcomes,
    scenario(agency: { readonly agencyId: string }, scenario: ReportScenario): void {
      scenarios.set(agency.agencyId, scenario);
    },
  });
}
