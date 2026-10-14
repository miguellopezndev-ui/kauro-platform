<!--
D-08b · Internal manual of personal data processing policies and procedures of Kauro Data S.A.S. (Ley 1581 de 2012, arts. 17 lit. k
and 18 lit. f; Decreto 1074 de 2015, arts. 2.2.2.25.6.1 and 2.2.2.25.6.2; SIC, Guide for implementing the principle of
demonstrated accountability). English master (owner rule 2026-10-07); a Spanish secondary translation is kept in es/ because the
manual belongs to the Ley 1581 habeas-data program that Colombian law requires in Spanish. INTERNAL document: not published and
not part of the contract with the Customer; DPA §5(f) refers to it. Draft by the builder without a lawyer (decision D-08b,
option 1).
Traceability: `auth:` = authority/r2; `law:` = CHECKLIST.md row; `prod:` = element of the product registry
(packages/contracts/registry) or Intelligence Core code. Sources consulted on 2026-10-06 (CHECKLIST §1 and §5).
Placeholders: only those of LAWYER_LATER F-01..F-05. The legal representative's name is entered at signing (decision D-16).
-->

# Internal manual of personal data processing policies and procedures

**Version:** 1.1 · **Adopted by:** the legal representative of Kauro Data S.A.S. · **Effective from:** [effective date] · **Next review:** twelve
(12) months after the effective date (section 9)

## 1. Purpose, scope and framework

1.1. This Manual says **who does what, when and with what record** to comply with the Personal Data Processing Policy (POL), the
Privacy Notice (NOTICE), the Terms of Service (ToS) and the Data Processing Agreement (DPA). It does not repeat those texts: it
applies them. If this Manual and a published text differ, the published text prevails and this Manual is corrected.

1.2. It covers all the databases in section 4: those Kauro processes as **controller** and those it processes as **processor**
(Customers' CRM files and their derivatives).

1.3. Framework: Ley 1581 de 2012 (art. 17 lit. k: the controller adopts an internal manual of policies and procedures,
especially for queries and claims; art. 18 lit. f: the same duty for the processor); Decreto 1074 de 2015, art. 2.2.2.25.6.1
(demonstrated accountability proportional to size, the nature of the data, the type of processing and the risks) and art.
2.2.2.25.6.2 (proportional administrative structure, internal mechanisms with training, processes for queries and claims); SIC,
Guide for implementing the principle of demonstrated accountability (comprehensive program: organizational commitment, program
controls, continuous evaluation and review); SIC, Circular Externa 002 de 2024 (AI), applied in PIA_BEDROCK.md.
<!-- law: C-12, C-13, C-24, C-27 · source: CHECKLIST C-24 (SIC Guide, Decreto 1074 Ch. 25 sections 4–6) -->

## 2. Proportionality: a one-person company

2.1. Kauro Data S.A.S. operates as a one-person company: its legal representative is also the one who operates the service and it
has no employees. The software is built and operated by that person with programming assistants, which have **no** access to
customer data. There are no employees, areas or committees. Independent sellers receive no CRM data.
<!-- auth: A4 §Owner acts and §Resources (one owner, assisted operation); 08 §Model boundary (last paragraph: customer data excluded from development assistants); DPA §8.3 (sellers without Customer Data) -->

2.2. For that reason the Manual relies on two types of steps, and each procedure says which is which:
- **PRODUCT:** done by the platform (with the R2 program package that builds it). Before that package is accepted and in
  production, the step is manual or the service is not activated (CHECKLIST §7).
- **MANUAL:** done by the legal representative, by hand, with the indicated record. A manual step without its record does not
  count as done.
<!-- law: C-24 (Decreto 1074 art. 2.2.2.25.6.1 num. 1: measures proportional to company size; art. 2.2.2.25.6.2 num. 1: proportional structure) -->

## 3. Roles and responsibilities

| Role | Who | Responsibilities |
|---|---|---|
| Controller / processor | Kauro Data S.A.S. | As per section 4 |
| **Data protection officer** (person who assumes the data protection function and handles requests) | **The legal representative** | Approve and review this Manual and the impact assessment; receive and resolve queries and claims (section 5.1); pass on requests about Customer Data (5.2); lead incident response and make the reports to the SIC and the notices to Customers (5.4); approve sub-processors (5.5); oversee retention and deletion (5.6); train and be trained (5.10); do the annual review (section 9); answer SIC requests with the program's evidence |
| Kauro's processors | AWS, Resend, Google (Workspace) and the electronic-invoicing provider | Under their contracts (section 5.5; POL §13.1; DPA Annex III) |
| Independent controllers | Wise, Bancolombia, DIAN | Process payment or tax data for their own purposes; they are not processors (POL §13.2) |
| Independent sellers | Commercial collaborators | Only prospect-organization data (agencies and companies); they accept the data-handling rules before being activated (section 5.10) |
| Programming assistants (Claude, Codex) | Builder tools | No data of customers, prospects or data subjects; defects are reproduced with synthetic data |
<!-- law: C-09b (Decreto 1074 art. 2.2.2.25.4.4: controller and processor designate a person or area) · auth: 19 §Business readiness gate ("a responsible person for obligations"); 19 §Subprocessor register; 08 §Model boundary; 12 §Seller onboarding and access lifecycle (data-handling acceptance and training before ACTIVE) · silence resolution S-14 · source: SIC Guide, III.1.1 (top management designates the person or area) and III.1.2 (data protection officer) -->

## 4. Database inventory

Databases are identified by code. "System" is where they live; "Auto" indicates whether the platform applies retention by itself
(PRODUCT) or the legal representative oversees it (MANUAL). The inventory is reviewed in the annual review and whenever a purpose,
a data item, a system or a processor changes.

### 4.1. Kauro as controller

| Code | Database (POL) | Data subjects | Data | System and location | Processors | Retention (POL §15) | Auto |
|---|---|---|---|---|---|---|---|
| R-01 | Customers and users (§6.1) | Administrators and users of customer agencies and companies | Identification and work contact, role, email and second-factor verification, acceptance of documents, separate commercial authorization with its channels, activity and security events, buyer type | Platform database on AWS (US) | AWS; Resend (notices) | Active account + 6 months | MANUAL until an automatic sweep exists |
| R-02 | Billing, payments and accounting (§6.2) | Billing representatives and contacts; transfer payers | Legal name, NIT, billing address and contact, orders, payments, refunds, disputes | Platform (AWS); electronic-invoicing provider; accounting books | AWS; invoicing provider | ≥ 10 years | MANUAL (legal period; not deleted earlier) |
| R-03 | Contact-form leads (§6.3) | People who fill in the contact form | Name, email, company, buyer type, target, record band, desired date, separate commercial authorization with its channels | Platform (AWS); corporate email | AWS; Google | 12 months without interaction | MANUAL |
| R-04 | Prospects (§6.3) | Organizations, agencies and companies (organization data), and people at them who authorized contact | Organization: organization name, domain, country, source and date, bounded notes without data of individuals, opt-out status and channels that meet the three facts of POL §6.3.1 with their evidence (URL, date, capture) and date of last verification. Person: name, title, work email and phone **only with an authorization record** | Platform (AWS) | AWS; Resend or corporate email for sending | Opt-out, revocation or 24 months without interaction; the opt-out is kept | MANUAL (deletion); PRODUCT (blocking of individuals' data without authorization, A-13) |
| R-05 | Commercial collaborators and providers (§6.4) | Sellers, candidates, individual providers | Identification, contact, contract, tax and social-security documents, bank details, commissions | Platform (AWS, access restricted to finance); corporate email | AWS; Google | Relationship + tax and accounting periods | MANUAL |
| R-06 | Requests, queries and claims (§6.5) | Those who exercise rights before Kauro | Requester identification, type, dates, verification, scope, response | Request register (section 8) in Kauro's Google Workspace space | Google | 5 years from closure | MANUAL |
| R-07 | Security and technical records (§6.6) | Users and operators | Actor, scope, action, result, date; no CRM content or secrets | Platform and AWS logs (US) | AWS | Application logs 30 days; security evidence 180 days | PRODUCT (09 §Retention schedule) |
| R-08 | Corporate correspondence | Senders and recipients of Kauro email | Contact and content of support, sales and administration emails | Google Workspace | Google | Per the database the email belongs to (R-01..R-06) | MANUAL |
<!-- law: C-25 (Decreto 1074 art. 2.2.2.25.2.8) · auth: POL §6 and §15 with their traces; 09 §Retention schedule; 08 §Audit events and retention; A9 §1 (Google Workspace unchanged) and §3 (AWS services) · source: SIC Guide, III.2.2 (inventory: what data, how it is used, whether it is needed, where it is obtained and proof of authorization) -->

R-08 is not a new database: it is the system through which data of R-01 to R-06 arrives. The rule is that **no CRM file arrives by
email** (ToS §12.2); if one does, it is treated as a prohibited-data incident (section 5.4) and deleted from the mailbox.

### 4.2. Kauro as processor (Customer Data)

| Code | Database | Controller | Data | System and location | Sub-processors | Retention | Auto |
|---|---|---|---|---|---|---|---|
| E-01 | CRM files and their derivatives, by zone: quarantine, accepted, profile, minimized, staging, delivery, import receipts | The Customer or its End Client (chain recorded per End Client, R2-111) | Those in DPA Annex I.4; data subjects in DPA Annex I.5 | Amazon S3 and platform database, AWS US regions; each object registered with agency, project, class, location, generation, hash and retention anchor | AWS | ToS §13.1 / DPA Annex IV (24 hours to 30 days depending on the stage) | PRODUCT (09 §Retention schedule, §Early deletion, §Deletion receipts) |
| E-02 | Minimized context sent to the model | Same as E-01 | Structure and aggregate facts (L0), approved vocabulary (L1), masked forms (L2); never L3 or L4 | MINIMIZED zone (AWS, US); in transit to Amazon Bedrock (`us.` inference profile) | AWS (Bedrock), no retention | Active review and short evidence window; deleted with the project | PRODUCT; impact assessment in PIA_BEDROCK.md |
<!-- auth: 09 §Storage zones and object registry; 09 §Derived data and worker scratch; 06 §Privacy classes and minimization; 19 §Data processing agreement; A9 §3 and §4 · prod: registry cases R2-111 (B19) · law: C-13, C-21 -->

## 5. Procedures

### 5.1. Data subjects' queries and claims to Kauro as controller

| Step | What | Legal term | Who |
|---|---|---|---|
| 1 | Receive at [notice email], in writing at [registered address] or through the platform's privacy section (UI46). Open the case in the request register with the date of receipt | — | PRODUCT (UI46 form, when it exists) or MANUAL (email and writing) |
| 2 | Verify the identity of the data subject, successor or representative **before** disclosing, correcting or deleting; record the method | — | MANUAL |
| 3 | Classify: query, claim (correction, update, deletion, revocation, breach), or request about Customer Data (goes to 5.2) | — | MANUAL |
| 4a | **Query:** respond | 10 business days from receipt; extension max. 5 business days with notice before the deadline | MANUAL |
| 4b | **Incomplete claim:** ask for it to be completed | Within 5 days of receipt; withdrawn after 2 months without response | MANUAL |
| 4c | **Claim for another competent party:** forward and inform the person concerned | 2 business days | MANUAL |
| 4d | **Complete claim:** mark the data with the legend "claim in process" and its reason | 2 business days from complete receipt | MANUAL (note in the register and in the affected database) |
| 4e | Resolve the claim. If not possible in time, inform the reasons and the new date **before the initial term expires** | 15 business days from the day after receipt; extension max. 8 business days after the first expires | MANUAL |
| 5 | Deletion or revocation: apply at any time without the data subject alleging a breach. Delete from R-01..R-08, or stop using the data for the unnecessary purposes (e.g., commercial), and explain in writing the residual records a legal or contractual duty requires keeping (e.g., invoices, R-02). An opt-out from commercial communications applies immediately, not at case closure | Within the term of 4e | MANUAL; the opt-out, PRODUCT |
| 6 | Close the case with response, date and minimum evidence, without copying the deleted data | — | MANUAL |

Rules: access is free at least once per calendar month and at each substantial change to the POL; "business days" are Monday to
Friday excluding Colombian holidays; the legal representative reviews the request register **every business day** and sets in it
the due date of each case when opening it.
<!-- law: C-08, C-09, C-10, C-11 (Ley 1581 arts. 14 and 15; Decreto 1074 arts. 2.2.2.25.2.6 and 2.2.2.25.4.2) · auth: 19 §Rights requests and privacy complaints; 11 §Billing, team, settings and help ("privacy requests") · prod: UI46 (DESIGN_NOT_RENDERED_PRODUCT); the register has no product command: it is MANUAL (CHECKLIST A-02) · text: POL §9, §10 -->

### 5.2. Queries and claims about Customer Data (Kauro as processor)

Kauro has its own processor duties (Ley 1581 art. 18): handle queries and claims, register legends, not circulate blocked
information. Merely forwarding is not enough.

| Step | What | Legal term | Who |
|---|---|---|---|
| 1 | Receive and open the case in the request register, marked "processor"; verify identity and delimit the request | — | MANUAL |
| 2 | Identify the project (E-01) and the **actual controller** with the recorded chain (DPA §1.2): in the two-party chain, the Customer; in the agency–end client chain, the End Client, reached through the agency. If Kauro no longer holds the data, tell the data subject | — | MANUAL with the processing-authority reference (R2-111) |
| 3 | Incomplete claim: ask for it to be completed | 5 days from receipt | MANUAL |
| 4 | **Complete claim: register the legend "claim in process" and its reason** on the affected project or revision, visible to the Customer and in the Package, and keep it until the decision | 2 business days | PRODUCT (A-17) or, until then, an equivalent MANUAL control: note in the register and retention of the affected Package |
| 5 | Pass to the controller what only it can decide (substance of the correction or deletion) and inform the data subject of the transfer | 2 business days from receipt | MANUAL |
| 6 | Carry out what the controller decides and respond or have the data subject answered. If the term is not enough, give notice of the extension **before the initial term expires** | Queries 10 + 5 business days; claims 15 + 8 business days | MANUAL; execution by PRODUCT (new Revision, exclusion, `RequestDeletion` CMD042, B16) |
| 7 | Update the information the controller reports | 5 business days from receipt | MANUAL until it exists in the product |
| 8 | **"Information under judicial dispute"**: insert the legend in the affected scope when an authority notifies Kauro, or the Customer reports it was notified, of a judicial proceeding about the quality of the data | On receiving the notification | PRODUCT (A-17) or equivalent MANUAL |
| 9 | **Block ordered by the SIC**: prevent circulation of the affected scope (downloads, Package publication, sends to the model, new processing) while the order lasts, without deleting unless the order so provides; record the order and its lifting | On receiving the order | PRODUCT (A-17: block by scope) or equivalent MANUAL: containment by scope under section 5.4 step 2 |
| 10 | Close the case with minimum evidence | — | MANUAL |
<!-- law: C-13, C-13b (Ley 1581 art. 18 lit. c, d, e, g, h, i), C-17 (art. 15 num. 1 and 2) · auth: 19 §Rights requests and privacy complaints ("The agency/controller chain is identified"); 09 §Early deletion; 09 §Deletion receipts and restoration; 14 §Incident containment · prod: CMD042 RequestDeletion (B16); registry R2-111 (chain) · text: DPA §5(d), (j), §12.2, §12.4; POL §12.2 · CHECKLIST A-17 -->

### 5.3. Authorization, notice and proof

1. PRODUCT (B11/B19): account registration and the contact form show the authorization checkbox with links to POL and NOTICE and
   store user, document version and date and time (CHECKLIST A-01).
2. MANUAL: each published version of POL, NOTICE, ToS and DPA is kept with its effective date in Kauro's document repository
   (without personal data) to prove what each data subject accepted.
3. MANUAL: for commercial collaborators, authorization is a document signed at contracting (R-05).
3a. PRODUCT (A-14): authorization for commercial communications is separate, optional, with an unticked checkbox and choice of
   channels; it is stored with purpose, channels, date and version; it does not condition the account, the purchase or the form.
3b. PRODUCT (A-13) + MANUAL: a prospect stores only organization data. An email or phone counts as organization data **only by
   facts, never by its shape**: (a) the organization, a legal entity, publishes it as its commercial contact channel and Kauro
   keeps the evidence (URL, date, capture); (b) it does not identify or attribute to a natural person (no person's name; the
   agency is not a sole-trader merchant or one-person business; it is not a mobile or personal line); (c) it is verified again
   each time it is used. Whoever records it (the legal representative or a seller) marks each fact with its evidence; if any
   fails or cannot be determined, it is personal data. An individual's data is stored only with an authorization record: the
   person filled in the form, or responded in writing to a first message sent to a channel that meets (a)–(c) and that asked for
   that authorization. The rule covers each imported field, the source reference and the notes. Nobody copies names, named emails
   or phones of individuals from websites, directories or networks.
4. Before using data for a new purpose, the POL is updated, notice is given before applying the change and, if the purpose
   changes, a new authorization is requested.
<!-- law: C-04, C-05, C-06, C-18, C-19, C-26, C-51, C-52 (SIC Circular Externa 002 de 2024, instruction IX: publicly accessible is not public in nature; SIC, concept file 23-571469 (corporate data of a legal entity)) · text: POL §6.3, §8, §20; NOTICE · CHECKLIST A-13, A-14, S-22 -->

### 5.4. Security incidents

An incident is any breach of security codes or loss, theft, unauthorized access, manipulation or destruction of personal data,
including the finding of prohibited data (sensitive, of minors, credentials, card) in a CRM file or in email.

| Step | What | Term | Who |
|---|---|---|---|
| 1 | **Detect and open the incident record**: time of detection, who or what alerted | On detection | PRODUCT (alerts of 14 §Monitoring; `RecordIncident` CMD056, UI42, B16) or MANUAL |
| 2 | **Contain by scope**: pause uploads, reviews, purchases, processing, publication or downloads of the affected scope; terminate compromised workers; without opening customer records except support access with a recorded reason | Immediate | PRODUCT (containment controls, B16/B18 `RestrictCapability` CMD059) + MANUAL (decision) |
| 3 | **Assess**: type of incident, date it occurred and was learned of, cause, type of data, number of data subjects, databases (section 4) and Customers affected | Continuous | MANUAL |
| 4 | **Notify the Customer** (data of E-01/E-02): scope, known facts, recommended action, containment and next update; without waiting to confirm or for the root cause and without claiming there was no exposure before verifying; update as it progresses | **Immediately and without undue delay** from when the incident is discovered or there are reasonable grounds to believe it occurred; **never more than 72 hours** from that moment; if a law requires sooner, that term | MANUAL (authorized message; drafting and sending are separate records) |
| 5 | **Report to the SIC** through the application or channel it provides | **Within 15 business days** of detection | MANUAL, coordinated with the Customer when it is Customer Data |
| 6 | **Notify the data subjects** of databases R-01..R-08 when appropriate, with measures to reduce harm. For E-01/E-02 the decision is the Customer's (controller), unless the law obliges Kauro | Without delay | MANUAL |
| 7 | **Repair and recover**; preserve minimum evidence; any retention for an incident carries a reason and review date | — | PRODUCT + MANUAL |
| 8 | **Close**: lesson learned, control change and, if applicable, update of this Manual or PIA_BEDROCK.md | On closing | MANUAL |

Minimum content of the record: database and data compromised, data subjects, date of the incident and of its discovery, cause,
corrective actions and person responsible. The legal representative is the only one authorized to send external notices.
<!-- law: C-14, C-15 (Ley 1581 arts. 17 lit. n and 18 lit. k; Circular Única Title V num. 2.1 lit. f(ii): 15 business days) · auth: 14 §Incident containment; 14 §Monitoring and service health; 18 §Incident communication; 19 §Incident and breach obligations; 19 §Data categories and excluded use (prohibited data: quarantine, notify, do not copy to support or a model) · prod: CMD056 RecordIncident, UI42 Incidents, CMD054/CMD055 break-glass (B16), CMD059 RestrictCapability (B18) · text: DPA §11 (from discovery or reasonable belief, maximum 72 hours: silence resolution S-02, r2; Cal. Civ. Code §1798.82(b) and Va. Code §18.2-186.6(D), CHECKLIST C-67); POL §18 · source: SIC Guide, III.2.4 (incident register: database and data compromised, data subjects, date of incident and of its discovery, corrective actions, persons responsible) and III.2.6 (when reporting: type, date of occurrence and of knowledge, cause, type of data and number of data subjects) -->

### 5.5. Management of processors and sub-processors

1. **Processor register** (section 8): for each provider, legal entity, service, data, purpose, location, retention, contract and
   security evidence, access method, relevant sub-processors, review date and exit plan. If the provider is an independent
   controller (payments, bank, DIAN), it is noted as such and not listed as a processor.
2. **Before adding or changing** a processor that handles Customer Data: review the data flow and the contract (obligations at
   least equivalent to the DPA, including those of DPA §14; incident notice; location), qualify technically, have an exit and
   deletion plan; if it is an AI model, **update PIA_BEDROCK.md before** first use.
3. **Notify Customers** at least **30 days** in advance (platform and email to administrators) with entity, function, data and
   location; handle objections (DPA §8.2). Update POL §13.1 and DPA Annex III before the change takes effect.
4. **Qualify each processor before handing it data** (CHECKLIST A-07): accept the contracts under the company and make, with a
   date, a table per provider showing where each mandatory clause is (content of the transmission contract of Decreto 1074 art.
   2.2.2.25.5.2; sub-processor obligations of 11 CCR §7051(b) and of VA/CO; incident notice; location; deletion; sub-processors),
   which services it covers, what role the provider has and the exceptions; for AWS it includes the AWS CCPA Terms. Archiving the
   contracts is not enough. If a mandatory clause is missing, that provider receives no data until resolved.
5. **Annual review** of each processor: did its DPA, location, retention or sub-processors change? (section 9).
All of this procedure is MANUAL.
<!-- law: C-12 (art. 17 lit. i: require security from the processor), C-21, C-63 (includes AWS CCPA Terms, CHECKLIST V-12), C-65, C-66 · auth: 19 §Subprocessor register; A9 §1 and §3 · text: DPA §8, Annex III; POL §13 · source: SIC Guide, III.2.7 (requirements for processors and mechanisms for them to report incidents) · see LAWYER_LATER L-01 -->

### 5.6. Retention and deletion

1. **Customer Data (E-01, E-02): PRODUCT.** Each object has an anchor and a period; the sweep deletes by generation, checks
   absence against the provider's inventory and issues the deletion receipt (without record values). A PARTIAL deletion stays
   visible with its next retry. MANUAL: the legal representative reviews **every week** the overdue-deletion metric (14
   §Monitoring: "overdue deletion") and acts on any.
2. **Own data (R-01..R-06, R-08): MANUAL** while no automatic sweep exists. The published periods are maximums, so deletion is
   done **before** they expire: **every Monday** (or, if it is a holiday, the next business day) the legal representative
   calculates the actual date of the next run (the following Monday or, if a holiday, the first business day after) and deletes
   **every record whose period expires on that date or before**: accounts that reach 6 months closed (except what belongs to
   R-02); prospects that reach 24 months without interaction (keeps only the opt-out); contact-form leads that reach 12 months
   without interaction; and request cases that reach 5 years closed. If a run is skipped for any reason, it is done the next
   business day with the same calculation and the incident is recorded. Emails containing CRM files are deleted the same day they
   are detected, and an opt-out or revocation is applied immediately. Note in the deletion register: database, criterion,
   quantity and date, without the deleted data.
3. **R-02** is kept at least 10 years (Código de Comercio art. 60); it never contains CRM content.
4. **R-07: PRODUCT** (30 days application logs; 180 days security evidence).
5. **Retention for an incident or by authority order**: only with a reason and review date, recorded; reviewed in the monthly
   cycle.
6. A restore from backup applies tombstones and revocations first (PRODUCT).
<!-- law: C-25 (Decreto 1074 art. 2.2.2.25.2.8), C-38 · auth: 09 §Retention schedule; 09 §Early deletion; 09 §Soft delete, versioning and holds; 09 §Deletion receipts and restoration; 14 §Monitoring and service health · text: POL §15 (silence resolution S-13); ToS §13.1; DPA §13, Annex IV · see LAWYER_LATER L-10 -->

### 5.7. Access to customer records

1. The ordinary support and operations view shows only safe metadata, statuses, hashes and codes.
2. Viewing records requires a **per-case grant** (purpose, project and revision, operations, approver, maximum 30 minutes,
   read-only by default), with recent authentication and audit (PRODUCT, B16: `OpenBreakglass` CMD054 / `RevokeBreakglass`
   CMD055). In a one-person company the requester and the approver coincide: for that reason the reason is written in the grant
   and reviewed in the annual review.
3. **Until that function is in production, nobody accesses customer records.** Defects are reproduced with synthetic or minimized
   data.
4. No data of customers, prospects or data subjects enters programming assistants, repositories, GitHub issues or model services
   other than the minimized Bedrock flow.
<!-- auth: 08 §Support access and break-glass; 08 §Model boundary · prod: CMD054, CMD055 (B16) · text: ToS §12.2; DPA §6 and Annex II (Support, Organization) -->

### 5.8. Use of artificial intelligence models

1. The only AI processing is the bounded proposal step with Amazon Bedrock described in PIA_BEDROCK.md. Its measures and the
   activation checks (CHECKLIST A-04, A-06, A-09, A-10 and A-12) are mandatory.
2. The impact assessment is updated **before**: changing model or provider, changing region or inference profile, raising the
   data level allowed to the model (for example, admitting L3), changing the masking policy, adding memory across customers or any
   new AI use with personal data.
3. Kauro does not use AI to make decisions about people or to profile data subjects.
<!-- law: C-27 (SIC Circular Externa 002 de 2024, instructions III and IV) · auth: 06 §Objective and execution shape; 06 §Scoped memory; A9 §4 -->

### 5.9. Commercial communications and opt-outs

| Step | What | Who |
|---|---|---|
| 1 | Permitted recipients: users and leads with commercial authorization for **that channel**; channels of prospect organizations that meet the three facts of POL §6.3.1, **verified again** before sending; people at agencies or companies with an authorization record (POL §17.1) | PRODUCT (sending gate, A-13, A-14) + MANUAL (re-verification with evidence) |
| 2 | For recipients in Colombia, consult the CRC **Excluded Numbers Registry** **on the same calendar day as the sending** (Bogotá time; a result from a previous day is never reused, because registrations take effect on the next business day) and exclude the registered channels; if the registration is later than the authorization, the authorization is deemed revoked unless a new one is given | MANUAL (consultation on the CRC's procedures platform with Kauro's account) + PRODUCT (marks the exclusion and rejects a result from another day) |
| 2a | **Frequency** for recipients in Colombia, after a direct contact by any channel or person (including sellers and calls): at most one commercial contact per day and a single channel per week. Every direct contact (call, message, response) is recorded in the recipient's contact record | PRODUCT (contact record and per-recipient block across all campaigns, channels and sellers, A-14) + MANUAL (recording of calls and contacts outside the platform) |
| 3 | Template: truthful sender and subject, clear identification as advertising, real postal address, unsubscribe without signing in | PRODUCT (template validation, A-14) |
| 4 | Hours for Colombia: Monday to Friday 7:00–19:00, Saturday 8:00–15:00, never Sundays or holidays | PRODUCT (sending window) |
| 5 | The opt-out applies immediately and survives re-imports and provider changes | PRODUCT (messaging suppression register) |
| 6 | Record the campaign: date, list, result of the RNE consultation, template | MANUAL |
<!-- law: C-50, C-51 (Ley 2300 de 2023 arts. 2, 3 —hours and frequency— and 5), C-52 (SIC Circular Externa 001 de 2024, instructions iii and iv; CRC Resolución 5050 de 2016, art. 2.1.18.1, as amended by CRC Resolutions 7356 de 2024 and 8308 de 2026 (art. 4, in force since 30-Jul-2026)) · auth: 18 §Communication compliance; reference/MESSAGING_AND_SENDER_OPERATIONS.md · text: POL §8.3, §17 · CHECKLIST A-14 -->

### 5.10. Training

| Who | What | When | Record |
|---|---|---|---|
| Legal representative | Re-read this Manual, PIA_BEDROCK.md, the SIC Guide on demonstrated accountability and new SIC circulars or resolutions on personal data | On adopting the Manual and then each year in the annual review | Date and material in the training register |
| Independent sellers | Data-handling rules (only prospect organizations, never the end clients of agency customers, never CRM-file data, opt-outs, not asking for or receiving CRM files, confidentiality) with a practical demonstration of handling an opt-out | Before being activated; refresher when the material changes | Signed acceptance and result of the demonstration |
| Any future person with access to data | General training and the specific one for their role; confidentiality agreement | Before receiving access | Same |
<!-- law: C-24 (Decreto 1074 art. 2.2.2.25.6.2 num. 2: training and education programs) · auth: 12 §Seller onboarding and access lifecycle; 12 §Resources and training (practical demonstration, including the opt-out); 19 §People and engagement administration · source: SIC Guide, III.2.5 (general and specific training, ongoing, with periodic updating) -->

## 6. Security

The technical and organizational measures are those of DPA Annex II and POL §14. This Manual adds only the legal
representative's obligations: MFA on all of Kauro's accounts (AWS, Google Workspace, GitHub, Resend, Wise, Cloudflare); no
long-lived static keys; review monthly the active seller accesses and remove those not in use. The measures must be
demonstrable to the SIC (configuration and test evidence).
<!-- law: C-12 (art. 17 lit. d), C-13 (art. 18 lit. b) · auth: 08 §Authentication and assurance; 08 §Secrets and supply chain; 12 §Seller onboarding and access lifecycle · source: SIC Circular 002 de 2024, instruction VIII (auditable measures); Decreto 1074 art. 2.2.2.25.6.1 (evidence of security measures at the SIC's request) -->

## 7. National Database Registry (RNBD)

Before starting operations (CHECKLIST A-16), and then at each annual review with the closed year's balance sheet, the legal
representative compares the company's total assets, per its balance sheet, with 100,000 UVT of the year and files the balance
sheet used and the date. A newly incorporated company is not presumed to be below it. If it exceeds it, the representative
registers the databases of section 4.1 within the period the SIC sets and checks whether the pending Title V resolution has
been adopted.
<!-- law: C-16 · CHECKLIST §6 (SIC draft resolution of 2026-05-26) · see LAWYER_LATER L-14 -->

## 8. Program records

All are kept in Kauro's Google Workspace space with access only for the legal representative, except those kept by the platform.
None contains CRM content.

| Record | Content | Where | Retention |
|---|---|---|---|
| Data subject requests (R-06) | Section 5.1 step 6 and 5.2 | Google Workspace | 5 years from closure |
| Incidents | Section 5.4 | Platform (CMD056, B16) or Google Workspace until then | 180 days as security evidence, or more with a recorded reason; reports to the SIC, 5 years |
| Processors | Section 5.5 | Google Workspace | While the provider is used and 5 years after |
| Deletion of own data | Section 5.6 step 2 | Google Workspace | 5 years |
| Deletion receipts for Customer Data | 09 §Deletion receipts | Platform | Per the platform's schedule |
| Support access grants | Section 5.7 | Platform (B16) | Security evidence |
| Training | Section 5.10 | Google Workspace | For the duration of the relationship and 5 years |
| Document versions | Section 5.3 step 2 | Kauro's document repository | Permanent |
| Annual review and impact assessment | Sections 9 and PIA_BEDROCK.md | Kauro's document repository | Permanent |
<!-- auth: 19 §Rights requests and privacy complaints (minimum evidence); 08 §Audit events and retention; 09 §Retention schedule · resolution: 5-year periods for records = that of POL §15 for requests (S-13) -->

## 9. Annual review and oversight

9.1. **Annual review**, in the anniversary month of the effective date, by the legal representative, with a signed minute that
answers:
1. What threats, incidents, complaints or findings were there and what was changed?
2. Is the inventory in section 4 still accurate (data, purposes, systems, processors, periods)?
3. Are there new services that collect, use or share more data?
4. Were the deadlines of the request, deletion and incident registers met? (indicators: requests handled on time / total;
   overdue deletions; incidents and days to report)
5. Did the law, the SIC's instructions or the processors' contracts and retention change (especially AWS Bedrock)?
6. Is PIA_BEDROCK.md still current and do checks A-06, A-09, A-10 and A-12 pass?
7. Does Kauro exceed the RNBD threshold (section 7)?
8. Was the training of section 5.10 done?

9.2. **Extraordinary review** before: a change of processor, AI model or region; a new type of data or data subject (for
example, EU residents); a change of the POL; and after any incident.
<!-- law: C-24 · source: SIC Guide, IV.A (oversight plan and annual review with a calendar for reviewing policies and controls at least once a year) and IV.B (monitoring questions) · silence resolution S-19 (the authority sets neither training nor annual review) -->

## 10. Adoption

Adopted by the legal representative of Kauro Data S.A.S., who assumes the function of data protection officer.

Legal representative of Kauro Data S.A.S. (name at signing, decision D-16) · Signature: ______________________ · Date: [effective date]
<!-- see CHECKLIST A-03 -->
