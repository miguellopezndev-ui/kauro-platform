// UI25 Processing as markup. The five phases are listed separately (PhaseList: words and icons, never a bar or a percentage), named in the
// customer's words (research agency-workspace.md section 5.14: "Queue, Startup, Execution, Verification, Publication" were the job engine's
// words), with when the work was queued and when the page last read it. Round 2 removed the ticking elapsed time (a number that grows reads
// as worry, not information), the delivery deadline (no policy states a preparation time, C-6) and the worker's heartbeat (internal); the
// page says instead that nothing is needed and the person can leave. Cancelling is destructive, so it sits last and apart, with what it
// does at this phase. Pure markup: the container owns the reads, the clock and the two commands.
import { Banner, Button, Deadline, LinkButton, PhaseList, StatusBadge, type Phase, type PhaseState, type Tone } from "@kauro/ui";
import type { ReactElement } from "react";
import type { JobView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { type ExecuteOffer, jobModel } from "./model.ts";

const TONE: Readonly<Record<JobView["state"], Tone>> = {
  QUEUED: "info",
  ADMITTED: "info",
  RUNNING: "info",
  VERIFYING: "info",
  READY: "success",
  FAILED: "danger",
  CANCEL_REQUESTED: "warning",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};

const PHASE_COPY: Readonly<Record<PhaseState, string>> = {
  done: message("screen.processing.phase.done"),
  current: message("screen.processing.phase.current"),
  upcoming: message("screen.processing.phase.upcoming"),
  failed: message("screen.processing.phase.failed"),
};

export interface ProcessingViewProps {
  readonly job: JobView;
  /** The browser clock, from shared/use-now.ts: it only words the elapsed time. */
  readonly nowMs: number;
  /** When this page last read the job (an RFC 3339 instant the container formats from its own read). */
  readonly readAt: string;
  readonly supportHref: string;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  readonly cancelling: boolean;
  /** CMD037 was recorded in this page: say so (the job read back may already show it). */
  readonly cancelRecorded: boolean;
  /** The delivery's page, when this build has it: offered once the package is ready. */
  readonly deliveryHref?: string | null;
}


export function ProcessingDetails({ job, nowMs, readAt, supportHref, onRefresh, onCancel, cancelling, cancelRecorded, deliveryHref = null }: ProcessingViewProps): ReactElement {
  const model = jobModel(job, nowMs);
  const phases: readonly Phase[] | null = model.phases === null ? null : model.phases.map((phase) => ({ id: phase.id, label: message(`screen.processing.phase.${phase.id}`), state: phase.status }));
  const advice = job.state === "QUEUED" || job.state === "ADMITTED" || job.state === "RUNNING" || job.state === "VERIFYING" ? null : (`screen.processing.next.${job.state}.body` as const);
  return (
    <div className="kauro-processing">
      <section className="kauro-set-status" aria-labelledby="processing-status">
        <h2 id="processing-status">{message("screen.processing.state.label")}</h2>
        <p role="status">
          <StatusBadge tone={TONE[job.state]}>{message(`screen.processing.state.${job.state}`)}</StatusBadge>
        </p>
        {model.ended ? null : <p className="kauro-set-open">{message("screen.processing.leave.body")}</p>}
      </section>
      <section className="kauro-processing-work" aria-labelledby="processing-phases">
        <h2 id="processing-phases">{message("screen.processing.phases.heading")}</h2>
        {model.ended ? null : <p className="kauro-processing-note">{message("screen.processing.estimate.body")}</p>}
        {phases === null ? null : <PhaseList label={message("screen.processing.phases.label")} phases={phases} copy={PHASE_COPY} />}
        <dl className="kauro-facts-grid">
          <div><dt>{message("screen.processing.queued.label")}</dt><dd><Deadline at={job.queuedAt} timeZone="UTC" /></dd></div>
          <div><dt>{message("screen.processing.updated.label")}</dt><dd><Deadline at={readAt} timeZone="UTC" /></dd></div>
        </dl>
        {advice === null ? null : (
          <Banner tone={TONE[job.state] === "danger" ? "danger" : "info"} title={message(`screen.processing.state.${job.state}`)} announce="status">
            <p>{message(advice)}</p>
          </Banner>
        )}
      </section>
      <p className="kauro-actions">
        {job.state === "READY" && deliveryHref !== null ? (
          <LinkButton href={deliveryHref} variant="primary">
            {message("screen.processing.delivery.cta")}
          </LinkButton>
        ) : null}{" "}
        {model.ended ? null : (
          <Button variant="secondary" onClick={onRefresh}>
            {message("screen.processing.refresh.label")}
          </Button>
        )}{" "}
        <a className="kauro-processing-support" href={supportHref}>
          {message("screen.processing.support.cta")}
        </a>
      </p>
      {model.cancelExplains === null ? null : (
        <section className="kauro-processing-cancel" aria-labelledby="processing-cancel">
          <h2 id="processing-cancel">{message("screen.processing.cancel.heading")}</h2>
          <p>{message(`screen.processing.cancel.${model.cancelExplains}.body`)}</p>
          {model.canCancel ? (
            <p className="kauro-actions">
              <Button variant="secondary" disabled={cancelling} aria-busy={cancelling ? true : undefined} onClick={() => (cancelling ? undefined : onCancel())}>
                {message("screen.processing.cancel.cta")}
              </Button>
            </p>
          ) : null}
        </section>
      )}
      {cancelling ? <p role="status">{message("screen.processing.cancel.working.body")}</p> : null}
      {cancelRecorded ? <p role="status">{message("screen.processing.cancel.done.body")}</p> : null}
    </div>
  );
}

/** The execute control (CMD036), only for the offer the model made: an unapproved newer plan is stale and carries no control. */
export function ExecutePanel({ offer, onExecute, executing }: { readonly offer: ExecuteOffer; readonly onExecute: () => void; readonly executing: boolean }): ReactElement {
  if (offer.kind === "STALE") {
    return (
      <Banner tone="warning" title={message("screen.processing.execute.stale.title")} announce="alert">
        <p>{message("screen.processing.execute.stale.body")}</p>
      </Banner>
    );
  }
  if (offer.kind === "NONE") {
    return (
      <Banner tone="info" title={message("screen.processing.execute.unavailable.title")} announce="status">
        <p>{message("screen.processing.execute.unavailable.body")}</p>
      </Banner>
    );
  }
  return (
    <section aria-labelledby="processing-execute">
      <h2 id="processing-execute">{message("screen.processing.execute.heading")}</h2>
      <p>{message("screen.processing.execute.body")}</p>
      <p className="kauro-actions">
        <Button disabled={executing} aria-busy={executing ? true : undefined} onClick={() => (executing ? undefined : onExecute())}>
          {message("screen.processing.execute.cta")}
        </Button>
      </p>
      {executing ? <p role="status">{message("screen.processing.execute.working.body")}</p> : null}
    </section>
  );
}

/** Nothing named in the address yet. */
export function NothingProcessing(): ReactElement {
  return (
    <section>
      <h2>{message("screen.processing.none.title")}</h2>
      <p>{message("screen.processing.none.body")}</p>
    </section>
  );
}
