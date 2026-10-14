// The composition root of the control plane (apps/control/src/composition.ts; design §12, §15, D-SAPI-6; mandate B07-CONTROL) on a
// real PostgreSQL 17: the control plane's database is a verified kauro_control pool (08 "Database isolation": a request handlers'
// login is refused at start, not at the first unit of work), the plane assembles exactly one sweeper per SOURCE_SWEEPERS name and the
// four consumers of the source lifecycle, and its production sources import no test-only subpath — the providers are what the caller
// hands in (here the labelled contract fakes, SIMULATED; a deployment of this edition has none to hand in until B15).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { CONSUMERS, EVENT_SUBSCRIPTIONS, type CorrelationId } from "@kauro/domain";
import { SOURCE_SWEEPERS } from "@kauro/application";
import { ROLES, testDatabaseEnvironment } from "@kauro/persistence/testing";
import { CONTROL_APPLICATION_NAME, openControlDatabase } from "../src/index.js";
import { clock, ids, startControlEnv, type ControlEnv } from "./support/env.js";

let env: ControlEnv;

before(async () => {
  env = await startControlEnv();
});

after(async () => {
  await env.stop();
});

/** The package's production sources (src/), read from the source tree next to the compiled test. */
function productionSources(): ReadonlyArray<{ readonly path: string; readonly text: string }> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".ts")) out.push({ path, text: readFileSync(path, "utf8") });
    }
  };
  walk(root);
  return out;
}

test("the composition root opens only a kauro_control pool, assembles one sweeper for each SOURCE_SWEEPERS name and the four source-lifecycle consumers, imports no test-only subpath, and one cycle over a settled database acts on nothing and fails nothing", { timeout: 300_000 }, async () => {
  // the control plane's pool: a request handlers' login is refused at start; the control plane's own is accepted
  const base = { host: "127.0.0.1", port: env.h.pg.port, database: ROLES.database, poolMax: 2, environment: testDatabaseEnvironment("LOCAL") };
  await assert.rejects(openControlDatabase({ ...base, user: ROLES.appLogin }), /must be a member of kauro_control/);
  const opened = await openControlDatabase({ ...base, user: ROLES.controlLogin });
  try {
    const seen = await opened.units.runSource({ kind: "SYSTEM", serviceId: "composition-test", correlationId: ids.next() as CorrelationId }, async (uow) => uow.serverInstant());
    assert.match(seen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const named = await env.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = $1", [CONTROL_APPLICATION_NAME]);
    assert.ok(Number(named.rows[0]?.n) >= 1, "its connections announce the control plane");
  } finally {
    await opened.close();
  }

  // exactly the sweepers of design §12.5, and a consumer for every source-lifecycle destination of EVENT_SUBSCRIPTIONS it owns
  assert.deepEqual(Object.keys(env.plane.sweeperByName).sort(), [...SOURCE_SWEEPERS].sort());
  const consumers = Object.values(env.plane.consumers).map((c) => c.consumer).sort();
  assert.deepEqual(consumers, ["AUTHORITY_JOURNAL", "DELETION_EXECUTOR", "SELECTION_EVALUATION", "STORAGE_LIFECYCLE", "UPLOAD_INSPECTION"]);
  for (const consumer of consumers) {
    assert.ok((CONSUMERS as ReadonlyArray<string>).includes(consumer));
    assert.ok(EVENT_SUBSCRIPTIONS.some((s) => s.consumer === consumer), `${consumer} is a registered destination`);
  }

  // no production source of the package imports a test-only subpath (architecture rule testOnlySubpaths): no fake is bound by it
  for (const source of productionSources()) {
    assert.ok(!/from\s+["'][^"']+\/testing["']/.test(source.text), `${source.path} imports a test-only subpath`);
    assert.ok(!/ContractFake/.test(source.text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")), `${source.path} names a contract fake in code`);
  }

  // one cycle over a database with nothing due: the location read-back (at start), then nothing to sweep or dispatch
  const cycle = await env.plane.runCycle(clock.now());
  assert.equal(cycle.sweeps.LOCATION_POLICY?.acted, 2, "both locations read back at start");
  for (const [name, result] of Object.entries(cycle.sweeps)) assert.deepEqual(result?.failed, [], name);
  for (const name of ["UPLOAD_DEADLINES", "PROVIDER_SESSION_RECONCILIATION", "RETENTION", "OBJECT_INVENTORY", "DELETION_RETRIES"] as const) assert.equal(cycle.sweeps[name]?.acted, 0, name);
  for (const [consumer, counts] of Object.entries(cycle.dispatched)) assert.deepEqual([counts.retried, counts.deadLettered], [0, 0], consumer);
  const again = await env.plane.runCycle(clock.now());
  assert.equal(again.sweeps.LOCATION_POLICY?.acted, 0, "a read-back younger than a day is not renewed");
});
