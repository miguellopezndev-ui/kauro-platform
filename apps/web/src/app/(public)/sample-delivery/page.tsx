import type { Metadata } from "next";
import { SampleDeliveryPage } from "../../../public/pages/sample-delivery.tsx";
import { pageMetadata } from "../../../public/site.ts";

export const metadata: Metadata = pageMetadata("sample");

export default function Page() {
  return <SampleDeliveryPage />;
}
