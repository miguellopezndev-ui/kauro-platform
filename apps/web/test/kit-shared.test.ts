// K0, the shared kit of the stage-2 screens: one copy catalogue assembled from per-area modules, the paged read, the step-up dialog and
// the one place the browser clock is read. The web judges no instant (D-STATE-1): the server's answer decides, the clock only disables.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type EndClientView, SCHEMAS } from "../src/api/generated.ts";
import { validateAgainst } from "../src/api/schema-guard.ts";
import { IdentityCredential } from "../src/client/identity/port.ts";
import { SCREEN_COPY } from "../src/copy/screens.ts";
import { PagedRead } from "../src/screens/shared/use-paged-read.ts";
import { runWithStepUp, StepUpPanel } from "../src/screens/shared/step-up.tsx";
import { useNow } from "../src/screens/shared/use-now.ts";
import { AGENCY, harness, problem, respond } from "./support/fixtures.ts";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const NEXT_CURSOR = `cursor-one.${"A".repeat(43)}`;
const SECOND_CURSOR = `cursor-two.${"B".repeat(43)}`;

// ---- the copy catalogue ----

test("K0: the copy catalogue is the union of the per-area modules with no key defined twice", async () => {
  // the area modules next to the code under test: dist/src when this runs compiled, src when it runs from source
  const dir = fileURLToPath(new URL("../src/copy/screens/", import.meta.url));
  const modules = readdirSync(dir).filter((name) => /\.(ts|js)$/.test(name) && !name.endsWith(".d.ts")).sort();
  assert.ok(modules.length >= 11, "an area module per screen area, empty ones included, so a lane never edits the aggregator");
  const union: string[] = [];
  for (const name of modules) {
    const loaded = (await import(pathToFileURL(join(dir, name)).href)) as Record<string, unknown>;
    const exported = Object.entries(loaded).filter(([key]) => key.endsWith("_COPY"));
    assert.equal(exported.length, 1, `${name} exports exactly one *_COPY table`);
    union.push(...Object.keys(exported[0]?.[1] as Record<string, string>));
  }
  assert.equal(new Set(union).size, union.length, "no key is defined by two areas");
  assert.deepEqual(Object.keys(SCREEN_COPY).sort(), [...union].sort(), "the aggregator carries every area's keys and nothing else");
  assert.ok(Object.keys(SCREEN_COPY).includes("screen.quote.title") && Object.keys(SCREEN_COPY).includes("screen.approval.title"), "the earlier keys moved, not vanished");
});

// ---- the paged read ----

function clientView(n: number, version: number): EndClientView {
  return {
    clientId: `0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6${String(n).padStart(3, "0")}`,
    agencyId: AGENCY,
    version,
    displayName: `Client ${n}`,
    state: "ACTIVE",
    processingAuthorityRef: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7f01",
    createdAt: "2026-10-13T12:00:00Z",
    permittedActions: ["CreateProject"],
  };
}
const pageBody = (items: readonly EndClientView[], nextCursor?: string) => ({ kind: "READ", data: { items, ...(nextCursor === undefined ? {} : { nextCursor }) } });
const cursorOf = (url: string): string | null => new URL(url, "http://x.test").searchParams.get("cursor");

function pagedClients(answer: Parameters<typeof harness>[0]) {
  const { client, sent } = harness(answer);
  const read = new PagedRead({
    load: (cursor, signal) => client.call("ListClients", { path: { agencyId: AGENCY }, ...(cursor === null ? {} : { query: { cursor } }), signal }),
    pageOf: (body) => ({ items: body.data.items, nextCursor: body.data.nextCursor ?? null, version: String(body.data.items[0]?.version ?? "none") }),
  });
  return { read, sent };
}

test("K0: a paged read keeps earlier pages, sends only the server's cursor, and drops every page when a later page answers a different version", async () => {
  assert.deepEqual(validateAgainst(SCHEMAS as never, "ClientPage", pageBody([clientView(1, 1)], NEXT_CURSOR).data), [], "the fixture is a valid page");

  // earlier pages are kept; the cursor is the one the server issued, and only after a page named it
  const walk = pagedClients(async (_sent, index) => (index === 0 ? respond(200, pageBody([clientView(1, 1), clientView(2, 1)], NEXT_CURSOR)) : respond(200, pageBody([clientView(3, 1)]))));
  await walk.read.first();
  assert.equal(cursorOf(walk.sent[0]?.url ?? ""), null, "the first page is asked for without a cursor");
  assert.deepEqual(walk.read.state.items.map((item) => item.displayName), ["Client 1", "Client 2"]);
  assert.equal(walk.read.state.hasMore, true);
  await walk.read.more();
  assert.equal(cursorOf(walk.sent[1]?.url ?? ""), NEXT_CURSOR);
  assert.deepEqual(walk.read.state.items.map((item) => item.displayName), ["Client 1", "Client 2", "Client 3"]);
  assert.equal(walk.read.state.hasMore, false);
  await walk.read.more();
  assert.equal(walk.sent.length, 2, "after the last page nothing more is asked for");

  // RETRY: a lost answer keeps the pages and retries the very same server cursor
  const lost = pagedClients(async (_sent, index) => {
    if (index === 0) return respond(200, pageBody([clientView(1, 1)], NEXT_CURSOR));
    if (index === 1) throw new Error("network down");
    return respond(200, pageBody([clientView(2, 1)]));
  });
  await lost.read.first();
  await lost.read.more();
  assert.equal(lost.read.state.status, "FAILED");
  assert.equal(lost.read.state.items.length, 1, "the earlier page stays on screen");
  await lost.read.more();
  assert.equal(cursorOf(lost.sent[2]?.url ?? ""), NEXT_CURSOR, "the retry uses the same cursor, never a made-up one");
  assert.equal(lost.read.state.items.length, 2);

  // RACE: a later page of another version drops all pages, and no further page is asked for
  const changed = pagedClients(async (_sent, index) => (index === 0 ? respond(200, pageBody([clientView(1, 1)], NEXT_CURSOR)) : respond(200, pageBody([clientView(2, 2)], SECOND_CURSOR))));
  await changed.read.first();
  await changed.read.more();
  assert.equal(changed.read.state.status, "CHANGED");
  assert.deepEqual(changed.read.state.items, [], "the page of the older version is gone too");
  assert.equal(changed.read.state.hasMore, false);
  await changed.read.more();
  assert.equal(changed.sent.length, 2, "a dropped list asks for nothing until it is read again from the start");

  // RACE: an answer that arrives after a newer read began is dropped
  const gates: Array<(value: ReturnType<typeof respond>) => void> = [];
  const late = pagedClients((_sent, index) =>
    index === 1 ? new Promise((resolve) => gates.push(resolve)) : Promise.resolve(respond(200, pageBody([clientView(index === 0 ? 1 : 9, 1)], index === 0 ? NEXT_CURSOR : undefined))),
  );
  await late.read.first();
  const slow = late.read.more();
  await Promise.resolve();
  await late.read.first();
  gates[0]?.(respond(200, pageBody([clientView(2, 1)])));
  await slow;
  assert.deepEqual(late.read.state.items.map((item) => item.displayName), ["Client 9"], "the stale page did not land on the newer list");
});

// ---- the step-up ----

const PROOF = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7001";
const proofReply = () => respond(201, { proofId: PROOF, expiresAt: "2026-10-13T13:00:00Z" });
const credential = () => new IdentityCredential("CONTRACT_FAKE", "STEP_UP", "provider-token-value");
const bodyOf = (init: { body?: string }): Record<string, unknown> => JSON.parse(init.body ?? "{}") as Record<string, unknown>;

test("K0: the step-up dialog sends the identity token once, hands the proof to exactly one command, and an expired or refused proof is the STEP_UP state that keeps the form", async () => {
  // the good path: one token sent once, one proof, one command
  const good = harness(async () => proofReply());
  const proofs: string[] = [];
  const done = await runWithStepUp({
    client: good.client,
    obtain: async () => credential(),
    command: async (proof) => {
      proofs.push(proof.take());
      assert.throws(() => proof.take(), /already/, "a proof is consumed by one command");
      return "COMMAND_OUTCOME";
    },
  });
  assert.equal(done.kind, "DONE");
  assert.deepEqual(proofs, [PROOF]);
  assert.equal(good.sent.length, 1, "the token travels in exactly one request");
  assert.equal(bodyOf(good.sent[0]?.init ?? {})["idToken"], "provider-token-value");
  assert.equal(good.sent[0]?.url, "/api/v1/assurance/step-ups");

  // a refused proof: the api says the assurance is not enough; the command never runs, nothing is retried with the spent token
  const refused = harness(async () => respond(403, problem(403, "ASSURANCE_REQUIRED", { reason: "STEP_UP_STALE" })));
  let ran = 0;
  const refusedResult = await runWithStepUp({
    client: refused.client,
    obtain: async () => credential(),
    command: async () => {
      ran += 1;
      return "x";
    },
  });
  assert.equal(refusedResult.kind, "STEP_UP");
  assert.equal(ran, 0);
  assert.equal(refused.sent.length, 1);

  // a lost answer: the token may have been used, so it is not sent again; a fresh proof is asked for
  const lost = harness(async () => {
    throw new Error("network down");
  });
  const lostResult = await runWithStepUp({ client: lost.client, obtain: async () => credential(), command: async () => "x" });
  assert.equal(lostResult.kind, "STEP_UP");
  assert.equal(lost.sent.length, 1);

  // an expired proof: the command is refused with ASSURANCE_REQUIRED, which is STEP_UP and not a failure
  const stale = await runWithStepUp({
    client: harness(async () => proofReply()).client,
    obtain: async () => credential(),
    command: async (proof) => {
      proof.take();
      return { refusedWith: "ASSURANCE_REQUIRED" };
    },
    isStale: (outcome) => outcome.refusedWith === "ASSURANCE_REQUIRED",
  });
  assert.equal(stale.kind, "STEP_UP");

  // no credential at all (the person closed the dialog)
  assert.equal((await runWithStepUp({ client: good.client, obtain: async () => null, command: async () => "x" })).kind, "STEP_UP");
  assert.equal(good.sent.length, 1, "no token, no request");

  // the form is kept beside the state, and the state offers the one next step
  const form = createElement("form", null, createElement("input", { name: "reason", defaultValue: "typed by the person" }));
  const html = renderToStaticMarkup(createElement(StepUpPanel, { result: stale, onStepUp: () => undefined }, form));
  assert.match(html, /typed by the person/);
  assert.match(html, /data-state="STEP_UP"/);
  assert.match(html, /<button[^>]*>Confirm identity<\/button>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(StepUpPanel, { result: done, onStepUp: () => undefined }, form)), /data-state="STEP_UP"/);
});

// ---- the clock ----

const CLOCK_SOURCES = /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(|\bDate\s*\(\s*\)/;
/** The only lines of the application that read the browser clock besides shared/use-now.ts: sources, identified by file and exact text. */
const ALLOWED_READS: ReadonlyArray<readonly [string, string]> = [
  ["client/operation-runner.ts", "now: () => Date.now(),"],
  ["shell/browser-page.ts", "now: () => Date.now(),"],
  ["screens/payments/containers.tsx", "const [now, setNow] = useState(() => Date.now());"],
  ["screens/payments/containers.tsx", "const timer = setInterval(() => setNow(Date.now()), 15_000);"],
];

function* sourcesOf(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourcesOf(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

test("K0: the browser clock is read only in shared/use-now.ts and the allowlisted payments container lines", () => {
  assert.equal(typeof useNow, "function");
  const src = join(webRoot, "src");
  const readers: string[] = [];
  for (const file of sourcesOf(src)) {
    const name = relative(src, file).split("\\").join("/");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const code = line.replace(/\/\/.*$/, "").trim();
      if (!CLOCK_SOURCES.test(code)) continue;
      if (name === "screens/shared/use-now.ts") {
        readers.push(name);
        continue;
      }
      assert.ok(ALLOWED_READS.some(([allowedFile, text]) => allowedFile === name && text === code), `${name} reads the clock outside the kit: ${code}`);
    }
  }
  assert.ok(readers.length > 0, "use-now.ts is where the clock is read");
});
