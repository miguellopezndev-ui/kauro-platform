// Package B12 outreach (plan docs/design/B12-outreach-plan.md): ports, runtime bounds and the calendar. The command handlers are the
// lanes' (L-DRAFT, L-AUTH, L-SEND, L-ACT, L-HOME); until a lane lands its handler answers NOT_BUILT (handlers.ts).
export type { OutreachSubmission, OutreachSubmitAnswer, OutreachSendPort, OutreachPorts } from "./ports.js";
export { OUTREACH_POLICY_VERSION, OUTREACH_RUNTIME, OUTREACH_UNCERTAIN_AFTER_MS, providerCallSignal } from "./runtime.js";
export type { OutreachZone } from "./calendar.js";
export {
  OUTREACH_CALENDAR_VERSION,
  OUTREACH_CALENDAR_FIRST_YEAR,
  OUTREACH_CALENDAR_LAST_YEAR,
  OUTREACH_CALENDAR_SOURCE,
  usFederalHolidays,
  outreachCalendarDays,
  isOutreachBusinessInstant,
  outreachBusinessDaysAfter,
} from "./calendar.js";
export { OUTREACH_HANDLERS, OutreachNotBuilt, type OutreachHandlerName } from "./handlers.js";
export { B12_SERVED_READ_IDS, createOutreachStubCommandHandlers, createOutreachStubReadHandlers, isB12CommercialCommand, isB12CommercialRead, isB12RegistryLessOperation, type B12CommandId, type B12ReadId } from "./routes.js";
// lane L-ACT (CMD064, ListSalesActivities, GetOutreachMetrics, RecordOutreachDiagnosis, the public opt-out)
export type { ActivityCollaborators, OutreachActivityStore, RecordActivityRequest, RecordDiagnosisRequest } from "./activity-ports.js";
export { recordActivityHandler, checkActivityShape } from "./record-activity.js";
export { listSalesActivitiesHandler } from "./list-activities.js";
export { getOutreachMetricsHandler } from "./metrics.js";
export { recordOutreachDiagnosisHandler } from "./diagnosis.js";
export { admitOneClickOptOut, OPT_OUT_BODY_LIMIT_BYTES, type OneClickAdmission } from "./opt-out-admission.js";
export { mintOptOutToken, readOptOutToken, optOutByToken, networkDigestOf, OPT_OUT_MISS_LIMIT, OPT_OUT_MISS_WINDOW_SECONDS, type OptOutKey, type OptOutStore, type OptOutOutcome, type OptOutAnswer, type OptOutDependencies } from "./opt-out.js";
export { createActivityCommandHandlers, createActivityReadHandlers } from "./activity-handlers.js";
