// Order 15 (OWASP API1 BOLA; S048 "deny without resource-existence or data leakage"): the object routes the S048 sweep left with only their
// nonexistent half (gap R2-B16-S048-UNSWEPT: GetUpload, GetUploadSession) and the source commands and intake whose foreign case had no test
// (CompleteUpload, CancelUpload by the other agency's member, the selection manifest intake on a foreign revision). Two ACTIVE agencies,
// each with its own upload in flight. A member of one, under its own X-Kauro-Agency, naming the other's upload or revision gets exactly the
// answer of an id that never existed (same status, problem and headers but the correlation id), the other's rows do not change, nothing is
// stored and no upload session is opened; a member naming the other agency in X-Kauro-Agency is no member there. Real routes, real
// composition root, real PostgreSQL 17.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { activate, reserved, sourceRoutes } from "./source-support.js";
import { asProblem, call, freshKey, ids, outcome, sha, world, type Person, type Reply, type World } from "./support.js";

let w: World;
let mine: { readonly uploadId: string; readonly revisionId: string };
let theirs: { readonly uploadId: string; readonly revisionId: string };
before(async () => {
  w = await world();
  await activate(w);
  await activate(w, w.B);
  const projectA = await w.project(w.A, w.clientA);
  const projectB = await w.project(w.B, w.clientB);
  mine = { uploadId: (await reserved(w, projectA.revisionId, 1)).data.upload.uploadId, revisionId: projectA.revisionId };
  theirs = { uploadId: (await reserved(w, projectB.revisionId, 1, { person: w.stranger, agency: w.B.agencyId })).data.upload.uploadId, revisionId: projectB.revisionId };
});
after(async () => {
  await w.stop();
});

/** A reply stripped of what legitimately differs between two requests: the correlation id (body and header) and the date. */
function shape(reply: Reply): unknown {
  const { correlationId: _c, ...problem } = asProblem(w, reply);
  const { "x-correlation-id": _h, date: _d, ...headers } = reply.headers;
  return { status: reply.status, problem, headers };
}

interface Probe {
  readonly name: string;
  readonly send: (id: string, person: Person, agency: string) => Promise<Reply>;
}

const get = (url: string, person: Person, agency: string): Promise<Reply> => call(w, { method: "GET", url, token: person.token, key: null, contentType: null, agency });
const UPLOAD_PROBES: ReadonlyArray<Probe> = [
  { name: "GetUpload", send: (id, p, a) => get(sourceRoutes.upload(id), p, a) },
  { name: "GetUploadSession", send: (id, p, a) => get(sourceRoutes.uploadSession(id), p, a) },
  { name: "CMD014 CompleteUpload", send: (id, p, a) => call(w, { url: sourceRoutes.completeUpload(id), token: p.token, agency: a, key: freshKey("o15-complete"), body: { providerCompletionRef: "o15-completion" } }) },
  { name: "CMD015 CancelUpload", send: (id, p, a) => call(w, { url: sourceRoutes.cancelUpload(id), token: p.token, agency: a, key: freshKey("o15-cancel"), body: { expectedVersion: 1 } }) },
];

async function uploadRows(): Promise<unknown> {
  const r = await w.h.oracle.query("SELECT upload_id, version, state FROM kauro.upload_sessions WHERE upload_id IN ($1, $2) ORDER BY upload_id", [mine.uploadId, theirs.uploadId]);
  return r.rows;
}

test("O15 BOLA: an upload of the other agency answers its member exactly like an upload that never existed — read, session, completion and cancellation — and nothing of it changes", async () => {
  const before = await uploadRows();
  const opened = () => w.vault.calls().filter((c) => c.operation === "open").length;
  const sessionsBefore = opened();
  const failures: string[] = [];
  const pairs: ReadonlyArray<{ readonly who: string; readonly person: Person; readonly agency: string; readonly foreign: string }> = [
    { who: "B's owner under B", person: w.stranger, agency: w.B.agencyId, foreign: mine.uploadId },
    { who: "A's operator under A", person: w.operator, agency: w.A.agencyId, foreign: theirs.uploadId },
  ];
  for (const { who, person, agency, foreign } of pairs) {
    for (const probe of UPLOAD_PROBES) {
      const other = await probe.send(foreign, person, agency);
      const nowhere = await probe.send(ids.next(), person, agency);
      const what = `${probe.name} by ${who}`;
      if (other.status !== 404) failures.push(`${what}: ${other.status} ${other.text.slice(0, 200)}`);
      else if (JSON.stringify(shape(other)) !== JSON.stringify(shape(nowhere))) failures.push(`${what}: a foreign and a nonexistent upload answer differently (${outcome(w, other)} / ${outcome(w, nowhere)})`);
    }
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(await uploadRows(), before, "neither agency's upload changed");
  assert.equal(opened(), sessionsBefore, "no upload session was opened");
  // the control: each probe reaches its own agency's upload (never NOT_FOUND), so the refusals above are about the other agency
  for (const probe of UPLOAD_PROBES) {
    const own = await probe.send(mine.uploadId, w.operator, w.A.agencyId);
    assert.notEqual(own.status, 404, `${probe.name} of A's own upload: ${own.text.slice(0, 200)}`);
  }
});

test("O15 BOLA: the selection manifest intake on the other agency's revision answers like a revision that never existed and stores nothing", async () => {
  const document = { schemaVersion: 1, revisionId: theirs.revisionId, inventoryHash: sha("o15-inventory"), files: [], tables: [], projections: [], associations: [] };
  const before = await w.count("selection_manifests");
  const foreign = await call(w, { url: sourceRoutes.selectionManifests(theirs.revisionId), token: w.operator.token, key: null, agency: w.A.agencyId, body: document });
  const unknownId = ids.next();
  const nowhere = await call(w, { url: sourceRoutes.selectionManifests(unknownId), token: w.operator.token, key: null, agency: w.A.agencyId, body: { ...document, revisionId: unknownId } });
  assert.equal(foreign.status, 404, foreign.text);
  assert.deepEqual(shape(foreign), shape(nowhere), "a foreign and a nonexistent revision answer alike");
  assert.equal(await w.count("selection_manifests"), before, "nothing stored");
});

test("O15 X-Kauro-Agency: naming the other agency in the selector makes the caller no member there — its own upload included — and the selector of its own agency does not reach the other's", async () => {
  // A's operator presenting B's agency: no live membership in B (foreign and nonexistent agencies alike, D-AUTHZ-4)
  assert.equal(outcome(w, await get(sourceRoutes.upload(mine.uploadId), w.operator, w.B.agencyId)), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, await get(sourceRoutes.upload(theirs.uploadId), w.operator, w.B.agencyId)), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, await get(sourceRoutes.upload(mine.uploadId), w.operator, ids.next())), "404 NOT_FOUND NOT_A_MEMBER");
  // the control: each member reads its own agency's upload under its own selector
  assert.equal((await get(sourceRoutes.upload(mine.uploadId), w.operator, w.A.agencyId)).status, 200);
  assert.equal((await get(sourceRoutes.upload(theirs.uploadId), w.stranger, w.B.agencyId)).status, 200);
});
