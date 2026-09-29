import type { ReactNode } from "react";
import { PublicFrame } from "../../shell/landmarks.tsx";

// The PUBLIC group (design D-ROUTE-1, D-TOPO-2): the screens of the public host, none of which reads a session. The frame is the skip
// link and the landmark; the public site's own header and footer belong to the screens that draw them.
export default function PublicLayout({ children }: { readonly children: ReactNode }) {
  return <PublicFrame>{children}</PublicFrame>;
}
