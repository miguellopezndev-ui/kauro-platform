// The 42 private screens of the registry, in the owner's five review groups (Order 11 §1), with what each one is in this review. The
// screens come from the registry itself (packages/contracts/registry/screens.json): a screen added to it and missing from a group is an
// error the review index shows, never a screen silently left out (tools/test/review-private-inventory.test.mjs is the check that runs in node).
import registry from "../../../../packages/contracts/registry/screens.json";
import groups from "./groups.json";
import { IMPLEMENTED_SCREENS } from "@web/screens.ts";

export type Technical = "IMPLEMENTED" | "PROTOTYPE" | "BLOCKED_EXTERNAL";
export type Review = "NOT_PRESENTED" | "PRESENTED" | "CHANGES_REQUESTED" | "REVISED_AWAITING_REVIEW" | "OWNER_APPROVED";
export type GroupKey = "A" | "B" | "C" | "D" | "E";

export const TECHNICAL_LABEL: Readonly<Record<Technical, string>> = {
  IMPLEMENTED: "IMPLEMENTED — REVIEW DATA",
  PROTOTYPE: "VISUAL PROTOTYPE — NOT FUNCTIONAL",
  BLOCKED_EXTERNAL: "BLOCKED EXTERNAL",
};

/** The five review groups, in the owner's order (Order 11 §1); a JSON file so tools/test checks it against the registry without a build. */
export const GROUPS = groups as ReadonlyArray<{ readonly key: GroupKey; readonly title: string; readonly ids: readonly string[] }>;

interface RegistryScreen {
  readonly id: string;
  readonly origin: "PUBLIC" | "APP" | "OPS";
  readonly route: string;
  readonly title: string;
  readonly primaryCopy: string;
  readonly information: string;
  readonly actions: string;
  readonly exceptions: string;
}

const SCREENS = registry as readonly RegistryScreen[];

/** Screens whose real behaviour needs a provider or infrastructure the review cannot have (shown designed, marked blocked). */
const BLOCKED: ReadonlySet<string> = new Set(["UI50"]);

export interface PrivateScreen extends RegistryScreen {
  readonly group: GroupKey;
  readonly technical: Technical;
}

export const PRIVATE_SCREENS: readonly PrivateScreen[] = GROUPS.flatMap((group) =>
  group.ids.map((id) => {
    const found = SCREENS.find((screen) => screen.id === id);
    if (found === undefined || found.origin === "PUBLIC") throw new Error(`the review names ${id}, which is not a private screen of the registry`);
    const technical: Technical = IMPLEMENTED_SCREENS.has(id) ? "IMPLEMENTED" : BLOCKED.has(id) ? "BLOCKED_EXTERNAL" : "PROTOTYPE";
    return { ...found, group: group.key, technical };
  }),
);

export const PRIVATE_IDS: readonly string[] = PRIVATE_SCREENS.map((screen) => screen.id);

/** The registry's private screens the groups do not list, and the ones listed twice: both must be empty. */
export const INVENTORY_GAPS = {
  missing: SCREENS.filter((screen) => screen.origin !== "PUBLIC" && !PRIVATE_IDS.includes(screen.id)).map((screen) => screen.id),
  repeated: PRIVATE_IDS.filter((id, index) => PRIVATE_IDS.indexOf(id) !== index),
  registryPrivate: SCREENS.filter((screen) => screen.origin !== "PUBLIC").length,
  registryTotal: SCREENS.length,
};

export function screenOf(id: string): PrivateScreen | undefined {
  return PRIVATE_SCREENS.find((screen) => screen.id === id);
}

export function neighbours(id: string): { readonly previous: string | null; readonly next: string | null } {
  const index = PRIVATE_IDS.indexOf(id);
  return { previous: index > 0 ? (PRIVATE_IDS[index - 1] ?? null) : null, next: index >= 0 && index < PRIVATE_IDS.length - 1 ? (PRIVATE_IDS[index + 1] ?? null) : null };
}
