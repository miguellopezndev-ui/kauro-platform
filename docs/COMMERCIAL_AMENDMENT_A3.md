# Amendment A3 — commercial positioning

Status: adopted by owner decision on 2026-09-25. It governs every public, application, report, terms and outreach text produced
in this repository from that date on. It is proposed to the authority as a versioned amendment and binds the construction
service only once the re-issued authority package contains it (section 1.3). Owner decision (2026-09-25), verbatim: "estoy de
acuerdo en todo lo que dijiste, hazlo así como lo pensaste" ("I agree with everything you said; do it the way you thought it
through").

A3 changes messaging, positioning and one admission rule. It does not change what is built. The 22 program packages, the 441
acceptance cases, the 64 commands, the 73 contracts, the policy registry (prices, discounts, limits, retention) and the vendored
registry under `packages/contracts/registry/` stay byte-identical. The hashes in `PROVENANCE.json` stay unchanged.

Quotation convention: A3 quotes the R2 manuals verbatim, with one exception. Where the R2 text uses the pre-rename brand, the quote
says Kauro (amendment A2). Section references use the headings of the R2 files in `authority_r2/`.

## 1. Status, decision and scope

1.1 **What the owner approved.** The owner approved the whole revised strategy report of 2026-09-25 (the Spanish report he read).
   That report compared his proposed commercial strategy with the R2 design. His approval covers every rule adopted in section 3,
   including admitting in-house CRM and data teams under their guardrails (rule 3.7). It also covers deferring every item in
   section 6 until after launch. The review had an analyst report and critic corrections. Where the critic corrected the analyst,
   A3 follows the correction, because the corrected version is the one the owner read. Evidence: workflow output `wbo4ftizd` of
   the Claude session of 2026-09-25 (analyst report, critic corrections, revised report). The output is not stored in this
   repository.

1.2 **Truth about scope (CH-012).** The CLEAN engine exists and is tested, but it is not accepted. The platform that sells CLEAN is
   still under construction: upload (B07), audit orchestration (B08), checkout (B09) and the public and agency application (B11).
   Nothing in A3 can be sold before commercial production activation (B19). Until activation, outreach keeps the "being built"
   wording that 18 §Draft: first contact requires. A3 gives no capability a new state.

1.3 **When A3 binds the construction service.** The construction service's roles read the installed R2 manuals and registries
   directly (`00..31 *.md`, `registry/*.json`, `reference/*.md`, `prompts/B*.md`). A document in this repository does not change
   what they read. So the authority package must be re-issued with A3 attached before the service reviews B11 or B19; otherwise
   the reviewer could flag A3-compliant copy as contrary to the R2 text. The re-issue is the planned deep-rename runtime round of
   A2 rule 4, and it carries A2 and A3 together. Four other packages produce output that A3 governs, from manuals it amends
   (`registry/program.json`, field `docs`):
   - B12 (seller prospecting and the operating review; manuals 12 and 18);
   - B13 (report title; manual 13);
   - B18 (release audit of distributed assets; manuals 01 and 29);
   - B20 (first customers; manuals 16 and 18).

   B00 and B01 (01, 29), B09 (16, 19), B10 (16, 18), B15 (19) and B21 (29) also read amended manuals. Their outputs contain no
   customer-facing copy that A3 governs, and A3 changes none of their behavior, so a review against the unamended text cannot
   diverge for them. The practical rule is therefore: re-issue before the first of B11, B12, B13, B18, B19 or B20 reaches
   review. Until then, A3 guides Claude's work in `kauro-platform`.

1.4 **What the re-issue changes in the authority package.** Everything else in the package stays as it is:
   - the manual text in section 4;
   - `registry/decisions.json` gains record D58 (section 4.9). That file is not vendored in this repository, so the vendored copy
     and its provenance are unaffected;
   - 31 §Delivered structure counts fifty-eight recorded design decisions instead of fifty-seven;
   - `MANIFEST_SHA256.json` and the compiled `project_load` volumes are regenerated (00: "Do not edit a compiled volume
     independently").

   `registry/screens.json` is deliberately not edited. Its records UI07 (Contact) and UI18 (Audit) are vendored here, and editing
   them would break byte identity. The manual text amended by A3 governs the rendered copy of those screens. The registry records
   keep their ids, routes and titles as internal names. If a later change needs a typed field or a changed screen record, it goes
   through a ChangeProposal and a new registry version (28 §How a change is made), not a silent edit.

## 2. Change record

The fields below are the ones required by 01 §Authority and change control, 28 §How a change is made and 20 §Review output.

| Field | Content |
|---|---|
| Observed reason (motive) | On 2026-09-25 the owner proposed a new commercial strategy with four goals: depend less on HubSpot and Salesforce accepting the data, lead with a free diagnosis, sell cleaning as a core service, and add high-ticket and recurring offers. The review found that its most sellable parts already exist in R2: the free audit (02 §5) and CLEAN, which needs no destination CRM (02 §Service modes). Those parts need only presentation. The rest is new product scope, legal exposure or consulting that the company cannot deliver. |
| Evidence and its limits | R2 manuals and registries; the Migration and Intelligence core repositories; the review of 2026-09-25. Kauro has no customers and no paid conversions (16 §Alternatives and retained price hypothesis). No revenue comparison between the owner's strategy and the current design is possible, and none is claimed. The legal references in section 5 identify applicable regimes for the rejections. They are not a legal opinion, and no source record is added for them. Any later use of them in a deferred item adds verified source records at that time (28 §Evidence rules). |
| Alternatives considered | (A) Keep the current positioning and record nothing. Rejected: it forgoes zero-cost gains and leaves the owner's decision undocumented. (B) Build the whole strategy before launch. Rejected: roughly 6 to 12 or more months, which would put production in the second half of 2027 or early 2028. It adds serious legal exposure and needs hires, and nothing shows it earns more. (C) Make CLEAN the headline offer. Rejected: CLEAN is 40–54% cheaper at the same band, and its compatibility claim is forbidden (rule 3.3). (D) Adopt the messaging, keep admission agency-only. Considered; the owner chose (E). (E) Adopt the messaging and admit inbound in-house teams with guardrails, reject the unsafe items and defer new product scope. **Chosen.** |
| Chosen behavior | Section 3 (adopted rules) and section 4 (amended text). |
| Rejected | Section 5. |
| Deferred | Section 6. |
| Impacted policy IDs | None. The same pricing schedule (`R2-INITIAL`), discounts, limits, retention and messaging limits apply. |
| Contracts, commands, cases, gates | None changed: 73 contracts, 64 commands, 441 cases, gates unchanged. No acceptance case is added. These existing cases already enforce A3's claim boundaries: R2-107 (seller overpromises import success, B20), S087 (unauthorized discounts or certifications, B19), S086 (public landing without readiness, B19), R2-111 (agency processor chain, B19), R2-090 and R2-127 (founding slot concurrency and reservation, B10). |
| Data migrations | None. |
| Producers and consumers | Producers: the B11 copy (site, onboarding, application), the B13 audit report title, the B19 public offer, terms and DPA template, and the manual 18 drafts materialized by the assistant or a seller (B12 workspace, B20). Consumers: prospects, agencies, admitted in-house teams, and the B18 release audit and construction-service reviewers. |
| Security and privacy effects | An in-house tenant is the controller of its own data and Kauro its processor. The DPA template covers that two-party chain (rule 3.7). The prohibited-data notice, data categories (19 §Data categories and excluded use), minimization, retention and model-path rules are unchanged. No network enrichment, credential or monitoring path is introduced. |
| Price and commission consequences | None (section 7.1). |
| Invalidated evidence | None. No accepted evidence exists for the affected packages, and no contract, case or registry byte changes. |
| Migration and transition | Prospective (28 §How a change is made). Issued quotes, accepted terms and earned commissions do not drift. Active construction mandates are unaffected. |
| Rollback limits | Every rule is text and can be reversed prospectively. Once an in-house tenant has accepted terms, holds a quote or has paid, a withdrawal of rule 3.7 stops only new admissions. Existing obligations are honored (00 §Reading and authority: a signed agreement is preserved). |
| Implementation mandate and qualification plan | No new mandate or package. The copy is written inside the B11, B12, B13, B19 and B20 mandates. It is qualified by the existing cases listed above, by the B18 release audit and by the construction-service review against the re-issued authority (1.3). |
| Funding source | None beyond work already planned. The copy is written inside packages that are built anyway (B11, B13, B19), and the DPA chain joins the lawyer review that B19 already requires. |
| Owner action | None beyond the decision already given. The company-as-controller DPA chain joins the lawyer review that B19 already requires (R2-111). |
| Review trigger and date | Section 7.3. |
| Affected sections | 01 §Purpose and customer promise; 02 §Buyer, user and job to be done, §1 Discover and qualify fit, §5 Receive the audit; 11 §Public route map, §Application navigation, §Audit overview; 13 §Audit report content; 16 §Offer and buyer fit, §Founding incentive, §Decision rules for experiments; 18 §Initial channel decision, §Prospect qualification, drafts, §Weekly and monthly operating loop; 19 §Data processing agreement; 28 §Material decisions (D58); 29 (new state entry); 31 §Delivered structure (count). |

## 3. Adopted rules (messaging and positioning only; zero build cost)

These rules bind anyone who writes customer-facing text:
- the builders of B11 (public site, onboarding and application copy);
- the builders of B13 (report titles);
- the builders of B19 (truthful public offer, terms and DPA template);
- the reviewers of B18;
- whoever materializes a manual 18 draft (the assistant, the owner or a seller in the B12 workspace, and B20 operations).

All product copy is English (11; D54). Spanish names are used only in explanations to the owner. Capability claims still come only
from the capability publication (02 §Capability publication contract).

3.1 **AI is a secondary context line only.**
   - Permitted wording, at most one sentence per page or message and never in the first screen's headline: "Before any CRM or AI
     project, your data needs to be clean, deduplicated and with every change explained. The free data health check shows you the
     exact numbers."
   - AI never appears in a headline, subject line, page title, offer name, capability label or deliverable name.
   - Never say or imply "AI-ready data" as a deliverable, "AI cleans your data", or that Kauro prepares data for, connects to,
     trains or improves a customer's AI.
   - Never use the owner's original phrases "without losing money" or "without mathematical hallucinations".

   Basis: 18 §Initial channel decision ("It should not be generic AI marketing"); 11 §Public route map (no "AI cleans everything"
   step).

3.2 **The public name is "Free data health check".** This is the customer-facing name of the free pre-purchase audit (02 §5).
   - Use the same name on the site, in the application and as the report title, so that a customer never sees two names for one
     thing.
   - The short form "health check" is allowed where space is limited, such as a tab or a button. The words "audit" and "diagnosis"
     are not used for this step in customer-facing copy.
   - Internal identifiers stay unchanged: the `Audit` contract, `StartAudit`/`CancelAudit`, the `AUDIT_REPORT` artifact family,
     the route `/projects/{id}/audit` and the screen record UI18.
   - The public call to action is "Request a free data health check". It leads to the fit form and then to account creation and
     onboarding, never to an anonymous upload.
   - The name creates no new entitlement. The check stays qualified: 26 says to invite only supported projects to audit and not to
     spend the free-audit pool on unqualified curiosity.
   - The check stays abuse-controlled and bounded: USD 1.50 of model spend per check (`freeAuditCeilingCents` 150), one active
     audit per customer tenant (`agencyAudits` 1), and a pause of new free checks at 90% of the funded envelope (14 §Cost
     controls). Copy never implies that it is unlimited or always immediately available.

3.3 **CLEAN stands beside HubSpot and Salesforce and does not replace them.**
   - CLEAN is presented beside the HUBSPOT and SALESFORCE modes as the offer for buyers without a qualified destination: a client on
     another CRM, a spreadsheet-only client, a cleanup before a migration, or a destination not yet chosen.
   - Permitted wording: "Cleaned, explained standard files that your team imports with its own tools. Kauro qualifies imports only
     for HubSpot and Salesforce."
   - Any text that names a qualified destination or mode names only those the capability publication lists as available when
     the text is published (02 §Capability publication contract). A mode that is not available is not named as qualified.
   - Never say "works with any CRM", "compatible with [CRM]" or "import-ready for any CRM". Never list a third-party CRM beside a
     Kauro offer, because it reads as a compatibility claim. Public copy says "another CRM". Basis: 02 §Service modes, CLEAN row,
     "No claim that a generic clean file satisfies an unknown CRM schema"; R2-107.
   - Say "we unify duplicates with your approval; nothing is removed without a trace". Never say "we delete duplicates" or "we
     eliminate records". A duplicate candidate is never presented as a confirmed duplicate (02 §5).
   - Say "we clean exported files, not your live CRM" (05 §Operation taxonomy: live CRM merges and deletes are outside the product).
   - The Home page keeps its concrete job, "prepare and verify CRM data from files". CLEAN is never the site's headline offer
     (section 7.1, cannibalization).

3.4 **The prices are shown as a ladder.** The Pricing page presents the existing schedule, unchanged, as steps:
   - Free data health check;
   - CLEAN from USD 695;
   - HubSpot preparation from USD 1,295 and Salesforce preparation from USD 1,495 (up to 50,000 billable source units; higher bands
     as published);
   - repeat discounts of 5%, 10% and 15%;
   - the founding discount of 25%, only while a founding slot can actually be reserved. The line is removed when none can be.

   Every displayed price remains an indicative band until the server issues a quote from the sealed scope (11 §Public route map).

3.5 **Only three money arguments are permitted, because they are true today.**
   1. "The free data health check shows how many duplicate candidates, invalid values and target blockers your client's files
      contain, measured on all the data you upload within the published limits, before anything is imported." Basis: 02 §5;
      13 §Audit report content.
   2. "When Kauro prepares a HubSpot import, marketing-contact status and paid enrichment stay switched off unless your agency
      decides to enable a supported setting, because both can add cost to your client's bill." Basis: 05 §HubSpot profile,
      Fields and values ("never enabled by default").
   3. "If your agency sells periodic cleanups, each one is a new project. The repeat discount starts with your second project:
      5% when your agency has one to nine qualifying projects in the preceding 365 days, 10% from ten and 15% from twenty-five.
      Safe templates carry your earlier column and target settings forward for review, and approvals are never reused." This is
      the zero-build recurring offer: no subscription and no guarantee. Basis: 16 §Recurrence decision; 20 §Templates and agency efficiency; 02 §10.

   Never state a savings amount ("you save USD X"), "the project pays for itself", "without losing money" or a guaranteed saving
   (12 §Outreach workspace; 26 §Months two and three). Never write "if we find nothing, the report is free", because the check is
   always free. Write "the check is free and creates no obligation to buy". The owner-approved wording "the check is free and the
   report is yours" is used once B11 and B13 let the customer download the health-check report, and then together with how long
   the report stays available in Kauro (13 §Privacy in reports and downloads; retention).

3.6 **The 15-minute demonstration is the Sample delivery plus a recorded demo.**
   - The demonstration is the synthetic Sample delivery (11 §Public route map; UI05) plus a short recorded demonstration
     (02 §1; 18 §Draft: optional call). Together they can be reviewed in about fifteen minutes. Synthetic data stays labelled.
   - Never promise a real health check of the customer's data in fifteen minutes, or any other fixed short time, for three reasons:
     - onboarding comes first: identity, agreements and MFA before data access (11 §Agency onboarding);
     - interpretation may take up to 20 minutes, and the full check may take hours (`interpretationSeconds` 1200,
       `auditAbsoluteSeconds` 86400; D12);
     - at launch one heavy job runs at a time (`heavyActive` 1, `heavyQueued` 3).
   - Any duration shown is an estimate derived from observed capacity (11 §Project dashboard).

3.7 **In-house teams are admitted, with every guardrail.** The in-house CRM, RevOps or data team of a company may buy through the
   same flow when it arrives on its own.
   - **Nobody prospects non-agency companies.** Outreach, research, content targeting, seller prospect records and attribution
     claims stay agency-only, for the owner, sellers, the assistant and any automation alike. A non-agency company or its
     in-house team is never recorded as a prospect (12 §Prospect record; 18 §Prospect qualification).
   - **One line on the site.** The site stays agency-first. Exactly one sentence addresses in-house teams: "In-house CRM and data
     teams can use Kauro too." It appears once, on the Pricing page beside the account-creation action. Home, How it works and For
     agencies are not rewritten for them.
   - **The fit form records the buyer type.** The fit form (02 §1; Contact, UI07) asks one required closed question: "Who will use
     Kauro?", answered "An agency preparing data for clients" (`agency`) or "An in-house team working on our own company's data"
     (`in-house`).
     - An account created without a prior inquiry answers the same question once during onboarding, before its first quote.
     - The answer is stored with the inquiry or onboarding record. No registry contract models the inquiry or the onboarding
       answers, so no contract changes.
       If a typed field on a registry contract (`Agency`, `Prospect`) proves necessary, B11 raises a ChangeProposal instead of
       extending a closed contract.
     - The monthly review (18 §Weekly and monthly operating loop) reports inquiries, health checks, quotes and paid projects by
       buyer type, so that D01's review trigger ("paid conversion by segment") can be measured.
     - The buyer type does not change price, discounts or admission checks.
   - **Founding slots are open to in-house teams.** An admitted in-house tenant can take one of the three 25% founding slots on the
     same terms as an agency (16 §Founding incentive). The total stays three.
   - **The processing agreement covers a company that controls its own data.** The DPA template (19 §Data processing agreement)
     covers the two-party chain: the company is the controller and Kauro its processor. The lawyer review before activation
     (B19, R2-111) covers it.
   - **Same fit, same limits.** The same fit checks apply (16 §Offer and buyer fit). These are the authority to process the data
     and make semantic decisions, a real person responsible for import, a supported envelope, a plausible date and a payment
     route. The same data-category exclusions and prohibited-data notice apply. An in-house buyer gets no consulting beyond the
     product (16: the offer "is not an unlimited consulting retainer"). An unsupported scope gets the manual 18 unsupported-scope
     answer.
   - **Kauro never sells around partner agencies.**
     - Kauro does not contact an agency's end client.
     - End-client names and data never leave the agency relationship. They are never used to find, qualify, contact or treat an
       in-house buyer differently.
     - An in-house buyer gets exactly the published schedule, so no offer can undercut an agency's quote.
   - **How the tenant is set up.** An in-house tenant uses the `Agency` contract, with its company as the single end-client
     workspace. `EndClient.processingAuthorityRef` records the company's own authority over the data.
   - **Reading rule.** Where R2 names the agency as the customer tenant, it also covers an admitted in-house tenant. This includes
     the account holder, plan approver, payer, holder of recurrence or founding eligibility, and the `Agency` contract. Where R2
     names agencies as the outreach, research, content or channel segment, the text stays agency-only.

## 4. Amended authority text

Each entry gives the current sentence and its replacement or addition. The text not listed is unchanged.

### 4.1 `01_CHARTER.md` §Purpose and customer promise, first paragraph

Current: "Kauro helps professional agencies turn authorized CRM exports and business spreadsheets into an explainable, verified
delivery for data cleaning or an explicitly supported CRM import. The agency remains the contracting customer and the authority
for its end client's data. Kauro earns revenue by reducing preparation work, preventing avoidable import mistakes, and making
decisions and exceptions reviewable."

New: "Kauro helps professional agencies, and in-house CRM or data teams working on their own company's data, turn authorized CRM
exports and business spreadsheets into an explainable, verified delivery for data cleaning or an explicitly supported CRM import.
The agency remains the contracting customer and the authority for its end client's data; an admitted in-house team's company is
the contracting customer and the controller of its own data. Agencies remain the only segment Kauro prospects. Kauro earns revenue
by reducing preparation work, preventing avoidable import mistakes, and making decisions and exceptions reviewable."

### 4.2 `02_PRODUCT_AND_CAPABILITIES.md`

§Buyer, user and job to be done, first paragraph. Current last sentence: "Kauro contracts with the agency, not with each person
appearing in an uploaded table." New: "Kauro contracts with the agency, or with an admitted in-house team's company, not with each
person appearing in an uploaded table."

Added paragraph after it: "An in-house CRM, RevOps or data team of a company may also buy through the same flow when it arrives on
its own. It registers as its own customer tenant with its company as the single end-client workspace, confirms that the company
controls the data, and passes the same fit, data-category, authority and payment checks. Kauro does not prospect in-house teams:
outreach, research, content and seller prospecting remain agency-only. Where this edition names the agency as the customer tenant,
account holder, approver, payer or holder of recurrence and founding eligibility, it also covers an admitted in-house tenant; where
it names agencies as the outreach or channel segment, it does not. The fit form records the buyer type so that conversion can be
measured by segment (D01, D58)."

§1 Discover and qualify fit. Current: "The fit form collects business contact details, destination, approximate record band and
desired timing." New: "The fit form collects business contact details, buyer type (agency preparing data for clients, or in-house
team working on its own company's data), destination, approximate record band and desired timing."

§5 Receive the audit. Current: "The free audit is bounded, abuse-controlled and funded before any model request." New: "The free
audit is bounded, abuse-controlled and funded before any model request. Its customer-facing name is 'Free data health check' on
the site, in the application and as the report title; internal identifiers keep the name Audit (amendment A3)."

### 4.3 `11_AGENCY_EXPERIENCE.md`

§Public route map. Current: "Home states the concrete job: prepare and verify CRM data from files. The primary action is to
assess a project or create an agency account under the current admission policy. The page does not promise direct live CRM
migration when the product delivers import packages." New: "Home states the concrete job: prepare and verify CRM data from
files. The primary action is to request a free data health check, which starts the fit assessment, or create an agency account
under the current admission policy. The page does not promise direct live CRM migration when the product delivers import
packages. At most one secondary sentence may say that clean, deduplicated data with every change explained is the first step
before any CRM or AI project; AI never appears in a headline or offer name."

Current: "How it works shows upload, audit, agency decisions, purchase, processing and import preparation." New: "How it works
shows upload, the free data health check, agency decisions, purchase, processing and import preparation."

Current: "Supported services reads the capability publication. It lists supported formats, objects, operations and limits, with
unavailable capabilities visibly excluded from purchase. Pricing explains the counted unit, mode, recurrence and taxes. A displayed
price is an indicative band until the server issues a quote from the sealed scope." Added after it: "Supported services presents
CLEAN beside HUBSPOT and SALESFORCE as the service for buyers without a qualified destination: cleaned, explained standard files
that the buyer imports with its own tools, with no claim of compatibility with any unqualified CRM. Pricing presents the existing
schedule as a ladder: free data health check, CLEAN, HubSpot or Salesforce preparation, repeat discounts, and the founding discount
only while a slot can actually be reserved. Pricing carries the site's single sentence for in-house teams: 'In-house CRM and data
teams can use Kauro too.'"

Current: "Sample delivery uses synthetic data and exposes a representative report, manifest explanation and import guide." Added
after it: "Sample delivery and a short recorded demonstration form the fifteen-minute demonstration. No page promises a real health
check of customer data within fifteen minutes or any other fixed short time."

Current: "Security explains actual controls and retention without claiming certification, guaranteed anonymity or zero retention
that has not been established." Added after it: "It never claims that Kauro finds security vulnerabilities in customer systems or
guarantees regulatory compliance; it names only the data risks the accepted report actually presents."

Current: "Contact collects business details and a safe project description." New: "Contact collects business details, the buyer
type (agency or in-house team) and a safe project description."

§Application navigation. Current: "Project detail has Overview, Sources, Audit, Plan, Purchase, Delivery, Import and Activity, with
visibility governed by state and capability." New: "Project detail has Overview, Sources, Health check, Plan, Purchase, Delivery,
Import and Activity, with visibility governed by state and capability. The Health check view is titled 'Free data health check';
its route and internal identifiers keep the name audit."

§Audit overview. Current: "Audit summary shows exact admitted counts, issue families, proposed changes, unresolved decisions and
target blockers." New: "The health check summary shows exact admitted counts, issue families, proposed changes, unresolved
decisions and target blockers. In customer-facing text this screen is the Free data health check view; 'audit' in this section
is the internal name."

### 4.4 `13_REPORTS_AND_DELIVERABLES.md` §Audit report content

Current: "The first page states project, source revision, mode, target if known, audit date, scope and status." New: "The report
is titled 'Free data health check' with the project label. The first page states project, source revision, mode, target if known,
check date, scope and status."

### 4.5 `16_AGENCY_LIFECYCLE_AND_PRICING.md`

§Offer and buyer fit. Current: "Fit requires a supported source/target envelope, an agency able to authorize data processing and
semantic decisions, a real person responsible for import, a plausible project date and a payment route. A vendor badge, company
size or English website alone does not establish fit." New: "Fit requires a supported source/target envelope, an agency able to
authorize data processing and semantic decisions for its end client or an in-house team able to authorize them for its own
company's data, a real person responsible for import, a plausible project date and a payment route. A vendor badge, company size
or English website alone does not establish fit. The buyer type is recorded for segment measurement and does not change price,
discounts or admission checks."

Channel-conflict rule. Current: "Kauro does not contact the agency's end client to sell around the agency. End-client names and
data remain within the agency relationship. A future direct-customer offer requires a channel-conflict and product decision." New:
"Kauro does not contact the agency's end client to sell around the agency. End-client names and data remain within the agency
relationship and are never used to find, qualify, contact or treat an in-house buyer differently. Decision D58 is the
channel-conflict and product decision for in-house teams: they are admitted when they arrive on their own, under the same flow,
prices and discounts, and nobody (owner, seller, assistant or automation) prospects them. Any other direct-customer offer,
including outbound sales to non-agency companies, requires its own channel-conflict and product decision."

§Founding incentive. Current: "The founding incentive is 25% on the first eligible project for each of the first three accepted
founding agencies." New: "The founding incentive is 25% on the first eligible project for each of the first three accepted
founding customers, agencies or admitted in-house teams. 'Founding agency' in the registry and cases names that customer tenant."

§Decision rules for experiments. Current: "Do not run more than two simultaneous commercial cells while the sample and staffing are
small." Added after it: "The first two cells are HubSpot-oriented and Salesforce-oriented agencies. A CLEAN or other-CRM agency cell
opens only when one of those two cells closes."

### 4.6 `18_SALES_MARKETING_AND_SUPPORT.md`

§Initial channel decision. Current: "It should not be generic AI marketing." Added after it: "An AI reference is permitted only as
one secondary context sentence (clean, deduplicated data with every change explained is the first step before any CRM or AI
project), never in a subject line, headline, offer name or deliverable label, and never as a claim that Kauro prepares data for,
connects to or improves a customer's AI. Messages use only the money arguments of amendment A3 rule 3.5 and never state a savings
amount."

§Prospect qualification. Current: "A qualified account has evidence of relevant service work, target ecosystem, buyer role, likely
project cadence and a reachable business channel." New: "Prospects are agencies. A non-agency company or its in-house team is
never researched, recorded as a prospect or contacted for outreach; it can buy only when it arrives on its own (D58). A qualified
account has evidence of relevant service work, target ecosystem, buyer role, likely project cadence and a reachable business
channel."

Added after "Draft: first contact". These drafts are for use only after commercial activation; before it, the existing draft and
its "being built" wording stay. When materialized, they name only the modes and destinations that the capability publication lists
as available at that time (rule 3.3).

> **Draft: first contact after activation (health-check variant)**
>
> Subject: A free data health check before your next CRM import
>
> Hi [verified first name],
>
> I saw that [agency] works on [specific, verified CRM service]. Kauro prepares exported CRM files and spreadsheets for
> controlled cleanup and for supported HubSpot and Salesforce imports, with a reviewable plan, exception records and an
> agency-ready delivery report.
>
> The free data health check measures all the data you upload, within the published limits, and shows how many duplicate
> candidates, invalid values and target blockers it contains before anything is imported. [Optional context sentence: Clean,
> deduplicated data with every change explained is the first step before any CRM or AI project.]
>
> Would that be useful for an upcoming project? No customer data is needed to discuss fit, and the check creates no obligation to
> buy.
>
> [Actual sender] / [Actual business identity and postal contact] / [Simple opt-out]

> **Draft: follow-up after activation (client-cost variant)**
>
> Subject: Re: A free data health check before your next CRM import
>
> Hi [name],
>
> One detail that can affect your client's bill: when Kauro prepares a HubSpot import, marketing-contact status and paid enrichment
> stay switched off unless your agency decides to enable a supported setting, because both can add cost. [Only if the agency sells
> periodic cleanups: Each periodic cleanup is its own project, and from your second project a repeat discount applies, based on
> your qualifying projects in the preceding 365 days, starting at 5% and reaching 15% with volume.]
>
> Would that be relevant to an upcoming project, or should I close this out for now?
>
> [Sender and required footer]

> **Draft: destination without a qualified import (CLEAN)**
>
> Kauro qualifies imports only for HubSpot and Salesforce, so I cannot promise that a file will import cleanly into [destination
> named by the prospect]. What we can deliver is CLEAN: cleaned standard files in which duplicates are unified only with your
> approval and every change is explained, which your team imports with its own tools. The price comes from the files you seal; the
> first band starts at USD 695.

§Draft: optional call. Added after "I can send a short recorded demonstration with synthetic data.": "The recorded demonstration is
kept short enough that it and the Sample delivery can be reviewed in about fifteen minutes; neither is a check of your own data."

§Weekly and monthly operating loop. Current: "Monthly review separates first acquisition from repeat, agency from project and
captured money from available cash." Added after it: "It also reports inquiries, health checks, quotes and paid projects by buyer
type (agency or in-house team), and the purchased mode against the destination stated on the fit form (D01, D58)."

### 4.7 `19_COMPANY_LEGAL_AND_PEOPLE.md` §Data processing agreement

Current: "The DPA identifies the actual chain of roles. An agency may be controller for its own business data and processor for
its end client's CRM data; Kauro's role follows the specific processing. The agreement records the relevant controller or
authorized chain rather than assuming every agency owns all data." Added after it: "An admitted in-house team's company is the
controller of its own CRM data and Kauro is its processor; the DPA template covers this two-party chain as well as the agency
chains, and the lawyer review before activation covers both."

### 4.8 `28_DECISIONS_AND_SOURCES.md` §Material decisions — new entry after D55

§Material decisions ends at D55 in R2. D56 and D57 are recorded in `registry/decisions.json` and cited in §Sender operations
decision and added primary evidence, so D58 is the next free identifier. It follows D55 under §Material decisions, in the same
format as the entries there.

> ### D58: Agency-first positioning with zero-build commercial messaging and inbound in-house admission
>
> Owner: 16. Alternative considered: Build the owner's 2026-09-25 strategy before launch (infrastructure migration, scraping
> enrichment, monitored subscription, ERP tables, direct mid-market sales) or make CLEAN the headline offer.
>
> The sellable parts of the strategy already exist in the design and need only presentation: a free entry check, cleaning without
> a destination CRM, true money arguments and periodic cleanup through repeat projects. Admitting inbound in-house teams widens who
> can buy without code or outreach. By the review's estimate, the expansions would add 6 to 12 or more months, legal exposure and
> hires, with no evidence of higher contribution. Amendment A3 records the adopted rules, rejections and deferred proposals.
>
> Review trigger: Paid conversion by buyer type (D01), the ninety-day commercial review, a channel-conflict complaint from an
> agency customer, CLEAN substituting for qualified-target preparation in the mode mix, or the first qualified paid request in a
> deferred area.

### 4.9 `registry/decisions.json` (authority package only; not vendored here) — record appended at re-issue

```json
{
  "id": "D58",
  "owner": "16",
  "decision": "Agency-first positioning with zero-build commercial messaging and inbound in-house admission",
  "alternative": "Build the owner's 2026-09-25 strategy before launch or make CLEAN the headline offer",
  "reason": "The sellable parts already exist in the design and need only presentation; inbound in-house admission widens who can buy without code or outreach; the expansions would add an estimated 6 to 12 or more months, legal exposure and hires with no evidence of higher contribution.",
  "reviewTrigger": "Paid conversion by buyer type, the ninety-day commercial review, an agency channel-conflict complaint, CLEAN substituting for qualified-target preparation, or the first qualified paid request in a deferred area.",
  "classification": "DESIGN_DECISION_WITH_BOUNDED_EVIDENCE",
  "status": "ADOPT_ON_EXPLICIT_R2_TRANSITION"
}
```

The record uses the existing classification and status vocabulary. The re-issue is the explicit transition, and the owner decision
date is carried by this amendment.

### 4.10 `29_STATE_AND_TRANSITION.md` — new section after §State update record

> ## Adopted amendments
>
> A3 — commercial positioning. Owner decision 2026-09-25. Text only: no change to the 22 packages, 441 cases, 64 commands, 73
> contracts, the policy registry or the platform's vendored registry; the decision registry gains D58. The edition version is the
> one set by the re-issue. Active mandates, the original clock, repository subjects, accepted gates and evidence, unresolved
> findings, cost reservations and owner actions are unchanged. It applies prospectively
> to public, application, report, terms and outreach copy produced by B11, B12, B13, B19 and B20 and to materialized manual 18
> drafts. Retired assumptions: agencies are the only admitted buyer type; "audit" is the customer-facing name of the free
> pre-purchase check. Next review trigger: D58. The same section carries the A2 entry, taken from its own amendment record.

### 4.11 `31_EDITION_VALIDATION.md` §Delivered structure

Current: "... sixty source records and fifty-seven recorded design decisions." New: "... sixty source records and fifty-eight
recorded design decisions." The re-issue also sets the edition identifier and regenerates the manifest and compiled volumes (1.4).

## 5. Rejected, with reasons

| Proposal | Reason |
|---|---|
| Enrichment by scraping (filling empty fields from the internet, "cross-validation") | Breaks CH-001: every emitted value has traceable authority, and nothing is invented. Migration has no ambient network client and never fetches URLs in customer values (04 §Architecture and dependency boundary). Enrichment is excluded from the price (16 §What the price includes) and never enabled by default (05 §HubSpot profile, Fields and values). It is the highest legal risk in the strategy: Colombian data law (Ley 1581 de 2012) requires the data subject's authorization, and website terms such as LinkedIn's forbid scraping. It could also engage GDPR and US state data-broker laws, and Kauro would become a data source rather than a processor. Offline validation of email, phone, date and URL syntax already exists. |
| "Security vulnerabilities" in the report | Kauro sees only exported files and has no capability to assess the security of customer systems, so the claim is false and creates liability. It is misleading advertising (FTC Act §5; Colombia Ley 256 de 1996). Any active probing of customer systems would risk computer-crime law (Ley 1273 de 2009; the US CFAA). Replacement term: "data risks", limited to findings the accepted report actually presents, such as cells a spreadsheet would execute as formulas, consent or do-not-contact conflicts, and invalid identifiers. |
| Migration of servers and files to AWS, Google Cloud or Snowflake ("AI-ready cloud migration") | This is infrastructure consulting, not a file product. It needs write credentials to customer infrastructure (05 §TargetContract: no persistent production write credentials; 20 §Direct CRM connectors), liability for downtime and data loss, insurance, and engineers the company cannot hire. It cannot be delivered at all without hires. The high-ticket step already exists: HubSpot and Salesforce preparation. |
| Data "structured vectorially" for customer LLMs | No defined deliverable and no customer demand. Embedding customer records would send raw data into a model path that the privacy classes exclude (06 §Privacy classes and minimization; 06 §Scoped memory: no vector database). It would also add a subprocessor and an international transfer. 20 §Scaling order: do not introduce vector databases to look scalable. |
| Clinics as a target sector (health data) | Patient data is sensitive data (Ley 1581 de 2012, arts. 5–6), with clinical-record confidentiality and, in the US, HIPAA. 19 §Data categories and excluded use and 18 §Prospect qualification already exclude it. One incident could end the company. A clinic's non-patient business data can be admitted under the normal rules, but clinics are not targeted. |
| Analysis of an "isolated sample" giving "exact percentages" | Self-contradictory: a sample cannot give exact percentages. Kauro profiles all admitted data (04 §Full-data profile and exact indexes), and every percentage names its population and denominator (02 §5). A customer may upload part of an export; the report is then exact for what was uploaded and says so. |
| Absolute promises: "100% optimal and production-ready", "permanent guarantee", "without losing money", "without regulatory errors", "pays for itself" | Nobody can guarantee these. CH-012 requires truth about scope. 12 §Outreach workspace forbids guaranteed savings and legal statuses not established. 11 §Public route map forbids unestablished certification claims, and S087 blocks unauthorized certifications. "Without regulatory errors" would promise legal compliance that Kauro cannot certify. The credible replacement: every change is explained and traceable, and a verified Kauro defect reported within 30 days has a five-business-day repair target. If it cannot be remedied, the agreed refund remedy applies (18 §Support coverage and service targets; `defectReportDays` 30, `defectRepairTargetBusinessDays` 5). That is a target with a remedy, never an absolute guarantee. |
| Promising savings amounts | Kauro cannot see the customer's contract or tier. A duplicate candidate is not a confirmed duplicate. Merging inside the live CRM is outside the product (05 §Operation taxonomy). A savings amount would be the guaranteed-savings claim that 12 §Outreach workspace and 26 §Months two and three forbid. The permitted money arguments are listed in rule 3.5. |

## 6. Deferred until after launch

The items below are new product scope. None is scheduled. Each can reopen only after B19, as a capability proposal
(20 §Capability proposal) with a bounded experiment, funding source, stop rule and acceptance output. If chosen, it becomes a
ChangeProposal (28): new requirements and cases, possibly new contracts or commands, pricing entries, a registry version bump,
re-vendoring of `@kauro/contracts` with new hashes, a construction-service catalogue re-import, and a post-launch package or a
B20/B21 "next measured bottleneck" mandate. The estimates are rough build-and-qualification ranges from the review. They are not
commitments.

| Item | Estimate | Condition to reopen |
|---|---|---|
| Direct sales experiment to mid-market companies (construction, distributors, large e-commerce), possibly in Colombia in Spanish | English experiment: no code, but copy, legal review and one of the two commercial cells. Colombian/Spanish version: about 3 to 6 or more weeks plus accountant review, covering UI, report and email localization (a D54 localization release) and a domestic tax and payment route (IVA, domestic e-invoicing, local methods; changes B09/B15). | After the first agency cells have run, and the D01 review shows either inbound in-house conversion comparable to agencies or the agency segment stalled under the 16/26 thresholds. Before any start, the experiment must also include: a consumer-data category review for e-commerce (consumer personal data, possible payment-card fragments that 19 excludes, consumer-contact rules such as Ley 2300 de 2023); Colombian withholding at source (renta, IVA, ICA), which reduces cash received per sale; Kauro as the direct processor for Colombian controllers (a DPA or transmission contract); and a new channel-conflict decision (16). |
| ERP and generic tables (products, invoices, inventory, suppliers) | About 3 to 6 weeks: a new object family across Migration, Intelligence, the capability record and reports, with about 20 to 30 new acceptance cases. | D02's trigger, "first unsupported paid request": a qualified paid request for non-CRM tables recorded through the unsupported-scope draft (18). The admitted data categories and prohibited-data checks must first be extended, because ERP tables can hold payroll, bank or health data. |
| Warehouse-ready export (clean files plus a schema for BigQuery or Snowflake, loaded by the customer, with no credentials) | About 2 to 4 weeks, including qualification against a real warehouse sandbox (small cost). It would be a new file-based target profile. | The first qualified paid request for a warehouse-load profile (D02 trigger). The customer always performs the load in its own account. |
| Paid periodic re-diagnosis (file-based: the customer uploads a fresh export monthly or quarterly for a flat fee) | About 3 to 5 weeks plus cases: a revision-comparison report, reminders, subscription product and billing (B09/B10/B15) and recurring e-invoicing. Live monitoring inside customer systems would take 2 to 3 or more months with security qualification and is not recommended. | 20 §Recurring service and subscriptions: cohorts show repeated demand, visible as a periodic project cadence in the 90/180/365-day repeat reporting (16 §Agency lifecycle). The service must add a comparison with the previous delivery and included cleaning, or it competes with the free check. It must define entitlements, expiry, refunds, tax and capacity, and treat a prepaid balance as a liability. Longer data keeping conflicts with Kauro's short-retention design (7 to 14 days) and would need new privacy terms. "Permanent guarantee" stays rejected. |
| License-waste estimate calculator, for per-contact-priced tools only | About 2 to 4 days after B19: an optional input field (B11), a report section (B13) and 3 to 5 new cases. | Prospects respond to the money argument, with price or value objections in the 16 §Decision rules analysis citing unclear savings, or explicit requests. The output is an "estimated maximum": the customer's own per-contact price times the duplicate candidates, clearly labelled as an estimate. It never promises a saving and is never offered for per-seat tools (Salesforce seats, ERP licences). Until then, rule 3.5(2) is the permitted cost argument. |

## 7. Effect on prices, commissions and the date; review

7.1 **Prices and commissions: no change.**
   - The price schedule (`R2-INITIAL`), repeat tiers, the 25% founding discount for three slots, non-stacking and quote rules stay
     as they are. Opening founding slots to in-house teams is an eligibility clarification: the discount liability stays at most
     three slots.
   - Seller compensation stays as defined in D32 (10% first, 4% recurring for twelve months) and D33 (the 90-day accepted claim).
     Non-agency companies may not be prospected, so no seller attribution claim can arise from prospecting an in-house team. An
     inbound in-house buyer produces seller compensation only as any inbound opportunity does: through an explicit compensation
     assignment made before the seller performs the agreed closing work (17 §Attribution subject). Otherwise it produces no
     commission.
   - **CLEAN cannibalization risk.** At the same band CLEAN costs 40–54% less than HubSpot or Salesforce preparation (USD 695
     against USD 1,295 or 1,495 in the first band). Presenting it as the headline offer could pull buyers with a qualified
     destination down to CLEAN. It would also delay 16's evidence milestone of two HubSpot, two Salesforce and one repeat project.
   - Mitigation: CLEAN stands beside the qualified modes and is never the headline (rule 3.3). The first commercial cells stay
     HubSpot-oriented and Salesforce-oriented, with at most two cells at once. A CLEAN or other-CRM cell opens only when one of
     those closes (16 §Decision rules for experiments, as amended).
   - The monthly review reports the mode mix against the destination stated on the fit form.

7.2 **The date: no change.**
   - No package, case, command or contract changes, and construction continues as it is. The copy is written when B11, B13 and B19
     are built anyway.
   - The credible limited-availability date given to the owner stands: not before 2026-12-16, most likely late January to
     mid-March 2027. It is still driven mainly by the owner's legal, tax, payment and cloud identity chain, not by code.
   - Building the whole strategy before launch would move production to the second half of 2027 or early 2028. That is alternative
     (B), which was rejected.

7.3 **Review trigger and date.** No calendar review falls before activation. The first scheduled review is the ninety-day
   commercial review after B19 activation (16 §Commercial admission and maturity). A3 and D58 are reviewed earlier when any of
   these occurs:
   - paid conversion by buyer type becomes measurable enough for D01's trigger;
   - an agency customer complains of channel conflict. This triggers an immediate review of rule 3.7, which can stop new in-house
     admissions prospectively;
   - CLEAN is bought in place of HubSpot or Salesforce preparation by buyers whose stated destination is qualified;
   - a qualified paid request arrives in a deferred area of section 6;
   - the re-issue finds R2 wording that A3 did not cover. In that case the re-issue records a versioned correction instead of
     adapting silently.
