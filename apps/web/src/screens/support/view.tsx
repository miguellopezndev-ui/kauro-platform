// UI52 Support cases as markup: the cases of one project with their status and the time the next response is due, one case in detail, the
// form that opens a case (warning against secrets and CRM rows, the attachments policy, the refusal with the secure-upload route) and the
// created case. Customer text (the summary) is always a text node. Pure markup: the container owns the reads, the form values and the run.
import { Banner, Button, Deadline, Field, LinkButton, StatusBadge, type Tone } from "@kauro/ui";
import type { ReactElement } from "react";
import type { GetSupportCaseReply, SupportCaseView } from "../../api/generated.ts";
import type { ApiAnswer } from "../../client/answer.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { stateOfAnswer } from "../../client/states.ts";
import { message } from "../../copy/en.ts";
import { CATEGORIES, type Category, type Refusal, type SummaryProblem } from "./model.ts";

const STATE_TONE: Readonly<Record<SupportCaseView["state"], Tone>> = {
  OPEN: "info",
  TRIAGED: "info",
  WAITING_KAURO: "info",
  WAITING_AGENCY: "warning",
  RESOLVED: "success",
  CLOSED: "neutral",
};

function CaseFacts({ item }: { readonly item: SupportCaseView }): ReactElement {
  return (
    <dl className="kauro-ledger-facts">
      <div><dt>{message("screen.support.case.category.label")}</dt><dd>{message(`screen.support.category.${item.category}`)}</dd></div>
      <div><dt>{message("screen.support.case.severity.label")}</dt><dd>{message(`screen.support.severity.${item.severity}`)}</dd></div>
      <div>
        <dt>{message("screen.support.case.state.label")}</dt>
        <dd><StatusBadge tone={STATE_TONE[item.state]}>{message(`screen.support.state.${item.state}`)}</StatusBadge></dd>
      </div>
      <div><dt>{message("screen.support.case.next.label")}</dt><dd><Deadline at={item.nextReviewAt} timeZone="America/Bogota" /></dd></div>
      <div><dt>{message("screen.support.case.opened.label")}</dt><dd><Deadline at={item.createdAt} timeZone="America/Bogota" /></dd></div>
    </dl>
  );
}

export interface CaseListProps {
  readonly cases: readonly SupportCaseView[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onMore: () => void;
  /** The address of one case; built by the container from the case id. */
  readonly caseHref: (caseId: string) => string;
}

export function CaseList({ cases, hasMore, loading, onMore, caseHref }: CaseListProps): ReactElement {
  if (cases.length === 0 && !loading) {
    return (
      <section>
        <h2>{message("screen.support.list.empty.title")}</h2>
        <p>{message("screen.support.list.empty.body")}</p>
      </section>
    );
  }
  return (
    <section className="kauro-screen-section" aria-labelledby="support-cases">
      <h2 id="support-cases">{message("screen.support.list.heading")}</h2>
      <p className="kauro-ledger-note">{message("screen.support.case.commitment.body")}</p>
      <ul className="kauro-ledger-list">
        {cases.map((item) => (
          <li key={item.caseId} className="kauro-ledger-item">
            <div className="kauro-ledger-item-head">
              <h3 className="kauro-case-summary">{item.summary}</h3>
              <LinkButton href={caseHref(item.caseId)} variant="secondary">
                {message("screen.support.case.open.cta")}
              </LinkButton>
            </div>
            <CaseFacts item={item} />
          </li>
        ))}
      </ul>
      {hasMore ? (
        <Button variant="secondary" disabled={loading} onClick={onMore}>
          {message("screen.support.list.more.cta")}
        </Button>
      ) : null}
    </section>
  );
}

/** One case; reached only from an answered read, so a refused read draws nothing of it. */
export function CaseDetail({ item, backHref }: { readonly item: SupportCaseView; readonly backHref: string }): ReactElement {
  return (
    <section className="kauro-ledger-item kauro-case" aria-labelledby="support-case">
      <h2 id="support-case">{message(`screen.support.category.${item.category}`)}</h2>
      <h3>{message("screen.support.case.summary.label")}</h3>
      <p className="kauro-case-text">{item.summary}</p>
      <CaseFacts item={item} />
      <p className="kauro-ledger-note">{message("screen.support.case.commitment.body")}</p>
      <LinkButton href={backHref} variant="secondary">
        {message("screen.support.case.back.cta")}
      </LinkButton>
    </section>
  );
}

/**
 * What a case link draws: the case only from a contract-valid read; every other answer (a revoked member's 403, a 404, a lost or failed
 * answer) is the shared state, which carries no case text. The case is never kept from an earlier read.
 */
export function CaseOrRefusal({ answer, backHref, onNext }: { readonly answer: ApiAnswer<GetSupportCaseReply>; readonly backHref: string; readonly onNext?: (() => void) | undefined }): ReactElement {
  if (answer.kind !== "REPLY") return <StatePanel decision={stateOfAnswer(answer)} onNext={onNext} />;
  return <CaseDetail item={answer.body.data} backHref={backHref} />;
}

export interface CaseFormProps {
  readonly category: Category;
  readonly summary: string;
  readonly onCategory: (value: Category) => void;
  readonly onSummary: (value: string) => void;
  readonly onSubmit: () => void;
  readonly submitting: boolean;
  /** Shown once the person tried to send. */
  readonly summaryProblem: SummaryProblem | null;
  readonly refusal: Refusal | null;
}

export function CaseForm({ category, summary, onCategory, onSummary, onSubmit, submitting, summaryProblem, refusal }: CaseFormProps): ReactElement {
  return (
    <section className="kauro-screen-section" aria-labelledby="support-form">
      <h2 id="support-form">{message("screen.support.form.heading")}</h2>
      <Banner tone="warning" title={message("screen.support.form.warning.title")}>
        <p>{message("screen.support.form.warning.body")}</p>
        <p>{message("screen.support.form.attachments.body")}</p>
      </Banner>
      {refusal === null ? null : (
        <Banner tone="danger" title={message("screen.support.form.refused.title")} announce="alert">
          <p>{message("screen.support.form.refused.body")}</p>
          {refusal.reason === null ? null : <p><code>{refusal.reason}</code></p>}
          {refusal.route === null ? null : (
            <LinkButton href={refusal.route} variant="secondary">
              {message("screen.support.form.secure-upload.cta")}
            </LinkButton>
          )}
        </Banner>
      )}
      <form
        className="kauro-panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitting) onSubmit();
        }}
      >
        <Field id="support-category" label={message("screen.support.form.category.label")}>
          {(control) => (
            <select {...control} value={category} onChange={(event) => onCategory(event.target.value as Category)}>
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {message(`screen.support.category.${value}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="support-summary"
          label={message("screen.support.form.summary.label")}
          hint={message("screen.support.form.summary.hint")}
          error={summaryProblem === null ? undefined : message(summaryProblem === "SHORT" ? "screen.support.form.summary.short.error" : "screen.support.form.summary.long.error")}
        >
          {(control) => <textarea {...control} name="summary" rows={6} value={summary} onChange={(event) => onSummary(event.target.value)} />}
        </Field>
        <p className="kauro-actions">
          <Button type="submit" disabled={submitting} aria-busy={submitting ? true : undefined}>
            {message("screen.support.form.submit.cta")}
          </Button>
        </p>
        {submitting ? <p role="status">{message("screen.support.form.working.body")}</p> : null}
      </form>
    </section>
  );
}

/** The case a run created, with its next response time. */
export function CaseCreated({ item, listHref }: { readonly item: SupportCaseView; readonly listHref: string }): ReactElement {
  return (
    <section aria-labelledby="support-created" role="status">
      <h2 id="support-created">{message("screen.support.created.title")}</h2>
      <p>{message("screen.support.created.body")}</p>
      <CaseFacts item={item} />
      <LinkButton href={listHref} variant="secondary">
        {message("screen.support.case.back.cta")}
      </LinkButton>
    </section>
  );
}

/** No project in the address: cases are project-scoped (Q-B11-1). */
export function ChooseProject(): ReactElement {
  return (
    <section>
      <h2>{message("screen.support.noproject.title")}</h2>
      <p>{message("screen.support.noproject.body")}</p>
    </section>
  );
}
