// Kauro's canonical synthetic world (Order 11 round 3, master plan §2.1): one world, as of Thursday Oct 22, 2026, 09:00 in Bogotá, that
// every screen and every document reads, so the same project shows the same counts, money and dates on the owner console, the workspace,
// the seller portal, the public sample and the PDF. Typed, deeply frozen, no clock and no randomness. docs/design/ROUND3-CANONICAL-WORLD.md
// describes it; reconcile.ts checks it; export.mjs writes world.json for readers that cannot load TypeScript.
import { AS_OF, HOLIDAYS } from "./calendar.ts";
import { DELETIONS, INCIDENTS, JOBS, RELEASES, SUPPORT_CASES } from "./operations.ts";
import { CLIENTS, MEMBERSHIPS, OWNER, PEOPLE, WORKSPACES } from "./people.ts";
import { HOLDS, ORDERS, PAYMENTS, QUOTES, REFUND_CLAIMS, REFUNDS } from "./money.ts";
import { PROJECTS } from "./projects.ts";
import { CLAIMS, COMMISSION_LINES, OFFSETS, PAYOUTS, PROSPECTS, RETAINER_LINES, SELLERS, STATEMENTS } from "./sellers.ts";
import { STRESS } from "./stress.ts";
import type { World } from "./types.ts";

/** Freezes a value and everything it holds, so no reader can change the world another reader sees. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export const CANON: World = deepFreeze({
  name: "Kauro canonical world",
  asOf: AS_OF,
  timezone: "America/Bogota",
  holidays: HOLIDAYS,
  owner: OWNER,
  people: PEOPLE,
  workspaces: WORKSPACES,
  memberships: MEMBERSHIPS,
  clients: CLIENTS,
  projects: PROJECTS,
  quotes: QUOTES,
  orders: ORDERS,
  holds: HOLDS,
  payments: PAYMENTS,
  refunds: REFUNDS,
  refundClaims: REFUND_CLAIMS,
  sellers: SELLERS,
  claims: CLAIMS,
  prospects: PROSPECTS,
  commissionLines: COMMISSION_LINES,
  retainerLines: RETAINER_LINES,
  offsets: OFFSETS,
  statements: STATEMENTS,
  payouts: PAYOUTS,
  jobs: JOBS,
  incidents: INCIDENTS,
  deletions: DELETIONS,
  releases: RELEASES,
  supportCases: SUPPORT_CASES,
});

/** The stress variants, each a whole world of its own (stress.ts). */
export const STRESS_WORLDS = deepFreeze(STRESS);

export { AS_OF, AS_OF_LOCAL, HOLIDAYS, TIMEZONE } from "./calendar.ts";
export { ADAPTER, associationPath, CORE_OBJECT, CORE_VERSION, fileName, importPath, PACKAGE_PATH } from "./engine.ts";
export { computeAlerts, kauroFigures, sellerFigures, type Alert, type KauroFigures, type SellerFigures } from "./figures.ts";
export { MAIN_ORDER, MAIN_QUOTE } from "./money.ts";
export { CLIENT, P, SELLER, uid, WS } from "./people.ts";
export { ALERT_RULES, CLAIM_RULES_LEGAL_STATUS, COMMISSION, PROPOSED } from "./policy.ts";
export { boardStage, PRJ, SAMPLE_IN_GROUPS } from "./projects.ts";
export { LONG_NAMES, UNICODE_CASES } from "./stress.ts";
export { STEPS } from "./types.ts";
export type * from "./types.ts";

/** One project with everything a page about it needs, resolved from the world (no page should join these itself). */
export function projectView(world: World, projectId: string) {
  const project = world.projects.find((one) => one.id === projectId);
  if (project === undefined) return null;
  const quote = world.quotes.find((one) => one.projectId === projectId) ?? null;
  const order = world.orders.find((one) => one.projectId === projectId) ?? null;
  return {
    project,
    workspace: world.workspaces.find((one) => one.id === project.workspaceId) ?? null,
    client: world.clients.find((one) => one.id === project.clientId) ?? null,
    quote,
    order,
    hold: world.holds.find((one) => one.projectId === projectId) ?? null,
    payment: world.payments.find((one) => one.projectId === projectId) ?? null,
    refunds: world.refunds.filter((one) => one.projectId === projectId),
    refundClaims: world.refundClaims.filter((one) => one.projectId === projectId),
    commissionLines: world.commissionLines.filter((one) => one.projectId === projectId),
    jobs: world.jobs.filter((one) => one.projectId === projectId),
    deletions: world.deletions.filter((one) => one.projectId === projectId),
    supportCases: world.supportCases.filter((one) => one.projectId === projectId),
    incidents: world.incidents.filter((one) => one.projectIds.includes(projectId)),
  };
}
