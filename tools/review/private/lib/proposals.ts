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
  /** Drawn without the private chrome, as the sign-in is (no session is needed to see it). */
  readonly anonymous?: boolean;
}

export const PROPOSALS: readonly Proposal[] = [
  {
    key: "P-05",
    group: "A",
    anchor: "UI50",
    origin: "APP",
    title: "Create account",
    why: "Sign-up is public and self-serve for agencies and companies (owner, 2026-10-20). The registry has no sign-up screen: it needs a route, the identity provider's sign-up and email verification.",
    route: "/signup (proposed)",
    primaryCopy: "Create your Kauro account.",
    information: "Google, or work email, full name and password; then an email code; then Kauro's two-step verification and the recovery codes; then the workspace setup (UI09). The path to the first project beside the form.",
    actions: "Continue with Google; create the account; verify the email; turn on two-step verification; keep the recovery codes.",
    exceptions: "Never says whether an address has an account; never grants seller, staff or owner access; an email domain never joins anyone to an agency.",
    anonymous: true,
  },
  {
    key: "P-06",
    group: "A",
    anchor: "UI50",
    origin: "APP",
    title: "Reset password",
    why: "Email and password need a safe recovery that ends every other session (owner, 2026-10-20). The registry has none.",
    route: "/login/reset (proposed)",
    primaryCopy: "Reset your password.",
    information: "The address; a code sent to it; the new password; the result.",
    actions: "Send a code; enter it; set a new password; sign in again.",
    exceptions: "Never says whether an address has an account; never changes two-step verification; pauses after repeated requests.",
    anonymous: true,
  },
  {
    key: "P-01",
    group: "A",
    anchor: "UI32",
    origin: "APP",
    title: "Personal settings",
    why: "Appearance, profile, sign-in methods, two-step verification, recovery codes, sessions and notices for every person. Only the theme and the current session exist in the contract today.",
    route: "/account (proposed)",
    primaryCopy: "Your own settings, the same in every agency.",
    information: "Appearance (exists); name and address as the identity provider holds them (needs a read); two-step verification state (exists in the session); this session's limits (exists); notices (needs a contract).",
    actions: "Change the theme (exists); sign out (exists); change password, replace the authenticator app, create new recovery codes, sign out of other sessions (need contracts, with step-up); choose notices (needs a contract).",
    exceptions: "No password, code or secret is ever shown or stored here; the identity provider keeps them.",
  },
  {
    key: "P-08",
    group: "B",
    anchor: "UI13",
    origin: "APP",
    title: "Activity",
    why: "The owner's decision on project navigation (2026-10-20): Activity is one of a project's areas, reachable and never a step. The registry has no activity screen and the api no activity read.",
    route: "/agencies/{agencyId}/projects/{id}/activity (proposed)",
    primaryCopy: "Everything that happened in this project, newest first.",
    information: "Typed events (files sealed, check ready, plan revision proposed, changes requested, revision approved, quote issued, transfer received, package released, links issued, stage result returned, deletion done), each with who, when and its reference; filters by area and person.",
    actions: "Filter; open the referenced page.",
    exceptions: "Nothing is editable; a void, a reissue or a cancellation keeps its reason; events of other projects never appear.",
  },
  {
    key: "P-09",
    group: "C",
    anchor: "UI30",
    origin: "APP",
    title: "Billing overview",
    why: "The menu's Billing opens UI30 without an order, and UI30 can only say \"choose an order\": the api reads one order at a time and lists none. A workspace first needs every quote and order of its projects, with what is due and by when, what is paid and its fiscal document.",
    route: "/agencies/{agencyId}/billing (without an order, proposed)",
    primaryCopy: "Track quotes, payments, fiscal documents and refunds.",
    information: "A summary (waiting for a transfer, quotes to accept, paid this year, refunded: each an amount and a count); one line a quote or order: project, client and service, state, amount, the date that matters (send by, valid until, paid, refunded), the fiscal document's number.",
    actions: "Open the quote (UI23), the payment (UI24) or the order's billing (UI30).",
    exceptions: "A quote is never shown as a charge, nor an order as an invoice; the free check never appears; only owners and billing members see it.",
  },
  {
    key: "P-07",
    group: "B",
    anchor: "UI18",
    origin: "APP",
    title: "Health check results",
    why: "The free check is how Kauro shows its value before any price (owner, 2026-10-20: personalise through the check, no coupons). UI18 shows the check's progress and its row counts; the api has no findings view, so the results the team reads need a read model before they can be built.",
    route: "/agencies/{agencyId}/projects/{id}/audit (results, proposed)",
    primaryCopy: "What the free check found in your files, and what fixing it involves.",
    information: "One sentence; each finding with its count, what it is counted out of, three examples, the consequence of importing as it is and how the plan fixes it; then the price band and what it includes; how long the results stay without buying.",
    actions: "Open the part of the plan that fixes a finding; review the plan; leave without buying.",
    exceptions: "Counts are of the whole file, never a sample; a candidate group is not a confirmed duplicate; the price never comes before the findings.",
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
