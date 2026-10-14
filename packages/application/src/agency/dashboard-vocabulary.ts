/**
 * The closed vocabulary of the project dashboard (ListProjects, R2 11 "Project dashboard", UI11; B11 lane A1): the five filters, the
 * phases and the required agency actions. Dependency-free on purpose: the response schemas (api/response-schemas) read it while
 * their module is evaluated, and agency/buyer-type re-exports it.
 */

/** The dashboard filters of R2 11 "Project dashboard": active, awaiting agency, delivered, failed, archived. */
export const PROJECT_DASHBOARD_FILTERS = Object.freeze(["active", "awaiting_agency", "delivered", "failed", "archived"] as const);
export type ProjectDashboardFilter = (typeof PROJECT_DASHBOARD_FILTERS)[number];
/** The phase of a project, from its durable facts (the persistence query derives it; the order is the lifecycle's). */
export const PROJECT_PHASES = Object.freeze(["SOURCES", "HEALTH_CHECK", "PLAN", "PURCHASE", "PROCESSING", "DELIVERED", "FAILED", "ARCHIVED"] as const);
export type ProjectPhase = (typeof PROJECT_PHASES)[number];
/** The one action the agency must take next, or NONE when the next step is Kauro's or the project is terminal. */
export const PROJECT_REQUIRED_ACTIONS = Object.freeze(["UPLOAD_SOURCES", "START_HEALTH_CHECK", "VALIDATE_PLAN", "APPROVE_PLAN", "REQUEST_QUOTE", "PAY_QUOTE", "START_PROCESSING", "NONE"] as const);
export type ProjectRequiredAction = (typeof PROJECT_REQUIRED_ACTIONS)[number];
