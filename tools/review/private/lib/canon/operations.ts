// Operations in the canonical world: jobs in every state (queued, running, failed, succeeded), one open and one resolved incident,
// deletion requests (one pending, three done with a receipt), three releases and six support cases. Each names the projects and
// workspaces above, so the owner's Jobs, Incidents, Deletion, Releases and Support pages tell the same stories as the workspace pages
// (case 115 is Fjordline's defect report, which holds Amara Okafor's line and is the refund request counsel is reviewing).
import { P, WS } from "./people.ts";
import { PRJ } from "./projects.ts";
import type { DeletionRequest, Incident, Job, Release, SupportCase } from "./types.ts";

export const JOBS: readonly Job[] = [
  { id: "job-1041", kind: "HEALTH_CHECK", projectId: PRJ.nwCustomerList, state: "RUNNING", attempt: 1, queuedAt: "2026-10-22T13:30:00Z", startedAt: "2026-10-22T13:30:00Z", endedAt: null, failure: null },
  { id: "job-1038", kind: "PREPARATION", projectId: PRJ.lkCustomerList, state: "FAILED", attempt: 1, queuedAt: "2026-10-22T12:45:00Z", startedAt: "2026-10-22T12:45:00Z", endedAt: "2026-10-22T13:10:00Z", failure: "A lease expired: the attempt stopped safely and nothing was published." },
  { id: "job-1039", kind: "PREPARATION", projectId: PRJ.lkCustomerList, state: "RUNNING", attempt: 2, queuedAt: "2026-10-22T13:10:00Z", startedAt: "2026-10-22T13:12:00Z", endedAt: null, failure: null },
  { id: "job-1042", kind: "IMPORT_READBACK", projectId: PRJ.nwOpportunities, state: "QUEUED", attempt: 1, queuedAt: "2026-10-22T13:50:00Z", startedAt: null, endedAt: null, failure: null },
  { id: "job-1033", kind: "PREPARATION", projectId: PRJ.coQ4, state: "SUCCEEDED", attempt: 1, queuedAt: "2026-10-20T16:10:00Z", startedAt: "2026-10-20T16:10:00Z", endedAt: "2026-10-21T15:00:00Z", failure: null },
  { id: "job-0712", kind: "DELETION", projectId: PRJ.coAccounts, state: "SUCCEEDED", attempt: 1, queuedAt: "2026-08-30T10:00:00Z", startedAt: "2026-08-30T10:05:00Z", endedAt: "2026-08-30T10:40:00Z", failure: null },
];

export const INCIDENTS: readonly Incident[] = [
  {
    id: "INC-2026-007",
    severity: "S2",
    state: "OPEN",
    title: "Download links fail for some packages",
    openedAt: "2026-10-22T13:20:00Z",
    resolvedAt: null,
    projectIds: [PRJ.coQ4, PRJ.nwOpportunities],
    containment: "Done 13:31 UTC: new links for the 2 packages paused",
    recovery: "Under way: the signing key is being rotated",
    communication: "A notice to the 2 workspaces, prepared, not sent",
  },
  {
    id: "INC-2026-006",
    severity: "S3",
    state: "RESOLVED",
    title: "Health checks delayed",
    openedAt: "2026-10-09T07:40:00Z",
    resolvedAt: "2026-10-09T08:53:00Z",
    projectIds: [],
    containment: "Done 08:20 UTC: the queue was drained",
    recovery: "Proved 08:53 UTC: checks compared with a second run",
    communication: "Not required: no customer saw a wrong result",
  },
];

export const DELETIONS: readonly DeletionRequest[] = [
  { id: "DR-2026-0031", projectId: PRJ.coAccounts, origin: "CUSTOMER_REQUEST", scope: "PROJECT", target: null, requestedAt: "2026-08-30T10:00:00Z", requestedBy: P.grace, state: "DONE", doneAt: "2026-08-30T10:40:00Z", receipt: "DEL-RCPT-2026-0031" },
  { id: "DR-2026-0040", projectId: PRJ.fjContacts, origin: "RETENTION_SCHEDULE", scope: "PROJECT", target: null, requestedAt: "2026-09-10T10:00:00Z", requestedBy: null, state: "DONE", doneAt: "2026-09-10T10:00:00Z", receipt: "DEL-RCPT-2026-0040" },
  { id: "DR-2026-0052", projectId: PRJ.hoDealers, origin: "RETENTION_SCHEDULE", scope: "PROJECT", target: null, requestedAt: "2026-10-03T19:00:00Z", requestedBy: null, state: "DONE", doneAt: "2026-10-03T19:00:00Z", receipt: "DEL-RCPT-2026-0052" },
  { id: "DR-2026-0061", projectId: PRJ.fjEvents, origin: "CUSTOMER_REQUEST", scope: "SOURCE_FILE", target: "old-leads-2024.csv", requestedAt: "2026-10-22T10:15:00Z", requestedBy: P.siobhan, state: "PENDING", doneAt: null, receipt: null },
];

export const RELEASES: readonly Release[] = [
  { id: "2026.10.2", state: "PROMOTED", createdAt: "2026-10-13T18:00:00Z", promotedAt: "2026-10-14T15:00:00Z", note: "Accepted exact candidate; contracts unchanged since 2026.10.1" },
  { id: "2026.10.3", state: "HELD", createdAt: "2026-10-20T17:00:00Z", promotedAt: null, note: "This image is not the one that was tested" },
  { id: "2026.10.4", state: "CANDIDATE", createdAt: "2026-10-22T11:00:00Z", promotedAt: null, note: "Every check passed on this image; ready to promote" },
];

export const SUPPORT_CASES: readonly SupportCase[] = [
  { id: "case-104", number: 104, workspaceId: WS.coastline, projectId: PRJ.coAccounts, kind: "DEFECT_REPORT", title: "Contacts linked to the wrong account", state: "RESOLVED", openedAt: "2026-09-20T14:00:00Z", openedBy: P.grace, nextAnswerDue: null, resolvedAt: "2026-10-13T15:00:00Z" },
  { id: "case-109", number: 109, workspaceId: WS.halden, projectId: PRJ.hoDealers, kind: "DEFECT_REPORT", title: "Dealer names lost their accents", state: "RESOLVED", openedAt: "2026-10-01T13:00:00Z", openedBy: P.tomasReyes, nextAnswerDue: null, resolvedAt: "2026-10-06T15:00:00Z" },
  { id: "case-115", number: 115, workspaceId: WS.fjordline, projectId: PRJ.fjContacts, kind: "DEFECT_REPORT", title: "Contacts HubSpot refused at import", state: "WAITING_KAURO", openedAt: "2026-10-08T15:00:00Z", openedBy: P.siobhan, nextAnswerDue: "2026-10-23T14:00:00Z", resolvedAt: null },
  { id: "case-116", number: 116, workspaceId: WS.northwind, projectId: PRJ.nwMain, kind: "BILLING", title: "The quote and its payment instructions", state: "WAITING_KAURO", openedAt: "2026-10-21T15:00:00Z", openedBy: P.ines, nextAnswerDue: "2026-10-22T16:00:00Z", resolvedAt: null },
  { id: "case-117", number: 117, workspaceId: WS.halden, projectId: PRJ.hoRecords, kind: "IMPORT_STEPS", title: "Import steps", state: "WAITING_CUSTOMER", openedAt: "2026-10-21T19:00:00Z", openedBy: P.tomasReyes, nextAnswerDue: null, resolvedAt: null },
  { id: "case-118", number: 118, workspaceId: WS.ridge, projectId: null, kind: "BILLING", title: "Billing details", state: "WAITING_CUSTOMER", openedAt: "2026-10-20T16:00:00Z", openedBy: P.felix, nextAnswerDue: null, resolvedAt: null },
];
