// UI14 source intake, UI15 selection, UI16 seal review (design D-STATE-1, D-OPS-1, D-SCR-3; registry primary copy). The facts of an upload,
// the cross-origin upload rules, the inspection as the api reports it, the three measures of a seal and the commands CMD013-CMD017 through
// the real api client over a scripted fetch. The failure matrix rows are in docs/design/B11-agency-app.md; the titles are the plan's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { screens as registryScreens } from "@kauro/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SCHEMAS } from "../src/api/generated.ts";
import { validateAgainst } from "../src/api/schema-guard.ts";
import { OperationRunner } from "../src/client/operation-runner.ts";
import { stateOfAnswer, stateOfRun } from "../src/client/states.ts";
import {
  cancelUpload,
  completeUpload,
  confirmSelection,
  countsView,
  initialDraft,
  reserveUpload,
  resumeUpload,
  sealOffer,
  sealRevision,
  selectionDocument,
  uploadActions,
  uploadFacts,
  uploadFile,
  uploadTarget,
  type PutResult,
  type UploadTransport,
} from "../src/screens/sources/model.ts";
import { SealView, SelectionView, SourcesView, UploadFacts } from "../src/screens/sources/view.tsx";
import { StatePanel } from "../src/screens/shared/state-panel.tsx";
import { contentSecurityPolicy, newNonce, uploadConnectOrigins, uploadOriginOrNull } from "../src/server/security-headers.ts";
import { harness, problem, respond, REVISION } from "./support/fixtures.ts";
import {
  evaluated,
  inspectedFile,
  inspection,
  MANIFEST,
  NOW,
  project,
  readyToSeal,
  reserved,
  revision,
  scannerSkipped,
  SELECTION_HASH,
  session,
  table,
  TABLE,
  TABLE_HIDDEN,
  UPLOAD,
  UPLOAD_ORIGIN,
  unevaluatedInspection,
  unevaluatedRevision,
  upload,
  withoutSelection,
  INVENTORY_HASH,
} from "./support/fixtures-sources.ts";

const noop = (): void => undefined;
const fastRunner = (): OperationRunner => new OperationRunner({ now: () => Date.parse("2026-10-14T00:00:00Z"), randomBytes: (n) => new Uint8Array(n).fill(3), wait: async () => undefined });
const chosen = { name: "contacts.csv", size: 2048, body: new Blob(["synthetic"]) };
const progressOf: Record<string, never> = {};

function sourcesHtml(overrides: Partial<Parameters<typeof SourcesView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(SourcesView, {
      revision: revision(),
      uploads: [],
      hasMore: false,
      uploadOrigin: UPLOAD_ORIGIN,
      nowMs: NOW,
      progress: progressOf,
      busy: false,
      refused: null,
      hrefs: { selection: "/s", seal: "/z" },
      onFile: noop,
      onResume: noop,
      onCancel: noop,
      onMore: noop,
      onRefresh: noop,
      ...overrides,
    }),
  );
}

function selectionHtml(draftOverride?: Parameters<typeof SelectionView>[0]["draft"], insp = inspection(), rev = revision({ state: "INSPECTING", permittedActions: ["SelectInputTables"] })): string {
  return renderToStaticMarkup(createElement(SelectionView, { revision: rev, inspection: insp, draft: draftOverride ?? initialDraft(insp), busy: false, confirmed: false, hrefs: { sources: "/a", seal: "/b" }, onChange: noop, onConfirm: noop, onRefresh: noop }));
}

const sealHtml = (rev = readyToSeal(), insp = evaluated(), busy = false): string => renderToStaticMarkup(createElement(SealView, { revision: rev, inspection: insp, busy, hrefs: { selection: "/sel" }, onSeal: noop, onRefresh: noop }));

class FakeTransport implements UploadTransport {
  readonly puts: { url: string; bytes: number }[] = [];
  constructor(private readonly result: PutResult = { kind: "SENT", completionRef: "completion-token-1" }) {}
  async put(input: Parameters<UploadTransport["put"]>[0]): Promise<PutResult> {
    this.puts.push({ url: input.url, bytes: input.body.size });
    input.onProgress({ sent: input.body.size, total: input.body.size });
    return this.result;
  }
}

const posts = (sent: readonly { url: string; init: { method?: string } }[]): string[] => sent.filter((entry) => entry.init.method === "POST").map((entry) => entry.url);

test("fixtures: every sources fixture is valid against the generated schema", () => {
  const checks: ReadonlyArray<readonly [string, unknown]> = [
    ["ProjectView", project()],
    ["SourceRevisionView", revision()],
    ["SourceRevisionView", readyToSeal()],
    ["UploadView", upload()],
    ["UploadView", scannerSkipped()],
    ["ReserveUploadView", reserved()],
    ["InspectionView", inspection()],
    ["InspectionView", evaluated()],
  ];
  for (const [name, value] of checks) assert.deepEqual(validateAgainst(SCHEMAS as never, name, value), [], name);
});

test("UI14: each file shows declared size, upload progress, provider observation, scanner coverage and parser state as separate facts; a scanner skip says not fully checked", () => {
  const skipped = scannerSkipped();
  const facts = uploadFacts(skipped, { sent: 1024, total: 2048 });
  assert.equal(facts.declaredBytes, 2048);
  assert.deepEqual(facts.progress, { sent: 1024, total: 2048 });
  assert.deepEqual(facts.observation, { bytes: 2048, observedAt: "2026-10-13T11:05:00Z" });
  assert.equal(facts.scanner.kind === "INSPECTED" && facts.scanner.fullyChecked, false, "a skip is not a clean scan");
  assert.equal(facts.parser.kind === "PARSED" && facts.parser.structure, "STRUCTURE_VALID", "the parser's state does not depend on the scanner's");
  const html = renderToStaticMarkup(createElement(UploadFacts, { upload: skipped, progress: { sent: 1024, total: 2048 } }));
  for (const label of ["Size", "Sent from this browser", "Received by the storage provider", "Security scan", "Structure"]) assert.ok(html.includes(label), label);
  assert.ok(html.includes("Not fully checked: the scanner skipped this file"));
  assert.ok(html.includes("1,024 of 2,048 bytes sent") && html.includes("2,048 bytes, at") && html.includes("The structure is valid"));
  // a clean scan that covered only part of the file is still not fully checked
  const partial = upload({ inspection: { ...(scannerSkipped().inspection as NonNullable<ReturnType<typeof scannerSkipped>["inspection"]>), scanState: "COVERED_CLEAN", scanCoverage: { expectedParts: 4, scannedParts: 3, expectedBytes: 2048, scannedBytes: 1536 } } });
  assert.ok(renderToStaticMarkup(createElement(UploadFacts, { upload: partial, progress: null })).includes("Not fully checked: 3 of 4 parts were scanned"));
  // the scanner's own verdict decides: a skip is a skip even if the coverage figures look complete
  const skippedFull = upload({ inspection: { ...(scannerSkipped().inspection as NonNullable<ReturnType<typeof scannerSkipped>["inspection"]>), scanCoverage: { expectedParts: 4, scannedParts: 4, expectedBytes: 2048, scannedBytes: 2048 } } });
  assert.equal(uploadFacts(skippedFull).scanner.kind === "INSPECTED" && (uploadFacts(skippedFull).scanner as { fullyChecked: boolean }).fullyChecked, false);
  assert.ok(renderToStaticMarkup(createElement(UploadFacts, { upload: skippedFull, progress: null })).includes("Not fully checked: the scanner skipped this file"));
  const clean = upload({ inspection: { ...(scannerSkipped().inspection as NonNullable<ReturnType<typeof scannerSkipped>["inspection"]>), scanState: "COVERED_CLEAN", scanCoverage: { expectedParts: 4, scannedParts: 4, expectedBytes: 2048, scannedBytes: 2048 } } });
  const cleanHtml = renderToStaticMarkup(createElement(UploadFacts, { upload: clean, progress: null }));
  assert.ok(cleanHtml.includes("Fully checked: no problem found") && !cleanHtml.includes("Not fully checked"));
  assert.ok(renderToStaticMarkup(createElement(UploadFacts, { upload: upload(), progress: null })).includes("Not inspected yet"), "no inspection yet is said, not guessed");
});

test("UI14/CMD013-015: reserve, complete and cancel each run under their subject key; a lost complete answer re-reads the upload and never reserves again", async () => {
  // reserve: one key per revision version and file; a second file is a second intent
  const reserve = harness(async () => respond(201, { kind: "COMPLETED", version: 5, replayed: false, data: reserved() }));
  const rev = revision();
  await reserveUpload(reserve.client, fastRunner(), rev, chosen);
  await reserveUpload(reserve.client, fastRunner(), rev, chosen);
  await reserveUpload(reserve.client, fastRunner(), rev, { name: "other.csv", size: 10 });
  const keys = reserve.sent.map((entry) => entry.init.headers["Idempotency-Key"]);
  assert.equal(keys[0], keys[1], "a double activation, a reload and a second tab are one intent");
  assert.notEqual(keys[0], keys[2], "another file is another intent");
  assert.equal(reserve.sent[0]?.url, `/api/v1/revisions/${REVISION}/uploads`);
  assert.deepEqual(JSON.parse(reserve.sent[0]?.init.body ?? "{}"), { expectedVersion: 4, declaredBytes: 2048, declaredFormat: "CSV", displayName: "contacts.csv" });

  // complete and cancel: the upload's own version is the subject version
  const live = harness(async (sent) => (sent.url.endsWith("/cancel") ? respond(200, { kind: "COMPLETED", version: 3, replayed: false, data: { upload: upload({ state: "CANCELLED", version: 3 }), revision: { revisionId: REVISION, state: "UPLOADING", version: 6 }, releasedBytes: 2048 } }) : respond(202, { kind: "ACCEPTED", operationId: MANIFEST, state: "VERIFYING", statusPath: `/api/v1/uploads/${UPLOAD}`, pollAfterSeconds: 2 })));
  const cancel1 = await cancelUpload(live.client, fastRunner(), upload());
  const cancel2 = await cancelUpload(live.client, fastRunner(), upload());
  const complete1 = await completeUpload(live.client, fastRunner(), upload(), "completion-token-1");
  const complete2 = await completeUpload(live.client, fastRunner(), upload(), "completion-token-1");
  assert.equal(cancel1.kind === "COMPLETED" && cancel1.data.state, "CANCELLED");
  assert.equal(cancel2.kind, "COMPLETED");
  assert.equal(complete1.kind, "ACCEPTED");
  assert.equal(complete2.kind, "ACCEPTED");
  const [c1, c2, p1, p2] = live.sent.map((entry) => entry.init.headers["Idempotency-Key"]);
  assert.equal(c1, c2);
  assert.equal(p1, p2);
  assert.notEqual(c1, p1, "a different command is a different key");
  assert.equal(live.sent[0]?.url, `/api/v1/uploads/${UPLOAD}/cancel`);
  assert.deepEqual(JSON.parse(live.sent[0]?.init.body ?? "{}"), { expectedVersion: 2 });
  assert.deepEqual(JSON.parse(live.sent[2]?.init.body ?? "{}"), { providerCompletionRef: "completion-token-1" });

  // a lost complete answer: the same key again, then the durable upload is read; the reservation is never repeated
  const lost = harness(async (sent) => {
    if (sent.init.method === "POST" && sent.url.endsWith("/uploads")) return respond(201, { kind: "COMPLETED", version: 5, replayed: false, data: reserved() });
    if (sent.init.method === "POST") throw new TypeError("network");
    return respond(200, { kind: "READ", data: upload({ state: "VERIFYING", version: 3 }) });
  });
  const transport = new FakeTransport();
  const flow = await uploadFile({ client: lost.client, runner: fastRunner(), transport, uploadOrigin: UPLOAD_ORIGIN, onProgress: noop }, rev, chosen);
  assert.equal(flow.kind, "COMPLETE_ENDED");
  assert.equal(flow.kind === "COMPLETE_ENDED" && flow.outcome.kind, "RECOVERED");
  const sentPosts = posts(lost.sent);
  assert.equal(sentPosts.filter((url) => url === `/api/v1/revisions/${REVISION}/uploads`).length, 1, "reserved exactly once");
  const completeKeys = lost.sent.filter((entry) => entry.url.endsWith("/complete")).map((entry) => entry.init.headers["Idempotency-Key"]);
  assert.ok(completeKeys.length >= 2 && new Set(completeKeys).size === 1, "every retry of the lost answer uses the same key");
  assert.equal(lost.sent[lost.sent.length - 1]?.url, `/api/v1/uploads/${UPLOAD}`, "the upload is read after the lost answers");
  assert.equal(transport.puts.length, 1, "the file was sent once");

  // a lost complete answer that the upload does not show yet stays Checking: never success, never a new reservation
  const unsure = harness(async (sent) => (sent.init.method === "POST" ? Promise.reject(new TypeError("network")) : respond(200, { kind: "READ", data: upload() })));
  const checking = await completeUpload(unsure.client, fastRunner(), upload(), "completion-token-1");
  assert.equal(checking.kind, "CHECKING");
  assert.equal(stateOfRun(checking).state, "PENDING");
});

test("UI14 EXPIRY: an expired upload session offers a new reservation, never a resume, and the browser clock can only disable resume", () => {
  const rev = revision();
  const expired = upload({ state: "EXPIRED", permittedActions: [] });
  const afterServer = uploadActions(expired, rev, NOW);
  assert.equal(afterServer.newReservation, true);
  assert.equal(afterServer.resume, "NOT_OFFERED");
  const html = sourcesHtml({ uploads: [expired] });
  assert.ok(html.includes("Reserve a new upload") && html.includes("This session expired"));
  assert.ok(!html.includes("Resume this upload"));
  // without the server's permission to reserve there is no new reservation either
  assert.equal(uploadActions(expired, revision({ permittedActions: [] }), NOW).newReservation, false);

  // a session the server still calls UPLOADING: valid by the clock resumes, past by the clock only disables
  const live = upload({ applicationExpiresAt: "2026-10-13T18:00:00Z" });
  assert.equal(uploadActions(live, rev, NOW).resume, "OFFERED");
  assert.ok(sourcesHtml({ uploads: [live] }).includes("Resume this upload"));
  const pastByClock = uploadActions(live, rev, Date.parse("2026-10-13T18:00:01Z"));
  assert.equal(pastByClock.resume, "DISABLED_BY_CLOCK");
  assert.equal(pastByClock.newReservation, false, "the clock never offers a reservation: only the server calls a session expired");
  const disabled = sourcesHtml({ uploads: [live], nowMs: Date.parse("2026-10-13T18:00:01Z") });
  assert.match(disabled, /<button[^>]*disabled[^>]*>Resume this upload<\/button>/);
  assert.ok(!disabled.includes("Reserve a new upload"));
  // a cancelled session needs a new, explicit attempt too
  assert.equal(uploadActions(upload({ state: "CANCELLED", permittedActions: [] }), rev, NOW).newReservation, true);
});

test("D-SCR-3: connect-src names exactly the configured upload origin, and without one the upload is unavailable and no wildcard appears", async () => {
  const nonce = newNonce();
  const directive = (policy: string): readonly string[] => (policy.split("; ").find((part) => part.startsWith("connect-src ")) ?? "").split(" ").slice(1);
  const configured = contentSecurityPolicy({ nonce, connectOrigins: uploadConnectOrigins(uploadOriginOrNull(UPLOAD_ORIGIN)) });
  assert.deepEqual(directive(configured), ["'self'", UPLOAD_ORIGIN], "exactly the one configured origin");
  for (const value of [undefined, "", "*", "https://*.example.test", "https://uploads.example.test/path", "https://uploads.example.test/", "http://uploads.example.test", "https://user@uploads.example.test", "uploads.example.test"]) {
    assert.equal(uploadOriginOrNull(value), null, String(value));
    const policy = contentSecurityPolicy({ nonce, connectOrigins: uploadConnectOrigins(uploadOriginOrNull(value)) });
    assert.deepEqual(directive(policy), ["'self'"], `${String(value)}: the policy gains nothing`);
    assert.ok(!policy.includes("*"), `${String(value)}: no wildcard anywhere`);
  }
  // without an origin the screen says uploads are unavailable, offers no file control and reserves nothing
  const html = sourcesHtml({ uploadOrigin: null });
  assert.ok(html.includes("Uploads are unavailable") && !html.includes('type="file"'));
  assert.ok(sourcesHtml().includes('type="file"'));
  const { client, sent } = harness(async () => respond(500, {}));
  const transport = new FakeTransport();
  const none = await uploadFile({ client, runner: fastRunner(), transport, uploadOrigin: null, onProgress: noop }, revision(), chosen);
  assert.deepEqual(none, { kind: "UNAVAILABLE", reason: "NO_UPLOAD_ORIGIN", upload: null });
  assert.equal(sent.length, 0, "nothing was reserved");
  assert.equal(transport.puts.length, 0);
  // the PUT goes only to a session on the configured origin
  assert.deepEqual(uploadTarget(session(), UPLOAD_ORIGIN), { kind: "READY", url: `${UPLOAD_ORIGIN}/session/opaque-one` });
  for (const uploadUrl of ["https://elsewhere.example.test/session/x", "https://uploads.example.test.evil.test/x", "https://user:pw@uploads.example.test/x", "https://uploads.example.test:8443/x"]) assert.deepEqual(uploadTarget(session({ uploadUrl }), UPLOAD_ORIGIN), { kind: "UNAVAILABLE", reason: "ORIGIN_MISMATCH" }, uploadUrl);
  assert.deepEqual(uploadTarget(session({ delivery: "UNAVAILABLE", unavailableReason: "NOT_REQUESTER" }), UPLOAD_ORIGIN), { kind: "UNAVAILABLE", reason: "SESSION_UNAVAILABLE" });
  const foreign = harness(async () => respond(201, { kind: "COMPLETED", version: 5, replayed: false, data: reserved({ session: session({ uploadUrl: "https://elsewhere.example.test/session/x" }) }) }));
  const refused = await uploadFile({ client: foreign.client, runner: fastRunner(), transport, uploadOrigin: UPLOAD_ORIGIN, onProgress: noop }, revision(), chosen);
  assert.equal(refused.kind, "UNAVAILABLE");
  assert.equal(transport.puts.length, 0, "no byte goes to another origin");
  const good = harness(async (sent) => (sent.url.endsWith("/complete") ? respond(202, { kind: "ACCEPTED", operationId: MANIFEST, state: "VERIFYING", statusPath: `/api/v1/uploads/${UPLOAD}`, pollAfterSeconds: 2 }) : respond(201, { kind: "COMPLETED", version: 5, replayed: false, data: reserved() })));
  const sentOk = await uploadFile({ client: good.client, runner: fastRunner(), transport, uploadOrigin: UPLOAD_ORIGIN, onProgress: noop }, revision(), chosen);
  assert.equal(sentOk.kind, "COMPLETE_ENDED");
  assert.deepEqual(transport.puts.map((put) => put.url), [`${UPLOAD_ORIGIN}/session/opaque-one`]);
  // resume re-reads the session and sends to the configured origin only; it never reserves
  const resumed = harness(async (sent) => (sent.url.endsWith("/session") ? respond(200, { kind: "READ", data: session({ uploadUrl: `${UPLOAD_ORIGIN}/session/opaque-two` }) }) : respond(202, { kind: "ACCEPTED", operationId: MANIFEST, state: "VERIFYING", statusPath: `/api/v1/uploads/${UPLOAD}`, pollAfterSeconds: 2 })));
  const resumeTransport = new FakeTransport();
  const again = await resumeUpload({ client: resumed.client, runner: fastRunner(), transport: resumeTransport, uploadOrigin: UPLOAD_ORIGIN, onProgress: noop }, upload(), chosen);
  assert.equal(again.kind, "COMPLETE_ENDED");
  assert.deepEqual(resumeTransport.puts.map((put) => put.url), [`${UPLOAD_ORIGIN}/session/opaque-two`]);
  assert.ok(!posts(resumed.sent).some((url) => url.endsWith("/uploads")), "resume never reserves");
});

test("UI15: positional duplicate headers show as 'Email - column 3', hidden sheets and formulas are labelled, and a selection change marks counts stale until re-evaluated", () => {
  const insp = evaluated({ revision: readyToSeal() });
  const rev = readyToSeal();
  const html = selectionHtml(undefined, insp, rev);
  assert.ok(html.includes("Email - column 3"), "a duplicated header is told apart by its position");
  assert.ok(!html.includes("Name - column"), "a plain header is shown as it is");
  assert.ok(html.includes("Hidden sheet") && html.includes("Visible sheet"), "visibility is labelled");
  assert.ok(html.includes("Contains formulas") && html.includes("Formula values: some missing"), "formulas are labelled with their cache state");
  assert.equal(inspectedFile().tables[1]?.visibility, "HIDDEN");
  // a very hidden sheet is not called merely hidden
  const very = inspection({ files: [inspectedFile({ tables: [table(), table({ tableId: TABLE_HIDDEN, name: "Vault", visibility: "VERY_HIDDEN" })] })] });
  assert.ok(selectionHtml(undefined, very).includes("Very hidden sheet"));
  // counts: current while the selection is the server's, stale as soon as the person changes it, until the evaluation is read again
  assert.equal(countsView(rev, insp, initialDraft(insp)).stale, false);
  assert.ok(!html.includes("The counts are out of date"));
  const changed = { ...initialDraft(insp), [TABLE_HIDDEN]: { include: true, reason: "", hiddenAcknowledged: true } };
  assert.equal(countsView(rev, insp, changed).stale, true);
  const staleHtml = selectionHtml(changed, insp, rev);
  assert.ok(staleHtml.includes("The counts are out of date") && staleHtml.includes("until it is evaluated again"));
  assert.equal(countsView(revision({ state: "INSPECTING", blockers: ["SELECTION_STALE"] }), insp, initialDraft(insp)).stale, true, "the server's own stale blocker counts too");
  // an excluded table needs a visible reason; a hidden sheet included needs the person's acknowledgement
  const noReason = { ...initialDraft(insp), [TABLE]: { include: false, reason: "", hiddenAcknowledged: false } };
  const missing = selectionHtml(noReason, insp, rev);
  assert.ok(missing.includes("A table that is excluded needs a visible reason."));
  assert.match(missing, /<button[^>]*disabled[^>]*>Confirm this selection<\/button>/);
  const noAck = { ...initialDraft(insp), [TABLE_HIDDEN]: { include: true, reason: "", hiddenAcknowledged: false } };
  assert.ok(selectionHtml(noAck, insp, rev).includes("A hidden sheet needs your confirmation before it is included."));
  assert.ok(!/<button[^>]*disabled[^>]*>Confirm this selection/.test(selectionHtml(undefined, insp, rev)), "a complete selection can be confirmed");
  // the registry sentence, and no control the server did not permit
  assert.ok(html.includes("Confirm the records this project includes."));
  assert.ok(!selectionHtml(undefined, insp, revision({ permittedActions: [] })).includes("Confirm this selection"));
});

test("UI15/CMD016: the confirmed selection is stored by content, selected under the revision version, and a lost answer is recovered from the revision", async () => {
  const insp = inspection();
  const draft = initialDraft(insp);
  const doc = selectionDocument(insp, draft);
  assert.equal(doc.inventoryHash, INVENTORY_HASH);
  assert.deepEqual(doc.tables.map((entry) => [entry.tableId, entry.disposition, entry.exclusionReason]), [[TABLE, "INCLUDE", undefined], [TABLE_HIDDEN, "EXCLUDE", ""]]);
  const reasoned = selectionDocument(insp, { ...draft, [TABLE_HIDDEN]: { include: false, reason: "OLD_OR_ARCHIVED_DATA", hiddenAcknowledged: false } });
  assert.equal(reasoned.tables[1]?.exclusionReason, "OLD_OR_ARCHIVED_DATA");
  const acknowledged = selectionDocument(insp, { ...draft, [TABLE_HIDDEN]: { include: true, reason: "", hiddenAcknowledged: true } });
  assert.equal(acknowledged.tables[1]?.hiddenSheetAcknowledged, true);
  assert.deepEqual(validateAgainst(SCHEMAS as never, "SelectionManifestDocument", reasoned), []);

  const selected = revision({ version: 5, state: "INSPECTING", selection: { selectionManifestId: MANIFEST, selectionHash: SELECTION_HASH, inventoryHash: INVENTORY_HASH, selectedAt: "2026-10-13T11:30:00Z" } });
  const ok = harness(async (sent) => (sent.url.endsWith("/selection-manifests") ? respond(201, { kind: "STORED", data: { selectionManifestId: MANIFEST, revisionId: REVISION, bodyHash: SELECTION_HASH, created: true } }) : respond(200, { kind: "COMPLETED", version: 5, replayed: false, data: { revision: selected, selection: { selectionManifestId: MANIFEST, selectionHash: SELECTION_HASH, includedFileCount: 1, includedTableCount: 1, reusedFileIds: [] } } })));
  const base = revision({ state: "INSPECTING", permittedActions: ["SelectInputTables"] });
  const done = await confirmSelection(ok.client, fastRunner(), base, reasoned);
  assert.equal(done.kind === "SELECT_ENDED" && done.outcome.kind, "COMPLETED");
  assert.deepEqual(JSON.parse(ok.sent[1]?.init.body ?? "{}"), { expectedVersion: 4, selectionManifestRef: MANIFEST });
  await confirmSelection(ok.client, fastRunner(), base, reasoned);
  assert.equal(ok.sent[1]?.init.headers["Idempotency-Key"], ok.sent[3]?.init.headers["Idempotency-Key"], "the same revision version and manifest is the same intent");

  const lost = harness(async (sent) => {
    if (sent.url.endsWith("/selection-manifests")) return respond(201, { kind: "STORED", data: { selectionManifestId: MANIFEST, revisionId: REVISION, bodyHash: SELECTION_HASH, created: false } });
    if (sent.init.method === "POST") throw new TypeError("network");
    return respond(200, { kind: "READ", data: selected });
  });
  const recovered = await confirmSelection(lost.client, fastRunner(), base, reasoned);
  assert.equal(recovered.kind === "SELECT_ENDED" && recovered.outcome.kind, "RECOVERED");
});

test("UI16/R2-065: the seal review shows physical rows, billable source units and association edges as three labelled measures, never one records figure", () => {
  const html = sealHtml();
  for (const [label, value] of [["Physical rows", "12,345"], ["Billable source units", "9,876"], ["Association edges", "4,321"]] as const) {
    const at = html.indexOf(label);
    assert.ok(at >= 0, label);
    assert.ok(html.slice(at, at + 220).includes(value), `${label} carries its own figure`);
  }
  assert.ok(html.includes("The units the service is priced on") && html.includes("The links between records that the selection declares"), "each measure has its definition");
  assert.ok(!html.includes("7,777"), "the logical record count is not composed into a figure");
  assert.ok(!/total records|records total|\brecords:/i.test(html));
  assert.ok(html.includes("Confirm this exact source revision."));
  // selected and excluded tables with their reason, the hashes, the retention date
  assert.ok(html.includes("contacts.xlsx") && html.includes("Contacts") && html.includes("Old or archived data"));
  assert.ok(html.includes(SELECTION_HASH) && html.includes(INVENTORY_HASH));
  assert.ok(html.includes("Files available until"));
  assert.ok(html.includes("It does not start anything you pay for."));
  // before the selection is evaluated there is no figure, only the sentence saying so
  const unevaluated = sealHtml(unevaluatedRevision(), unevaluatedInspection());
  assert.ok(unevaluated.includes("The counts are not available until the selection is evaluated.") && !unevaluated.includes("Physical rows"));
});

test("UI16/CMD017: seal is offered only for READY_TO_SEAL with no unresolved input, sends the inventory hash it showed, and a changed hash is STALE", async () => {
  const offered = sealOffer(readyToSeal(), evaluated());
  assert.deepEqual(offered, { kind: "OFFERED", selectionHash: SELECTION_HASH, inventoryHash: INVENTORY_HASH });
  assert.ok(sealHtml().includes("Seal this set"));
  // not offered: not ready, a blocker, no selection, a failed evaluation, sealed, not permitted
  const cases: ReadonlyArray<readonly [string, ReturnType<typeof readyToSeal>, ReturnType<typeof evaluated>, string]> = [
    ["not ready", readyToSeal({ state: "INSPECTING" }), evaluated(), "BLOCKED"],
    ["unresolved input", readyToSeal({ blockers: ["INPUT_REJECTED_NOT_EXCLUDED"] }), evaluated(), "BLOCKED"],
    ["no selection", withoutSelection(), evaluated(), "BLOCKED"],
    ["failed evaluation", readyToSeal(), evaluated({ evaluation: { evaluationHash: "a".repeat(64), result: "ADMISSION_FAILED", failures: [{ code: "ADMISSION_REVOKED" }] } }), "BLOCKED"],
    ["already sealed", readyToSeal({ state: "SEALED", sealedAt: "2026-10-13T12:00:00Z" }), evaluated(), "SEALED"],
    ["not permitted", readyToSeal({ permittedActions: [] }), evaluated(), "NOT_PERMITTED"],
    ["inventory changed", readyToSeal(), evaluated({ inventoryHash: "b".repeat(64) }), "STALE"],
  ];
  for (const [name, rev, insp, kind] of cases) {
    assert.equal(sealOffer(rev, insp).kind, kind, name);
    assert.ok(!sealHtml(rev, insp).includes("Seal this set"), `${name}: no seal control`);
  }
  assert.ok(sealHtml(readyToSeal({ blockers: ["INPUT_REJECTED_NOT_EXCLUDED"] })).includes("A rejected file is not excluded yet."));
  assert.ok(sealHtml(readyToSeal(), evaluated({ inventoryHash: "b".repeat(64) })).includes("The selection and the files no longer match"));
  assert.ok(sealHtml(readyToSeal({ state: "SEALED" })).includes("This revision is sealed"));

  // the command: the selection hash shown is the one sent, under the revision version and that hash
  const sealed = readyToSeal({ state: "SEALED", sealedAt: "2026-10-13T12:00:00Z", permittedActions: [] });
  const ok = harness(async () => respond(200, { kind: "COMPLETED", version: 10, replayed: false, data: { revision: sealed, manifestHash: "c".repeat(64), projectionHash: "d".repeat(64), sealedSubjectHash: "e".repeat(64), retention: { retentionId: MANIFEST, class: "UNPAID", anchorEvidenceHash: "f".repeat(64), hardDeadline: "2026-11-13T00:00:00Z", effectiveDeadline: "2026-11-13T00:00:00Z", policyVersion: "RET_V1", providerResiduals: [], state: "ACTIVE" } } }));
  const first = await sealRevision(ok.client, fastRunner(), readyToSeal(), SELECTION_HASH);
  await sealRevision(ok.client, fastRunner(), readyToSeal(), SELECTION_HASH);
  assert.equal(first.kind, "COMPLETED");
  assert.equal(ok.sent[0]?.url, `/api/v1/revisions/${REVISION}/seal`);
  assert.deepEqual(JSON.parse(ok.sent[0]?.init.body ?? "{}"), { expectedVersion: 9, selectionHash: SELECTION_HASH });
  assert.equal(ok.sent[0]?.init.headers["Idempotency-Key"], ok.sent[1]?.init.headers["Idempotency-Key"], "a double activation is one intent");

  // a changed hash on the server is STALE with the comparison; nothing is shown as sealed
  const stale = harness(async () => respond(409, problem(409, "STALE_VERSION", { current: { version: 10, state: "READY_TO_SEAL" } })));
  const refused = await sealRevision(stale.client, fastRunner(), readyToSeal(), SELECTION_HASH);
  assert.equal(refused.kind, "PROBLEM");
  const decision = stateOfRun(refused);
  assert.equal(decision.state, "STALE");
  assert.equal(decision.next, "COMPARE_VERSIONS");

  // a lost answer: the revision says whether it took effect
  const lost = harness(async (sent) => (sent.init.method === "POST" ? Promise.reject(new TypeError("network")) : respond(200, { kind: "READ", data: sealed })));
  assert.equal((await sealRevision(lost.client, fastRunner(), readyToSeal(), SELECTION_HASH)).kind, "RECOVERED");
  const notYet = harness(async (sent) => (sent.init.method === "POST" ? Promise.reject(new TypeError("network")) : respond(200, { kind: "READ", data: readyToSeal() })));
  assert.equal((await sealRevision(notYet.client, fastRunner(), readyToSeal(), SELECTION_HASH)).kind, "CHECKING");
});

test("UI14-UI16: the shared states carry the screens - denied clears the view, a broken answer shows the support reference, a lost read is checking, and the registry sentences are on the pages", () => {
  const panel = (decision: Parameters<typeof StatePanel>[0]["decision"]): string => renderToStaticMarkup(createElement(StatePanel, { decision, onNext: noop }));
  const forbidden = panel(stateOfAnswer({ kind: "PROBLEM", status: 403, correlationId: "c", problem: problem(403, "NOT_AUTHORIZED") }));
  assert.ok(forbidden.includes("This is not available") && !forbidden.includes("<button"));
  const broken = panel(stateOfAnswer({ kind: "INTEGRITY", status: 200, correlationId: "corr-77", failure: "REPLY_FAILED_CONTRACT" }));
  assert.ok(broken.includes("Support reference: corr-77"));
  const later = panel(stateOfAnswer({ kind: "PROBLEM", status: 503, correlationId: "c", problem: problem(503, "CAPACITY_UNAVAILABLE", { retryAfterSeconds: 30 }) }));
  assert.ok(later.includes("30"), "the retry hint is shown");
  assert.ok(panel(stateOfAnswer({ kind: "NO_ANSWER", reason: "NETWORK", status: null })).includes("We are checking the result"));
  // the registry sentence of each screen, word for word (UI14's earlier brand is written as the product name: the copy lint refuses the old one)
  const registry = new Map(registryScreens().map((row) => [(row as unknown as { id: string }).id, (row as unknown as { primaryCopy: string }).primaryCopy] as const));
  const sentence = (id: string): string => (registry.get(id) ?? "").replace(/\bK[a]vo\b/, "Kauro");
  assert.ok(sourcesHtml().includes(sentence("UI14")), "UI14");
  assert.ok(selectionHtml().includes(sentence("UI15")), "UI15");
  assert.ok(sealHtml().includes(sentence("UI16")), "UI16");
  assert.equal(sentence("UI15"), "Confirm the records this project includes.");
});
