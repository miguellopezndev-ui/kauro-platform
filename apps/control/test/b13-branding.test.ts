// CMD008 UpdateBranding and its logo intake meeting B13's reports on a real PostgreSQL 17 (order 7; docs/design/B13-branding.md).
// The branding is recorded through the product — the logo intake's and CMD008's handlers of @kauro/application, exactly as apps/api
// binds them (admitted as the transport admits a request, B06's pipeline, the persistence adapter of migrations 0095/0096, every answer
// checked against its route's contract) — and the reports are made by the control plane and the worker's report stage over the
// platform's records (PlatformReportInputs, ReportingExecutionEnvelope), so each case is the whole path:
//   1. a branding version recorded with a synthetic logo is the one a later job's report names, prints and embeds — the logo exactly the
//      stored PNG, nothing else under the brand; the issuer's legal identity stays the issuer's;
//   2. a branding change racing a job's queueing and its first report: the job's version is the one bound at its first report and never
//      moves, whichever commits first; a change committed later is for later jobs;
//   3. a published report is never touched by later branding: the same bytes under the same generations.
// Every image and identity is synthetic; nothing is fetched. With KAURO_B13_EVIDENCE_DIR set, case 1 writes the report it made there.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  BRANDING_INTAKE_ROUTES,
  HEADERS,
  UPDATE_BRANDING,
  admitDocument,
  admitStructure,
  checkReply,
  commandRouteResponses,
  createBrandingHandlers,
  createBrandingIntakeHandlers,
  createSchemaValidator,
  envelopeOf,
  intakeRouteResponses,
  type AuthenticatedSubject,
  type BrandingLogoIntakeView,
  type BrandingStores,
  type CommandResult,
  type ContractSchemaBundle,
  type UpdateBrandingView,
} from "@kauro/application";
import { createAssuranceVerifier, createAuthorizer } from "@kauro/authorization";
import { REPORT_RECORD_ROLE, assembleReportFacts, readReportPdfRecord, type ReportScope } from "@kauro/data-plane";
import { encodePng, textDigest, type AgencyId, type CorrelationId, type UnitOfWork, type UserId } from "@kauro/domain";
import { reportSourcesOf } from "@kauro/persistence";
import { readFileSync } from "node:fs";
import { PlatformReportInputs } from "../src/execution/report-inputs.js";
import { admitted, clock, ids, launched, observedDone } from "./support/execution-world.js";
import { kitOf } from "./support/report-kit.js";
import { BRAND, ISSUER, RENDER, defaultEngine, reportFixtureOf, sha256, startReportWorld, type ReportWorld } from "./support/report-world.js";

let w: ReportWorld;
let k: ReturnType<typeof kitOf>;
let product: ReturnType<typeof brandingProduct>;

before(async () => {
  w = await startReportWorld("b13-branding");
  k = kitOf(w);
  product = brandingProduct(w);
});
after(async () => {
  await w.stop();
});

type Agency = Awaited<ReturnType<ReportWorld["agency"]>>;

/**
 * The branding routes of the product over the world's request-handler units (kauro_app), with one hold point: `holdBeforeCommit`
 * keeps CMD008's transaction open after its writes and before its journal commit (the moment a concurrent job may queue or bind).
 */
function brandingProduct(world: ReportWorld) {
  let held: { readonly reached: () => void; readonly release: Promise<void> } | null = null;
  const instrument = (uow: UnitOfWork): UnitOfWork =>
    new Proxy(uow, {
      get(target, property) {
        if (property === "journal") {
          const journal = target.journal;
          return {
            ...journal,
            reserve: journal.reserve.bind(journal),
            find: journal.find.bind(journal),
            markUncertain: journal.markUncertain.bind(journal),
            async commit(...args: Parameters<typeof journal.commit>) {
              const h = held;
              if (h !== null) {
                held = null;
                h.reached();
                await h.release;
              }
              return journal.commit(...args);
            },
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  const factory = world.h.app;
  const unitOfWork = new Proxy(factory, {
    get(target, property) {
      if (property === "run") return (context: Parameters<typeof factory.run>[0], work: (uow: UnitOfWork) => Promise<unknown>) => target.run(context, (uow) => work(instrument(uow)));
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const authorizer = createAuthorizer({ clock, assurance: createAssuranceVerifier() });
  const stores: BrandingStores = { branding: (uow) => reportSourcesOf(uow).brandingVersions };
  const handlers = createBrandingHandlers({ unitOfWork, authorizer, clock, ids }, stores);
  const intakes = createBrandingIntakeHandlers({ unitOfWork, authorizer, clock, cursorKey: new Uint8Array(32).fill(7) }, stores);
  const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle;
  const validator = createSchemaValidator(bundle);
  const subject = (userId: string): AuthenticatedSubject => {
    const verifiedAt = clock.now();
    return { identity: { userId: userId as UserId, state: "ACTIVE", emailVerifiedAt: verifiedAt, mfaEnrolledAt: verifiedAt }, provider: "identity-platform", subjectHash: textDigest(`subject:${userId}`) };
  };
  const raw = (agencyId: string, params: Record<string, string>, body: unknown, key?: string) => ({
    headers: { "content-type": HEADERS.contentType, ...(key === undefined ? {} : { [HEADERS.idempotencyKey]: key }), [HEADERS.agency]: agencyId },
    repeatedHeaders: [],
    correlationId: ids.next() as CorrelationId,
    params,
    body: new TextEncoder().encode(JSON.stringify(body)),
    clientAddressHash: null,
  });
  return {
    /** Holds the next CMD008 transaction after its writes, before its journal commit; `reached` resolves once it is there. */
    holdBeforeCommit(): { readonly reached: Promise<void>; release(): void } {
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const r = new Promise<void>((resolve) => (reached = resolve));
      held = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
      return { reached: r, release };
    },
    async uploadLogo(agency: Agency, png: Uint8Array): Promise<BrandingLogoIntakeView> {
      const route = BRANDING_INTAKE_ROUTES.SubmitBrandingLogo;
      const body = { mediaType: "image/png", contentBase64: Buffer.from(png).toString("base64"), contentSha256: sha256(png), rightsConfirmed: true };
      const admission = admitDocument(route, raw(agency.agencyId, { agencyId: agency.agencyId }, body), validator);
      if (admission.kind === "PROBLEM") assert.fail(`the logo is not admitted: ${JSON.stringify(admission.problem)}`);
      const result = await intakes.SubmitBrandingLogo.execute({ ...admission.admission, subject: subject(agency.ownerUserId) });
      if (result.kind === "PROBLEM") assert.fail(`SubmitBrandingLogo: ${JSON.stringify(result.problem)}`);
      checkReply(validator, intakeRouteResponses("SubmitBrandingLogo"), result.created ? 201 : 200, HEADERS.contentType, { kind: "STORED", data: result.view });
      return result.view;
    },
    async updateBranding(agency: Agency, body: Record<string, unknown>): Promise<CommandResult<UpdateBrandingView>> {
      const admitted = admitStructure(UPDATE_BRANDING, raw(agency.agencyId, { agencyId: agency.agencyId }, body, `b13_brand_${ids.next().replace(/-/g, "")}`), validator, clock);
      if (admitted.kind === "PROBLEM") assert.fail(`CMD008 is not admitted: ${JSON.stringify(admitted.problem)}`);
      const result = await handlers.CMD008.execute(envelopeOf("CMD008", "LOCAL", admitted.admission, subject(agency.ownerUserId)) as never);
      const responses = commandRouteResponses("CMD008", "UpdateBranding");
      if (result.kind === "COMPLETED") checkReply(validator, responses, result.status, HEADERS.contentType, { kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.view });
      else if (result.kind !== "ACCEPTED") checkReply(validator, responses, result.problem.status, HEADERS.problemContentType, result.problem);
      return result;
    },
  };
}

const agencyVersionOf = async (agencyId: string): Promise<number> => Number((await w.h.oracle.query<{ v: string }>("SELECT version::text AS v FROM kauro.agencies WHERE agency_id = $1", [agencyId])).rows[0]!.v);
const completedView = (r: CommandResult<UpdateBrandingView>): UpdateBrandingView => {
  if (r.kind !== "COMPLETED") assert.fail(`CMD008 did not complete: ${JSON.stringify(r)}`);
  return r.view;
};
/** CMD008 by the agency's owner at its current version. */
const rebrand = async (agency: Agency, displayName: string, logoId?: string): Promise<UpdateBrandingView> =>
  completedView(await product.updateBranding(agency, { expectedVersion: await agencyVersionOf(agency.agencyId), displayName, ...(logoId === undefined ? {} : { logoArtifactRef: logoId }) }));

/** A synthetic logo: a 96 x 32 two-tone badge with the seed in its green channel and a transparent border. */
function syntheticLogo(seed: number): Uint8Array {
  const width = 96;
  const height = 32;
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const border = x < 2 || y < 2 || x >= width - 2 || y >= height - 2;
      px.set(border ? [0, 0, 0, 0] : x < width / 3 ? [20, seed & 0xff, 140, 255] : [240, 240, 245, 255], (y * width + x) * 4);
    }
  }
  return encodePng(width, height, px);
}

/** The scope of a job's latest attempt, from the oracle. */
async function scopeOf(jobId: string): Promise<ReportScope> {
  const r = (await w.h.oracle.query<{ agency_id: string; project_id: string; attempt_id: string }>("SELECT j.agency_id, j.project_id, a.attempt_id FROM kauro.processing_jobs j JOIN kauro.processing_attempts a ON a.job_id = j.job_id WHERE j.job_id = $1 ORDER BY a.ordinal DESC LIMIT 1", [jobId])).rows[0];
  assert.ok(r);
  return { agencyId: r.agency_id, projectId: r.project_id, jobId, attemptId: r.attempt_id };
}
const port = (): PlatformReportInputs => new PlatformReportInputs({ units: w.units, ids });
const bindingOf = async (jobId: string): Promise<number | null> => {
  const r = (await w.h.oracle.query<{ v: number }>("SELECT branding_version AS v FROM kauro.report_branding_bindings WHERE job_id = $1", [jobId])).rows[0];
  return r === undefined ? null : r.v;
};
/** The branding the report stage would print for the job: the facts assembled from the platform's inputs. */
const brandingOfJob = async (jobId: string) => {
  const scope = await scopeOf(jobId);
  return assembleReportFacts(scope, await port().read(scope), RENDER.rendererVersion).branding;
};
/** The delivered report's record of a published job. */
async function deliveredRecordOf(jobId: string) {
  const pdf = await k.deliveredPdf(jobId);
  const copy = (await k.deliveredOf(pdf.packageVersionId)).find((c) => c.role === REPORT_RECORD_ROLE)!;
  const bytes = await k.bytesOf("DELIVERY", copy.object_name, copy.generation);
  const read = readReportPdfRecord(bytes);
  assert.ok(read.ok);
  return { pdf, recordBytes: bytes, record: read.record };
}

test("CMD008-OK in a synthetic report: a version recorded through the logo intake and CMD008 is the one a later job binds, its report prints the brand and embeds exactly the stored logo — beside the issuer's legal identity, which no brand replaces", async () => {
  const A = await w.agency("brand-report");
  const png = syntheticLogo(90);
  const logo = await product.uploadLogo(A, png);
  assert.equal(logo.created, true);
  const recorded = await rebrand(A, "Synthetic Branded Agency", logo.logoId);
  assert.deepEqual([recorded.branding.brandingVersion, recorded.branding.logo?.sha256], [2, logo.sha256], "version 1 is the world's own; CMD008 records version 2");
  const stored = (await w.h.oracle.query<{ content: Buffer }>("SELECT content FROM kauro.agency_branding_logos WHERE logo_id = $1", [logo.logoId])).rows[0]!.content;

  // the job's report, with the HTML the PDF engine is handed captured on its way
  const printed: string[] = [];
  const engine = defaultEngine();
  w.scenario(A, { packageName: "A-clean-multi-object", engine: () => ({ engineId: engine.engineId, print: async (request) => (printed.push(request.html), engine.print(request)) }) });
  const p = await w.paid(A, "brand-report", { mode: "HUBSPOT", report: reportFixtureOf("A-clean-multi-object") });
  const { jobId, identity } = await admitted(w, p);
  await launched(w, jobId);
  await observedDone(w, identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(jobId)).state, "READY", "the branded report was delivered");
  assert.equal(await bindingOf(jobId), 2, "the job is bound to the version in force when it was queued");

  // the platform's inputs: the version, its logo and the logo's bytes — the stored PNG, held to the hash the version names
  const scope = await scopeOf(jobId);
  const inputs = await port().read(scope);
  assert.ok(inputs !== null);
  assert.deepEqual(inputs.branding, { binding: "AGENCY_BRANDING_V1", agencyId: A.agencyId, version: 2, displayName: "Synthetic Branded Agency", recordedAt: inputs.branding?.binding === "AGENCY_BRANDING_V1" ? inputs.branding.recordedAt : "", logo: { logoId: logo.logoId, sha256: logo.sha256, mediaType: "image/png" } });
  assert.equal(sha256(inputs.logo ?? new Uint8Array()), logo.sha256);
  const facts = assembleReportFacts(scope, inputs, RENDER.rendererVersion);
  assert.deepEqual(facts.branding, { version: "agency-branding-v2", displayName: "Synthetic Branded Agency", logo: { sha256: logo.sha256, mediaType: "image/png" } });
  assert.deepEqual(facts.issuer, { legalName: ISSUER.legalName, jurisdiction: ISSUER.jurisdiction, registrationId: ISSUER.taxId }, "the issuer is the legal identity document's, never the brand");

  // the report: the HTML the engine printed is the one the delivered record names; it embeds the stored PNG and no other image or URL
  const { pdf, record } = await deliveredRecordOf(jobId);
  assert.equal(printed.length, 1);
  const html = printed[0]!;
  assert.equal(sha256(html), record.identity.htmlSha256, "the delivered record names exactly this HTML");
  assert.ok(html.includes(`<img class="logo" alt="Synthetic Branded Agency" src="data:image/png;base64,${stored.toString("base64")}">`), "the stored logo, embedded");
  assert.equal([...html.matchAll(/<img /g)].length, 1, "one image: the logo");
  assert.equal([...html.matchAll(/https?:\/\//g)].length, 0, "no URL anywhere in the report");
  assert.ok(html.includes("Synthetic Branded Agency"));
  assert.ok(html.includes(ISSUER.legalName) && html.includes(ISSUER.taxId), "the issuer's line is printed");
  assert.equal(record.scope.jobId, jobId);
  assert.equal(sha256(pdf.bytes), record.identity.pdfSha256);

  const dir = process.env["KAURO_B13_EVIDENCE_DIR"];
  if (dir !== undefined && dir !== "") {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "branded-report.pdf"), pdf.bytes);
    writeFileSync(join(dir, "branded-report.html"), html);
    writeFileSync(join(dir, "branded-report-logo.png"), stored);
    writeFileSync(
      join(dir, "branded-report-evidence.json"),
      `${JSON.stringify({ engineId: engine.engineId, agencyId: A.agencyId, jobId, brandingVersion: 2, binding: await bindingOf(jobId), displayName: facts.branding.displayName, logo: { logoId: logo.logoId, sha256: logo.sha256, width: logo.width, height: logo.height, byteLength: logo.byteLength }, issuer: facts.issuer, record: record.identity, pdf: { sha256: sha256(pdf.bytes), byteLength: pdf.bytes.length } }, null, 2)}\n`,
    );
  }
});

test("CMD008-RACE with a job: a branding change open while a job is queued and first read binds the version committed then, and the job keeps it after the change commits; a change committed before the first read is bound; later changes reach only later jobs", async () => {
  const A = await w.agency("brand-race");
  w.scenario(A, { packageName: "A-clean-multi-object" });
  const logo = await product.uploadLogo(A, syntheticLogo(91));

  // (a) the job is queued and admitted; CMD008 writes version 2 and is held before COMMIT; the job's first read binds what is committed: 1
  const p1 = await w.paid(A, "brand-race-1", { mode: "HUBSPOT", report: reportFixtureOf("A-clean-multi-object") });
  const j1 = await admitted(w, p1);
  const hold = product.holdBeforeCommit();
  const change = rebrand(A, "Race Rebrand", logo.logoId);
  await hold.reached;
  assert.equal((await brandingOfJob(j1.jobId)).version, "agency-branding-v1", "an uncommitted version is invisible to the binding");
  assert.equal(await bindingOf(j1.jobId), 1);
  hold.release();
  assert.equal((await change).branding.brandingVersion, 2);
  for (let i = 0; i < 3; i++) assert.equal((await brandingOfJob(j1.jobId)).version, "agency-branding-v1", "the binding never moves");
  await launched(w, j1.jobId);
  await observedDone(w, j1.identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(j1.jobId)).state, "READY");
  assert.equal(await bindingOf(j1.jobId), 1, "delivered under the version bound at its first report");

  // (b) CMD008 begins (its version stamped at its transaction's instant) before a job is queued, the job is queued while it is open, and the
  // change commits before the job's first read: the first read binds the change — committed and in force at the queueing — and keeps it
  const hold2 = product.holdBeforeCommit();
  const change2 = rebrand(A, "Race Rebrand Again");
  await hold2.reached;
  const p2 = await w.paid(A, "brand-race-2", { mode: "HUBSPOT", report: reportFixtureOf("A-clean-multi-object") });
  const j2 = await admitted(w, p2);
  hold2.release();
  const v3 = (await change2).branding;
  assert.equal(v3.brandingVersion, 3);
  const bound = (await brandingOfJob(j2.jobId)).version;
  assert.equal(bound, "agency-branding-v3", "a version stamped before the queueing and committed before the first report is the job's");
  // a fourth version afterwards changes nothing for this job, and is the next job's (each job runs to its end before the next: one slot)
  await rebrand(A, "Race Rebrand Final");
  assert.equal((await brandingOfJob(j2.jobId)).version, bound);
  const run = async (j: { readonly jobId: string; readonly identity: string }): Promise<void> => {
    await launched(w, j.jobId);
    await observedDone(w, j.identity);
    await w.drain(w.x.consumers.jobExecution);
    assert.equal((await w.job(j.jobId)).state, "READY");
  };
  await run(j2);
  assert.equal((await brandingOfJob(j2.jobId)).version, bound, "delivered under the version bound at its first report");
  const p3 = await w.paid(A, "brand-race-3", { mode: "HUBSPOT", report: reportFixtureOf("A-clean-multi-object") });
  const j3 = await admitted(w, p3);
  assert.equal((await brandingOfJob(j3.jobId)).version, "agency-branding-v4");
  await run(j3);
  assert.deepEqual([await bindingOf(j1.jobId), await bindingOf(j2.jobId), await bindingOf(j3.jobId)], [1, 3, 4]);
});

test("CMD008 and published reports: a report already delivered keeps its bytes, generations and record after the agency records new versions and a new logo; the version it was bound to stays exactly as recorded", async () => {
  const before = await k.delivered("brand-integrity", "A-clean-multi-object");
  const A = before.A;
  const first = await deliveredRecordOf(before.jobId);
  const version1 = (await w.h.oracle.query("SELECT to_jsonb(v) AS row FROM kauro.agency_branding_versions v WHERE agency_id = $1 AND branding_version = 1", [A.agencyId])).rows;
  assert.deepEqual(await brandingOfJob(before.jobId), { version: "agency-branding-v1", displayName: BRAND, logo: null });
  const logo = await product.uploadLogo(A, syntheticLogo(92));
  await rebrand(A, "Integrity Rebrand", logo.logoId);
  await rebrand(A, "Integrity Rebrand Twice");
  // the delivered report: the same PDF and record bytes under the same generations, and the job still names version 1
  const again = await deliveredRecordOf(before.jobId);
  assert.deepEqual([again.pdf.copy.generation, again.pdf.copy.sha256, sha256(again.pdf.bytes)], [first.pdf.copy.generation, first.pdf.copy.sha256, sha256(first.pdf.bytes)]);
  assert.deepEqual(again.recordBytes, first.recordBytes);
  assert.equal(await bindingOf(before.jobId), 1);
  assert.deepEqual(await brandingOfJob(before.jobId), { version: "agency-branding-v1", displayName: BRAND, logo: null });
  assert.deepEqual((await w.h.oracle.query("SELECT to_jsonb(v) AS row FROM kauro.agency_branding_versions v WHERE agency_id = $1 AND branding_version = 1", [A.agencyId])).rows, version1, "version 1 is exactly as recorded");
  // and a stale CMD008 naming the agency version the first report was made under records nothing
  const stale = await product.updateBranding(A, { expectedVersion: (await agencyVersionOf(A.agencyId)) - 2, displayName: "Rewrite History" });
  assert.equal(stale.kind === "COMPLETED" || stale.kind === "ACCEPTED" ? stale.kind : stale.problem.code, "STALE_VERSION");
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.agency_branding_versions WHERE agency_id = $1", [A.agencyId])).rowCount, 3);
});
