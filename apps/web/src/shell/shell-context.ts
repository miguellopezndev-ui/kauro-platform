// What a private screen reads of the shell (design D-PRIV-1): the page's api client and session runtime. The application frame provides it
// only while it draws the screen's content, which is only while the session is confirmed, so a screen never sees an absent shell.
import { createContext, useContext } from "react";
import type { Shell } from "./shell-runtime.ts";

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (shell === null) throw new Error("SHELL_MISSING");
  return shell;
}
