import type { ReactNode } from "react";
import { AppShell } from "../../shell/app-shell.tsx";

// The APP group (design D-ROUTE-1, D-TOPO-2): every screen of the app host renders inside the application shell, which holds private
// content back until the session is confirmed. Screens are added under this directory by the mandates that own them.
export default function AppLayout({ children }: { readonly children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
