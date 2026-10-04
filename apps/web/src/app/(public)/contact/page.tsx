import type { Metadata } from "next";
import { ContactPage } from "../../../public/pages/contact.tsx";
import { pageMetadata } from "../../../public/site.ts";

export const metadata: Metadata = pageMetadata("contact");

export default function Page() {
  return <ContactPage />;
}
