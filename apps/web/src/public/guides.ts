// The static help guides of UI48 (A3 3.8: "static versioned guides"; search is deferred). The words are catalogue messages; this module
// arranges them into guides, fills the figures a guide states from the vendored policy snapshot, and carries the guides' version.
//
// "Versioned" is enforced, not promised: test/public-data.test.ts records a digest of guideText() under GUIDES_VERSION and GUIDES_CHANGED,
// so a change to any guide (or to a policy number a guide states) fails that test until the version and the date are raised and the digest
// is recorded again.
import { PUBLIC_COPY, copy, placeholdersOf, type PublicCopyId } from "../copy/public.ts";
import { INPUT_LIMITS } from "./limits.ts";
import { POLICY_SNAPSHOT } from "./policy-snapshot.ts";
import { formatDays } from "./retention.ts";

export const GUIDES_VERSION = "1.3";
/** The date the guides last changed, in UTC. */
export const GUIDES_CHANGED = "2026-10-20";

export interface GuideParagraph {
  readonly id: PublicCopyId;
  readonly text: string;
}

export interface Guide {
  /** The anchor of the guide on the help page: `guide-<slug>`. */
  readonly slug: string;
  readonly headingId: PublicCopyId;
  readonly heading: string;
  readonly summary: string;
  readonly paragraphs: readonly GuideParagraph[];
}

interface Outline {
  readonly slug: string;
  readonly headingId: PublicCopyId;
  readonly summaryId: PublicCopyId;
  readonly paragraphs: readonly PublicCopyId[];
}

const OUTLINE: readonly Outline[] = [
  { slug: "files", headingId: "help.files.heading", summaryId: "help.files.summary", paragraphs: ["help.files.export", "help.files.limits", "help.files.large", "help.files.excluded"] },
  { slug: "target", headingId: "help.target.heading", summaryId: "help.target.summary", paragraphs: ["help.target.confirm", "help.target.keep"] },
  { slug: "approval", headingId: "help.approval.heading", summaryId: "help.approval.summary", paragraphs: ["help.approval.review", "help.approval.version", "help.approval.enter"] },
  { slug: "payment", headingId: "help.payment.heading", summaryId: "help.payment.summary", paragraphs: ["help.payment.quote", "help.payment.confirm"] },
  { slug: "stages", headingId: "help.stages.heading", summaryId: "help.stages.summary", paragraphs: ["help.stages.flow", "help.stages.receipt", "help.stages.state"] },
  { slug: "retention", headingId: "help.retention.heading", summaryId: "help.retention.summary", paragraphs: ["help.retention.purchased", "help.retention.check", "help.retention.full"] },
  { slug: "support", headingId: "help.support.heading", summaryId: "help.support.summary", paragraphs: ["help.support.case", "help.support.secrets", "help.support.contact"] },
];

const r = POLICY_SNAPSHOT.retention;

/** Every figure a guide states, from the policy; a paragraph takes only the ones it has a place for. */
const FIGURES: Readonly<Record<string, string | number>> = Object.freeze({
  files: INPUT_LIMITS.files,
  fileSize: INPUT_LIMITS.fileSize,
  setSize: INPUT_LIMITS.setSize,
  columns: INPUT_LIMITS.columns,
  units: INPUT_LIMITS.units,
  days: POLICY_SNAPSHOT.quoteDays,
  kept: formatDays(r.targetMetadataDaysFromLastUse),
  fresh: formatDays(r.targetExecutionFreshnessDays),
  package: formatDays(r.paidDaysFromFirstPackage),
  hard: formatDays(r.paidDaysHardFromCapture),
  check: formatDays(r.unpaidDaysFromReady),
});

function paragraph(id: PublicCopyId): GuideParagraph {
  const values: Record<string, string | number> = {};
  for (const name of placeholdersOf(PUBLIC_COPY[id])) {
    const value = FIGURES[name];
    if (value !== undefined) values[name] = value;
  }
  return { id, text: copy(id, values) };
}

/** The guides in the order the help page shows them, with every figure filled. */
export function guides(): readonly Guide[] {
  return OUTLINE.map((outline) => ({
    slug: outline.slug,
    headingId: outline.headingId,
    heading: copy(outline.headingId),
    summary: copy(outline.summaryId),
    paragraphs: outline.paragraphs.map(paragraph),
  }));
}

/** The guides as one text (headings, summaries and paragraphs in order): the input of the recorded digest. */
export function guideText(): string {
  return guides()
    .map((guide) => [guide.heading, guide.summary, ...guide.paragraphs.map((item) => item.text)].join("\n"))
    .join("\n\n");
}
