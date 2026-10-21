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

/**
 * Round 2 (owner-console.md §4, §6, §10): the owner's pages the registry does not hold. Each is drawn from the review's fixture; the reads
 * they need are recorded in docs/design/ORDER11-ROUND2-OPS.md.
 */
const PROPOSALS_ROUND2: readonly Proposal[] = [
  {
    key: "P-24",
    group: "D",
    anchor: "UI34",
    origin: "OPS",
    title: "Claims",
    why: "Sellers work prospects; the owner decides claims. Round 1 put the decision inside one seller's prospect list. The api decides a claim by id (AcceptAttribution) and lists none across sellers.",
    route: "/ops/sales/claims (proposed)",
    primaryCopy: "Decide which seller found a customer first.",
    information: "Claims to decide, accepted, won, refused or expired; one opened with its evidence, the check against Kauro's records and what accepting means, in dates.",
    actions: "Accept the claim (CMD047, step-up); refuse it with a reason from a fixed list (proposed with counsel).",
    exceptions: "A seller is never told who else claimed; a refusal never names another seller or a customer.",
  },
  {
    key: "P-23",
    group: "D",
    anchor: "UI35",
    origin: "OPS",
    title: "Customers",
    why: "The owner cannot see the channels: which agencies and companies bought, how each came (direct or through a seller), who serves it and what it paid. The api lists no customers with their buyer type and channel.",
    route: "/ops/customers (proposed)",
    primaryCopy: "Every agency and company that has paid Kauro.",
    information: "Customer and kind, came through (direct or a seller), served by, projects paid, collected since the start, last payment; a total.",
    actions: "Filter by kind; open a customer (UI35).",
    exceptions: "An agency's own clients are never listed (D-33 §4.2).",
  },
  {
    key: "P-22",
    group: "D",
    anchor: "UI36",
    origin: "OPS",
    title: "Payouts",
    why: "The owner pays every seller each month and had no page that shows what is owed across sellers, by when, and what holds it. The api reads one statement by id.",
    route: "/ops/money/payouts (proposed)",
    primaryCopy: "What you owe sellers, when, and what is holding it.",
    information: "The cycle's dates; statements to approve; transfers sent and not yet confirmed; every statement with held, payable, pay date and paid reference; what is coming, as facts.",
    actions: "Open a seller's statements to approve the payout (CMD052, step-up); record a transfer as sent; confirm paid with the bank's proof (CMD053, inert today).",
    exceptions: "Paid only with the bank's proof; no forecast for a project not yet bought.",
  },
  {
    key: "P-21",
    group: "D",
    anchor: "UI37",
    origin: "OPS",
    title: "Sellers",
    why: "The owner cannot see the sellers: what each sold, the kinds and number of customers, what those brought in, what is owed and their rates. The api lists no sellers and aggregates nothing across them.",
    route: "/ops/sales/sellers (proposed)",
    primaryCopy: "Who sells for Kauro, what they brought in and what you owe them.",
    information: "One row per seller: status, owed now and held, next date, customers by kind, collected and commission for a chosen period, claims; a total; the default rates in one sentence.",
    actions: "Filter by status; change the period; open a seller (UI37); register a seller (RegisterSellerCandidate); download the list as CSV (proposed).",
    exceptions: "No clicks, rankings or charts; a status with no seller is not drawn.",
  },
];

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
    exceptions: "A quote is never shown as a charge, nor an order as an invoice; the free check never appears; every member sees it, and only owners and billing members act on it.",
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
    why: "A seller's own status, sign-in, payout destination, tax documents, sending identity and notifications, opened from the account menu. Payout change exists (seller, step-up); a profile read, documents and notification preferences need contracts.",
    route: "/ops/settings (proposed, seen as a seller)",
    primaryCopy: "Your seller account, payouts and sending identity.",
    information: "Seller status and agreement; sign-in method and sessions; the payout destination as a masked label and its state; tax documents on file; the sending identity and its state; which emails are always sent and which can be turned off.",
    actions: "Change the payout destination (ChangePayoutDestination, seller, step-up; Kauro checks it 48 hours later); sign out other sessions; turn optional reminders off (needs a contract).",
    exceptions: "No bank number, token or mailbox secret is shown; a masked label and a state only.",
  },
  {
    key: "P-04",
    group: "E",
    anchor: "UI38",
    origin: "OPS",
    title: "Settings",
    why: "The owner had no configuration page. Round 2 shows only what is true today, each section saying whether it is live (an existing command), read-only (a policy value with its version) or needs backend work.",
    route: "/ops/settings (proposed)",
    primaryCopy: "What Kauro runs on, as it is today.",
    information: "You: account and security. Selling: services on offer, prices and discounts, commissions and rates by seller, paying sellers, outreach rules. Money: the bank route. Platform: providers, limits and retention, break-glass. Company: business details, team, notifications, recovery.",
    actions: "Sign out other sessions; change what is offered (CMD058/059, step-up); open Finance for the bank route. Policy values change only through a reviewed new version.",
    exceptions: "No key, token, password or full account number is ever shown; sections that need backend work say so and change nothing.",
  },
  ...PROPOSALS_ROUND2,
  // the owner's decisions of 2026-10-21 (Orders 11-12, design only), drawn beside the real screens they would change
  {
    key: "P-30",
    group: "C",
    anchor: "UI23",
    origin: "APP",
    title: "Quote: the five dates that end something",
    why: "Owner decision of 2026-10-21: the quote's expiry, the free check's retention, the one extension (now also for the free check, to 17 days from sealing at most), the hold for a pending transfer and the paid project's retention, kept apart everywhere they appear.",
    route: "/agencies/{agencyId}/projects/{id}/purchase (proposed)",
    primaryCopy: "Review price, scope and availability.",
    information: "The next step for the moment the project is in; the five dates as one table with the rule and the state of each; how Kauro keeps the files before and after payment.",
    actions: "Accept the quote (owner, billing); ask for the one extension (owner, admin); open the payment and its hold.",
    exceptions: "A hold is not payment, starts only with proof of a sent transfer, is given once per quote and per set of files, is never renewed and never added to the extension; preparation never starts on it.",
  },
  {
    key: "P-31",
    group: "C",
    anchor: "UI24",
    origin: "APP",
    title: "Payment: the hold while a sent transfer arrives",
    why: "Owner decision of 2026-10-21: a separate, limited retention for an order whose bank transfer was legitimately sent and waits for confirmation (proposed: five business days, to be checked against the payment method and its evidence).",
    route: "/agencies/{agencyId}/payments/{orderId} (proposed)",
    primaryCopy: "Your status comes from verified payment information.",
    information: "The order's status; how to give the proof of a sent transfer and what it does; the hold's end and its limits; the five dates.",
    actions: "Give the proof of a sent transfer (owner, billing) once per quote; check the status again.",
    exceptions: "The proof is not payment; a second proof, another order on the same quote or a new quote for the same files starts no new hold; a hold that ends without the money deletes the files.",
  },
];

export function proposalOf(key: string): Proposal | undefined {
  return PROPOSALS.find((proposal) => proposal.key === key);
}
