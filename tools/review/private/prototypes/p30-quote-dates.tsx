"use client";
// P-30 (proposal beside UI23 Quote; owner decision of 2026-10-21, Orders 11–12, design only): the quote's dates as the owner decided them.
// The quote as built (UI23) keeps two dates side by side; this proposal shows the five dates that can end something, kept apart (the
// price, the free check's files, the one extension, the hold for a pending transfer, the paid project's retention), and what each moment
// asks of whom. Nothing here changes the quote's price or its terms; the proposed values (17 days, five business days, the 24-day ceiling)
// wait for the checks named in docs/design/ORDER11-FUNCTIONAL-GAPS.md (F-19 to F-24).
import type { ReactElement } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { moment, NextStep, Only, ScreenButton, ScreenLink } from "./kit.tsx";
import { MONEY } from "./money.ts";
import { can, onlyLine, whoCan } from "./people.ts";
import { FiveDates } from "./retention-dates.tsx";
import { HOLD_BUSINESS_DAYS, RETENTION, type RetentionMoment } from "./retention.ts";
import { TIMELINE } from "./timeline.ts";

export const P30_STATES: readonly StateDef[] = [
  { key: "normal", label: "Free check, files end first", note: "The quote is valid to Nov 3, but the free check's files go on Oct 27: the page says to pay before, and that one extension is available." },
  { key: "extended", label: "Free check, extension requested", note: "An owner asked for the one extension: the free check's files stay 3 more days (Oct 30). With it they may pass 14 days from sealing, never 17." },
  { key: "held", label: "Transfer pending, within its hold", note: "The transfer was sent and its proof given: the files are held up to 5 business days (proposed) while Kauro waits for the money. Not payment; preparation cannot start." },
  { key: "hold-expired", label: "Hold ended, no payment", note: "The hold ended without a confirmed payment: the files are deleted, the quote cannot be paid, a late transfer is reviewed and returned." },
  { key: "paid", label: "Paid", note: "The payment is confirmed: the free check's dates no longer apply; the paid project's retention starts." },
];

const MOMENT: Readonly<Record<string, RetentionMoment>> = { normal: "check", extended: "extended", held: "held", "hold-expired": "hold-expired", paid: "paid" };

export function QuoteDates({ ctx, state, project }: PrototypeProps): ReactElement {
  const when = MOMENT[state] ?? "check";
  const pays = can(ctx, "pay");
  const extends_ = can(ctx, "delete");
  const status =
    when === "paid"
      ? { tone: "success" as const, text: "Paid" }
      : when === "held"
        ? { tone: "warning" as const, text: "Transfer pending" }
        : when === "hold-expired"
          ? { tone: "danger" as const, text: "Files deleted" }
          : { tone: "warning" as const, text: "Waiting for payment" };
  return (
    <>
      <ProjectHeader stage={when === "paid" ? "preparation" : "purchase"} title="Quote" lead="Review price, scope and availability." status={status} />
      <p className="kauro-d-proposed kauro-d-proposed--page">
        Proposed for Orders 11–12 (owner decision of Oct 21, 2026): the quote&apos;s dates. The price, scope and terms are as built (<ScreenLink to="UI23" ctx={ctx} project={project.projectId}>the quote as built</ScreenLink>).
      </p>
      {when === "check" ? (
        <NextStep
          id="d-next"
          heading={`Pay before ${moment(TIMELINE.filesKeptUntil)}`}
          facts={[
            ["Who", whoCan(ctx, "pay")],
            ["By", moment(TIMELINE.filesKeptUntil)],
            ["If not", "The free check's files are deleted and the quote cannot be paid; you would upload again"],
          ]}
          action={pays ? <ScreenButton to="UI23" ctx={ctx} project={project.projectId} variant="primary">Review and accept the quote</ScreenButton> : undefined}
        >
          <p>
            The price of {MONEY.quoteExact} is valid until {moment(TIMELINE.quoteExpiresAt)}, but the files of the free check are kept only until {moment(TIMELINE.filesKeptUntil)}. {extends_ ? "You can" : `${whoCan(ctx, "delete")} can`} ask once for up to 3 more days.
          </p>
        </NextStep>
      ) : null}
      {when === "extended" ? (
        <NextStep
          id="d-next"
          heading={`Pay before ${moment(RETENTION.extendedUntil)}`}
          facts={[
            ["Who", whoCan(ctx, "pay")],
            ["By", moment(RETENTION.extendedUntil)],
            ["If not", "The files are deleted; no second extension exists"],
          ]}
          action={pays ? <ScreenButton to="UI23" ctx={ctx} project={project.projectId} variant="primary">Review and accept the quote</ScreenButton> : undefined}
        >
          <p>The one extension was requested on {moment(RETENTION.extensionRequestedAt)}: the free check&apos;s files now stay until {moment(RETENTION.extendedUntil)}. The price is unchanged.</p>
        </NextStep>
      ) : null}
      {when === "held" ? (
        <NextStep
          id="d-next"
          label="Waiting for the transfer"
          heading={`Files held until ${moment(RETENTION.holdUntil)}`}
          facts={[
            ["Who", "Kauro, when the money arrives"],
            ["Proof given", moment(RETENTION.proofAt)],
            ["If not", "The hold ends, the files are deleted and a late transfer is returned"],
          ]}
          action={<ScreenLink to="P-31" ctx={ctx} project={project.projectId}>See the payment and its hold</ScreenLink>}
        >
          <p>
            A transfer for {MONEY.quoteExact} was sent and its proof given. Kauro holds the files up to {HOLD_BUSINESS_DAYS} business days while the money arrives. This is not payment: preparation starts only once Kauro confirms the transfer.
          </p>
        </NextStep>
      ) : null}
      {when === "hold-expired" ? (
        <NextStep
          id="d-next"
          label="The files are gone"
          heading="Upload the files again for a new quote"
          facts={[
            ["Who", whoCan(ctx, "operate")],
            ["Deleted", moment(RETENTION.holdUntil)],
            ["A transfer that still arrives", "Reviewed and returned to the account it came from"],
          ]}
          action={can(ctx, "operate") ? <ScreenButton to="UI14" ctx={ctx} project={project.projectId} variant="primary">Upload the files again</ScreenButton> : undefined}
        >
          <p>The hold ended on {moment(RETENTION.holdUntil)} without a confirmed payment, so the files were deleted. This quote cannot be paid any more, and its hold cannot be renewed.</p>
        </NextStep>
      ) : null}
      {when === "paid" ? (
        <NextStep
          id="d-next"
          label="Paid"
          heading="Your team can start the preparation"
          facts={[
            ["Who", whoCan(ctx, "operate")],
            ["Payment confirmed", moment(RETENTION.paidWhileHeld)],
            ["Files kept", `7 days after the package is ready, never after ${moment(RETENTION.paidHardLimit)}`],
          ]}
          action={can(ctx, "operate") ? <ScreenButton to="UI25" ctx={ctx} project={project.projectId} variant="primary">Go to the preparation</ScreenButton> : undefined}
        />
      ) : null}
      {pays || when === "hold-expired" || when === "paid" ? null : <Only>{onlyLine(ctx, "pay", "accept the quote and pay it")}</Only>}
      <section className="kauro-d-section" aria-labelledby="d-dates-h">
        <h2 id="d-dates-h">The dates that end something</h2>
        <FiveDates when={when} ctx={ctx} />
      </section>
      <details className="kauro-d-help">
        <summary>How Kauro keeps your files before and after payment</summary>
        <ul>
          <li>The price and the files have separate dates. The earlier one is the one to plan for.</li>
          <li>The free check&apos;s files stay 7 days after the check, never past 14 days from sealing, unless the one extension is asked for (never past 17 days).</li>
          <li>When a transfer has been sent and its proof given, the files are held a short time while the money arrives. A hold is not payment, cannot be renewed and is given once per quote and per set of files.</li>
          <li>After Kauro confirms the payment, the paid project&apos;s dates apply: 7 days after the package is ready, never past 14 days from the payment.</li>
        </ul>
      </details>
    </>
  );
}
