<!--
D-08b · Kauro Personal Data Processing Policy (Ley 1581 de 2012; Decreto 1377 de 2013 compiled in Decreto 1074 de 2015, art.
2.2.2.25.3.1). English master (owner rule 2026-10-07); a Spanish secondary translation is kept in es/ because Colombian law
requires the habeas-data policy in Spanish. Draft by the builder without a lawyer (decision D-08b, option 1).
Traceability: `auth:` = authority/r2; `law:` = CHECKLIST.md row. Allowed placeholders: [NIT], [registered address],
[notice email], [effective date], [phone] (see LAWYER_LATER F-05).
-->

# Personal Data Processing Policy

**Version:** 1.0 · **Effective from:** [effective date]

## 1. Data controller

| Item | Value |
|---|---|
| Legal name | Kauro Data S.A.S. |
| NIT | [NIT] |
| Domicile and address | [registered address] |
| Email | [notice email] |
| Phone | [phone] |
| Website | kaurodata.com |
<!-- law: C-03 (Decreto 1074 art. 2.2.2.25.3.1 num. 1: name, domicile, address, email and phone) · auth: A8 §1; A4 §Owner acts; 19 §BusinessProfile and legal facts -->

## 2. Legal framework and scope

This Policy complies with Statutory Law 1581 of 2012, Decreto 1377 of 2013 (compiled in Chapter 25 of Decreto 1074 of 2015) and
the instructions of the Superintendencia de Industria y Comercio (SIC). It applies to the databases containing personal data of
which **Kauro is the controller** and, as applicable, to the data Kauro processes as **processor** on behalf of its customers
(section 12).
<!-- law: C-01, C-02 -->

## 3. Definitions

The definitions of article 3 of Ley 1581 de 2012 are used: authorization, database, personal data, processor, controller, data
subject and processing. In addition: **transfer** is the sending of data to a recipient that is itself a controller;
**transmission** is the communication of data to a processor so that it processes them on the controller's behalf.
<!-- law: C-01 (Ley 1581 art. 3); C-20 (Decreto 1074 art. 2.2.2.25.5.1) -->

## 4. Principles

Kauro applies in a harmonious way the principles of legality, purpose, freedom, truthfulness or quality, transparency, restricted
access and circulation, security and confidentiality of article 4 of Ley 1581 de 2012, and the principle of demonstrated
accountability. In practice: it collects only the data necessary for each purpose; it sends to sellers, analytics, notifications,
logs and development tools no more data than necessary; and it does not use customer data in development assistants,
repositories or unpaid model services.
<!-- law: C-01 (art. 4), C-24 (Decreto 1074 art. 2.2.2.25.6.1) · auth: 01 CH-006 -->

## 5. Kauro's roles

- **Controller:** of the data of its customers as companies and of their users, of leads and prospects, of its commercial
  collaborators and providers, of those who exercise rights before Kauro and of security records (section 6).
- **Processor:** of the personal data contained in the CRM exports and spreadsheets that customers upload for preparation, and
  of their derivatives. In that case the controller is the customer or the customer's end client, and the processing is
  governed by the Data Processing Agreement (DPA) signed with the customer (section 12).
<!-- auth: 19 §Data processing agreement; 01 §Purpose and customer promise (A3 §4.1); product: brief D-08b -->

## 6. Databases, data processed and purposes (Kauro as controller)

### 6.1. Customers and platform users

- **Data subjects:** administrators and invited users of customer agencies and companies.
- **Data:** name, work email, company, role and permissions, language; email and second-factor verification information (Kauro
  keeps no clear-text passwords and shows no recovery codes outside the secure flow); record of acceptance of the contract
  documents; activity on the platform and security events (actor, scope, action, result and date); declared buyer type (agency
  or in-house team).
- **Purposes:** (a) create and manage the account, memberships and permissions; (b) provide the contracted service and support;
  (c) authenticate and protect access; (d) send transactional service notices (invitations, processing status, payments,
  deliveries, deletion notices, support); (e) apply recurrence discounts and founding slots; (f) measure usage in aggregate by
  segment; (g) comply with legal obligations and respond to authority requests; (h) only if the user authorizes it separately
  (section 8.3), send commercial communications about Kauro through the channels it authorized; and (i) prevent abuse and fraud.
<!-- auth: 02 §2; 08 §Authentication and assurance; 08 §Audit events and retention; 11 §Agency onboarding; 16 §Recurrence decision; A3 §3.7 (buyer type); reference/MESSAGING_AND_SENDER_OPERATIONS.md (transactional notices via Resend) -->

### 6.2. Billing, payments and accounting

- **Data subjects:** representatives and billing contacts of customers; people named in payments and transfers.
- **Data:** legal name, tax identification, billing address, billing contact, order data, payment references and statuses, the
  payer's name and reference in received transfers, refunds and disputes. Kauro does not receive or keep card numbers.
- **Purposes:** collect, reconcile payments, issue electronic invoices and notes, manage refunds and disputes, keep the books and
  meet tax and commercial obligations.
<!-- auth: 15 §Money vocabulary; 15 §FiscalProfile ("collects only billing facts necessary"); 15 §Disputes and chargebacks; A8 §1, §3 -->

### 6.3. Leads and prospects

- **Data subjects:** people who fill in the site's contact form, and people at **prospect organizations** (agencies and
  companies) who authorized Kauro to contact them.
- **Data:** from the form: name, email and company, buyer type, target, approximate record band and desired date (the form
  accepts no CRM files). From prospect organizations (agencies and companies), **organization data only**: organization
  name, domain, country, source and date of observation, bounded commercial notes without data of individuals, opt-out
  status and, as a contact channel, only an email or phone that meets **all three facts** of section 6.3.1. Any data of an
  individual (name, title, email, phone) is processed **only after that person authorizes** the processing, and Kauro keeps the
  proof.
- **6.3.1. When a channel is the organization's.** An email or phone is organization data, and not personal data, only if all
  three of the following facts are met, verified and recorded, never inferred from the shape of the email or number: (a) the
  organization itself, which is a legal entity, publishes it as its commercial contact channel, and Kauro keeps the evidence
  (web address, date and capture); (b) it does not identify or cannot be attributed to a natural person: it does not contain a
  person's name, the organization is not a sole-trader merchant or a one-person business, and the number is not a mobile or personal
  line; and (c) Kauro re-verifies (a) and (b) each time it is about to use it. If any of the three fails or cannot be determined,
  the channel is **personal data** and requires prior authorization. The same rule applies to each imported field, to the source
  reference and to the notes.
- **Purposes:** answer requests; assess whether the project fits the service; contact the organization through its organization
  channels (section 6.3.1) to present the service and, if a person wants to continue the conversation, ask for authorization;
  send commercial communications only under section 17; and record opt-outs to always respect them.
- **Limits:** Kauro prospects only organizations (agencies and companies), never individuals for their personal use. It never
  researches, records as a prospect or contacts for sale the end clients of its agency customers, and never uses information
  received from an agency customer to do so. **It does not collect from websites, directories or social networks names, named
  emails or direct phones of individuals to prospect them.** It does not use the data in its customers' CRM files for commercial
  purposes.
<!-- auth: 02 §1 Discover and qualify fit; 12 §Prospect record (contact person "where appropriate": restricted by the coordinator's decisions of 2026-10-06, CHECKLIST S-22); 18 §Prospect qualification; 18 §Communication compliance ("Publicly available contact details do not automatically authorize every use"); 16 §Offer and buyer fit; A3 §3.7 as superseded in part by D-33 (docs/authority/decisions/2026-10-13-COMMERCIAL-SCOPE.md; wording changed 2026-10-13, pending competent review, D-31) · law: C-04, C-06, C-19 (Ley 1581 arts. 3 lit. c, 9 and 10; SIC Circular 002 de 2024, instruction IX; SIC, concept file 23-571469 (corporate data of a legal entity)) · CHECKLIST A-13 -->

### 6.4. Commercial collaborators and providers

- **Data subjects:** independent sellers, candidates to be sellers, individual providers and provider contacts.
- **Data:** identification, contact, contractual information, required tax and social-security documents, bank details for
  payments, commission settlements and their support.
- **Purposes:** select and contract, manage the relationship, calculate and pay commissions or fees, meet tax and accounting
  obligations and handle disputes. Identity, bank and tax documents are kept with access restricted to finance and are never
  included in prospect exports or review packages.
<!-- auth: 17 §Currency, fees and tax documentation; 17 §Legal engagement packet; 12 §Seller onboarding and access lifecycle -->

### 6.5. Requests, queries and claims

- **Data:** requester identification, type of request, dates, verification applied, scope, response and closure.
- **Purpose:** handle and document the exercise of rights and complaints, keeping the minimum evidence without keeping the data
  that was deleted.
<!-- auth: 19 §Rights requests and privacy complaints -->

### 6.6. Security and technical records

- **Data:** security events and application logs with actor, scope, action, result and date identifiers. They contain no CRM
  content, passwords or secrets.
- **Purpose:** protect the service, investigate incidents and demonstrate compliance.
<!-- auth: 08 §Audit events and retention; 09 §Retention schedule -->

## 7. Sensitive data and data of children and adolescents

Kauro does not request sensitive data in any of the databases in section 6 and does not process data of children or
adolescents; the service is for companies only. If a data subject decides to provide sensitive data, answering is optional.
Customers are prohibited from uploading sensitive data and data of minors in CRM files (Terms of Service, section 5.2).
<!-- law: C-07 (Ley 1581 arts. 5, 6 and 7; Decreto 1074 art. 2.2.2.25.2.3) · auth: 19 §Data categories and excluded use -->

## 8. Authorization

8.1. Kauro requests the data subject's prior, express and informed authorization at the time of collection, by a means that
allows it to be consulted later: an acceptance checkbox at account registration and on the contact form, with a link to this
Policy and the Privacy Notice; or a signed document when contracting collaborators. Kauro keeps the proof of authorization.

8.2. Authorization is not required in the cases of article 10 of Ley 1581 de 2012, among them data of a public nature and
information required by an authority in the exercise of its functions. Data accessible to the public, for example on a website,
is not for that reason of a public nature; therefore Kauro does not process data of contact persons for prospecting without their
authorization (section 6.3). The authorization of a person at a prospect organization is obtained when that person fills in the contact
form themselves, or when they respond in writing to a first message sent to an organization channel that meets section 6.3.1
and that asks for that authorization; Kauro keeps the response as proof.
<!-- law: C-04, C-05, C-06, C-19 (Ley 1581 arts. 9 and 10; Decreto 1074 arts. 2.2.2.25.2.2, 2.2.2.25.2.4 and 2.2.2.25.2.5; SIC Circular Externa 002 de 2024, instruction IX) · CHECKLIST A-13, S-22 -->

8.3. **Commercial communications: separate and optional authorization.** Authorization to receive commercial communications from
Kauro is requested separately from the authorization to provide the service, with a checkbox not pre-ticked; it is not a
condition for creating the account, using the platform, buying or filling in the form. The data subject chooses the channels it
authorizes (email, call, SMS or messaging) and may revoke it at any time. Kauro records the purpose, the channels, the date and
the version of the text accepted.
<!-- law: C-51 (Ley 2300 de 2023 arts. 2 and 5, paragraph 2), C-52 (SIC Circular Externa 001 de 2024, instruction iii) · CHECKLIST A-14 -->

## 9. Rights of data subjects

The data subject may: (a) know, update and rectify its data before Kauro, including partial, inaccurate, incomplete, fractioned
or misleading data, or data whose processing was not authorized; (b) request proof of the authorization, except where it is not
required; (c) be informed, on request, of the use made of its data; (d) file complaints with the Superintendencia de Industria y
Comercio, after exhausting the query or claim procedure before Kauro; (e) request at any time the deletion of its data and/or
revoke the authorization by claim, without needing to allege a breach, except for the applicable legal or contractual duty to
remain in the database; and (f) access its data free of charge at least once per calendar month and each time there are
substantial changes to this Policy. If a duty to remain prevents total deletion, Kauro stops using the data for the purposes that
are not necessary to meet that duty (for example, commercial communications).
<!-- law: C-08 (Ley 1581 arts. 8 and 16), C-09 (Decreto 1074 art. 2.2.2.25.4.2), C-11 (Decreto 1074 art. 2.2.2.25.2.6: revocation and deletion at any time) -->

## 10. Procedure for queries and claims

10.1. **Channel.** Requests are sent to [notice email], or in writing to [registered address], or from the privacy section of the
account on the platform. Kauro verifies the identity of the data subject or its successor or representative before disclosing,
correcting or deleting data.
<!-- auth: 11 §Billing, team, settings and help ("privacy requests"); 19 §Rights requests and privacy complaints -->

10.2. **Queries.** They are answered within a maximum of ten (10) business days from receipt. If that is not possible, Kauro
informs, before the deadline, the reasons and the new date, which will not exceed five (5) additional business days.

10.3. **Claims** (correction, update, deletion or alleged breach). The claim must include the data subject's identification, the
description of the facts, the address and the documents it wants to rely on. If it is incomplete, Kauro asks for it to be
completed within five (5) days of receipt; if two (2) months pass without a response, the claim is deemed withdrawn. If Kauro is
not competent to resolve it, it forwards it to the one who is within a maximum of two (2) business days and informs the person
concerned. Once the complete claim is received, Kauro adds to the database the legend "claim in process" and its reason within a
maximum of two (2) business days, and keeps it until it decides. The term to handle it is fifteen (15) business days from the day
after receipt; if that is not possible, Kauro informs the person concerned, **before the initial term expires**, of the reasons
and the new date, which will not exceed eight (8) business days after the expiry of the first term.

10.4. **Deletion and revocation.** They may be requested at any time. They do not apply when the data subject has a legal or
contractual duty to remain in the database (for example, invoices and accounting records the law requires to be kept). In that
case Kauro deletes or stops using everything else, and explains what residual records it keeps and why.
<!-- law: C-10 (Ley 1581 arts. 14 and 15), C-11 (Decreto 1074 art. 2.2.2.25.2.6, revocation and deletion) · auth: 19 §Rights requests and privacy complaints (last paragraph) -->

## 11. Area responsible for data protection

The personal data protection function is assumed by Kauro's legal representative, who receives and handles data subjects'
requests through the channels in section 10.1.
<!-- law: C-09b (Decreto 1074 art. 2.2.2.25.4.4: designate a person or area) · silence resolution S-14 -->

## 12. Data Kauro processes as processor (CRM files)

12.1. When an agency or company uploads CRM exports, the controller of that data is the customer or its end client. Kauro
processes it only to prepare it according to the customer's instructions, does not use it for its own purposes, does not sell or
share it, does not use it to train models and deletes it within short periods (between 24 hours and 30 days depending on the
stage; the full schedule is in the Terms of Service, section 13).

12.2. If you are a person whose data appears in the CRM of a Kauro customer, you may direct your query or claim to the company
you have a relationship with (the controller) or to Kauro. If you file it with Kauro, Kauro, as processor: verifies your
identity; identifies the project and the controller according to the recorded chain (when Kauro's customer is an agency, the
controller is that agency's end client and the request is passed to it through the agency); within two (2) business days after
receiving a complete claim, marks the affected data with the legend "claim in process" and its reason; passes to the controller
what only it can decide and informs you of the transfer; and carries out and communicates to you what applies within the terms
of section 10. Kauro also marks the legend "information under judicial dispute" when an authority notifies it of a judicial
proceeding about the quality of the data, and does not circulate information whose blocking the Superintendencia de Industria y
Comercio orders. Kauro keeps the data only for the duration of the project, so it may no longer have it; in that case it tells
you so.

12.3. To prepare the data, Kauro may send to a language model hosted on Amazon Bedrock (Amazon Web Services, in the United
States) only minimized context: structure, aggregate data, approved vocabulary and masked examples. It never sends raw records,
credentials or secrets, and the model makes no decisions: the customer approves them.
<!-- auth: 19 §Data processing agreement; 06 §Privacy classes and minimization; 09 §Retention schedule; 19 §Rights requests and privacy complaints ("The agency/controller chain is identified"); A9 §3 · law: C-13, C-13b, C-17 (Ley 1581 arts. 15 and 18 lit. e, g, h, i) -->

## 13. International transmissions and transfers

13.1. Kauro uses processors (providers that process data on its behalf), some of them located in the United States:

| Processor | Function | Data | Location |
|---|---|---|---|
| Amazon Web Services, Inc. | Hosting, database, storage, identity, logs and language models (Amazon Bedrock) | All of those in section 6 that the platform stores; CRM files as sub-processor | United States |
| Resend | Transactional email for the service (Kauro's processor for its users' data; receives no CRM files) | User's email and name and minimal notice content, without CRM records | United States |
| Google LLC (Google Workspace) | Kauro's corporate email (support, sales, administration) and internal records of requests, incidents and training | Contact data, content of correspondence and data in internal records (no CRM files) | Per Google's infrastructure |
| Electronic-invoicing provider Kauro uses before the DIAN | Issuance and validation of invoices and notes | Billing data (section 6.2) | Colombia |
<!-- Google Workspace internal records: INTERNAL_DATA_MANUAL §8 (silence resolution S-20) · auth: A9 §1 and §3; 19 §Subprocessor register; reference/MESSAGING_AND_SENDER_OPERATIONS.md; 15 §Accounting integration decision (Alegra candidate or DIAN route) · silence resolution S-05 (tax provider not chosen) -->

13.2. Kauro communicates payment data to **Wise**, and operates with its bank **Bancolombia**; these entities process that data as
independent controllers under their own policies, because they provide regulated financial services. Kauro also delivers to the
DIAN the information the tax law requires.
<!-- auth: A8 §1; 19 §Subprocessor register (provider as independent controller); 15 §TaxDocument state machine -->

13.3. Communications of data to processors abroad are **transmissions** and are governed by contracts that oblige the processor
to process the data according to the principles of Ley 1581 and this Policy, to protect the security of the databases and to keep
confidentiality. The United States appears on the SIC's list of countries with an adequate level of protection. Kauro does not
transfer personal data to third-party controllers outside Colombia other than those indicated in section 13.2.
<!-- law: C-20, C-21, C-22, C-23 · CHECKLIST A-07 (r2: dated mapping of mandatory clauses per provider before handing over data); see LAWYER_LATER L-01 (only gaps the mapping finds) -->

## 14. Security

Kauro applies technical, human and administrative measures to prevent adulteration, loss, unauthorized consultation, use or
access: mandatory second factor, per-customer isolation in the database, encryption in transit and at rest, short-lived
credentials, least privilege, audit logs without sensitive content and verified deletion. The full description is in Annex II of
the DPA.
<!-- law: C-12 (art. 17 lit. d), C-13 (art. 18 lit. b) · auth: 08 (all sections cited in DPA Annex II) -->

## 15. Retention

| Database | Period |
|---|---|
| Customers and users | While the account is active and up to six (6) months after its closure, except data that must be kept on another basis |
| Billing, payments and accounting | At least ten (10) years, because of the merchant's duty to keep books and papers (Código de Comercio, art. 60) |
| Prospects | Organization data and data of people who authorized contact: until opt-out or revocation, or twenty-four (24) months without interaction, whichever comes first; the opt-out is kept to respect it |
| Contact-form leads | Twelve (12) months from the last interaction if they do not become customers |
| Commercial collaborators | During the relationship and for the later statutory tax and accounting periods |
| Requests and claims | Five (5) years from closure, with the minimum evidence |
| Application logs | Thirty (30) days |
| Security evidence | One hundred eighty (180) days, except retention for an incident with reason and review date |
| CRM files (as processor) | Per the schedule in the Terms of Service, section 13 |

The periods are maximums: Kauro deletes each record before its period expires, and applies an opt-out or revocation immediately.
<!-- auth: 09 §Retention schedule (logs 30 days, security 180 days, financial by legal period, CRM); law: C-25 (Decreto 1074 art. 2.2.2.25.2.8 time limitation), C-38 (C. Co. art. 60) · silence resolution S-13 (periods for accounts, prospects, form and requests not set by the authority) -->

## 16. Cookies and similar technologies

The platform uses a strictly necessary session cookie to keep the session signed in and to protect against request forgery. As of
the effective date, Kauro uses no advertising or third-party tracking cookies. If that changes, Kauro will update this Policy
before using them.
<!-- auth: 08 §Authentication and assurance (Secure, HttpOnly, SameSite session cookies); 13 §Privacy in reports and downloads (preview in third-party analytics prohibited); design B11 D-AUTH-1 and D-PRIV-1 (docs/design/B11-agency-app.md) · silence resolution S-15 -->

## 17. Commercial communications

17.1. **To whom.** Kauro sends commercial communications only (a) to users and leads who authorized them separately (section 8.3),
through the channels they authorized; (b) to the channels of a prospect organization that meet the three facts of section 6.3.1,
verified again before sending; and (c) to people at an agency or company who authorized that contact. It never obliges anyone to accept
advertising to obtain the service.

17.2. **CRC Excluded Numbers Registry.** Before each commercial sending by email, call, SMS or messaging to recipients in
Colombia, Kauro consults the Excluded Numbers Registry (RNE) of the Communications Regulation Commission (CRC) **on the same
calendar day as the sending (Bogotá time)** and excludes the registered channels. Because a registration takes effect on the next
business day, a result from a previous day is never reused. An authorization prior to a channel's registration in the RNE is
deemed revoked, unless the data subject gives a new authorization after registering.

17.2A. **Frequency after a direct contact.** Once a direct contact with a recipient in Colombia is established, through any
channel and by any person acting for Kauro (including sellers), Kauro does not contact it again for commercial purposes more
than once on the same day, nor through more than one channel in the same week. Kauro keeps a contact record per recipient
covering all campaigns, channels and sellers.

17.3. **Form and hours.** Each message truthfully identifies the sender and the subject, is clearly identified as advertising
when it is, includes Kauro's real postal address and an unsubscribe mechanism that does not require signing in. The opt-out
applies immediately and survives reassignments, list re-imports and provider changes. Transactional service notices include no
disguised advertising. For recipients in Colombia, Kauro sends commercial messages only Monday to Friday from 7:00 a.m. to
7:00 p.m. and Saturdays from 8:00 a.m. to 3:00 p.m., never on Sundays or holidays.
<!-- auth: 18 §Communication compliance ("required commercial identification"; "Publicly available contact details do not automatically authorize every use"); reference/MESSAGING_AND_SENDER_OPERATIONS.md (unsubscribe without login, immediate suppression) · law: C-50 (CAN-SPAM, FTC), C-51 (Ley 2300 de 2023 arts. 2, 3 —hours and frequency— and 5), C-52 (SIC Circular Externa 001 de 2024, instructions iii and iv; CRC Resolución 5050 de 2016, art. 2.1.18.1, as amended by CRC Resolutions 7356 de 2024 and 8308 de 2026 (art. 4, in force since 30-Jul-2026)) · CHECKLIST A-14 -->

## 18. Security incidents

Kauro manages incidents with a record of detection, impact, containment, communication and recovery; it reports to the SIC
breaches of security codes within fifteen (15) business days after detection and notifies affected data subjects and customers
when appropriate.
<!-- law: C-14, C-15 · auth: 14 §Incident containment; 19 §Incident and breach obligations -->

## 19. National Database Registry (RNBD)

Registration in the National Database Registry (Registro Nacional de Bases de Datos) is mandatory for companies with total assets
above 100,000 UVT. Kauro determines its total assets from its balance sheet before starting operations and then at each annual
close; while they do not exceed that threshold it is not obliged to register, and if they do it will register its databases
within the period the SIC sets. Its other data protection duties do not depend on that registration.
<!-- law: C-16 (Decreto 1074 art. 2.2.2.26.1.2, amended by Decreto 090 de 2018) · CHECKLIST A-16 -->

## 20. Validity and changes

This Policy is in force from [effective date]. The databases remain in force for the purposes in section 6 and the periods in
section 15. Kauro will inform data subjects of substantial changes through the platform, by email or on the website before
applying them and, when they affect the purpose, will request a new authorization.
<!-- law: C-03 (Decreto 1074 art. 2.2.2.25.3.1 num. 6 and paragraph), C-26 (art. 2.2.2.25.2.2 on new authorization for change of purpose) -->
