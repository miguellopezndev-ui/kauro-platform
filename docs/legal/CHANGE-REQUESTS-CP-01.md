# Legal change requests for CP-01 (Order 16, 2026-10-22)

The legal side of `docs/authority/proposals/CP-01-FUNCTIONAL-GOVERNANCE.md` (component C2 of
`docs/design/FUNCTIONAL-CHANGE-INVENTORY.md`). These are **proposals for competent review** (D-08b, D-31; LAWYER_LATER L-20). None
is applied to the texts, none is in force, and none may be published until every condition in its "Blocked until" line holds. The
minimal alignments that needed no new obligation and narrowed no promise were applied to the draft Terms and are listed in CHECKLIST
§11.

Common rule for entry into force: a request enters a text only (1) after competent review, (2) in the same versioned re-issue as the
implementation that makes it true, tested, and (3) with the published templates (`apps/web/src/legal/templates.ts`, through
`docs/design/LEGAL-CORRECTION-REQUESTS.md`) and the public words (`apps/web/src/public/retention.ts`, Help) changed in the same step.
A text never promises what the product does not yet do.

No company data (NIT, address, phone, effective date) is filled in here: they stay owner fill-ins F-01 to F-05.

## LR-01. The free check's extension, to 17 days from sealing (F-19, F-20; CP-01.02)

- **Today.** ToS §13.1, Free data health check row: "7 days after the result is ready or after terminal failure | 14 days from
  sealing". ToS §13.2: "it never exceeds the maximum limits". DPA Annex IV: "one soft extension of up to 72 hours that never exceeds
  the maximums".
- **Proposed.** §13.1 row, maximum: "14 days from sealing; up to 17 days from sealing only through the extension in section 13.2".
  §13.2, after "it never exceeds the maximum limits": ", except that the extension of a Free data health check may keep its data up
  to seventeen (17) days from sealing. There is one extension per project, whichever period it is used for." DPA Annex IV: the same
  two sentences.
- **Why.** Owner decision 2026-10-21. The extension already applies to any soft period (§13.2 is not limited to paid projects); only
  the ceiling is new.
- **Blocked until.** CP-01.02 adopted; the backend writes the UNPAID soft deadline and accepts the extension (with Order 15 for the row
  policies); competent review.

## LR-02. The pending-payment hold, and five dates named alike (F-21, F-22, F-24; CP-01.11)

- **Today.** ToS §6.2 (price validity and data availability shown separately), §8.2 (paid only on a reconciled credit), §10.5,
  §13.1 (no hold class). DPA Annex IV (no hold).
- **Proposed (revision 2, owner parameters of 2026-10-22).** A new §13.2A "Hold while a transfer is confirmed": "When an authorised
  user, after additional verification of their identity, gives proof that an ACH bank transfer for the exact amount of an Order, with
  its reference, has already been sent, Kauro keeps the data of that Quote until the earlier of five (5) United States banking days
  after it accepts the proof and twenty-four (24) days from sealing. The Platform shows the actual end date. There is one hold per
  Quote and per sealed set of Files; it is not renewed and is not added to an extension: the data stays until the later of the two
  dates, never their sum, and never past twenty-four (24) days from sealing. A declared transfer or a proof is not payment, does not
  start any work and creates no commercial authorisation (section 8.2). If the credit is not reconciled before the hold ends, the data
  is deleted; a later credit is reviewed and returned under section 10 and does not restore the data." The §13.1 table gains the row.
  "United States banking days" are those of the Federal Reserve's FedACH calendar (sources in CP-01 §3.10); another payment route is
  not described by this paragraph.
  §6.2, §8 and §13 name the five dates with the same words: "the Quote's price validity", "the free check's retention", "the
  extension", "the hold while a transfer is confirmed", "the paid project's retention". DPA Annex IV: the row and its purpose
  (completing a purchase the Customer has already paid for).
- **Blocked until.** Wise Business enabled, the PV1 qualification and the evidence the route really gives; implementation, abuse
  controls and tests; competent review, including §25 if consumer rules ever applied (D-30 keeps consumers out of V1). The owner's
  values were decided on 2026-10-22 (CP-01.11).

## LR-03. Proven identity is a technical class, not a guarantee (F-25; CP-01.12)

- **Today.** ToS §3.7: "A duplicate candidate is not a confirmed merge; Kauro merges duplicates only with the Customer's approval".
- **Proposed (revision 2, after the owner's security modification of 2026-10-22).** Add: "Records are combined without a separate
  decision only when they share an identifier that proves they are one record: the same source record identifier within one identity
  space, or an external identifier the Customer declared authoritative and that was verified. The same email address and the same name
  are a strong sign of a possible duplicate, not proof: those candidates are decided by a person, with a preview, in groups of at most
  one hundred (100). Kauro writes to no CRM." Revision 1's example (same email and same name as "demonstrated") is withdrawn.
- **Blocked until.** CP-01.12 adopted with the core intervention that implements it; competent review.

## LR-04. Salesforce record IDs and import error messages (F-28, F-29)

- **Today.** DPA Annex I.4 already lists "CRM record identifiers"; Annex I.2 item 7 already covers "Verification of import receipts
  supplied by the Customer". The processing is therefore described.
- **Proposed (clarity only).** Annex I.4: "CRM record identifiers, including those a target CRM returns in import result files, and
  the error messages of those files, which may quote record values".
- **Blocked until.** The reconciliation is built (after the tool checks of F-28 to F-30); competent review.

## LR-05. Publishing the Personal Data Processing Policy and recording the authorization (F-08; CP-01.10)

- **Today.** POL §8.1 requires the checkbox and the proof; no page publishes the Policy; the contact form lacks the checkbox (F-08,
  register X-38).
- **Proposed.** Publish POL at the route of UI56 with its version label (same versioning as `templates.ts`); the registration and the
  contact form record user, document version, date and time; marketing consent stays separate (POL §8.3; CHECKLIST A-14).
- **Blocked until.** Operator facts (A-08); competent review; verification that the Policy reflects the processing actually carried
  out; CP-02 consent fields keeping essential obligations apart from optional commercial authorisations. The owner approved the screen
  and the versioned publication mechanism on 2026-10-22 (CP-01.10); no incomplete, false or unreviewed policy is published.

## LR-06. Who tells the customer a refund decision, and when (F-33)

- **Today.** ToS §10.2: Kauro "explains its decision in writing"; no sender, channel or time. The approval event
  (`refund.approved.v1`) does not reach the notifications consumer (`packages/domain/src/commerce/events.ts:336`).
- **Recommended (owner decision).** Kauro (the owner role) sends the decision, approved or refused, through the Platform and by email
  within two (2) business days of the decision; the refund record keeps the message's due time and send state; an approval never
  counts as the message. Proposed ToS §10.2 addition: "Kauro sends its written decision within two (2) business days of making it."
- **Blocked until.** Owner decision; competent review of the wording.

## LR-07. Colombian customers and pesos (register: "contracts allow USD only, while the Terms say Colombian customers pay in COP")

- **Today.** ToS §7.4 says Colombian customers pay in pesos "by the route Kauro indicates in its Quote"; policy `money.currency` is USD
  only; A3 §6 defers the domestic payment and tax route; D-33 §2.1 admits a buyer only with "a payment means that is actually enabled
  for that buyer".
- **Reading.** No contradiction in operation: until a domestic route exists, a Colombian buyer has no enabled payment means and is not
  admitted. The wording still describes a route V1 does not have.
- **Blocked.** Whether a Colombian resident may be invoiced and paid in USD, and how, is an exchange-regime and tax question for the
  accountant (Payments V1 §7(c)) and counsel. No wording is proposed before their answer.

## LR-08. Paid enrichment (register X-35): no change

ToS §3.5 says Kauro does no paid enrichment; A3 §3.5(2) says HubSpot's own marketing-contact status and paid enrichment stay off in
the prepared import unless the agency enables a supported setting. One speaks of Kauro's work, the other of a setting in the
customer's CRM import. They do not conflict. Counsel may confirm; no wording is proposed.

## LR-09. Bank details in a downloadable file (register, round 3 open conflict)

ToS §8.4 says Kauro communicates its bank details only within the Platform or from its verified domain, and asks the Customer to
confirm any change on the Platform. A downloadable file is forwarded and edited outside both. Recommendation: payment documents carry
the amount, the reference and the order, and say "Bank details: on the Platform"; no change to the Terms.

## LR-10. Exception rows with personal data in documents for an agency's client (register, round 3 open conflict)

The package's files are Customer Data the agency already holds and forwards under its own contract with its End Client (DPA §1.2).
Recommendation: summary documents meant to be forwarded carry counts and categories only, never rows; the rows stay in the package
files. No change to the texts.

## LR-11. The free-check pause: 90% of the funded envelope or "exhausted" (register X-34, Q-4; CP-01.03)

- **Today.** ToS §3.3: "a pause on new free reviews when the available budget is exhausted", while the comment under it cites A3 §3.2,
  which says the pause is "at 90% of the funded envelope (14 §Cost controls)". The register records X-34 as open for the owner and
  counsel.
- **Proposed.** "a pause on new free reviews once ninety percent (90%) of the budget funded for free reviews is used". It follows the
  authority (A3, manual 14) and CP-01.03, but it lets Kauro pause earlier than the current draft says, so it narrows what the Customer
  is told and is not applied as an alignment.
- **Blocked until.** Counsel reviews the wording through the Terms' amendment procedure. The owner approved the 90% internal threshold
  on 2026-10-22 (CP-01.03) and required that the public Terms are not changed automatically by it.

