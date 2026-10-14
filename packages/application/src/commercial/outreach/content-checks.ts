/**
 * The outreach content checks (package B12, lane L-DRAFT; plan §0 A13, companion §T): a pure judgment PutOutreachContent runs before any
 * write. A refusal is 422 CONTENT_REFUSED. Rules are reported in this order, every broken rule once:
 * SUBJECT_LENGTH (> 200 chars), SUBJECT_CONTROL (CR, LF, NUL or any other control character in the subject), NOT_NFC (subject or body),
 * BODY_LENGTH (> 20,000 chars), SAVINGS_AMOUNT (an amount within 8 words of save/savings in the body), GUARANTEE, AI_IN_SUBJECT,
 * AI_SENTENCES (more than one body sentence naming AI).
 */
export type ContentRule = "SUBJECT_LENGTH" | "SUBJECT_CONTROL" | "NOT_NFC" | "BODY_LENGTH" | "SAVINGS_AMOUNT" | "GUARANTEE" | "AI_IN_SUBJECT" | "AI_SENTENCES";

export interface OutreachContent {
  readonly subject: string;
  readonly body: string;
}

export interface ContentVerdict {
  readonly refused: ReadonlyArray<ContentRule>;
}

export const SUBJECT_MAX_CHARS = 200;
export const BODY_MAX_CHARS = 20_000;
/** An amount counts as a savings claim when it is at most this many words from save/savings. */
export const SAVINGS_WORD_DISTANCE = 8;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const AI_WORD = /\bAI\b/u;
const SAVE_WORD = /^(?:save|saves|saved|saving|savings)$/iu;
const AMOUNT = /^(?:[$€£]\s*\d[\d,.]*|\d[\d,.]*\s*%|\d[\d,.]*(?:usd|eur|cop|dollars))$/iu;

const bareWord = (w: string): string => w.replace(/^[^\p{L}\p{N}$€£]+|[^\p{L}\p{N}%]+$/gu, "");

function savingsAmount(body: string): boolean {
  const words = body.split(/\s+/u).filter((w) => w !== "").map(bareWord);
  const saves: number[] = [];
  const amounts: number[] = [];
  words.forEach((w, i) => {
    if (SAVE_WORD.test(w)) saves.push(i);
    else if (AMOUNT.test(w)) amounts.push(i);
  });
  return saves.some((s) => amounts.some((a) => Math.abs(a - s) <= SAVINGS_WORD_DISTANCE));
}

function aiSentences(body: string): number {
  return body.split(/[.!?\n]+/u).filter((s) => AI_WORD.test(s)).length;
}

/** The rules the content breaks, in rule order; empty when admitted. */
export function contentChecks(content: OutreachContent): ContentVerdict {
  const { subject, body } = content;
  const refused: ContentRule[] = [];
  if ([...subject].length > SUBJECT_MAX_CHARS) refused.push("SUBJECT_LENGTH");
  if (CONTROL.test(subject)) refused.push("SUBJECT_CONTROL");
  if (subject.normalize("NFC") !== subject || body.normalize("NFC") !== body) refused.push("NOT_NFC");
  if ([...body].length > BODY_MAX_CHARS) refused.push("BODY_LENGTH");
  if (savingsAmount(body)) refused.push("SAVINGS_AMOUNT");
  if (/guarantee/iu.test(subject) || /guarantee/iu.test(body)) refused.push("GUARANTEE");
  if (AI_WORD.test(subject)) refused.push("AI_IN_SUBJECT");
  if (aiSentences(body) > 1) refused.push("AI_SENTENCES");
  return { refused };
}
