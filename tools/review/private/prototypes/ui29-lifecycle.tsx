"use client";
// UI29 Data and deletion (registry: "See what remains and what will be deleted."), rebuilt in Order 11 round 2 (research
// agency-workspace.md §5.18; principles-craft.md C11, V22). What Kauro holds for this project, until when, and the two things a person can
// do about it:
//   - one verdict line first ("Files and package deleted on …, unless you extend once (to …)");
//   - the schedule as a table with absolute dates (RetentionView: class, soft and hard deadlines, state), every date from timeline.ts and the
//     policy: a purchased package stays 7 days after it is ready, never past 14 days from the payment; one extension of up to 72 hours,
//     never past that limit;
//   - two separate panels, not a pair of buttons: More time (only while possible) and Delete now (irreversible and early, so it asks for the
//     project's name typed, then the authenticator code). Both are owner and admin actions (CMD060, CMD042); every other role reads one line
//     naming who can, and no control;
//   - what deletion does not reach, said plainly.
import { Banner, Button, ErrorSummary, Field } from "@kauro/ui";
import { type FormEvent, type ReactElement, useState } from "react";
import { ProjectHeader } from "@web/screens/shared/project-header.tsx";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import type { PrototypeProps } from "../lib/screens.tsx";
import type { StateDef } from "../lib/scenario.ts";
import { actor } from "./board.ts";
import { Badge, moment, Only } from "./kit.tsx";
import { can, onlyLine } from "./people.ts";
import { FiveDates } from "./retention-dates.tsx";
import { EXTENDED_CEILING_DAYS, RETENTION, type RetentionMoment } from "./retention.ts";
import { TIMELINE } from "./timeline.ts";

export const UI29_STATES: readonly StateDef[] = [
  { key: "normal", label: "Kept", note: "What the delivered project holds and when each goes; the one extension still available; early deletion with a typed confirmation." },
  { key: "extended", label: "Extended", note: "The one extension used: 3 more days, still inside the limit set by the payment date." },
  { key: "deletion", label: "Deletion requested", note: "An owner asked to delete the project's data now: what goes, and that the page says when it is done." },
  { key: "deleted", label: "Deleted", note: "The files and package are deleted on their date; nothing can bring them back." },
  { key: "check", label: "Free check, nothing bought (proposed)", note: "Owner decision of 2026-10-21: before a purchase, the five dates kept apart; the one extension is offered for the free check too, up to 17 days from sealing." },
  { key: "check-extended", label: "Free check, extension requested (proposed)", note: "The extension is used for the free check: the files stay 3 more days; no second extension; the hold and the extension never add up." },
  { key: "held", label: "Transfer pending, within its hold (proposed)", note: "The transfer was sent and its proof given: the files are held up to 5 business days, once, never renewed; early deletion is still possible." },
  { key: "hold-expired", label: "Hold ended (proposed)", note: "The hold ended without the money: the files are deleted on that date; a late transfer is returned." },
];

const UNPAID: Readonly<Record<string, RetentionMoment>> = { check: "check", "check-extended": "extended", held: "held", "hold-expired": "hold-expired" };

const R = POLICY_SNAPSHOT.retention;
const HOUR = 3_600_000;
const EXTENSION_HOURS = 72;
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
const until = TIMELINE.packageAvailableUntil;
const hard = TIMELINE.packageHardLimit;
const extendedUntil = iso(Math.min(Date.parse(until) + EXTENSION_HOURS * HOUR, Date.parse(hard)));
const requestedAt = iso(Date.parse(TIMELINE.packageReadyAt) + 18 * HOUR);

interface Row {
  readonly what: string;
  readonly holds: string;
  readonly until: string;
  readonly rule: string;
  readonly state: "kept" | "deleting" | "deleted";
}

export function Lifecycle({ ctx, state, project }: PrototypeProps): ReactElement {
  const unpaid = UNPAID[state];
  if (unpaid !== undefined) return <UnpaidLifecycle ctx={ctx} when={unpaid} project={project} />;
  const clean = project.mode === "CLEAN";
  const extended = state === "extended";
  const gone = state === "deleted";
  const deleting = state === "deletion";
  const mayAct = can(ctx, "delete");
  const ends = extended ? extendedUntil : until;
  const files: Row["state"] = gone ? "deleted" : deleting ? "deleting" : "kept";
  const rows: readonly Row[] = [
    {
      what: "Files, plan and package",
      holds: "The sealed files, the approved plan, the package and its report",
      until: gone ? `Deleted ${moment(until)}` : moment(ends),
      rule: `${R.paidDaysFromFirstPackage} days after the package was ready; never after ${moment(hard)}, ${R.paidDaysHardFromCapture} days after the payment`,
      state: files,
    },
    ...(clean
      ? []
      : [
          {
            what: "Import results",
            holds: "The exports your team returned, and their checks",
            until: `${R.importReceiptDaysFromTerminal} days after each check is final`,
            rule: "Or with the project's files, while a stage still needs them",
            state: files,
          },
          {
            what: "Destination settings you confirmed",
            holds: "What your team uploaded and confirmed; never a password or a key",
            until: `Up to ${R.targetMetadataDaysFromLastUse} days after their last use`,
            rule: `Used for a new delivery for ${R.targetExecutionFreshnessDays} days at most`,
            state: "kept" as const,
          },
        ]),
    {
      what: "Financial and legal records",
      holds: "The quote, the order, the payment and the invoice; no CRM content",
      until: "For the period the law requires",
      rule: "Stored apart from CRM content",
      state: "kept",
    },
  ];
  const verdict = gone
    ? `The files, plan and package were deleted on ${moment(until)}.`
    : deleting
      ? `The files, plan and package are being deleted, at ${actor(ctx, "OWNER")}'s request.`
      : extended
        ? `Files, plan and package deleted on ${moment(extendedUntil)}. The one extension is used.`
        : `Files, plan and package deleted on ${moment(until)}, unless you extend once (to ${moment(extendedUntil)}).`;
  return (
    <>
      <ProjectHeader stage="delivery" title="Data and deletion" lead="See what remains and what will be deleted." />
      <p className="kauro-b-verdict">{verdict}</p>
      {deleting ? (
        <Banner tone="info" title={`Deletion requested on ${moment(requestedAt)}`} announce="status">
          <p>The project&apos;s files, package and import results are being deleted from Kauro&apos;s storage, staging and derived files. This page says when it is done, with the deletion record.</p>
        </Banner>
      ) : null}
      {gone ? (
        <Banner tone="neutral" title="The project's files are deleted" announce="status">
          <p>No extension can bring them back. To work on the same data again, start a new project and upload the files.</p>
        </Banner>
      ) : null}
      <section className="kauro-b-section" aria-labelledby="schedule-h">
        <h2 id="schedule-h">What Kauro holds for this project</h2>
        <table className="kauro-rtable kauro-b-schedule">
          <caption className="kauro-visually-hidden">What the project holds and when each kind is deleted</caption>
          <thead>
            <tr>
              <th scope="col">What is kept</th>
              <th scope="col">Until</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.what}>
                <td data-label="">
                  <span className="kauro-b-name-text">{row.what}</span>
                  <span className="kauro-sub">{row.holds}</span>
                </td>
                <td data-label="Until">
                  <span className="kauro-b-cell">
                    {row.until}
                    <span className="kauro-sub">{row.rule}</span>
                  </span>
                </td>
                <td data-label="State" className="kauro-b-nowrap">
                  {row.state === "deleted" ? <Badge tone="neutral">Deleted</Badge> : row.state === "deleting" ? <Badge tone="info">Being deleted</Badge> : <Badge tone="success">Kept</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {gone || deleting ? null : (
        <section className="kauro-b-section" aria-labelledby="actions-h">
          <h2 id="actions-h">More time, or delete now</h2>
          {mayAct ? null : <Only>{onlyLine(ctx, "delete", "extend the dates or delete this project's data")}</Only>}
          <div className="kauro-b-panels">
            <div className="kauro-b-panel">
              <h3>More time</h3>
              {extended ? (
                <p>The extension is used: the files now stay until {moment(extendedUntil)}. A project has one, and none is left.</p>
              ) : (
                <>
                  <p>A project can have one extension, of up to {EXTENSION_HOURS} hours, asked for before {moment(until)}. It never passes {moment(hard)}.</p>
                  <dl className="kauro-b-panel-fact">
                    <div>
                      <dt>New date</dt>
                      <dd>{moment(extendedUntil)}</dd>
                    </div>
                  </dl>
                  {mayAct ? <Button variant="secondary">Extend by 3 days</Button> : null}
                </>
              )}
            </div>
            <div className="kauro-b-panel">
              <h3>Delete now</h3>
              <p>Delete the files, plan, package and import results before their date. Copies already downloaded are not affected.</p>
              <dl className="kauro-b-panel-fact">
                <div>
                  <dt>Can be undone</dt>
                  <dd>No</dd>
                </div>
              </dl>
              {mayAct ? <DeleteNow name={project.name} /> : null}
            </div>
          </div>
        </section>
      )}
      <section className="kauro-b-section" aria-labelledby="residual-h">
        <h2 id="residual-h">What deletion does not reach</h2>
        <ul>
          <li>Copies your team downloaded stay with your team.</li>
          <li>Financial and legal records stay for the period the law requires, apart from CRM content.</li>
          <li>Nothing in your CRM: Kauro never had access to it.</li>
        </ul>
      </section>
    </>
  );
}

/** Early deletion: the project's name typed, then the authenticator code (CMD042 is a step-up command). */
function DeleteNow({ name }: { readonly name: string }): ReactElement {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!asking)
    return (
      <Button variant="secondary" onClick={() => setAsking(true)}>
        Request deletion
      </Button>
    );
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const typed = String(new FormData(event.currentTarget).get("confirm") ?? "").trim();
    setError(typed === name ? null : `Type the project's name exactly: ${name}`);
  };
  return (
    <form className="kauro-b-delete" noValidate onSubmit={submit}>
      <ErrorSummary title="There is a problem" errors={error === null ? [] : [{ fieldId: "delete-confirm", message: error }]} />
      <Field id="delete-confirm" label={`Type the project's name to confirm: ${name}`} hint="You confirm with your authenticator code next." error={error ?? undefined}>
        {(control) => <input {...control} name="confirm" autoComplete="off" spellCheck={false} />}
      </Field>
      <div className="kauro-actions">
        <Button type="submit" variant="danger">
          Delete the project&apos;s data
        </Button>
        <Button onClick={() => setAsking(false)}>Keep the data</Button>
      </div>
    </form>
  );
}

/**
 * Before a purchase (owner decision of 2026-10-21, proposed): the free check's files with the five dates kept apart, the one extension now
 * offered for the free check too (72 hours, and only through it past 14 days from sealing, never past 17), the hold for a pending transfer
 * when it applies, and early deletion. The hold and the extension never add up: the files go on the later of the two dates.
 */
function UnpaidLifecycle({ ctx, when, project }: { readonly ctx: PrototypeProps["ctx"]; readonly when: RetentionMoment; readonly project: PrototypeProps["project"] }): ReactElement {
  const mayAct = can(ctx, "delete");
  const extended = when === "extended";
  const held = when === "held";
  const gone = when === "hold-expired";
  const verdict = gone
    ? `The files and the check's results were deleted on ${moment(RETENTION.holdUntil)}, when the hold ended without a confirmed payment.`
    : held
      ? `Files held until ${moment(RETENTION.holdUntil)} while a sent transfer arrives. Not renewable.`
      : extended
        ? `Files of the free check deleted on ${moment(RETENTION.extendedUntil)}. The one extension is used.`
        : `Files of the free check deleted on ${moment(TIMELINE.filesKeptUntil)}, unless the one extension is asked for (to ${moment(RETENTION.extendedUntil)}).`;
  return (
    <>
      <ProjectHeader stage="purchase" title="Data and deletion" lead="See what remains and what will be deleted." />
      <p className="kauro-d-proposed kauro-d-proposed--page">Proposed for Orders 11–12 (owner decision of Oct 21, 2026): the free check&apos;s extension and the hold for a pending transfer.</p>
      <p className="kauro-b-verdict">{verdict}</p>
      <section className="kauro-b-section" aria-labelledby="d-unpaid-h">
        <h2 id="d-unpaid-h">The dates that end something</h2>
        <FiveDates when={when} ctx={ctx} caption="Before a purchase, five dates are kept apart. The files go on the earliest date that applies." />
      </section>
      {gone ? (
        <Banner tone="neutral" title="The project's files are deleted" announce="status">
          <p>To work on the same data again, upload the files again for a new check. A transfer that still arrives is reviewed and returned.</p>
        </Banner>
      ) : (
        <section className="kauro-b-section" aria-labelledby="d-unpaid-actions-h">
          <h2 id="d-unpaid-actions-h">More time, or delete now</h2>
          {mayAct ? null : <Only>{onlyLine(ctx, "delete", "extend the dates or delete this project's data")}</Only>}
          <div className="kauro-b-panels">
            <div className="kauro-b-panel">
              <h3>More time</h3>
              {extended ? (
                <p>The extension is used: the files now stay until {moment(RETENTION.extendedUntil)}. A project has one, and none is left.</p>
              ) : held ? (
                <p>The files are held for the transfer. An extension would not add to the hold: the files go on the later of the two dates, never both.</p>
              ) : (
                <>
                  <p>
                    One extension, of up to {EXTENSION_HOURS} hours, asked for before {moment(TIMELINE.filesKeptUntil)}. With it the files may stay past 14 days from sealing, never past {EXTENDED_CEILING_DAYS} days ({moment(RETENTION.extendedCeiling)}).
                  </p>
                  <dl className="kauro-b-panel-fact">
                    <div>
                      <dt>New date</dt>
                      <dd>{moment(RETENTION.extendedUntil)}</dd>
                    </div>
                  </dl>
                  {mayAct ? <Button variant="secondary">Extend by 3 days</Button> : null}
                </>
              )}
            </div>
            <div className="kauro-b-panel">
              <h3>Delete now</h3>
              <p>Delete the files and the check&apos;s results before their date. {held ? "This also ends the hold; the transfer is then returned when it arrives." : ""}</p>
              <dl className="kauro-b-panel-fact">
                <div>
                  <dt>Can be undone</dt>
                  <dd>No</dd>
                </div>
              </dl>
              {mayAct ? <DeleteNow name={project.name} /> : null}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
