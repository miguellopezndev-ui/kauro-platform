<!--
D-08b · Privacy impact assessment of the language-model proposal step on Amazon Bedrock (SIC, Circular Externa 002 de 2024,
instruction IV, items a–c). English master (owner rule 2026-10-07). INTERNAL Kauro document; the Customer may request it for its
own assessment (DPA §12.3). Draft by the builder without a lawyer (decision D-08b, option 1).
Traceability: `auth:` = authority/r2; `law:` = CHECKLIST.md row; `ic:` = Intelligence Core, repository
kauro-intelligence-core, commit b819658 of branch ic/b04-integrate (the minimizer and the classifier, masking policy 1.4.0, are
also on main b3d0cc6; the Bedrock transport is only on the branch: CHECKLIST A-12). Official sources consulted on 2026-10-06
(CHECKLIST C-27 and V-02, V-03, V-09, V-10).
-->

# Privacy impact assessment: model-assisted proposal on Amazon Bedrock

**Version:** 1.0 · **Date of assessment:** 2026-10-06 · **Responsible for the assessment:** the legal representative of Kauro Data
S.A.S. (data protection officer, INTERNAL_DATA_MANUAL §3) · **Status:** pending signature (section 9)

## 0. Why it is done and with what structure

SIC Circular Externa 002 de 2024 requires, before the design and development of AI and to the extent a high risk to data
subjects is likely, carrying out and documenting a privacy impact assessment with, at a minimum: (a) a detailed description of the
processing operations; (b) an assessment of the specific risks to the rights and freedoms of data subjects, with their
identification and classification; and (c) the measures envisaged to prevent them from materializing. The same circular asks to
weigh suitability, necessity, reasonableness and proportionality (instruction I), to abstain or adopt precautionary measures
under uncertainty about serious harm (II), to manage risks (III), to process truthful and complete data (V), privacy by design
(VI), to inform the data subject (VII) and auditable security measures (VIII). The instructions are addressed to "Personal Data
Administrators", which according to its note 2 include **controllers and processors**.

Kauro concludes in section 7 that the residual risk is low, so the assessment might not be mandatory; it does it anyway because
the step uses AI on third-party data, because the DPA (§12.3, Annex II) relies on it and because Customers need it for their own
assessments. This document follows the order of the circular: section 1 = item (a); sections 2 and 3 = instruction I; section 4
= item (b) and instruction III; section 5 = item (c) and instructions II, V, VI, VIII; section 6 = instruction VII.
<!-- law: C-27 (SIC Circular Externa 002 de 2024, instructions I–VIII and note 2) -->

## 1. Detailed description of the processing operations (item a)

### 1.1. Context and roles

An agency or company (the Customer) uploads exports of its CRM so Kauro prepares a migration plan and a data package. The
Customer (or its End Client) is the **controller**; Kauro is the **processor**; Amazon Web Services is the **sub-processor** (DPA
§1, §8, Annex III). The data subjects are business contacts, customers and prospects of the Customer, and CRM employees or users
who appear as record owners (DPA Annex I.5).
<!-- auth: 19 §Data processing agreement · text: DPA §1, Annex I -->

### 1.2. What the model does and does not do

The language model **does not process the records**. Migration Core processes the records deterministically. The intelligence
service first resolves deterministically everything it can, assembles a finite set of candidates and asks the model only about
bounded **schema and semantic** decisions that remain open: which target field a column corresponds to, what a value from a
category list means, what transformation to apply, how objects relate. The response is validated and compiled; it cannot create a
target field, establish a person's identity or authorize a destructive operation. The Customer reviews and approves the plan, and
Migration Core validates it against the full data set.
<!-- auth: 06 §Objective and execution shape; 06 §Response parser and compiler; 06 §Migration validation and final states; 02 §4–§10 (plan approval by the agency) -->

### 1.3. What data reaches the model

Each request is an "envelope" assembled by the minimizer. Privacy classes of the authority: L0 non-identifying structure and
aggregate facts; L1 approved semantic vocabulary that cannot identify a person; L2 authorized masked examples; L3 raw personal or
confidential data (**excluded**); L4 credentials and secrets (**always excluded**).

| Envelope content | Class | How it is formed |
|---|---|---|
| Per column: number of rows, non-empty and distinct values, uniqueness, candidate shapes, minimum and maximum length | L0 | Measurement over all the data by the profiler |
| Column headers, sheet and file names, target labels and options, memory patterns, repair codes | L0/L1 if the classifier admits them as structural metadata | If they do not pass, they travel as an **opaque token**: an HMAC with a key bound to the customer, the attempt and the project revision, known only to the intelligence service |
| Values of a category column (for example, states) | L1 | Only if **all** the column's values are classified as safe low-cardinality semantics (closed vocabulary or the target's own options) and none looks like an instruction; a single personal, secret, sensitive or unknown value closes the entire column |
| Masked form of a free text | L2 | Only for tasks that need it (value map, semantic type, transformation, repair), only from columns with no personal, secret or sensitive value, as a mask of up to 32 characters (letters → `a`/`A`, digits → `9`), maximum 6 per column |
| Deterministic candidates, target objects and associations, budget | L0 | Opaque references and closed codes |

Never travel: rows, names, emails, phones, addresses, identifications, card or account numbers, notes, credentials or the
authentication token (which goes in the signed header, outside the body). The data that travels is **minimized and
pseudonymized**, not anonymized: Kauro keeps the token key during the attempt, and an L1 value could, through a classifier
error, be personal data (risk R1). For that reason this assessment treats the content as personal data.
<!-- auth: 06 §Privacy classes and minimization; 06 §Facts and decision evidence; 09 §Storage zones and object registry (MINIMIZED zone) · ic: src/envelope/envelope-builder.ts (minimize, whole-column rule, TASK_NEEDS_L2, MAX_EXEMPLARS_PER_FIELD = 6, MASKING_POLICY_VERSION = 1.4.0, mask key per tenant/attempt/revision); src/classifier/data-classifier.ts (classes SAFE_STRUCTURAL_METADATA, SAFE_LOW_CARDINALITY_SEMANTICS, POTENTIAL_PII, POTENTIAL_SECRET, SENSITIVE_OR_RESTRICTED, FREE_TEXT, UNKNOWN; UNKNOWN fails closed; email, phone, card, IBAN, identification and address shapes); src/contracts/envelope.ts (SourceFieldFact) -->

### 1.4. Flow, location and retention

1. The intelligence service assembles the envelope, decides the egress (EgressDecision bound to the exact bytes, the permitted
   destination and an expiry) and the transport signs those bytes with temporary credentials (SigV4).
2. The request goes to `bedrock-runtime` in a US region (us-east-1, or us-west-2 if probe P2 requires it), to a **`us.`
   geographic inference profile** of an Anthropic Claude model. The code cannot build a URL to a `global.`, `eu.`, `apac.`
   profile or another region. AWS processes the request in a US commercial region inside the AWS network, encrypted in transit.
3. The body carries no tools, files, cache control or metadata; if the response reports cache tokens, the result is discarded as
   a privacy violation.
4. Retention at AWS: account data-retention mode `none` (no request or response is written to durable storage or shared with the
   model provider) and invocation logging off. CloudTrail records the call in the source region.
5. Retention at Kauro: the minimized context lives in the MINIMIZED zone only during the active review and its short evidence
   window, and is deleted with the project data (ToS §13.1; DPA Annex IV).
<!-- auth: 06 §Privacy classes and minimization (EgressDecision); 06 §Prompt injection and tool restrictions; 08 §Model boundary; A9 §3 and §4; 09 §Derived data and worker scratch; 09 §Retention schedule · ic: src/provider/bedrock-wire.ts (BEDROCK_REGIONS, BEDROCK_PROFILE `^us\.anthropic\.`, closed members, empty tools); src/provider/bedrock-transport.ts (temporary credentials, no retries, redirect: error); src/provider/bedrock-gateway.ts (CACHE_TOKENS terminal); src/provider/bedrock-receipts.ts (authorization and session token redacted) · source: V-03 (retention `none`; geographic profiles), V-10 (invocation logging) -->

### 1.5. Volume and frequency

Per project and at the Customer's request; requests per project are limited by the attempt's budget. There is no continuous or
batch processing of records.
<!-- auth: 06 §Budget algebra · text: DPA Annex I.7 -->

## 2. Purpose and reasonableness

Purpose: propose mapping and transformation decisions so the Customer can migrate its own CRM data, which is the service it
contracted (DPA Annex I.3 a). It is a legitimate purpose of performing a contract on behalf of the controller, with no own use
by Kauro: Kauro does not sell, share, train models or create cross-customer memory with this data.
<!-- law: C-27 (instruction I.c, reasonableness) · auth: 06 §Scoped memory (no vector database, no cross-customer RAG, no online learning); 19 §Data processing agreement · text: DPA §3.3, §3.4 -->

## 3. Necessity, suitability and proportionality (instruction I)

| Criterion | Analysis |
|---|---|
| **Suitability** | The model is used only if it passes the measured B04 qualification (sealed corpus, thresholds of useful decisions, zero critical authority violations). An unqualified model does not enter production. |
| **Necessity** | The more moderate alternative is the deterministic one, and it is applied first: the model sees only what remains unresolved. Within the model step, the least intrusive measure is minimization: no rows and no L3 are sent. If minimizing destroys the meaning needed, the system asks the Customer a bounded question or leaves the candidate unresolved; it does **not** export raw data. Without a model, the same decisions would be made by the Customer by hand, with more cost and more error; the final decision remains the Customer's. |
| **Reasonableness** | Section 2. |
| **Strict proportionality** | The impact on habeas data is minimal (pseudonymized L0–L2 context, with no retention, in the US, a country with an adequate level of protection according to the SIC) against the advantage of a faster and more correct migration plan, which also protects the quality of data subjects' data in the target CRM. |
<!-- law: C-27 (instruction I), C-22 · auth: 06 §Provider selection decision (lexicographic selection: privacy and security first); 06 §Qualification corpus and scorer; 06 §Privacy classes and minimization (last resort: ask or leave unresolved) -->

## 4. Risks to the rights and freedoms of data subjects (item b, instruction III)

Scale: **probability** L (low: requires a failure of several defenses), M (medium), H (high); **impact** L (no identity exposure or
exposure of an isolated business-contact data item), M (exposure of contact data of several data subjects or an erroneous decision
on their records), H (massive exposure, sensitive data or harm that is hard to reverse). Inherent risk without measures; residual
with the measures of section 5.

| ID | Risk | Right affected | Inherent (P/I) | Measures (section 5) | Residual (P/I) |
|---|---|---|---|---|---|
| R1 | A personal data item is wrongly classified as safe semantics and travels as L1 (e.g., a short list of names in a category column) | Confidentiality, restricted circulation | M/M | M1, M2, M3 | L/L |
| R2 | A personal data item travels in a metadata channel (header that is an email, file name, target label, memory) | Confidentiality | M/M | M1, M2 | L/L |
| R3 | Re-identification through L2 masked forms or aggregate counts | Confidentiality | L/L | M1, M3 | L/L |
| R4 | AWS keeps inputs or outputs (abuse, human review, invocation logging enabled by mistake) | Confidentiality, time limitation | M/M | M4, M5, M6 | L/L, conditional on A-09 and A-10 |
| R5 | Inference is processed outside the US (global profile or another region) | International transfer | M/M | M7 | L/L |
| R6 | The data is used to train models or shared with the model provider | Purpose, restricted circulation | L/M | M8 | L/L |
| R7 | Prompt injection in CRM data leads the model to propose harmful operations or leak data | Integrity, confidentiality | M/M | M9, M10 | L/L |
| R8 | A wrong suggestion produces an erroneous transformation of records (inaccurate or incomplete data of the data subject in the target CRM) | Truthfulness and quality | M/M | M10, M11 | L/M |
| R9 | Automated decisions or profiling of people | Non-discrimination, freedom | L/H | M12 | L/L (the step does not decide about people) |
| R10 | Leak of credentials or secrets in the request or in logs | Security | L/H | M1, M13 | L/L |
| R11 | Unauthorized access to the AWS account or use of the model by another identity | Security, confidentiality | L/H | M13, M14 | L/M |
| R12 | Retention at Kauro of the context or receipts beyond the project | Time limitation | M/L | M15 | L/L |
| R13 | Reuse of one customer's decisions for another | Purpose, confidentiality | L/M | M16 | L/L |
| R14 | Data subjects do not know a model is involved | Information (instruction VII) | M/L | M17 | L/L |
| R15 | Silent change of model, provider or profile that alters the guarantees (e.g., a model that requires retention) | All the above | L/M | M5, M7, M18 | L/L |
<!-- law: C-27 (item b; instruction III and note 7: human biases, technical failures, security vulnerabilities, implementation and design failures) · auth: 06 §Privacy classes and minimization ("Low cardinality does not make a value L1. A two-value enum can contain two employee names. A header can contain a customer email"); 06 §Prompt injection and tool restrictions; 08 §Threat model and assets -->

## 5. Measures (item c; instructions II, V, VI, VIII)

| ID | Measure | Type | Evidence or obligation |
|---|---|---|---|
| M1 | **Classification of all output**: each value and each metadata text receives a class before leaving; UNKNOWN fails closed; shapes of email, phone, identification, address, card, IBAN and secrets are detected in any channel; a personal or unknown value closes the whole column; texts that do not pass travel as HMAC tokens with a key per tenant, attempt and revision | Software design | ic: src/classifier/data-classifier.ts; src/envelope/envelope-builder.ts |
| M2 | **Bound egress decision**: the gateway sends only an envelope whose hash matches the decision signed by the core, which re-reads the text channels instead of trusting the builder; a boolean "minimized=true" has no authority | Software design | auth: 06 §Privacy classes and minimization; 08 §Model boundary · ic: envelope-builder.ts (egress decision HMAC) |
| M3 | **Sentinel tests**: unique synthetic values in every possible channel; the final HTTP body, logs, errors, retries and repairs are inspected | Test | ic: test/b03-*.test.ts ("sentinel" tests); auth: 06 §Privacy classes and minimization (last paragraph) · CHECKLIST A-12 (privacy suite on the real Bedrock wire) |
| M4 | **Zero retention at Bedrock**: account data-retention mode `none` in each source region used; with `none`, a model that requires retention is rejected by AWS (`ValidationException`), so the control fails closed; Kauro does not use models that require retention or human review (today, Claude Fable 5 and 5.1) | Configuration | source: V-03 · **build obligation**: read back `GET /data-retention` = `none` before each stage and production, and deny by policy `bedrock:PutAccountDataRetention` with another mode (CHECKLIST A-09; the probe does not exist in b819658: P8 only records the page) |
| M5 | **Invocation logging off**: it is disabled by default; if it were enabled, it would store full bodies in S3 or CloudWatch | Configuration | source: V-10 · ic: tools/campaign/aws-probes.mjs **P4** (`GetModelInvocationLoggingConfiguration`: OFF only if there is no `loggingConfig`; any destination rejects) · CHECKLIST A-10 (P4 in each source region before each stage and, in production, at each deployment) |
| M6 | **No order-owned retention channels**: no prompt caching, no batches, no files, no tools; reported cache tokens = terminal violation | Software design | ic: bedrock-wire.ts, bedrock-gateway.ts (`CACHE_TOKENS`) |
| M7 | **US only**: URL built only to `bedrock-runtime.<us-east-1|us-west-2>` and a `us.anthropic.*` profile; probe P2 checks that the profile is active and that all its member regions are US; no switch to another provider or a global endpoint | Design + configuration | ic: bedrock-wire.ts (`BEDROCK_PROFILE`, `BEDROCK_REGIONS`), src/gateway/candidates.ts (D4-BR-1), aws-probes.mjs P2 · auth: A9 §4; 08 §Model boundary · source: V-03 · CHECKLIST A-06 |
| M8 | **No training and no provider access**: AWS and model providers do not use Bedrock inputs or outputs to train models and they are not shared with providers; providers have no access to deployment accounts, logs, prompts or responses | Contractual / provider | source: V-09 (Amazon Bedrock FAQ), V-02 (Bedrock Data protection); contract: AWS Service Terms and AWS DPA (V-01; CHECKLIST A-07) |
| M9 | **Untrusted input**: the model has no tools, browsing, remote files, code, external memory or switching; texts that look like instructions are not sent as values | Software design | auth: 06 §Prompt injection and tool restrictions · ic: classifier (`instructionLike`) |
| M10 | **The compiler rules**: the response is validated against closed schemas and permissions; it cannot create fields, establish identity or authorize destructive operations; evidence per decision | Software design | auth: 06 §Response parser and compiler; 06 §Facts and decision evidence |
| M11 | **Validation and human approval**: Migration Core validates the plan over all the data; the Customer reviews and approves; defects have a remedy | Organizational + software | auth: 06 §Migration validation and final states; 02 §4–§10; ToS §11 |
| M12 | **No decisions about people**: the model's tasks are schema and semantics; it does not score, classify or profile data subjects | Design | auth: 06 §Objective and execution shape |
| M13 | **Credentials**: temporary (STS / IAM Identity Center), never written; signature and session token redacted in receipts; L4 excluded | Design + configuration | ic: bedrock-transport.ts, bedrock-receipts.ts · auth: 06 §Privacy classes and minimization (authentication slot) |
| M14 | **Least privilege at AWS**: the intelligence identity can only `InvokeModel` on the approved `us.` profiles and read the probes; MFA on the account; deployment with federated identity | Configuration | ic: aws-probes.mjs (least-privilege policy) · auth: 14 §Identity matrix; A9 §3 (IAM + GitHub OIDC) · CHECKLIST A-06 |
| M15 | **Short lifecycle at Kauro**: MINIMIZED zone only during the active review and its evidence window; deleted with the project and covered by the deletion receipt | Software | auth: 09 §Derived data and worker scratch; 09 §Retention schedule; 09 §Deletion receipts and restoration |
| M16 | **Scoped memory**: CLIENT, AGENCY or GLOBAL; GLOBAL only reviewed non-personal patterns; no vector database or cross-customer RAG | Design | auth: 06 §Scoped memory |
| M17 | **Information**: POL §12.3, DPA Annex I.2.4 and Annex II say what reaches the model, where and without retention; the Customer, as controller, informs its data subjects | Organizational | text: POL §12.3; DPA Annex I, II, III |
| M18 | **Controlled changes**: changing model, provider, region, profile or masking policy requires updating this assessment, 30 days' notice to Customers if a sub-processor changes and a new qualification | Organizational | INTERNAL_DATA_MANUAL §5.5, §5.8; DPA §8.2 · auth: 06 §Provider selection decision; 19 §Subprocessor register |

Instruction II (precaution): if one of checks A-06, A-09, A-10 or A-12 does not pass, **the model step is not activated**; the
service continues with deterministic resolution and questions to the Customer. Instruction V (quality): decisions rest on
measured facts over all the data and the full validation of Migration Core, never on a sample. Instruction VI (privacy by
design): minimization by classes and the whole-column rule serve that function; Kauro does not use differential privacy because
it publishes no statistics about data subjects: the model receives schema facts, not queries about people. Instruction VIII
(auditable security): the probes, the request receipts and the egress decisions are evidence that can be shown to the SIC.
<!-- law: C-27 (item c; instructions II, V, VI, VIII), C-23 · auth: 06 §Facts and decision evidence; 06 §Migration validation and final states -->

## 6. Information and rights of data subjects (instruction VII)

Data subjects of E-01/E-02 may exercise their rights before the Customer (controller) or before Kauro; Kauro handles what it
receives as processor, with its legends and terms, and passes to the controller what only it can decide
(INTERNAL_DATA_MANUAL §5.2; DPA §12.2). Kauro delivers to the Customer, on request, this assessment and the description of the
processing so it can inform its data subjects and make its own assessment (DPA §12.3).
<!-- law: C-17, C-27 (instruction VII) · text: DPA §12 -->

## 7. Residual risk and conclusion

With measures M1–M18 the residual risk is **LOW** for all risks except R8 and R11 (medium impact, low probability), which are
accepted because the final decision is the Customer's with full validation (R8) and because access to the account is protected
by MFA, temporary credentials and least privilege (R11). No high risk to data subjects is identified within the meaning of
instruction IV.

The conclusion is **conditional**: it holds only if, before the first Customer datum is sent to Bedrock, the activation checks
A-06, A-09, A-10 and A-12 pass (CHECKLIST §7). Until they pass, the model step stays off.

## 8. Review

This assessment is reviewed in the annual review (INTERNAL_DATA_MANUAL §9) and **before** any change in section M18, in the
maximum class of data sent to the model, in the retention policy or in the AWS Bedrock terms, and after any incident involving
the model step.

## 9. Approval

Decision: **APPROVED WITH CONDITIONS** (section 7).

Legal representative and data protection officer of Kauro Data S.A.S.

Legal representative of Kauro Data S.A.S. (name at signing, decision D-16) · Signature: ______________________ · Date: ____________
<!-- see CHECKLIST A-04 -->
