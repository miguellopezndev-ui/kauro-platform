import type { Metadata } from "next";
import { HowItWorksPage } from "../../../public/pages/how-it-works.tsx";
import { pageMetadata } from "../../../public/site.ts";

export const metadata: Metadata = pageMetadata("how");

export default function Page() {
  return <HowItWorksPage />;
}
