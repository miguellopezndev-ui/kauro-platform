// Order 24: the api world of the web's private-journey browser suite (apps/web e2e/private-journey.spec.ts). Not a test: a process that starts
// the api over the test harness (PostgreSQL 17 from PGBIN, the contract-fake identity issuer of the session boundary, SIMULATED), seeds a
// synthetic journey — agency A with a CLEAN project whose files are sealed and a HUBSPOT project with a validated plan, agency B with a
// project of its own — signs in A's owner, A's viewer and B's owner through POST /api/v1/sessions, writes their session secrets and the ids
// to the file KAURO_E2E_WORLD names, and listens on 127.0.0.1:KAURO_E2E_API_PORT until it is stopped. Every value is synthetic.
// With KAURO_E2E_CANDIDATE=on the api runs with the O19A candidate's CLEAN without a target switched on (LOCAL, Order 20) and the CLEAN
// project's free check is started with no target contract; its audit id is written too.
import { writeFileSync } from "node:fs";
import { auditIdOf, fundPool, startAudit } from "./audit-support.js";
import { world } from "./support.js";

const port = Number(process.env["KAURO_E2E_API_PORT"] ?? 44310);
const out = process.env["KAURO_E2E_WORLD"];
if (out === undefined) throw new Error("KAURO_E2E_WORLD names the file the world is written to");

const candidate = process.env["KAURO_E2E_CANDIDATE"] === "on";
const w = await world({ sessions: true, ...(candidate ? { candidate: { cleanWithoutTarget: true } } : {}) });
const clean = await w.project(w.A, w.clientA);
const cleanSource = await w.revision(w.A, clean.projectId, "SEALED", { recent: true });
let cleanAudit: string | null = null;
if (candidate) {
  await fundPool({ w, poolId: null });
  cleanAudit = auditIdOf(await startAudit(w, cleanSource.revisionId, {}));
}
const hubspot = await w.project(w.A, w.clientA, { mode: "HUBSPOT" });
await w.approvable(w.A, hubspot.projectId, "o24-e2e", "SET", { recent: true, mode: "HUBSPOT" });
const foreign = await w.project(w.B, w.clientB);
const identity = w.identity();
const owner = await identity.signIn(w.owner);
const viewer = await identity.signIn(w.viewer);
const stranger = await identity.signIn(w.stranger);
writeFileSync(
  out,
  JSON.stringify({
    agencyA: w.A.agencyId,
    agencyB: w.B.agencyId,
    projects: { clean: clean.projectId, hubspot: hubspot.projectId, foreign: foreign.projectId },
    cleanAudit,
    sessions: { owner: owner.secret, viewer: viewer.secret, stranger: stranger.secret },
  }),
);
await w.app.listen({ host: "127.0.0.1", port });
process.stdout.write(`o24 e2e api world listening on 127.0.0.1:${port}\n`);
const stop = (): void => {
  void w.stop().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
