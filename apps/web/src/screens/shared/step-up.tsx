"use client";
// The step-up of a sensitive command (design D-AUTH-4, D-STATE-1; cases UI14 EXPIRY, UI12 DENY): the person proves who they are again, the
// identity provider's token is sent once to the api (`createStepUp`), the api answers a one-use proof, and exactly one command spends it.
//   - The token is taken from its credential once and is never kept; a lost answer does not send it again (it may have been used): the
//     state is STEP_UP and the person confirms again for a fresh proof.
//   - A proof is handed to the command through `take()`, which works once; the proof is never a member of any state.
//   - A proof the api refuses, or that expired before the command ran, is not a failure: it is the STEP_UP state, drawn beside the form,
//     which is not touched, so nothing the person typed is lost. The web never compares a clock: the server's refusal is the only judge.
import type { ReactElement, ReactNode } from "react";
import type { ApiClient } from "../../client/api-client.ts";
import type { IdentityCredential } from "../../client/identity/port.ts";
import { type StateDecision, stateOfAnswer } from "../../client/states.ts";
import { message } from "../../copy/en.ts";
import { StatePanel } from "./state-panel.tsx";

export interface StepUpProof {
  /** The proof's id, once. A second call is a bug and throws. */
  take(): string;
}

export type StepUpCause = "NO_CREDENTIAL" | "PROOF_REFUSED" | "PROOF_LOST" | "PROOF_STALE";

export type StepUpResult<Out> =
  | { readonly kind: "DONE"; readonly outcome: Out }
  | { readonly kind: "STEP_UP"; readonly cause: StepUpCause }
  | { readonly kind: "FAILED"; readonly decision: StateDecision };

export interface StepUpRun<Out> {
  readonly client: ApiClient;
  /** The completed re-authentication (a STEP_UP credential), or null when the person closed the dialog. */
  readonly obtain: () => Promise<IdentityCredential | null>;
  /** The one command that spends the proof. */
  readonly command: (proof: StepUpProof) => Promise<Out>;
  /** True when the command's outcome says the proof was not enough (default: a RunOutcome PROBLEM with code ASSURANCE_REQUIRED). */
  readonly isStale?: (outcome: Out) => boolean;
}

function refusedForAssurance(outcome: unknown): boolean {
  const candidate = outcome as { kind?: unknown; problem?: { code?: unknown } } | null;
  return candidate?.kind === "PROBLEM" && candidate.problem?.code === "ASSURANCE_REQUIRED";
}

export async function runWithStepUp<Out>(run: StepUpRun<Out>): Promise<StepUpResult<Out>> {
  const credential = await run.obtain();
  if (credential === null || credential.purpose !== "STEP_UP" || credential.spent) return { kind: "STEP_UP", cause: "NO_CREDENTIAL" };
  let idToken: string;
  try {
    idToken = credential.takeToken();
  } catch {
    return { kind: "STEP_UP", cause: "NO_CREDENTIAL" };
  }
  let answer;
  try {
    answer = await run.client.call("createStepUp", { body: { idToken } });
  } catch {
    // the request was refused before leaving the page (a malformed token): the token never travelled and is gone, so a fresh one is needed
    return { kind: "STEP_UP", cause: "PROOF_REFUSED" };
  }
  if (answer.kind === "NO_ANSWER") return { kind: "STEP_UP", cause: "PROOF_LOST" };
  if (answer.kind === "PROBLEM" && answer.problem.code === "ASSURANCE_REQUIRED") return { kind: "STEP_UP", cause: "PROOF_REFUSED" };
  if (answer.kind !== "REPLY") return { kind: "FAILED", decision: stateOfAnswer(answer) };
  let proofId: string | null = answer.body.proofId;
  const proof: StepUpProof = {
    take() {
      if (proofId === null) throw new Error("this proof was already taken");
      const taken = proofId;
      proofId = null;
      return taken;
    },
  };
  let outcome: Out;
  try {
    outcome = await run.command(proof);
  } finally {
    proofId = null;
  }
  return (run.isStale ?? refusedForAssurance)(outcome) ? { kind: "STEP_UP", cause: "PROOF_STALE" } : { kind: "DONE", outcome };
}

export interface StepUpPanelProps {
  readonly result: StepUpResult<unknown> | null;
  /** Opens the confirmation again; wired by the screen. */
  readonly onStepUp: () => void;
  /** The screen's form, drawn untouched whatever the state. */
  readonly children?: ReactNode;
}

export function StepUpPanel({ result, onStepUp, children }: StepUpPanelProps): ReactElement {
  return (
    <>
      {children}
      {result?.kind === "STEP_UP" ? (
        <section className="kauro-state" data-state="STEP_UP" role="alert">
          <h2 tabIndex={-1}>{message("screen.step-up.title")}</h2>
          <p>{message("screen.step-up.body")}</p>
          <button type="button" className="kauro-button" onClick={onStepUp}>
            {message("screen.step-up.cta")}
          </button>
        </section>
      ) : null}
      {result?.kind === "FAILED" ? <StatePanel decision={result.decision} /> : null}
    </>
  );
}
