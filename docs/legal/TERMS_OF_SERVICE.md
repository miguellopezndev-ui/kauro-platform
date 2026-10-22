<!--
D-08b · Terms of Service (agency/customer <-> Kauro). English master (owner rule 2026-10-07: customers are US companies; no Spanish text by default). Draft written by the builder without a lawyer (owner decision D-08b, option 1, 2026-10-05). Legal sources: CHECKLIST.md. Uncertainties: LAWYER_LATER.md.
Traceability convention: each statement of fact about Kauro carries an `auth:` comment with the file and heading of authority/r2 (or of the amendment) it comes from. `law:` comments point to the CHECKLIST row.
Only placeholders allowed: [NIT], [registered address], [notice email], [effective date]; plus [phone], added because Decreto 1377 de 2013 art. 13 requires it (see LAWYER_LATER F-05).
-->

# Kauro Terms of Service

**Version:** 1.0 · **Effective from:** [effective date]

These Terms of Service (the "Terms") govern the relationship between **Kauro Data S.A.S.** ("Kauro") and the legal entity that
creates a customer account on Kauro's platform (the "Customer"). Read them in full before accepting them. Together with the
documents listed in section 1.3 they form the contract between the parties.

## 1. Parties, contract documents and order of precedence

1.1. **Kauro.** Kauro Data S.A.S., a simplified stock company (sociedad por acciones simplificada) incorporated in Colombia, NIT [NIT], domiciled at
[registered address], notice email [notice email], phone [phone], website kaurodata.com.
<!-- auth: amendments/A8_PAYMENT_ROUTING.md §1 (Kauro Data S.A.S.); amendments/A4_OPERATING_MODEL.md §Owner acts (domain kaurodata.com); 19 §BusinessProfile and legal facts (real postal address, no fictitious office) -->

1.2. **Customer.** The Customer is (a) an agency that provides CRM, RevOps or data-cleaning services to its own clients
(each, an "End Client"), or (b) a company that works on its own company's data, with or without a dedicated in-house CRM or
data team ("Internal Customer"). Kauro contracts only with the Customer, not with its End Client or with the people who appear
in the files.
<!-- auth: 01_CHARTER.md §Purpose and customer promise (text amended by A3 §4.1); 02 §Buyer, user and job to be done; A3 §3.7 as superseded in part by D-33 (docs/authority/decisions/2026-10-13-COMMERCIAL-SCOPE.md; wording changed 2026-10-13, pending competent review, D-31) -->

1.3. **Contract documents.** The contract consists of: (i) these Terms; (ii) the Data Processing Agreement for Personal Data
("DPA", file DPA.md, the English master); (iii) Kauro's Personal Data Processing Policy; (iv) the list of sub-processors and
transfers published in the DPA; (v) the retention schedule in section 13; (vi) the support and remedies policy in sections 11
and 12; and (vii) each accepted Quote (the "Order").
<!-- auth: 19 §Customer instrument hierarchy -->

1.4. **Precedence.** In case of conflict the following prevails, in this order: the DPA as to personal data processed on the
Customer's behalf; the Order as to mode, units, price, discount, taxes and delivery scope; and these Terms in everything else.
No email, seller message, advertising text or screen extends Kauro's obligations beyond these documents. A negotiated exception
binds only if it appears in a written amendment to the Order accepted by both parties.
<!-- auth: 19 §Customer instrument hierarchy; 19 §Service terms: required operative content ("The order governs mode, counted units...") -->

## 2. Definitions

- **Platform:** Kauro's web application, its API and the packages it produces.
- **Files:** the CRM exports and spreadsheets the Customer uploads.
- **Source Revision:** the sealed set of admitted Files and sheets, with their hashes and read configuration. Any later change
  creates a new Revision.
- **Plan:** the bounded transformation plan the Customer reviews and approves, tied to a Revision, to a Target Contract where the
  mode has one, and to specific decisions.
- **Target Contract:** the current approved description of the target CRM instance (when the mode requires it).
- **Supported Profile:** the import profile accepted for a target (HubSpot importer or Salesforce Data Loader).
- **Package:** the published deliverable (files, report, machine-readable manifest and import instructions).
- **Service Completion:** the moment the first Package of the Order becomes available for download or, for a staged import, the
  moment the final delivery becomes available.
- **Authorized Users:** the people the Customer's administrator invites and to whom it assigns a role.
- **Billable Units:** the occurrences of admitted objects under the sealed projection, before approved deduplication, as
  provided in section 7.
- **Free data health check:** the free, pre-purchase review of the state of the uploaded data (section 3.3).
<!-- auth: 19 §Service terms: required operative content ("define files, source revision, plan, package, target contract, supported profile, service completion and authorized users"); 02 §4 Upload, inspect and seal; 02 §6 Resolve and approve the plan; 16 §Billable unit and fairness; A3 §3.2; Plan definition wording changed 2026-10-22 by Order 16 for "Clean your data" (no destination), pending competent review, D-31; CHECKLIST §11 -->

## 3. Purpose and scope of the service

3.1. **What Kauro does.** Kauro receives authorized Files, inspects them, profiles the data, proposes a bounded Plan, obtains
the Customer's approval, collects the agreed price, executes the Plan deterministically and delivers a Package with evidence
and, where the mode includes it, an import procedure for the target. The service is **file preparation**: Kauro cleans exported
files, not the live CRM.
<!-- auth: 01 §Purpose and customer promise (second paragraph); A3 §3.3 ("we clean exported files, not your live CRM") -->

3.2. **Modes.** Each project has a single purchased mode and, where the mode prepares files for a target CRM, a single target instance
for its paid revision:
- **CLEAN:** clean tables, disposition of each source unit, an inventory of issues, an explanation of the approved
  transformations and machine verification. It does not claim that a generic file meets the schema of an unknown CRM.
- **HUBSPOT:** files for the supported objects, associations, importer configuration, ordered steps and target-bound evidence,
  with a current Target Contract and an accepted HubSpot import profile.
- **SALESFORCE:** files for the supported objects, Data Loader mapping and configuration, dependency steps and target-bound
  evidence, with current organization metadata and an accepted Data Loader profile.

Only the modes and capabilities the Platform shows as available at the time of the Quote may be quoted. Kauro qualifies imports
only for HubSpot and Salesforce. Changing from CLEAN to HUBSPOT, or changing Salesforce organization, requires a new Quote and
a new approval.
<!-- auth: 02 §Service modes; 02 §Capability publication contract; A3 §3.3; owner decision 2026-10-20 ("Clean your data" has no destination; docs/design/ORDER11-DESIGN-DECISIONS.md §4.7; wording changed 2026-10-22 by Order 16, pending competent review, D-31; CHECKLIST §11) -->

3.3. **Free data health check.** Before buying, the Customer may request a Free data health check on the Files it uploads within
the published limits. It is free and creates no obligation to buy. It is bounded and abuse-protected: one active review per
Customer at a time, a processing-spend cap per review and a pause on new free reviews once ninety percent (90%) of the funded
processing budget is used. It is not always available immediately and its duration depends on observed capacity; Kauro promises
no fixed time. If the processing budget is exhausted, the Platform delivers the deterministic profile and a specific pending
status, without inventing a complete interpretation.
<!-- auth: A3 §3.2 (public name, cap USD 1.50 freeAuditCeilingCents 150, agencyAudits 1, pause at 90%; pause wording aligned with A3 on 2026-10-22 by Order 16, pending competent review, D-31; CHECKLIST §11); A3 §3.5 ("the check is free and creates no obligation to buy"); A3 §3.6 (no fixed time); 02 §5 Receive the audit -->

3.4. **Covered objects.** The initial object scope is contacts, organizations/accounts and deals/opportunities, with the
associations supported per target. Unless a qualified capability is published, the following are not included: lead conversion,
arbitrary custom objects, activities, attachments, recreation of interaction history, campaign memberships, owner provisioning
and automation deployment. Each unsupported shape receives an explanation and a path of action.
<!-- auth: 02 §Service modes (last paragraph) -->

3.5. **What Kauro does not do.** Kauro does not write to the Customer's or End Client's production CRM, does not deploy fields,
validation rules or automations, does no paid enrichment, does not manage the live CRM or offer ongoing database maintenance,
provides no unlimited consulting, and does not run arbitrary code or natural-language instructions that bypass the Plan
compiler. Generating an import file gives Kauro no authority over a CRM.
<!-- auth: 01 §Purpose and customer promise; 02 §Service modes ("Excluded authority" column); 02 §6; 16 §What the price includes; 16 §Offer and buyer fit ("not an unlimited consulting retainer") -->

3.6. **Use of language models.** To propose bounded decisions (for example, the meaning of a column or a possible duplicate),
the Platform may send to a language model hosted on Amazon Bedrock only minimized context: structure, aggregate data, approved
semantic vocabulary and authorized masked examples. No raw records, credentials or secrets are sent. Model proposals are never
executed on their own: the Customer decides, and only the deterministic engine executes supported, validated operations.
<!-- auth: 06 §Privacy classes and minimization (L0–L4); 08 §Model boundary; 01 CH-002; amendments/A9_CLOUD_AWS.md §3 (Bedrock) and §4 -->

3.7. **What the Customer decides.** Semantic decisions that cannot be established from the source and target facts (for example,
whether two similar people should be merged or whether a value should be deleted) belong to the Customer. A duplicate candidate
is not a confirmed merge; Kauro merges duplicates only with the Customer's approval and nothing is deleted without leaving a
trace.
<!-- auth: 02 §What remains human; 02 §5; A3 §3.3 -->

3.8. **Availability status.** Kauro initially operates in limited availability, within a qualified technical envelope and
published limits (files, size, rows, columns, expansion of compressed files and concurrency). A limit the Platform does not
publish is not offered.
<!-- auth: 02 §Capability publication contract (AVAILABLE_LIMITED); 02 §Intake and project boundaries; 09 §Initial intake envelope -->

## 4. Accounts, users and access security

4.1. The Customer registers through an explicit membership process. Similarity of name or email domain never grants
membership. The Customer's first administrator provides the billing and contractual information, accepts the current versions of
the contract documents and confirms its authority to process the data of its End Client or of its own company.
<!-- auth: 02 §2 Establish agency authority; 11 §Agency onboarding -->

4.2. To access data, each Authorized User must have a verified email and multi-factor authentication (MFA) enabled. High-impact
actions (transfer of ownership, change of payment destination, privileged grants, destructive decisions) require recent
re-authentication.
<!-- auth: 08 §Authentication and assurance -->

4.3. The Customer is responsible for: the people it invites and the roles it assigns; revoking the access of anyone who stops
working with it; keeping its credentials and factors confidential; and notifying Kauro without delay if it suspects
unauthorized access. Kauro never asks for passwords, recovery codes or MFA seeds by email or chat.
<!-- auth: 08 §Authentication and assurance (last paragraph); 11 §Billing, team, settings and help -->

4.4. A user who belongs to several Customers actively chooses the Customer they are working with; data follows the selected
context.
<!-- auth: 02 §2; 11 §Agency onboarding -->

## 5. Authority over data, acceptable use and prohibited data

5.1. **Statement of authority.** The Customer represents and warrants that (a) it has the authority needed to upload and have
the Files processed and to make the semantic decisions the service requires; (b) when acting on behalf of an End Client, it has
that End Client's instructions and authorizations; and (c) the collection of the data and its delivery to Kauro comply with the
law applicable to the Customer and the End Client, including data subjects' authorizations where the law requires them. This
statement does not relieve Kauro of its own obligations.
<!-- auth: 19 §Service terms: required operative content (second paragraph); 17 Ley 1581 controller duties (law: C-12) -->

5.2. **Prohibited data.** The Customer will not upload: credentials or authentication secrets; full payment card data;
regulated health data; sensitive data within the meaning of article 5 of Ley 1581 de 2012 or "sensitive personal information"
under US state laws; data of children and adolescents; or other categories whose obligations or security requirements exceed the
qualified service. A "notes" field may contain sensitive information: the Customer must review or exclude it before uploading.
<!-- auth: 19 §Data categories and excluded use; 02 §1 (no CRM attachments are accepted in the form) -->

5.3. **Finding prohibited data.** If prohibited material is detected, Kauro may quarantine or pause the affected scope, minimize
access, notify the Customer's authorized contact and apply the deletion or incident procedure. Kauro will not copy that
material into a support ticket or a model query.
<!-- auth: 19 §Data categories and excluded use (last paragraph) -->

5.4. **Out-of-scope instructions.** Kauro may ask for evidence, or suspend the affected processing, if an instruction appears
unlawful or outside the contracted scope (for example, keeping data indefinitely or sending raw records to an unapproved model).
<!-- auth: 19 §Service terms: required operative content; 19 §Data processing agreement (third paragraph) -->

5.5. **Data subject to the laws of other jurisdictions.** The initial service is offered for customers and data whose processing
is governed by Colombian law and by United States laws; of the US state privacy laws, Kauro has verified only those of
California, Virginia and Colorado, and a project subject to another is accepted only under section 14.1 of the DPA. Kauro does
not offer in this version the transfer instruments of the European Union or United Kingdom General Data Protection Regulation.
If the Files contain data whose processing is subject to those rules, the Customer must say so before uploading them so Kauro
can assess whether it can accept the project; without that assessment, they must not be uploaded.
<!-- auth: 02 §Buyer, user and job to be done ("Expansion to other markets is a capability change with legal and support consequences"); 19 §Data processing agreement (last paragraph, GDPR depends on roles and geography) · silence resolution: see CHECKLIST §Silences S-06 -->

5.6. **Acceptable use.** The Customer will not attempt to access other customers' data, bypass upload, free-review or security
limits, upload active or malicious content, or use the Platform for unlawful activities. Kauro applies rate and resource limits
and may suspend abuse under section 19.
<!-- auth: 08 §Abuse controls; 08 §Quarantine and malware boundaries -->

## 6. Quote, Order and electronic acceptance

6.1. **Quote.** The server calculates the Quote from the admitted Billable Units, the mode, the recurrence tier and the valid
discount. The Quote records the price version, quantity evidence, discount applied, tax treatment, issuer, source and plan
fingerprints and, where the mode has a target, the target fingerprint, price expiry and the date until which the data will be
available. An issued Quote does not change; a material correction creates a substitute Quote with a visible comparison.
<!-- auth: 16 §Quote calculation; 02 §7 Quote and purchase; target fingerprint wording changed 2026-10-22 by Order 16 for "Clean your data" (no destination), pending competent review, D-31; CHECKLIST §11 -->

6.2. **Validity.** The price of a Quote expires after fourteen (14) days. Data availability is shown separately and may end
earlier. A Quote cannot be paid or executed on data that has already been deleted; in that case the Customer re-uploads the
Files and obtains a compatible validated Revision or a new Quote.
<!-- auth: 09 §Quotes, reuploads and retention; 02 §7 -->

6.3. **Formation of the contract.** The Quote published on the Platform is a commercial offer by Kauro. The Order is formed when
the Customer accepts the Quote on the Platform (approval of the current Plan and purchase confirmation) within its validity.
Acceptance is by electronic means and is fully valid; Kauro keeps a durable record of the version of each accepted document, the
identity of the Authorized User, the date and the Quote. No later change to the website modifies an existing Order.
<!-- auth: 19 §Customer instrument hierarchy ("durable record"; "A later website edit does not silently amend an existing order") · law: C-30..C-34 (Ley 527 arts. 5, 14, 15; C. Co. arts. 824, 845, 864; Decreto 2364 de 2012) -->

6.4. **Purchase requirements.** To purchase, the following are required: a current Plan approval, available data, funded
processing capacity, billing identity, the buyer-type declaration in section 25.1 and a usable means of payment.
<!-- auth: 02 §7 · law: C-37 · CHECKLIST A-05 -->

6.5. **Scope changes.** A new scope requires a new Order or an accepted amendment. By default a single source replacement is
allowed before execution, after revalidation, if no paid execution has started and the new scope stays in the same band.
Correcting a Kauro defect never becomes a new, uninformed purchase.
<!-- auth: 16 §Scope changes and credits; 19 §Service terms: required operative content -->

## 7. Prices, discounts and taxes

7.1. **Pricing unit.** The price depends on the mode and the band of Billable Units. Occurrences of admitted objects under the
sealed projection are counted before approved deduplication; physical output rows and the multiplication of relations are not
counted. Kauro cannot change the interpretation after payment to reach a higher band. Zero eligible units do not generate a
minimum-price sale.
<!-- auth: 16 §Billable unit and fairness; 16 §Price schedule -->

7.2. **Rates.** For Customers that are not consumers, the current reference prices appear in Annex A and on the pricing page;
any figure shown before the Quote is an indicative band and the binding price is that of the Quote issued on the sealed scope.
For a Customer that is a consumer, section 7.7 governs and prevails over this paragraph.
<!-- auth: A3 §3.4; 16 §Price schedule -->

7.3. **Discounts.** (a) Recurrence discount, calculated when the Quote is issued on the Customer's qualified projects in the
previous 365 days: 5% with 1 to 9 prior projects, 10% with 10 to 24 and 15% with 25 or more. (b) Founding discount of 25% on the
first eligible project of each of the first three accepted founding customers (agencies or Internal Customers), only while a
slot can be reserved; the slot is reserved when the Quote with the founding discount is issued and expires with it. (c)
Discounts do not stack: the larger eligible one applies. A later refund of a prior project affects future Quotes, not an
already accepted Order.
<!-- auth: 16 §Recurrence decision; 16 §Founding incentive (amended by A3 §4.5); A3 §3.4, §3.5 point 3, §3.7 (founding slots open to Internal Customers) -->

7.4. **Currency.** Prices for customers outside Colombia are expressed and charged in United States dollars (USD). Colombian
pesos are not shown to foreign customers. Colombian customers pay in Colombian pesos by the route Kauro indicates in its Quote,
separate from the international USD collection. A consumer is always informed of and charged the price in Colombian pesos
(section 7.7).
<!-- auth: amendments/A8_PAYMENT_ROUTING.md §2 rule 6; 16 §Price schedule (USD) -->

7.5. **Taxes.** The prices in the Annex A schedule, for Customers that are not consumers, do not include taxes. Before payment,
the Quote shows the taxes that apply under the tax treatment validated for that transaction, and the total. Kauro issues the
electronic sales invoice in accordance with DIAN regulations. If withholding tax is legally required of the Customer, the
Customer applies it and delivers the corresponding certificate.
<!-- auth: 15 §Money vocabulary; 15 §FiscalProfile; 16 §Quote calculation; 01 CH-007 · law: C-40, C-41 -->

7.6. **What the price includes.** The approved deterministic transformations, the exceptions report within the admitted
envelope, verification of the Package, the report with the Customer's branding under the supported options, the target guide,
the staged continuation needed for the purchased relationship strategy and the correction of verified Kauro defects. A staged
import, with its additional action and its retention window, is disclosed before purchase and does not generate a second charge
merely because target identifiers appear after an earlier stage.
<!-- auth: 16 §What the price includes -->

7.7. **Consumer prices.** For a Customer that is a consumer (section 25.1), every price Kauro tells or advertises to it —on the
pricing page, in examples, on the Platform and in the Quote— is shown visually, next to the description of the service, as the
**total price in Colombian pesos including VAT where applicable and all other taxes and additional costs** it must pay, with the
tax calculated by Kauro's electronic-invoicing provider for that transaction. The pricing page shows those totals, or a clearly
identified consumer tab showing them for each band. No indicative figure without taxes or in dollars is the only price a
consumer sees, and the Quote shows the same total. The price informed matches the price charged; if two prices appear, the
consumer pays the lower.
<!-- law: C-37b (Ley 1480 de 2011 art. 26; SIC Circular Única, Título II, numerals 2.3 and 2.3.1) · CHECKLIST A-18 · see LAWYER_LATER L-07 (VAT rate and exemptions) -->

## 8. Payments

8.1. **Means of payment.** Kauro works per project: there are no subscriptions or automatic recurring charges. For customers in
the United States, the only means of payment envisaged is a **US bank transfer (ACH, or a domestic wire to the same details)**,
received in Kauro's business account, with a unique reference per Order. Kauro does not collect or accept payments by this
route until the route is enabled; it is shown only **when enabled**, and Kauro may not offer it. The Platform does not offer
card payment or other means.

A Customer that pays through an accounts-payable platform pays to the bank details Kauro has indicated for that Order. Kauro is
not integrated with those platforms.
<!-- auth: amendments/A8_PAYMENT_ROUTING.md §1 and §2 (rules 2, 3, 4, 5); 15 §Initial payment decision · Payments V1 (owner decision 2026-10-07): PayPal out of the launch, no card offered; a single conditional route -->

8.2. **When an Order is considered paid by bank transfer.** A return page or a notice that the Customer initiated a transfer does
not prove payment.

1. An Order is considered paid only when Kauro reconciles a credit **received** in Kauro's account for the **exact USD amount**
   of the Order, with the Order reference and verified with bank evidence. Initiating or scheduling a transfer is not
   confirmation of payment.
2. The payment instructions show a **deadline** and a recommended send date ("send by"). Kauro does not guarantee how long the
   Customer's bank or the banking system takes to credit the transfer.
3. To decide whether the payment arrived on time, what counts is the **date and time the bank books the credit**, according to
   the bank evidence, within the technical tolerance stated in the payment instructions. The date on which the Customer
   initiated the transfer, and the date on which Kauro finishes reconciling it, do not count.
4. If the credit was booked on time, Kauro honors the accepted price even if it confirms the payment after the deadline,
   **provided that**, when it confirms it, the accepted Quote and its source or files, target, legal and fiscal treatment and
   delivery scope remain **unchanged** (a scope amendment or source replacement under section 6.5 after the Quote was accepted
   does not qualify), and the project has no other open or paid purchase. This does not depend on whether Kauro had already
   marked the Order as expired.
5. If the credit was booked after that moment, or any of those conditions is no longer met, Kauro **does not start the work**:
   it records the money received and **returns** it under section 10; the Customer may request a new Quote.
6. A partial payment, an overpayment, a payment with another reference or sent by a payer other than the accepted billing holder
   is **under review**: it does not enable the work and is returned under section 10. Kauro does not ask for the difference to
   be completed with a second payment.
7. Kauro does not request a second payment while a sent payment is unreconciled. The Customer must not pay again while its
   payment is in transit or under review.

Charges made by the Customer's bank or platform for sending the payment are borne by the Customer; receiving and processing fees
on Kauro's side are borne by Kauro and are not added to the total.
<!-- auth: 02 §7 ("Payment return pages do not assert payment success"); A8 §3 ("the order paid only on a reconciled credit of the exact amount and currency"); 15 §Money vocabulary ("only explicitly disclosed permitted charges"); 15 §Fee reference and example · silence resolution S-09 -->

8.3. **No double charge.** Kauro does not request a second payment while a sent payment is unreconciled; uncertain payments are
reconciled before any retry.
<!-- auth: 01 CH-007; 15 §Webhooks and reconciliation -->

8.4. **Kauro's bank details.** Kauro communicates its bank details only within the Platform or from its verified domain. If the
Customer receives a change of bank details by any other means, it must confirm it on the Platform before paying.
<!-- auth: 15 §Settlement and withdrawal (change of payment destination with verification); 08 §Authentication and assurance -->

8.5. **Disputes and chargebacks.** If the Customer opens a dispute or chargeback, Kauro responds with truthful evidence limited to
the disputed service (accepted terms, Quote, approval, payment, availability and download of the Package, support history),
without providing CRM records. A reversal may revoke the authority for new executions of the affected Order.
<!-- auth: 15 §Disputes and chargebacks -->

## 9. Execution, delivery and import

9.1. Authorized work uses immutable inputs. Provisional output stays private until the final verifier, lineage reconciliation,
re-check of authorization and publication succeed. A cancelled or replaced attempt does not publish.
<!-- auth: 02 §8 Execute and deliver -->

9.2. The Customer receives a Package with a human-readable report, a machine-readable manifest and target-specific
instructions. The Platform distinguishes prepared, downloadable, downloaded and Customer-reported import packages. Kauro never
marks a project as imported merely because a file was downloaded.
<!-- auth: 02 §8 -->

9.3. **The import is the Customer's.** The Customer runs the documented import in its own authorized target environment and is
responsible for it. In staged imports, the Customer delivers on the Platform the defined result receipts and receives the next
verified stage. An arbitrary "success" file is not proof.
<!-- auth: 02 §9 Verify target import and handle issues; 19 §Service terms ("agency's responsibility for final CRM import") -->

9.4. **Target changes.** A change of the target after payment pauses the execution that depends on it; the Customer receives the
impact and its options. An additional charge applies only with a new accepted scope.
<!-- auth: 15 §Price and source expiry races -->

9.5. **Customer branding.** The Customer may brand the report and omit Kauro's advertising, but may not edit it to claim a
certification, guarantee or import that did not occur.
<!-- auth: 13 §Branding and white label -->

## 10. Cancellation and refunds

10.1. **Before paid processing starts.** The Customer may cancel a paid Order before its processing begins and receives a refund
of the amount paid. Payment-provider fees that are not recovered are Kauro's cost.
<!-- auth: 15 §Refund policy and calculation (second paragraph) -->

10.2. **After processing starts.** Cancellation stops future work and blocks new publications, but cannot undo work already
transmitted or an import the Customer has already done. Kauro evaluates the request in good faith according to the recorded
phase and, where appropriate, credits the amount to a new Revision or refunds it, and explains its decision in writing. Kauro
imposes no penalties that are not in these Terms. If the Customer is a consumer, its statutory rights in section 25 (withdrawal,
delivery and payment reversal) prevail over this evaluation and over any credit.
<!-- auth: 19 §Service terms (cancellation paragraph); 01 CH-005; 15 §Refund policy and calculation ("does not invent a penalty"); 16 §Scope changes and credits ("Prior payment is credited or refunded through the ledger where appropriate") · silence resolution S-08 -->

10.3. **Kauro defect.** The remedy for a Kauro defect is governed by section 11.

10.4. **Form of the refund.** Refunds are paid by the same means of payment where possible (bank-transfer refunds, as an
outbound transfer approved by Kauro, once actual execution is evidenced). The total refunded never exceeds what was actually
captured less prior refunds and reversals. A partial refund identifies the affected component of the service and adjusts the tax
consistently, with the corresponding credit note.
<!-- auth: 15 §Refund policy and calculation; A8 §3 ("refunds as outbound transfers under owner approval"); 15 §TaxDocument state machine -->

10.5. **Price and data expiry.** If a payment is confirmed after the Quote expires or after the data is deleted, Kauro honors the
price only if the accepted Quote and its source, target, legal treatment and scope remain unchanged; otherwise it refunds or
issues a new Quote at the Customer's choice.
<!-- auth: 15 §Price and source expiry races -->

## 11. Defects and remedies

11.1. **What a Kauro defect is.** A material failure of the Package against the approved Plan, the Target Contract or the
Supported Profile, attributable to Kauro. The following are not Kauro defects in themselves: source errors, Customer edits,
target changes or third-party tool configurations; Kauro distinguishes them with evidence and without automatically blaming the
Customer.
<!-- auth: 19 §Service terms (remedy paragraph); 02 §9 (failure classification) -->

11.2. **Time to claim.** The Customer may report a defect within **thirty (30) days** after Service Completion. Because data is
kept for a shorter time (section 13), a claim after deletion may require re-uploading exactly the same source and the evidence;
the Platform explains this. Staged projects use the milestones disclosed before purchase.
<!-- auth: 18 §Support coverage and service targets; registry/policy.json support.defectReportDays = 30; 11 §Billing, team, settings and help -->

11.3. **Remedy.** For a verified material Kauro defect, the main remedy is to investigate and repair or regenerate the Package,
with an initial target of **five (5) business days**. If repair is not reasonable or not possible, Kauro refunds the value of the
affected project to the extent appropriate. This does not limit rights the law does not allow to be excluded; for a Customer
that is a consumer, the remedy is the consumer's choice under section 25.9.
<!-- auth: 18 §Support coverage and service targets; registry/policy.json support.defectRepairTargetBusinessDays = 5; 15 §Refund policy and calculation (third paragraph); 19 §Service terms ("preserves rights that cannot legally be excluded") -->

## 12. Support

12.1. Human support is in writing, Monday to Friday from 09:00 to 17:00 Bogotá time (America/Bogota), excluding applicable
holidays. Acknowledgment is automatic and the human response target is the next business day. Kauro does not offer 24/7 staffed
support.
<!-- auth: 18 §Support coverage and service targets; registry/policy.json support -->

12.2. The Customer must never send its CRM export by email. Support requests refer to project and artifact identifiers. If
Kauro needs to see records, it does so within the Platform through case-specific support access: with defined purpose, project
and operations, approval, a maximum duration of thirty (30) minutes, read-only by default, an audit record and, where
appropriate, the Customer's consent.
<!-- auth: 02 §9; 08 §Support access and break-glass; registry/policy.json retention.breakglassSeconds = 1800 -->

12.3. The Customer may have an optional call with an English-speaking seller, but is not required to have one in order to
purchase.
<!-- auth: 02 §1 Discover and qualify fit; 11 §Billing, team, settings and help -->

## 13. Retention, return and deletion of data

13.1. **Schedule.** Kauro keeps the Customer's data for the following periods ("day" means a 24-hour period):

| Class | Ordinary availability | Maximum limit |
|---|---|---|
| Incomplete upload and quarantine | Until inspection ends or the reservation expires | 24 hours from the start of the upload |
| Source and derivatives of the Free data health check (unpaid) | 7 days after the result is ready or after terminal failure | 14 days from sealing |
| Source and delivery of an ordinary paid project | 7 days after the first Package is available | 14 days from payment confirmation |
| Source and artifacts of a staged import | Until the end of the staged window and then up to 7 days for the final delivery | 21 days from the first stage and never more than 30 days from payment confirmation |
| Import receipts | 7 days from when their verification ends | Within the staged project's limit when needed to continue |
| Target schema and reusable configuration | Up to 180 days from the last confirmation or use | Maximum executable validity of 30 days; invalidated on a material change of the target |
| Minimized context sent to the model | During the active review and its short evidence window | Deleted with the project data |
| Application logs | 30 days | No CRM content or secrets |
| Minimal security evidence | 180 days | No CRM content |
| Financial and legal records | The applicable legal period | Separate, no CRM content |
<!-- auth: 09 §Retention schedule; registry/policy.json retention -->

13.2. **Extension.** A single extension of a soft period per project is allowed, of up to seventy-two (72) hours, requested by an
authorized user before it expires, with a stated purpose; it never exceeds the maximum limits. Opening a report, contacting
support or receiving reminders does not extend retention.
<!-- auth: 09 §Quotes, reuploads and retention; registry/policy.json retention.softExtensionsPerProject = 1, softExtensionMaximumSeconds = 259200, extendHardCap = false -->

13.3. **Return or deletion at the controller's choice.** When the service ends, or earlier on request, the Customer (on its own
behalf or on its End Client's instruction) chooses whether Kauro **returns** or **deletes** all the personal data in the
Customer Data that Kauro still holds: the accepted source Files, the Packages and the other derivatives containing personal data
(profiles, exceptions, lineage, import receipts). Return is by secure download within the Platform before deletion; afterwards,
Kauro deletes and delivers the receipt described in section 13.4. If the Customer does not choose, the schedule in section 13.1
applies, which deletes data within short periods; the Platform gives notice of the deletion date so the Customer can download
earlier. What the law requires to be kept is kept only for that purpose. Each signed download link expires after fifteen (15)
minutes.
<!-- auth: 09 §Notifications and customer action; 09 §Early deletion; 09 §Deletion receipts and restoration; 19 §Data processing agreement ("return/deletion"); registry/policy.json retention.signedDownloadSeconds = 900 · law: C-65 (Va. Code §59.1-579 B.2), C-66 (C.R.S. 6-1-1305(5)(d)(I), 2026 text) · resolution S-11 (r2) · CHECKLIST A-15 -->

13.4. **Early deletion.** The Customer may request early deletion of a project or a scope. Kauro first blocks new uploads,
sends to the model, processing, publications and downloads, cancels active attempts and deletes all recorded generations
(quarantine, accepted, derived, provisional, deliveries, receipts and support copies), comparing them with the provider's
inventory. Kauro delivers a deletion receipt for the scope it controls; it cannot delete copies already downloaded by the
Customer or imports made in its CRM. If a provider operation fails, the deletion remains partial and visible, and is retried. A
deleted copy may persist for a few days after deletion in the provider's storage, until it expires automatically; Kauro does not
use or restore it.
<!-- auth: 09 §Early deletion; 09 §Deletion receipts and restoration -->

13.5. **Backups.** Database backups contain metadata and references, not the content of the Files. Restoring a backup does not
reactivate downloads or deleted data.
<!-- auth: 14 §Storage configuration ("Domain backups contain metadata and safe references, not source file payload"); 09 §Deletion receipts and restoration -->

## 14. Personal data protection

14.1. With respect to the personal data contained in the Files and their derivatives, the Customer (or its End Client, according
to the recorded chain) is the controller and Kauro acts as **processor** on the Customer's behalf, under the DPA. With respect
to the data of the Customer's accounts, users, billing and communications with Kauro, Kauro is the **controller** and processes
it under its Personal Data Processing Policy.
<!-- auth: 19 §Data processing agreement (text amended by A3 §4.7); product: brief D-08b · law: C-01..C-29 -->

14.2. Kauro does not sell or share the personal data in the Files, does not use it for its own purposes, does not combine it
with other customers' data and does not use it to train models. There is no vector database, cross-customer search or online
learning.
<!-- auth: 06 §Scoped memory; 01 CH-006; 09 §Derived data and worker scratch · law: C-60..C-66 -->

## 15. Intellectual property

15.1. **Kauro software.** Kauro (or its licensor) owns the Platform, its code, its configuration models, its generic templates
and its documentation. The Customer receives a non-exclusive, non-transferable right, limited to the term of the contract, to use
the Platform in its own operation.

15.2. **Customer Data.** Kauro does not acquire ownership of the Files or of customer records. The Customer grants Kauro only the
license needed to provide the service, under the DPA's instructions.

15.3. **Deliverables.** The Customer may use, modify and deliver to its End Client the Packages and reports generated for it. The
brand, logo and colors the Customer uploads remain its own; Kauro uses them only to generate its reports. Kauro's technical
evidence inside the manifest retains its provenance.

15.4. **Feedback.** Kauro may use the Customer's general suggestions about the product without any payment obligation, without
including Customer data. Kauro uses the Customer's name, identity or testimonials only with its written approval of the exact
text.
<!-- auth: 19 §Service terms (IP distinguishes software, data, brand and deliverables; "Kauro does not claim ownership of customer records"); 13 §Branding and white label; 18 §Feedback and product improvement -->

## 16. Confidentiality

16.1. Each party will protect the other's non-public information that it receives in connection with the contract with at least
the care it applies to its own and never less than reasonable care; will use it only to perform or exercise the contract; and
will disclose it only to its personnel, collaborators and providers who need it and are bound by equivalent confidentiality.

16.2. Information is not confidential if it (a) was already public through no fault of the recipient; (b) was already lawfully
held by the recipient; (c) is lawfully received from a third party without a duty of confidentiality; or (d) is independently
developed. A party may disclose information when a competent authority orders it, giving prior notice to the other if the law
permits and limiting the disclosure to what is ordered.

16.3. The personal data in the Files is also governed by the DPA. This obligation survives termination as long as the
information remains confidential.
<!-- auth: 19 §Service terms ("Confidentiality covers both parties' nonpublic information with defined permitted uses and exceptions") -->

## 17. Customer representations; scope of warranties

17.1. The Customer represents that the billing and identity information it provides is truthful and that its Authorized Users
act with its authorization.

17.2. Kauro provides the service with the diligence of a professional in the field and in accordance with the approved Plan.
Kauro does not guarantee that the target CRM will always accept the import when the target changes or when the Customer modifies
files or configurations; nor does it guarantee a commercial result, a particular saving, or that a free review will find
problems. Nothing in these Terms excludes the Customer's non-waivable rights.
<!-- auth: A3 §3.5 (no savings promised); 01 CH-012; 19 §Service terms (remedy and non-waivable rights) · law: C-36, C-37 -->

## 18. Limitation of liability

18.1. Each party's total liability to the other for all claims arising from or related to an Order is limited to the amount
actually paid by the Customer to Kauro for the Orders of the twelve (12) months before the event giving rise to the claim.

18.2. Neither party is liable to the other for lost profits or for damages that were not foreseen or foreseeable when the
contract was made.

18.3. The above limits **do not apply** to: (a) fraud (dolo) or gross negligence (culpa grave); (b) the Customer's obligation to pay the
price; (c) rights the law does not allow to be limited; or (d) the liability the law imposes on each party toward data subjects
or the data protection authority for its own role.
<!-- auth: 19 §Service terms ("does not insert a sweeping 'no liability under any circumstances' clause"); 15 §Refund policy · law: C-35 (C.C. arts. 63, 1522, 1616) · see LAWYER_LATER L-04 · silence resolution S-03 -->

## 19. Suspension and termination

19.1. **Suspension.** Kauro may suspend, with notice to the Customer and for the minimum scope necessary: (a) the processing of an
apparently unlawful or out-of-scope instruction; (b) the scope affected by prohibited data; (c) the access of a user or account
used for abuse or with a security risk; (d) new executions of an Order whose payment was reversed; or (e) services affected by an
incident, as a containment measure. Suspension preserves the legitimate paths of recovery, refund and deletion.
<!-- auth: 19 §Service terms; 19 §Data categories and excluded use; 08 §Abuse controls; 14 §Incident containment; 15 §Disputes and chargebacks -->

19.2. **Termination by the Customer.** The Customer may close its account at any time. Closure stops new Orders and follows
pending delivery, refund, legal and deletion obligations. The Customer may obtain the permitted records during the closure
process.

19.3. **Termination by Kauro.** Kauro may terminate the contract on thirty (30) days' notice, or immediately in case of a serious
breach by the Customer not cured within ten (10) business days after written notice. Paid Orders in progress at the time of
notice without cause are completed or refunded.

19.4. **Effects.** On termination, the Customer's data is deleted under section 13 and the DPA, and only minimal financial,
legal and security records are kept, separate and without CRM content. "Account deleted" does not mean that invoices the law
requires to be kept disappear. Sections 13, 15, 16, 18, 22, 23 and 25 survive.
<!-- auth: 16 §Agency lifecycle ("Closing an agency stops new orders..."); 19 §Rights requests and privacy complaints (last paragraph); 09 §Retention schedule · silence resolution S-10 (termination notice periods) -->

## 20. Sellers and communications

20.1. Kauro may sell through independent commercial collaborators. A seller may not promise features, dates, prices, unlimited
support, permanent retention or writes to a live CRM, or bind Kauro outside the Quote issued by the Platform. Sellers do not
receive reports containing CRM records.
<!-- auth: 19 §Customer instrument hierarchy (last paragraph); 02 §1 ("A seller cannot promise a feature or delivery date..."); 13 §Privacy in reports and downloads -->

20.2. Kauro sends the Customer transactional service notices (account, invitations, payment status, delivery, deletion notices,
support) to registered users. Those notices include no CRM records or signed download links; they link to the Platform.
Commercial communications to Authorized Users are sent only to those who authorized them separately and through the channels they
authorized, under the rules in section 17 of the Processing Policy (identification as advertising, consultation of the CRC
Excluded Numbers Registry for recipients in Colombia, legal hours and immediate unsubscribe). Accepting these Terms does not
mean accepting advertising.
<!-- auth: 09 §Notifications and customer action; reference/MESSAGING_AND_SENDER_OPERATIONS.md (Resend, transactional only; suppression); 18 §Communication compliance · law: C-50, C-51, C-52 · CHECKLIST A-14 -->

## 21. Changes to these Terms

21.1. Each version of the contract documents has a number and an effective date. Kauro will give notice on the Platform and by
email to the Customer's administrators, at least thirty (30) days in advance, of any material change. The change applies to
Orders after its acceptance; it never modifies an Order already accepted. If the Customer does not accept the new version, it may
close its account at no cost before it takes effect.
<!-- auth: 19 §Customer instrument hierarchy ("version and effective date"; "Material changes require notice and acceptance where applicable") -->

## 22. Governing law and dispute resolution

22.1. These Terms and each Order are governed by the laws of the Republic of Colombia.

22.2. The parties will try to resolve any dispute by direct negotiation for thirty (30) calendar days from the written notice of
either of them. That stage does not prevent seeking urgent measures or filing an action before it lapses or becomes time-barred.
If they do not resolve it, the dispute will be submitted to the competent judges under the applicable statutory rules of
jurisdiction and competence.

22.3. Nothing above prevents a data subject or an authority from exercising the rights or powers the law gives them, or the
Customer from going to the Superintendencia de Industria y Comercio (SIC) when the law permits.
<!-- auth: 19 §Service terms ("Liability limits, exclusions, governing law, forum, dispute procedure and any indemnity require application to the actual operator..."; "no ... invented foreign jurisdiction") · law: C-42 (Código General del Proceso art. 28 num. 3: a stipulation of contractual domicile for judicial purposes is deemed unwritten) · see LAWYER_LATER L-05 (arbitration or recognition in the US) -->

## 23. Notices

23.1. Kauro notifies the Customer through the Platform and at the registered administrator's email. The Customer notifies Kauro
at [notice email] or through the Platform's channels. An email notice is deemed received when the recipient's information system
receives it, unless proven otherwise.
<!-- law: C-32 (Ley 527 de 1999, art. 24, time of receipt in the designated information system) -->

23.2. Judicial notices to Kauro are addressed to [registered address] and [notice email].

## 24. Miscellaneous

24.1. **Force majeure.** Neither party is liable for non-performance caused by force majeure or fortuitous event (fuerza mayor o
caso fortuito), provided it notifies the other and mitigates its effects; this does not suspend security or data-deletion
obligations that remain possible.

24.2. **Assignment.** The Customer may not assign the contract without Kauro's written consent. Kauro may assign it to a
successor company of its business, with notice to the Customer, provided the assignee assumes the DPA obligations.

24.3. **Independence.** The parties are independent contractors. Nothing creates a partnership, commercial agency or employment
relationship.

24.4. **Language.** These Terms are written in English, which is the master version. Kauro may offer translations (including a
Spanish translation where Colombian law requires one); in case of difference the English version prevails.

24.5. **Entire agreement and severability.** The documents in section 1.3 are the entire agreement between the parties on their
subject matter. If a provision is invalid, the others keep their effect and the invalid one is replaced by the valid one closest
to its purpose.

## 25. Customers that are consumers

25.1. **Buyer-type declaration.** Before paying, the Customer declares on the Platform whether it acquires the service for a need
intrinsically linked to its economic activity (for example, an agency preparing data for its clients' projects) or as a final
recipient for a need that is not. Kauro does not presume that a Customer is not a consumer. If the Customer is a consumer under
article 5, numeral 3, of Ley 1480 de 2011, this section applies whatever its declaration was, and no other provision of these
Terms limits the rights that law gives it.

25.2. **Information before buying.** Before the purchase and in the same medium, the Platform states: Kauro's identity
(section 1.1); the description of the service (sections 3 and 7.6, the Plan and the Quote); the total price in Colombian pesos
with all taxes and costs (section 7.7); the means of payment; the delivery time the Quote indicates; the validity of the offer;
and the right of withdrawal with the procedure to exercise it. These Terms and the other contract documents may be consulted,
printed and downloaded at any time, before and after the purchase.

25.3. **Summary and acceptance.** Before completing the purchase, the Platform shows a summary of the Order (service, mode,
units, price, taxes and total) that the Customer can correct, cancel and download. Acceptance is express and recorded.

25.4. **Acknowledgment of receipt.** No later than the calendar day after the Order, Kauro sends an acknowledgment of receipt
with the delivery time, the exact price with taxes and the form of payment.

25.5. **Withdrawal.** The consumer may withdraw within five (5) business days after the contract is made, from the Platform or by
writing to [notice email] with the Order reference. The contract is terminated and Kauro returns everything paid, without
deductions, by the same means of payment or one agreed, within fifteen (15) calendar days after the right is exercised, once the
consumer provides the correct data requested for it. Withdrawal does not apply if performance of the service has already begun
with the consumer's agreement: therefore, within those five days Kauro starts paid processing only if the consumer expressly asks
for it on the Platform after being told that this loses the right of withdrawal; if the consumer does not ask, Kauro waits for the
period to expire.

25.6. **Delivery time and unavailability.** Kauro provides the service within the time accepted in the Quote or, if none was
stated, within thirty (30) calendar days after the day the consumer placed the Order. If at any time before that deadline Kauro
knows it will not be able to provide the service (for example, for lack of capacity or because the scope cannot be served), it
informs the consumer **immediately**; the consumer may then terminate the contract and receive a refund of everything paid,
without retentions or deductions, within fifteen (15) calendar days, or ask for a second date. If Kauro exceeds the deadline,
the consumer has the same right to terminate and receive the refund within fifteen (15) calendar days.

25.7. **Payment reversal.** This applies when the consumer paid by e-commerce with a credit card, debit card or other electronic
payment instrument and both Kauro and the instrument's issuer are domiciled in Colombia. The Platform does not currently offer
payment by card or other electronic instruments (section 8.1); this section records the statutory right and applies only if a
payment of that kind ever comes to exist. Grounds: fraud, unrequested transaction, service not received, or service that does not
correspond to what was ordered or is defective. The consumer files a complaint with Kauro through the Platform, by email to
[notice email] or verbally, **within five (5) business days** after: the date the consumer learned of the fraudulent or
unrequested transaction; the date it should have received the service (the Package, per the time in section 25.6), if it did not
receive it; or the date it received it, if it does not correspond to what was ordered or is defective. The complaint states the
reasons, the ground, the amount for which reversal is requested and the instrument to which the transaction was charged. However
it is filed, Kauro immediately delivers a downloadable acknowledgment with the date and the ground.

Within the same five (5) business days the issuer of the payment instrument is notified, through the channels the issuer
provides. If the consumer is not the holder of the instrument (for example, it paid with another person's card), **that
notification must be filed by the holder of the financial product**; the consumer still files its complaint with Kauro. The
notification to the issuer contains at least: (1) the reasons for the request; (2) the ground; (3) the amount; (4) the
identification of the transaction with its number, date and time, if applicable; (5) the account, card or instrument to which it
was charged; and (6) the acknowledgment of the complaint filed with Kauro. Participants in the payment process must have a
reversal request form, but the consumer may use any other document that meets these requirements.

Once the request is filed with the issuer, the participants in the payment process have **fifteen (15) business days** to make the
reversal effective. If Kauro's account has insufficient funds and the reversal is partial, **Kauro refunds the consumer directly**
the amount or the missing portion. If Kauro had already returned the price directly and the reversal also proceeds, the consumer
returns those funds to Kauro. Kauro **does not charge again or ask for the transaction to be charged again** while the reversal is
unresolved: only if a judicial or administrative authority determines, by a **final** decision, that the reversal was not
appropriate, and once that decision is notified, may the issuer definitively charge the transaction to the consumer.

25.8. **Petitions, complaints and claims.** The Platform offers a service channel that gives a case number with the date and time
of each petition, complaint or claim and allows it to be tracked. If the consumer claims verbally or by phone, Kauro gives it a
written acknowledgment with the date and subject of the claim. Kauro answers each direct claim **within fifteen (15) business
days** after receiving it, with the evidence it relies on. The site and the Platform show a visible link to the Superintendencia
de Industria y Comercio (www.sic.gov.co).

25.9. **Warranty and remedies.** If Kauro fails to provide the service, the consumer **chooses** between having the service
provided under the contracted conditions or having the price paid refunded; section 11 (remedy at Kauro's choice) does not
apply to it to the extent it would reduce that choice. Nothing in sections 10 and 11 limits the rights in this section or the
consumer's other non-waivable rights.
<!-- law: C-36, C-37 (Ley 1480 de 2011 arts. 5 num. 3, 7, 11 num. 3, 46, 47 —amended by Ley 2439 de 2024—, 50 —items b, g and h amended by Ley 2439 de 2024—, 51 and 58 num. 5 lit. b and c; Decreto 1074 de 2015 arts. 2.2.2.51.1, 2.2.2.51.2, 2.2.2.51.4 to 2.2.2.51.10 and 2.2.2.51.12) · auth: A3 §3.7 (Internal Customers admitted); 02 §7 Quote and purchase · CHECKLIST A-05 · resolution S-23 -->

## Annex A. Reference rates for Customers that are not consumers (USD, before taxes)

This table **is not a consumer price**: a consumer is informed of the total in Colombian pesos with taxes included (section 7.7).
It applies only to the modes the Platform shows as available when the Quote is issued. Bands above 500,000 units are not
available until the larger envelope is accepted.

| Billable Units | CLEAN | HUBSPOT | SALESFORCE |
|---|---:|---:|---:|
| 1–50,000 | 695 | 1,295 | 1,495 |
| 50,001–150,000 | 1,095 | 1,995 | 2,295 |
| 150,001–500,000 | 1,795 | 2,995 | 3,495 |
| 500,001–1,000,000 | Not available | Not available | Not available |

Calculation example: HUBSPOT with 50,000 units costs USD 1,295; with 50,001 units, USD 1,995. With a 5% recurrence discount, the
first band comes to USD 1,230.25 before taxes.
<!-- auth: 16 §Price schedule; 16 §Quote calculation; A3 §3.4 -->
