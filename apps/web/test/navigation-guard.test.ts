// NavigationGuard (B11 design D-OPS-3; case R2-064: "Show saved/draft status and a recoverable warning; do not silently treat unsaved local
// edits as approved"). Four facts are shown as four separate statuses: local edits (counted in this page's memory), saved draft (the
// CMD023 revision the server holds), validated and approved (both read from the server). Only the first is ever computed here; the other
// three change only when the server says so. The oracle of every assertion is the value the test itself fed in.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NavigationGuard,
  armTabClose,
  type DraftSaver,
  type SaveDraftResult,
} from "../src/client/navigation-guard.ts";

const SERVER_READ = { draftRevision: 4, validated: true, approved: false } as const;

function guardWith(saveDraft: DraftSaver): NavigationGuard {
  return new NavigationGuard({ saveDraft });
}

const neverSaves: DraftSaver = async () => {
  throw new Error("a leave that needed no save called the saver");
};

test("R2-064: local edits, saved draft, validated and approved are four separate statuses; leaving with local edits needs Stay, Save draft or Discard, and no status is derived from local edits", async () => {
  const calls: Readonly<Record<string, unknown>>[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let hold = false;
  let answer: SaveDraftResult = { kind: "REFUSED", code: "STALE_VERSION", correlationId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f70" };
  const guard = guardWith(async (edits) => {
    calls.push(edits);
    if (hold) await held;
    return answer;
  });

  // before the server has spoken, nothing is claimed about the saved draft, validation or approval
  assert.deepEqual(guard.status(), { localEdits: 0, savedDraft: { kind: "UNKNOWN" }, validated: "UNKNOWN", approved: "UNKNOWN" });
  assert.deepEqual(guard.requestLeave("IN_APP"), { kind: "PROCEED" }, "nothing to lose, nothing asked");

  guard.applyServerRead(SERVER_READ);
  const fromServer = { localEdits: 0, savedDraft: { kind: "SAVED", revision: 4 }, validated: "YES", approved: "NO" };
  assert.deepEqual(guard.status(), fromServer);

  // an edit changes the first status and only the first: it never becomes validated, approved or a saved draft
  guard.edit({ field: "enumMap.status.OPEN", value: "Open", baseline: "New" });
  guard.edit({ field: "enumMap.status.OPEN", value: "Opened", baseline: "New" });
  guard.edit({ field: "enumMap.status.LOST", value: "Closed lost", baseline: "Lost" });
  assert.deepEqual(guard.status(), { ...fromServer, localEdits: 2 }, "two fields edited, the field edited twice counts once");
  guard.edit({ field: "enumMap.status.LOST", value: "Lost", baseline: "Lost" });
  assert.equal(guard.status().localEdits, 1, "putting a field back to what the server holds is no longer an unsaved edit");
  guard.edit({ field: "enumMap.status.LOST", value: "Closed lost", baseline: "Lost" });

  // leaving from the app, with back, and by closing the tab: every way needs an answer, and the answers offered are the design's
  for (const via of ["IN_APP", "BACK"] as const) {
    assert.deepEqual(guard.requestLeave(via), { kind: "PROMPT", via, options: ["STAY", "SAVE_DRAFT", "DISCARD"], localEdits: 2 });
    assert.deepEqual(await guard.resolve("STAY"), { kind: "STAYED" });
    assert.deepEqual(guard.status(), { ...fromServer, localEdits: 2 }, "Stay keeps every edit and every status");
  }
  assert.deepEqual(guard.requestLeave("TAB_CLOSE"), { kind: "PROMPT", via: "TAB_CLOSE", options: ["STAY", "DISCARD"], localEdits: 2 }, "a browser tab close can only be stayed or accepted");
  await assert.rejects(() => guard.resolve("SAVE_DRAFT"), RangeError, "the option was not offered for a tab close");
  assert.deepEqual(await guard.resolve("STAY"), { kind: "STAYED" });
  await assert.rejects(() => guard.resolve("STAY"), RangeError, "there is no open question to answer");

  // Save draft that the server refuses keeps the edits and the statuses, and says why by code
  guard.requestLeave("IN_APP");
  const refused = await guard.resolve("SAVE_DRAFT");
  assert.deepEqual(refused, { kind: "SAVE_FAILED", code: "STALE_VERSION", correlationId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f70" });
  assert.deepEqual(calls, [{ "enumMap.status.OPEN": "Opened", "enumMap.status.LOST": "Closed lost" }], "the saver received exactly the edits");
  assert.deepEqual(guard.status(), { ...fromServer, localEdits: 2 }, "a refused save changes nothing");
  assert.deepEqual(guard.requestLeave("IN_APP").kind, "PROMPT", "the leave is still guarded");

  // an edit made while the save is in flight is not part of the draft the server records
  answer = { kind: "SAVED", revision: 5, validated: false, approved: false };
  hold = true;
  const saving = guard.resolve("SAVE_DRAFT");
  guard.edit({ field: "enumMap.status.WON", value: "Closed won", baseline: "Won" });
  release();
  assert.deepEqual(await saving, { kind: "SAVED", revision: 5 });
  assert.deepEqual(
    guard.status(),
    { localEdits: 1, savedDraft: { kind: "SAVED", revision: 5 }, validated: "NO", approved: "NO" },
    "the saved revision, validated and approved come from the server's answer; the edit made during the save is still local",
  );
  hold = false;

  // Discard drops the local edits only: what the server holds stays exactly as it is
  guard.requestLeave("BACK");
  assert.deepEqual(await guard.resolve("DISCARD"), { kind: "DISCARDED", discarded: 1 });
  assert.deepEqual(guard.status(), { localEdits: 0, savedDraft: { kind: "SAVED", revision: 5 }, validated: "NO", approved: "NO" });
  assert.deepEqual(guard.requestLeave("IN_APP"), { kind: "PROCEED" });

  // no sequence of edits and reversions moves the three server statuses; only a server read does
  const before = guard.status();
  for (let i = 0; i < 20; i += 1) {
    guard.edit({ field: `enumMap.f${i % 3}`, value: `v${i}`, baseline: "base" });
    if (i % 4 === 0) guard.edit({ field: `enumMap.f${i % 3}`, value: "base", baseline: "base" });
    const now = guard.status();
    assert.deepEqual([now.savedDraft, now.validated, now.approved], [before.savedDraft, before.validated, before.approved]);
  }
  guard.applyServerRead({ draftRevision: 6, validated: true, approved: true });
  assert.deepEqual(guard.status().approved, "YES");
  assert.equal(guard.status().localEdits, 3, "a server read does not erase what the person typed");
  // an approved plan with local edits is still guarded: approval is not permission to lose edits
  assert.equal(guard.requestLeave("IN_APP").kind, "PROMPT");
  await guard.resolve("STAY");

  // a page that has nothing typed never calls the saver
  const idle = guardWith(neverSaves);
  idle.applyServerRead(SERVER_READ);
  assert.deepEqual(idle.requestLeave("BACK"), { kind: "PROCEED" });
});

test("R2-064: closing the tab with local edits raises the browser's own leave warning, and a tab with nothing typed is never asked", () => {
  const guard = guardWith(neverSaves);
  const target = new EventTarget();
  const disarm = armTabClose(guard, target);
  // the event of a browser carries a writable returnValue; the one of the test runner carries an own data property in its place
  class UnloadEvent extends Event {
    returnValue: unknown = undefined;
    constructor() {
      super("beforeunload", { cancelable: true });
    }
  }
  const closing = () => {
    const event = new UnloadEvent();
    target.dispatchEvent(event);
    return event;
  };
  assert.equal(closing().defaultPrevented, false, "nothing typed, nothing asked");
  guard.edit({ field: "enumMap.status.OPEN", value: "Open", baseline: "New" });
  const warned = closing();
  assert.equal(warned.defaultPrevented, true);
  assert.equal(warned.returnValue, "", "the legacy flag some engines still read");
  guard.edit({ field: "enumMap.status.OPEN", value: "New", baseline: "New" });
  assert.equal(closing().defaultPrevented, false, "the edit was put back");
  guard.edit({ field: "enumMap.status.OPEN", value: "Open", baseline: "New" });
  disarm();
  assert.equal(closing().defaultPrevented, false, "a disarmed guard leaves the tab alone");
});
