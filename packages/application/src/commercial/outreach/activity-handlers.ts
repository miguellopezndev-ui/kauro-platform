/**
 * Lane L-ACT's four handlers as one factory, for the composition root to spread over the NOT_BUILT stubs of createOutreachStub*Handlers
 * (the same operation ids: CMD064, RecordOutreachDiagnosis, ListSalesActivities, GetOutreachMetrics).
 */
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { ActivityCollaborators } from "./activity-ports.js";
import { recordOutreachDiagnosisHandler } from "./diagnosis.js";
import { listSalesActivitiesHandler } from "./list-activities.js";
import { getOutreachMetricsHandler } from "./metrics.js";
import { recordActivityHandler } from "./record-activity.js";

export function createActivityCommandHandlers(runtime: CommerceRequestRuntime, co: ActivityCollaborators): { readonly CMD064: CommercialCommandHandler<unknown, unknown>; readonly RecordOutreachDiagnosis: CommercialCommandHandler<unknown, unknown> } {
  return Object.freeze({
    CMD064: recordActivityHandler(runtime, co) as unknown as CommercialCommandHandler<unknown, unknown>,
    RecordOutreachDiagnosis: recordOutreachDiagnosisHandler(runtime, co) as unknown as CommercialCommandHandler<unknown, unknown>,
  });
}

export function createActivityReadHandlers(runtime: CommerceRequestRuntime, co: ActivityCollaborators): { readonly ListSalesActivities: CommercialReadHandler<unknown>; readonly GetOutreachMetrics: CommercialReadHandler<unknown> } {
  return Object.freeze({
    ListSalesActivities: listSalesActivitiesHandler(runtime, co) as unknown as CommercialReadHandler<unknown>,
    GetOutreachMetrics: getOutreachMetricsHandler(runtime, co) as unknown as CommercialReadHandler<unknown>,
  });
}
