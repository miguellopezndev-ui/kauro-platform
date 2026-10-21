import { notFound } from "next/navigation";
import { message } from "../../../../../copy/en.ts";
import { SettingsScreen } from "../../../../../screens/settings/container.tsx";
import { PageHeader } from "../../../../../screens/shared/project-header.tsx";
import { idOrNull } from "../../../../../screens/shared/params.ts";

// UI32 Settings (design D-ROUTE-1): the agency comes from the path.
export default async function Page({ params }: { readonly params: Promise<{ agencyId: string }> }) {
  const { agencyId } = await params;
  const agency = idOrNull(agencyId);
  if (agency === null) notFound();
  return (
    <>
      <PageHeader title={message("screen.settings.title")} lead={message("screen.settings.lead.body")} />
      <SettingsScreen agencyId={agency} />
    </>
  );
}
