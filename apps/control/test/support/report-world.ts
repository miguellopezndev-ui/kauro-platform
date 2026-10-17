// The execution world with B13's report stage in the worker (B13 x B08; docs/design/B13-report-delivery.md §6): the world's worker host
// runs ReportingExecutionEnvelope over a core that stages a real Migration Core 3.0.0 acceptance package, so every job of this world
// delivers a package and the PDF report of that package through B08's own steps — staging, read-back, verification, delivery copies,
// publication — on a real PostgreSQL 17.
//
// REAL: the report chain, the attempt's envelope, B08's control plane and store, the PDF engine where a browser exists, and the platform's
// records the report inputs are read from — the validation receipt's manifest hash, the sealed revision's populations and the receipt's
// counts (through the store function the publication itself uses), and the frozen quote's units, terms version and terms hash.
// CONTRACT FAKE — SIMULATED: B07's object storage and the Migration core's staging (an acceptance package replayed through the writer,
// as MigrationCoreAdapter stages one); and the terms snapshot the issuer is read from, branding, privacy class and finding ids, which no
// platform record holds yet (the owner has not provided the issuer's legal identity). The superuser connection is the oracle only.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionEnvelopePort, ExecutionOutcome, HostIo, StagedArtifact } from "@kauro/application";
import type { RowCounts, Sha256Hex } from "@kauro/contracts";
import { ChromiumPdfEngine, ReportingExecutionEnvelope, findChromiumExecutable, type AuthorizedReportInputs, type ReportInputsPort, type ReportRenderConfig, type ReportScope } from "@kauro/data-plane";
import { SIMULATED_ISSUER, simulatedTermsOf } from "@kauro/data-plane/testing";
import type { AgencyId, CorrelationId, ProcessingJobId } from "@kauro/domain";
import { EXECUTION_SERVICES, boundSystem } from "../../src/execution/work.js";
import { ids, startExecutionWorld, type ExecutionWorld, type ReportFixture, type TestClockExecutionUnits } from "./execution-world.js";

export type PackageName = "A-clean-multi-object" | "D-salesforce";
type Engine = ConstructorParameters<typeof ReportingExecutionEnvelope>[0]["engine"];

// compiled to apps/control/dist/test/support: five levels up is the repository root
const FIXTURES = fileURLToPath(new URL("../../../../../packages/reports/test/fixtures/mc-3.0.0/", import.meta.url));

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
    expectedManifestSha256: "69a35b99f6e033d1375ccc0f268adf8d92e09d4c54daf57d2a91a6804bdd985e",
    packageDigest: "37f98cce23e43a71ad24922ade889f877465e40000bcb00b54d875bbc7ff950a",
    files: 30,
    counts: { physicalSourceRows: 19, logicalSourceRecords: 15, billableSourceUnits: 15, associationEdges: 12, emittedRepresentatives: 19, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: 27 },
  },
  "D-salesforce": {
    expectedManifestSha256: "46d9e077930d8dbbf73f934e43d5d6d788423f6683e07307e17adbf7bafb43c4",
    packageDigest: "232f775956d7d61c2c5e38639a2465c4484b58b8a84f7bb23b7461389c1471ce",
    files: 30,
    counts: { physicalSourceRows: 19, logicalSourceRecords: 15, billableSourceUnits: 15, associationEdges: 12, emittedRepresentatives: 15, mergedNonSurvivors: 0, rejected: 0, withheld: 4, unresolved: 0, emittedArtifactRows: 23 },
  },
});

export const TERMS_VERSION = "TERMS-2026-01";
/** The terms snapshot a quote of this world is accepted under (SIMULATED: no platform record holds the issuer's identity yet). */
export const TERMS = simulatedTermsOf(TERMS_VERSION, SIMULATED_ISSUER);

/** The fixture a purchase needs to deliver `name`: the package's counts and manifest hash, and the hash of the terms snapshot. */
export function reportFixtureOf(name: PackageName, overrides: Partial<ReportFixture> = {}): ReportFixture {
  const record = PACKAGE_RECORDS[name];
  return { counts: record.counts, expectedManifestSha256: record.expectedManifestSha256, termsHash: TERMS.termsSha256 as Sha256Hex, ...overrides };
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
    print: async () => new TextEncoder().encode(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${"% filler\n".repeat(40)}trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`),
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

/** The platform's recorded inputs for a job's report, read from the database (see the header for what is real). */
function inputsOf(parts: { readonly units: TestClockExecutionUnits; readonly oracle: ExecutionWorld["h"]["oracle"] }, scenarios: Map<string, ReportScenario>): ReportInputsPort {
  return {
    async read(scope: ReportScope): Promise<AuthorizedReportInputs | null> {
      const agencyId = scope.agencyId as AgencyId;
      const found = await parts.units.run(boundSystem(EXECUTION_SERVICES.JOB_EXECUTION, agencyId, ids.next() as CorrelationId), async (uow) => {
        const job = await uow.execution.getJob(scope.jobId as ProcessingJobId);
        return job === null ? null : { job, countFacts: await uow.execution.deliveryCountFacts(job) };
      });
      const scenario = scenarios.get(scope.agencyId);
      if (found === null) return scenario?.inputs?.(null) ?? null;
      const { job, countFacts } = found;
      const receipt = (await parts.oracle.query<{ artifact_evidence_hash: string }>("SELECT artifact_evidence_hash FROM kauro.validation_receipts WHERE agency_id = $1 AND receipt_hash = $2", [scope.agencyId, job.validationReceiptHash])).rows[0];
      const quote = (
        await parts.oracle.query<{ quote_id: string; billable_units: string; terms_version: string; terms_hash: string }>(
          `SELECT q.quote_id, q.billable_units::text AS billable_units, q.terms_version, q.terms_hash
             FROM kauro.quotes q JOIN kauro.commercial_authorizations a ON a.agency_id = q.agency_id AND a.quote_id = q.quote_id
            WHERE a.agency_id = $1 AND a.authorization_id = $2`,
          [scope.agencyId, job.authorizationId],
        )
      ).rows[0];
      if (receipt === undefined || quote === undefined) return scenario?.inputs?.(null) ?? null;
      const read: AuthorizedReportInputs = {
        evidenceClass: "EXECUTED_LOCAL",
        scope,
        expectedManifestSha256: receipt.artifact_evidence_hash,
        quote: { quoteId: quote.quote_id, billableSourceUnits: Number(quote.billable_units) },
        privacyClass: "SECURE_DETAIL",
        branding: { version: "brand-simulated-1", displayName: "Northwind Data Partners", logo: null },
        logo: null,
        // the platform records the terms' version and hash (the frozen quote); the document they name is the simulated snapshot
        terms: { termsVersion: quote.terms_version, termsSha256: quote.terms_hash, snapshot: TERMS.snapshot },
        countFacts,
        findingIds: ["F-1"],
        materialDecisionIds: ["D-1"],
      };
      return scenario?.inputs === undefined ? read : scenario.inputs(read);
    },
  };
}

export interface ReportWorld extends ExecutionWorld {
  readonly scenarios: Map<string, ReportScenario>;
  /** Registers the scenario of an agency's jobs. */
  scenario(agency: { readonly agencyId: string }, scenario: ReportScenario): void;
}

export const RENDER: ReportRenderConfig = { pageSize: "LETTER", locale: "en-US", rendererVersion: "renderer-1.0.0" };

export async function startReportWorld(tag: string): Promise<ReportWorld> {
  const scenarios = new Map<string, ReportScenario>();
  const world = await startExecutionWorld(tag, {
    envelope: (parts) =>
      ({
        async execute(subject, io): Promise<ExecutionOutcome> {
          const scenario = scenarios.get(subject.agencyId);
          const envelope = new ReportingExecutionEnvelope({
            inner: coreOf(scenarios),
            storage: parts.storage,
            inputs: inputsOf(parts, scenarios),
            engine: scenario?.engine?.() ?? defaultEngine(),
            render: { ...RENDER, rendererVersion: scenario?.rendererVersion ?? RENDER.rendererVersion },
          });
          return envelope.execute(subject, io);
        },
      }) satisfies ExecutionEnvelopePort,
  });
  return Object.assign(world, {
    scenarios,
    scenario(agency: { readonly agencyId: string }, scenario: ReportScenario): void {
      scenarios.set(agency.agencyId, scenario);
    },
  });
}
