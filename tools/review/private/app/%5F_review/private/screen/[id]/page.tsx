// The viewer of one private screen (Order 11 §6).
import { notFound } from "next/navigation";
import { CONTEXTS, type ContextKey } from "@review/lib/contexts.ts";
import { screenOf } from "@review/lib/inventory.ts";
import { reviewOf } from "@review/lib/review-status.ts";
import { Viewer } from "@review/lib/viewer.tsx";

export default async function Screen({ params, searchParams }: { readonly params: Promise<{ id: string }>; readonly searchParams: Promise<{ ctx?: string; state?: string; w?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const screen = screenOf(id);
  if (screen === undefined) notFound();
  const fallback: ContextKey = screen.origin === "OPS" ? "owner" : "agency";
  const context: ContextKey = query.ctx !== undefined && Object.hasOwn(CONTEXTS, query.ctx) ? (query.ctx as ContextKey) : fallback;
  return <Viewer screen={screen} review={reviewOf(id)} context={context} state={query.state ?? "normal"} width={query.w ?? "full"} />;
}
