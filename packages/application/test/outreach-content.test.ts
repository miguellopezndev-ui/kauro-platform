// The outreach content checks (package B12, lane L-DRAFT; plan docs/design/B12-outreach-plan.md §0 A13 and §9 TD-DRAFT, companion
// B12-outreach-plan-cells.md §T): a pure judgment PutOutreachContent runs before any write (422 CONTENT_REFUSED). Subject <= 200 chars,
// no CR/LF/NUL/control, NFC; body <= 20,000 chars, NFC; an amount within 8 words of save/savings; "guarantee"; AI in the subject; more than
// one AI sentence in the body. Written FIRST against the K1 stub (notBuilt): every title fails until the lane builds content-checks.ts with
// this signature. Each refusal is a single-rule change of one safe base, so a rule that is missing or too wide fails its own title.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contentChecks as stub } from "../src/commercial/outreach/content-checks.js";

/** The rule ids the lane's contentChecks reports (declared here; the builder exports exactly these). */
type ContentRule = "SUBJECT_LENGTH" | "SUBJECT_CONTROL" | "NOT_NFC" | "BODY_LENGTH" | "SAVINGS_AMOUNT" | "GUARANTEE" | "AI_IN_SUBJECT" | "AI_SENTENCES";
interface ContentVerdict {
  /** The rules the content breaks, in the order above; empty when admitted. */
  readonly refused: ReadonlyArray<ContentRule>;
}
const contentChecks = stub as unknown as (content: { readonly subject: string; readonly body: string }) => ContentVerdict;

const SUBJECT = "Migration review for your team";
const BODY = "Hello,\n\nI help agencies plan data migrations with a reviewed, reversible process.\n\nWould a short call next week be useful?\n";
const refusedOf = (subject: string, body: string): ReadonlyArray<ContentRule> => contentChecks({ subject, body }).refused;

test("outreach content: the safe base and the boundary values are admitted (subject 200 chars, body 20,000 chars, an amount 12 words from savings, one AI sentence)", () => {
  assert.deepEqual(refusedOf(SUBJECT, BODY), [], "the safe base");
  assert.deepEqual(refusedOf("s".repeat(200), BODY), [], "a 200-char subject");
  assert.deepEqual(refusedOf(SUBJECT, "b".repeat(20_000)), [], "a 20,000-char body");
  assert.deepEqual(refusedOf(SUBJECT, "We reviewed $40,000 of records last month for one agency and then later talked about savings.\n"), [], "an amount 12 words from savings");
  assert.deepEqual(refusedOf(SUBJECT, `${BODY}We use AI to check field mappings before a person reviews them.\n`), [], "one AI sentence in the body");
  assert.deepEqual(refusedOf("Café owners: a migration review", BODY), [], "an NFC subject with a precomposed letter");
});

test("outreach content: each single rule is refused alone (SUBJECT_LENGTH 201, SUBJECT_CONTROL CR/LF/NUL/TAB, NOT_NFC, BODY_LENGTH 20,001, SAVINGS_AMOUNT within 8 words, GUARANTEE, AI_IN_SUBJECT, AI_SENTENCES 2)", () => {
  const one: ReadonlyArray<readonly [string, string, string, ContentRule]> = [
    ["a 201-char subject", "s".repeat(201), BODY, "SUBJECT_LENGTH"],
    ["CR/LF in the subject", "Migration review\r\nBcc: x@example.com", BODY, "SUBJECT_CONTROL"],
    ["LF in the subject", "Migration review\nfor you", BODY, "SUBJECT_CONTROL"],
    ["NUL in the subject", "Migration\u0000review", BODY, "SUBJECT_CONTROL"],
    ["TAB in the subject", "Migration\treview", BODY, "SUBJECT_CONTROL"],
    ["a decomposed (NFD) subject", "Café owners: a migration review", BODY, "NOT_NFC"],
    ["a decomposed (NFD) body", SUBJECT, "Hello,\n\nCafé owners plan migrations with us.\n", "NOT_NFC"],
    ["a 20,001-char body", SUBJECT, "b".repeat(20_001), "BODY_LENGTH"],
    ["an amount 2 words before save", SUBJECT, "Hello,\n\nWe can save you $40,000 on your next migration.\n", "SAVINGS_AMOUNT"],
    ["an amount 8 words after savings", SUBJECT, "Hello,\n\nThe savings for one agency last year were around 40%.\n", "SAVINGS_AMOUNT"],
    ["guarantee", SUBJECT, "Hello,\n\nWe guarantee a clean migration.\n", "GUARANTEE"],
    ["AI in the subject", "AI-written migration plan for you", BODY, "AI_IN_SUBJECT"],
    ["two AI sentences", SUBJECT, "Hello,\n\nOur AI maps your fields. Then AI checks every record.\n", "AI_SENTENCES"],
  ];
  for (const [what, subject, body, rule] of one) assert.deepEqual(refusedOf(subject, body), [rule], what);
});

test("outreach content: several broken rules are all reported, in rule order", () => {
  assert.deepEqual(
    refusedOf("AI savings\r\n", "We guarantee you save $10,000. Our AI does it. The AI checks it.\n"),
    ["SUBJECT_CONTROL", "SAVINGS_AMOUNT", "GUARANTEE", "AI_IN_SUBJECT", "AI_SENTENCES"],
  );
});
