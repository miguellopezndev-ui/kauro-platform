import type { Metadata } from "next";
import { UnsubscribePage } from "../../../../public/pages/unsubscribe.tsx";
import { pageMetadata } from "../../../../public/site.ts";

export const metadata: Metadata = pageMetadata("unsubscribe");

// The address carries a one-time token that this page deliberately never reads: until the unsubscribe path exists (B12) the page changes
// nothing and records nothing, so it has no use for the token (and a token in an address is never logged or echoed from here).
export default function Page() {
  return <UnsubscribePage />;
}
