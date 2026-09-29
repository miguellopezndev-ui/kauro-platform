import type { Metadata } from "next";
import { PricingPage } from "../../../public/pages/pricing.tsx";
import { pageMetadata } from "../../../public/site.ts";
import { signInAddress } from "../../../server/config/site-origins.ts";
import { loadPublication } from "../../../server/public-data.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata("pricing");

export default async function Page() {
  return <PricingPage publication={await loadPublication()} signInHref={signInAddress()} />;
}
