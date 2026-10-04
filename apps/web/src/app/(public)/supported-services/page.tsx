import type { Metadata } from "next";
import { SupportedServicesPage } from "../../../public/pages/supported-services.tsx";
import { pageMetadata } from "../../../public/site.ts";
import { loadPublication } from "../../../server/public-data.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata("services");

export default async function Page() {
  return <SupportedServicesPage publication={await loadPublication()} />;
}
