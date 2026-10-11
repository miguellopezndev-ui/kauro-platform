"use client";
// UI22 Approval as markup: the exact effects with their counts, then the confirmation dialog of the design system (a native dialog with
// no form, every effect acknowledged by its own checkbox, Enter does nothing, Escape is Cancel). A blocked plan shows why and the way back
// to review, and no approve control at all.
import { Banner, ConfirmDialog, LinkButton, Button } from "@kauro/ui";
import { type ReactElement, useRef, useState } from "react";
import { message } from "../../copy/en.ts";
import { type ApprovalFacts, approvalGate } from "./model.ts";

export interface ApprovalViewProps {
  readonly facts: ApprovalFacts;
  /** Runs the step-up and CMD025; called only after every effect is acknowledged. */
  readonly onApprove: () => void;
  readonly approving: boolean;
  /** Server refusals tied to a disclosed effect (or to none). */
  readonly errors?: readonly { readonly effectId: string; readonly message: string }[];
  readonly reviewHref: string;
}

export function ApprovalDetails({ facts, onApprove, approving, errors, reviewHref }: ApprovalViewProps): ReactElement {
  const gate = approvalGate(facts);
  const [open, setOpen] = useState(false);
  const invoker = useRef<HTMLButtonElement>(null);
  return (
    <div className="kauro-approval">
      <p>{message("screen.approval.lead.body")}</p>
      <dl>
        <div><dt>{message("screen.approval.plan.label")}</dt><dd>{facts.planId}</dd></div>
      </dl>
      {gate.kind === "NOT_VALIDATED" ? (
        <Banner tone="warning" title={message("state.UNSAVED.title")} announce="alert"><p>{message("state.UNSAVED.body")}</p></Banner>
      ) : null}
      {gate.kind === "HIDDEN_EFFECT" ? (
        <Banner tone="danger" title={message("screen.approval.hidden.title")} announce="alert"><p>{message("screen.approval.hidden.body")}</p></Banner>
      ) : null}
      {gate.kind === "READY" ? <p>{message("screen.approval.validated.body")}</p> : null}
      <section aria-labelledby="approval-effects">
        <h2 id="approval-effects">{message("screen.approval.effects.heading")}</h2>
        <ul>
          {facts.effects.map((effect) => (
            <li key={effect.id}>
              {effect.description} ({effect.count} {message("screen.approval.effects.rows.label")})
            </li>
          ))}
        </ul>
      </section>
      <p className="kauro-actions">
        {gate.kind === "READY" ? (
          <Button ref={invoker} variant="primary" disabled={approving} aria-busy={approving ? true : undefined} onClick={() => setOpen(true)}>
            {message("screen.approval.open.cta")}
          </Button>
        ) : null}{" "}
        <LinkButton href={reviewHref}>{message("screen.approval.return.label")}</LinkButton>
      </p>
      {gate.kind === "READY" ? (
        <ConfirmDialog
          open={open}
          invoker={invoker}
          title={message("screen.approval.dialog.title")}
          summary={<p>{message("screen.approval.dialog.summary.body")}</p>}
          effects={facts.effects.map((effect) => ({
            id: effect.id,
            description: effect.description,
            count: effect.count,
            countLabel: message("screen.approval.effects.rows.label"),
            acknowledgeLabel: message("screen.approval.acknowledge.body", { effect: effect.description }),
          }))}
          errors={errors}
          copy={{ approve: message("screen.approval.dialog.approve.cta"), cancel: message("screen.approval.dialog.cancel.label"), errorSummaryTitle: message("screen.approval.dialog.errors.title") }}
          pending={approving}
          onCancel={() => setOpen(false)}
          onApprove={onApprove}
        />
      ) : null}
    </div>
  );
}
