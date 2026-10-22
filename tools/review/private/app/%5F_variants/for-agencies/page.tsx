// The "For agencies" page (Order 11; review only), with the statements and limits of the owner's answer 8.
import type { Metadata } from "next";
import { ForAgenciesPage } from "../../../variants/for-agencies.tsx";

export const metadata: Metadata = { title: "For agencies, variant | Kauro review", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <>
      <div className="kauro-variant-ribbon" role="note">
        <p>
          <strong>Proposed page</strong> · For agencies, with only what you allowed it to say. It is not on the approved site · <a href="/">the approved home page</a> ·{" "}
          <a href="/__review/private">all screens</a>
        </p>
      </div>
      <ForAgenciesPage />
    </>
  );
}
