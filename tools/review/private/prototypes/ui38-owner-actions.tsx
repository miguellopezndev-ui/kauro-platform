"use client";
// UI38 Owner actions (registry: "Personal actions are prepared before they reach you."). Round 2: no longer a top-level item beside Today
// (Today's queue lists what is due; this page holds the preparation), reached from Today and from the Company group. The acts only the owner
// can do in the world outside Kauro (a registrar, a bank, a tax office), each prepared in full: why, the verified official address, the
// values to check, the one personal act left, the cost, the deadline and what to keep as proof. An action whose steps are not prepared
// says "Not ready" instead of guessing (registry exceptions). If the official page looks different from the preparation, the owner reports
// it and stops.
import { Banner, Button } from "@kauro/ui";
import { type ReactElement, useState } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { OpsHead, OpsPage, SectionHead, Word } from "./ops-kit.tsx";

/** The registrar's fields a person types; the rest are only checked. */
const TYPED: ReadonlySet<string> = new Set(["Domain"]);

export const UI38_STATES: readonly StateDef[] = [
  { key: "normal", label: "Actions", note: "One action prepared and due, one not ready, two done with their proof." },
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
    <section className="kauro-ops-decide" aria-labelledby="renew-h">
      <div className="kauro-ops-head-title">
        <h2 id="renew-h">Renew the kauro.example domain</h2>
        {state === "recorded" ? <Word tone="success">Done</Word> : <Word tone="warning">Due by Nov 2, 2026</Word>}
      </div>
      <p>If it lapses, the site and every email address on it stop working. The registrar holds it until Nov 2, 2026.</p>
      <dl className="kauro-ops-facts">
        <div>
          <dt>Where</dt>
          <dd>
            <code>https://account.registrar.example/domains/kauro.example/renew</code>
            <span className="kauro-ops-sub">Checked on Oct 20, 2026: the registrar&apos;s own address, as on its invoices</span>
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
      <h3>What to check on the registrar&apos;s page</h3>
      <div className="kauro-ops-tablewrap">
        <div className="kauro-table-region">
          <table className="kauro-table kauro-ops-table">
            <caption className="kauro-visually-hidden">What to check on the registrar&apos;s page</caption>
            <tbody>
              {fields.map(([label, value]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{value}</td>
                  <td className="kauro-table-actions">{TYPED.has(label) ? <Button onClick={() => setCopied(label)}>{copied === label ? "Copied" : "Copy"}</Button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {state === "recorded" ? (
        <p className="kauro-ops-sentence">Recorded on Oct 20, 2026 at 10:12 AM Bogotá: renewed to Nov 2, 2027, receipt kept with this action.</p>
      ) : state === "changed" ? (
        <Banner tone="warning" title="Reported: the page did not match" announce="alert">
          <p>You said the registrar asked for a transfer code this preparation does not mention. Nothing was paid. Kauro prepares the action again from the registrar&apos;s current page before it comes back to you.</p>
        </Banner>
      ) : (
        <div className="kauro-actions">
          <Button variant="primary">Open the registrar&apos;s page</Button>
          <Button>Record the result</Button>
          <button type="button" className="kauro-text-button">
            The page looks different
          </button>
        </div>
      )}
    </section>
  );
}

export function OwnerActions({ state }: PrototypeProps): ReactElement {
  return (
    <OpsPage>
      <OpsHead title="Owner actions" lead="What only you can do outside Kauro, prepared in full before it reaches you." />
      <Prepared state={state} />
      <section aria-labelledby="ready-h">
        <SectionHead id="ready-h" title="Not ready" />
        <ul className="kauro-ops-lines">
          <li>
            <strong>File the next tax return.</strong> Its date and steps come from the company&apos;s accountant and are not recorded yet, so it asks nothing of you: Kauro does not guess a government&apos;s screens. It comes back prepared once they are.
          </li>
        </ul>
      </section>
      <section aria-labelledby="done-h">
        <SectionHead id="done-h" title="Done" />
        <ol className="kauro-ops-history">
          <li>
            <time>Oct 14, 2026</time>
            <span>Verified the company bank account at the payment provider · confirmation kept</span>
          </li>
          <li>
            <time>Jul 1, 2026</time>
            <span>Signed the seller agreement with Daniel Kim · signed copy kept</span>
          </li>
        </ol>
      </section>
    </OpsPage>
  );
}
