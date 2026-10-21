"use client";
// UI33 Private home (registry: "Your permitted operational and commercial work."). One page, drawn from the person's capabilities: a seller
// sees their own sales work and their own statements, never the company's cash or any customer's CRM data; the owner sees what waits for
// them first, then the state of money, work and product, each with the screen that holds it. A balance that is not known yet says so and is
// never shown as zero (registry exceptions). The seller's figures are SellerHomeView's (statements with payable and held amounts).
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { PageHead, ScreenButton, ScreenLink } from "./kit.tsx";
import { PROSPECTS, STATEMENTS, sumOf, usd } from "./sales.ts";

export const UI33_STATES: readonly StateDef[] = [
  { key: "normal", label: "Today", note: "The owner's queue first, then money, work and product; a seller sees only their own sales work." },
  { key: "quiet", label: "Nothing waiting", note: "Nothing needs the person today: the page says so and still shows where things stand." },
];

interface Tile {
  readonly label: string;
  readonly figure: string;
  readonly fact: string;
  readonly screen: string;
  readonly tone?: "attention" | undefined;
}

function Tiles({ tiles, ctx }: { readonly tiles: readonly Tile[]; readonly ctx: PrototypeProps["ctx"] }): ReactElement {
  return (
    <ul className="kauro-tiles">
      {tiles.map((tile) => (
        <li key={tile.label} className={tile.tone === "attention" ? "is-attention" : undefined}>
          <span className="kauro-tile-label">{tile.label}</span>
          <strong>{tile.figure}</strong>
          <span className="kauro-tile-fact">{tile.fact}</span>
          <ScreenLink to={tile.screen} ctx={ctx}>
            Open<span className="kauro-visually-hidden"> {tile.label.toLowerCase()}</span>
          </ScreenLink>
        </li>
      ))}
    </ul>
  );
}

function SellerHome({ ctx, quiet }: { readonly ctx: PrototypeProps["ctx"]; readonly quiet: boolean }): ReactElement {
  const draft = STATEMENTS.find((one) => one.state === "DRAFT");
  const last = STATEMENTS.find((one) => one.state === "PAID");
  const open = PROSPECTS.filter((one) => one.state !== "SUPPRESSED" && one.state !== "WON" && one.state !== "LOST");
  return (
    <>
      <PageHead title="Today" lead="Your permitted operational and commercial work." />
      {quiet ? (
        <section className="kauro-next" aria-labelledby="next-h">
          <p className="kauro-next-label">Today</p>
          <h2 id="next-h">Nothing waits for you today</h2>
          <p>No reply to follow up and no draft to finish. Your prospects and statements are below.</p>
        </section>
      ) : (
        <section className="kauro-next" aria-labelledby="next-h">
          <p className="kauro-next-label">Next</p>
          <h2 id="next-h">Ostra Revenue Ops asked for the worked example</h2>
          <p>Send it from the current resources, through a reviewed message. Your claim on them is accepted until 31 Dec 2026.</p>
          <div className="kauro-actions">
            <ScreenButton to="UI54" ctx={ctx} variant="primary">
              <span className="kauro-go">Prepare the message</span>
            </ScreenButton>
          </div>
        </section>
      )}
      <Tiles
        ctx={ctx}
        tiles={[
          { label: "Prospects you work", figure: String(open.length), fact: "1 to check before any message, 1 suppressed", screen: "UI34" },
          { label: "This month so far", figure: draft === undefined ? "Not issued" : usd(sumOf(draft.lines, "payableCents")), fact: draft === undefined ? "" : `A draft until it is issued on 9 Nov; ${usd(sumOf(draft.lines, "heldCents"))} held`, screen: "UI36" },
          { label: "Last paid", figure: last === undefined ? "None yet" : usd(sumOf(last.lines, "payableCents")), fact: last === undefined ? "" : `${last.period}, paid on ${last.paid ?? ""}`, screen: "UI36" },
        ]}
      />
      <p className="kauro-muted">You see your own prospects, messages and statements. Customer files, CRM data and the company&apos;s accounts are not part of a seller&apos;s access.</p>
    </>
  );
}

function OwnerHome({ ctx, quiet }: { readonly ctx: PrototypeProps["ctx"]; readonly quiet: boolean }): ReactElement {
  return (
    <>
      <PageHead title="Today" lead="Your permitted operational and commercial work." />
      {quiet ? (
        <section className="kauro-next" aria-labelledby="next-h">
          <p className="kauro-next-label">Waiting for you</p>
          <h2 id="next-h">Nothing needs you today</h2>
          <p>No owner action is due, no incident is open and every credit is attributed.</p>
        </section>
      ) : (
        <section className="kauro-next" aria-labelledby="next-h">
          <p className="kauro-next-label">Waiting for you · 2</p>
          <h2 id="next-h">Renew the kauro.example domain before 2 Nov 2026</h2>
          <p>Prepared: the registrar&apos;s own page, the fields filled in, the cost (USD 18.00) and what to keep as proof. One more action waits: approve a seller&apos;s claim.</p>
          <div className="kauro-actions">
            <ScreenButton to="UI38" ctx={ctx} variant="primary">
              <span className="kauro-go">Open owner actions</span>
            </ScreenButton>
          </div>
        </section>
      )}
      <section className="kauro-screen-section" aria-labelledby="money-h">
        <h2 id="money-h">Money</h2>
        <Tiles
          ctx={ctx}
          tiles={[
            { label: "Credits to attribute", figure: quiet ? "0" : "2", fact: quiet ? "Every credit is matched to its order" : "USD 2,275.00 received, not matched yet", screen: "UI39", tone: quiet ? undefined : "attention" },
            { label: "Seller payouts", figure: "Not issued", fact: "October's statements are issued on 9 Nov", screen: "UI36" },
          ]}
        />
      </section>
      <section className="kauro-screen-section" aria-labelledby="work-h">
        <h2 id="work-h">Work</h2>
        <Tiles
          ctx={ctx}
          tiles={[
            { label: "Jobs", figure: "1 running", fact: "No job failed in the last 7 days", screen: "UI40" },
            { label: "Deletion", figure: quiet ? "0" : "1 retry", fact: quiet ? "Every scheduled deletion verified" : "A provider object was not removed: retried at 14:00", screen: "UI41", tone: quiet ? undefined : "attention" },
            { label: "Incidents", figure: "None open", fact: "The last one closed on 9 Oct 2026", screen: "UI42" },
            { label: "Support cases", figure: "3 open", fact: "Next answer due today at 16:00 UTC", screen: "UI55" },
          ]}
        />
      </section>
      <section className="kauro-screen-section" aria-labelledby="product-h">
        <h2 id="product-h">Product and sales</h2>
        <Tiles
          ctx={ctx}
          tiles={[
            { label: "Releases", figure: "1 candidate", fact: "Every gate passed; waiting for your promotion", screen: "UI43" },
            { label: "Operating review", figure: "Due 3 Nov", fact: "October's evidence is being gathered", screen: "UI44" },
            { label: "Sales", figure: "1 claim", fact: "Saltmarsh Digital, claimed by Daniel Kim", screen: "UI34" },
          ]}
        />
      </section>
    </>
  );
}

export function PrivateHome({ ctx, state }: PrototypeProps): ReactElement {
  return ctx.key === "seller" ? <SellerHome ctx={ctx} quiet={state === "quiet"} /> : <OwnerHome ctx={ctx} quiet={state === "quiet"} />;
}
