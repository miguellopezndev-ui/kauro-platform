/**
 * Loads the generated contract bundle (`@kauro/contracts/schemas.json`, provenance-checked at build time) and compiles the
 * closed validator once (S093: reviewed application-owned schemas only; the bundle is a build artifact of the vendored
 * registry, never a value received at runtime).
 */
import { readFileSync } from "node:fs";
import type { CandidateActivation, SchemaValidator } from "@kauro/application";
import { OPERATIONAL_ROUTES, createSchemaValidator, type ContractSchemaBundle } from "@kauro/application";

/** candidate: the behaviour built against the O19A re-issue candidate this deployment switched on (Order 20); absent, the in-force schemas. */
export function loadContractSchemas(candidate?: CandidateActivation): SchemaValidator {
  const url = new URL(import.meta.resolve("@kauro/contracts/schemas.json"));
  const bundle = JSON.parse(readFileSync(url, "utf8")) as ContractSchemaBundle;
  return createSchemaValidator(bundle, OPERATIONAL_ROUTES, candidate);
}
