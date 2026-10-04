/** Support (B11 CMD044): the severity table, the covered-hours calculator with its holiday calendar, and the content detector. */
export { SUPPORT_SEVERITY_BY_CATEGORY, severityOf } from "./severity.js";
export type { DateKey, HolidayCalendar, HolidaySource } from "./holidays.js";
export { COLOMBIA_CALENDAR_VERSION, COLOMBIA_HOLIDAYS, COLOMBIA_HOLIDAY_SOURCE, colombianHolidays, easterSundayMs } from "./holidays.js";
export type { SupportWindow, Weekday } from "./covered-hours.js";
export { BOGOTA_OFFSET_MS, SUPPORT_TIMEZONE, SupportPolicyError, nextReviewAt, supportWindowOf } from "./covered-hours.js";
export type { ContentFinding } from "./content-detector.js";
export { detectRefusedContent } from "./content-detector.js";
