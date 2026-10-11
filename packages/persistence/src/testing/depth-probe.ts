/**
 * Depth probes of SEC-DEPTH-PROVENANCE (P1, section C "Independence proof"; test-only, @kauro/persistence/testing).
 *
 * `nestedAsSuperuser(oracle, group, sql)`: the superuser oracle creates, in schema `depth_probe`, a SECURITY DEFINER function it owns
 * that runs `sql` (the statement runs in the probe trigger at depth 1; the kauro guards its writes fire run at depth 2), a probe table and an AFTER INSERT trigger calling it, and grants INSERT on the probe to the runtime group. The
 * RUNTIME session then inserts one probe row (`fire`), so `sql` runs at trigger depth 2 AS SUPERUSER (no RLS, no column grant,
 * is_control_session() true, kauro triggers ENABLED). It proves a check does not depend on depth, role, RLS or grants. It claims
 * nothing against TCB code that stops triggers (P2). The probe only ever lives in the temporary cluster of a test.
 *
 * `slowCheckHook(oracle, group, ms)`: the same shape with an INVOKER trigger that sleeps `ms` milliseconds, so a test can hold a
 * runtime transaction at a known point (a deterministic widening of a race window; never a substitute for lock observation).
 */
import type { Client } from "pg";
import type { SqlSession } from "./source-lifecycle.js";

let sequence = 0;

export interface DepthProbe {
  /** The probe table name, schema-qualified. */
  readonly table: string;
  /** Inserts one probe row from `runtime` (inside the caller's transaction); the nested statement runs at depth 2. */
  fire(runtime: SqlSession): Promise<void>;
  /** Drops the probe (the oracle's schema objects). Safe to call twice. */
  drop(): Promise<void>;
}

function assertIdentifier(value: string, what: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error(`${what} ${JSON.stringify(value)} is not a plain identifier`);
}

async function install(oracle: Client, group: string, body: string, definer: boolean): Promise<DepthProbe> {
  assertIdentifier(group, "runtime group");
  const n = ++sequence;
  const table = `depth_probe.probe_${n}`;
  const fn = `depth_probe.run_${n}`;
  await oracle.query("CREATE SCHEMA IF NOT EXISTS depth_probe");
  await oracle.query("GRANT USAGE ON SCHEMA depth_probe TO " + group);
  await oracle.query(`CREATE TABLE ${table} (n int)`);
  await oracle.query(`GRANT INSERT ON ${table} TO ${group}`);
  await oracle.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql ${definer ? "SECURITY DEFINER" : ""} SET search_path = pg_catalog, kauro AS $probe$ BEGIN ${body}; RETURN NULL; END $probe$`);
  await oracle.query(`CREATE TRIGGER probe_${n} AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  let dropped = false;
  return {
    table,
    async fire(runtime: SqlSession): Promise<void> {
      await runtime.query(`INSERT INTO ${table} (n) VALUES (1)`);
    },
    async drop(): Promise<void> {
      if (dropped) return;
      dropped = true;
      await oracle.query(`DROP TABLE IF EXISTS ${table}`);
      await oracle.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    },
  };
}

/** `sql` is a plpgsql statement list (semicolon-separated, no trailing RETURN) that runs as the superuser at depth 2. */
export async function nestedAsSuperuser(oracle: Client, group: string, sql: string): Promise<DepthProbe> {
  if (sql.includes("$probe$")) throw new Error("the nested statement may not contain the probe's quote tag");
  return install(oracle, group, sql.replace(/;\s*$/, ""), true);
}

/** Holds the runtime transaction for `ms` milliseconds at the probe insert (an INVOKER trigger: the runtime role's own authority). */
export async function slowCheckHook(oracle: Client, group: string, ms: number): Promise<DepthProbe> {
  if (!Number.isInteger(ms) || ms < 1 || ms > 60_000) throw new Error("ms must be an integer in 1..60000");
  return install(oracle, group, `PERFORM pg_sleep(${ms / 1000})`, false);
}
