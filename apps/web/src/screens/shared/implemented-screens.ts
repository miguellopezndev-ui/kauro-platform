"use client";
// The screens this build has, as a context: a page links to the next screen only when it exists (the health check to the plan, the
// preparation to the delivery). A review of every screen provides a wider set.
import { createContext } from "react";
import { IMPLEMENTED_SCREENS } from "../../screens.ts";

export const ImplementedScreens = createContext<ReadonlySet<string>>(IMPLEMENTED_SCREENS);
