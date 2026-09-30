/**
 * Every document intake this edition serves, by operation id: B07's selection manifest (D-SEL-2) and B08's decision artifact
 * (D8-PLAN-1). The api registers a route for each, the generated OpenAPI document and the matrix read them, and the request
 * validation tests walk them — the one list, so a served intake can never be missing from one of them.
 */
import { AUDIT_INTAKE_ROUTES } from "../audit/handlers/intake.js";
import { SOURCE_INTAKE_ROUTES, type IntakeSpec } from "../sources/handlers/intake.js";
import type { IntakeOperationId } from "./response-schemas.js";

export const INTAKE_ROUTES: Readonly<Record<IntakeOperationId, IntakeSpec>> = Object.freeze({
  ...SOURCE_INTAKE_ROUTES,
  ...AUDIT_INTAKE_ROUTES,
});
