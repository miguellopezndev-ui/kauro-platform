"use client";
// The containers of UI23 and UI24 (design D-PRIV-1, D-OPS-1): they read through the page's api client, hold the person's choices (the terms
// checkbox) and the run of CMD028, and hand everything to the pure views. Nothing private is stored; the page's heap is the only place.
import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { message } from "../../copy/en.ts";
import { pathOf } from "../../screens.ts";
import { useShell } from "../../shell/shell-context.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { pageRunner, useCommand } from "../shared/run-command.ts";
import { useRead } from "../shared/use-read.ts";
import { createPaymentOrder, instructionsRead } from "./model.ts";
import { PaymentDetails, type InstructionsRead, PaymentUnread } from "./payment-view.tsx";
import { QuoteDetails } from "./quote-view.tsx";

export function QuoteScreen({ agencyId, projectId, quoteId }: { readonly agencyId: string; readonly projectId: string; readonly quoteId: string | null }): ReactElement {
  const { client } = useShell();
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // the price can expire while the page is open: the clock only ever disables the control
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const { state, refresh } = useRead((signal) => (quoteId === null ? Promise.resolve({ kind: "NO_ANSWER", reason: "ABORTED", status: null } as const) : client.call("GetQuote", { path: { quoteId }, signal })), quoteId ?? "none");
  const quote = state.kind === "ANSWERED" && state.answer.kind === "REPLY" ? state.answer.body.data : null;
  const command = useCommand(() => {
    if (quote === null) throw new Error("NO_QUOTE");
    return createPaymentOrder(client, pageRunner(), quote);
  });
  // a changed quote (a newer version, a replaced quote) is a different thing to accept: the acceptance does not carry over
  const identity = quote === null ? "" : `${quote.quoteId}:${quote.version}:${quote.termsHash}`;
  useEffect(() => setTermsAccepted(false), [identity]);

  if (quoteId === null) {
    return (
      <section>
        <h2>{message("screen.quote.none.title")}</h2>
        <p>{message("screen.quote.none.body")}</p>
      </section>
    );
  }
  if (state.kind === "LOADING") return <StatePanel decision={state.decision} />;
  if (quote === null) return <StatePanel decision={state.decision} onNext={refresh} />;
  const done = command.state.kind === "DONE" ? command.state : null;
  const created = done !== null && (done.outcome.kind === "COMPLETED" || done.outcome.kind === "RECOVERED") ? done.outcome.data : null;
  return (
    <>
      <QuoteDetails
        quote={quote}
        nowMs={now}
        termsAccepted={termsAccepted}
        onTermsChange={setTermsAccepted}
        onCreate={command.run}
        creating={command.state.kind === "RUNNING" || created !== null}
        termsHref="/legal/terms"
        reuploadHref={pathOf("UI14", { agencyId, id: projectId })}
        planHref={pathOf("UI22", { agencyId, id: projectId })}
      />
      {created === null ? null : (
        <section role="status">
          <p>{message("screen.payment.created.body")}</p>
          <p>
            <a href={pathOf("UI24", { agencyId, orderId: created.order.orderId })}>{message("screen.payment.title")}</a>
          </p>
        </section>
      )}
      {done === null || created !== null ? null : <StatePanel decision={done.decision} onNext={done.decision.next === "RELOAD" || done.decision.next === "REQUERY" ? refresh : undefined} />}
    </>
  );
}

export function PaymentScreen({ agencyId, orderId }: { readonly agencyId: string; readonly orderId: string }): ReactElement {
  const { client } = useShell();
  const { state, refresh } = useRead((signal) => client.call("GetPaymentOrder", { path: { orderId }, signal }), orderId);
  const order = state.kind === "ANSWERED" && state.answer.kind === "REPLY" ? state.answer.body.data.order : null;
  const showsInstructions = order?.paymentStatus === "NOT_STARTED";
  const details = useRead((signal) => (showsInstructions ? client.call("getTransferInstructions", { path: { orderId }, signal }) : Promise.resolve({ kind: "NO_ANSWER", reason: "ABORTED", status: null } as const)), `${orderId}:${showsInstructions ? "details" : "none"}:${state.kind === "ANSWERED" ? "r" : "l"}`);
  const instructions: InstructionsRead = !showsInstructions ? { kind: "NOT_SHOWN" } : details.state.kind === "LOADING" ? { kind: "LOADING" } : details.state.kind === "ERROR" ? { kind: "UNAVAILABLE", decision: details.state.decision } : instructionsRead(details.state.answer);
  if (state.kind === "LOADING") return <StatePanel decision={state.decision} />;
  if (order === null) return <PaymentUnread decision={state.decision} onRefresh={refresh} />;
  return (
    <PaymentDetails
      order={order}
      instructions={instructions}
      onRefresh={refresh}
      refreshing={false}
      hrefs={{ CONTACT_SUPPORT: pathOf("UI52", { agencyId }), REQUEST_NEW_QUOTE: pathOf("UI23", { agencyId, id: order.projectId }), REQUEST_NEW_REVIEW: pathOf("UI18", { agencyId, id: order.projectId }) }}
      projectHref={pathOf("UI13", { agencyId, id: order.projectId })}
      preparationHref={pathOf("UI25", { agencyId, id: order.projectId })}
    />
  );
}
