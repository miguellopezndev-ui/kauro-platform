// The "Check a file free" page (Order 11; review only): where the main call to action would lead, before sign-up (owner's answer 7, F-03).
import type { Metadata } from "next";
import { FreeCheckPage } from "../../../variants/free-check.tsx";

export const metadata: Metadata = { title: "Check a file free, variant | Kauro review", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <>
      <div className="kauro-variant-ribbon" role="note">
        <p>
          <strong>Proposed page</strong> · where &quot;Check a file free&quot; would lead. Today the call to action opens the contact form (A3 §3.2); this changes it, so it waits for your
          decision (F-03) · <a href="/">the approved home page</a> · <a href="/__review/private">all screens</a>
        </p>
      </div>
      <FreeCheckPage />
    </>
  );
}
