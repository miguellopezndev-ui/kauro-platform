import type { ReactNode } from "react";
import { AppShell } from "../../shell/app-shell.tsx";

// The OPS group (design D-SCR-1): the private origin's screens live under /ops and are served only on the ops host (KAURO_OPS_ORIGIN). They
// render inside the application shell, which holds private content back until the session is confirmed; the api decides every access
// (KAURO_OWNER), this frame is presentation only. Screens are added under this directory by the mandates that own them.
export default function OpsLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
