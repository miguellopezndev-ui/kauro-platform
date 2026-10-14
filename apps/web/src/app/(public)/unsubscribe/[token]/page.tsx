import type { Metadata } from "next";
import { UnsubscribePage } from "../../../../public/pages/unsubscribe.tsx";
import { pageMetadata } from "../../../../public/site.ts";

export const metadata: Metadata = pageMetadata("unsubscribe");

// The token of the address goes only into the form's action (posted to the api); it is never logged or written into the page text.
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <UnsubscribePage token={token} />;
}
