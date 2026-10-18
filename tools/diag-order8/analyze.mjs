// Reads a diag JSONL file: for each retryDue, the passes that followed it; classifies each watched RETRYABLE row a pass left unclaimed.
import { readFileSync } from "node:fs";
const lines = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let retryDue = null;
let before = [];
const out = { retryDues: 0, missedPasses: 0, provenClockMiss: 0, heldPasses: 0, minMarginMs: Infinity, claimedMargins: [], claimedNotDelivered: [], maxMarginMs: -Infinity, misses: [] };
for (const l of lines) {
  // the rows the retryDue UPDATE returned are the state the next pass starts from (nothing runs between them and the claim)
  if (l.kind === "retryDue") { retryDue = l; before = l.rows.map((r) => ({ ...r, state: "RETRYABLE" })); out.retryDues++; continue; }
  if (l.kind !== "pass" || retryDue === null) continue;
  if (l.held) out.heldPasses++;
  const rowsBefore = l.rowsBefore ?? before;
  before = l.rowsAfter ?? [];
  for (const r of rowsBefore) {
    if (r.state !== "RETRYABLE") continue;
    const dueMs = Number(BigInt(r.next_us)) / 1000;
    const after = (l.rowsAfter ?? []).find((x) => x.outbox_id === r.outbox_id);
    const claimed = after && after.attempts > r.attempts;
    const delivered = claimed && after.state === "DELIVERED";
    // the claim clock is a Date.now() read between tBefore and tAfter: margin bounds (claim clock - due) from above by tAfter - due
    const marginUpperMs = l.tAfterMs - dueMs;
    if (claimed && !delivered) out.claimedNotDelivered.push({ pid: l.pid, stateAfter: after.state, attempts: after.attempts });
    if (delivered) {
      // the claim wrote next_attempt_at = claim clock + 120 s (OUTBOX_CLAIM_SECONDS) and delivered() leaves it: the exact claim clock
      const claimMs = Number(BigInt(after.next_us)) / 1000 - 120_000;
      const margin = claimMs - dueMs;
      out.claimedMargins.push(Number(margin.toFixed(3)));
      out.minMarginMs = Math.min(out.minMarginMs, margin); out.maxMarginMs = Math.max(out.maxMarginMs, margin);
    }
    else {
      out.missedPasses++;
      if (marginUpperMs < 0) out.provenClockMiss++;
      out.misses.push({ pid: l.pid, pass: l.i, held: l.held, dueTxt: r.next_txt, dueMs, tBeforeMs: l.tBeforeMs, tAfterMs: l.tAfterMs, claimClockAtMostMinusDueMs: Number(marginUpperMs.toFixed(3)), stateAfter: after?.state, deliveries: l.deliveries });
    }
  }
}
console.log(JSON.stringify(out, null, 1));
