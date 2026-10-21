"use client";
// UI35 Agency relationship (registry: "Assignment and acquisition entitlement are separate."). For one agency, two different facts side by
// side: who serves it now (the service owner, who can change) and who acquired it (the acquisition owner, whose entitlement follows the
// signed agreement: the rate on the first project, the repeat rate and its window, counted from the first confirmed capture). Reassigning
// service never resets the first project or erases what the acquiring seller is still owed (registry exception). The history shows events,
// never customer data.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead, ScreenLink } from "./kit.tsx";
import { CLAIM_DAYS, FIRST_RATE, REPEAT_RATE, WINDOW_MONTHS } from "./sales.ts";

export const UI35_STATES: readonly StateDef[] = [
  { key: "normal", label: "Relationship", note: "Coastline Analytics: served and acquired by Daniel Kim, inside the 12-month window of repeats." },
  { key: "reassign", label: "Preparing a reassignment", note: "Service moves to the owner; the acquisition entitlement stays with the seller who found them." },
];

export function AgencyRelationship({ ctx, state }: PrototypeProps): ReactElement {
  const reassign = state === "reassign";
  return (
    <>
      <PageHead title="Coastline Analytics" lead="Assignment and acquisition entitlement are separate." />
      <div className="kauro-lifecycle-actions">
        <section className="kauro-lifecycle-card" aria-labelledby="service-h">
          <h2 id="service-h">Who serves them</h2>
          <p className="kauro-relationship-who">{reassign ? "Kauro owner, from 1 Nov 2026" : "Daniel Kim, seller"}</p>
          <p className="kauro-muted-text">Answers their questions and prepares their next project. It can change; changing it moves no money.</p>
        </section>
        <section className="kauro-lifecycle-card" aria-labelledby="acq-h">
          <h2 id="acq-h">Who acquired them</h2>
          <p className="kauro-relationship-who">Daniel Kim, seller</p>
          <ul className="kauro-relationship-terms">
            <li>Claim accepted on 18 Jul 2026, valid {CLAIM_DAYS} days</li>
            <li>
              First project: {FIRST_RATE}%, captured 26 Aug 2026 <Badge tone="success">Paid</Badge>
            </li>
            <li>
              Repeats: {REPEAT_RATE}% until 26 Aug 2027, {WINDOW_MONTHS} months after the first capture
            </li>
          </ul>
          <p className="kauro-muted-text">Under the seller agreement 2026-07. It does not change when service changes.</p>
        </section>
      </div>
      {reassign ? (
        <section className="kauro-approve" aria-labelledby="re-h">
          <h2 id="re-h">Move their service to you</h2>
          <p>From 1 Nov 2026, you serve Coastline Analytics. Daniel Kim keeps the repeat rate on their projects until 26 Aug 2027, and their first project stays theirs. Daniel Kim is told in writing.</p>
          <div className="kauro-actions">
            <Button variant="primary">Confirm the reassignment</Button>
            <Button>Cancel</Button>
          </div>
        </section>
      ) : (
        <div className="kauro-actions">
          <Button>Prepare a reassignment</Button>
          <ScreenLink to="UI36" ctx={ctx}>
            See the statements
          </ScreenLink>
        </div>
      )}
      <section className="kauro-screen-section" aria-labelledby="history-h">
        <h2 id="history-h">History</h2>
        <ol className="kauro-history">
          <li>
            <span>9 Jul 2026</span> Found by Daniel Kim on their own site, and qualified
          </li>
          <li>
            <span>18 Jul 2026</span> Claim accepted by the owner
          </li>
          <li>
            <span>11 Aug 2026</span> Agency created its workspace
          </li>
          <li>
            <span>26 Aug 2026</span> First project paid: USD 2,450.00 of service
          </li>
          <li>
            <span>14 Oct 2026</span> Second project quoted, a repeat
          </li>
        </ol>
      </section>
      {reassign ? null : (
        <Banner tone="info" title="Two facts, kept apart" announce="status">
          <p>Who serves an agency can change at any time. Who acquired it is decided once, by the accepted claim and the agreement, and only an amendment both sides sign can change it.</p>
        </Banner>
      )}
    </>
  );
}
