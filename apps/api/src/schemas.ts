/**
 * Loads the generated contract bundle (`@kauro/contracts/schemas.json`, provenance-checked at build time) and compiles the
 * closed validator once (S093: reviewed application-owned schemas only; the bundle is a build artifact of the vendored
 * registry, never a value received at runtime).
 */
import { readFileSync } from "node:fs";
import type { SchemaValidator } from "@kauro/application";
import { createSchemaValidator, type ContractSchemaBundle } from "@kauro/application";

export function loadContractSchemas(): SchemaValidator {
  const url = new URL(import.meta.resolve("@kauro/contracts/schemas.json"));
  const bundle = JSON.parse(readFileSync(url, "utf8")) as ContractSchemaBundle;
  return createSchemaValidator(bundle);
}
