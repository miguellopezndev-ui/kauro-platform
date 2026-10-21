"use client";
// UI28 Import results (registry: "Match the actual target result to this stage."). Round 2 (research agency-workspace.md §5.16): a stage's
// result belongs to its stage, so this address draws the one import page (ui27-import.tsx) opened at the stage whose result is due. The
// registry keeps both routes; a link to either lands on the same list, so nobody walks between two pages for one stage.
import type { ReactElement } from "react";
import type { PrototypeProps } from "../lib/screens.tsx";
import { ImportSteps, UI28_STATES } from "./ui27-import.tsx";

export { UI28_STATES };

/** UI28's own "normal" is the stage waiting for its result; its other states are the import page's. */
export function ImportResults(props: PrototypeProps): ReactElement {
  return <ImportSteps {...props} state={props.state === "normal" ? "waiting" : props.state} />;
}
