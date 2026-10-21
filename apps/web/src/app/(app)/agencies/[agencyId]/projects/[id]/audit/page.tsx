import { notFound } from "next/navigation";
import { message } from "../../../../../../../copy/en.ts";
import { HealthCheckScreen } from "../../../../../../../screens/health-check/container.tsx";
import { idOrNull } from "../../../../../../../screens/shared/params.ts";
import { ProjectHeader } from "../../../../../../../screens/shared/project-header.tsx";

// UI18 Free data health check (design D-ROUTE-1; A3 3.2): the project and agency come from the path, the check from `?audit=`.
export default async function Page({ params, searchParams }: { readonly params: Promise<{ agencyId: string; id: string }>; readonly searchParams: Promise<{ audit?: string | string[] }> }) {
  const { agencyId, id } = await params;
  const { audit } = await searchParams;
  if (idOrNull(agencyId) === null || idOrNull(id) === null || (audit !== undefined && idOrNull(audit) === null)) notFound();
  return (
    <>
      <ProjectHeader stage="check" title={message("health-check.title")} lead={message("screen.health.lead.body")} />
      <HealthCheckScreen auditId={idOrNull(audit)} agencyId={agencyId} projectId={id} />
    </>
  );
}
