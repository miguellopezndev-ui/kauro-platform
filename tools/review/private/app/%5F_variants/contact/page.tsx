// The contact variant (Order 11; review only): the §8.1 authorisation on the contact form, and "Email address".
import type { Metadata } from "next";
import { ContactVariant } from "../../../variants/contact.tsx";

export const metadata: Metadata = { title: "Contact, variant | Kauro review", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <>
      <div className="kauro-variant-ribbon" role="note">
        <p>
          <strong>Proposed variant</strong> · the contact form with the required authorisation (Data Processing Policy §8.1) and &quot;Email address&quot;. Nothing is sent here ·{" "}
          <a href="/contact">see the approved page</a> · <a href="/__review/private">all screens</a>
        </p>
      </div>
      <ContactVariant />
    </>
  );
}
