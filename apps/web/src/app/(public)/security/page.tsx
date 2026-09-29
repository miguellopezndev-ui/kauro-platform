import type { Metadata } from "next";
import { SecurityPage } from "../../../public/pages/security.tsx";
import { pageMetadata } from "../../../public/site.ts";

export const metadata: Metadata = pageMetadata("security");

export default function Page() {
  return <SecurityPage />;
}
