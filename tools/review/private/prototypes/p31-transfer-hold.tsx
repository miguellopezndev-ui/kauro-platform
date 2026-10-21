"use client";
// P-31 (proposal beside UI24 Payment; owner decision of 2026-10-21, Orders 11–12, design only): the hold while a sent transfer arrives.
// The payment as built shows the bank details and waits for Kauro to match the money. The owner decided a separate, transitional and
// limited retention for an order whose transfer was legitimately sent and waits for confirmation (proposed: five business days, to be
// checked against the enabled payment method and its evidence). This page designs how the person who pays starts that hold and what
// stops it being abused:
//   - only an owner or a billing member gives the proof, and only for a transfer already sent (the bank's confirmation, or its trace
//     number), with the exact amount and the order's reference;
//   - the proof is not payment: preparation never starts on it;
//   - one hold per quote and per set of files: another order on the same quote, a new quote for the same files or a second proof starts
//     none; it is never renewed and never added to the extension; it never passes 24 days from sealing (proposed);
//   - when the hold ends without the money, the files are deleted and a late transfer is reviewed and returned.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import Link from "next/link";
import { type FormEvent, type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import { appPathOf } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { Badge, moment, Only, ScreenLink } from "./kit.tsx";
import { MONEY } from "./money.ts";
import { can, onlyLine } from "./people.ts";
import { FiveDates } from "./retention-dates.tsx";
import { HOLD_BUSINESS_DAYS, RETENTION, type RetentionMoment, UNPAID_CEILING_DAYS } from "./retention.ts";
import { TIMELINE } from "./timeline.ts";

export const P31_STATES: readonly StateDef[] = [
  { key: "normal", label: "Waiting, proof can be given", note: "The order waits for the transfer. If the transfer was already sent, an owner or billing member can give its proof to hold the files while the money arrives." },
  { key: "held", label: "Transfer pending, within its hold", note: "The proof was given: the files are held until Nov 3 (5 business days on the Bogotá calendar, Nov 2 being a holiday; proposed). Not payment; preparation cannot start." },
  { key: "second", label: "A second proof is refused", note: "The quote already had its hold: another proof, another order or a new quote for the same files starts no new hold." },
  { key: "hold-expired", label: "Hold ended, no payment", note: "The hold ended without the money: the files are deleted; a transfer that still arrives is reviewed and returned." },
  { key: "confirmed", label: "Payment confirmed during the hold", note: "Kauro matched the exact amount during the hold: the paid project's dates apply and the team can start the preparation." },
];

const REFERENCE = "K0123456789ABCDEFGHJKMN";
const grouped = REFERENCE.replace(/(.{4})(?=.)/g, "$1 ");
const MOMENT: Readonly<Record<string, RetentionMoment>> = { normal: "check", held: "held", second: "held", "hold-expired": "hold-expired", confirmed: "paid" };

export function TransferHold({ ctx, state, project }: PrototypeProps): ReactElement {
  const when = MOMENT[state] ?? "check";
  const pays = can(ctx, "pay");
  const quoteHref = `${appPathOf("P-30", ctx, project.projectId)}?review-proposal=P-30&review-state=${state === "confirmed" ? "paid" : when === "check" ? "normal" : when}`;
  const status =
    when === "paid"
      ? { tone: "success" as const, text: "Payment confirmed" }
      : when === "held"
        ? { tone: "warning" as const, text: "Transfer pending" }
        : when === "hold-expired"
          ? { tone: "danger" as const, text: "Hold ended" }
          : { tone: "info" as const, text: "Waiting for your transfer" };
  return (
    <>
      <ProjectHeader stage="purchase" title="Payment" lead="Your status comes from verified payment information." />
      <p className="kauro-d-proposed kauro-d-proposed--page">
        Proposed for Orders 11–12 (owner decision of Oct 21, 2026): a limited hold while a sent transfer arrives. The bank details are as built (<ScreenLink to="UI24" ctx={ctx}>the payment as built</ScreenLink>).
      </p>
      <section className="kauro-d-status" aria-labelledby="d-status-h">
        <h2 id="d-status-h">
          <Badge tone={status.tone}>{status.text}</Badge>
        </h2>
        <p className="kauro-d-amount">{MONEY.quoteExact}</p>
        <p>
          {when === "paid"
            ? `Kauro matched the exact amount on ${moment(RETENTION.paidWhileHeld)}. Your team can start the preparation.`
            : when === "held"
              ? `The files are held until ${moment(RETENTION.holdUntil)} while the money arrives. Nothing is confirmed until Kauro matches it; do not pay again.`
              : when === "hold-expired"
                ? `The hold ended on ${moment(RETENTION.holdUntil)} without a confirmed payment. The files were deleted and this order cannot be paid.`
                : "Nothing is confirmed until Kauro matches your transfer to this order."}
        </p>
        <p className="kauro-d-for">
          For the quote of {project.name}: <Link href={quoteHref}>see its five dates</Link>
        </p>
      </section>
      {state === "second" ? (
        <Banner tone="warning" title="This quote already had its hold" announce="alert">
          <p>A hold is given once per quote and per set of files, and it is never renewed. The files stay held until {moment(RETENTION.holdUntil)}; after that they are deleted if the money has not arrived.</p>
        </Banner>
      ) : null}
      {when === "check" ? <SentProof pays={pays} ctxLine={onlyLine(ctx, "pay", "give the proof of a sent transfer")} /> : null}
      {when === "held" ? (
        <section className="kauro-d-section" aria-labelledby="d-proof-h">
          <h2 id="d-proof-h">The proof Kauro holds the files on</h2>
          <dl className="kauro-d-facts">
            <div><dt>Given</dt><dd>{moment(RETENTION.proofAt)} by Ines Duarte (Billing)</dd></div>
            <div><dt>Proof</dt><dd>The bank&apos;s confirmation of the sent transfer (PDF), ACH trace number ending 4821</dd></div>
            <div><dt>Amount and reference</dt><dd>{MONEY.quoteExact} · <span className="kauro-d-mono">{grouped}</span></dd></div>
            <div><dt>Held until</dt><dd>{moment(RETENTION.holdUntil)} ({HOLD_BUSINESS_DAYS} business days, proposed)</dd></div>
          </dl>
          <p className="kauro-d-note">A proof that does not match a credit is reviewed by Kauro; it never counts as payment and never keeps the files past the hold.</p>
        </section>
      ) : null}
      {when === "hold-expired" ? (
        <section className="kauro-d-section" aria-labelledby="d-after-h">
          <h2 id="d-after-h">If the money still arrives</h2>
          <p>Kauro reviews it and returns it to the account it came from. To buy, upload the files again: a new check and a new quote follow.</p>
        </section>
      ) : null}
      <section className="kauro-d-section" aria-labelledby="d-limits-h">
        <h2 id="d-limits-h">What a hold can and cannot do</h2>
        <ul className="kauro-d-limits">
          <li>It starts only with the proof of a transfer already sent, for the exact amount, with this order&apos;s reference.</li>
          <li>It is given once per quote and per set of files. Another order, a new quote for the same files or a second proof starts none.</li>
          <li>It lasts up to {HOLD_BUSINESS_DAYS} business days from the proof, is never renewed and is never added to the extension. It never passes {moment(RETENTION.unpaidCeiling)} ({UNPAID_CEILING_DAYS} days from sealing).</li>
          <li>It is not payment. Preparation starts only after Kauro confirms the exact amount.</li>
        </ul>
      </section>
      <section className="kauro-d-section" aria-labelledby="d-dates-h">
        <h2 id="d-dates-h">The dates that end something</h2>
        <FiveDates when={when} ctx={ctx} />
      </section>
      <p className="kauro-d-note">Price valid until {moment(TIMELINE.quoteExpiresAt)}. Send by {moment(TIMELINE.sendBy)}, as the bank details say.</p>
    </>
  );
}

/** The proof of a transfer already sent: who gives it, what it is, and what it does. */
function SentProof({ pays, ctxLine }: { readonly pays: boolean; readonly ctxLine: string }): ReactElement {
  const [errors, setErrors] = useState<readonly { readonly fieldId: string; readonly message: string }[]>([]);
  const [done, setDone] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found: { fieldId: string; message: string }[] = [];
    if (!/^[0-9]{6,20}$/.test(String(data.get("trace") ?? "").replace(/\s/g, ""))) found.push({ fieldId: "d-trace", message: "Enter the trace or confirmation number your bank gave, 6 to 20 digits" });
    if (data.get("sent") !== "on") found.push({ fieldId: "d-sent", message: "Confirm the transfer was already sent, for the exact amount, with the reference" });
    setErrors(found);
    setDone(found.length === 0);
  };
  return (
    <section className="kauro-d-section" aria-labelledby="d-sent-h">
      <h2 id="d-sent-h">Already sent the transfer?</h2>
      <p>If your bank has already sent it, give its proof. Kauro then holds the files for up to {HOLD_BUSINESS_DAYS} business days while the money arrives. Only once per quote.</p>
      {pays ? (
        done ? (
          <Banner tone="success" title="The files are held while the money arrives" announce="status">
            <p>Held until {moment(RETENTION.holdUntil)}. This is not payment: Kauro confirms the payment when the exact amount arrives.</p>
          </Banner>
        ) : (
          <form className="kauro-d-form" noValidate onSubmit={submit}>
            <ErrorSummary title="There is a problem" errors={errors} />
            <Field id="d-trace" label="Trace or confirmation number" hint="On your bank's confirmation of the sent transfer" error={errors.find((one) => one.fieldId === "d-trace")?.message}>
              {(control) => <input {...control} name="trace" inputMode="numeric" autoComplete="off" spellCheck={false} />}
            </Field>
            <Field id="d-file" label="Your bank's confirmation (optional)" hint="A PDF or image of the sent transfer, with the amount, the reference and the date">
              {(control) => <input {...control} name="file" type="file" accept=".pdf,image/png,image/jpeg" />}
            </Field>
            <label className="kauro-d-check" htmlFor="d-sent">
              <input id="d-sent" name="sent" type="checkbox" aria-invalid={errors.some((one) => one.fieldId === "d-sent") ? true : undefined} />
              <span>The transfer was already sent from our organisation&apos;s account, for {MONEY.quoteExact}, with the reference {grouped}.</span>
            </label>
            <div className="kauro-actions">
              <Button type="submit" variant="primary">
                Hold the files while it arrives
              </Button>
            </div>
          </form>
        )
      ) : (
        <Only>{ctxLine}</Only>
      )}
    </section>
  );
}
