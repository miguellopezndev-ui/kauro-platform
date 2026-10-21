"use client";
// UI54 Reviewed correspondence (registry: "Review exactly what will be sent."). One message, shown exactly as it would leave: recipient (a
// role address from the prospect's own public source), sender (the seller's verified identity), why it may be sent (the purpose and the
// rule in force for that country), the suppression check, and the content, taken from a current resource. A seller drafts; the owner
// authorises that exact content (OutreachAuthorizationView: allowed content, window, number of sends); then the seller sends it. After
// sending, the provider's acceptance is not delivery and not a reply, and an uncertain send is said to be uncertain (registry exceptions).
import { Banner, Button } from "@kauro/ui";
import { type ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead, ScreenLink } from "./kit.tsx";

export const UI54_STATES: readonly StateDef[] = [
  { key: "normal", label: "A draft", note: "A reply Ostra Revenue Ops asked for, drafted by the seller and waiting for the owner's review." },
  { key: "authorised", label: "Authorised", note: "The owner authorised this exact content, once, until a date: the seller can send it." },
  { key: "accepted", label: "Accepted by the provider", note: "Sent: the provider accepted it. That is not delivery and not a reply." },
  { key: "uncertain", label: "Send uncertain", note: "The provider did not answer: whether it left is not known, and nothing is sent again on a guess." },
  { key: "blocked", label: "Blocked by suppression", note: "The address asked not to be contacted: the message cannot be authorised or sent." },
];

const STATE: Readonly<Record<string, { readonly word: string; readonly tone: "neutral" | "info" | "success" | "warning" | "danger" }>> = {
  normal: { word: "Draft, waiting for review", tone: "neutral" },
  authorised: { word: "Authorised, not sent", tone: "info" },
  accepted: { word: "Accepted by the provider", tone: "success" },
  uncertain: { word: "Send uncertain", tone: "warning" },
  blocked: { word: "Suppressed: cannot be sent", tone: "danger" },
};

export function Outreach({ ctx, state }: PrototypeProps): ReactElement {
  const owner = ctx.key === "owner";
  const blocked = state === "blocked";
  const shown = STATE[state] ?? STATE["normal"] ?? { word: "", tone: "neutral" };
  return (
    <>
      <PageHead title="Reviewed correspondence" lead="Review exactly what will be sent." />
      {state === "accepted" ? (
        <Banner tone="success" title="The provider accepted the message" announce="status">
          <p>At 10:42 AM UTC. That means it left Kauro&apos;s provider; it does not mean it reached the inbox, or that anyone read it. A reply, if one comes, appears here.</p>
        </Banner>
      ) : null}
      {state === "uncertain" ? (
        <Banner tone="warning" title="It is not known whether the message left" announce="alert">
          <p>The provider did not confirm or refuse it. It is not sent again automatically: the owner checks the provider&apos;s record first, so the prospect never receives it twice.</p>
        </Banner>
      ) : null}
      {blocked ? (
        <Banner tone="danger" title="This address asked not to be contacted" announce="alert">
          <p>Kestrel &amp; Lowe is suppressed since Oct 1, 2026, on every channel. This draft cannot be authorised or sent, from this page or any other.</p>
        </Banner>
      ) : null}
      <section className="kauro-letter" aria-labelledby="letter-h">
        <div className="kauro-letter-head">
          <h2 id="letter-h">{blocked ? "To Kestrel & Lowe" : "To Ostra Revenue Ops"}</h2>
          <Badge tone={shown.tone}>{shown.word}</Badge>
        </div>
        <dl className="kauro-letter-facts">
          <div>
            <dt>To</dt>
            <dd>{blocked ? "hello@kestrel-lowe.example" : "partners@ostra-revops.example"}, the address on their own site</dd>
          </div>
          <div>
            <dt>From</dt>
            <dd>Daniel Kim &lt;daniel.kim@sales.kauro.example&gt;, verified</dd>
          </div>
          <div>
            <dt>Why it may be sent</dt>
            <dd>{blocked ? "It may not: the address is suppressed." : "They asked for the worked example on Oct 16, 2026, in writing: a reply they requested, under the rule in force for the Netherlands."}</dd>
          </div>
          <div>
            <dt>Suppression</dt>
            <dd>{blocked ? "Suppressed since Oct 1, 2026" : "Checked at 10:31 AM UTC: not suppressed"}</dd>
          </div>
          <div>
            <dt>Content</dt>
            <dd>
              From the worked example, version 2 (current) · <ScreenLink to="UI53" ctx={ctx}>Resources</ScreenLink>
            </dd>
          </div>
        </dl>
        <div className="kauro-letter-body">
          <p className="kauro-letter-subject">Subject: The worked example you asked for</p>
          <p>Hello,</p>
          <p>Thank you for your note on 16 October. Here is the worked example: two synthetic files, 12,480 contacts and 3,204 companies, taken through the free health check, the plan your team approves, and the import package for HubSpot. Every count in it adds up, and nothing in it is anyone&apos;s real data.</p>
          <p>Kauro never connects to a CRM: your team imports the files with its own account. If a check of one of your own exports would help, the health check is free.</p>
          <p>Daniel Kim, for Kauro</p>
          <p className="kauro-letter-foot">To stop receiving messages from Kauro, reply with &quot;stop&quot;; it takes effect at once, on every channel.</p>
        </div>
      </section>
      {blocked ? null : state === "normal" ? (
        owner ? (
          <section className="kauro-approve" aria-labelledby="auth-h">
            <h2 id="auth-h">Authorise this message</h2>
            <p>The authorisation covers this exact content, from Daniel Kim&apos;s identity, once, until Oct 23, 2026. Any change to the text needs a new review.</p>
            <div className="kauro-actions">
              <Button variant="primary">Authorise once</Button>
              <Button>Send back with a note</Button>
            </div>
          </section>
        ) : (
          <p className="kauro-muted">Waiting for the owner&apos;s review, sent on Oct 20, 2026 at 10:31 AM UTC. You will see the answer here; until then, nothing is sent.</p>
        )
      ) : state === "authorised" ? (
        <section className="kauro-approve" aria-labelledby="send-h">
          <h2 id="send-h">Send</h2>
          <p>Authorised by the owner for this exact content, once, until Oct 23, 2026.</p>
          <Button variant="primary">Send the message</Button>
        </section>
      ) : null}
    </>
  );
}
