// The three-card variant of Supported services (Order 11; review only), reading the same capability publication as the approved page, so
// the reading switched at /__review/publication/{reading} changes both alike.
import type { Metadata } from "next";
import { publicationUrl } from "@web/server/public-origins.ts";
import { readPublication } from "@web/server/publication-reader.ts";
import { SupportedServicesCards } from "../../../variants/supported-services-cards.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Supported services, variant: three cards | Kauro review", robots: { index: false, follow: false } };

const PUBLICATION = publicationUrl({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: undefined, KAURO_LOCAL_PUBLICATION_ORIGIN: process.env["KAURO_LOCAL_PUBLICATION_ORIGIN"] ?? "http://127.0.0.1:4402" });

export default async function Page() {
  return (
    <>
      <div className="kauro-variant-ribbon" role="note">
        <p>
          <strong>Proposed variant</strong> · three cards and the new service names. The approved page stays as it is: <a href="/supported-services">see the approved page</a> ·{" "}
          <a href="/__review/private">all screens</a>
        </p>
      </div>
      <SupportedServicesCards publication={await readPublication(PUBLICATION)} />
    </>
  );
}
