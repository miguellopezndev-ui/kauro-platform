// Designs the owner asked for that the registry does not hold yet (Order 11 §4): shown for visual approval only. None of them is a route,
// a contract or a command of the application; each names the screen it sits beside, what it would show, and what it would need before it
// could be built (the dependencies are listed in docs/design/ORDER11-FINAL-AUDIT.md). The owner's approval of a proposal is a visual
// approval; the functional authority (registry, contract, commands) is changed only by its own procedure.
import type { GroupKey } from "./inventory-types.ts";

export interface Proposal {
  readonly key: string;
  readonly group: GroupKey;
  /** The screen this proposal sits after in the review, and extends or completes. */
  readonly anchor: string;
  readonly origin: "APP" | "OPS";
  readonly title: string;
  readonly why: string;
  readonly route: string;
  readonly primaryCopy: string;
  readonly information: string;
  readonly actions: string;
  readonly exceptions: string;
}

export const PROPOSALS: readonly Proposal[] = [
  {
    key: "P-01",
    group: "A",
    anchor: "UI32",
    origin: "APP",
    title: "Personal settings",
    why: "Appearance, profile, security, sessions and notices for every person. Only the theme and the current session exist in the contract today.",
    route: "/account (proposed)",
    primaryCopy: "Your own settings, the same in every agency.",
    information: "Appearance (exists); name and address as the identity provider holds them (needs a read); two-step verification state (exists in the session); this session's limits (exists); notices (needs a contract).",
    actions: "Change the theme (exists); sign out (exists); sign out of other devices (needs a contract); choose notices (needs a contract).",
    exceptions: "No password, code or secret is ever shown or stored here; the identity provider keeps them.",
  },
  {
    key: "P-02",
    group: "A",
    anchor: "UI32",
    origin: "APP",
    title: "Organisation settings, complete",
    why: "UI32 within its current contract: edit the name and the logo (served, not wired yet), who buys, legal identity, security and closure, for an agency or a company.",
    route: "/agencies/{agencyId}/settings",
    primaryCopy: "Manage agency details and safe branding.",
    information: "Display name, logo, buyer type, accepted agreements, billing identity, security rule for members, closure.",
    actions: "Update name and logo (CMD008, owner or admin); follow a legal-profile change through support; request closure (CMD043, owner, step-up).",
    exceptions: "Renaming does not reset discounts, attribution or client identity; a logo must be a PNG the agency has the rights to.",
  },
  {
    key: "P-03",
    group: "D",
    anchor: "UI37",
    origin: "OPS",
    title: "Seller settings",
    why: "A seller's own profile, security, payout destination, authorised sender and enablement. Payout change exists (seller, step-up); the rest needs reads.",
    route: "/ops/sales/settings (proposed)",
    primaryCopy: "Your seller account, payouts and sending identity.",
    information: "Enablement state (GetSellerHome); payout destination as a masked label; the sending identity Kauro authorised for you and its state; notices.",
    actions: "Change the payout destination (ChangePayoutDestination, seller, step-up); ask Kauro to verify a sending identity (owner registers it).",
    exceptions: "No bank number, token or mailbox secret is shown; a masked label and a state only.",
  },
  {
    key: "P-04",
    group: "E",
    anchor: "UI38",
    origin: "OPS",
    title: "Owner settings",
    why: "The owner's profile and security, the state of each provider, the operating parameters in force, security controls, audit and recovery. Provider states come from served reads; nothing shows a secret.",
    route: "/ops/settings (proposed)",
    primaryCopy: "How Kauro is connected, protected and recovered.",
    information: "Identity provider, bank route, email sending, payment provider: state, environment, last check, alerts. Operating parameters from the policy. Break-glass grants. Recovery contacts.",
    actions: "Open the provider's own screen (bank route, senders); review break-glass grants; go to the operating review. Changes go through their own commands with step-up.",
    exceptions: "No key, token, account number or password is ever shown; a provider is a state, an environment and dates.",
  },
];

export function proposalOf(key: string): Proposal | undefined {
  return PROPOSALS.find((proposal) => proposal.key === key);
}
