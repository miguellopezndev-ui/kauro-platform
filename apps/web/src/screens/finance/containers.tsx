"use client";
// The container of UI39 Company finance, owner sections O1 and O2 (docs/design/B12-owner-screens.md D-B12S-5): it reads through the page's
// api client, holds the queue's state filter and pages and the run of one command, and hands everything to the pure views. The step-up
// credential comes from `obtainStepUp`, the shell's re-authentication (none is wired yet: every step-up command answers the STEP_UP state,
// which keeps the form; see the lane report's gap). Nothing private is stored; the page's heap is the only place.
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { IdentityCredential } from "../../client/identity/port.ts";
import { message } from "../../copy/en.ts";
import { useShell } from "../../shell/shell-context.ts";
import { pageRunner } from "../shared/run-command.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { StepUpPanel, type StepUpResult } from "../shared/step-up.tsx";
import { useRead } from "../shared/use-read.ts";
import { type BankCreditState, type BankCreditView, type CreditCommand, type QueueRead, type RouteCommand, confirmCredit, disableRoute, listCredits, queueRead } from "./model.ts";
import { CreditQueue, RouteSection } from "./view.tsx";

/** The shell's step-up (D-AUTH-4). Not wired in this build: no credential, so the command is not sent and the STEP_UP state is drawn. */
const obtainStepUp = async (): Promise<IdentityCredential | null> => null;

function RoutePanel({ routeId, onDenied }: { readonly routeId: string; readonly onDenied: (denied: boolean) => void }): ReactElement {
  const { client } = useShell();
  const { state, refresh } = useRead((signal) => client.call("getBankRoute", { path: { routeId }, signal }), routeId);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StepUpResult<unknown> | null>(null);
  const route = state.kind === "ANSWERED" && state.answer.kind === "REPLY" ? state.answer.body.route : null;
  // a refusal of access covers the whole page: the queue is not drawn beside it to say the same thing again
  const denied = state.kind !== "LOADING" && route === null && state.decision.state === "DENIED";
  useEffect(() => {
    onDenied(denied);
  }, [denied, onDenied]);
  if (state.kind === "LOADING") return <StatePanel decision={state.decision} />;
  if (route === null) return <StatePanel decision={state.decision} onNext={refresh} />;
  const onCommand = (command: RouteCommand): void => {
    if (busy) return;
    // VERIFY (the owner's review record), ENABLE (rollout, participants) and REPLACE_DETAILS (the file) take inputs from forms this build
    // does not draw yet; their model functions (verifyRoute, enableRoute, replaceRouteDetails) are what those forms call
    if (command !== "DISABLE") return;
    const run = disableRoute(client, pageRunner(), route, obtainStepUp);
    setBusy(true);
    void run.then(
      (done) => {
        setBusy(false);
        setResult(done);
        if (done.kind === "DONE") refresh();
      },
      () => setBusy(false),
    );
  };
  return (
    <StepUpPanel result={result} onStepUp={() => setResult(null)}>
      <RouteSection route={route} busy={busy} onCommand={onCommand} />
    </StepUpPanel>
  );
}

function QueuePanel(): ReactElement {
  const { client } = useShell();
  const [filter, setFilter] = useState<BankCreditState>("MATCH_REVIEW");
  const [pages, setPages] = useState<readonly BankCreditView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [result, setResult] = useState<StepUpResult<unknown> | null>(null);
  const { state, refresh } = useRead((signal) => listCredits(client, filter, cursor, signal), `${filter}:${cursor ?? ""}`);
  const page: QueueRead | null = state.kind === "ANSWERED" ? queueRead(state.answer) : null;
  // a new state starts over from its first page; a further page is appended to what is shown
  useEffect(() => {
    setPages([]);
    setCursor(null);
  }, [filter]);
  const read: QueueRead | null = page === null ? null : page.kind === "READY" ? { ...page, credits: [...pages, ...page.credits] } : page;
  const onOpen = (credit: BankCreditView, command: CreditCommand | null): void => {
    if (command !== "CONFIRM") return;
    void confirmCredit(client, pageRunner(), credit, obtainStepUp).then((done) => {
      setResult(done);
      if (done.kind === "DONE") refresh();
    });
  };
  return (
    <StepUpPanel result={result} onStepUp={() => setResult(null)}>
      {read === null ? (
        <StatePanel decision={state.decision} onNext={refresh} />
      ) : (
        <CreditQueue
          state={filter}
          read={read}
          onState={setFilter}
          onMore={(next) => {
            if (page?.kind === "READY") setPages([...pages, ...page.credits]);
            setCursor(next);
          }}
          onOpen={onOpen}
        />
      )}
    </StepUpPanel>
  );
}

export function FinanceScreen({ routeId }: { readonly routeId: string | null }): ReactElement {
  const [denied, setDenied] = useState(false);
  const onDenied = useCallback((value: boolean) => setDenied(value), []);
  useEffect(() => setDenied(false), [routeId]);
  return (
    <>
      {routeId === null ? (
        <section>
          <h2>{message("screen.finance.route.title")}</h2>
          <p>{message("screen.finance.route.none.body")}</p>
        </section>
      ) : (
        <RoutePanel routeId={routeId} onDenied={onDenied} />
      )}
      {denied ? null : <QueuePanel />}
    </>
  );
}
