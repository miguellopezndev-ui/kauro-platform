<!--
D-08b · Data Processing Agreement, English version of DPA.md. Both versions have equal force (Terms §24.4); any change to one is
made to the other in the same commit. Traceability comments are the same as in DPA.md (`auth:` = authority/r2, `law:` = row of
CHECKLIST.md). Placeholders: [NIT], [domicilio], [correo de notificaciones], [fecha de vigencia], [teléfono] (see LAWYER_LATER F-05);
they are kept in Spanish so one fill-in serves both versions.
-->

# Data Processing Agreement (DPA)

**Version:** 1.0 · **Effective from:** [fecha de vigencia]

This Agreement is part of Kauro's Terms of Service (the "Terms") and is accepted electronically by the Customer and by **Kauro
Data S.A.S.**, Colombian tax ID (NIT) [NIT], registered address [domicilio], email [correo de notificaciones] ("Kauro").
Capitalized terms not defined here have the meaning given in the Terms.

This Agreement is the **personal-data transmission contract** required by article 2.2.2.25.5.2 of Colombian Decree 1074 of 2015
(formerly article 25 of Decree 1377 of 2013) and, for Customers subject to US state privacy laws, the service-provider or
processor contract those laws require (section 14).
<!-- law: C-20, C-21, C-60..C-66 -->

## 1. Roles and processing chain

1.1. **Kauro is a processor.** For personal data contained in the Files the Customer uploads and in everything derived from them
(profiles, duplicate indexes, lineage, exceptions, minimized context, Packages, reports and import receipts) ("Customer Data"),
Kauro acts as processor ("encargado del tratamiento" / "service provider") and processes the data only on the Customer's behalf.
<!-- auth: 19 §Data processing agreement; 09 §Derived data and worker scratch -->

1.2. **Recorded chain.** When creating each end client and each project, the Customer records in the Platform the applicable chain
of roles:
- **Agency–end-client chain:** the End Client is the controller of its CRM data, the Customer (agency) acts as its processor and
  Kauro is the Customer's sub-processor. The Customer warrants that its contract with the End Client allows it to engage Kauro as
  a sub-processor on the terms of this Agreement, including the sub-processors in Annex III and the transmissions in section 10.
- **Two-party chain:** where the Customer is the controller of the data (an In-house Customer processing its own company's data,
  or an agency processing its own business data), the Customer is the controller and Kauro its processor.

Kauro does not presume that the Customer owns all data. A generic "I am the controller" checkbox is not enough: the Platform
records the Customer's authority over each end client's data (processing-authority reference).
<!-- auth: 19 §Data processing agreement (as amended by A3 §4.7); A3 §3.7; registry/additional_scenarios.json R2-111 -->

1.3. **Kauro is controller of its own data.** Data about the Customer's accounts and users, billing, payments, support, security
and communications with Kauro is not Customer Data: Kauro processes it as controller under its Personal Data Processing Policy.

## 2. Description of processing (Annex I)

The subject matter, nature, purpose, types of personal data, categories of data subjects and duration of processing are described
in Annex I, which forms part of the Customer's documented instructions.

## 3. Customer instructions

3.1. Kauro processes Customer Data only on the Customer's documented instructions. Instructions are: (a) this Agreement and the
Terms; (b) every upload, worksheet selection, sealing, Plan approval, semantic decision, purchase, download, import receipt,
extension, deletion request and support-access grant made in the Platform by an Authorized User; and (c) any additional written
instructions Kauro accepts.
<!-- auth: 19 §Data processing agreement; 02 §4–§10; 08 §Support access and break-glass -->

3.2. Kauro will inform the Customer if it considers that an instruction infringes applicable law or exceeds the qualified
service, and may suspend executing it while it is clarified. Kauro will reject, or review separately, instructions to retain data
indefinitely, process unsupported sensitive data or send raw records to an unapproved model.
<!-- auth: 19 §Data processing agreement; 19 §Service terms -->

3.3. **Prohibited uses.** Kauro does not: (a) sell or share Customer Data; (b) retain, use or disclose it for any purpose other than
the business purposes in Annex I; (c) retain, use or disclose it outside the direct business relationship with the Customer; (d)
combine it with personal data received from other customers or collected from its own interaction with data subjects; (e) use it
to train or improve language models; (f) use it to contact, profile or sell to data subjects or to the End Client.
<!-- law: C-61, C-62 · auth: 06 §Scoped memory; 16 §Offer and buyer fit; A3 §3.7 -->

3.4. **Non-personal synthetic derivatives.** Kauro does not create evaluation cases, global rules or other derivatives from
Customer Data unless the Customer authorizes it in writing for a specific project. Even with that authorization, the derivative
must be stripped of all personal data and all Customer confidential data, is reviewed before use and does not allow anyone to be
re-identified. Without authorization, Kauro keeps only non-personal rules that already existed or that are built from synthetic
data.
<!-- auth: 06 §Scoped memory; 09 §Retention schedule (minimized model context row) -->

## 4. Customer obligations

The Customer: (a) gives Kauro only data whose processing is authorized under the law applicable to it and to the End Client; (b)
ensures, to the extent within its control, that the data is accurate and current and informs Kauro in time of updates,
rectifications and deletions that must be reflected; (c) does not upload the prohibited categories in section 5.2 of the Terms;
(d) answers data-subject requests as controller, or forwards them to the End Client; (e) gives data subjects any notice the law
requires about the use of processors; and (f) requires Kauro to respect security and privacy conditions.
<!-- law: C-12 -->

## 5. Kauro obligations

Kauro, as processor: (a) processes Customer Data on the Customer's behalf in accordance with the principles of Colombian Law 1581
of 2012 (legality, purpose, freedom, accuracy, transparency, restricted access and circulation, security and confidentiality) and
with the controller's processing policy as applicable to the engagement; (b) safeguards database security with the measures in
Annex II; (c) keeps confidentiality; (d) carries out in time the updates, rectifications or deletions the Customer instructs and
updates information reported by the Customer within five (5) business days of receipt; (e) allows access only to authorized
persons; (f) maintains an internal manual of policies and procedures; (g) reports breaches of security codes to the Colombian
Superintendence of Industry and Commerce (SIC) under section 11; (h) complies with the authority's requests; and (i) complies with
the applicable US obligations in section 14 and gives Customer Data the same level of protection those laws require; and (j)
handles data subjects' claims, records the "reclamo en trámite" (claim in progress) and "información en discusión judicial"
(information under judicial dispute) legends and refrains from circulating information whose blocking the SIC has ordered, as set
out in section 12.
<!-- law: C-13, C-13b, C-21, C-62 -->

## 6. Personnel confidentiality

Kauro ensures that every person authorized to process Customer Data (its staff and collaborators with access) is subject to a duty
of confidentiality. Sellers, ordinary owner views, analytics, notifications, logs and development tools receive only the minimum
facts they need; no customer record enters development assistants, repositories or unpaid model services. Support access to
records follows section 12.2 of the Terms.
<!-- auth: 01 CH-006; 08 §Model boundary; 08 §Support access and break-glass; 13 §Privacy in reports and downloads · law: C-64, C-65 -->

## 7. Security measures

Kauro applies the technical and organizational measures in Annex II, appropriate to the nature of Customer Data and to the risk.
Kauro may change them provided the level of protection does not decrease.
<!-- law: C-13, C-62, C-66 -->

## 8. Sub-processors

8.1. **General authorization.** The Customer authorizes Kauro to use the sub-processors in Annex III for the functions and data
stated there. Kauro enters into a written contract with each sub-processor imposing data-protection obligations at least
equivalent to this Agreement, including those required by section 14, and remains liable to the Customer for their performance.
<!-- auth: 19 §Data processing agreement; 19 §Subprocessor register · law: C-63, C-65, C-66 -->

8.2. **Changes.** Kauro will notify the Customer, in the Platform and by email to its administrators, at least thirty (30) days in
advance of adding or replacing a sub-processor that processes Customer Data, stating the entity, function, data and location. The
Customer may object in writing, on reasonable data-protection grounds, within that period. If the parties cannot resolve the
objection, the Customer may terminate the affected Orders not yet executed and receive a refund of what it paid for them.
<!-- auth: 19 §Subprocessor register · law: C-66 (C.R.S. 6-1-1305(3)(b), 2026 text: opportunity to object; Virginia B.5 requires only a written contract, the objection right goes further) -->

8.3. **Who is not a sub-processor.** Payment providers (PayPal, Wise) and Kauro's bank act as independent controllers of the
payment data they process for their own regulated purposes and do not receive Customer Data. Kauro's sales collaborators do not
receive Customer Data.
<!-- auth: 19 §Subprocessor register; 13 §Privacy in reports and downloads; A8 §1 -->

## 9. Data location

Customer Data is stored and processed in Amazon Web Services regions located in the United States. Language-model requests to
Amazon Bedrock are processed in the United States, in a US region or through a geographic inference profile limited to the US;
Kauro does not use global inference profiles. Recovery copies do not create an undisclosed permanent copy of the Files. Kauro, its
tools and its staff may access the data from Colombia in the cases allowed by section 12.2 of the Terms.
<!-- auth: A9 §3, §4; 14 §Network paths; 14 §Storage configuration -->

## 10. International transmissions and transfers

10.1. Sending Customer Data from the Customer (or End Client) to Kauro, and from Kauro to its sub-processors in the United States,
is a **transmission** of data to a processor for processing on the controller's behalf, not a transfer to a new controller. Under
Colombian law, this Agreement and Kauro's contracts with its sub-processors serve as the transmission contract of article
2.2.2.25.5.2 of Decree 1074 of 2015.
<!-- law: C-20, C-21 -->

10.2. The United States of America is on the SIC's list of countries with an adequate level of protection (Circular Única, Title
V, Chapter 3, numeral 3.2). That status does not relieve Kauro from demonstrating the appropriate and effective measures it
applies; this Agreement and Annex II are that demonstration as far as Kauro is concerned.
<!-- law: C-22, C-23 -->

10.3. Kauro does not transfer Customer Data to third-party controllers. If a sub-processor ever needed to process data outside the
United States, section 8.2 applies.

## 11. Security incidents

11.1. **Notice to the Customer.** Kauro will notify the Customer immediately and without undue delay after it discovers a
security incident affecting Customer Data (breach of security codes, or loss, theft, unauthorized acquisition or access) or has a
reasonable belief that one occurred, without waiting for confirmation, and in any case within **seventy-two (72) hours** of that
moment. If an applicable law requires earlier notice, that deadline prevails. The initial notice includes what is known: affected
scope, known facts, immediate action recommended to the Customer, containment under way and the date of the next update; Kauro
updates it as the investigation progresses. Kauro does not wait for a root cause before the initial notice and does not claim
there was no exposure before checking.
<!-- auth: 19 §Incident and breach obligations; 18 §Incident communication; 14 §Incident containment · law: C-67 · resolution S-02 (r2) -->

11.2. **Assistance.** Kauro gives the Customer the information reasonably available (timeline, affected data and data subjects as
they become known, measures taken) so that the Customer and the End Client can meet their own obligations to notify data
subjects and authorities. The decision on and content of notices to data subjects belong to the controller, unless the law obliges
Kauro directly.
<!-- law: C-65, C-66 -->

11.3. **Report to the SIC.** As a processor subject to Colombian law, Kauro will report the incident to the SIC within fifteen
(15) business days of its detection, through the application or channel the SIC provides, and will coordinate the report with the
Customer.
<!-- law: C-14, C-15 -->

11.4. **Record.** Kauro records each incident with detection, impact, affected subjects, containment, minimal evidence
preservation, repair, communication and recovery. An incident hold has a reason and a review date; it is not a permanent
exception to retention.
<!-- auth: 14 §Incident containment; 19 §Incident and breach obligations -->

## 12. Assistance with data-subject rights

12.1. The Platform lets the Customer view, correct (through a new Revision), exclude and delete Customer Data within the
retention periods.

12.2. **Queries and claims received by Kauro.** If a data subject submits a query or claim about Customer Data to Kauro, Kauro:
(a) authenticates the requester and scopes the request before disclosing or deleting anything; (b) identifies the project and the
controller from the registered chain (section 1.2) and, in the agency–end client chain, routes the request to the End Client
through the Customer; (c) once a complete claim is received, records the legend "reclamo en trámite" (claim in progress) and its
reason on the affected data within two (2) business days and keeps it until the claim is decided; (d) forwards to the controller,
within two (2) business days of receipt, whatever only the controller can decide, and informs the data subject of the referral;
(e) performs its own duties as processor without waiting for the controller, and executes the controller's decision within the
statutory periods (queries: ten (10) business days plus five; claims: fifteen (15) business days plus eight, notifying any
extension before the initial period expires); and (f) if it no longer holds the data, says so. Kauro does not answer on the merits
for the controller unless the Customer instructs it or the law obliges Kauro directly.
<!-- auth: 19 §Rights requests and privacy complaints · law: C-10, C-13, C-17 · CHECKLIST A-02, A-17 -->

12.3. Kauro helps the Customer, through appropriate technical and organizational measures and to the extent of the information
available to it, to respond to data-subject requests, to meet its security obligations and to carry out impact or risk
assessments the Customer must document, by giving it the necessary information about the processing.
<!-- law: C-62, C-65, C-66 -->

12.4. **Legends and blocking.** When a competent authority notifies Kauro, or the Customer informs Kauro that it has been
notified, of judicial proceedings about the quality of a datum, Kauro inserts the legend "información en discusión judicial"
(information under judicial dispute) on the affected data. When the SIC orders the blocking of information disputed by the data
subject, Kauro prevents its circulation while the order lasts: it blocks downloads, Package publication, model dispatch and new
processing of the affected scope, without deleting the information unless the order says so.
<!-- auth: 19 §Rights requests and privacy complaints; 09 §Early deletion; 14 §Incident containment · law: C-13, C-13b, C-17, C-62 · CHECKLIST A-02, A-17 -->

## 13. Deletion and return at the end

13.1. At the end of the provision of services, or earlier on request, the Customer, on its own behalf or on the End Client's
documented instruction, chooses whether Kauro **returns** or **deletes** all Customer Data it still holds, including the accepted
source Files and any derivatives that contain personal data, unless a law requires retention. Return is by secure download in the
Platform before deletion. In addition, Kauro deletes Customer Data according to the retention schedule in Annex IV when each
period ends, or when the Customer requests early deletion, whichever comes first; the Platform gives notice before each deletion
so the Customer can download.

13.2. Kauro issues a deletion receipt for the scope it controls, with the requested scope, policy version, deadlines, access
revocation, enumerated object generations and deletion and absence results. The receipt contains no values of deleted records and
does not cover copies already downloaded or imports made by the Customer.

13.3. Where the law requires keeping some data, Kauro keeps it only for that purpose, separately and without CRM content. Kauro's
financial and security records contain no Customer Data.
<!-- auth: 09 §Early deletion; 09 §Deletion receipts and restoration; 09 §Retention schedule; 09 §Notifications and customer action · law: C-65, C-66 · CHECKLIST A-15 -->

## 14. Terms for Customers subject to US privacy laws

14.1. **Limited and specified purposes.** The Customer discloses Customer Data to Kauro only for the specific business purposes in
Annex I, section 3. Kauro acts as a "service provider" within the meaning of California Civil Code §1798.140(ag) and as a
"processor" within the meaning of laws such as the Virginia Consumer Data Protection Act (Va. Code §59.1-579) and the Colorado
Privacy Act (C.R.S. 6-1-1305).
<!-- law: C-60, C-61, C-64, C-65, C-66 -->

14.2. **Kauro commitments.** In addition to section 3.3, Kauro: (a) complies with the obligations applicable to it under the
California Consumer Privacy Act and its regulations and provides Customer Data the same level of privacy protection the Act
requires of businesses; (b) notifies the Customer if it determines it can no longer meet those obligations; (c) allows the
Customer to take reasonable and appropriate steps to ensure that Kauro uses the data consistently with the Customer's obligations,
as set out in section 15; (d) allows the Customer, upon notice, to take reasonable and appropriate steps to stop and remediate
unauthorized use, including providing documentation verifying that Kauro no longer retains or uses the data of a consumer who
made a valid deletion request; and (e) enables the Customer to comply with consumer requests or complies with requests the
Customer informs it of.
<!-- law: C-60, C-62 -->

14.3. **Permitted uses.** Kauro may also retain or use Customer Data, to the extent reasonably necessary and proportionate, to
prevent, detect or investigate security incidents or malicious, fraudulent or illegal activity against the service, and to comply
with the law.
<!-- law: C-62b · auth: 08 §Abuse controls -->

14.4. **Liability by role.** Nothing in this Agreement relieves the Customer or Kauro of the liabilities imposed on them by law by
virtue of their role.
<!-- law: C-65, C-66 -->

## 15. Information, audit and verification

15.1. **Information.** Upon the Customer's reasonable request, Kauro makes available all information in its possession necessary
to demonstrate compliance with this Agreement and with the laws in section 14, including the current description of measures, the
sub-processor list, deletion receipts, the log of support access to the Customer's data and a completed security questionnaire.
There is no fixed limit on the number of requests.

15.2. **Audits and inspections.** Kauro allows for and contributes to reasonable audits and inspections by the Customer or the
Customer's designated auditor. As a routine arrangement they are scheduled on thirty (30) days' notice during business hours, but
the notice is shortened to what is reasonable when the audit responds to a regulator's request, credible suspicion of
non-compliance, a material change in processing or an incident. To protect other customers and Kauro's confidential information,
access is limited to the necessary scope and the auditor is bound by confidentiality; confidential information needed as evidence
is provided under that confidentiality, not withheld. Each party bears its own costs.

15.3. **Alternative independent audit.** With the Customer's consent, Kauro may instead arrange for a qualified and independent
auditor to audit, at least annually and at Kauro's expense, its policies and technical and organizational measures using an
appropriate and accepted control standard or framework and audit procedure, and will provide the audit report to the Customer upon
request.
<!-- law: C-60, C-61, C-62 (11 CCR §§7050(h), 7051(a)(6)), C-65, C-66 (C.R.S. 6-1-1305(5)(d)(II), 2026 text) -->

## 16. Liability, term and governing law

16.1. The parties' liability under this Agreement is governed by section 18 of the Terms, without prejudice to section 14.4 and to
the liability the law imposes on each party towards data subjects and authorities.

16.2. This Agreement applies for as long as Kauro processes Customer Data; its confidentiality, security and deletion obligations
survive until complete deletion.

16.3. This Agreement is governed by Colombian law, without prejudice to mandatory data-protection rules that apply to the Customer
or End Client because of their domicile or that of the data subjects, which Kauro will comply with as far as they concern it as
processor. Disputes are resolved under section 22 of the Terms.

---

## Annex I. Description of processing

**1. Subject matter.** Preparation of CRM data from files: receipt, inspection, profiling, bounded semantic proposal,
deterministic transformation, validation, delivery, support and deletion.

**2. Nature of the operations.**
1. Receipt of Files into a quarantine zone; inspection of format, archives and malware.
2. Sealing of the Revision (hashes, admitted worksheets, parser configuration).
3. Complete profiling of the admitted data (counts, formats, duplicate candidates, relationships).
4. Sending a **minimized context** to a language model on Amazon Bedrock to propose bounded decisions. The context contains only
   structure and aggregate facts (class L0), approved semantic vocabulary (L1) and authorized masked examples with task-scoped
   substitutions (L2). It never contains raw personal or confidential data (L3) or credentials (L4). The model proposes; it does
   not execute or grant authority.
5. Review and approval of the Plan by the Customer.
6. Deterministic transformation, validation, lineage reconciliation and publication of the Package.
7. Verification of import receipts supplied by the Customer (staged projects).
8. Support with scoped access, and deletion.
<!-- auth: 02 §4–§10; 06 §Privacy classes and minimization; 08 §Quarantine and malware boundaries; 08 §Model boundary -->

**3. Specific business purposes.** (a) Producing for the Customer the Free data health check, the Plan, the Package and the project
evidence the Customer requests; (b) providing support and defect remedy for that project; (c) maintaining the security and
integrity of the service for that project; (d) deleting the data under Annex IV.

**4. Types of personal data.** Whatever the Customer includes in CRM exports and business spreadsheets within the supported
objects: identification and business contact data (names, titles, emails, phone numbers, business addresses), company and
organization membership, deal or opportunity data, CRM record identifiers, dates, record owners, custom fields and free-text fields
(notes). Excluded: the prohibited categories in section 5.2 of the Terms.

**5. Categories of data subjects.** Business contacts, customers and prospects of the End Client or of the Customer, and CRM
employees or users who appear as record owners. They may be residents of the United States, Colombia or other countries, subject to
section 5.5 of the Terms.

**6. Duration.** During each project and up to the limits in Annex IV.

**7. Frequency.** Per project, at the Customer's request.

## Annex II. Technical and organizational measures

Measures that exist in the approved service design. Kauro does not claim certifications it does not hold.

| Area | Measure |
|---|---|
| Tenant isolation | PostgreSQL with row-level security (RLS) for reads and writes; runtime roles without owner or RLS-bypass privileges; per-transaction tenant context cleared on connection return; foreign keys binding tenant and parent. |
| User access | Verified email and MFA required for data access; recent re-authentication for high-impact actions; Secure, HttpOnly, SameSite session cookies; CSRF protection; CORS limited to application origins. |
| Storage | Separate zones (quarantine, accepted, profile, minimized, staging, delivery, receipts, legal/finance, security); opaque object names; objects never public or CDN-cached; preconditions preventing overwrite; periodic inventory against the object registry. Encryption at rest (Amazon S3 server-side encryption) and in transit (TLS). |
| Process containment | Short-lived storage credentials scoped to the attempt and exact prefixes, issued by a broker; the intelligence process has no access to raw storage; no general internet egress from migration workers; non-root containers; resource limits on archive extraction and parsing. |
| Hostile content | Format validation, archive inspection, recorded malware-scan coverage; a failed scan is not a clean file; no macro or formula execution; reports with contextual escaping and PDFs without remote resources. |
| Language model | Minimized context (L0–L2) bound to an egress decision fixing exact bytes, destination and expiry; no raw data or credentials; prompt-injection tests; no silent provider or endpoint change. On Amazon Bedrock, Kauro sets inference data retention to zero and invocation logging off, and does not use models that require retaining inputs or outputs or human review. |
| Support | Support view with safe metadata; record access only through a case-specific grant (purpose, project, operations, approver, maximum 30-minute expiry, read-only by default), audited and revocable. |
| Secrets and supply chain | Secrets in the secret manager; no long-lived static keys (federated identity for deployment); pinned and scanned dependencies; separate build, deploy and runtime identities. |
| Logs and audit | Security events without customer payload or credentials; application logs 30 days and security evidence 180 days; tracing does not capture HTTP bodies. |
| Downloads | Authorization rechecked at each download; 15-minute signed links; emails without signed links or records. |
| Deletion | Per-generation deletion with absence check and receipt; backups hold metadata, not file content; tombstones applied before restore. |
| Resilience | Daily metadata backups with point-in-time recovery, verified by restore drills. |
| Incidents | Containment by scope (uploads, checks, purchases, processing, publication, downloads) independent of refunds and deletion; incident record. |
| Organization | Least privilege for staff and sellers; confidentiality duty; no customer data in development tools or repositories; defects reproduced with synthetic data. |
<!-- auth: same rows as DPA.md Annex II -->

## Annex III. Authorized sub-processors

| Sub-processor | Function | Customer Data received | Location |
|---|---|---|---|
| Amazon Web Services, Inc. | Cloud infrastructure: compute, database, object storage, queues, secrets management, identity, logging and language models through Amazon Bedrock. | All Customer Data the Platform stores or processes; on Bedrock, only the minimized context of Annex I, item 2.4. | AWS regions in the United States. |

Kauro providers that are **not** sub-processors of Customer Data: Resend (transactional email; Kauro's processor for the
Customer's users' data —email, name and minimal notice content—, which under section 1.3 is not Customer Data; it receives no CRM
records and keeps sending data for its own period, 30 days on the observed plan), Google LLC (Google Workspace: Kauro's corporate
email; the Customer must not send records by email), Cloudflare, Inc. (domain registration and DNS), PayPal and Wise (independent controllers
of payment data), Bancolombia (Kauro's bank) and Kauro's e-invoicing provider (Customer billing data, not Customer Data). Google
Cloud is not used in production.

## Annex IV. Retention schedule for Customer Data

The schedule in section 13.1 of the Terms is part of this Agreement. In summary: incomplete upload, 24 hours; Free data health
check, 7 days from the result and at most 14 from sealing; ordinary paid project, 7 days from the first Package and at most 14 from
payment; staged project, at most 21 days from the first stage and 30 from payment; one soft extension of up to 72 hours that never
exceeds the maximums; minimized context, only during the active check and its short evidence window, deleted with the project
data.
