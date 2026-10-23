/**
 * The observation INTELLIGENCE-CONSUMER-01 prints, read back by the architecture gate.
 *
 * tools/consumer-check.mjs ends with one line:
 *
 *   INTELLIGENCE-CONSUMER-01 = PASS: {observation} validity {validity} problems
 *
 * The gate used to take `/\{.*\}/` of the output, which on that line runs from the observation's first brace to the
 * validity record's last one, is not JSON, and so left `consumer_report_bound` false on every run, passing or not
 * (BLK-MC, found by the first core gate run on Migration Core 3.1.0). This reads the first JSON object after the verdict,
 * by its own braces and strings, and nothing else.
 */
export const CONSUMER_VERDICT = /^INTELLIGENCE-CONSUMER-01 = (PASS|FALSE): /u;

/** The end index (exclusive) of the JSON object that starts at text[start] === '{', or -1. */
function objectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** @returns {Record<string, unknown> | null} the observation, or null when the output holds no verdict line or no object after it */
export function consumerObservation(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/u).find((candidate) => CONSUMER_VERDICT.test(candidate));
  if (line === undefined) return null;
  const body = line.replace(CONSUMER_VERDICT, '');
  if (!body.startsWith('{')) return null;
  const end = objectEnd(body, 0);
  if (end === -1) return null;
  try {
    const value = JSON.parse(body.slice(0, end));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
