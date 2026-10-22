// The review states of the three source screens the web implements (UI14 Source intake, UI15 Selection, UI16 Seal review), answered from
// the review's one project (fixtures/project.ts). Each state is only the api's answers; the screens draw them with their own code.
import type { SourceRevisionView, UploadView } from "@web/api/generated.ts";
import type { ReviewContext } from "../contexts.ts";
import { AGENCY_ID } from "../contexts.ts";
import type { Script } from "../fixture-fetch.ts";
import { PENDING, READ, type StateDef, UNAVAILABLE } from "../scenario.ts";
import { companiesAdmitted, companiesNotScanned, companiesRejected, companiesUploading, contactsAdmitted, readyRevision, REVISION, reviewEvaluated, reviewInspection, reviewProject, uploadingRevision } from "./project.ts";

const agencyOf = (ctx: ReviewContext): string => ctx.agency?.agencyId ?? AGENCY_ID;

/** The project and its current revision, agreeing on the revision's state and version, and the uploads the revision holds. */
function sources(revision: (agency: string) => SourceRevisionView, uploads: (agency: string) => readonly UploadView[]) {
  return (ctx: ReviewContext): Script => {
    const agency = agencyOf(ctx);
    const current = revision(agency);
    return {
      GetProject: () => READ(reviewProject(agency, { currentRevision: { revisionId: REVISION, state: current.state, version: current.version } })),
      GetRevision: () => READ(current),
      ListUploads: () => READ({ items: uploads(agency) }),
    };
  };
}

const failing = (reply: typeof PENDING | typeof UNAVAILABLE) => (): Script => ({ GetProject: reply });

const SHARED_END: readonly StateDef[] = [
  { key: "loading", label: "Loading", note: "The project has not been read yet: the screen holds its place and says so.", script: failing(PENDING) },
  { key: "error", label: "Recoverable error", note: "The project could not be read for a moment: the screen offers to try again.", script: failing(UNAVAILABLE) },
  { key: "denied", label: "Not a member", note: "A signed-in person who is not a member of this agency: the shell refuses before anything is read.", base: "AGENCY_REFUSED" },
];

export const UI14_STATES: readonly StateDef[] = [
  { key: "normal", label: "Both files in", note: "contacts.csv and companies.xlsx admitted, read and scanned: the next step is choosing what is included; more files can still be added.", script: sources((agency) => uploadingRevision(agency, { state: "INSPECTING", version: 6, permittedActions: ["ReserveUpload", "CompleteUpload", "CancelUpload", "SelectInputTables"] }), (agency) => [contactsAdmitted(agency), companiesAdmitted(agency)]) },
  { key: "uploading", label: "Uploading", note: "companies.xlsx is still uploading; contacts.csv is in.", script: sources((agency) => uploadingRevision(agency), (agency) => [contactsAdmitted(agency), companiesUploading(agency)]) },
  { key: "not-scanned", label: "Not fully checked", note: "The scanner did not cover companies.xlsx: its structure was read, and the page says it was not fully checked.", script: sources((agency) => uploadingRevision(agency), (agency) => [contactsAdmitted(agency), companiesNotScanned(agency)]) },
  { key: "rejected", label: "A file refused", note: "companies.xlsx is not the format its name says: it is refused with its reason, and the team replaces it.", script: sources((agency) => uploadingRevision(agency), (agency) => [contactsAdmitted(agency), companiesRejected(agency)]) },
  { key: "empty", label: "No files yet", note: "A new project: nothing uploaded yet, and the limits said before the first upload.", script: sources((agency) => uploadingRevision(agency), () => []) },
  ...SHARED_END,
];

/** The selection screen reads the inspection of the revision as well. */
function selection(evaluated: boolean) {
  return (ctx: ReviewContext): Script => {
    const agency = agencyOf(ctx);
    const view = evaluated ? reviewEvaluated(agency) : reviewInspection(agency);
    return {
      GetProject: () => READ(reviewProject(agency, { currentRevision: { revisionId: REVISION, state: view.revision.state, version: view.revision.version } })),
      GetRevision: () => READ(view.revision),
      GetInspection: () => READ(view),
      ListUploads: () => READ({ items: view.uploads }),
    };
  };
}

export const UI15_STATES: readonly StateDef[] = [
  { key: "normal", label: "Choose what is included", note: "Both files read: the visible sheets offered, the hidden archive sheet with formulas flagged, a duplicate column label shown by position.", script: selection(false) },
  { key: "evaluated", label: "Selection confirmed", note: "The archive sheet left out with its reason; the counts measured on everything included.", script: selection(true) },
  ...SHARED_END,
];

function seal(sealed: boolean) {
  return (ctx: ReviewContext): Script => {
    const agency = agencyOf(ctx);
    const view = reviewEvaluated(agency);
    const current = sealed ? readyRevision(agency, { state: "SEALED", version: 10, permittedActions: [] }) : view.revision;
    return {
      GetProject: () => READ(reviewProject(agency, { currentRevision: { revisionId: REVISION, state: current.state, version: current.version } })),
      GetRevision: () => READ(current),
      GetInspection: () => READ({ ...view, revision: current }),
      ListUploads: () => READ({ items: view.uploads }),
    };
  };
}

export const UI16_STATES: readonly StateDef[] = [
  { key: "normal", label: "Ready to seal", note: "The exact set: two files, two tables included, one left out with its reason, 15,684 billable source units, and the date the data is kept until.", script: seal(false) },
  { key: "sealed", label: "Sealed", note: "The set is sealed: it can no longer change, and sealing did not start a paid audit.", script: seal(true) },
  ...SHARED_END,
];
