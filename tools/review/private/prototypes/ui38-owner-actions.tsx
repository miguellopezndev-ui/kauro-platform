"use client";
// UI38 Owner actions (registry: "Personal actions are prepared before they reach you."). The acts only the owner can do in the world outside
// Kauro (a registrar, a bank, a tax office), each prepared in full: why, the verified official address, the fields already worked out, the
// one personal act left, the cost, the deadline and what to keep as proof. The owner never has to code, open a terminal or guess a menu; an
// action whose steps are not prepared says Not ready instead of guessing (registry exceptions). If the official page looks different from
// what was prepared, the owner reports it and stops.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, PageHead } from "./kit.tsx";

/** The registrar's fields a person types; the rest are only checked. */
const TYPED: ReadonlySet<string> = new Set(["Domain"]);

export const UI38_STATES: readonly StateDef[] = [
  { key: "normal", label: "Actions", note: "One action prepared and due, one not ready, one done with its proof." },
  { key: "recorded", label: "Result recorded", note: "The renewal done: the receipt kept, and the action closed." },
  { key: "changed", label: "The page looked different", note: "The registrar's page did not match the preparation: the owner stops and reports it." },
];

function Prepared({ state }: { readonly state: string }): ReactElement {
  const [copied, setCopied] = useState<string | null>(null);
  const fields = [
    ["Domain", "kauro.example"],
    ["Period", "1 year, to Nov 2, 2027"],
    ["Automatic renewal", "Leave off"],
    ["Privacy protection", "Keep on (included)"],
  ] as const;
  return (
    <section className="kauro-owner-action" aria-labelledby="renew-h">
      <div className="kauro-owner-action-head">
        <h2 id="renew-h">Renew the kauro.example domain</h2>
        {state === "recorded" ? <Badge tone="success">Done</Badge> : <Badge tone="warning">Due Nov 2, 2026</Badge>}
      </div>
      <p>If it lapses, the site and every email address on it stop working. The registrar holds it until Nov 2, 2026.</p>
      <dl className="kauro-owner-action-facts">
        <div>
          <dt>Where</dt>
          <dd>
            <code>https://account.registrar.example/domains/kauro.example/renew</code>
            <span className="kauro-muted-text">Checked on Oct 20, 2026: the registrar&apos;s own address, as on its invoices</span>
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>USD 18.00, on the company card already on file there</dd>
        </div>
        <div>
          <dt>Your part</dt>
          <dd>Sign in to the registrar with your own account, check the four values below, and pay.</dd>
        </div>
        <div>
          <dt>Keep as proof</dt>
          <dd>The receipt the registrar emails you, as a PDF</dd>
        </div>
      </dl>
      <table className="kauro-table kauro-owner-fields">
        <caption>What to check on the registrar&apos;s page</caption>
        <tbody>
          {fields.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
              <td className="kauro-table-actions">
                {/* only a value typed on the registrar's page is copied; the others are checked, not typed */}
                {TYPED.has(label) ? <Button onClick={() => setCopied(label)}>{copied === label ? "Copied" : "Copy"}</Button> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {state === "recorded" ? (
        <p className="kauro-owner-action-done">Recorded on Oct 20, 2026 at 3:12 PM UTC: renewed to Nov 2, 2027, receipt kept with this action.</p>
      ) : state === "changed" ? (
        <Banner tone="warning" title="Reported: the page did not match" announce="alert">
          <p>You said the registrar asked for a transfer code this preparation does not mention. Nothing was paid. Kauro prepares the action again from the registrar&apos;s current page before it comes back to you.</p>
        </Banner>
      ) : (
        <div className="kauro-actions">
          <Button variant="primary">Open the registrar&apos;s page</Button>
          <Button>Record the result</Button>
          <Button>The page looks different</Button>
        </div>
      )}
    </section>
  );
}

export function OwnerActions({ state }: PrototypeProps): ReactElement {
  return (
    <>
      <PageHead title="Owner actions" lead="Personal actions are prepared before they reach you." />
      <Prepared state={state} />
      <section className="kauro-owner-action is-not-ready" aria-labelledby="tax-h">
        <div className="kauro-owner-action-head">
          <h2 id="tax-h">File the next tax return</h2>
          <Badge tone="neutral">Not ready</Badge>
        </div>
        <p>Its date and its steps come from the company&apos;s accountant and are not recorded yet, so this action asks nothing of you: Kauro does not guess a government&apos;s screens. Once they are recorded, it comes back prepared, like the one above.</p>
      </section>
      <section className="kauro-screen-section" aria-labelledby="done-h">
        <h2 id="done-h">Done</h2>
        <ol className="kauro-history">
          <li>
            <span>Oct 14, 2026</span> Verified the company bank account at the payment provider · confirmation kept
          </li>
          <li>
            <span>Jul 1, 2026</span> Signed the seller agreement with Daniel Kim · signed copy kept
          </li>
        </ol>
      </section>
    </>
  );
}
