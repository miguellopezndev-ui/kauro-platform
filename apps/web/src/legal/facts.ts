// The operator facts of the three legal documents (design D-LEGAL-1; manual 19 "BusinessProfile and legal facts": a legal contact and a
// real postal address are required for customer terms, and the assistant never fills an unknown identity field from a display name or an
// example). Pure: no file access and no environment, so a test can hand the renderer any fact set.
//
// A fact is a recorded value and where it came from. The file of the shipped facts (operator-facts.json) names every fact and holds null
// for each one the owner has not provided; a fact left out of the file is a mistake, not a null. A fact whose value is REQUIRES_REVIEW is
// one the operator's legal reviewer has not confirmed (liability, governing law and forum are decided by application to the actual
// operator and customer contract, 19 "Service terms: required operative content"). Any gap, in any fact, stops every document: a
// document that names its operator in one place and leaves a blank in another is not a legal document.

/** The value a fact carries while its text awaits the legal reviewer. */
export const REQUIRES_REVIEW = "REQUIRES_REVIEW";

/** A recorded fact: its text and the citation of where it came from (the citation is never part of a document). */
export interface Fact {
  readonly value: string;
  readonly source: string;
}

export interface Subprocessor {
  readonly name: Fact | null;
  readonly purpose: Fact | null;
  readonly location: Fact | null;
  readonly transferBasis: Fact | null;
}

export const SCALAR_FACT_NAMES = [
  "legalName",
  "entityType",
  "taxId",
  "registeredAddress",
  "postalContact",
  "legalEmail",
  "governingLaw",
  "forum",
  "liability",
  "effectiveDate",
] as const;

export const FACT_NAMES = [...SCALAR_FACT_NAMES, "subprocessors"] as const;

export type ScalarFactName = (typeof SCALAR_FACT_NAMES)[number];
export type FactName = (typeof FACT_NAMES)[number];

export type OperatorFacts = { readonly [name in ScalarFactName]: Fact | null } & { readonly subprocessors: readonly Subprocessor[] | null };

export type GapReason = "MISSING" | "REQUIRES_REVIEW" | "INVALID";

export interface Gap {
  readonly fact: FactName;
  readonly reason: GapReason;
}

const SUBPROCESSOR_MEMBERS = ["name", "purpose", "location", "transferBasis"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFact(name: string, raw: unknown): Fact | null {
  if (raw === null) return null;
  if (!isRecord(raw)) throw new TypeError(`operator fact ${name} is null or an object with a value and a source`);
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== "source" || keys[1] !== "value") throw new TypeError(`operator fact ${name} has exactly a value and a source`);
  const value = raw["value"];
  const source = raw["source"];
  if (typeof value !== "string") throw new TypeError(`operator fact ${name} has a text value`);
  if (typeof source !== "string" || source.trim().length === 0) throw new TypeError(`operator fact ${name} names where it came from`);
  return { value, source };
}

function parseSubprocessors(raw: unknown): readonly Subprocessor[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw)) throw new TypeError("operator fact subprocessors is null or a list");
  return raw.map((entry: unknown, index: number): Subprocessor => {
    if (!isRecord(entry)) throw new TypeError(`operator fact subprocessors[${index}] is an object`);
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== [...SUBPROCESSOR_MEMBERS].sort().join(",")) throw new TypeError(`operator fact subprocessors[${index}] has exactly ${SUBPROCESSOR_MEMBERS.join(", ")}`);
    const at = (member: (typeof SUBPROCESSOR_MEMBERS)[number]): Fact | null => parseFact(`subprocessors[${index}].${member}`, entry[member]);
    return { name: at("name"), purpose: at("purpose"), location: at("location"), transferBasis: at("transferBasis") };
  });
}

/** The strict reading of the facts file: every fact present (null or a cited value), nothing else, and nothing guessed. */
export function parseOperatorFacts(raw: unknown): OperatorFacts {
  if (!isRecord(raw)) throw new TypeError("the operator facts are an object");
  const known: ReadonlySet<string> = new Set(FACT_NAMES);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new TypeError(`the operator facts name an unknown fact: ${key}`);
  for (const name of FACT_NAMES) if (!Object.hasOwn(raw, name)) throw new TypeError(`the operator facts leave out ${name}: record it as null until it is known`);
  const scalar = (name: ScalarFactName): Fact | null => parseFact(name, raw[name]);
  return {
    legalName: scalar("legalName"),
    entityType: scalar("entityType"),
    taxId: scalar("taxId"),
    registeredAddress: scalar("registeredAddress"),
    postalContact: scalar("postalContact"),
    legalEmail: scalar("legalEmail"),
    governingLaw: scalar("governingLaw"),
    forum: scalar("forum"),
    liability: scalar("liability"),
    effectiveDate: scalar("effectiveDate"),
    subprocessors: parseSubprocessors(raw["subprocessors"]),
  };
}

// a control character is never part of a published fact: it could split a line of the text or a header
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when the text is a real calendar date written yyyy-mm-dd. */
export function isCalendarDate(text: string): boolean {
  const match = DATE.exec(text);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function reasonOf(fact: Fact | null, name?: FactName): GapReason | null {
  if (fact === null || fact.value.trim().length === 0) return "MISSING";
  if (fact.value === REQUIRES_REVIEW) return "REQUIRES_REVIEW";
  if (CONTROL.test(fact.value)) return "INVALID";
  if (name === "effectiveDate" && !isCalendarDate(fact.value)) return "INVALID";
  return null;
}

/** Every reason a document cannot be published, one entry per fact, in the order of FACT_NAMES. Empty exactly when the set is complete. */
export function gapsOf(facts: OperatorFacts): readonly Gap[] {
  const gaps: Gap[] = [];
  for (const name of SCALAR_FACT_NAMES) {
    const reason = reasonOf(facts[name], name);
    if (reason !== null) gaps.push({ fact: name, reason });
  }
  const list = facts.subprocessors;
  if (list === null || list.length === 0) gaps.push({ fact: "subprocessors", reason: "MISSING" });
  else {
    const reasons = list.flatMap((entry) => SUBPROCESSOR_MEMBERS.map((member) => reasonOf(entry[member])));
    const first = reasons.find((reason): reason is GapReason => reason !== null);
    if (first !== undefined) gaps.push({ fact: "subprocessors", reason: reasons.includes("REQUIRES_REVIEW") ? "REQUIRES_REVIEW" : first });
  }
  return gaps;
}

/** A published fact's text. Only called once gapsOf is empty; a missing fact here is a programming error, not a page. */
export function textOf(fact: Fact | null): string {
  if (fact === null) throw new Error("a legal document was rendered with a fact that is not recorded");
  return fact.value;
}
