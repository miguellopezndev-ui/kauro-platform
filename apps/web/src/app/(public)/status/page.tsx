import type { Metadata } from "next";
import { StatusPage } from "../../../public/pages/status.tsx";
import { pageMetadata } from "../../../public/site.ts";
import { loadPublication } from "../../../server/public-data.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata("status");

export default async function Page() {
  return <StatusPage publication={await loadPublication()} />;
}
