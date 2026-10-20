import type { Metadata } from "next";
import { HomePage } from "../../public/pages/home.tsx";
import { pageMetadata } from "../../public/site.ts";
import { loadPublication } from "../../server/public-data.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = pageMetadata("home");

export default async function Page() {
  return <HomePage publication={await loadPublication()} />;
}
