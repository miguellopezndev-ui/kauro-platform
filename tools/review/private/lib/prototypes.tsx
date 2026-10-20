"use client";
// The prototypes of the private screens not built yet (Order 11 §2: VISUAL PROTOTYPE — NOT FUNCTIONAL). Each is a view of synthetic data
// shaped like the api's own views, drawn with the web's components and stylesheets, so the design can move into the application later
// without being redrawn. None of them calls anything: their states are chosen by the review.
import type { ComponentType } from "react";
import type { ContextKey } from "./contexts.ts";
import type { StateDef } from "./scenario.ts";
import type { PrototypeProps } from "./screens.tsx";

export interface PrototypeEntry {
  readonly Component: ComponentType<PrototypeProps>;
  readonly states: readonly StateDef[];
  readonly contexts?: readonly ContextKey[];
}

export const PROTOTYPES: Readonly<Record<string, PrototypeEntry>> = {};
