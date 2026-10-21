"use client";
// UI37 Seller lifecycle (registry: "Track the actual reviewed engagement."). One seller's engagement as it really stands: the assessment,
// the legal review of the relationship (a contractor label is not a legal review), the terms signed, training, access and the pilot dates
// (SellerRecordView, SellerAgreementRecordView). The owner prepares the next step: activation, training, an amendment or a termination; a
// termination keeps every lawful financial duty, including the tail of opportunities already claimed (policy: 90 days) and the commissions
// still owed (registry exception).
import { Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";
import { SELLER } from "./sales.ts";

export const UI37_STATES: readonly StateDef[] = [
  { key: "normal", label: "Active seller", note: "Daniel Kim: assessed, reviewed, signed, trained and active, in his pilot." },
  { key: "terminate", label: "Preparing a termination", note: "What ends at once, and what Kauro still owes and keeps paying." },
];

const STEPS = [
  { name: "Assessment", fact: "Interviewed and assessed on 12 Jun 2026", done: true },
  { name: "Legal review", fact: "Independent contractor in Colombia, reviewed by counsel on 24 Jun 2026", done: true },
  { name: "Agreement", fact: `${SELLER.agreement}, signed by both on 1 Jul 2026`, done: true },
  { name: "Training", fact: "Offer, data handling and outreach rules, completed 4 Jul 2026", done: true },
  { name: "Access", fact: "Sales screens only, with two-step verification; no customer data", done: true },
  { name: "Pilot", fact: "1 Jul to 31 Dec 2026; review due 15 Dec 2026", done: false },
] as const;

export function SellerLifecycle({ state }: PrototypeProps): ReactElement {
  const terminate = state === "terminate";
  return (
    <>
      <PageHead title={SELLER.name} lead="Track the actual reviewed engagement." aside={<Badge tone="success">Active</Badge>} />
      <ol className="kauro-seller-steps">
        {STEPS.map((step) => (
          <li key={step.name} className={step.done ? "is-done" : "is-current"}>
            <strong>{step.name}</strong>
            <span>{step.fact}</span>
          </li>
        ))}
      </ol>
      {terminate ? (
        <section className="kauro-approve" aria-labelledby="end-h">
          <h2 id="end-h">End the engagement</h2>
          <dl className="kauro-relationship-ends">
            <div>
              <dt>Ends at once</dt>
              <dd>Access to the sales screens, new claims and every message not yet sent.</dd>
            </div>
            <div>
              <dt>Kauro still owes</dt>
              <dd>Every commission earned, on its normal statement; first projects of claims already accepted, for 90 days; repeats inside their windows, as the agreement says.</dd>
            </div>
            <div>
              <dt>Notice</dt>
              <dd>As the agreement sets: 15 days, in writing, with the reason.</dd>
            </div>
          </dl>
          <div className="kauro-actions">
            <Button variant="danger">Prepare the notice</Button>
            <Button>Cancel</Button>
          </div>
          <p className="kauro-muted">Preparing the notice sends nothing: you read it, and you send it.</p>
        </section>
      ) : (
        <section className="kauro-screen-section" aria-labelledby="next-h">
          <h2 id="next-h">Prepare</h2>
          <div className="kauro-actions">
            <Button>Schedule the pilot review</Button>
            <Button>Prepare an amendment</Button>
            <Button>Prepare training</Button>
            <Button variant="danger">Prepare a termination</Button>
          </div>
        </section>
      )}
    </>
  );
}
