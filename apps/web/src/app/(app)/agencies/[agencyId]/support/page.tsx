import { notFound } from "next/navigation";
import { message } from "../../../../../copy/en.ts";
import { idOrNull } from "../../../../../screens/shared/params.ts";
import { SupportScreen } from "../../../../../screens/support/container.tsx";

// UI52 Support cases (design D-ROUTE-1; Q-B11-1): cases are project-scoped, so the project is named in `?project=`; a case link names `?case=`.
export default async function Page({ params, searchParams }: { readonly params: Promise<{ agencyId: string }>; readonly searchParams: Promise<{ project?: string | string[]; case?: string | string[] }> }) {
  const { agencyId } = await params;
  const { project, case: caseParam } = await searchParams;
  const agency = idOrNull(agencyId);
  if (agency === null || (project !== undefined && idOrNull(project) === null) || (caseParam !== undefined && idOrNull(caseParam) === null)) notFound();
  return (
    <>
      <h1>{message("screen.support.title")}</h1>
      <SupportScreen agencyId={agency} projectId={idOrNull(project)} caseId={idOrNull(caseParam)} />
    </>
  );
}
