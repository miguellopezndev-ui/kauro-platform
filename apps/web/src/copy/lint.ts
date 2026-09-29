// The copy lint of design D-COPY-1: amendment A3 section 3 as executable rules. Pure (no file access, no environment), so a test can run
// it over the catalogue, over the sources of the public and legal pages, and over a synthetic entry that must fail. A rule answers the
// message id (or file), the rule name and the offending text; it never rewrites anything.
//
// The pre-rename brand is not spelled anywhere in this repository's web sources: the caller passes the names to refuse (the test reads
// them from the contract package's alias table at run time).

export interface CopyViolation {
  readonly id: string;
  readonly rule: string;
  readonly text: string;
}

export interface LintOptions {
  /** Names of the earlier brand, refused as whole words in any case. */
  readonly brands: readonly string[];
}

/** The one sentence about AI that A3 3.1 permits, at most once per page or message and never on a surface. */
export const PERMITTED_AI_SENTENCE =
  "Before any CRM or AI project, your data needs to be clean, deduplicated and with every change explained. The free data health check shows you the exact numbers.";
export const HEALTH_CHECK_NAME = "Free data health check";
export const HEALTH_CHECK_CTA = "Request a free data health check";
export const IN_HOUSE_SENTENCE = "In-house CRM and data teams can use Kauro too.";

interface PhraseRule {
  readonly rule: string;
  readonly pattern: RegExp;
}

/** Phrases refused in any customer text (A3 3.1, 3.2, 3.3, 3.5; D-COPY-1). */
const FORBIDDEN: readonly PhraseRule[] = [
  { rule: "A3-3.2 the free step is never an audit or a diagnosis", pattern: /\baudits?(ed|ing)?\b/i },
  { rule: "A3-3.2 the free step is never an audit or a diagnosis", pattern: /\bdiagnos(is|es|e|tic|tics)\b/i },
  { rule: "A3-3.1 no AI-ready data", pattern: /\bAI[- ]ready\b/i },
  { rule: "A3-3.1 AI never cleans data", pattern: /\bAI[- ]?(cleans|cleaned|cleaning|powered|driven)\b/i },
  { rule: "A3-3.1 Kauro never prepares data for, trains or improves a customer's AI", pattern: /\b(prepares? data for|connects? to|trains?|improves?)\s+(your|a customer's|the customer's|any)\s+AI\b/i },
  { rule: "A3-3.1 the owner's original phrases are never used", pattern: /\bwithout (losing money|mathematical hallucinations)\b/i },
  { rule: "A3-3.3 no compatibility claim", pattern: /\bworks with any CRM\b/i },
  { rule: "A3-3.3 no compatibility claim", pattern: /\bcompatible with\b/i },
  { rule: "A3-3.3 no compatibility claim", pattern: /\bimport-ready for any CRM\b/i },
  { rule: "A3-3.3 duplicates are unified with approval, never deleted", pattern: /\bwe (delete|remove|eliminate)\s+(the\s+)?(duplicates?|records?)\b/i },
  { rule: "A3-3.3 duplicates are unified with approval, never deleted", pattern: /\beliminate\s+records\b/i },
  { rule: "A3-3.5 no savings amount and no guarantee", pattern: /\byou (will )?save\s+(up to\s+)?(USD|US\$|\$)/i },
  { rule: "A3-3.5 no savings amount and no guarantee", pattern: /\bpays? for itself\b/i },
  { rule: "A3-3.5 no savings amount and no guarantee", pattern: /\bguaranteed (saving|savings)\b/i },
  { rule: "A3-3.5 the check is always free", pattern: /\bif we find nothing\b/i },
  { rule: "D-COPY-1 the founding discount line stays hidden until B10 reports a reservable slot", pattern: /\bfounding\b/i },
  { rule: 'D-COPY-1 "Prepared for import", never "Imported"', pattern: /\bImported\b/ },
];

const SURFACE_SUFFIXES = ["title", "heading", "label", "cta", "offer", "subject", "name"] as const;
const AI_WORD = /\bAI\b/;

function segmentOf(id: string): string {
  return id.slice(id.lastIndexOf(".") + 1);
}

/** Phrase-level rules over any text: the catalogue's entries, a page's sources, a mail template. `id` names where the text lives. */
export function lintText(id: string, text: string, options: LintOptions): readonly CopyViolation[] {
  const found: CopyViolation[] = [];
  for (const { rule, pattern } of FORBIDDEN) if (pattern.test(text)) found.push({ id, rule, text });
  for (const brand of options.brands) {
    if (brand.length === 0) continue;
    if (new RegExp(`(^|[^A-Za-z0-9])${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "i").test(text)) found.push({ id, rule: "D-COPY-1 the pre-rename brand is never written", text });
  }
  return found;
}

/** The rules that need the message id: surfaces, the one permitted AI sentence, required names and the once-only Pricing sentence. */
export function lintCatalogue(entries: Readonly<Record<string, string>>, options: LintOptions): readonly CopyViolation[] {
  const found: CopyViolation[] = [];
  for (const [id, text] of Object.entries(entries)) {
    if (text.trim() !== text || text.length === 0) found.push({ id, rule: "D-COPY-1 a message is non-empty and has no leading or trailing space", text });
    if (/[{}]/.test(text.replaceAll(/\{[A-Za-z][A-Za-z0-9]*\}/g, ""))) found.push({ id, rule: "D-COPY-1 a placeholder is {name}", text });
    if (/[<>]/.test(text)) found.push({ id, rule: "D-COPY-1 copy is plain text: no markup", text });
    found.push(...lintText(id, text, options));
    const withoutPermitted = text.replace(PERMITTED_AI_SENTENCE, "");
    const surface = (SURFACE_SUFFIXES as readonly string[]).includes(segmentOf(id));
    if (surface && (AI_WORD.test(text) || /\bartificial intelligence\b/i.test(text))) found.push({ id, rule: "A3-3.1 AI never appears in a headline, title, offer, label or name", text });
    else if (!surface && (AI_WORD.test(withoutPermitted) || /\bartificial intelligence\b/i.test(withoutPermitted))) found.push({ id, rule: "A3-3.1 AI appears only in the one permitted sentence", text });
  }
  const need = (id: string, exact: string, rule: string): void => {
    if (entries[id] !== exact) found.push({ id, rule, text: entries[id] ?? "" });
  };
  need("health-check.title", HEALTH_CHECK_NAME, `A3-3.2 the free step is named "${HEALTH_CHECK_NAME}"`);
  need("public.cta.request-health-check.cta", HEALTH_CHECK_CTA, `A3-3.2 the call to action is "${HEALTH_CHECK_CTA}"`);
  const inHouse = Object.entries(entries).filter(([, text]) => text.includes(IN_HOUSE_SENTENCE));
  if (inHouse.length !== 1) found.push({ id: "(catalogue)", rule: "A3-3.7 the in-house sentence appears exactly once", text: `${inHouse.length} times` });
  for (const [id, text] of inHouse) if (!id.startsWith("pricing.")) found.push({ id, rule: "A3-3.7 the in-house sentence appears on Pricing only", text });
  return found;
}

/** Source text of a page without its comments: block comments and whole-line comments (a URL inside a string keeps its slashes). */
export function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}
