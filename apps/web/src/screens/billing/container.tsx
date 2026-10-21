"use client";
// The container of UI30 (design D-PRIV-1, D-OPS-1): reads the agency (what this member may do) and the order named in the address, runs the
// refund request (CMD044 then CMD031) through the page's runner, and reads the refund back from the server. The form's two keys are minted
// when the form opens and are renewed only after a completed answer, so a double activation and a lost answer replay the same keys.
import { useEffect, useRef, useState } from "react";
import { pathOf } from "../../screens.ts";
import type { ReactElement } from "react";
import { useShell } from "../../shell/shell-context.ts";
import { pageRunner, useCommand } from "../shared/run-command.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { useRead } from "../shared/use-read.ts";
import { type RefundForms, refundInputProblems, type RefundInputProblem, requestRefund } from "./model.ts";
import { BillingDetails, NoOrder } from "./view.tsx";

const NO_ANSWER = { kind: "NO_ANSWER", reason: "ABORTED", status: null } as const;

export function BillingScreen({ agencyId, orderId }: { readonly agencyId: string; readonly orderId: string | null }): ReactElement {
  const { client } = useShell();
  const agencyRead = useRead((signal) => client.call("GetAgency", { path: { agencyId }, signal }), agencyId);
  const orderRead = useRead((signal) => (orderId === null ? Promise.resolve(NO_ANSWER) : client.call("GetPaymentOrder", { path: { orderId }, signal })), `${agencyId}:${orderId ?? "none"}`);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [problems, setProblems] = useState<readonly RefundInputProblem[]>([]);
  const [refundId, setRefundId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // the form opens where the button was: focus moves to its heading, so a keyboard user carries on from there; another order closes it
  useEffect(() => {
    if (formOpen) document.getElementById("billing-refund-form")?.focus();
  }, [formOpen]);
  useEffect(() => setFormOpen(false), [orderId]);
  const forms = useRef<RefundForms | null>(null);
  const agency = agencyRead.state.kind === "ANSWERED" && agencyRead.state.answer.kind === "REPLY" ? agencyRead.state.answer.body.data : null;
  const detail = orderRead.state.kind === "ANSWERED" && orderRead.state.answer.kind === "REPLY" ? orderRead.state.answer.body.data : null;
  const refundRead = useRead((signal) => (refundId === null ? Promise.resolve(NO_ANSWER) : client.call("GetRefund", { path: { refundId }, signal })), refundId ?? "none");
  const refund = refundRead.state.kind === "ANSWERED" && refundRead.state.answer.kind === "REPLY" ? refundRead.state.answer.body.data : null;
  const command = useCommand(async () => {
    if (detail === null) throw new Error("NO_ORDER");
    const runner = pageRunner();
    forms.current ??= { caseForm: runner.openForm("CMD044"), refundForm: runner.openForm("CMD031") };
    const outcome = await requestRefund(client, runner, detail.order, { reason, details }, forms.current);
    if (outcome.kind === "COMPLETED" || outcome.kind === "RECOVERED") {
      forms.current = null;
      setRefundId(outcome.data.refund.refundId);
    }
    return outcome;
  });
  if (orderId === null) return <NoOrder projectsHref={pathOf("UI11", { agencyId })} />;
  if (agencyRead.state.kind === "LOADING" || orderRead.state.kind === "LOADING") return <StatePanel decision={agencyRead.state.kind === "LOADING" ? agencyRead.state.decision : orderRead.state.decision} />;
  if (agency === null) return <StatePanel decision={agencyRead.state.decision} onNext={agencyRead.refresh} />;
  if (detail === null) return <StatePanel decision={orderRead.state.decision} onNext={orderRead.refresh} />;
  const done = command.state.kind === "DONE" ? command.state : null;
  const created = done !== null && (done.outcome.kind === "COMPLETED" || done.outcome.kind === "RECOVERED") ? done.outcome.data.refund : null;
  const onSubmit = (): void => {
    const found = refundInputProblems({ reason, details });
    setProblems(found);
    if (found.length === 0) {
      command.run();
      return;
    }
    // the first field with a problem takes focus, so its message is read with it
    document.getElementById(found[0] === "REASON" ? "billing-refund-reason" : "billing-refund-details")?.focus();
  };
  return (
    <>
      <BillingDetails
        agency={agency}
        detail={detail}
        refund={refund ?? created}
        form={{ reason, details, problems, submitting: command.state.kind === "RUNNING", onReasonChange: setReason, onDetailsChange: setDetails, onSubmit, open: formOpen, onOpen: () => setFormOpen(true) }}
        projectHref={pathOf("UI13", { agencyId, id: detail.order.projectId })}
      />
      {done === null || created !== null ? null : <StatePanel decision={done.decision} onNext={done.decision.next === "RELOAD" || done.decision.next === "REQUERY" ? orderRead.refresh : undefined} />}
    </>
  );
}
