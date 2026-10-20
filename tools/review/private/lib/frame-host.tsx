"use client";
// What the frame of one screen draws (Order 11): the synthetic-data notice, then the screen inside the real application shell. A real
// screen arrives as `children` (its own page, rendered by the server); a prototype is drawn here from the same state key.
import { type ReactElement, type ReactNode, useMemo } from "react";
import { CONTEXTS, type ContextKey } from "./contexts.ts";
import { ReviewShell } from "./review-shell.tsx";
import { scriptOf } from "./scenario.ts";
import { appPathOf, screenDef } from "./screens.tsx";

export function FrameHost({ id, context, state, children }: { readonly id: string; readonly context: ContextKey; readonly state: string; readonly children: ReactNode }): ReactElement {
  const def = screenDef(id);
  const stateDef = def.states.find((candidate) => candidate.key === state) ?? def.states[0];
  const ctx = CONTEXTS[context];
  const script = useMemo(() => {
    const fixed = stateDef === undefined ? {} : scriptOf(stateDef, context);
    return () => fixed;
  }, [stateDef, context]);
  const Prototype = def.Prototype;
  return (
    <>
      <p className="kauro-review-notice" role="note">
        Review — synthetic data, nothing is sent or saved. <span>{ctx.who}</span>
      </p>
      <ReviewShell appPath={appPathOf(id, ctx)} context={context} script={script}>
        {children ?? (Prototype === undefined ? null : <Prototype ctx={ctx} state={stateDef?.key ?? "normal"} />)}
      </ReviewShell>
    </>
  );
}
