"use client";
// P-04 Settings (proposed; round 2, owner-console.md §9). The owner's configuration, showing only what is true today. Every section says
// what it is backed by, in words: "Live" (a control backed by an existing command, with a fresh confirmation of identity), "Read-only" (the
// value in force, with its policy version: a policy value changes only through a reviewed new version, never here) or "Needs backend" (a
// design waiting for a contract, saying so). Grouped by what it affects: you, selling, money, the platform, the company; the sections that
// need backend work come last. No key, token, password or full account number is shown anywhere: a provider is a state and dates, an
// account a masked label.
//
// What left the round 1 page: links that only jumped to other pages ("Security controls"), the mixed "Operating parameters" list (quote
// validity beside the session timeout, now each in its own section), and the paragraph about secrets (now one line at the foot).
import { Button } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement } from "react";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Kind, OPS_PATH, OpsHead, OpsPage, PendingLegal, Word } from "./ops-kit.tsx";
import { CLAIM_DAYS, ELIGIBLE_DAYS, FIRST_RATE, REPEAT_RATE, SELLERS, SERVICE_NAME, TAIL_DAYS, WINDOW_MONTHS, amount, type Service } from "./sales.ts";

export const P04_STATES: readonly StateDef[] = [
  { key: "normal", label: "Settings", note: "Today's synthetic picture: the bank route verified in sandbox, sign-in not connected, every policy value shown with its version." },
  { key: "alerts", label: "A provider needs attention", note: "The bank route's details expired and a sending identity was revoked: each says what it stops and what to do." },
];

const GROUPS = [
  { title: "You", sections: [["account", "Your account and security"]] },
  { title: "Selling", sections: [["services", "Services on offer"], ["prices", "Prices and discounts"], ["commissions", "Commissions"], ["paying", "Paying sellers"], ["outreach", "Outreach rules"]] },
  { title: "Money", sections: [["bank", "Getting paid"]] },
  { title: "Platform", sections: [["providers", "Providers"], ["alerts", "Alerts"], ["limits", "Limits and retention"], ["access", "Access and break-glass"]] },
  { title: "Company", sections: [["business", "Business details"], ["team", "Team"], ["notifications", "Notifications"], ["recovery", "Recovery"]] },
] as const;

const SERVICES: readonly Service[] = ["CLEAN", "HUBSPOT", "SALESFORCE"];
const gb = (bytes: number): string => `${bytes / 1_000_000_000} GB`;

function Facts({ rows }: { readonly rows: readonly (readonly [string, ReactElement | string])[] }): ReactElement {
  return (
    <dl className="kauro-ops-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Head({ id, title, kind, kindText, purpose }: { readonly id: string; readonly title: string; readonly kind: "live" | "read" | "backend"; readonly kindText: string; readonly purpose: string }): ReactElement {
  return (
    <>
      <h2 id={`${id}-h`} className="kauro-ops-setting-title">
        {title}
      </h2>
      <Kind kind={kind}>{kindText}</Kind>
      <p className="kauro-ops-setting-purpose">{purpose}</p>
    </>
  );
}

export function OwnerSettings({ state }: PrototypeProps): ReactElement {
  const alerts = state === "alerts";
  const bands = POLICY_SNAPSHOT.bands;
  const range = (index: number): string => `${index === 0 ? "1" : ((bands[index - 1]?.maximum ?? 0) + 1).toLocaleString("en-US")}–${(bands[index]?.maximum ?? 0).toLocaleString("en-US")}`;
  return (
    <OpsPage>
      <OpsHead title="Settings" lead="What Kauro runs on, as it is today. Each section says whether you can change it here, and how." />
      <div className="kauro-ops-settings">
        <nav className="kauro-ops-settings-nav" aria-label="Sections of the settings">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <p>{group.title}</p>
              <ul>
                {group.sections.map(([id, title]) => (
                  <li key={id}>
                    <a href={`#${id}`}>{title}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="kauro-ops-settings-body">
          <p className="kauro-ops-group-title">You</p>
          <section id="account" aria-labelledby="account-h">
            <Head id="account" title="Your account and security" kind="read" kindText="Read-only, except your sessions" purpose="How you sign in, and how long a session lasts. These apply only to you." />
            <Facts
              rows={[
                ["Signed in as", "Kauro owner · owner@kauro.example"],
                ["Two-step verification", <Word key="m" tone="success">On</Word>],
                ["A sensitive act", "Asks for a fresh confirmation of identity, valid 15 minutes"],
                ["A session ends", "After 30 minutes without activity, and 12 hours after sign-in at the latest"],
                ["Active sessions", "1, this browser"],
              ]}
            />
            <div className="kauro-actions">
              <Button>Sign out other sessions</Button>
            </div>
          </section>

          <p className="kauro-ops-group-title">Selling</p>
          <section id="services" aria-labelledby="services-h">
            <Head id="services" title="Services on offer" kind="live" kindText="Live · with a fresh confirmation" purpose="Which services customers can buy. Restricting one stops new quotes for it; issued quotes keep their terms." />
            <div className="kauro-ops-tablewrap">
              <div className="kauro-table-region">
                <table className="kauro-table kauro-ops-table kauro-ops-table--cards kauro-ops-table--compact">
                  <caption className="kauro-visually-hidden">Services on offer</caption>
                  <thead>
                    <tr>
                      <th scope="col">Service</th>
                      <th scope="col">State</th>
                      <th scope="col">Since</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SERVICES.map((service) => (
                      <tr key={service}>
                        <th scope="row">{SERVICE_NAME[service]}</th>
                        <td data-label="State">
                          <span>
                            <Word tone="success">Available</Word>
                          </span>
                        </td>
                        <td data-label="Since">
                          <span>Oct 1, 2026</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="kauro-actions">
              <Button>Change what is offered</Button>
            </div>
          </section>

          <section id="prices" aria-labelledby="prices-h">
            <Head id="prices" title="Prices and discounts" kind="read" kindText={`Read-only · price schedule ${POLICY_SNAPSHOT.scheduleVersion}`} purpose="What a project costs, by billable source units, before tax. A change goes through a new reviewed policy version." />
            <div className="kauro-ops-tablewrap">
              <div className="kauro-table-region">
                <table className="kauro-table kauro-ops-table kauro-ops-table--cards kauro-ops-table--compact">
                  <caption className="kauro-visually-hidden">Price bands in USD, by billable source units</caption>
                  <thead>
                    <tr>
                      <th scope="col">Billable source units</th>
                      {SERVICES.map((service) => (
                        <th key={service} scope="col" className="kauro-table-end">
                          {SERVICE_NAME[service]} (USD)
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bands.map((band, index) => (
                      <tr key={band.maximum}>
                        <th scope="row">
                          {range(index)}
                          {band.maximum > POLICY_SNAPSHOT.launchSourceUnits ? <span className="kauro-ops-sub">Not offered at launch</span> : null}
                        </th>
                        {SERVICES.map((service) => (
                          <td key={service} className="kauro-table-end" data-label={SERVICE_NAME[service]}>
                            <span className={band.maximum > POLICY_SNAPSHOT.launchSourceUnits ? "kauro-ops-zero" : undefined}>{amount(band.minor[service])}</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <Facts
              rows={[
                ["Repeat discount", `${POLICY_SNAPSHOT.repeatTiers.filter((tier) => tier.percent > 0).map((tier) => `${tier.percent}% from ${tier.minimum} earlier ${tier.minimum === 1 ? "project" : "projects"}`).join(", ")}, counted over ${POLICY_SNAPSHOT.repeatLookbackDays} days`],
                ["First three customers", "25% on the first eligible project of each of the first 3 accepted customers, while a place can be reserved. Places used: needs a read"],
                ["Two discounts", "Never added together: the larger one applies"],
                ["A quote is valid", `${POLICY_SNAPSHOT.quoteDays} days`],
              ]}
            />
          </section>

          <section id="commissions" aria-labelledby="commissions-h">
            <Head id="commissions" title="Commissions" kind="read" kindText="Defaults read-only · rates live through each seller's agreement" purpose="How sellers are paid. A seller's own rates live in their signed agreement; changing them is an amendment both sides sign." />
            <Facts
              rows={[
                ["Rates", `${FIRST_RATE}% of a customer's first project · ${REPEAT_RATE}% of its repeats for ${WINDOW_MONTHS} calendar months from its first confirmed payment`],
                ["Counted on", "The service collected, after discount, net of refunds, without tax"],
                ["A claim lasts", <span key="claim">{CLAIM_DAYS} days from its acceptance <PendingLegal /></span>],
                ["A line is payable", `${ELIGIBLE_DAYS} days after the project's final completion`],
                ["Statements", "Issued on the 5th business day of the next month, paid by the 10th, on the Bogotá calendar"],
                ["Smallest payout", "USD 0.00; Kauro pays the transfer fees"],
                ["Retainer", "USD 0.00 by default for a new agreement. A signed agreement may set a fixed monthly payment; it is then owed every month and shown wherever the rates are"],
                ["Offset after a refund", "Shown line by line on the statement, with the refund, the project, the rule and the balance; applied only as the agreement in force and the applicable rules allow"],
                ["After an engagement ends", <span key="tail">Claims already accepted keep running for up to {TAIL_DAYS} days <PendingLegal /></span>],
              ]}
            />
            <h3>Rates by seller</h3>
            <div className="kauro-ops-tablewrap">
              <div className="kauro-table-region">
                <table className="kauro-table kauro-ops-table kauro-ops-table--cards kauro-ops-table--compact">
                  <caption className="kauro-visually-hidden">Rates by seller</caption>
                  <thead>
                    <tr>
                      <th scope="col">Seller</th>
                      <th scope="col">Agreement</th>
                      <th scope="col" className="kauro-table-end">
                        First project
                      </th>
                      <th scope="col" className="kauro-table-end">
                        Repeats
                      </th>
                      <th scope="col" className="kauro-table-end">
                        Retainer (USD a month)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {SELLERS.map((seller) => (
                      <tr key={seller.id}>
                        <th scope="row">
                          <Link href={OPS_PATH.seller(seller.id)} prefetch={false}>
                            {seller.name}
                          </Link>
                        </th>
                        <td data-label="Agreement">
                          <span>
                            {seller.agreement}
                            <span className="kauro-ops-sub">{seller.signed === null ? "Not signed yet" : seller.state === "TERMINATED" ? `Ended ${seller.endedOn ?? ""}` : `Signed ${seller.signed}`}</span>
                          </span>
                        </td>
                        <td className="kauro-table-end" data-label="First project">
                          <span>{FIRST_RATE}%</span>
                        </td>
                        <td className="kauro-table-end" data-label="Repeats">
                          <span>
                            {REPEAT_RATE}% · {WINDOW_MONTHS} months
                          </span>
                        </td>
                        <td className="kauro-table-end" data-label="Retainer (USD a month)">
                          <span>{seller.retainerCents > 0 ? amount(seller.retainerCents) : <span className="kauro-ops-zero">None</span>}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section id="paying" aria-labelledby="paying-h">
            <Head id="paying" title="Paying sellers" kind="live" kindText="Live · you verify a changed destination" purpose="Where each seller is paid. You make each transfer from the bank, then record it; a changed destination is checked at least 48 hours after the change." />
            <Facts
              rows={SELLERS.map((seller) => [
                seller.name,
                seller.payout.state === "NONE" ? (
                  "Not added yet"
                ) : (
                  <span key={seller.id}>
                    Bank account {seller.payout.label} · {seller.payout.currency} · <Word tone="success">Verified</Word> {seller.payout.verifiedOn}
                  </span>
                ),
              ])}
            />
          </section>

          <section id="outreach" aria-labelledby="outreach-h">
            <Head id="outreach" title="Outreach rules" kind="live" kindText="Live · sending identities and authorisations" purpose="Who may send messages for Kauro, and what has been authorised. A message leaves only with its exact text authorised." />
            <Facts
              rows={[
                ["Sending identities", alerts ? "1 verified · 1 revoked on Oct 21 (amara.okafor@sales.kauro.example); messages from it have stopped" : "2 verified · 1 revoked (Tomás Vidal's, when the engagement ended)"],
                ["Authorisations in force", "1: Daniel Kim to Ostra Revenue Ops, one send, until Oct 23, 2026"],
                ["Channel rules in force", "A reply someone asked for, a first contact to an organisation, a follow-up: by country"],
                ["Do not contact", "1 organisation, on every channel"],
              ]}
            />
          </section>

          <p className="kauro-ops-group-title">Money</p>
          <section id="bank" aria-labelledby="bank-h">
            <Head id="bank" title="Getting paid" kind="live" kindText="Live · verify, enable and disable in Finance" purpose="How customers pay Kauro: a bank transfer in USD, matched by you to its order." />
            <Facts
              rows={[
                ["Route", "Bank transfer: ACH or domestic wire, in USD"],
                ["State", alerts ? <Word key="b" tone="danger">Details expired</Word> : <Word key="b" tone="success">Verified · sandbox</Word>],
                ["Account", "Shown as ··US01 only"],
                ["Last verified", alerts ? "Oct 14, 2026. Payments stop being offered until the details are confirmed again" : "Oct 14, 2026"],
              ]}
            />
            <div className="kauro-actions">
              <Link href={OPS_PATH.finance}>Open Finance</Link>
            </div>
          </section>

          <p className="kauro-ops-group-title">Platform</p>
          <section id="providers" aria-labelledby="providers-h">
            <Head id="providers" title="Providers" kind="read" kindText="Read-only · states and dates" purpose="The services Kauro depends on, each as a state and a date." />
            <Facts
              rows={[
                ["Identity provider", <span key="i"><Word tone="warning">Not connected</Word> Sign-in is simulated in this review until it is connected.</span>],
                ["Email sending", alerts ? <span key="e"><Word tone="danger">1 identity revoked</Word> Outreach from it has stopped.</span> : <span key="e"><Word tone="success">2 identities verified</Word></span>],
                ["Card payments", <span key="c"><Word tone="neutral">Not offered</Word> Payments are bank transfers.</span>],
                ["Cloud", <span key="h"><Word tone="neutral">Not opened</Word> Nothing is deployed; this review runs on your machine.</span>],
              ]}
            />
          </section>

          <section id="alerts" aria-labelledby="alerts-h">
            <Head id="alerts" title="Alerts" kind="backend" kindText="Needs backend · alerts are not computed yet" purpose="When something is flagged, from recorded dates and events only. Three kinds, said in words: blocked, deadline, inactive." />
            <Facts
              rows={[
                ["Inactivity", "A project is flagged after 14 days without relevant progress, even with no deadline near"],
                ["Deadlines", "2 days before an important date (file deletion, quote expiry, payment due, claim end), or at once when it has passed, whatever the activity"],
                ["Seller claims", "14 days and 3 days before a claim's recorded end"],
                ["Pilot period", "Its review is prepared 14 days before the pilot ends; no agreement changes automatically"],
                ["Once per item", "An item appears once, under its most urgent kind (blocked, deadline passed, deadline in 2 days, inactive); its other conditions are its second line"],
              ]}
            />
          </section>

          <section id="limits" aria-labelledby="limits-h">
            <Head id="limits" title="Limits and retention" kind="read" kindText={`Read-only · policy ${POLICY_SNAPSHOT.scheduleVersion}`} purpose="How much a project may hold, and how long Kauro keeps what customers upload." />
            <Facts
              rows={[
                ["Files", `${POLICY_SNAPSHOT.input.files} per set · ${gb(POLICY_SNAPSHOT.input.fileBytes)} per file · ${gb(POLICY_SNAPSHOT.input.revisionBytes)} per set · ${POLICY_SNAPSHOT.input.columns} columns`],
                ["Largest project", `${POLICY_SNAPSHOT.launchSourceUnits.toLocaleString("en-US")} billable source units`],
                ["Free data health check", "USD 1.50 of model spend each · one at a time per customer · USD 220.00 funded each month"],
                ["Files of a check not followed by a purchase", `${POLICY_SNAPSHOT.retention.unpaidDaysFromReady} days after the check is ready · ${POLICY_SNAPSHOT.retention.unpaidDaysHardFromSeal} days from sealing at most`],
                ["Files and package of a purchased project", `${POLICY_SNAPSHOT.retention.paidDaysFromFirstPackage} days after the first package · ${POLICY_SNAPSHOT.retention.paidDaysHardFromCapture} days from payment at most`],
                ["A staged project", `${POLICY_SNAPSHOT.retention.stagedDaysFromFirstRelease} days after the first stage · ${POLICY_SNAPSHOT.retention.stagedDaysHardFromCapture} days from payment at most`],
                ["Records", `Application logs ${POLICY_SNAPSHOT.retention.ordinaryLogsDays} days · security records ${POLICY_SNAPSHOT.retention.securityLogsDays} days · a download link ${POLICY_SNAPSHOT.retention.signedDownloadSeconds / 60} minutes`],
              ]}
            />
          </section>

          <section id="access" aria-labelledby="access-h">
            <Head id="access" title="Access and break-glass" kind="live" kindText="Live · opened from a support case, revoked here" purpose="Emergency access to a customer's stored copy: case by case, read-only, 30 minutes at most, recorded." />
            <Facts
              rows={[
                ["Break-glass grants", "None active"],
                ["Restricted capabilities", "None"],
              ]}
            />
          </section>

          <p className="kauro-ops-group-title">Company</p>
          <section id="business" aria-labelledby="business-h">
            <Head id="business" title="Business details" kind="backend" kindText="Needs backend · legal identity not recorded" purpose="The legal name, tax number and address on every invoice and report." />
            <Facts
              rows={[
                ["Legal name", "Not recorded"],
                ["Tax number (NIT)", "Not recorded"],
                ["Address", "Not recorded"],
              ]}
            />
            <p className="kauro-muted">Until these are recorded, invoices and reports are refused. They are entered through the legal identity procedure, not here.</p>
          </section>

          <section id="team" aria-labelledby="team-h">
            <Head id="team" title="Team" kind="backend" kindText="Needs backend · no staff role exists" purpose="Who works in this console." />
            <p>Only you. Kauro has no staff role yet; sellers are listed under Sellers, not here.</p>
          </section>

          <section id="notifications" aria-labelledby="notifications-h">
            <Head id="notifications" title="Notifications" kind="backend" kindText="Needs backend · no owner preferences exist" purpose="Which events email you." />
            <p>Proposed: a transfer received, a claim submitted, a statement contested, an incident opened. None can be chosen yet.</p>
          </section>

          <section id="recovery" aria-labelledby="recovery-h">
            <Head id="recovery" title="Recovery" kind="backend" kindText="Needs backend · no recovery contract" purpose="Who can recover the company's access if you cannot." />
            <Facts
              rows={[
                ["Recovery contact", "Not recorded"],
                ["Succession", "Not recorded"],
              ]}
            />
          </section>
          <p className="kauro-muted kauro-ops-settings-foot">No key, token, password or full account number is shown on this page.</p>
        </div>
      </div>
    </OpsPage>
  );
}
