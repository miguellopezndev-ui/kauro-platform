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
