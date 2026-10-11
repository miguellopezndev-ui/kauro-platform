# Real ACH test plan (deliverable 9b, Payments V1) — draft 2026-10-07

Goal: confirm the V1 rail end to end (Payments V1 §2 a-f): one real ACH collection from a US payer into the Wise Business
USD details of KAURO DATA S.A.S., its reconciliation in Kauro, and a controlled refund of that same payment with evidence.

## Preconditions (all real, none assumed)
1. KAURO DATA S.A.S. registered (NIT/RUT) — D-14.
2. Wise Business approved in the company's name; USD details visible in the account; the account shows ACH receiving.
3. Kauro running in an environment with the ACH route configured and not ENABLED for customers.
4. The accountant's answers on how to record the collection and the refund (foreign exchange and DIAN) — at least for this
   test (`ACCOUNTANT-QUESTIONS-2026-10-07.md`, question 15).

## Payer (D-25)
- One **person or company in the US with a US bank account** that sends an ACH (not card, not person-to-person Zelle, not
  PayPal) to the Wise USD details and agrees in writing to receive the refund.
- The test collection is a **real low-value invoice the owner specifically authorises**, carrying the **reference Kauro
  generates**. Paying from an owner-held US account is not allowed (R2 15 forbids self-payment).
- Owner D-25 (2026-10-07): a possible US payer exists; the owner confirms once the company is registered.

## Amount
- Recommended: **USD 25** (the refund looks like a normal transaction; low test cost). One Kauro invoice for USD 25 with a
  unique reference.

## Steps
1. Kauro issues the test invoice (USD 25) with the USD details and a unique reference; the order is recorded in Kauro.
2. The payer sends the ACH with the reference. Send date/time is recorded.
3. Arrival at Wise (official Wise help: "ACH: Usually within hours, and up to 4 working days"). The receipt/statement is
   downloaded.
4. Reconciliation in Kauro (owner-role manual entry with the receipt): the order becomes paid **only** on exact amount and
   currency; evidence stored; revenue/cash and seller commission (if any) recorded.
5. Controlled refund of that same payment: owner authorisation in Kauro; the refund is recorded (idempotent) **before**
   execution; the owner sends the refund from Wise to the payer (USD 25, or the amount the accountant indicates if there are
   costs); the Wise send receipt is stored; Kauro records the refund as sent **only** with that receipt; revenue/cash,
   commission and fiscal evidence are adjusted (credit note if the accountant says so).
6. Negative checks in the same window (no extra money): recording the refund again with the same key creates no second
   refund; a refund in an uncertain state never offers "resend" (NEVER-RESEND, any rail).
7. Final evidence: package with invoice, Wise incoming and outgoing receipts, Kauro records (order, reconciliation, refund,
   ledger entries) and the reconciliation result with zero differences.

## Success criterion (owner adjustment 2026-10-07, binding)
- One test payment serves for both the collection and the refund.
- Collection is ENABLED when: (a) that payment's ACH is received and reconciled in Kauro, and (b) the refund of that same
  payment is SENT from Wise and recorded in Kauro with the Wise send receipt. Arrival in the payer's account is not awaited;
  a later return follows the normal return flow (never a resend while uncertain).
- Zero reconciliation differences; exactly one collection and one refund recorded; evidence archived. Only then may the ACH
  route move to ENABLED and Kauro state publicly that it accepts ACH.
- D-26 (owner, decided in advance): no production without collection enabled; if Wise USD details are not live on
  2026-10-12 20:00 Bogota, the production date moves.

## Expected cost
Incoming ACH: no Wise fee (official help, see `WISE-FEES-2026-10-07.md`). Outgoing refund: whatever the Wise account shows
when it is executed (recorded). No spend without a line in `.kauro/grants.md`.
