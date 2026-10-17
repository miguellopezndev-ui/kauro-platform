// B13 x B08: the report inside an attempt (design docs/design/B13-report-delivery.md). The chain readMigrationPackage ->
// buildReportModel -> generateReportPdf -> stage -> read back, joined to the attempt through ReportingExecutionEnvelope, over the real
// Migration Core 3.0.0 acceptance packages and the attempt's real envelope (scratch store, fenced writer). REAL: the chain, the
// writer, the PDF engine where a browser exists. CONTRACT FAKE — SIMULATED: B07's object storage and the platform's report inputs
// (nothing records the issuer's legal identity yet). The effects asserted are what is in the storage, in the staged manifest and in the
// record, not that a function was called. Needs a Chromium-family browser for the real-engine cases (KAURO_PDF_BROWSER); CI sets
// KAURO_REQUIRE_PDF_ENGINE=1 and a missing browser is then a failure, never a skip.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readStagedManifest, type ObjectStoragePort, type StagedArtifact } from "@kauro/application";
import { generateReportPdf, buildReportModel, readMigrationPackage, type PdfEngine, type ReportPdf } from "@kauro/reports";
import {
  AttemptEnvelopeFailure,
  ChromiumPdfEngine,
  REPORT_PDF_ROLE,
  REPORT_RECORD_ROLE,
  ReportStageError,
  ReportingExecutionEnvelope,
  StagedReportPdfPublisher,
  findChromiumExecutable,
  produceStagedReport,
  readReportPdfRecord,
  reportPdfObjectNameOf,
  readStagedPackage,
  readTermsSnapshot,
  reportIdOf,
  reportPackageIdOf,
  reportPdfRecordBytesOf,
  reportRecordProblems,
  termsSnapshotBytesOf,
  type ReportRenderConfig,
} from "../src/index.js";
import { SIMULATED_ISSUER, SimulatedReportInputs, simulatedReportInputsOf, simulatedTermsOf } from "../src/testing/index.js";
import { collect, manualChannel, v7 } from "./support/attempt.js";
import { acceptanceCore, inputsFor, platformRecordOf, rig, scriptedEngine, scriptedPdf, sha, type Rig } from "./support/report-rig.js";
import { readPdf, squash } from "./support/pdf-reader.js";
import { loadPackage, type CaseName } from "./support/report-fixtures.js";

const browser = findChromiumExecutable(process.env["KAURO_PDF_BROWSER"] ?? null);
const required = process.env["KAURO_REQUIRE_PDF_ENGINE"] === "1";
const evidenceDir = process.env["KAURO_PDF_EVIDENCE_DIR"] ?? null;
const evidence = (name: string, value: unknown): void => {
  if (evidenceDir === null) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
};
const render: ReportRenderConfig = { pageSize: "LETTER", locale: "en-US", rendererVersion: "renderer-1.0.0" };

// The core's own acceptance record for each package (reports/test/support/fixtures.ts ORACLE; the core's acceptance.json and an independent
// implementation of its package digest): the oracle for what the report must say about the package.
const ORACLE: Record<"A-clean-multi-object" | "D-salesforce", { manifestSha256: string; packageDigest: string; files: number }> = {
  "A-clean-multi-object": { manifestSha256: "69a35b99f6e033d1375ccc0f268adf8d92e09d4c54daf57d2a91a6804bdd985e", packageDigest: "37f98cce23e43a71ad24922ade889f877465e40000bcb00b54d875bbc7ff950a", files: 30 },
  "D-salesforce": { manifestSha256: "46d9e077930d8dbbf73f934e43d5d6d788423f6683e07307e17adbf7bafb43c4", packageDigest: "232f775956d7d61c2c5e38639a2465c4484b58b8a84f7bb23b7461389c1471ce", files: 30 },
};
const CLEAN: CaseName = "A-clean-multi-object";
const SALESFORCE: CaseName = "D-salesforce";

let attemptNumber = 100;
const nextRig = (options: Parameters<typeof rig>[1] = {}): Rig => rig(++attemptNumber, options);
const real = (): PdfEngine => new ChromiumPdfEngine({ executablePath: browser as string }, "chromium/test");
/** The real engine where there is a browser; the scripted one otherwise (and a failure where CI requires the browser). */
const engineForFlows = (): PdfEngine => {
  if (browser !== null) return real();
  assert.ok(!required, "KAURO_REQUIRE_PDF_ENGINE=1 but no Chromium-family browser was found (set KAURO_PDF_BROWSER)");
  return scriptedEngine();
};

const envelopeOf = (r: Rig, name: CaseName, inputs: SimulatedReportInputs, engine: PdfEngine, inner = acceptanceCore(name)): ReportingExecutionEnvelope =>
  new ReportingExecutionEnvelope({ inner, storage: r.storage, inputs, engine, render });

const objectsOf = async (r: Rig): Promise<string[]> => (await r.fake.list(r.fake.location("STAGING"), r.fixture.prefix)).objects.map((o) => o.objectName);
const bytesOf = (r: Rig, a: StagedArtifact): Promise<Buffer> => collect(r.fake.read(r.fake.location("STAGING"), a.objectName, a.generation));
const reportObjects = (artifacts: readonly StagedArtifact[]): StagedArtifact[] => artifacts.filter((a) => a.role === REPORT_PDF_ROLE || a.role === REPORT_RECORD_ROLE);

/** Runs the envelope and asserts the attempt ended REFUSED/CANCELLED/FENCED with `code`, nothing of a report staged. */
async function refusedWith(r: Rig, name: CaseName, inputs: SimulatedReportInputs, engine: PdfEngine, code: string, problems: readonly string[] = [], inner = acceptanceCore(name)): Promise<void> {
  const outcome = await envelopeOf(r, name, inputs, engine, inner).execute(r.fixture.subject, r.io);
  assert.equal(outcome.terminalCause, "REFUSED", `${code}: the attempt ends REFUSED`);
  assert.ok(outcome.refusal?.code === `REPORT_${code}`, `${outcome.refusal?.code} is REPORT_${code}`);
  for (const p of problems) assert.ok(outcome.refusal?.message.includes(p), `the refusal names ${p}: ${outcome.refusal?.message}`);
  assert.deepEqual(reportObjects(r.writer.artifacts()), [], `${code}: no report artifact was staged`);
  const names = await objectsOf(r);
  assert.ok(names.every((n) => r.writer.artifacts().some((a) => a.objectName === n)), `${code}: nothing is in the prefix that the writer did not close`);
}

describe("B13xB08 the report joins the attempt: positive flows over the acceptance packages", () => {
  for (const name of [CLEAN, SALESFORCE] as const) {
    it(`${name}: the report is produced, stored, read back, recorded and named by the staged manifest beside the package`, async () => {
      const r = nextRig();
      const inputs = inputsFor(name);
      const engine = engineForFlows();
      const outcome = await envelopeOf(r, name, inputs, engine).execute(r.fixture.subject, r.io);
      assert.equal(outcome.terminalCause, "COMPLETED");
      const pdf = outcome.stagedArtifacts.filter((a) => a.role === REPORT_PDF_ROLE);
      const record = outcome.stagedArtifacts.filter((a) => a.role === REPORT_RECORD_ROLE);
      assert.equal(pdf.length, 1, "one PDF");
      assert.equal(record.length, 1, "one record");
      assert.equal(outcome.stagedArtifacts.length, ORACLE[name].files + 2, "the package's files and the report's two");
      assert.deepEqual(
        [...outcome.stagedArtifacts].map((a) => a.objectName).sort(),
        r.writer.artifacts().map((a) => a.objectName).sort(),
        "what the core answered is exactly what the writer closed",
      );

      // the attempt's manifest names the report with the package, and the control plane's reader accepts it
      const reference = await r.writer.writeManifest({ fence: 1, inputBindingHash: r.fixture.subject.inputBindingHash, declaredSummary: outcome.reconciliationSummary });
      const staging = r.fake.location("STAGING");
      const manifest = readStagedManifest(await collect(r.fake.read(staging, reference.objectName, reference.generation)), {
        jobId: r.fixture.jobId,
        attemptId: r.fixture.attemptId,
        fence: 1,
        inputBindingHash: r.fixture.subject.inputBindingHash,
        stagingPrefix: r.fixture.prefix,
        manifestObjectName: r.fixture.capability.manifestObjectName,
      });
      assert.ok(manifest.ok, "the staged manifest is this attempt's");
      assert.equal(manifest.payload.artifacts.filter((a) => a.role === REPORT_PDF_ROLE || a.role === REPORT_RECORD_ROLE).length, 2);

      // the stored bytes, read from the storage by their generation, are the PDF the identity describes
      const bytes = await bytesOf(r, pdf[0] as StagedArtifact);
      assert.equal(sha(bytes), (pdf[0] as StagedArtifact).sha256);
      assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
      const recordBytes = await bytesOf(r, record[0] as StagedArtifact);
      assert.deepEqual(reportRecordProblems(recordBytes, bytes, r.scope), [], "the record names exactly these bytes and this scope");
      const read = readReportPdfRecord(recordBytes);
      assert.ok(read.ok);
      const id = read.record.identity;
      assert.equal(id.pdfSha256, sha(bytes));
      assert.equal(id.byteLength, bytes.byteLength);
      assert.equal(id.reportId, reportIdOf(r.scope));
      assert.equal(id.packageId, reportPackageIdOf(r.scope));
      assert.equal(id.manifestSha256, ORACLE[name].manifestSha256, "the core's own manifest hash");
      assert.equal(id.packageDigest, ORACLE[name].packageDigest, "the core's own package digest");
      assert.equal(read.record.stage, "STAGED_VERIFIED", "stored and verified; delivery is B08's");
      assert.deepEqual(read.record.scope, r.scope);
      assert.equal(read.record.pdf.objectName, (pdf[0] as StagedArtifact).objectName);
      assert.equal(read.record.pdf.generation, (pdf[0] as StagedArtifact).generation);
      // one generation each: nothing was written twice
      assert.equal(r.fake.generationsOf(staging, (pdf[0] as StagedArtifact).objectName).length, 1);
      assert.equal(r.fake.generationsOf(staging, (record[0] as StagedArtifact).objectName).length, 1);

      // the bytes the model was hashed from are the ones the report says: an independent build over the same inputs gives the same modelHash
      const files = await readStagedPackage(r.storage, outcome.stagedArtifacts.filter((a) => !reportObjects([a]).length));
      assert.equal(files.size, ORACLE[name].files);

      if (browser !== null) {
        const text = squash((await readPdf(bytes)).pages.map((p) => p.text).join(" "));
        assert.ok(text.includes(ORACLE[name].packageDigest) && text.includes(ORACLE[name].manifestSha256), "the printed report carries the core's references");
        assert.ok(text.includes(squash(SIMULATED_ISSUER.legalName)), "the issuer printed is the terms snapshot's");
        evidence(`delivery-${name}.json`, { name, engineId: id.engineId, pdfSha256: id.pdfSha256, byteLength: id.byteLength, modelHash: id.modelHash, htmlSha256: id.htmlSha256, packageDigest: id.packageDigest, manifestSha256: id.manifestSha256, reportId: id.reportId, packageId: id.packageId });
        if (evidenceDir !== null) writeFileSync(join(evidenceDir, `delivery-${name}.pdf`), bytes);
      }
    });
  }

  it("the model is BOUND to the platform's counts, the issuer is the terms snapshot's and never the brand's, and the terms hash is the snapshot's", async () => {
    const r = nextRig();
    const inputs = inputsFor(CLEAN, { branding: { version: "brand-9", displayName: "Impostor Legal Holdings Ltd", logo: null } });
    // a staged package the chain reads, without going through the envelope
    const core = await acceptanceCore(CLEAN).execute(r.fixture.subject, r.io);
    const files = await readStagedPackage(r.storage, core.stagedArtifacts);
    const produced = await produceStagedReport({ files, scope: r.scope, writer: r.writer, storage: r.storage, inputs, engine: scriptedEngine(), render, cancellation: r.channel });
    const model = produced.report.model;
    assert.equal(produced.report.countsBinding, "BOUND");
    assert.equal(model.countsBinding, "BOUND");
    assert.equal(model.issuer.legalName, SIMULATED_ISSUER.legalName);
    assert.notEqual(model.issuer.legalName, model.branding.displayName);
    const snapshot = termsSnapshotBytesOf(model.termsVersion, SIMULATED_ISSUER);
    assert.equal(model.termsSha256, sha(snapshot));
    assert.equal(produced.staged.stage, "STAGED_VERIFIED");
    assert.equal(produced.staged.identity.modelHash, produced.report.modelHash);
  });
});

describe("B13xB08 the platform's facts: nothing is invented, nothing unbound is delivered", () => {
  it("a package other than the one the platform's receipt bound is refused: no PDF, no engine call", async () => {
    const r = nextRig();
    const engine = scriptedEngine();
    await refusedWith(r, CLEAN, inputsFor(CLEAN, { expectedManifestSha256: platformRecordOf(SALESFORCE).expectedManifestSha256 }), engine, "MODEL_REFUSED", ["PACKAGE_BINDING_MISMATCH"]);
    assert.equal(engine.calls, 0);
  });

  it("a package that does not verify (a file missing, a file the manifest does not claim) is refused before any model exists", async () => {
    for (const [label, inner, problem] of [
      ["a file the core did not stage", acceptanceCore(CLEAN, { drop: (p) => p === "01_IMPORT/clean-only/contacts.csv" }), "ARTIFACT_MISSING"],
      ["a file no manifest entry claims", acceptanceCore(CLEAN, { extra: { "01_IMPORT/unclaimed.csv": new TextEncoder().encode("a,b\n1,2\n") } }), "claimed by no manifest entry"],
    ] as const) {
      const r = nextRig();
      const engine = scriptedEngine();
      await refusedWith(r, CLEAN, inputsFor(CLEAN), engine, "PACKAGE_UNREADABLE", [], inner);
      assert.equal(engine.calls, 0, label);
      void problem;
    }
  });

  it("counts that are inconsistent or lack their evidence are refused, never printed as UNBOUND", async () => {
    const record = platformRecordOf(CLEAN);
    const populations = (c: typeof record.counts) => ({ physicalSourceRows: c.physicalSourceRows, logicalSourceRecords: c.logicalSourceRecords, billableSourceUnits: c.billableSourceUnits, associationEdges: c.associationEdges });
    const cases: ReadonlyArray<readonly [string, Parameters<typeof simulatedReportInputsOf>[2], string, readonly string[]]> = [
      ["no populations or receipt counts at all", { countFacts: null }, "COUNTS_UNAVAILABLE", []],
      ["the receipt misses a count", { countFacts: { populations: populations(record.counts), receiptCounts: { physicalSourceRows: 1 } } }, "COUNTS_UNAVAILABLE", []],
      ["the receipt disagrees with the sealed populations", { countFacts: { populations: populations(record.counts), receiptCounts: { ...record.counts, physicalSourceRows: record.counts.physicalSourceRows - 1 } } }, "COUNTS_MISMATCH", []],
      ["the receipt leaves decisions unresolved", { countFacts: { populations: populations(record.counts), receiptCounts: { ...record.counts, unresolved: 2 } } }, "COUNTS_UNRESOLVED", []],
      [
        "populations and receipt agree with each other but not with the package's bytes",
        { countFacts: { populations: { ...populations(record.counts), physicalSourceRows: 20 }, receiptCounts: { ...record.counts, physicalSourceRows: 20 } } },
        "MODEL_REFUSED",
        ["DECLARED_COUNTS_MISMATCH"],
      ],
      ["the frozen quote differs from the sealed billable units", { quote: { quoteId: "q-x", billableSourceUnits: record.counts.billableSourceUnits + 1 } }, "MODEL_REFUSED", ["DECLARED_COUNTS_MISMATCH"]],
    ];
    for (const [label, overrides, code, problems] of cases) {
      const r = nextRig();
      const engine = scriptedEngine();
      await refusedWith(r, CLEAN, inputsFor(CLEAN, {}, overrides), engine, code, problems);
      assert.equal(engine.calls, 0, label);
    }
  });

  it("an issuer or terms that cannot be verified are refused: absent, altered, of another version, spelled another way, or unsafe", async () => {
    const good = termsSnapshotBytesOf("terms-simulated-1", SIMULATED_ISSUER);
    const flipped = Uint8Array.from(good);
    flipped[flipped.length - 10] = (flipped[flipped.length - 10] as number) ^ 1;
    const respelled = new TextEncoder().encode(`${Buffer.from(good).toString("utf8").replace('"version":1', '"version": 1')}`);
    const cases: ReadonlyArray<readonly [string, Parameters<typeof simulatedReportInputsOf>[2], string]> = [
      ["no terms snapshot", { terms: null }, "TERMS_UNAVAILABLE"],
      ["a snapshot altered after it was made", { terms: { termsVersion: "terms-simulated-1", termsSha256: sha(good), snapshot: flipped } }, "TERMS_UNVERIFIABLE"],
      ["a snapshot of another terms version than the platform names", { terms: { termsVersion: "terms-simulated-2", termsSha256: sha(good), snapshot: good } }, "TERMS_UNVERIFIABLE"],
      ["a snapshot spelled differently from its canonical form", { terms: { termsVersion: "terms-simulated-1", termsSha256: sha(respelled), snapshot: respelled } }, "TERMS_UNVERIFIABLE"],
      ["a recorded hash that is not the snapshot's (the platform recorded other terms)", { terms: { termsVersion: "terms-simulated-1", termsSha256: "5".repeat(64), snapshot: good } }, "TERMS_UNVERIFIABLE"],
      ["bytes that are no snapshot", { terms: { termsVersion: "terms-simulated-1", termsSha256: sha("Kauro Data S.A.S."), snapshot: new TextEncoder().encode("Kauro Data S.A.S.") } }, "TERMS_UNVERIFIABLE"],
      ["an issuer whose name carries markup", { terms: simulatedTermsOf("terms-simulated-1", { ...SIMULATED_ISSUER, legalName: "<b>Issuer</b>" }) }, "MODEL_REFUSED"],
    ];
    for (const [label, overrides, code] of cases) {
      const r = nextRig();
      const engine = scriptedEngine();
      await refusedWith(r, CLEAN, inputsFor(CLEAN, {}, overrides), engine, code);
      assert.equal(engine.calls, 0, label);
    }
    assert.ok(readTermsSnapshot(good).ok);
    assert.ok(!readTermsSnapshot(flipped).ok || (readTermsSnapshot(flipped) as { sha256?: string }).sha256 !== sha(good), "an altered snapshot does not read as the same terms");
  });

  it("inputs the platform read for another agency, project, job or attempt are refused", async () => {
    const other = nextRig();
    // every attempt of these rigs shares one agency and one project; the foreign ones are named outright
    const foreign = { agencyId: v7(1500), projectId: v7(1998), jobId: other.scope.jobId, attemptId: other.scope.attemptId };
    for (const key of ["agencyId", "projectId", "jobId", "attemptId"] as const) {
      const r = nextRig();
      const inputs = new SimulatedReportInputs((scope) => simulatedReportInputsOf({ ...scope, [key]: foreign[key] }, platformRecordOf(CLEAN)));
      await refusedWith(r, CLEAN, inputs, scriptedEngine(), "FACTS_FOREIGN_SCOPE");
    }
    const nothing = nextRig();
    await refusedWith(nothing, CLEAN, new SimulatedReportInputs(() => null), scriptedEngine(), "FACTS_UNAVAILABLE");
  });

  it("an infrastructure failure reading the inputs is not a refusal: it propagates, and nothing of the report is staged", async () => {
    const r = nextRig();
    const inputs = new SimulatedReportInputs(() => Promise.reject(new Error("database unavailable")));
    await assert.rejects(envelopeOf(r, CLEAN, inputs, scriptedEngine()).execute(r.fixture.subject, r.io), /database unavailable/);
    assert.deepEqual(reportObjects(r.writer.artifacts()), []);
  });
});

describe("B13xB08 the PDF: a failed or invalid generation stages nothing", () => {
  it("an engine that fails, returns garbage or returns a truncated PDF ends the attempt REFUSED with no report object", async () => {
    const truncated = scriptedPdf("t").subarray(0, 120);
    const engines: ReadonlyArray<readonly [string, ReturnType<typeof scriptedEngine>]> = [
      ["throws", scriptedEngine(() => Promise.reject(new Error("browser crashed")))],
      ["throws a non-Error", scriptedEngine(() => Promise.reject("boom"))],
      ["html instead of a pdf", scriptedEngine(() => new TextEncoder().encode("<html>not a pdf</html>".repeat(30)))],
      ["a pdf without its trailer", scriptedEngine(() => new TextEncoder().encode(`%PDF-1.7\n${"x".repeat(400)}`))],
      ["a truncated pdf", scriptedEngine(() => truncated)],
      ["nothing", scriptedEngine(() => new Uint8Array(0))],
    ];
    for (const [label, engine] of engines) {
      const r = nextRig();
      await refusedWith(r, CLEAN, inputsFor(CLEAN), engine, "PDF_FAILED");
      assert.equal(engine.calls, 1, label);
    }
  });

  it("a ReportPdf is only what generateReportPdf returned, and only while its bytes still hash to its identity", async () => {
    const r = nextRig();
    const core = await acceptanceCore(CLEAN).execute(r.fixture.subject, r.io);
    const files = await readStagedPackage(r.storage, core.stagedArtifacts);
    const inputs = inputsFor(CLEAN);
    const facts = await inputs.read(r.scope);
    assert.ok(facts !== null);
    const report = buildReportModel(readMigrationPackage(files), {
      reportId: reportIdOf(r.scope),
      packageId: reportPackageIdOf(r.scope),
      expectedManifestSha256: facts.expectedManifestSha256,
      privacyClass: "SECURE_DETAIL",
      billableSourceUnits: facts.quote.billableSourceUnits,
      quoteId: facts.quote.quoteId,
      branding: facts.branding,
      termsVersion: "terms-simulated-1",
      termsSha256: sha(termsSnapshotBytesOf("terms-simulated-1", SIMULATED_ISSUER)),
      issuer: SIMULATED_ISSUER,
      findingIds: [],
      materialDecisionIds: [],
      rendererVersion: render.rendererVersion,
      declaredCounts: platformRecordOf(CLEAN).counts,
    });
    const publisher = new StagedReportPdfPublisher({
      writer: r.writer,
      storage: r.storage,
      scope: r.scope,
      binding: { reportId: reportIdOf(r.scope), packageId: reportPackageIdOf(r.scope), packageDigest: report.model.package.packageDigest, manifestSha256: report.model.package.manifestSha256, modelHash: report.modelHash },
    });
    const pdf = await generateReportPdf(report, { pageSize: "LETTER", locale: "en-US", logo: null }, scriptedEngine());
    // a look-alike with the right fields
    await assert.rejects(publisher.publish({ ...pdf } as ReportPdf), (e: unknown) => e instanceof ReportStageError && e.code === "PDF_NOT_GENUINE");
    // the identity is frozen; the bytes are not, and changing them is caught by the hash
    assert.throws(() => {
      (pdf.identity as { pdfSha256: string }).pdfSha256 = "0".repeat(64);
    }, TypeError);
    const changed = Uint8Array.from(pdf.bytes);
    const tampered: ReportPdf = Object.freeze({ ...pdf, bytes: changed });
    await assert.rejects(publisher.publish(tampered), (e: unknown) => e instanceof ReportStageError && e.code === "PDF_NOT_GENUINE", "an unregistered copy is refused");
    (pdf.bytes as Uint8Array)[40] = (pdf.bytes[40] as number) ^ 1;
    await assert.rejects(publisher.publish(pdf), (e: unknown) => e instanceof ReportStageError && e.code === "PDF_NOT_GENUINE" && e.problems.includes("HASH_DIFFERS"), "bytes changed after generation are not stored as the report");
    assert.deepEqual(reportObjects(r.writer.artifacts()), []);
  });
});

/** A storage whose reads of the objects named by `pick` come back as `alter` makes them; everything else is the fake's. */
function readsAltered(fake: Rig["fake"], pick: (objectName: string) => boolean, alter: (bytes: Buffer) => Buffer | Error): ObjectStoragePort {
  return new Proxy(fake, {
    get(target, prop) {
      if (prop === "read") {
        return (location: Parameters<ObjectStoragePort["read"]>[0], objectName: string, generation: string): AsyncIterable<Uint8Array> => {
          const inner = target.read(location, objectName, generation);
          if (!pick(objectName)) return inner;
          return (async function* () {
            const altered = alter(await collect(inner));
            if (altered instanceof Error) throw altered;
            yield altered;
          })();
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as ObjectStoragePort;
}

/** A storage failing (or running `act` before) the n-th createResumableSession; everything else is the fake's. */
function sessionsFailingAt(fake: Rig["fake"], n: number, act: () => void | Error): ObjectStoragePort {
  let calls = 0;
  return new Proxy(fake, {
    get(target, prop) {
      if (prop === "createResumableSession") {
        return (...args: Parameters<ObjectStoragePort["createResumableSession"]>) => {
          calls += 1;
          if (calls === n) {
            const fault = act();
            if (fault instanceof Error) return Promise.reject(fault);
          }
          return target.createResumableSession(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as ObjectStoragePort;
}

/** The attempt after the core staged its package: the report chain's inputs, ready to run `produceStagedReport` again and again. */
async function afterCore(r: Rig, name: CaseName = CLEAN): Promise<{ files: Map<string, Uint8Array>; staged: readonly StagedArtifact[] }> {
  const core = await acceptanceCore(name).execute(r.fixture.subject, r.io);
  return { files: await readStagedPackage(r.fake, core.stagedArtifacts), staged: core.stagedArtifacts };
}

const chain = (r: Rig, files: Map<string, Uint8Array>, engine: PdfEngine, storage: ObjectStoragePort = r.storage, inputs = inputsFor(CLEAN)) =>
  produceStagedReport({ files, scope: r.scope, writer: r.writer, storage, inputs, engine, render, cancellation: r.channel });

describe("B13xB08 stored bytes: what is recorded was read back from the storage and is the generated PDF", () => {
  const isPdf = (name: string) => name.length > 0;
  it("a read-back that is truncated, altered or another report's PDF is refused: the record is never made", async () => {
    const other = scriptedPdf("other-attempt");
    const cases: ReadonlyArray<readonly [string, (b: Buffer) => Buffer]> = [
      ["truncated", (b) => b.subarray(0, b.length - 40)],
      ["altered", (b) => Buffer.from(b.map((v, i) => (i === 60 ? v ^ 1 : v)))],
      ["extended", (b) => Buffer.concat([b, Buffer.from("trailing")])],
      ["another report's pdf", () => Buffer.from(other)],
      ["empty", () => Buffer.alloc(0)],
    ];
    for (const [label, alter] of cases) {
      const r = nextRig();
      const { files } = await afterCore(r);
      const pdfNameOf = () => r.writer.artifacts().find((a) => a.role === REPORT_PDF_ROLE)?.objectName;
      const storage = readsAltered(r.fake, (name) => name === pdfNameOf(), alter);
      await assert.rejects(chain(r, files, scriptedEngine(), storage), (e: unknown) => e instanceof ReportStageError && e.code === "STORED_BYTES_DIFFER", label);
      // the PDF stays where it was written (evidence); no record was made and a record cannot be reached through it
      assert.equal(r.writer.artifacts().filter((a) => a.role === REPORT_PDF_ROLE).length, 1, `${label}: the stored PDF is kept as evidence`);
      assert.equal(r.writer.artifacts().filter((a) => a.role === REPORT_RECORD_ROLE).length, 0, `${label}: no record without a verified PDF`);
      void isPdf;
    }
  });

  it("a stored object replaced behind the writer (another generation under the name) is refused", async () => {
    const r = nextRig();
    const { files } = await afterCore(r);
    const staging = r.fake.location("STAGING");
    const storage = new Proxy(r.fake, {
      get(target, prop) {
        if (prop === "stat") {
          return async (location: Parameters<ObjectStoragePort["stat"]>[0], objectName: string) => {
            const pdf = r.writer.artifacts().find((a) => a.role === REPORT_PDF_ROLE);
            if (pdf !== undefined && pdf.objectName === objectName) target.plantObject(staging, objectName, Buffer.from("replaced"), { overwrite: true });
            return target.stat(location, objectName);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as ObjectStoragePort;
    await assert.rejects(chain(r, files, scriptedEngine(), storage), (e: unknown) => e instanceof ReportStageError && e.code === "STORED_BYTES_DIFFER");
    assert.equal(r.writer.artifacts().filter((a) => a.role === REPORT_RECORD_ROLE).length, 0);
  });

  it("an uncertain read-back keeps the stored PDF, records nothing, and the same PDF published again completes without a second copy", async () => {
    const r = nextRig();
    const { files } = await afterCore(r);
    let failing = true;
    const storage = readsAltered(r.fake, (name) => failing && r.writer.artifacts().some((a) => a.role === REPORT_PDF_ROLE && a.objectName === name), () => Object.assign(new Error("socket closed"), { transient: true }));
    const engine = scriptedEngine();
    await assert.rejects(chain(r, files, engine, storage), (e: unknown) => e instanceof ReportStageError && e.code === "VERIFICATION_UNCERTAIN");
    const first = r.writer.artifacts().filter((a) => a.role === REPORT_PDF_ROLE);
    assert.equal(first.length, 1, "kept");
    assert.equal(r.writer.artifacts().filter((a) => a.role === REPORT_RECORD_ROLE).length, 0, "nothing recorded on an uncertain result");
    // the retry (a deterministic engine gives the same bytes) finds the artifact the writer closed, verifies it, and records once
    failing = false;
    const again = await chain(r, files, engine, storage);
    assert.equal(again.staged.pdf.objectName, (first[0] as StagedArtifact).objectName);
    assert.equal(again.staged.pdf.generation, (first[0] as StagedArtifact).generation);
    assert.equal(r.fake.generationsOf(r.fake.location("STAGING"), (first[0] as StagedArtifact).objectName).length, 1, "no second generation");
    assert.equal(r.writer.artifacts().filter((a) => a.role === REPORT_RECORD_ROLE).length, 1);
  });

  it("an interrupted upload (the provider received less than was sent) is a terminal SHORT_WRITE: no PDF generation exists, no record, no manifest", async () => {
    let finals = 0;
    const r = nextRig({
      rewrite: (chunk, final) => {
        if (!final) return chunk;
        finals += 1;
        return finals === ORACLE[CLEAN].files + 1 ? chunk.subarray(0, chunk.length - 7) : chunk; // the report's PDF is the first object after the package
      },
    });
    const { files } = await afterCore(r);
    await assert.rejects(chain(r, files, scriptedEngine()), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.terminalCause === "SHORT_WRITE");
    assert.equal(reportObjects(r.writer.artifacts()).length, 0);
    assert.deepEqual((await objectsOf(r)).length, ORACLE[CLEAN].files, "the interrupted object does not exist in the storage");
    await assert.rejects(r.writer.writeManifest({ fence: 1, inputBindingHash: r.fixture.subject.inputBindingHash, declaredSummary: null }), (e: unknown) => e instanceof AttemptEnvelopeFailure, "the writer is spent: no manifest names a package without its report");
  });
});

describe("B13xB08 duplicates and retries are idempotent", () => {
  async function ready(r: Rig) {
    const { files } = await afterCore(r);
    const inputs = inputsFor(CLEAN);
    const facts = (await inputs.read(r.scope)) as NonNullable<Awaited<ReturnType<typeof inputs.read>>>;
    const report = buildReportModel(readMigrationPackage(files), {
      reportId: reportIdOf(r.scope),
      packageId: reportPackageIdOf(r.scope),
      expectedManifestSha256: facts.expectedManifestSha256,
      privacyClass: "SECURE_DETAIL",
      billableSourceUnits: facts.quote.billableSourceUnits,
      quoteId: facts.quote.quoteId,
      branding: facts.branding,
      termsVersion: "terms-simulated-1",
      termsSha256: sha(termsSnapshotBytesOf("terms-simulated-1", SIMULATED_ISSUER)),
      issuer: SIMULATED_ISSUER,
      findingIds: [],
      materialDecisionIds: [],
      rendererVersion: render.rendererVersion,
      declaredCounts: platformRecordOf(CLEAN).counts,
    });
    const make = (salt: string) => generateReportPdf(report, { pageSize: "LETTER", locale: "en-US", logo: null }, scriptedEngine(() => scriptedPdf(salt)));
    const publisher = () =>
      new StagedReportPdfPublisher({
        writer: r.writer,
        storage: r.storage,
        scope: r.scope,
        binding: { reportId: reportIdOf(r.scope), packageId: reportPackageIdOf(r.scope), packageDigest: report.model.package.packageDigest, manifestSha256: report.model.package.manifestSha256, modelHash: report.modelHash },
      });
    return { report, make, publisher };
  }

  it("the same PDF published again, or three times at once, is one stored PDF and one record; a lost answer is answered again identically", async () => {
    const r = nextRig();
    const { make, publisher } = await ready(r);
    const pdf = await make("one");
    const p = publisher();
    const [a, b, c] = await Promise.all([p.publish(pdf), p.publish(pdf), p.publish(pdf)]);
    assert.deepEqual([b.location, c.location], [a.location, a.location]);
    const lostAnswer = await p.publish(pdf);
    assert.deepEqual(lostAnswer, a);
    // a second publisher over the same attempt (the caller restarted its object) finds what the writer already closed
    const restarted = await publisher().publish(pdf);
    assert.deepEqual(restarted.pdf, a.pdf);
    assert.deepEqual(restarted.record, a.record);
    const staging = r.fake.location("STAGING");
    assert.equal(r.fake.generationsOf(staging, a.pdf.objectName).length, 1);
    assert.equal(r.fake.generationsOf(staging, a.record.objectName).length, 1);
    assert.equal(reportObjects(r.writer.artifacts()).length, 2);
    assert.equal(r.fake.calls("createResumableSession").filter((c2) => [a.pdf.objectName, a.record.objectName].includes(String(c2.request["objectName"]))).length, 2, "two sessions in all: one per object");
  });

  it("another PDF for an attempt that already staged one is refused: a corrected report is another attempt's artifact", async () => {
    const r = nextRig();
    const { make, publisher } = await ready(r);
    const first = await publisher().publish(await make("one"));
    await assert.rejects(publisher().publish(await make("two")), (e: unknown) => e instanceof ReportStageError && e.code === "REPORT_ALREADY_STAGED");
    assert.equal(reportObjects(r.writer.artifacts()).length, 2);
    const staging = r.fake.location("STAGING");
    assert.equal(sha(await collect(r.fake.read(staging, first.pdf.objectName, first.pdf.generation))), first.pdf.sha256, "the first is untouched");
  });

  it("an object this writer did not write under the PDF's name is left as it is and the PDF is refused", async () => {
    const r = nextRig();
    const { make, publisher } = await ready(r);
    const pdf = await make("planted");
    const name = reportPdfObjectNameOf(r.fixture.prefix, reportIdOf(r.scope), pdf.identity.pdfSha256);
    const staging = r.fake.location("STAGING");
    const planted = r.fake.plantObject(staging, name, Buffer.from("planted by someone else"));
    await assert.rejects(publisher().publish(pdf), (e: unknown) => e instanceof ReportStageError && e.code === "OBJECT_NOT_THIS_WRITERS");
    const [only] = r.fake.generationsOf(staging, name);
    assert.deepEqual([r.fake.generationsOf(staging, name).length, only?.generation], [1, planted.generation], "the planted generation is the only one and was not replaced");
    assert.equal(reportObjects(r.writer.artifacts()).length, 0);
  });
});

/** The report model of `r`'s attempt over the CLEAN package, built the way the chain builds it (an independent assembly of the facts). */
async function modelFor(r: Rig, scope = r.scope, overrides: { rendererVersion?: string } = {}) {
  const { files } = await afterCore(r);
  const facts = (await inputsFor(CLEAN).read(scope)) as NonNullable<Awaited<ReturnType<SimulatedReportInputs["read"]>>>;
  return buildReportModel(readMigrationPackage(files), {
    reportId: reportIdOf(scope),
    packageId: reportPackageIdOf(scope),
    expectedManifestSha256: facts.expectedManifestSha256,
    privacyClass: "SECURE_DETAIL",
    billableSourceUnits: facts.quote.billableSourceUnits,
    quoteId: facts.quote.quoteId,
    branding: facts.branding,
    termsVersion: "terms-simulated-1",
    termsSha256: sha(termsSnapshotBytesOf("terms-simulated-1", SIMULATED_ISSUER)),
    issuer: SIMULATED_ISSUER,
    findingIds: [],
    materialDecisionIds: [],
    rendererVersion: overrides.rendererVersion ?? render.rendererVersion,
    declaredCounts: platformRecordOf(CLEAN).counts,
  });
}

describe("B13xB08 the report is this agency's, this project's, this job's and this attempt's", () => {
  it("a publisher or a chain of another scope is refused before anything is written", async () => {
    const r = nextRig();
    const other = nextRig({ agency: 1500 });
    const foreign = { ...other.scope, projectId: v7(1998) };
    const { files } = await afterCore(r);
    const binding = { reportId: "rpt-x", packageId: "pkg-x", packageDigest: "1".repeat(64), manifestSha256: "2".repeat(64), modelHash: "3".repeat(64) };
    for (const key of ["agencyId", "projectId", "jobId", "attemptId"] as const) {
      assert.throws(
        () => new StagedReportPdfPublisher({ writer: r.writer, storage: r.storage, scope: { ...r.scope, [key]: foreign[key] }, binding }),
        (e: unknown) => e instanceof ReportStageError && e.code === "SCOPE_FOREIGN",
        key,
      );
    }
    await assert.rejects(
      produceStagedReport({ files, scope: foreign, writer: r.writer, storage: r.storage, inputs: inputsFor(CLEAN), engine: scriptedEngine(), render, cancellation: r.channel }),
      (e: unknown) => e instanceof ReportStageError && e.code === "SCOPE_FOREIGN",
    );
    assert.deepEqual(reportObjects(r.writer.artifacts()), []);
  });

  it("a PDF generated for another attempt's report is not this attempt's report", async () => {
    const mine = nextRig();
    const theirs = nextRig({ job: 4242 });
    const report = await modelFor(mine, theirs.scope);
    const pdfOfTheirs = await generateReportPdf(report, { pageSize: "LETTER", locale: "en-US", logo: null }, scriptedEngine());
    const own = await modelFor(nextRig(), mine.scope);
    const publisher = new StagedReportPdfPublisher({
      writer: mine.writer,
      storage: mine.storage,
      scope: mine.scope,
      binding: { reportId: reportIdOf(mine.scope), packageId: reportPackageIdOf(mine.scope), packageDigest: own.model.package.packageDigest, manifestSha256: own.model.package.manifestSha256, modelHash: own.modelHash },
    });
    await assert.rejects(publisher.publish(pdfOfTheirs), (e: unknown) => e instanceof ReportStageError && e.code === "IDENTITY_FOREIGN");
    assert.deepEqual(reportObjects(mine.writer.artifacts()), []);
  });
});

describe("B13xB08 a stale or cancelled attempt stages no report", () => {
  it("fenced after the core staged: the attempt ends FENCED before the engine runs, nothing of the report exists", async () => {
    const r = nextRig();
    const engine = scriptedEngine();
    const core = acceptanceCore(CLEAN);
    const fencing = {
      execute: async (s: Parameters<typeof core.execute>[0], io: Parameters<typeof core.execute>[1]) => {
        const o = await core.execute(s, io);
        r.channel.state = "FENCED";
        return o;
      },
    };
    const outcome = await envelopeOf(r, CLEAN, inputsFor(CLEAN), engine, fencing).execute(r.fixture.subject, r.io);
    assert.equal(outcome.terminalCause, "FENCED");
    assert.equal(engine.calls, 0);
    assert.deepEqual(reportObjects(r.writer.artifacts()), []);
  });

  it("cancelled while the PDF is being printed: the attempt ends CANCELLED and the printed bytes are never stored", async () => {
    const r = nextRig();
    const engine = scriptedEngine(() => {
      r.channel.state = "CANCELLED";
      return scriptedPdf("late");
    });
    const outcome = await envelopeOf(r, CLEAN, inputsFor(CLEAN), engine).execute(r.fixture.subject, r.io);
    assert.equal(outcome.terminalCause, "CANCELLED");
    assert.equal(engine.calls, 1);
    assert.deepEqual(reportObjects(r.writer.artifacts()), []);
    assert.equal((await objectsOf(r)).length, ORACLE[CLEAN].files);
  });

  it("fenced inside the upload itself: the writer's own check stops the PDF before its last chunk; no generation, no record", async () => {
    const channel = manualChannel();
    const r = nextRig({ channel, wrap: (fake) => sessionsFailingAt(fake, ORACLE[CLEAN].files + 1, () => void (channel.state = "FENCED")) });
    const { files } = await afterCore(r);
    await assert.rejects(chain(r, files, scriptedEngine()), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.terminalCause === "FENCED");
    assert.equal(reportObjects(r.writer.artifacts()).length, 0);
    assert.equal((await objectsOf(r)).length, ORACLE[CLEAN].files);
  });
});

describe("B13xB08 a crash at each step leaves no partial report", () => {
  it("storing the PDF fails: no PDF object, no record; storing the record fails: the verified PDF stays as evidence, no record, no manifest", async () => {
    const pdfFails = nextRig({ wrap: (fake) => sessionsFailingAt(fake, ORACLE[CLEAN].files + 1, () => new Error("storage down")) });
    const a = await afterCore(pdfFails);
    await assert.rejects(chain(pdfFails, a.files, scriptedEngine()), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.terminalCause === "ARTIFACT_CLOSE_FAILED");
    assert.equal(reportObjects(pdfFails.writer.artifacts()).length, 0);
    assert.equal((await objectsOf(pdfFails)).length, ORACLE[CLEAN].files);

    const recordFails = nextRig({ wrap: (fake) => sessionsFailingAt(fake, ORACLE[CLEAN].files + 2, () => new Error("storage down")) });
    const b = await afterCore(recordFails);
    await assert.rejects(chain(recordFails, b.files, scriptedEngine()), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.terminalCause === "ARTIFACT_CLOSE_FAILED");
    assert.equal(recordFails.writer.artifacts().filter((x) => x.role === REPORT_PDF_ROLE).length, 1, "the PDF that was verified stays");
    assert.equal(recordFails.writer.artifacts().filter((x) => x.role === REPORT_RECORD_ROLE).length, 0);
    await assert.rejects(recordFails.writer.writeManifest({ fence: 1, inputBindingHash: recordFails.fixture.subject.inputBindingHash, declaredSummary: null }), AttemptEnvelopeFailure);
  });

  it("the storage will not say whether the PDF's name is free: the report is not stored on a guess", async () => {
    const r = nextRig();
    const { files } = await afterCore(r);
    const storage = new Proxy(r.fake, {
      get(target, prop) {
        if (prop === "stat") return () => Promise.reject(new Error("timeout"));
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as ObjectStoragePort;
    await assert.rejects(chain(r, files, scriptedEngine(), storage), (e: unknown) => e instanceof ReportStageError && e.code === "VERIFICATION_UNCERTAIN");
    assert.deepEqual(reportObjects(r.writer.artifacts()), []);
  });
});

describe("B13xB08 a corrected report is another artifact: the delivered one is kept", () => {
  it("a second attempt with a corrected renderer version stages its own PDF under its own prefix; the first PDF, record and generations are untouched", async () => {
    const fake = rig(7000).fake;
    const first = rig(7001, { fake, job: 7001 });
    const second = rig(7002, { fake, job: 7002 });
    const make = async (r: Rig, rendererVersion: string) => {
      const env = new ReportingExecutionEnvelope({ inner: acceptanceCore(CLEAN), storage: r.storage, inputs: inputsFor(CLEAN), engine: engineForFlows(), render: { ...render, rendererVersion } });
      const outcome = await env.execute(r.fixture.subject, r.io);
      assert.equal(outcome.terminalCause, "COMPLETED");
      const pdf = outcome.stagedArtifacts.find((a) => a.role === REPORT_PDF_ROLE) as StagedArtifact;
      const record = outcome.stagedArtifacts.find((a) => a.role === REPORT_RECORD_ROLE) as StagedArtifact;
      return { pdf, record, pdfBytes: await bytesOf(r, pdf), recordBytes: await bytesOf(r, record) };
    };
    const v1 = await make(first, "renderer-1.0.0");
    const v2 = await make(second, "renderer-1.1.0");
    const staging = fake.location("STAGING");
    assert.notEqual(v1.pdf.objectName, v2.pdf.objectName);
    assert.notEqual(v1.pdf.sha256, v2.pdf.sha256);
    const r1 = readReportPdfRecord(v1.recordBytes);
    const r2 = readReportPdfRecord(v2.recordBytes);
    assert.ok(r1.ok && r2.ok);
    assert.equal(r1.record.identity.rendererVersion, "renderer-1.0.0");
    assert.equal(r2.record.identity.rendererVersion, "renderer-1.1.0");
    assert.notEqual(r1.record.identity.modelHash, r2.record.identity.modelHash, "the renderer version is part of the model: a different layout is a different report");
    // the first delivery is exactly as it was: same generation, same bytes, still described by its own record
    assert.equal(fake.generationsOf(staging, v1.pdf.objectName).length, 1);
    assert.equal(sha(await collect(fake.read(staging, v1.pdf.objectName, v1.pdf.generation))), v1.pdf.sha256);
    assert.deepEqual(reportRecordProblems(v1.recordBytes, v1.pdfBytes, first.scope), []);
    assert.deepEqual(reportRecordProblems(v2.recordBytes, v2.pdfBytes, second.scope), []);
    // a record never describes the other attempt's PDF or scope
    assert.notDeepEqual(reportRecordProblems(v1.recordBytes, v2.pdfBytes, first.scope), []);
    assert.ok(reportRecordProblems(v2.recordBytes, v2.pdfBytes, first.scope).includes("SCOPE_DIFFERS"));
  });
});

describe("B13xB08 the record is read back strictly", () => {
  it("any alteration, another spelling or a PDF that is not its own is a problem", async () => {
    const r = nextRig();
    const outcome = await envelopeOf(r, CLEAN, inputsFor(CLEAN), scriptedEngine()).execute(r.fixture.subject, r.io);
    const pdf = await bytesOf(r, outcome.stagedArtifacts.find((a) => a.role === REPORT_PDF_ROLE) as StagedArtifact);
    const recordBytes = await bytesOf(r, outcome.stagedArtifacts.find((a) => a.role === REPORT_RECORD_ROLE) as StagedArtifact);
    assert.deepEqual(reportRecordProblems(recordBytes, pdf, r.scope), []);
    const text = recordBytes.toString("utf8");
    const alterations: ReadonlyArray<readonly [string, string]> = [
      ["a hash digit", text.replace(/"pdfSha256":"[0-9a-f]/, (m) => m.slice(0, -1) + (m.endsWith("0") ? "1" : "0"))],
      ["another spelling", text.replace('"stage":"STAGED_VERIFIED"', '"stage": "STAGED_VERIFIED"')],
      ["a published stage", text.replace("STAGED_VERIFIED", "PUBLISHED")],
      ["an extra field", text.replace('"stage"', '"extra":1,"stage"')],
      ["not json", "STAGED_VERIFIED"],
    ];
    for (const [label, altered] of alterations) assert.notDeepEqual(reportRecordProblems(new TextEncoder().encode(altered), pdf, r.scope), [], label);
    const wrongPdf = Buffer.from(pdf);
    wrongPdf[wrongPdf.length - 12] = (wrongPdf[wrongPdf.length - 12] as number) ^ 1;
    assert.ok(reportRecordProblems(recordBytes, wrongPdf, r.scope).includes("PDF_HASH_DIFFERS"));
    assert.ok(reportRecordProblems(recordBytes, pdf.subarray(0, pdf.length - 1), r.scope).includes("PDF_LENGTH_DIFFERS"));
    const read = readReportPdfRecord(recordBytes);
    assert.ok(read.ok);
    assert.deepEqual(Buffer.from(reportPdfRecordBytesOf(read.record)), recordBytes, "the record round-trips byte for byte");
  });
});
