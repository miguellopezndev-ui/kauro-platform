// Self-test of the B12 §M harness (lane K1 done criterion): raceAtWrite reports "blocked" when the first actor holds the lock the second
// needs at its pause, and "settled" when it does not; tokenFromSentMime reads only what the Gmail fake recorded; the SIM fake records
// aborts before it answers and keeps late acceptances.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { ContractFakeGmailSend } from "@kauro/application/testing";
import { startTemporaryPostgres, type TemporaryPostgres } from "@kauro/persistence/testing";
import { RaceNotObserved, mimeHeader, raceAtWrite, tokenFromSentMime } from "./outreach-support.js";

let pg: TemporaryPostgres;
let oracle: Client;

before(async () => {
  pg = await startTemporaryPostgres();
  oracle = await pg.connect("postgres");
});
after(async () => {
  await oracle?.end();
  await pg?.stop();
});

async function pidOf(client: Client): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
}

/** A first actor that takes advisory lock `key` in a transaction, pauses there (its "first write"), then commits. */
async function pausedLocker(key: number) {
  const client = await pg.connect("postgres");
  const pid = await pidOf(client);
  let reach: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((r) => (reach = r));
  const released = new Promise<void>((r) => (release = r));
  return {
    client,
    actor: {
      reached,
      release: () => release(),
      pid: () => pid,
      run: async () => {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [key]);
        reach();
        await released;
        await client.query("COMMIT");
        return "first";
      },
    },
  };
}

/** A second actor that takes advisory lock `key` in its own transaction. */
async function locker(key: number) {
  const client = await pg.connect("postgres");
  const pid = await pidOf(client);
  return {
    client,
    actor: {
      pid: () => pid,
      run: async () => {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [key]);
        await client.query("COMMIT");
        return "second";
      },
    },
  };
}

describe("B12 K1 raceAtWrite (§M)", () => {
  test("a planted lock: the second waits on the first's backend, so the race reports blocked, and both finish once the first is released", async () => {
    const a = await pausedLocker(912_001);
    const b = await locker(912_001);
    try {
      const r = await raceAtWrite({ oracle, first: a.actor, second: b.actor });
      assert.equal(r.outcome, "blocked");
      assert.deepEqual([r.first.status, r.second.status], ["fulfilled", "fulfilled"]);
    } finally {
      await a.client.end();
      await b.client.end();
    }
  });

  test("no planted lock (a different key): the second settles while the first is paused, so the race reports settled and never throws", async () => {
    const a = await pausedLocker(912_002);
    const b = await locker(912_003);
    try {
      const r = await raceAtWrite({ oracle, first: a.actor, second: b.actor });
      assert.equal(r.outcome, "settled");
      assert.deepEqual([r.first.status, r.second.status], ["fulfilled", "fulfilled"]);
    } finally {
      await a.client.end();
      await b.client.end();
    }
  });

  test("a first actor that ends before its pause point is a broken race, never an outcome", async () => {
    const b = await locker(912_004);
    try {
      await assert.rejects(
        raceAtWrite({ oracle, first: { reached: new Promise<void>(() => undefined), release: () => undefined, pid: () => 0, run: async () => "no pause" }, second: b.actor }),
        RaceNotObserved,
      );
    } finally {
      await b.client.end();
    }
  });
});

const signal = (): AbortSignal => new AbortController().signal;
const submission = (intentId: string, mime: string) => ({ intentId, fence: 1, senderId: "s", senderAddress: "seller@example.com", route: "GMAIL_API" as const, mime });

describe("B12 K1 tokenFromSentMime (rule 24b)", () => {
  const mime = (token: string): string =>
    [
      "From: Seller <seller@example.com>",
      "To: lead@example.org",
      "Subject: Hello",
      `List-Unsubscribe: <mailto:unsubscribe@example.com>,\r\n <https://app.kaurodata.com/api/v1/public/outreach/opt-out/${token}>`,
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      "",
      "Body naming https://app.kaurodata.com/api/v1/public/outreach/opt-out/BODY-ONLY",
    ].join("\r\n");

  test("the token comes from the recorded message's List-Unsubscribe https URI (header folded), never from the body", async () => {
    const fake = new ContractFakeGmailSend();
    await fake.submit(submission("intent-1", mime("tok_ABC-123")), signal());
    assert.equal(tokenFromSentMime(fake, "intent-1"), "tok_ABC-123");
    assert.equal(mimeHeader(mime("x"), "list-unsubscribe-post"), "List-Unsubscribe=One-Click");
  });

  test("DENY: support refuses an unsent token (an intent the fake never received)", async () => {
    const fake = new ContractFakeGmailSend();
    await fake.submit(submission("intent-sent", mime("tok_1")), signal());
    assert.throws(() => tokenFromSentMime(fake, "intent-never-sent"), /never sent/);
  });

  test("a message without the header or without an https opt-out URI has no token", async () => {
    const fake = new ContractFakeGmailSend();
    await fake.submit(submission("intent-2", "Subject: x\r\n\r\nhttps://app.kaurodata.com/api/v1/public/outreach/opt-out/BODY"), signal());
    await fake.submit(submission("intent-3", "List-Unsubscribe: <mailto:u@example.com>\r\n\r\nbody"), signal());
    assert.throws(() => tokenFromSentMime(fake, "intent-2"), /no List-Unsubscribe/);
    assert.throws(() => tokenFromSentMime(fake, "intent-3"), /no https opt-out URI/);
  });
});

describe("B12 K1 ContractFakeGmailSend (SIMULATED)", () => {
  const sub = (intentId: string) => submission(intentId, "Subject: x\r\n\r\nb");

  test("a held call aborted by the caller records the abort before it answers UNKNOWN(ABORTED)", async () => {
    const fake = new ContractFakeGmailSend();
    const hold = fake.hold();
    const ac = new AbortController();
    const answer = fake.submit(sub("i-abort"), ac.signal);
    await hold.reached;
    ac.abort();
    assert.deepEqual(await answer, { kind: "UNKNOWN", reason: "ABORTED" });
    assert.deepEqual(
      fake.events.map((e) => e.kind),
      ["submit", "abort", "answer"],
    );
    assert.equal(fake.callsOf("i-abort")[0]?.aborted, true);
    hold.release();
  });

  test("a held call answers only after release", async () => {
    const fake = new ContractFakeGmailSend();
    const hold = fake.hold();
    const answer = fake.submit(sub("i-held"), signal());
    await hold.reached;
    assert.equal(fake.callsOf("i-held")[0]?.answer, null);
    hold.release();
    assert.equal((await answer).kind, "ACCEPTED");
  });

  test("a LATE script: the caller sees a lost answer, the fake keeps the provider's acceptance for later evidence", async () => {
    const fake = new ContractFakeGmailSend();
    fake.script("i-late", { kind: "LATE", providerMessageRef: "msg-late-1" });
    assert.deepEqual(await fake.submit(sub("i-late"), signal()), { kind: "UNKNOWN", reason: "LOST_ANSWER" });
    assert.equal(fake.lateAnswerOf("i-late"), "msg-late-1");
  });

  test("an unscripted call is ACCEPTED with a provider reference, and scripts bind per intent", async () => {
    const fake = new ContractFakeGmailSend();
    fake.script("i-rej", { kind: "REJECTED", status: 400, reason: "invalid recipient" });
    const ok = await fake.submit(sub("i-ok"), signal());
    const rej = await fake.submit(sub("i-rej"), signal());
    assert.equal(ok.kind, "ACCEPTED");
    assert.equal(rej.kind, "REJECTED");
    assert.equal(fake.label, "CONTRACT_FAKE");
    assert.equal(fake.evidenceClass, "SIMULATED");
  });
});
