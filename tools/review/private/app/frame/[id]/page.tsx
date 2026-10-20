// One screen, drawn alone (Order 11): the page the viewer puts in its frame at the chosen width. A real screen is its own page module.
import { notFound } from "next/navigation";
import { AGENCY_ID, COMPANY_ID, CONTEXTS, type ContextKey } from "@review/lib/contexts.ts";
import { FrameHost } from "@review/lib/frame-host.tsx";
import { screenOf } from "@review/lib/inventory.ts";
import { realPage } from "@review/lib/real-pages.tsx";

export default async function Frame({ params, searchParams }: { readonly params: Promise<{ id: string }>; readonly searchParams: Promise<{ ctx?: string; state?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const screen = screenOf(id);
  if (screen === undefined) notFound();
  const fallback: ContextKey = screen.origin === "OPS" ? "owner" : "agency";
  const context: ContextKey = query.ctx !== undefined && Object.hasOwn(CONTEXTS, query.ctx) ? (query.ctx as ContextKey) : fallback;
  const agencyId = context === "company" ? COMPANY_ID : AGENCY_ID;
  const real = screen.technical === "IMPLEMENTED" ? await realPage(id, agencyId) : null;
  return (
    <FrameHost id={id} context={context} state={query.state ?? "normal"}>
      {real}
    </FrameHost>
  );
}
