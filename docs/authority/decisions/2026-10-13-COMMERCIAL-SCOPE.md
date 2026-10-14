# Decision D-33: commercial scope (2026-10-13)

Status: owner decision, 2026-10-13. In force from that date, prospectively. It supersedes only the clauses listed in section 4;
every other approved decision stays in force, including D-30 (no consumers buying for personal use in V1).

Naming: "D-33" is this owner decision. It is distinct from the R2 design decision D33 (the 90-day accepted attribution claim),
which stays in force unchanged.

## 1. Who Kauro may sell to

1.1. Kauro may research, identify, contact, prospect and sell directly to **agencies** and to **companies** that need to clean,
prepare or migrate their own data. No intermediary is required.

1.2. A company may reach Kauro in any lawful way: on its own, by referral, by search, through a campaign, or because Kauro or a
seller contacted it. How a company arrives does not change its admission or its eligibility for quotes, discounts, founding slots,
payments, deliverables, support or data protection. It matters only as attribution evidence (section 3).

1.3. **No consumers in V1 (D-30).** Kauro does not sell to individuals buying for personal, family or household use in V1. The
buyer declares that it buys for its economic activity. This does not waive any right that the law grants a buyer and that cannot
be waived; where the law treats a buyer as a consumer, the consumer terms apply.

## 2. Admission

2.1. A buyer is admitted when, and only when, it meets:
- the real requirements of the service: a supported source and target envelope, a real person responsible for the import, a
  plausible project date (16 §Offer and buyer fit), and the data-category exclusions and prohibited-data notice (19 §Data
  categories and excluded use);
- the law that applies to the buyer, the data and the contact;
- authority over the data: the buyer is the controller of the data, or holds the controller's authorization (processing-authority
  reference); and
- a payment means that is actually enabled for that buyer.

2.2. There is no other restriction by company size, sector or nationality. A company buyer uses the existing `Agency` tenant
contract, with its company as its end-client workspace; the contract name gives it no lesser treatment.

2.3. The buyer type (`agency` or `in-house`) stays recorded for measurement and for the processing chain. It does not change price,
discounts or admission checks.

## 3. Attribution

3.1. A company opportunity that a seller actively sourced may be attributed to that seller when it meets the attribution rules in
force (17 §Attribution subject, §Claim validity and conflicts; R2 D32 and D33). An inbound buyer produces seller compensation only
through an explicit compensation assignment made before the seller performs the agreed closing work (A3 §7.1, unchanged).

## 4. Protections (kept, binding)

4.1. Kauro never uses data from a customer's CRM files to prospect, qualify or contact anyone.

4.2. Kauro never uses information received from a partner agency to capture that agency's end clients. Kauro does not contact an
agency's end client to sell around the agency, and end-client names and data never leave the agency relationship (A3 §3.7, kept).

4.3. Contact is lawful only: organization data or channels that meet the recorded facts of the Data Processing Policy §6.3.1, or a
person's prior authorization; consent and opt-out rules per channel; no indiscriminate extraction of personal data from websites,
directories or social networks; no campaign against legal contact rules.

4.4. Kauro never promises capabilities, prices or results it cannot deliver. The claim rules of A3 §3.1–§3.6 and §5 stay in force.

## 5. Superseded clauses

Line numbers refer to `docs/COMMERCIAL_AMENDMENT_A3.md` at commit ba93a62 (the same lines in the authority copy
`amendments/A3_COMMERCIAL.md`). Each place is marked in the current text of A3; the original wording stays in git history.

| A3 clause | Lines | What is superseded |
|---|---|---|
| §3.7 opening | 180–181 | "when it arrives on its own" as a condition of admission |
| §3.7 first bullet | 182–184 | the ban on prospecting non-agency companies and on recording them as prospects or attribution claims |
| §3.7 second bullet | 185–187 | the rule of a single in-house sentence, once, on the Pricing page |
| §3.7 reading rule | 217–218 | "where R2 names agencies as the outreach, research, content or channel segment, the text stays agency-only" |
| §4.1 (01 §Purpose) | 234 | "Agencies remain the only segment Kauro prospects." |
| §4.2 (02 §Buyer, user and job) | 243–248 | the inbound-only condition, "Kauro does not prospect in-house teams…", and the exclusion from the outreach or channel segment |
| §4.3 (11 §Public route map) | 278–279 | the Pricing page's single in-house sentence |
| §4.5 (16 channel-conflict rule) | 321–324 | in-house admission only "when they arrive on their own", "nobody … prospects them", and the need for a further decision on outbound sales to non-agency companies (this decision is that decision) |
| §4.6 (18 §Prospect qualification) | 343–344 | "Prospects are agencies…" and "…only when it arrives on its own (D58)" |
| §4.8–§4.9 (D58) | 414–441 | in part: the inbound-only admission of in-house teams and the agency-only prospecting limit |
| §6 direct-sales row | 487 | in part: direct sales to companies are no longer deferred; Colombian/Spanish localization stays deferred |
| §7.1 second bullet | 500–501 | "Non-agency companies may not be prospected, so no seller attribution claim can arise from prospecting an in-house team." |
| §7.3 second trigger | 524–525 | "…which can stop new in-house admissions prospectively" |

The R2 manual text that A3 §4 amends (01, 02, 16, 18, 28) is read as further amended by this record. Texts derived from the
superseded clauses (the Data Processing Policy §6.3 and §17, the Internal Data Manual, Terms §1.2, the B10 and B11 design
records) are updated to match; the legal-text changes are pending competent review (D-30/D-31) and are listed in
`docs/legal/CHECKLIST.md` and `docs/legal/LAWYER_LATER.md`.

## 6. Unchanged

The product (CLEAN independent; HubSpot and Salesforce preparation when enabled and qualified), the price schedule, repeat and
founding discounts and their slots, non-stacking and quote rules, seller compensation (R2 D32, D33), the buyer-type field and its
values, the processing chains of the DPA, and every customer right.
