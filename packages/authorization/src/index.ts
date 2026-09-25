/**
 * @kauro/authorization — the authorization decisions of the Kauro platform (08 "Identity is not permission", "Role and
 * capability model", "Authentication and assurance", "Abuse controls"): the Authorizer over the unit of work, the step-up
 * assurance verifier and the admission limiter. It implements the ports of @kauro/application over @kauro/domain and never
 * touches a database driver, a framework or a session store.
 */
export { createAuthorizer } from "./authorizer.js";
export type { AuthorizerDependencies } from "./authorizer.js";
export { createAssuranceVerifier } from "./assurance.js";
export { createAdmissionLimiter, DEFAULT_ADMISSION_LIMITS } from "./admission.js";
export type { AdmissionLimits, AdmissionWindow } from "./admission.js";
