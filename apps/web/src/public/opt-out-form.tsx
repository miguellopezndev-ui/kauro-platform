"use client";

// UI49 (form): one form, method POST to the api's opt-out route with the RFC 8058 body in a hidden input, so it also works before the script
// loads. With the script, the submit posts the same body and shows the confirmation only when the api answers 200. Rendering issues no request.
import { useState, type FormEvent, type ReactElement } from "react";
import { PUBLIC_COPY } from "../copy/public.ts";
import { OPT_OUT_BODY, optOutPath, submitOptOut, type OptOutOutcome } from "./opt-out.ts";

export function OptOutForm({ token }: { readonly token: string }): ReactElement {
  const [state, setState] = useState<"IDLE" | "SENDING" | OptOutOutcome>("IDLE");
  const [name, value] = OPT_OUT_BODY.split("=") as [string, string];
  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState("SENDING");
    setState(await submitOptOut(token));
  }
  if (state === "DONE") {
    return (
      <div role="status" id="unsubscribe-done">
        <h2>{PUBLIC_COPY["unsubscribe.done.heading"]}</h2>
        <p>{PUBLIC_COPY["unsubscribe.done.body"]}</p>
      </div>
    );
  }
  return (
    <form method="post" action={optOutPath(token)} encType="application/x-www-form-urlencoded" onSubmit={(event) => void onSubmit(event)}>
      <input type="hidden" name={name} value={value} />
      <button className="kauro-site-button kauro-site-button--primary" type="submit" disabled={state === "SENDING"}>
        {PUBLIC_COPY["unsubscribe.submit.cta"]}
      </button>
      {state === "FAILED" || state === "LIMITED" ? <p role="alert" className="kauro-site-error">{PUBLIC_COPY[state === "LIMITED" ? "unsubscribe.limited.body" : "unsubscribe.failed.body"]}</p> : null}
    </form>
  );
}
