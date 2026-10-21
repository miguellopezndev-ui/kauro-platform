// The Pricing variant (Order 11; review only): the approved page with what the price includes and a few questions about it.
import type { Metadata } from "next";
import { publicationUrl } from "@web/server/public-origins.ts";
import { readPublication } from "@web/server/publication-reader.ts";
import { PricingVariant } from "../../../variants/pricing.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pricing, variant | Kauro review", robots: { index: false, follow: false } };

const PUBLICATION = publicationUrl({ KAURO_ENV: "LOCAL", KAURO_PUBLIC_ORIGIN: undefined, KAURO_LOCAL_PUBLICATION_ORIGIN: process.env["KAURO_LOCAL_PUBLICATION_ORIGIN"] ?? "http://127.0.0.1:4402" });

export default async function Page() {
  return (
    <>
      <div className="kauro-variant-ribbon" role="note">
        <p>
          <strong>Proposed variant</strong> · the approved Pricing page with what the price includes and questions about it. The approved page stays as it is:{" "}
          <a href="/pricing">see the approved page</a> · <a href="/__review/private">all screens</a>
        </p>
      </div>
      <PricingVariant publication={await readPublication(PUBLICATION)} signInHref="/login" />
    </>
  );
}
