import type { Metadata } from "next";
import { HelpPage } from "../../../public/pages/help.tsx";
import { pageMetadata } from "../../../public/site.ts";

export const metadata: Metadata = pageMetadata("help");

export default function Page() {
  return <HelpPage />;
}
