/**
 * GetOutreachMetrics — GET /api/v1/ops/outreach/metrics — an ACTIVE seller or the corporate owner (plan docs/design/B12-outreach-plan.md §2 Reads,
 * A12). Counts of what was observed, under the caller's own policies: accepted by the provider, uncertain, observed sent by a person, bounced,
 * replied, accepted less the bounces known, and the pause rule's numerator and denominator (bounces among the caller's latest min(n, 50) counted
 * sends after its latest diagnosis). No member names "delivered": delivery is never known (R2-129).
 */
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { OutreachMetricsView } from "../views.js";
import type { ActivityCollaborators } from "./activity-ports.js";
import { outreachActivityRead } from "./list-activities.js";

export function getOutreachMetricsHandler(runtime: CommerceRequestRuntime, co: ActivityCollaborators): CommercialReadHandler<OutreachMetricsView> {
  return outreachActivityRead<OutreachMetricsView>(runtime, co, "GetOutreachMetrics", (uow, caller) => co.activity(uow).metrics(caller.userId));
}
