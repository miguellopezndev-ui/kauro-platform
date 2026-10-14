"use client";
// The container of UI32 (design D-PRIV-1, D-AUTH-4): reads the agency named in the address and runs the closure (CMD043) behind a fresh
// step-up. Until the identity provider's re-authentication dialog is wired into the shell (W-IDP-LIVE) no credential can be obtained, so the
// closure ends in the STEP_UP state and sends nothing; a test supplies `obtain`.
import { useRef, useState } from "react";
import type { ReactElement } from "react";
import type { IdentityCredential } from "../../client/identity/port.ts";
import { stateOfRun } from "../../client/states.ts";
import { useShell } from "../../shell/shell-context.ts";
import { pageRunner } from "../shared/run-command.ts";
import { StatePanel } from "../shared/state-panel.tsx";
import { type StepUpResult, StepUpPanel } from "../shared/step-up.tsx";
import { useRead } from "../shared/use-read.ts";
import type { AgencyClosureView } from "../../api/generated.ts";
import type { RunOutcome } from "../../client/operation-runner.ts";
import { closeWithStepUp } from "./model.ts";
import { SettingsDetails } from "./view.tsx";

const noCredential = async (): Promise<IdentityCredential | null> => null;

export function SettingsScreen({ agencyId, obtain = noCredential }: { readonly agencyId: string; readonly obtain?: () => Promise<IdentityCredential | null> }): ReactElement {
  const { client } = useShell();
  const { state, refresh } = useRead((signal) => client.call("GetAgency", { path: { agencyId }, signal }), agencyId);
  const [result, setResult] = useState<StepUpResult<RunOutcome<AgencyClosureView>> | null>(null);
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const agency = state.kind === "ANSWERED" && state.answer.kind === "REPLY" ? state.answer.body.data : null;
  if (state.kind === "LOADING") return <StatePanel decision={state.decision} />;
  if (agency === null) return <StatePanel decision={state.decision} onNext={refresh} />;
  const onClose = (): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    void closeWithStepUp(client, pageRunner(), agency, obtain).then(
      (next) => {
        inFlight.current = false;
        setRunning(false);
        setResult(next);
      },
      () => {
        inFlight.current = false;
        setRunning(false);
      },
    );
  };
  const done = result?.kind === "DONE" ? result.outcome : null;
  const closure = done !== null && (done.kind === "COMPLETED" || done.kind === "RECOVERED") ? done.data : null;
  const decision = done !== null && closure === null ? stateOfRun(done) : null;
  return (
    <>
      <StepUpPanel result={result} onStepUp={onClose}>
        <SettingsDetails agency={closure?.agency ?? agency} onClose={onClose} closing={running} closure={closure} />
      </StepUpPanel>
      {decision === null ? null : <StatePanel decision={decision} onNext={decision.next === "RELOAD" || decision.next === "REQUERY" || decision.next === "COMPARE_VERSIONS" ? refresh : undefined} />}
    </>
  );
}
