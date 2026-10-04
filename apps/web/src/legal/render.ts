// The renderer of the three legal documents (design D-LEGAL-1). Pure: facts in, either a refusal or a published document out.
//
// A document is published only from a complete fact set (gapsOf is empty); any gap, in any fact, refuses all three documents and the
// refusal carries no version, because a version names words that exist. The version label is
//   <document key>-<effective date>-<first 12 hex of sha256 of the rendered text>
// and the text it hashes is the words of the document as plain text, with the effective date in it and the label not in it: the same
// words always carry the same label, whatever a fact's citation says, and a new word is a new version (an accepted version never changes).
import { gapsOf, textOf, type Gap, type OperatorFacts } from "./facts.ts";
import { sha256Hex } from "./sha256.ts";
import { DATA_PROCESSING, PRIVACY, TERMS, type ResolvedFacts, type Section, type Template } from "./templates.ts";

export const LEGAL_KEYS = ["terms", "privacy", "data-processing"] as const;
export type LegalKey = (typeof LEGAL_KEYS)[number];

export interface LegalDocument {
  readonly key: LegalKey;
  /** The public path, and the folder of its route handler under src/app/(public). */
  readonly route: string;
  readonly title: string;
  readonly primary: string;
}

const TEMPLATES: Readonly<Record<LegalKey, Template>> = { terms: TERMS, privacy: PRIVACY, "data-processing": DATA_PROCESSING };

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = LEGAL_KEYS.map((key) => ({
  key,
  route: `/legal/${key}`,
  title: TEMPLATES[key].title,
  primary: TEMPLATES[key].primary,
}));

export interface RefusedLegal {
  readonly published: false;
  readonly key: LegalKey;
  readonly title: string;
  /** Why, for the operator's log: never shown on a page. */
  readonly gaps: readonly Gap[];
}

export interface PublishedLegal {
  readonly published: true;
  readonly key: LegalKey;
  readonly title: string;
  readonly primary: string;
  readonly effectiveDate: string;
  readonly version: string;
  /** The words of the document as plain text: what the version label digests. */
  readonly text: string;
  readonly sections: readonly Section[];
}

export type RenderedLegal = RefusedLegal | PublishedLegal;

/** `<document>-<effective date>-<first 12 hex of sha256 of the text>`. */
export function versionLabel(key: LegalKey, effectiveDate: string, text: string): string {
  return `${key}-${effectiveDate}-${sha256Hex(text).slice(0, 12)}`;
}

function resolve(facts: OperatorFacts): ResolvedFacts {
  return {
    legalName: textOf(facts.legalName),
    entityType: textOf(facts.entityType),
    taxId: textOf(facts.taxId),
    registeredAddress: textOf(facts.registeredAddress),
    postalContact: textOf(facts.postalContact),
    legalEmail: textOf(facts.legalEmail),
    governingLaw: textOf(facts.governingLaw),
    forum: textOf(facts.forum),
    liability: textOf(facts.liability),
    effectiveDate: textOf(facts.effectiveDate),
    subprocessors: (facts.subprocessors ?? []).map((entry) => ({
      name: textOf(entry.name),
      purpose: textOf(entry.purpose),
      location: textOf(entry.location),
      transferBasis: textOf(entry.transferBasis),
    })),
  };
}

/** The document as plain text: a title, its promise and each section as a heading, its paragraphs and its list. */
export function serialize(title: string, primary: string, sections: readonly Section[]): string {
  const blocks: string[] = [title, primary];
  for (const section of sections) {
    blocks.push(`## ${section.heading}`);
    blocks.push(...section.paragraphs);
    if (section.items !== undefined && section.items.length > 0) blocks.push(section.items.map((item) => `- ${item}`).join("\n"));
  }
  return blocks.join("\n\n");
}

export function renderLegal(key: LegalKey, facts: OperatorFacts): RenderedLegal {
  const template = TEMPLATES[key];
  const gaps = gapsOf(facts);
  if (gaps.length > 0) return { published: false, key, title: template.title, gaps };
  const resolved = resolve(facts);
  const sections = template.sections(resolved);
  const text = serialize(template.title, template.primary, sections);
  return {
    published: true,
    key,
    title: template.title,
    primary: template.primary,
    effectiveDate: resolved.effectiveDate,
    version: versionLabel(key, resolved.effectiveDate, text),
    text,
    sections,
  };
}
