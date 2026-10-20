import { notFound } from "next/navigation";
import { message } from "../../../../../../../copy/en.ts";
import { HealthCheckScreen } from "../../../../../../../screens/health-check/container.tsx";
import { idOrNull } from "../../../../../../../screens/shared/params.ts";
import { ProjectStages } from "../../../../../../../screens/shared/project-stages.tsx";

// UI18 Free data health check (design D-ROUTE-1; A3 3.2): the project and agency come from the path, the check from `?audit=`.
export default async function Page({ params, searchParams }: { readonly params: Promise<{ agencyId: string; id: string }>; readonly searchParams: Promise<{ audit?: string | string[] }> }) {
  const { agencyId, id } = await params;
  const { audit } = await searchParams;
  if (idOrNull(agencyId) === null || idOrNull(id) === null || (audit !== undefined && idOrNull(audit) === null)) notFound();
  return (
    <>
      <ProjectStages agencyId={agencyId} projectId={id} current="check" />
      <h1>{message("health-check.title")}</h1>
      <HealthCheckScreen auditId={idOrNull(audit)} />
    </>
  );
}
