/**
 * What lane L-ACT's handlers (CMD064, ListSalesActivities, GetOutreachMetrics, RecordOutreachDiagnosis) run on: B09's request runtime and the
 * commercial authorizer, plus ONE accessor over the unit of work for the activity records (@kauro/persistence outreachActivityOf). Every SQL
 * statement, advisory lock (plan §L) and database-clock judgment (plan §W) lives behind OutreachActivityStore; the handlers here own the
 * access decision, the journal, the closed request shape and the view. D-33: nothing here reads a segment or a buyer type, and nothing ranks.
 */
import type { UnitOfWork } from "@kauro/domain";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { CommercialAuthorizer } from "../authorizer.js";
import type { OutreachDiagnosisView, OutreachMetricsView, SalesActivityView } from "../views.js";

/** CMD064 after the closed request schema and the kind-shape checks: who records, and what. */
export interface RecordActivityRequest {
  readonly activityId: string;
  /** The registry row id of a SUPPRESSED activity (unused by the other kinds). */
  readonly suppressionId: string;
  readonly callerUserId: string;
  /** The caller's ACTIVE seller id, or null when the caller is the corporate owner. */
  readonly callerSellerId: string | null;
  readonly prospectId: string;
  readonly draftId: string | null;
  readonly kind: "REPLIED" | "BOUNCED" | "SUPPRESSED" | "HUMAN_SEND_OBSERVED";
  readonly occurredAt: string;
  readonly evidenceHash: string;
  readonly providerMessageRef: string;
  readonly observation: "SENT" | "NOT_SENT" | null;
  readonly suppressionKeyKind: "ORGANIZATION" | "CONTACT" | null;
  readonly suppressionReason: "OPT_OUT" | "COMPLAINT" | "DISQUALIFIED" | "REFUSAL" | null;
}

export interface RecordDiagnosisRequest {
  readonly diagnosisId: string;
  readonly ownerUserId: string;
  readonly personUserId: string;
  readonly evidenceHash: string;
  readonly proofId: string;
}

/** The activity records of one unit of work. Each method throws a DomainFailure for a refusal and writes nothing then. */
export interface OutreachActivityStore {
  /** CMD064 in lock order (plan §L): discovery, the whole serializer set, the judgment at kauro.effect_now(), then the writes. */
  record(request: RecordActivityRequest): Promise<SalesActivityView>;
  /** The newest activities (at most 200) of one prospect the caller may see; null when the prospect is not the caller's to see. */
  listForProspect(prospectId: string, callerSellerId: string | null): Promise<ReadonlyArray<SalesActivityView> | null>;
  /** Counts of what the caller may see (RLS) and the pause rule's numerator and denominator for the caller's own sends. */
  metrics(callerUserId: string): Promise<OutreachMetricsView>;
  /** RecordOutreachDiagnosis under L4 X of the person; NOT_FOUND when the person has never sent. */
  recordDiagnosis(request: RecordDiagnosisRequest): Promise<OutreachDiagnosisView>;
}

export interface ActivityCollaborators {
  readonly authorizer: CommercialAuthorizer;
  readonly activity: (uow: UnitOfWork) => OutreachActivityStore;
  /** B06's step-up verifier (RecordOutreachDiagnosis, owner step-up). */
  readonly assurance: AssuranceVerifier;
}
