# Round 3: voice and terms

Foundations 4 of the round-3 master plan (`ORDER11-ROUND3-MASTER-PLAN.md` §2.2). Written 2026-10-21, before any composition.

One file for every word Kauro shows or prints, on all four sites and in every document:
- the public site;
- the agency/company workspace;
- the seller portal;
- the owner console;
- the PDF report, the CSV/JSON/Markdown files of the package, and emails.

Real copy for each page is written in that page's brief from this file. Where this file and a page disagree, the page is wrong.

**Order of authority.** When two sources disagree, the higher one wins:
1. Amendment A3 §3 (`docs/COMMERCIAL_AMENDMENT_A3.md`) and the copy lint (`apps/web/src/copy/lint.ts`, `apps/web/test/copy-lint.test.ts`,
   `apps/web/test/public-copy.test.ts`).
2. The owner's recorded decisions: service names, seller money, claims, identity, D-33 and D-34.
3. The registry's primary copy (`packages/contracts/registry/screens.json`). It is never edited. A change to a primary sentence is an
   amendment (R2-x in `ORDER11-ROUND2-PUBLIC.md`) or a proposal (P-xx).
4. This file.

**What this file is built from:**
- the catalogues: `apps/web/src/copy/public.ts`, `en.ts`, `screens/*.ts` and `packages/reports/src/copy.ts`;
- the review prototypes, which hold the seller-portal and owner-console words (`tools/review/private/prototypes/*`);
- the core's document writers (`cores/kauro-migration-core/src/artifacts/*`);
- the format helpers (`packages/ui/src/format.ts`, `apps/web/src/public/pricing-bands.ts`);
- the registry contracts (`contracts.json`: RowCounts, CommissionLine, CommissionStatement, AttributionClaim, Settlement and others);
- the round-2 research (`Kauro.archive/Deliveries/Visual/order11/research/round2/principles-craft.md` §2, `owner-console.md` §8).

**Line references.** In this file, `public.ts`, `en.ts` and `screens/*.ts` are under `apps/web/src/copy/`, `report copy.ts` is
`packages/reports/src/copy.ts`, and prototype names are under `tools/review/private/prototypes/`.

---

## 1. Voice principles

Kauro speaks like a careful data specialist writing to a busy colleague who will check the numbers. It is plain, exact, calm and
brief. It never sells harder than the evidence allows.

### V1. Say what happens to the data, in the reader's words, never in the system's
The reader knows files, rows, contacts, duplicates, imports and prices. The reader does not know publications, deployments,
authorizations, revisions, hashes, providers or envelopes. A term from the contracts reaches the screen only when the glossary (§2)
gives it a reader's name.

| Keep | Avoid (and why) |
|---|---|
| "Kauro prepares exported CRM files. It does not connect to, change or delete records in a live CRM." (`public.ts:25`) | "These services are listed as available in Kauro's live capability publication." (`public.ts:164`): internal mechanism |
| "Sealing fixes the files, the choices and the count together. A sealed set never changes." (`public.ts:207`) | "This deployment has no upload destination configured, so no file can be sent now." (`screens/sources.ts:51`) |
| "Kauro shows the phase the work is in, never a percentage or a guess of when it will finish." (`screens/processing.ts:7`) | "Nothing more will run for this authorization." (`screens/processing.ts:36`) |
| "Returning from your bank or a screenshot is not payment." (`screens/payment.ts:25`) | "Recording the bank's proof is not connected yet (payout reconciliation is inert in this build)" (`ui36-commissions.tsx:334`) |

### V2. Name who acts: Kauro proposes and prepares; your team decides and imports
Every sentence about an action has a subject. "Kauro" is the subject for what the service does. "Your team" is the subject for what
the customer's organisation does. "You" is the person reading, at the moment they act. Passive voice is allowed only when the actor
truly does not matter.

| Keep | Avoid |
|---|---|
| "Kauro proposes and explains; you decide. No change is made without your approval." (`public.ts:174`) | "This runs on its own." (`screens/health-check.ts:31`): what runs, and who started it? |
| "Your team imports the prepared files with its own tools." (`public.ts:173`) | "The action may already be recorded. Do not repeat it: we look up the same operation." (`en.ts:138`): "we", "operation" |

On screens, "we" is not the voice of the product. It is allowed only where a person at Kauro answers in writing: contact replies,
support, and emails signed by a person. Shared states that say "We are checking…" (`en.ts:32`, `en.ts:137`, `en.ts:139`) and payment
lines that say "We have not yet received…" (`screens/payment.ts:13`, `screens/payment.ts:37`) move to "Kauro" (inconsistency I-17).

### V3. Exact before persuasive
A number carries its unit and its population. A claim is one Kauro can prove today. A3 §3.5 allows only three money arguments, and
there are no savings amounts, no guarantees and no "instant".

| Keep | Avoid |
|---|---|
| "A report with exact counts, and the population behind every percentage." (`public.ts:159`) | "Every number adds up." (`public.ts:75`) as a claim on its own: true, but it needs the count beside it |
| "Every share says out of what." (`public.ts:491`) | Any "save up to", "pays for itself" or "guaranteed" (refused by the lint) |

### V4. Put the limit next to the claim
Every promise is followed, in the same block, by the limit that governs it. A limit is written as a plain fact, not as an apology.

| Keep | Avoid |
|---|---|
| "A duplicate candidate is a signal to review, never a confirmed duplicate." (`public.ts:221`) | "Cleaned, explained files…" written without "Kauro qualifies imports only for HubSpot and Salesforce" nearby (A3 §3.3) |
| "A cleaned file is not a promise about how another CRM will read it." (`public.ts:333`) | "The check is bounded…" as the only word on capacity: say what bounds it (`public.ts:224` is good; reuse it) |

### V5. Stay calm when waiting or failing: say what is recorded, whether to repeat, and what comes next
A waiting or failure message answers three questions. Is anything recorded or charged? Is it safe to try again? What is the next step,
and who takes it? Never blame, never joke, never alarm.

| Keep | Avoid |
|---|---|
| "Check your connection and send it again. It is safe to retry: the same inquiry is never recorded twice." (`public.ts:617`) | "This did not finish" (`screens/health-check.ts:13`, `screens/processing.ts:16`) as a status with no reason and no next step |
| "Do not pay again. We are reconciling the result and will show it here." (`en.ts:140`) (keep the meaning, change "We" to "Kauro") | "We could not verify this answer" (`en.ts:145`): which answer? what now? |

### V6. One name per thing, everywhere
The same concept has the same word on the public site, in the workspace, in the seller portal, in the owner console, in the report and
in emails. The glossary (§2) is the list. A synonym is a defect even when each sentence is correct on its own.

| Keep | Avoid |
|---|---|
| "Free data health check" on the site, in the app and as the report title (A3 §3.2) | "importer guide" (`public.ts:501`), "import instructions" (`public.ts:475`), "Import guide" (report `copy.ts:45`) and "Import steps" (`public.ts:158`) for one file |

### V7. Short and front-loaded
- Sentences have 25 words or fewer, and paragraphs 5 sentences or fewer.
- The information-carrying word comes first in a heading.
- Text is in sentence case; capitals are not used for emphasis.
- One idea goes in each sentence.

Long legal or retention facts are split into separate sentences, never joined with semicolons.

| Keep | Avoid |
|---|---|
| "Pressing Enter never approves anything." (`public.ts:237`) | "Pay before {date}. The files are deleted then, before the price expires, and the quote cannot be paid without them. An owner or admin can extend them once, by up to 3 days, in Data and deletion." (`screens/quote.ts:75`): three ideas and a hard-coded figure |

### V8. Neutral, respectful and the same for every buyer
- People are "they", never "he" or "she".
- An agency and a company buy on the same terms (D-33). A sentence about who may buy, who gets a discount or whose data is protected
  names "any customer", "your team" or "your workspace", never an agency alone.
- There are no confirmshaming declines, no urgency tricks and no pre-selected answers (research P16).

| Keep | Avoid |
|---|---|
| "Companies preparing their own CRM data can buy Kauro directly, at the same prices and discounts as agencies." (`public.ts:45`) | "Your agency setup is not complete." (`screens/quote.ts:46`) shown to a company |

---

## 2. Glossary

### 2.1 How to read it
- **Term:** the only word for the concept in customer, seller and owner text. Capitalise it only at the start of a sentence or in a
  name. The three service names are always capitalised as written.
- **Do not use:** words that are refused for this concept. A word in that column may still be correct for a different concept.
- **Internal:** the contract or code name. It stays in code, ids and routes, and never appears on a screen or in a document.
- **Where:** the sites and documents where the term appears. The sites are P (public site), W (workspace), S (seller portal), O (owner
  console) and D (documents and emails).

### 2.2 The offer and the data

| Term | Definition | Do not use | Internal | Where |
|---|---|---|---|---|
| **Free data health check** (short form **health check** where space is limited; **the check** in running text after the first mention) | The free step before any purchase. Kauro measures the whole sealed set and shows what it finds: duplicate candidates, invalid values and what would block the import, with the proposed changes and the open decisions. It creates no obligation to buy. It is bounded, so it is never described as unlimited or immediate. | audit, diagnosis, assessment, scan, review, free check, free audit, test | `Audit`, `StartAudit`, `AUDIT_REPORT`, route `/audit`, UI18 | P W O D |
| **Request a free data health check** | The public call to action, word for word (A3 §3.2). It leads to the fit questions and then to an account, never to an anonymous upload. | Get started, Try free, Check a file free (a proposal that needs an A3 amendment) | `public.cta.request-health-check.cta` | P D |
| **Prepare for HubSpot** | The service that prepares import files, associations, importer settings and ordered steps for HubSpot's own import tool. | HubSpot mode, HUBSPOT, HubSpot integration, HubSpot connector | `HUBSPOT` | P W S O D |
| **Prepare for Salesforce** | The service that prepares Data Loader files, field mapping, settings and dependency-ordered steps for Salesforce. | Salesforce mode, SALESFORCE, Salesforce integration | `SALESFORCE` | P W S O D |
| **Clean your data** | The service with no destination. Kauro delivers cleaned standard files with every change explained, and your team uses them with its own tools. It never implies outside enrichment, irreversible deletion or compatibility with any CRM. It is never the headline offer (A3 §3.3). | CLEAN, clean-only, CLEAN_ONLY, cleanup mode, generic export | `CLEAN`, `CLEAN_ONLY`, folder `clean-only` | P W S O D |
| **service** | One of the three above. In a list, they come in the order Prepare for HubSpot, Prepare for Salesforce, Clean your data (round 2). | mode, capability, product, plan, offer | `ServiceMode`, `Capability` | all |
| **open for new projects** / **not available for purchase** | Whether a service can be bought now, read from the capability publication. | live, enabled, published, supported (alone), running | capability publication | P W |
| **destination** | The CRM a service prepares files for: HubSpot or Salesforce. Clean your data has none. | target, platform, system, integration, connector, org (outside Salesforce-specific text) | `TargetContract`, UI17 "Target setup" | P W D |
| **destination settings** | The settings of the destination that your team confirms before the check (fields, required values, owners, marketing-contact status). | target settings, target contract, org metadata (in a heading) | `TargetContract` | P W D |
| **qualified destination** | A destination for which Kauro qualifies imports, and only while the capability publication lists it. Today these are HubSpot and Salesforce. | compatible, supported CRM, works with | capability publication | P |
| **another CRM** | Any CRM other than a qualified destination. A third-party CRM is never named beside a Kauro offer (A3 §3.3). | a third-party CRM's name, any CRM | | P D |
| **exported files** / **your files** | The CSV or XLSX exports your team uploads. Each holds one object per file or worksheet, with a single header row. | dataset, data dump, source data (in a heading), inputs | `SourceLocator`, `FileManifest` | P W D |
| **sealed set** (in a sentence: "the sealed files") | The files, your choices about them and their count, fixed together by sealing. A sealed set never changes. A change makes a **new version** of the set, and approvals and quotes do not carry over. | source revision, revision, snapshot, batch, confirmed set | `DatasetRevision` | P W D |
| **seal** | The explicit act that fixes the set. It starts nothing you pay for. | confirm (for this act), lock, freeze, submit | `SealRevision` | P W |
| **version** | A later state of a sealed set or a plan. It is written as "version 2" and never as "revision 6". | revision, iteration | `revision` | W D |
| **billable source unit** (after the first use in the same view: **unit**) | Each contact, organisation or deal admitted in the sealed set, counted before duplicates are unified. It is fixed when the set is sealed, the quote and order use that count, and it cannot change after payment. It is not a physical row and not an output row, and splitting a file does not lower it. | record, row, source unit (outside the pinned Pricing headline), contact count, seat, credit | `billableSourceUnits` (RowCounts) | P W S O D |
| **organisation** (generic object) | A company or account record in the files. In destination-specific text, use the destination's own object name: Company in HubSpot, Account in Salesforce. | company (as the generic object name), firm | `TargetObject` | P W D |
| **duplicate candidate** (a group: **duplicate candidate group**) | Records the check flags as possibly the same. It is a signal to review, never a confirmed duplicate. | duplicate (for an unreviewed group), match, dupe, confirmed duplicate | `Candidate`, `IdentityDecision` | P W D |
| **unify / unification** ("unified with approval") | The approved combining of a duplicate candidate group into one kept row. Every other row is traced to it, so nothing is removed without a trace. | merge (except for an action in the customer's own CRM, where "merge" is the CRM's word), dedupe, delete duplicates, remove duplicates, eliminate records | `mergedNonSurvivors`, `merges.json`, survivor | P W D |
| **kept row** | The row a unified group keeps. | survivor, master record, golden record | survivor | W D |
| **normalise** | Change a value to one standard form, such as an email in lower case or a name trimmed, with your approval. | standardise, fix, correct, clean (as a verb for one value) | `TransformStep` | P W D |
| **association** | A link between two records, such as a contact and its organisation, that the destination supports. | relationship (in customer text), link between records (as a heading), edge, association edge | `associationEdges`, `RelationshipDecision`, UI21 "Relationships" | P W D |

### 2.3 The project and its stages

| Term | Definition | Do not use | Internal | Where |
|---|---|---|---|---|
| **project** | One set of files, one service and, for an import, one destination, from upload to delivery. Each periodic cleanup is a new project. | job (customer side), engagement, order (for the project) | `Project` | all |
| **plan** | Every change Kauro proposes for one project: column mapping, which duplicate candidate groups to unify, associations and normalised values, together with the decisions only your team can take. A plan has versions. | configuration, preparation decisions (outside the pinned UI22 sentence), proposal (for the whole plan), recipe | `Plan` | P W D |
| **proposal** | One proposed change inside the plan, which your team keeps, changes or rejects. | suggestion, recommendation, AI suggestion | `Candidate`, `DecisionEvidence` | P W |
| **decision** | An answer only your team can give, such as which value wins or whether a hidden sheet is included. | question, task, open item | `MemoryDecision`, `NEEDS_DECISION` | W D |
| **approval** / **approve** | The separate, explicit act by a permitted person that approves one exact version of the plan, for one sealed set and one destination. It is never reused, and pressing Enter never approves. | sign off, accept (for a plan), confirm (for a plan), OK | `Approval`, `PlanApproval` | P W D |
| **approver** | A workspace member whose role may approve. | reviewer, signer | `APPROVER` | W |
| **blocker** | Something that stops the next step, written with what unblocks it. | error (when nothing failed), issue, problem | blocker codes | W O D |
| **exception** | A row held back from the import files for review, with its reason. The exceptions are rows not readable, rows held back on purpose, unmapped fields, unresolved associations and destination conflicts. They live in `02_EXCEPTIONS`. | error, reject (for the whole group), failure, leftover | `rejected`, `withheld`, `02_EXCEPTIONS` | P W D |
| **rows held back** | Rows kept out of the import files on purpose, each with its reason. "Held" is reserved for commission (§2.5). | withheld (in text), quarantined, skipped | `withheld` | W D |
| **trace** | The record that ties every output row, every unified row and every row held back to its source row. It is in the trace files (`03_TRACEABILITY`), not in the manifest. | lineage (in text), audit trail, history, provenance | `03_TRACEABILITY`, `source-lineage.csv`, `merges.json` | P W D |
| **manifest** | The machine-readable list of every file in the package, with its row count and SHA-256, and the counts that must add up. | index, inventory, table of contents, the file that "ties every row" (that is the trace) | `PackageManifest`, `manifest.json` | P W D |
| **package** | Everything Kauro releases at delivery: the import files (or the cleaned files), the exceptions, the trace files, the report, the import instructions and the manifest. "Import package" is allowed only in the pinned texts that already use it (UI02 primary, footer tagline). | delivery package, bundle, deliverable (in customer text), export, zip | `Artifact`, bundle | P W D |
| **report** | The PDF in the package that says what the check found, what your team decided and what changed, with exact counts. The free data health check report is a separate document that is not built yet. | audit, audit report, migration audit, summary (as its name) | `ReportSnapshot`, `audit.md` (core), `AUDIT_REPORT` | P W D |
| **import instructions** | The step-by-step instructions for one destination: what to import, in which order and with which settings, and what to check afterwards. | importer guide, import guide, import steps (as the document's name), playbook, runbook | `import-instructions.md` | P W D |
| **import files** / **cleaned files** | The files to import, for the two destination services; or the files delivered, for Clean your data. | output, results (for the files), export | `01_IMPORT` | P W D |
| **prepared for import** | The state of a project, and of its records, from delivery until your team reports the result. A download never makes a project "imported". | Imported, done, migrated, synced, live | `READY`, `PUBLISH` | P W O D |
| **delivered** (Clean your data only; proposed, see Q-2) | The final state of a Clean your data project, which has no import. | prepared for import (no import exists), imported, complete | | W O D |
| **import result** | What your team reports back after importing one stage: rows accepted, rows rejected by the destination, unmatched rows. It is never "imported with errors". | receipt (in a heading), import status, Imported with errors | `StageReceipt` | W D |
| **stage** (of an import in stages) | One part of an import that your team imports and reports before the next verified part is released. | phase (for the import), batch, wave | `ImportStage` | P W D |
| **phase** (of the work) | Where the check or the preparation is: waiting, running, checking, released. A phase is never shown as a percentage. | step (for this), progress %, ETA | job states | W |

**The six project stages.** One full name and one short name for each. The full names are How it works's headings, and the short names
are the workspace's (`en.ts:63-69`).

| # | Full name (How it works, documents, owner Today) | Short name (stage strip, navigation, tables) | Not |
|---|---|---|---|
| 1 | Upload and seal your files | Files | Sources, Upload, Intake |
| 2 | The free data health check | Health check | Free health check, Audit, Measure, Check results (as the stage) |
| 3 | Review and approve the plan | Plan | Decide, Your decisions, Plan and approval |
| 4 | Quote and payment | Quote and payment | Purchase, Checkout, Quote (alone, as the stage) |
| 5 | Preparation and verification | Preparation | Processing, Prepare, Run |
| 6 | Delivery and your import (Clean your data: Delivery) | Delivery and import (Clean your data: Delivery) | Import (alone, as the stage), Delivery package |

Other workspace areas keep their names: Overview, Destination, Activity, and Data and deletion. Activity is never a stage.

### 2.4 Money on the customer side

| Term | Definition | Do not use | Internal | Where |
|---|---|---|---|---|
| **indicative band** / **estimate** | A price read from the public table for a count your team expects. It reserves nothing and is not a quote. | price (alone), offer, quote, pre-quote | `PriceBand` | P W |
| **quote** | Kauro's offer, issued from the sealed set and the approved plan. It shows the units, the band, at most one discount, any tax, the total, how long it is valid and any blockers. It is valid for {days} days. | estimate, proposal, invoice, price list | `Quote` | P W O D |
| **confirm the quote** | Your team accepts the terms of a quote and creates the payment order. After that, the quote's state is "Accepted for payment". | buy now, check out, accept the quote (as a button), place order | `ACCEPTED_FOR_CHECKOUT` | P W |
| **order** (in a heading: **payment order**) | What exists once the quote is confirmed: one project's scope at the quoted price, waiting for payment. | purchase, invoice, checkout, cart | `PaymentOrder` | W O D |
| **payment** | The customer's bank transfer for an order. It is "confirmed" only after Kauro matches it to the exact amount and reference. | charge, capture, checkout, payout (that is the seller's) | `CaptureFact`, `PaymentAttempt` | P W O D |
| **payment reference** | The reference the transfer must carry so that Kauro can match it. | memo, order ID (in transfer instructions), code | | W D |
| **transfer hold** (proposed, P-31) | The limited time, after your team proves a transfer was sent, during which the files are kept while the money arrives. It is not payment, and preparation never starts on it. | grace period, extension (that is the other mechanism), hold (alone) | pending-payment hold | W O |
| **extension** | The one-time extension of how long the files of a check are kept, by up to the policy's limit. | hold, renewal | | W O |
| **repeat discount** | 5%, 10% or 15% off a new quote, by qualifying projects in the preceding 365 days. It starts with the second project and never stacks. | repeat-project discount, loyalty discount, volume discount | `PriceEligibilitySnapshot` | P W O D |
| **before tax** | Every public price and band is before tax. A quote shows any tax on its own line. | net, excl. VAT, + tax | | P W D |
| **fiscal document** | An invoice, credit note or debit note with its legal number. It is distinct from the amount of the order. | receipt, bill, statement | `TaxDocument` | W O D |
| **refund** | Money returned for an order after review. It is completed only when the transfer is made. | reimbursement, chargeback, credit (alone) | `Refund` | W O D |

### 2.5 People and places

| Term | Definition | Do not use | Internal | Where |
|---|---|---|---|---|
| **customer** | An agency or a company that buys from Kauro. Use it where both are meant (owner console, Data handling). | tenant, client (for a buyer), account (for a buyer) | `Agency` (tenant) | P O |
| **agency** | A customer that prepares data for its own clients. | partner (unless a signed partnership exists), reseller | `Agency` | P W S O |
| **company** (buyer) | A customer that prepares its own data. On the public site the buyer name is "company"; "in-house team" is allowed only in the Home audience card (`public.ts:152`). | direct client, end customer, in-house (as the buyer type in forms) | `in-house` (fit answer id) | P W S O |
| **client** | An agency's own customer, whose data the agency provides. Kauro never contacts a client (A3 §3.7). | end client (outside the pinned UI12 sentence), customer (for this), account | `EndClient` | W O D |
| **workspace** | The place where one agency or one company works: its projects, team, billing and settings. A person may belong to several workspaces. | tenant, agency (for the container), organisation (for the container), account | `Agency`, `TenantScope` | P W O |
| **account** | One person's sign-in identity. | user, login, profile (for the identity) | identity | P W S O |
| **team** / **member** | The people in a workspace, each with one role: Owner, Admin, Operator, Approver, Billing or Viewer. | users, staff, seats | `Membership` | W |
| **workspace owner** (role) | The member role named "Owner". Always write "an owner of this workspace" so it is never read as Kauro's owner. | the owner (alone, in the workspace), admin (for this role) | `OWNER` | W |
| **Kauro's owner** (console user; in their own console, "you") | The person who runs Kauro and uses the owner console. Sellers and customers read "Kauro", never "the owner". | the owner (on a seller or customer screen), admin, superuser | owner | O S |
| **seller** | A person under a signed seller agreement who researches prospects, claims them and earns commission. | rep, affiliate, partner, salesperson, agent | `SellerAgreement` | S O |
| **prospect** | An agency or company a seller researches and may contact. It is not yet a customer. | lead, target, deal | `Prospect` | S O |
| **two-step verification** | The second factor Kauro always asks for, a code from an authenticator app. | MFA, 2FA, TOTP (in customer text) | TOTP | P W S O |
| **confirm your identity** | The fresh identity check before a sensitive action. The heading is "Confirm it is you" and the button is "Confirm your identity". | step-up, re-authenticate, fresh identity check, fresh confirmation of your identity | step-up | W S O |
| **support case** (after the first use: **case**) | A written question or problem tied to a project. | ticket, request, issue | `SupportCase` | P W O |

### 2.6 Seller and owner money

| Term | Definition | Do not use | Internal | Where |
|---|---|---|---|---|
| **claim** | A seller's request to be credited with acquiring one prospect. It lasts 90 days after acceptance unless a documented extension applies. Its states are Submitted, Accepted, Refused, Contested, Expired and Converted. | reservation, lead registration, attribution (in seller text), deal | `AttributionClaim` | S O |
| **Not available to claim** | What a seller reads when a claim is refused for a reason that would reveal another relationship. The owner sees the internal reason, the evidence and the history. | rejected, taken, already claimed, conflict | `CLAIM_REASONS` | S |
| **commission** | The seller's share of net revenue: 10% of a first project and 4% of repeats for 12 months, after any offset. The state words are **Earned**, **Held**, **Payable**, **On statement**, **Paid**, **Adjusted** and **Void**, each defined once on the page. | commission generated, bonus, fee, reward | `CommissionLine` | S O |
| **earned** | Commission whose customer payment is confirmed. It becomes payable 30 days (720 hours) after the project is finally complete: the reported import result for Prepare for HubSpot and Prepare for Salesforce, the delivery for Clean your data (`packages/domain/src/commercial/time.ts`, D10-ELIG-1). Registry UI36: "what was earned, held and paid". | generated, accrued, pending (as a state) | `ACCRUED_PENDING` | S O |
| **pending** (owner total only) | Earned and not yet paid: payable, on a statement, held, or waiting for a project to finish. It is always "as of now". | owed (for commission alone, because owed also includes the retainer), outstanding | | O |
| **held** | Commission paused for a stated reason until a review date. | on hold, frozen, blocked, withheld | `HELD`, `heldCents` | S O |
| **statement** | The monthly list of a seller's commission lines, retainer and offsets, with the payable amount. Its states are Draft, Issued, Contested, Approved, Paid and Corrected. | invoice, report, payslip | `CommissionStatement` | S O D |
| **payout** | Kauro's transfer of a statement's payable amount to the seller's verified account. It is "Paid" only with the bank's proof, and "Sent, not yet confirmed" before that. | payment (that is the customer's), disbursement, remittance | CMD052, CMD053 | S O |
| **payout destination** | The seller's verified bank account. | bank details (in a heading), payee account | | S O |
| **retainer** | A fixed monthly amount a signed seller agreement may set. It is zero by default, never hidden, and owed apart from commission. | salary, base pay, fee, stipend | agreement terms | S O |
| **offset** | A reduction of commission after a customer refund. It is shown on the statement with its basis, amount and balance, and applied only under the agreement and the applicable law. | clawback, chargeback, deduction, penalty | `CommissionAdjustment` | S O |
| **net revenue** | What a seller's customers actually paid for the service: collections, not invoices, net of refunds and without tax. Each collection is counted once, in its month. | sales, billings, invoiced, GMV, revenue (unqualified, on seller rows) | | O |
| **collected** / **cash** / **held by the provider** | In company finance: money received, money available in the bank, and money the payment provider holds. They are distinct figures that are never added together. | balance (unqualified), funds | `Settlement` | O |

### 2.7 Inconsistencies found

Each item gives the evidence, the term this file chooses and what changing it needs. "Catalogue" means an ordinary copy change that
passes the lint. "Registry" means the text is a pinned primary sentence, so the change needs an R2-x amendment. "Core patch" means a
Migration Core document, which changes only through the deliverables plan's patch (§1.1). "Prototype" means a review-only page.

| # | Inconsistency | Evidence (file:line) | Choose | Needs |
|---|---|---|---|---|
| I-01 | Three sets of stage names on the public site and the app | Home process: Upload, Measure, Decide, Quote, Prepare, Import (`public.ts:77-88`). Home app mock: four phases (`public.ts:58-65`). How it works headings (`public.ts:196, 214, 228, 243, 261, 274`). App short names (`en.ts:63-69`). Research proposal "Free health check" (`agency-workspace.md:687`) | §2.3 table: full plus short names. Home's verbs are decided in Home's own audition, because Home is the reference | Catalogue; Home audition |
| I-02 | "Purchase step", a stage that no longer exists | `screens/billing.ts:7`; owner answers memory "Purchase" | "Quote and payment" | Catalogue |
| I-03 | Processing vs preparation for stage 5 | `screens/processing.ts:38` "Cancel processing" and `:47-49` "Start processing" vs `:39` "Cancel the preparation" and `screens/payment.ts:46-48` "start the preparation"; registry UI25 title "Processing" | "preparation", "Start preparation", "Cancel preparation" | Catalogue (the registry title is not rendered) |
| I-04 | Target vs destination | `public.ts:308, 418, 488, 638, 649-652`; `screens/quote.ts:54` "Confirm the target again"; registry UI17 "Target setup" | "destination", "destination settings" | Catalogue |
| I-05 | The manifest is described as the row trace | `public.ts:161, 300, 474, 495` say that the manifest ties each output row to its source row. The trace is in `03_TRACEABILITY`; `manifest.json` lists the files, hashes and counts | Manifest = file list and counts; trace = row links | Catalogue (Home and Sample delivery) |
| I-06 | Four names for the import instructions | `public.ts:464, 501` "importer guide"; `public.ts:475` "import instructions"; `public.ts:158` "Import steps"; report `copy.ts:45` "Import guide"; core file `import-instructions.md` | "import instructions" | Catalogue; report copy |
| I-07 | Three names for the package | `public.ts:64` "Delivery package"; `public.ts:26, 49, 52` and UI02 "import package"; `public.ts:465` "delivery package" | "package" | Catalogue; the registry and footer texts stay |
| I-08 | Associations vs relationships vs links | `public.ts:96, 132, 344, 361, 505` "associations"; report `copy.ts:25, 40` "Relationships"; `screens/sources.ts:159` "Association edges"; `ui21-relationships.tsx:40` "Links between records"; registry UI21 "Relationships" | "associations" (it is HubSpot's own word, and Salesforce readers understand it) | Catalogue; report copy; prototype |
| I-09 | Organisation vs company in the definition of the unit | `public.ts:208` "a contact, a company or a deal" vs `public.ts:385, 409, 427` "organisation"; report `copy.ts:22` lists "company, contact, deal or lead" | "organisation" in generic text | Catalogue; report copy |
| I-10 | When the unit count is fixed | `public.ts:248` "sealed count"; report `copy.ts:24` "fixed when the order was placed"; `screens/sources.ts:158` "after the selection is applied" | "Fixed when the set is sealed; the quote uses that count" | Report copy; catalogue |
| I-11 | "Source revision" and "revision" shown to buyers | `screens/sources.ts:11, 174, 177, 180`; `screens/processing.ts:51`; `ui13-overview.tsx:341` "Revision 6"; vs `public.ts:212` "a new version of the set" and `screens/approval.ts:13` "this version of the plan". Registry UI16 primary "Confirm this exact source revision." is pinned | "sealed set", "version" | Catalogue; registry for UI16 |
| I-12 | Confirm vs seal | `screens/sources.ts:16-17` "Ready to confirm" and "Confirmed and sealed" vs `:172` "Seal this set" | "Ready to seal", "Sealed" | Catalogue |
| I-13 | "free check" and "free allowance" as other names for the free step | `public.ts:518`; `screens/health-check.ts:19, 25`; `p05-sign-up.tsx:234`; `p07-results.tsx:150`; `p09-billing.tsx:64` | "health check" (the short form A3 allows) | Catalogue; prototypes |
| I-14 | Agency-only words shown to companies | `screens/quote.ts:46` "Your agency setup"; `screens/billing.ts:76` "an owner of this agency"; `screens/sources.ts:25` "The agency is not active."; `screens/settings.ts:5` and registry UI09, UI10, UI11, UI32, UI51 | "workspace" | Catalogue; registry for the pinned primaries |
| I-15 | "end client" vs "client" | `ui12-clients.tsx:104` (registry UI12 primary) vs "client" everywhere else (`public.ts:115, 118, 153`) | "client" | Registry for UI12 |
| I-16 | Internal jargon on buyer screens | "capability publication" and "service publication": `public.ts:164, 166, 318, 325, 326, 341, 628, 631`. "This capability is restricted": `screens/sources.ts:27`. "deployment": `screens/sources.ts:51`. "provider": `screens/sources.ts:64`. "authorization": `screens/processing.ts:36, 54` and `screens/settings.ts:31, 42`. "Fit inquiry": `public.ts:568`. "fit form": `public.ts:200`. "Physical rows": `screens/sources.ts:155`. "Selection hash" and "Inventory hash": `screens/sources.ts:164-165`. "Reason code" and "Failure code": `screens/health-check.ts:30`, `screens/sources.ts:93, 150`. "Interpreting", "proposed operations", "explicitly incomplete": `screens/health-check.ts:8-9, 26`. "inert in this build": `ui36-commissions.tsx:334`, `p22-payouts.tsx:86` | Reader's words (§1 V1). Codes go behind a "Details" disclosure, each beside a plain reason | Catalogue; prototypes |
| I-17 | "we" vs "Kauro" as the product's voice | "We" in `en.ts:32, 35, 137-140` and `screens/payment.ts:13, 15, 37`; "Kauro" in `screens/processing.ts:7-8` and `screens/support.ts:54` | "Kauro" on screens; "we" only in written replies (V2) | Catalogue |
| I-18 | Four phrasings for the identity check | `screens/kit.ts:3` "Confirm it is you", `:4` "fresh confirmation of your identity", `:5` "Confirm identity"; `en.ts:155` "Confirm your identity"; `screens/approval.ts:18` "fresh identity check"; `screens/settings.ts:28` | Heading "Confirm it is you", button "Confirm your identity", body "This needs you to confirm your identity again." | Catalogue |
| I-19 | Support area names and support buttons | Nav "Help and support" (`en.ts:54`); screen "Support" (`screens/support.ts:4`); registry UI52 and ops nav "Support cases". Buttons "Contact support" (`en.ts:163`, `screens/payment.ts:21`) vs "Open support" (`screens/processing.ts:34-35, 46`). Case buttons "Open case" (`screens/support.ts:14`), "Open a case" (`:39`), "Open the case" (`:48`) | Area "Support cases" (W); button to reach it "Contact support"; open a new case "Open a case"; open an existing one "View case" | Catalogue |
| I-20 | Article use in buttons | `screens/billing.ts:51` "Request a refund" vs `:72` "Request refund"; `screens/quote.ts:70` "Create payment order" | With the article, as the A3 call to action: "Request a refund", "Create a payment order" | Catalogue |
| I-21 | Re-check buttons | "Check again" (`en.ts:34, 159`, `screens/processing.ts:32`), "Check the status again" (`screens/health-check.ts:32`, `screens/payment.ts:20`, `screens/sources.ts:102`), "Refresh the list" (`screens/support.ts:12`), "Reload" (`en.ts:157`) | "Check again" for a status; "Reload the page" only for the page | Catalogue |
| I-22 | Repeat discount name | `screens/quote.ts:9` "Repeat-project discount" vs `public.ts:418` and A3 "repeat discount" | "Repeat discount ({percent}%)" | Catalogue |
| I-23 | Commission "generated" vs "earned" | `p21-sellers.tsx:136, 168, 200, 228`; `ui37-seller.tsx:106` vs `ui36-commissions.tsx:215, 367` "Earned" and registry UI36 "earned, held and paid" | "earned" | Prototypes |
| I-24 | A seller's payout called "payments" | `p03-seller.tsx:111` "Payments approved before the change" | "Payouts approved before the change" | Prototype |
| I-25 | "Imported" as a stage-result label | `ui27-import.tsx:41, 84, 98` "Imported with errors" (the lint refuses "Imported" in the product) | "Result: {count} rows rejected by {destination}" | Prototype |
| I-26 | "audit" and internal mode ids in package documents | `cores/kauro-migration-core/src/artifacts/audit.ts:35` "# Migration audit"; file `audit.md` (`layout.ts:127`); `import-instructions.ts:62` prints the id ("HUBSPOT", "CLEAN_ONLY"); folder `01_IMPORT/clean-only` | Title "Preparation summary"; the service name in headings; the folder may stay because it is a machine path | Core patch (deliverables plan §1.1) |
| I-27 | The report speaks of an import for Clean your data, and of the agency's price to its client | report `copy.ts:9` "Import package report", `:12` "your team imports these files" and `:39` "Records prepared for import" for every service. Report `copy.ts:24` "The units your quote was priced on" tells a client what the agency paid Kauro | Title by service (Q-3); pricing words out of white-label documents (§6.1) | Report copy |
| I-28 | Range punctuation | En dash: `p21-sellers.tsx:30` "Oct 1–21"; `p04-owner.tsx:64` band range; "5–15 %" in ORDER11-ROUND2-PUBLIC. "Between 20 and 4000" (`screens/support.ts:45`) vs "20 to 4000" (`screens/billing.ts:71`) | "to" (§3.3) | Catalogue; prototypes |
| I-29 | Thousands separator missing | "4000" in `screens/billing.ts:71` and `screens/support.ts:45, 47` vs "1,000,000" (`public.ts:587`) | "4,000" | Catalogue |
| I-30 | Figures typed into messages instead of read from the policy | "30 days" (`screens/billing.ts:50`); "4 business days" (`screens/payment.ts:44, 49`); "3 days" (`screens/quote.ts:75`), while `public.ts` uses {days} | Placeholders filled from the policy snapshot | Catalogue |
| I-31 | Time format and zone | 24-hour "09:00 to 17:00 Bogotá time (14:00 to 22:00 UTC)" (`screens/support.ts:22`); "11:00 AM Bogotá" (`ui55-support.tsx:30`); research "09:12 Bogotá" (`owner-console.md` §8) vs `formatDeadline` "Mar 14, 2027, 5:00 PM UTC" | §3.4 | Catalogue; prototypes; owner Q-1 |
| I-32 | Dates without a year in sentences | `p22-payouts.tsx:44` "issued on Nov 9"; `:67` "held until Nov 4" | §3.4 | Prototypes |
| I-33 | Negative money written two ways | `packages/ui/src/format.ts:56` "USD -12.50" (hyphen) vs `sales.ts:31` "−USD 12.50" (minus sign before the code) | "USD −12.50" (§3.5) | Format helper (frontend) |
| I-34 | The outreach draft uses "CLEAN" as a name | `docs/COMMERCIAL_AMENDMENT_A3.md:408` "What we can deliver is CLEAN" | "Clean your data" | A3 amendment (the outreach text is sealed by its hash) |
| I-35 | British and American spelling mixed | British: organisation, normalise, centre, cancelled, catalogue, authorised (`public.ts:278`). American: authorization (`screens/processing.ts:36, 54`, `screens/settings.ts:31, 42`) | British spelling, en-US number and date formats. The exceptions are a destination's own field names (for example "Salesforce organization ID") | Catalogue |
| I-36 | Vague "review" in shared states | `en.ts:142` "The review it was based on is no longer current"; `en.ts:160` and `screens/payment.ts:23` "Request a new review" | Name the object: "Request a new quote", "Run the health check again" | Catalogue |
| I-37 | Two words for one quote act | `public.ts:244, 254` "confirms" the quote vs `screens/quote.ts:43` "I accept the service terms" and `:63` "Accepted for payment" | "confirm the quote" for the act; "accept the terms" for the checkbox | Catalogue |
| I-38 | Generic shared states | `en.ts:125-128` "Nothing here yet / Start with the first step below." and "Ready / This is the current information."; `en.ts:149-150` "Done / The result is recorded." | Each screen gives its subject (§4) | Catalogue |

Already settled, and not an inconsistency: the fit answer "A company working on its own data" (`public.ts:576`) differs from A3 §3.7's
older wording. D-33 changed it, and `public-copy.test.ts` pins it.

---

## 3. Numbers, dates, currency

### 3.1 Numbers
- Numbers use the en-US format: a comma for thousands and a point for decimals, from 1,000 up ("4,000", "12,480", "1,000,000"). The
  catalogue's `message()` and `formatCount` already do this. A figure typed into a message is a defect (I-29, I-30).
- In running text, write numbers as figures, except zero to nine at the start of a sentence or in a fixed phrase ("one discount",
  "three services").
- **Non-breaking space (U+00A0)** goes between a number and its unit, between a currency code and its amount, and inside "Stage 2",
  "Page 3", "2:02 PM UTC" and "Oct 21". In catalogues, write it as ` ` in the template ("{count} rows"). In HTML documents
  use `&nbsp;`, and in Markdown and plain text the character itself.
- Units are spelled out in prose ("12,480 contacts", "7 days", "48 hours", "5 business days") and abbreviated only for file sizes
  ("50 MB", "2 GB"), in tables, and after a number.
- Figures in tables use tabular digits and are right-aligned. The unit or currency goes in the column header, as in "Rows" or
  "Payable (USD)".
- An unknown value is written "Unknown" followed by its reason, never "0" and never a dash. The one exception is the estimator's
  empty result.

### 3.2 Counts with their population, and percentages
- A count always says what it counts: "1,204 contacts", never "1,204".
- A share never appears without its count and population: "1,204 of 12,480 contacts (9.6%)". In tables, use the "Count", "Out of"
  and "Share" columns (`public.ts:480-483`).
- Write percentages with no space before "%": "9.6%", "10%".
- Use at most one decimal, and the same precision within one table. Rates in agreements and discounts are whole numbers ("5%").
- Never round a non-zero count to "0%" or a partial count to "100%". Write "less than 0.1%" or "more than 99.9%".
- Never write a percentage of work done for a running job (`public.ts:269`).
- Name the population when two counts could be confused: groups found, groups approved, rows unified (`public.ts:493`).

### 3.3 Ranges
- In prose and in tables, a range is written with "to": "50,001 to 150,000", "20 to 4,000 characters", "Oct 1 to 21, 2026",
  "1 to 9 qualifying projects". No en dash and no hyphen.
- An open range is written "up to 50,000" or "more than 1,000,000".
- The only arrow allowed is in a design note, never in product text.

### 3.4 Dates and times
- **A date** is written "Oct 21, 2026": a three-letter month, the day with no leading zero, a comma and the year (`kit.tsx day()`,
  `formatDeadline`). A whole month is written "October 2026". A period is written "October 2026 (so far, to Oct 21)".
- **The year** is always written in sentences. A table may leave it out only when its caption or its period heading states the year.
- **A time** is written "2:02 PM UTC": a 12-hour clock, no leading zero, AM or PM in capitals, and always a zone. Do not use the
  24-hour clock (I-31).
- **A deadline** is shown to the minute, with its zone. A relative phrase ("in 3 days") may follow the absolute date, but never
  replaces it. Documents never use relative dates, because they are read later.
- **Time zones:**
  - The public site, the workspace, documents and customer emails show UTC, as the product does today (`<Deadline timeZone="UTC">`).
  - A commitment defined in Bogotá business hours names Bogotá first and gives UTC beside it: "9:00 AM to 5:00 PM Bogotá time
    (2:00 PM to 10:00 PM UTC), Monday to Friday except holidays".
  - The owner console and the seller portal show Bogotá time for business dates, such as commission eligibility, payouts and support
    due times, labelled "Bogotá". Their technical pages (Jobs, Releases, Incidents, Deletion) show UTC.
  - This split is recommended by the round-2 research and still needs the owner's confirmation (Q-1).
- **Durations** say whose business days they are: "5 Bogotá business days". For customers, "business days" alone, as the terms define
  it.
- **Machine files** (CSV, JSON) use ISO 8601 in UTC: "2026-10-21T14:02:00Z".

### 3.5 Currency
- **In a sentence**, write the code, a non-breaking space and the amount: "USD 1,295.00". Never write "$" or "US$". In captions,
  write "in US dollars".
- **Public bands and the price table** show whole dollars: "USD 695" (`formatUsd`). **Quotes, orders, payments, refunds, statements
  and payouts** always show cents: "USD 1,295.00" (`formatMoney`).
- **In tables**, the header carries the currency ("Payable (USD)") and the cell carries the amount alone ("1,295.00").
- **A negative amount** uses the minus sign U+2212 after the code: "USD −51.80", or "−51.80" in a cell. A word goes beside it
  ("Offset after a refund"). Colour alone never marks it. In a sentence, prefer words: "an offset of USD 51.80".
- **Zero** is "USD 0.00" only when it is verified. Otherwise write "Unknown" and the reason.
- **Tax:** every public price and band is followed by "before tax", or carries it in its caption. A quote shows tax on its own line,
  with the treatment in words ("Exempt: export of services").
- **The basis** is named for every amount that could be confused: "Amount of the order", "Amount received", "Net revenue (collections,
  without tax)". An order amount is never called an invoice, and a payout sent is never called paid without the bank's proof.
- **Another currency** (for example a seller paid in COP) shows its own code and the observed conversion rate with its date. A
  conversion is never estimated.

---

## 4. Message patterns

Every state is a panel with a heading, one or two sentences and at most one next step (`KAURO_VISUAL_IDENTITY.md`, states). The
templates below fill that panel. `{thing}` is the screen's own subject, never "this" alone. The examples marked "existing" are kept
as they are. Names, references and amounts in the other examples are synthetic.

### 4.1 Empty state
Template:
- **Heading:** "No {things} yet", or for a filter, "No {thing} {is in this state}".
- **Body:** what will appear here and what makes it appear.
- **Action:** the one control that creates it, if the reader may use it. Otherwise say who can.

1. Existing: "No cases yet" / "No one has opened a case for this project." (`screens/support.ts:9-10`)
2. Replaces the generic `state.EMPTY` (`en.ts:125-126`) on Projects: "No projects yet" / "A project holds one set of files and one
   service, from upload to delivery." / [Create a project]

### 4.2 Error (something failed)
Template:
- **Heading:** what failed, in the past tense ("The {thing} could not be {done}").
- **Body:** why, if known; what was and was not recorded or charged; whether a retry is safe; the fix.
- **Action:** the fix, or "Contact support" with the support reference.

1. Existing: "The file could not be sent. Nothing was completed: choose the same file to try again." (`screens/sources.ts:57`)
2. Replaces "This did not finish" (`screens/processing.ts:16, 34`): "The preparation stopped before it finished" / "No package was
   released and nothing was charged again. Kauro has the details; open a case to agree the next step." / [Contact support]

**A field error** sits beside its field. It is an imperative with the expected format, and the input is kept: "Enter an email address
such as name@company.com." (`public.ts:602`); "Write at least 20 characters." (`screens/support.ts:46`).

### 4.3 Blocked action
Template:
- **Heading:** "Before you can {act}".
- **Body:** one line per blocker: what blocks it, then what unblocks it, and who acts if it is not the reader.
- **Rule:** never show a disabled button without its reason beside it.

1. Existing heading "Before you can pay" (`screens/quote.ts:45`) with "The price of this quote has expired. Request a new quote."
   (`:48`)
2. Replaces "This service is restricted right now." (`screens/quote.ts:55`): "Prepare for HubSpot is not open for new purchases right
   now. Your files and plan are kept until {date}; you can buy once the service reopens, or choose another service."

### 4.4 Pending or processing
Template:
- **Heading:** the phase, in the present continuous ("Checking the payment", "Preparing the files").
- **Body:** what is recorded already; "Do not {repeat the act}" when a repeat could double an effect; whether the reader can leave;
  what notifies them.
- **Never:** a percentage, a countdown or a guessed end time.

1. Existing: "We are reconciling the payment with verified information. Do not pay again; this page shows the result."
   (`screens/payment.ts:15`), with "We" changed to "Kauro" (I-17).
2. Existing: "Nothing is needed from you while Kauro works. You can close this page and come back to the project."
   (`screens/processing.ts:8`)

### 4.5 Confirmation before an irreversible or money action
Use it only for:
- approving a plan;
- confirming a quote (creating the payment order);
- requesting a refund;
- approving a payout;
- deleting files now;
- closing a workspace;
- changing bank details;
- removing a member.

A routine action is never confirmed (research C11, C12).

Template:
- **Title:** the verb and its object ("Approve this plan").
- **Body:** the exact effect, with its numbers and money; what cannot be undone; what stays available.
- **Acknowledgement:** a checkbox that names the effect, when the authority requires one.
- **Buttons:** the outcome verb ("Approve plan") and a way back ("Go back", "Keep the files"). Never "Yes", "OK" or "Confirm" alone.
  The destructive button never has default focus.
- **Identity:** a step-up when the action is sensitive (§2.5).

1. Existing: "Approve this plan" / "You approve exactly the effects listed here, for this version of the plan. A change to the plan
   needs a new approval." (`screens/approval.ts:12-13`). The buttons become "Approve plan" and "Go back"; they are "Approve" and
   "Cancel" today (`:14-15`).
2. Owner console, a payout: "Approve this payout" / "USD 1,140.00 to Daniel Kim, to the verified account ending 4821, by Nov 17, 2026.
   Kauro pays the transfer fees. It is marked paid only when the bank confirms it." / [Approve payout] [Go back]
   (`ui36-commissions.tsx:323-328`, tightened)

### 4.6 Success
Template:
- **Heading:** what is now true, in the past tense ("Plan approved").
- **Body:** where the result is, and the next step with its owner.
- **Never:** "Done" or "Success" alone.

1. Existing: "Plan approved" / "Your approval is recorded for this exact plan." (`screens/approval.ts:20-21`), followed by "Next: Kauro
   issues the quote."
2. Existing: "Your case is open" / "Kauro will respond by the time below." (`screens/support.ts:53-54`)

### 4.7 Permission denied
Two different cases:
- **Inside your own workspace:** say which role can do it and, when known, name a person who holds it. Never hide that the action
  exists.
- **Another customer's data:** answer exactly as for something that does not exist (`public.ts:541`). Never confirm that it exists.

Template (own workspace): "Only {roles} can {act}. Ask {person or 'an owner of this workspace'} to {act}."

1. Existing: "Only an owner or a billing member of this workspace can accept the terms and create the payment order."
   (`screens/quote.ts:74`)
2. Replaces "Your role does not allow sealing this revision." (`screens/sources.ts:180`): "Only an owner, an admin or an operator can
   seal this set. Ask Samuel Osei (Admin) to seal it."

### 4.8 Stale or changed while reading
Template:
- **Heading:** "This changed while you were working".
- **Body:** what changed and what was kept. Offer to compare; never overwrite silently.

1. Existing: `state.STALE` (`en.ts:131-132`).
2. Existing: "The selection changed. The counts below belong to the earlier selection until it is evaluated again."
   (`screens/sources.ts:144`)

---

## 5. Headlines, buttons, links and the lint

### 5.1 Headline patterns

| Kind | Pages | The h1 | The lead | Examples |
|---|---|---|---|---|
| **Path page** (a visitor deciding) | Home, How it works, Supported services, Pricing, Sample delivery | The outcome or the offer as a statement, ending in a full stop, 65 characters or fewer, naming the object. It never contains AI, and never presents Clean your data as the headline offer | Who acts and the main limit, in one or two sentences | "Prepare and verify CRM data from files." (UI01); "Three services for your exported CRM files." (R2-2) |
| **Reference page** (a visitor looking something up) | Data handling, Help, Contact, Service status, legal texts | What the reader can know or do, ending in a full stop | What this page covers and what it does not claim | "Know what is processed and when it is deleted." (UI06); "Request a free data health check." (R2-1) |
| **Tool screen** (signed in) | Every workspace, seller and owner page | The area's name, identical to its navigation label, with no full stop. A project page has the project's name as h1 and the stage strip under it | The registry's primary sentence, or one sentence on this state, front-loaded | "Payouts" / "What you owe sellers, when, and what is holding it."; "Quote" / "Review price, scope and availability." |

Rules for every heading:
- Headings are in sentence case, front-loaded and unique on their screen. Two headings never start with the same two words.
- A section heading is a noun phrase or a short statement, with no full stop. A question is used only in a list of questions.
- A dialog title is a verb and its object.
- A status label is one to four words, in sentence case, always with a word and never colour alone.
- Headlines get their own auditions (master plan §2.2), and this file only sets their form.

### 5.2 Button labels
- **The verb comes first**, in sentence case, with no full stop. Name the outcome and the object: "Approve plan", "Seal this set",
  "Request a refund", "Download the package".
- Keep the article where the object reads naturally with it, as in the fixed call to action "Request a free data health check" (I-20).
- **One primary (filled) button per view.** On the public site it is the call to action, in the closing band. The remaining actions
  are secondary buttons or text links. A destructive action is never primary, except inside its own confirmation.
- **Same action, same label, everywhere** (I-19, I-21).
- **Never use:** "Submit", "OK", "Yes", "Click here", or "Continue" for a commitment.
- **"Cancel"** only closes a dialog without acting. To stop something that is running, write "Cancel the check" or "Cancel
  preparation", and the way back is "Keep it running".
- **Disabled buttons** are avoided. When one is used, its reason is visible beside it (`screens/quote.ts:72-73`).
- **Working state:** the label stays and a line below says what is happening and whether to wait ("Recording your approval. Do not
  repeat this step.").

### 5.3 Link text
- A link names its destination or result. On its own, out of context, it still makes sense. It is never "here", "more" or a bare URL.
- **Verbs by kind:**
  - "See {page}" for a public page;
  - "Read {legal text or guide}";
  - "Open {object}" for a project, case or delivery;
  - "Go to {area}" for a workspace area.

  The object is the page's exact name.
- Inconsistent today: "View the synthetic sample" (`public.ts:54`), "See the sample delivery" (`:389`), "Read pricing" (`:509`), "See
  pricing" (`:391`), "See the prices and estimate yours" (`:251`) and "Review supported services" (`:309`). Choose "See the sample
  delivery", "See pricing" and "See supported services".
- An external link says where it goes. In emails, the URL stands on its own line (§6.3).

### 5.4 The lint rules as a checklist
These are enforced by `lint.ts`, `copy-lint.test.ts` and `public-copy.test.ts` today, unless marked "(not linted)". A new page passes
every line before review.

**Names**
- [ ] The free step is "Free data health check". The call to action is exactly "Request a free data health check".
- [ ] Never "audit" or "diagnosis", in any form or case.
- [ ] "Prepared for import", never "Imported" (case-sensitive in the lint; treat "imported" as a project state as refused too).
- [ ] The pre-rename brand is never written.
- [ ] The services are "Clean your data", "Prepare for HubSpot" and "Prepare for Salesforce", never CLEAN or another uppercase id
  (not linted; owner decision).

**AI**
- [ ] AI never appears in a title, heading, label, call to action, offer, subject or name.
- [ ] AI appears in running text only in the one permitted sentence, at most once per page or message.
- [ ] Never "AI-ready", "AI cleans", or Kauro preparing data for, connecting to, training or improving anyone's AI.
- [ ] Never "without losing money" or "without mathematical hallucinations".

**Claims**
- [ ] Never "works with any CRM", "compatible with" or "import-ready for any CRM". A third-party CRM is never named beside an offer;
  write "another CRM" (the naming part is not linted).
- [ ] HubSpot and Salesforce are never described as integrated, synchronised or connected to.
- [ ] Never "we delete duplicates", "remove records" or "eliminate records". Write "unified with your approval; nothing is removed
  without a trace".
- [ ] No savings amount, no "pays for itself", no guaranteed saving, no "if we find nothing". Write "the check is free and creates no
  obligation to buy".
- [ ] Never "certified", "guaranteed", "100%", "risk-free" or "instant(ly)".
- [ ] No fifteen-minute promise, except the download-link retention row.
- [ ] No founding-discount line until a founding slot can really be reserved.
- [ ] A service is named as open or qualified only when the capability publication lists it (enforced at render time).
- [ ] The free check is never described as unlimited or always immediately available (not linted).
- [ ] No real health check is promised in a fixed short time (not linted).
- [ ] No publication version on a service card (R2-3; asserted absent).

**Buyers**
- [ ] A line about who may buy, who gets a discount, who holds an account or whose data is kept apart names any customer, never an
  agency alone (D-33).

**Form**
- [ ] Copy is plain text, with no markup, no leading or trailing space, and placeholders written `{name}` only.
- [ ] No price is typed into a message; prices come from the policy bands. No prose is typed into a public page component.
- [ ] Every message is used by a page, and no id is defined twice.
- [ ] Every shared state has a distinct title. The payment-uncertain state says "Do not pay again", and a pending title never says
  "fail".

**Also check by hand (not linted; this file)**
- [ ] The glossary (§2): no word from a "Do not use" column.
- [ ] Number, date and currency forms (§3).
- [ ] Neutral pronouns.
- [ ] English only, with British spelling.

---

## 6. Documents and emails

Documents and emails use the same glossary and the same number, date and currency rules. They differ in voice volume, brand and
medium.

### 6.1 Documents an agency may forward (white label)
These are the package report, the exception files, the import instructions and the forwarded one-page summary. The reader may be the
agency's client, who has never heard of Kauro.

- **The agency's brand leads** ("Prepared by {brand}"). Kauro appears only in the issuer line, which white label cannot remove
  ("Service provided by {legalName} ({jurisdiction}, {registrationId}) under terms {termsVersion}", report `copy.ts:11`).
- **No Kauro voice markers:**
  - no "Kauro proposes; you decide";
  - no "Kauro" as the subject of a sentence;
  - no "we";
  - no tagline;
  - no reference to the public site, pricing or the free data health check.

  The voice is neutral and third person: "This package…", "The plan approved on Oct 21, 2026…".
- **No commercial facts between Kauro and the agency:** no quote, price, band, discount or "your quote" (I-27). The billable source
  unit is defined by what it counts, never by what it priced: "Objects in the sealed files, counted before duplicates were unified."
- **"Your team" is ambiguous** once a document is forwarded. The import instructions speak to the person importing, in the imperative
  ("Import the files under 01_IMPORT in the order below"). The report names the action without an owner: "Prepared for import. No
  record has been written to any CRM."
- **Printed, not clicked:**
  - no "click", "below the button" or hover text;
  - a reference to another part reads "see Exceptions to review, page 4";
  - every table has its unit in the header;
  - every count has its definition (report `copy.ts:19-38`);
  - every page carries the title and "Page n of m".
- **Absolute dates** with their zone, and the evidence line (package, manifest, core, report model and renderer versions) at the end.
- **The title follows the service.** For Clean your data, nothing says "import" (Q-3).

### 6.2 Kauro-branded documents
These are the quote and order summary, the payment instructions, the commission statement, the deletion receipt and the free data
health check report. They are not built yet (deliverables plan §1).

- The Kauro voice is used at low volume, with the wordmark allowed. The glossary and §3 apply in full.
- A money document states its basis ("before tax", "collections, not invoices") and its status in words ("Not a fiscal invoice",
  "Paid only with the bank's proof").
- A seller statement shows the retainer and every offset with its basis, amount and balance. It never hides a figure the agreement
  sets.

### 6.3 Machine and package files (CSV, JSON, Markdown)
These files are written by the Migration Core. Their wording changes only through the deliverables plan's specimens and patch, and
the core is never edited here.

- **Import files** use the destination's own column names, unchanged.
- **Exception and trace files** pair each reason code with a plain-English reason column, so a person never needs the code list.
- **CSV:**
  - ISO 8601 UTC dates;
  - a decimal point and no thousands separator;
  - no currency symbol (the currency goes in its own column);
  - `true` or `false`;
  - an empty cell means "not applicable", and "unknown" is written as a word.
- **The spreadsheet-safe copies** (`04_DOCUMENTATION/data-view/`) use readable headers in sentence case.
- **Markdown documents** have sentence-case headings, service names instead of mode ids, and no "audit" (I-26). They render the same
  in a plain text editor.

### 6.4 Emails
- **Who receives them:** emails go only to members of a workspace, to sellers, to Kauro's owner, or (outreach) to a prospect. Kauro
  never emails an agency's client (A3 §3.7).
- **Format:** every email has a plain-text part. There are no attachments of CRM data and no records in the body, only counts and
  names already shown in the workspace.
- **Subject:**
  - 60 characters or fewer;
  - states the fact and the project;
  - no AI, no "Imported", no urgency words ("urgent", "act now", "last chance");
  - no emoji.

  Example: "Plan ready for approval: Contacts migration".
- **Body:**
  - The first sentence is what happened.
  - The second is what to do and by when, as an absolute date with its zone.
  - Then comes one link, on a line of its own, with the full URL.
  - A notice never tells the reader to reply with data.
- **Signature:** a notice is signed "Kauro". Outreach is signed by the actual sender, with the business identity and postal contact
  (A3 §4.6).
- **Footer:** it says why the reader receives the email. An optional message has a one-click way to stop it. A notice (account,
  payment, files, support case) says it cannot be turned off (`public.ts:692`).

Template: "{What happened} for {project}. {What to do} by {date, time, zone}.\n\n{URL}\n\n{Why you receive this}"

Examples:
1. Subject "Payment confirmed: Contacts migration". Body: "Kauro matched your transfer of USD 1,230.25 to order KR-2026-0142 on Oct 21,
   2026, 2:02 PM UTC. Your team can start the preparation from the project." Then the link. Footer: "You receive this because you
   manage billing in the Northwind workspace. Payment notices cannot be turned off."
2. Subject "Files deleted Oct 27 unless bought: Contacts migration". Body: "The files of the free data health check for Contacts
   migration are deleted on Oct 27, 2026, 10:58 AM UTC unless the project is bought. An owner or admin can extend them once from Data
   and deletion." Then the link.

---

## 7. Questions for the owner (not assumed)

- **Q-1. Time zone in the owner console and seller portal.** Bogotá time for business dates and UTC on technical pages, as the
  round-2 research proposes (§3.4)? Or UTC everywhere, as in the workspace?
- **Q-2. The final state of a Clean your data project.** "Delivered" is proposed, because "prepared for import" does not fit a
  service with no import.
- **Q-3. The report's title by service.** Today it is "Import package report" for every service. Proposed: "Preparation report" for all
  three, with the service name as a subtitle.
- **Q-4. Home's six step names** (Upload, Measure, Decide, Quote, Prepare, Import). Do they stay as Home's own verbs, or align with the
  stage short names? This is decided in Home's audition (I-01).
- **Q-5. Registry primaries that conflict with this glossary.** UI09, UI10, UI11, UI32 and UI51 say "agency"; UI12 says "end client";
  UI16 says "source revision"; UI20 says "merging". Amend them (R2-x) together in one change, or leave them until a later registry
  version?
