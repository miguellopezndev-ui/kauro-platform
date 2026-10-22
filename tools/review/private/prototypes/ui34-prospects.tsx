"use client";
// UI34 Prospects (registry: "Work only qualified, permitted opportunities."). Round 2 (seller-portal.md §5).
//
// The seller's own book of organisations, each with what it allows today. Four views instead of eight states (to work, claimed, won,
// closed); each row says its stage, its claim as a date, its next step and its last activity. Availability comes before effort: adding a
// prospect answers at once with one of three words, and "Not available" never says why (it merges an existing customer, another seller's
// claim and an owner rule, so no commercial relationship is disclosed; owner and counsel to confirm). A suppressed organisation shows "Do
// not contact" and no action anywhere. No bulk tools, no import, no export: a seller's list is personal data with a lawful source.
//
// The owner sees every seller's prospects, filtered by seller, and decides claims on the Claims page (they left this page: sellers work
// prospects, the owner decides claims). The prospect's record keeps only commercial milestones: never files, findings or prices.
import { Button, Field } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Filter, OPS_PATH, OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";
import { CLAIM_DAYS, FIRST_RATE, PROSPECTS, REPEAT_RATE, SELLER, SELLERS, WINDOW_MONTHS, sellerById, type Prospect, type ProspectState } from "./sales.ts";

export const UI34_STATES: readonly StateDef[] = [
  { key: "normal", label: "Prospects", note: "The seller's book in four views; Ostra Revenue Ops opened, with its claim as a date, its facts and its history." },
  { key: "add", label: "Adding a prospect", note: "Four fields and the lawful source; the answer comes at once: available, not available or do not contact." },
  { key: "unavailable", label: "Not available", note: "The answer for an organisation that cannot be claimed: a neutral message, never the reason; the seller can ask for a review." },
  { key: "suppressed", label: "Do not contact", note: "Kestrel & Lowe opened: suppressed on every channel, with no way to contact it." },
];

const WORD: Readonly<Record<ProspectState, string>> = { RESEARCHED: "To check", QUALIFIED: "Qualified", CONTACTED: "Contacted", ENGAGED: "In conversation", OPPORTUNITY: "Opportunity", WON: "Won", LOST: "Lost", SUPPRESSED: "Do not contact" };
const TONE = (state: ProspectState): "neutral" | "info" | "success" | "danger" => (state === "SUPPRESSED" ? "danger" : state === "WON" ? "success" : state === "ENGAGED" || state === "OPPORTUNITY" ? "info" : "neutral");
type View = "work" | "claimed" | "won" | "closed";
const VIEW_OF = (one: Prospect): View => (one.state === "WON" ? "won" : one.state === "LOST" || one.state === "SUPPRESSED" ? "closed" : "work");
const claimed = (one: Prospect): boolean => one.claim.startsWith("Ends") || one.claim === "In review";

const HISTORY: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  "p-03": [
    ["Oct 20, 2026", "Kauro authorised your reply, for one send until Oct 23"],
    ["Oct 16, 2026", "They asked for the worked example, in writing"],
    ["Oct 2, 2026", `Claim accepted, for ${CLAIM_DAYS} days, until Dec 31`],
    ["Oct 1, 2026", "Claimed, with your evidence"],
    ["Sep 30, 2026", "Added from a published conference speaker list"],
  ],
  "p-05": [
    ["Oct 1, 2026", "They asked not to be contacted, on every channel"],
    ["Sep 29, 2026", "First message drafted; never sent"],
    ["Sep 28, 2026", "Added from its own site"],
  ],
};

function claimSentence(one: Prospect): string {
  if (one.claim === "In review") return "Claim submitted on Oct 20. Kauro decides it; you will be told the outcome.";
  if (one.claim.startsWith("Ends")) return `Claimed until ${one.claim.slice(5)}. If ${one.name} buys before then, its first project earns you ${FIRST_RATE}% of the service collected, and its repeats ${REPEAT_RATE}% for ${WINDOW_MONTHS} months.`;
  if (one.claim.startsWith("Won")) return `${one.claim}. Its repeats earn ${REPEAT_RATE}% for ${WINDOW_MONTHS} months after its first payment.`;
  return one.state === "QUALIFIED" ? "Not claimed. Claim it now that it is qualified." : "Not claimed. Claim it once you have qualified it.";
}

function Detail({ prospect, owner }: { readonly prospect: Prospect; readonly owner: boolean }): ReactElement {
  const suppressed = prospect.state === "SUPPRESSED";
  const history = HISTORY[prospect.id] ?? [
    [prospect.last, prospect.next],
    [prospect.observed, `Added from ${prospect.source.charAt(0).toLowerCase()}${prospect.source.slice(1)}`],
  ];
  return (
    <section className="kauro-ops-decide" aria-labelledby="prospect-h">
      <div className="kauro-ops-head-title">
        <h2 id="prospect-h">{prospect.name}</h2>
        <Word tone={TONE(prospect.state)}>{WORD[prospect.state]}</Word>
      </div>
      <dl className="kauro-ops-facts">
        {owner ? (
          <div>
            <dt>Seller</dt>
            <dd>
              <Link href={OPS_PATH.seller(prospect.sellerId)} prefetch={false}>
                {sellerById(prospect.sellerId)?.name}
              </Link>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Next step</dt>
          <dd>{prospect.next}</dd>
        </div>
        <div>
          <dt>Claim</dt>
          <dd>{suppressed ? "None. A suppressed organisation cannot be claimed." : claimSentence(prospect)}</dd>
        </div>
        <div>
          <dt>Found</dt>
          <dd>
            {prospect.source}, seen on {prospect.observed}
          </dd>
        </div>
        <div>
          <dt>Kind and country</dt>
          <dd>
            {prospect.segment} · {prospect.jurisdiction}
          </dd>
        </div>
        <div>
          <dt>Fit</dt>
          <dd>{prospect.fit}</dd>
        </div>
        <div>
          <dt>Contact</dt>
          <dd>{suppressed ? "Do not contact, on every channel, since Oct 1, 2026" : "Can be contacted through its own published address"}</dd>
        </div>
      </dl>
      <h3>History</h3>
      <ol className="kauro-ops-history">
        {history.map(([date, what]) => (
          <li key={`${date}-${what}`}>
            <time>{date}</time>
            <span>{what}</span>
          </li>
        ))}
      </ol>
      {suppressed || owner || prospect.state === "WON" ? null : (
        <div className="kauro-actions">
          {prospect.state === "QUALIFIED" && prospect.claim === "None" ? <Button>Claim {prospect.name}</Button> : null}
          <Link className="kauro-button kauro-button-secondary" href={OPS_PATH.outreach} prefetch={false}>
            Prepare a message
          </Link>
          <Button>Record an activity</Button>
          <button type="button" className="kauro-text-button">
            Mark as lost
          </button>
        </div>
      )}
      {owner && prospect.claim === "In review" ? (
        <p className="kauro-muted">
          Its claim is yours to decide on <Link href={OPS_PATH.claims}>Claims</Link>.
        </p>
      ) : null}
    </section>
  );
}

function AddProspect({ answered }: { readonly answered: boolean }): ReactElement {
  if (answered)
    return (
      <section className="kauro-ops-decide" aria-labelledby="answer-h">
        <div className="kauro-ops-head-title">
          <h2 id="answer-h">Pinewood Analytics is not available to claim</h2>
          <Word tone="neutral">Not available</Word>
        </div>
        <p>Kauro does not give the reason, so nothing about another party is disclosed. Nothing was added to your prospects.</p>
        <p>If you think this answer is wrong, ask Kauro to review it. Kauro looks at the decision again and tells you the outcome.</p>
        <div className="kauro-actions">
          <Button>Ask for a review</Button>
          <Button>Add another prospect</Button>
        </div>
      </section>
    );
  return (
    <section className="kauro-ops-decide" aria-labelledby="add-h">
      <h2 id="add-h">Add a prospect</h2>
      <p className="kauro-muted">Kauro answers at once: available to work, not available to claim, or asked not to be contacted. Only an available one is added.</p>
      <div className="kauro-ops-form">
        <Field id="add-name" label="Organisation and its website" hint="Its own name and the address of its own site">
          {(control) => <input {...control} defaultValue="Pinewood Analytics, pinewood-analytics.example" />}
        </Field>
        <Field id="add-kind" label="Agency or company" hint="An agency prepares data for its clients; a company for itself">
          {(control) => (
            <select {...control} defaultValue="Agency">
              <option>Agency</option>
              <option>Company</option>
            </select>
          )}
        </Field>
        <Field id="add-source" label="Where you found it, and when" hint="A public source you can show: its own site, a directory, a published list">
          {(control) => <input {...control} defaultValue="Its own site, Oct 20, 2026" />}
        </Field>
        <Field id="add-country" label="Country">
          {(control) => <input {...control} defaultValue="United States" />}
        </Field>
        <div className="kauro-actions">
          <Button variant="primary">Check and add</Button>
          <Button>Cancel</Button>
        </div>
      </div>
    </section>
  );
}

export function Prospects({ ctx, state }: PrototypeProps): ReactElement {
  const owner = ctx.key === "owner";
  const mine = owner ? PROSPECTS : PROSPECTS.filter((one) => one.sellerId === SELLER.id);
  const [view, setView] = useState<View>(state === "suppressed" ? "closed" : "work");
  const [who, setWho] = useState<string>("all");
  const [open, setOpen] = useState<string>(state === "suppressed" ? "p-05" : owner ? "p-01" : "p-03");
  const adding = state === "add" || state === "unavailable";
  const rows = owner ? mine.filter((one) => who === "all" || one.sellerId === who) : mine.filter((one) => (view === "claimed" ? claimed(one) : VIEW_OF(one) === view));
  const prospect = mine.find((one) => one.id === open) ?? rows[0];
  const count = (key: View): number => mine.filter((one) => (key === "claimed" ? claimed(one) : VIEW_OF(one) === key)).length;
  return (
    <OpsPage>
      <OpsHead
        title="Prospects"
        lead={owner ? "Every seller's prospects. Sellers work them; you decide their claims on Claims." : "Your organisations, and what each allows today."}
        action={owner || adding ? undefined : <Button variant="primary">Add a prospect</Button>}
      />
      {owner ? (
        <Filter<string>
          label="Show prospects of"
          value={who}
          onChange={setWho}
          options={[{ key: "all", label: "All sellers", count: mine.length }, ...SELLERS.filter((seller) => mine.some((one) => one.sellerId === seller.id)).map((seller) => ({ key: seller.id, label: seller.name, count: mine.filter((one) => one.sellerId === seller.id).length }))]}
        />
      ) : (
        <Filter<View>
          label="Show prospects"
          value={view}
          onChange={(key) => {
            setView(key);
            const first = mine.find((one) => (key === "claimed" ? claimed(one) : VIEW_OF(one) === key));
            if (first !== undefined) setOpen(first.id);
          }}
          options={[
            { key: "work", label: "To work", count: count("work") },
            { key: "claimed", label: "Claimed", count: count("claimed") },
            { key: "won", label: "Won", count: count("won") },
            { key: "closed", label: "Closed", count: count("closed") },
          ]}
        />
      )}
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
            <caption className="kauro-visually-hidden">{owner ? "Every seller's prospects" : "Your prospects"}</caption>
            <thead>
              <tr>
                <th scope="col">Organisation</th>
                {owner ? <th scope="col">Seller</th> : null}
                <th scope="col">Stage</th>
                <th scope="col">Claim</th>
                {owner ? null : <th scope="col">Next step</th>}
                <th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((one) => (
                <tr key={one.id} className={one.id === prospect?.id && !adding ? "is-open" : undefined}>
                  <th scope="row">
                    <button type="button" className="kauro-ops-rowbutton" aria-expanded={one.id === prospect?.id && !adding} onClick={() => setOpen(one.id)}>
                      {one.name}
                    </button>
                    <span className="kauro-ops-sub">
                      {one.segment} · {one.jurisdiction}
                    </span>
                  </th>
                  {owner ? (
                    <td data-label="Seller">
                      <span>{sellerById(one.sellerId)?.name}</span>
                    </td>
                  ) : null}
                  <td data-label="Stage">
                    <span>
                      <Word tone={TONE(one.state)}>{WORD[one.state]}</Word>
                    </span>
                  </td>
                  <td data-label="Claim">
                    <span>{one.claim}</span>
                  </td>
                  {owner ? null : (
                    <td data-label="Next step">
                      <span>{one.next}</span>
                    </td>
                  )}
                  <td data-label="Last activity">
                    <span className="kauro-ops-date">{one.last}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {adding && !owner ? <AddProspect answered={state === "unavailable"} /> : prospect === undefined ? null : <Detail prospect={prospect} owner={owner} />}
      {owner ? null : (
        <section aria-labelledby="rules-h">
          <SectionHead id="rules-h" title="Before any message" />
          <p className="kauro-muted">A message goes out only with its exact text authorised by Kauro, from your verified sending identity, and never to an organisation that asked not to be contacted.</p>
        </section>
      )}
    </OpsPage>
  );
}
