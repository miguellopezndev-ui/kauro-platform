// UI18 Free data health check as markup. Separates what the api reports (status, deadlines, allowance), the decisions waiting for the
// person, and what is not supported; a used-up allowance keeps the measured profile and says the interpretation is incomplete. Customer
// strings and codes are text nodes. Pure markup: the container owns the read and the cancel run.
import { Banner, Button, Deadline, LinkButton, StatusBadge, type Tone } from "@kauro/ui";
import type { ReactElement } from "react";
import type { AuditView } from "../../api/generated.ts";
import { message } from "../../copy/en.ts";
import { healthCheckModel } from "./model.ts";

export interface HealthCheckViewProps {
  readonly audit: AuditView;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  readonly cancelling: boolean;
  /** The plan's page, when this build has it: offered once the check has a draft plan. */
  readonly planHref?: string | null;
}

const TONE: Readonly<Record<AuditView["state"], Tone>> = {
  QUEUED: "info",
  PROFILING: "info",
  INTERPRETING: "info",
  VALIDATING: "info",
  DRAFT_READY: "success",
  NEEDS_DECISION: "warning",
  UNSUPPORTED: "warning",
  FAILED: "danger",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};

/** The phases a check goes through, in order; where the check is comes from its state alone (Order 11). */
const PHASES = ["PROFILING", "INTERPRETING", "VALIDATING", "DRAFT_READY"] as const;
const PHASE_AT: Readonly<Partial<Record<AuditView["state"], number>>> = { QUEUED: -1, PROFILING: 0, INTERPRETING: 1, VALIDATING: 2, DRAFT_READY: 3, NEEDS_DECISION: 3 };

function Phases({ state }: { readonly state: AuditView["state"] }): ReactElement | null {
  const at = PHASE_AT[state];
  if (at === undefined) return null;
  return (
    <ol className="kauro-check-phases" aria-label={message("screen.health.phases.label")}>
      {PHASES.map((phase, index) => {
        const name = index === 3 && state === "NEEDS_DECISION" ? message("screen.health.state.NEEDS_DECISION") : message(`screen.health.state.${phase}`);
        const done = index < at || (index === 3 && state === "DRAFT_READY");
        const current = index === at && !done;
        return (
          <li key={phase} className={done ? "kauro-check-phase kauro-check-phase--done" : current ? "kauro-check-phase kauro-check-phase--current" : "kauro-check-phase"} aria-current={current ? "step" : undefined}>
            {name}
          </li>
        );
      })}
    </ol>
  );
}

export function HealthCheckDetails({ audit, onRefresh, onCancel, cancelling, planHref = null }: HealthCheckViewProps): ReactElement {
  const model = healthCheckModel(audit);
  return (
    <div className="kauro-health-check">
      <section className="kauro-set-status" aria-labelledby="health-status">
        <h2 id="health-status">{message("screen.health.state.label")}</h2>
        <p role="status">
          <StatusBadge tone={TONE[model.state]}>{message(`screen.health.state.${model.state}`)}</StatusBadge>
        </p>
        {model.running ? <p className="kauro-set-open">{message("screen.health.progress.body")}</p> : null}
      </section>
      <Phases state={model.state} />
      <dl className="kauro-facts-grid">
        <div>
          <dt>{message("screen.health.started.label")}</dt>
          <dd>
            <Deadline at={audit.startedAt} timeZone="UTC" />
          </dd>
        </div>
        {audit.interpretationDeadlineAt === undefined ? null : (
          <div>
            <dt>{message("screen.health.interpretation.label")}</dt>
            <dd>
              <Deadline at={audit.interpretationDeadlineAt} timeZone="UTC" />
            </dd>
          </div>
        )}
        <div>
          <dt>{message("screen.health.deadline.label")}</dt>
          <dd>
            <Deadline at={audit.absoluteDeadline} timeZone="UTC" />
          </dd>
        </div>
        <div>
          <dt>{message("screen.health.grant.label")}</dt>
          <dd>{message(`screen.health.grant.${audit.grantState}`)}</dd>
        </div>
      </dl>
      {model.interpretationIncomplete ? (
        <Banner tone="warning" title={message("screen.health.exhausted.title")} announce="status">
          <p>{message("screen.health.exhausted.body")}</p>
        </Banner>
      ) : null}
      {model.terminalReason === null ? null : (
        <p>
          {message("screen.health.reason.label")}: <code>{model.terminalReason}</code>
        </p>
      )}
      <section className="kauro-screen-section" aria-labelledby="health-decisions">
        <h2 id="health-decisions">{message("screen.health.decisions.heading")}</h2>
        {model.pendingDecisions.length === 0 ? (
          <p className="kauro-set-open">{message("screen.health.decisions.none.body")}</p>
        ) : (
          <ul className="kauro-codes">
            {model.pendingDecisions.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
      {model.unsupportedCapabilities.length === 0 ? null : (
        <section className="kauro-screen-section" aria-labelledby="health-unsupported">
          <h2 id="health-unsupported">{message("screen.health.unsupported.heading")}</h2>
          <ul className="kauro-codes">
            {model.unsupportedCapabilities.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="kauro-actions">
        {model.state === "DRAFT_READY" && planHref !== null ? (
          <LinkButton href={planHref} variant="primary">
            {message("screen.health.plan.cta")}
          </LinkButton>
        ) : null}{" "}
        {model.terminal ? null : (
          <Button variant="secondary" onClick={onRefresh}>
            {message("screen.health.refresh.label")}
          </Button>
        )}{" "}
        {model.canCancel ? (
          <Button variant="secondary" disabled={cancelling} aria-busy={cancelling ? true : undefined} onClick={() => (cancelling ? undefined : onCancel())}>
            {message("screen.health.cancel.cta")}
          </Button>
        ) : null}
      </p>
      {cancelling ? <p role="status">{message("screen.health.cancel.working.body")}</p> : null}
    </div>
  );
}

/** No check has been requested for the project (no audit in the address). */
export function NoHealthCheck(): ReactElement {
  return (
    <section>
      <h2>{message("screen.health.none.title")}</h2>
      <p>{message("screen.health.none.body")}</p>
    </section>
  );
}
