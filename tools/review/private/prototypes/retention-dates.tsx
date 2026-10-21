"use client";
// The five dates that can end something, as one table that reads the same on the Quote, the Payment, the Overview and Data and deletion
// (owner decision of 2026-10-21; retention.ts). Each row names what ends, its date, the rule behind it and its state in words; a proposed
// value carries the Proposed marker until its check is done. The table never adds two holds together and never shows a date nobody can
// reach: a row that does not apply yet says when it would start.
import type { ReactElement, ReactNode } from "react";
import type { ReviewContext } from "../lib/contexts.ts";
import { Badge, moment } from "./kit.tsx";
import { whoCan } from "./people.ts";
import { EXTENDED_CEILING_DAYS, HOLD_BUSINESS_DAYS, RETENTION, type RetentionMoment, UNPAID_CEILING_DAYS } from "./retention.ts";
import { TIMELINE } from "./timeline.ts";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

interface DateRow {
  readonly key: string;
  readonly what: string;
  readonly date: ReactNode;
  readonly rule: ReactNode;
  readonly state: { readonly tone: Tone; readonly text: string };
  readonly proposed?: boolean;
}

function Proposed(): ReactElement {
  return <span className="kauro-d-proposed">Proposed</span>;
}

/** The rows of one moment, in the order the five things happen. */
export function dateRows(when: RetentionMoment, ctx: ReviewContext): readonly DateRow[] {
  const extended = when === "extended";
  const held = when === "held";
  const expired = when === "hold-expired";
  const paid = when === "paid";
  return [
    {
      key: "quote",
      what: "Price valid until",
      date: moment(TIMELINE.quoteExpiresAt),
      rule: "14 days after the quote was issued. A transfer credited in time keeps this price.",
      state: expired ? { tone: "neutral", text: "Cannot be paid: the files are gone" } : paid ? { tone: "success", text: "Paid" } : { tone: "info", text: "Valid" },
    },
    {
      key: "files",
      what: "Files of the free check kept until",
      date: expired ? `Deleted ${moment(RETENTION.holdUntil)}` : held ? `Held until ${moment(RETENTION.holdUntil)}` : moment(extended ? RETENTION.extendedUntil : TIMELINE.filesKeptUntil),
      rule: (
        <>
          7 days after the check was ready, while nothing is bought; ordinarily never after {moment(RETENTION.ordinaryCeiling)} (14 days from sealing).
        </>
      ),
      state: expired ? { tone: "danger", text: "Deleted" } : paid ? { tone: "neutral", text: "Replaced by the paid project's dates" } : held ? { tone: "warning", text: "Held for the transfer" } : extended ? { tone: "warning", text: "Extended" } : { tone: "info", text: "Kept" },
    },
    {
      key: "extension",
      what: "Extension",
      date: extended ? moment(RETENTION.extendedUntil) : paid || expired || held ? "—" : `Up to ${moment(RETENTION.extendedUntil)}`,
      rule: (
        <>
          One request a project, up to 3 more days, by {whoCan(ctx, "delete")}. With it the files may stay past 14 days from sealing, never past{" "}
          {moment(RETENTION.extendedCeiling)} ({EXTENDED_CEILING_DAYS} days). <Proposed />
        </>
      ),
      state: extended
        ? { tone: "warning", text: `Used ${moment(RETENTION.extensionRequestedAt)}` }
        : held
          ? { tone: "neutral", text: "Not added to the hold" }
          : paid || expired
            ? { tone: "neutral", text: "Not used" }
            : { tone: "info", text: "Available" },
      proposed: true,
    },
    {
      key: "hold",
      what: "Held for a pending transfer",
      date: held ? `Until ${moment(RETENTION.holdUntil)}` : expired ? `Ended ${moment(RETENTION.holdUntil)}` : "—",
      rule: (
        <>
          Only after a transfer was sent and its proof given: {HOLD_BUSINESS_DAYS} business days from the proof, once per quote and per set of files, never renewed,
          never added to the extension, never past {moment(RETENTION.unpaidCeiling)} ({UNPAID_CEILING_DAYS} days from sealing). Preparation never starts on a hold. <Proposed />
        </>
      ),
      state: held
        ? { tone: "warning", text: `Proof given ${moment(RETENTION.proofAt)}` }
        : expired
          ? { tone: "danger", text: "Ended without a confirmed payment" }
          : paid
            ? { tone: "neutral", text: "Not needed" }
            : { tone: "neutral", text: "Not started" },
      proposed: true,
    },
    {
      key: "paid",
      what: "Kept after payment",
      date: paid ? `Never after ${moment(RETENTION.paidHardLimit)}` : "—",
      rule: "From the confirmed payment: 7 days after the package is ready, never past 14 days from the payment.",
      state: paid ? { tone: "success", text: `Payment confirmed ${moment(RETENTION.paidWhileHeld)}` } : { tone: "neutral", text: "Starts when Kauro confirms the payment" },
    },
  ];
}

/** The table of the five dates, with its caption naming the moment. */
export function FiveDates({ when, ctx, caption }: { readonly when: RetentionMoment; readonly ctx: ReviewContext; readonly caption?: string }): ReactElement {
  const rows = dateRows(when, ctx);
  return (
    <table className="kauro-rtable kauro-d-dates">
      <caption>{caption ?? "Five dates can end something in this project. Each is kept apart."}</caption>
      <thead>
        <tr>
          <th scope="col">What ends</th>
          <th scope="col">Date (UTC)</th>
          <th scope="col">The rule</th>
          <th scope="col">Now</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row" data-label="">
              {row.what}
            </th>
            <td data-label="Date">
              <span>{row.date}</span>
            </td>
            <td data-label="Rule" className="kauro-d-rule">
              <span>{row.rule}</span>
            </td>
            <td data-label="Now">
              <Badge tone={row.state.tone}>{row.state.text}</Badge>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
