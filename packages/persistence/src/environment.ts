/**
 * The environment of a database connection as a branded value (DB-TLS gap 2 closed by construction, on 291b668): createPool and the
 * migrator connection accept only a DatabaseEnvironment, never a string. A literal "LOCAL", or one built at run time ("LOC" + "AL"), is
 * refused at compile time (the brand is a unique symbol) and at run time (the value is not in MINTED).
 *
 * Two minters, no third:
 * - production: claimEnvironmentMinter() hands its minter out ONCE per process. The api's configuration module claims it when it loads and
 *   mints only from the validated KAURO_ENVIRONMENT (apps/api/src/config.ts environmentOf). Any earlier claim makes that module fail to load,
 *   so the process cannot start with a second source of the environment.
 * - tests: testDatabaseEnvironment in the test-only subpath (@kauro/persistence/testing), which the architecture gate keeps out of every
 *   production import graph.
 */
export type DatabaseEnvironmentName = "LOCAL" | "SANDBOX" | "LIVE";

declare const BRAND: unique symbol;

/** A connection's environment, minted from validated configuration only. */
export interface DatabaseEnvironment {
  readonly name: DatabaseEnvironmentName;
  readonly [BRAND]: true;
}

const NAMES: ReadonlyArray<string> = Object.freeze(["LOCAL", "SANDBOX", "LIVE"]);
const MINTED = new WeakSet<object>();

function mint(name: string): DatabaseEnvironment {
  if (!NAMES.includes(name)) throw new TypeError("a database environment is LOCAL, SANDBOX or LIVE");
  const value = Object.freeze({ name }) as DatabaseEnvironment;
  MINTED.add(value);
  return value;
}

let claimed = false;

/** The production minter, handed out once per process (to the api's configuration module). */
export function claimEnvironmentMinter(): (name: string) => DatabaseEnvironment {
  if (claimed) throw new Error("the database environment minter was already claimed: the environment has one source, the validated configuration (DB-TLS gap 2)");
  claimed = true;
  return mint;
}

/** Test-only: re-exported by src/testing/index.ts alone (the scan refuses this name anywhere else). */
export function mintTestDatabaseEnvironment(name: DatabaseEnvironmentName): DatabaseEnvironment {
  return mint(name);
}

/** The name of a minted environment; anything else (a string, a look-alike object) is refused. */
export function nameOfDatabaseEnvironment(value: unknown): DatabaseEnvironmentName {
  if (typeof value !== "object" || value === null || !MINTED.has(value)) {
    throw new TypeError("a database connection takes its environment from the validated configuration (a DatabaseEnvironment), never a string (DB-TLS gap 2)");
  }
  return (value as DatabaseEnvironment).name;
}
