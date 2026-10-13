import { notFound } from "next/navigation";
import { message } from "../../../../../copy/en.ts";
import { SettingsScreen } from "../../../../../screens/settings/container.tsx";
import { idOrNull } from "../../../../../screens/shared/params.ts";

// UI32 Settings (design D-ROUTE-1): the agency comes from the path.
export default async function Page({ params }: { readonly params: Promise<{ agencyId: string }> }) {
  const { agencyId } = await params;
  const agency = idOrNull(agencyId);
  if (agency === null) notFound();
  return (
    <>
      <h1>{message("screen.settings.title")}</h1>
      <SettingsScreen agencyId={agency} />
    </>
  );
}
