// Order 15 F-04 (FAILURE-MATRIX-TEMPLATE rule 16; 07 "revocation is effective server-side immediately for new commands"; ASVS 5.0 V7 session
// termination): a logout that commits while a core command sent under that browser session is in flight. The membership and the identity
// are fenced by their transition locks inside the command's unit (D-TX-2); the session was not — the core pipeline (B06, B07, B08, B16
// commands) judged the cookie at the transport only, so the command committed for a session already ended. Now the command's unit fences
// the presented session (FOR SHARE, the last lock before its journal commit) and judges it there: a logout committed before that refuses the
// command with nothing written; one that starts after waits for the command's COMMIT. Real routes, real composition root, the real session
// boundary of B11 (contract-fake identity provider), real PostgreSQL 17.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { waitForLockWait } from "@kauro/persistence/testing";
import { SESSIONS_APPLICATION_NAME } from "../src/index.js";
import { call, freshKey, outcome, routes, world, type BrowserSession, type Reply, type World } from "./support.js";

let w: World;
before(async () => {
  w = await world({ sessions: true });
});
after(async () => {
  await w.stop();
});

function createClient(s: BrowserSession, key: string, name: string): Promise<Reply> {
  return call(w, {
    url: routes.createClient(w.A.agencyId),
    token: null,
    agency: null,
    key,
    body: { displayName: name, processingAuthorityRef: w.authorityA },
    headers: { cookie: s.cookie, origin: w.identity().origin, "x-kauro-csrf": s.view.csrfToken },
  });
}

function logout(s: BrowserSession): Promise<Reply> {
  return call(w, { url: "/api/v1/sessions/current/revoke", token: null, agency: null, key: null, contentType: null, headers: { cookie: s.cookie, origin: w.identity().origin, "x-kauro-csrf": s.view.csrfToken } });
}

const clientsNamed = async (name: string): Promise<number> => w.count("end_clients", "display_name = $1", [name]);

test("O15 F-04: a core command whose browser session is logged out while it waits inside its unit is refused at its commit, with nothing written", async () => {
  const session = await w.identity().signIn(w.operator);
  const key = freshKey("o15-f04");
  const name = "O15 client after logout";
  const hold = w.holds.arm("journal.reserved");
  const pending = createClient(session, key, name);
  await hold.reached;
  // the logout commits while the command holds its reservation (no session lock is held yet: the fence is the last lock)
  const out = await logout(session);
  assert.ok(out.status === 200 || out.status === 204, `the logout: ${out.status} ${out.text}`);
  hold.release();
  const reply = await pending;
  assert.equal(reply.status, 401, `the command after its session ended: ${reply.text}`);
  assert.equal(outcome(w, reply), "401 AUTHENTICATION_REQUIRED -");
  assert.equal(await clientsNamed(name), 0, "no client");
  assert.equal(await w.journal(key), null, "no journal entry");
});

test("O15 F-04 control: the same command under a live session commits, and a logout sent while the command holds the fence waits for its COMMIT", async () => {
  const session = await w.identity().signIn(w.operator);
  const name = "O15 client before logout";
  const hold = w.holds.arm("journal.commit");
  const pending = createClient(session, freshKey("o15-f04-control"), name);
  await hold.reached;
  // the command holds the session row FOR SHARE until its COMMIT: the logout's update of that row waits on it
  const out = logout(session);
  try {
    await waitForLockWait(w.h.oracle, SESSIONS_APPLICATION_NAME, "web_sessions");
  } finally {
    hold.release();
  }
  const reply = await pending;
  assert.equal(reply.status, 201, reply.text);
  assert.equal(await clientsNamed(name), 1);
  const ended = await out;
  assert.ok(ended.status === 200 || ended.status === 204, ended.text);
  // the next request of the ended session is refused at the transport, as before
  assert.equal((await createClient(session, freshKey("o15-f04-after"), "O15 never")).status, 401);
});
