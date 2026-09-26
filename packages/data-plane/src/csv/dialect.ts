/**
 * Delimiter discovery (04 "CSV parser requirements": "Delimiter discovery evaluates candidate consistency and reports ambiguity
 * rather than selecting the interpretation producing the most columns"). Over a sample of complete records, a candidate is
 * consistent when every non-blank record has the same width and that width is at least two. One consistent candidate is chosen;
 * several are DELIMITER_AMBIGUOUS (the inventory shows the first of comma, semicolon, tab, pipe — a fixed order, never the widest);
 * none is DELIMITER_INCONSISTENT (the candidate whose modal width covers the most records); a file of one column is SINGLE_COLUMN.
 * The agency confirms the dialect in its selection (CsvParserChoice); the inventory only reports.
 *
 * Loaded inside the isolated child.
 */
import { StopParsing } from "../errors.js";
import { CsvTokenizer, type CsvLimits } from "./tokenizer.js";

export type DelimiterName = "COMMA" | "SEMICOLON" | "TAB" | "PIPE";
export const DELIMITERS: ReadonlyArray<readonly [DelimiterName, string]> = [
  ["COMMA", ","],
  ["SEMICOLON", ";"],
  ["TAB", "\t"],
  ["PIPE", "|"],
];

export function delimiterChar(name: DelimiterName): string {
  return (DELIMITERS.find(([n]) => n === name) as readonly [DelimiterName, string])[1];
}

export interface DialectDecision {
  readonly delimiter: DelimiterName;
  readonly issues: ReadonlyArray<string>;
}

const SAMPLE_RECORDS = 200;

interface Census {
  readonly name: DelimiterName;
  readonly widths: number[];
}

function census(name: DelimiterName, char: string, sample: string, complete: boolean, limits: CsvLimits): Census {
  const widths: number[] = [];
  const tokenizer = new CsvTokenizer({ delimiter: char, quote: '"' }, limits, (fields, facts) => {
    if (!facts.blank) widths.push(fields.length);
    return widths.length < SAMPLE_RECORDS;
  });
  try {
    tokenizer.push(sample);
    if (complete) tokenizer.end();
  } catch (error) {
    if (!(error instanceof StopParsing)) {
      // a sample this candidate cannot tokenize (an unclosed quote at the sample's end) still counts what it read
    }
  }
  return { name, widths };
}

/** Decides the delimiter from a sample of decoded text; `complete` says whether the sample is the whole file. */
export function discoverDialect(sample: string, complete: boolean, limits: CsvLimits): DialectDecision {
  const results = DELIMITERS.map(([name, char]) => census(name, char, sample, complete, limits));
  const consistent = results.filter((r) => r.widths.length > 0 && (r.widths[0] as number) >= 2 && r.widths.every((w) => w === r.widths[0]));
  if (consistent.length === 1) return { delimiter: (consistent[0] as Census).name, issues: [] };
  if (consistent.length > 1) return { delimiter: (consistent[0] as Census).name, issues: ["DELIMITER_AMBIGUOUS"] };
  let best: { name: DelimiterName; share: number } | undefined;
  for (const r of results) {
    if (r.widths.length === 0) continue;
    const counts = new Map<number, number>();
    for (const w of r.widths) counts.set(w, (counts.get(w) ?? 0) + 1);
    let modal = 0;
    let modalCount = 0;
    for (const [w, c] of counts) {
      if (c > modalCount || (c === modalCount && w > modal)) {
        modal = w;
        modalCount = c;
      }
    }
    if (modal < 2) continue;
    const share = modalCount / r.widths.length;
    if (best === undefined || share > best.share) best = { name: r.name, share };
  }
  if (best === undefined) return { delimiter: "COMMA", issues: ["SINGLE_COLUMN"] };
  return { delimiter: best.name, issues: ["DELIMITER_INCONSISTENT"] };
}
