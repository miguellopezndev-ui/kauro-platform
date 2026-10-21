"use client";
// UI54 Outreach (registry "Reviewed correspondence": "Review exactly what will be sent."). Round 2 (seller-portal.md §6).
//
// The list of the seller's messages in four views, then one message as it will be read: the facts above it (to, from, purpose, why it may
// be sent, the do-not-contact check, the resources it quotes, the authorisation), the letter exactly as sent, and one action by state.
// The words are the contract's states only (OutreachDraftView: DRAFT, AUTHORIZED, SUBMITTING, PROVIDER_ACCEPTED, SEND_UNCERTAIN, BOUNCED,
// REPLIED, SUPPRESSED, CANCELLED). Round 1's "In review", "Changes requested" and "Rejected" are gone: they do not exist. Kauro authorises an
// exact text (a content hash) with a sender, a window and a number of sends, so any edit falls outside the authorisation, and the page says
// so above the text. The owner authorises (AuthorizeOutreach, step-up); there is no "send back with a note" in the contract (gap recorded).
// Sending is inert in this build (OUTREACH_COMPLIANCE_UNCONFIGURED); the review draws it as designed.
import { Banner, Button } from "@kauro/ui";
import Link from "next/link";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Filter, OPS_PATH, OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";
import { DRAFTS, DRAFT_TONE, DRAFT_WORD, PURPOSE_WORD, SELLER, sellerById, type Draft, type DraftState } from "./sales.ts";

export const UI54_STATES: readonly StateDef[] = [
  { key: "normal", label: "Messages", note: "Seller: the reply to Ostra Revenue Ops, authorised until Oct 23, ready to send. Owner: a follow-up waiting for your authorisation." },
  { key: "draft", label: "A draft", note: "The seller's follow-up to Saltmarsh Digital: a draft, not authorised; nothing can be sent until Kauro authorises this exact text." },
  { key: "accepted", label: "Sent", note: "Accepted by the sending service. That is not delivery and not a reply." },
  { key: "uncertain", label: "Not known yet", note: "The sending service did not answer: whether it left is not known, and nothing is sent again on a guess." },
  { key: "blocked", label: "Do not contact", note: "The organisation asked not to be contacted: the message is stopped and cannot be authorised or sent." },
];

type View = "ready" | "drafts" | "sent" | "stopped";
const VIEW_OF: Readonly<Record<DraftState, View>> = { DRAFT: "drafts", AUTHORIZED: "ready", SUBMITTING: "sent", PROVIDER_ACCEPTED: "sent", SEND_UNCERTAIN: "sent", BOUNCED: "sent", REPLIED: "sent", SUPPRESSED: "stopped", CANCELLED: "stopped" };

const LETTERS: Readonly<Record<string, { readonly subject: string; readonly body: readonly string[]; readonly to: string; readonly why: string; readonly quotes: string }>> = {
  "d-01": {
    to: "partners@ostra-revops.example, the address on their own site",
    why: "They asked for the worked example on Oct 16, 2026, in writing: a reply they asked for, under the rule in force for the Netherlands.",
    quotes: "Worked example, version 2 (current)",
    subject: "The worked example you asked for",
    body: [
      "Hello,",
      "Thank you for your note on October 16. Here is the worked example: two synthetic files, 12,480 contacts and 3,204 companies, taken through the free data health check, the plan your team approves, and the package prepared for HubSpot. For Salesforce, the package is the files Data Loader takes. Nothing in it is anyone's real data.",
      "Kauro never connects to a CRM: your team imports the files with its own account. If a check of one of your own exports would help, the free data health check is free and creates no obligation to buy.",
      "Daniel Kim, for Kauro",
    ],
  },
  "d-02": {
    to: "hello@saltmarsh-digital.example, the address on their own site",
    why: "A follow-up to the first message of Oct 12, under the rule in force for Ireland: one follow-up, no earlier than 7 days after it.",
    quotes: "Offer sheet, version 3 (current)",
    subject: "Following up: checking client exports before an import",
    body: [
      "Hello,",
      "I wrote on October 12 about Kauro. In one line: you upload a client's exported files, Kauro measures every row in a free data health check, your team approves the plan, and Kauro prepares files your team imports with its own tools.",
      "The offer sheet with the three services and the price bands is attached. If it is not for you, a one-word reply is enough and I will not write again.",
      "Daniel Kim, for Kauro",
    ],
  },
  "d-05": {
    to: "hello@kestrel-lowe.example, the address on their own site",
    why: "It may not be sent: the organisation asked not to be contacted, on every channel, on Oct 1, 2026.",
    quotes: "Offer sheet, version 2 (replaced on Oct 12)",
    subject: "Client data, checked before it reaches HubSpot",
    body: ["Hello,", "Your site says you set up HubSpot for clients. Kauro checks the files a client exports, prepares them for the import your team runs, and shows every change in a report. The free data health check is free.", "Daniel Kim, for Kauro"],
  },
};

function shownState(draft: Draft, state: string): DraftState {
  if (draft.id !== "d-01") return draft.state;
  return state === "accepted" ? "PROVIDER_ACCEPTED" : state === "uncertain" ? "SEND_UNCERTAIN" : draft.state;
}

function Message({ draft, shown, owner }: { readonly draft: Draft; readonly shown: DraftState; readonly owner: boolean }): ReactElement {
  const letter = LETTERS[draft.id] ?? LETTERS["d-01"];
  const seller = sellerById(draft.sellerId);
  return (
    <section aria-labelledby="letter-h">
      <SectionHead id="letter-h" title={<>To {draft.prospect}</>} meta={`${PURPOSE_WORD[draft.purpose]} · last change ${draft.changed}`} aside={<Word tone={DRAFT_TONE[shown]}>{shown === "AUTHORIZED" ? `Authorised · until ${draft.until ?? ""}` : DRAFT_WORD[shown]}</Word>} />
      {shown === "PROVIDER_ACCEPTED" ? (
        <Banner tone="success" title="Sent on Oct 21, 2026 at 9:42 AM Bogotá" announce="status">
          <p>The sending service accepted it. That does not mean it reached the inbox or that anyone read it. A reply, when it comes, is recorded on the prospect.</p>
        </Banner>
      ) : null}
      {shown === "SEND_UNCERTAIN" ? (
        <Banner tone="warning" title="Not known yet whether it was sent" announce="alert">
          <p>The sending service did not confirm or refuse it. Kauro is checking its record. Do not send it again: Ostra Revenue Ops never receives it twice.</p>
        </Banner>
      ) : null}
      {shown === "SUPPRESSED" ? (
        <Banner tone="danger" title="Stopped: do not contact" announce="alert">
          <p>Kestrel &amp; Lowe asked not to be contacted, on Oct 1, 2026, on every channel. This message cannot be authorised or sent, from this page or any other.</p>
        </Banner>
      ) : null}
      <dl className="kauro-ops-facts">
        <div>
          <dt>To</dt>
          <dd>{letter?.to}</dd>
        </div>
        <div>
          <dt>From</dt>
          <dd>
            {seller?.name} &lt;{seller?.sender?.address}&gt;, verified
          </dd>
        </div>
        <div>
          <dt>Why it may be sent</dt>
          <dd>{letter?.why}</dd>
        </div>
        <div>
          <dt>Do-not-contact check</dt>
          <dd>{shown === "SUPPRESSED" ? "Do not contact since Oct 1, 2026" : "Checked today at 9:31 AM Bogotá: may be contacted"}</dd>
        </div>
        <div>
          <dt>Quotes</dt>
          <dd>
            {letter?.quotes} · <Link href={OPS_PATH.resources}>Resources</Link>
          </dd>
        </div>
        <div>
          <dt>Authorisation</dt>
          <dd>{shown === "AUTHORIZED" ? `This exact text, from ${seller?.name ?? ""}'s identity, one send, until ${draft.until ?? ""}` : shown === "DRAFT" ? "None yet. Kauro authorises this exact text before it can be sent." : shown === "SUPPRESSED" ? "Not possible" : "Used: one send of one"}</dd>
        </div>
      </dl>
      {(shown === "DRAFT" || shown === "AUTHORIZED") && !owner ? <p className="kauro-muted">Editing an authorised message removes its authorisation. <Link href={OPS_PATH.resources}>What you may say</Link></p> : null}
      <article className="kauro-ops-letter" aria-label="The message as it will be read">
        <p className="kauro-ops-letter-subject">Subject: {letter?.subject}</p>
        {letter?.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        <p className="kauro-ops-letter-foot">To stop receiving messages from Kauro, reply with &quot;stop&quot;. It takes effect at once, on every channel.</p>
      </article>
      {owner && shown === "DRAFT" ? (
        <div className="kauro-ops-decide kauro-ops-ask">
          <h3>Authorise this exact text</h3>
          <p>One send, from {seller?.name}&apos;s verified identity, until Oct 24, 2026. Any change to the text after this needs a new authorisation.</p>
          <div className="kauro-actions">
            <Button variant="primary">Authorise this text</Button>
          </div>
          <p className="kauro-muted">Authorising asks for a fresh confirmation of your identity. If you leave it unauthorised, nothing is sent.</p>
        </div>
      ) : null}
      {!owner && shown === "AUTHORIZED" ? (
        <div className="kauro-actions">
          <Button variant="primary">Send the message</Button>
          <Button>Edit the text</Button>
        </div>
      ) : null}
      {!owner && shown === "DRAFT" ? (
        <>
          <p className="kauro-muted">Kauro reviews drafts in its own queue; you see the answer here. Until then, nothing is sent.</p>
          <div className="kauro-actions">
            <Button>Edit the draft</Button>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function Outreach({ ctx, state }: PrototypeProps): ReactElement {
  const owner = ctx.key === "owner";
  const mine = owner ? DRAFTS : DRAFTS.filter((one) => one.sellerId === SELLER.id);
  const initial = state === "blocked" ? "d-05" : state === "draft" || (owner && state === "normal") ? "d-02" : "d-01";
  const [open, setOpen] = useState(initial);
  const draft = mine.find((one) => one.id === open) ?? mine[0];
  const [view, setView] = useState<View>(draft === undefined ? "ready" : VIEW_OF[shownState(draft, state)]);
  const rows = mine.filter((one) => VIEW_OF[shownState(one, state)] === view);
  const count = (key: View): number => mine.filter((one) => VIEW_OF[shownState(one, state)] === key).length;
  return (
    <OpsPage>
      <OpsHead title="Outreach" lead={owner ? "Every seller's messages. You authorise an exact text before it can be sent." : "Your messages. Each is sent only with its exact text authorised by Kauro."} />
      <Filter<View>
        label="Show messages"
        value={view}
        onChange={(key) => {
          setView(key);
          const first = mine.find((one) => VIEW_OF[shownState(one, state)] === key);
          if (first !== undefined) setOpen(first.id);
        }}
        options={[
          { key: "ready", label: "Ready to send", count: count("ready") },
          { key: "drafts", label: owner ? "To authorise" : "Drafts", count: count("drafts") },
          { key: "sent", label: "Sent", count: count("sent") },
          { key: "stopped", label: "Stopped", count: count("stopped") },
        ]}
      />
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table kauro-ops-table--cards">
            <caption className="kauro-visually-hidden">Messages</caption>
            <thead>
              <tr>
                <th scope="col">Prospect</th>
                {owner ? <th scope="col">Seller</th> : null}
                <th scope="col">Purpose</th>
                <th scope="col">State</th>
                <th scope="col">Last change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((one) => {
                const shown = shownState(one, state);
                return (
                  <tr key={one.id} className={one.id === draft?.id ? "is-open" : undefined}>
                    <th scope="row">
                      <button type="button" className="kauro-ops-rowbutton" aria-expanded={one.id === draft?.id} onClick={() => setOpen(one.id)}>
                        {one.prospect}
                      </button>
                    </th>
                    {owner ? (
                      <td data-label="Seller">
                        <span>{sellerById(one.sellerId)?.name}</span>
                      </td>
                    ) : null}
                    <td data-label="Purpose">
                      <span>{PURPOSE_WORD[one.purpose]}</span>
                    </td>
                    <td data-label="State">
                      <span>
                        <Word tone={DRAFT_TONE[shown]}>{shown === "AUTHORIZED" ? `Authorised · until ${one.until ?? ""}` : DRAFT_WORD[shown]}</Word>
                      </span>
                    </td>
                    <td data-label="Last change">
                      <span className="kauro-ops-date">{one.changed}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {draft === undefined || LETTERS[draft.id] === undefined ? (
        draft === undefined ? null : (
          <p className="kauro-muted">The text of this message is kept with its record; open it from the prospect&apos;s history.</p>
        )
      ) : (
        <Message draft={draft} shown={shownState(draft, state)} owner={owner} />
      )}
    </OpsPage>
  );
}
