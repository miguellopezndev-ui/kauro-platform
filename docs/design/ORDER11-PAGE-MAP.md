# Order 11: the page map: who comes to each page, why, and where they go next

**Status:** working document for the owner's review (2026-10-20). It guides every design of Order 11. The public pages are approved in Order
10 and are not redesigned here. They are listed so that the private pages can continue the path they start.

**Sources:**
- the screen registry (`packages/contracts/registry/screens.json`);
- A3 (offer and admission), D-30 and D-33 (who may buy);
- the owner's decisions of 2026-10-20 on identity (below);
- the competitive research in `C:\Users\migue\Kauro-visual-delivery\order11\research\`.

## 0. What Kauro is

**Today.** Kauro takes a team's files of customer records (contacts, companies or accounts, deals or opportunities, as CSV or XLSX) and gives
back files that are ready to import:
- into HubSpot through its importer;
- into Salesforce through Data Loader;
- or, as CLEAN, standard cleaned files for another CRM or for spreadsheets.

Before anything is prepared, Kauro shows what it found and what it proposes. A person on the team approves exactly that. Kauro then
prepares, verifies and delivers a package: the files, a report of what happened to every source row, a manifest, and the importer's steps
in order. The team imports with its own tools. Kauro never connects to a CRM and never writes into one.

**Who buys.** Two kinds of buyer, on the same terms (D-33):
- agencies (RevOps and CRM consultancies, HubSpot and Salesforce partners) preparing data for their clients;
- companies preparing their own data.

No consumers (D-30).

**Who it is meant to become.** The careful hand an agency builds its data practice on. The research shows the same ladder at every partner:
- a free check;
- a cleanup or migration project;
- recurring care.

Kauro is the only one in that market that works from files, explains every change and needs a person's approval before preparing anything.
Its personality:
- **exact:** the numbers are the project's own;
- **calm:** one next step at a time;
- **candid:** a limit is said before it hurts;
- **on the customer's side:** a paid option stays off unless chosen.

**The path, held by the hand:**
1. The public site makes the promise.
2. The free data health check shows the customer their own data.
3. The quote turns a decision into a price.
4. The delivery keeps the promise.
5. The next project comes with the same team, the same habits and the repeat discount.

Every private page knows where it is on this path and what comes next.

## 1. The owner's decisions on identity (2026-10-20)

- **Two ways to sign in for V1:** Google, and email with a strong password. No other provider before launch.
- **Kauro's own second factor:** TOTP from an authenticator app is always required, also after Google. An email never replaces it.
- **Before private data:** the email must be verified and two-step verification enrolled.
- **The identity screens to design:**
  - enrolment;
  - verification;
  - safe recovery;
  - errors;
  - protection against repeated attempts;
  - ending other sessions.
- **Sign-up** is public and self-serve for agencies and direct-buyer companies, without manual approval. A verified email, two-step
  verification and the business setup come before the private workspace opens.
- **Never through sign-up:** seller, Kauro staff, owner and administrator access. Those come only by invitation and specific authorisation.
  The operations sign-in therefore has no "Create account" link.

## 2. The repeated pages, side by side

Some pages exist in more than one application. Each copy is shaped by who arrives, not by the template.

| Page | Agency or company (APP) | Kauro owner (OPS) | Seller (OPS) |
| --- | --- | --- | --- |
| **Sign in** | Google or email and password, then the Kauro code; links to create an account and to reset the password | The same form, without "Create account"; a line saying access is by invitation | As the owner |
| **Create account** | Proposed P-05: open to agencies and companies | None | None: a seller is invited |
| **Home** | The projects board (UI11): what needs the team, what Kauro is doing, what is ready to import | Private home (UI33), owner view: the queues only the owner can clear, money facts, the health of the work | Private home (UI33), seller view: assignments, statements, resources; no global cash, no customer CRM data |
| **Settings** | Personal (P-01), plus organisation (UI32 / P-02) for owners and admins | Personal (P-04 owner view): security, sessions, the owner's notification routes | Personal (P-03 seller view): security, payout identity, sending identity |
| **Support** | Support cases (UI52): the team's questions about its own projects | Support operations (UI55): every assigned case, with scoped evidence | Support operations (UI55) narrowed: no raw CRM artifacts |
| **Team** | Team (UI31): roles inside one agency | Staff and sellers live under the seller lifecycle (UI37), not a team page | None |

## 3. The path, page by page

The table below gives, for each page:
- who comes;
- from where;
- why;
- what they do there;
- where they go next.

"Must not" lists what the page must never show or offer.

### 3.1 Public (Order 10, approved; not redesigned)

| Page | Who comes and why | Next |
| --- | --- | --- |
| Home (UI01) | A buyer who heard of Kauro, deciding whether it is for them | Contact (the free check) or Sign in |
| How it works (UI02) | A buyer checking who does what at each stage | Contact; Supported services |
| Supported services (UI03) | A buyer checking whether their destination is open now | Contact; Pricing |
| Pricing (UI04) | A buyer estimating cost | Contact |
| Sample delivery (UI05) | A buyer who wants to see what they will receive | Contact |
| Data handling (UI06) | A buyer's security or privacy reviewer | Contact |
| Contact (UI07) | A buyer ready for the free data health check, or with a question | Their reply by email; later, Create account |
| Status (UI08), Help (UI48), legal (UI45–47), preferences (UI49) | Anyone who needs a fact | Back where they came from |

**Change requested by the owner on Order 10's approved work:** on Supported services, the "Availability now" section becomes three upright
cards side by side. Each card reads in the same order:
1. name and state;
2. the piece of the product;
3. who it is for;
4. what you receive;
5. the limit and version.

### 3.2 Access and identity (group A, plus the proposals)

| Page | Who comes | Why | What they do | Next | Must not |
| --- | --- | --- | --- | --- | --- |
| **Sign in (UI50)** | A team member or a Kauro person returning; someone sent here by an expired session | To reach their work | Continue with Google, or enter email and password; then the six-digit code from their authenticator app | The page they were going to (an allow-listed route), else their home | Say whether an account exists; show "Create account" on the operations sign-in; accept an email in place of the code |
| **Create account (P-05, proposed)** | A buyer after reading the site, often after the free check | To start their first project | Continue with Google, or full name, work email and password. Then verify the email with a code, then set up two-step verification and keep the recovery codes | Agency setup (UI09) | Ask for company details before the account exists; grant any seller or staff access; promise a price |
| **Reset password (P-06, proposed)** | A member who forgot their password | To get back in | Enter email; receive a code; set a new password; every other session ends | Sign in, then the Kauro code | Say whether the email has an account; skip the second factor |
| **Accept invitation (UI51)** | A person invited by an owner or admin | To join that agency in the intended role | Sign in or create the account with the invited email; then accept | That agency's projects | Show the agency before the token and identity are checked; let a forwarded invitation in |
| **Agency setup (UI09)** | A new account holder | To prepare a workspace that may hold client data | Say who buys (agency or company), name the workspace, the legal and billing profile, accept the terms | The projects board, with the first project offered | Join an agency by email domain; ask anything twice |
| **Switcher (UI10)** | A person with more than one membership | To choose the workspace to work in | Pick one; create another eligible workspace | That workspace's projects | Show a workspace the person does not belong to; keep the old one's content on screen while switching |

### 3.3 The project (group B)

The project is the path's core. Its six stages are the same as on How it works:
1. upload and seal;
2. the free data health check;
3. review and approve the plan;
4. quote and payment;
5. preparation and verification;
6. delivery and import.

| Page | Who comes | Why | What they do | Next | Must not |
| --- | --- | --- | --- | --- | --- |
| **Projects (UI11)** | Any member, every day | To see what needs them | Open the project that needs them; create a project; filter by client or stage | A project's overview | Look empty on first visit (show a synthetic example, labelled); hide support, refund or deletion routes from a restricted agency |
| **Clients (UI12)** | Agency owners and admins (a company has none) | To keep each end client apart | Add a client; open its projects; archive one after seeing the impact | That client's projects | Merge two clients because their names look alike; call archiving "delete" |
| **Overview (UI13)** | Any member opening a project | To know where the project is and what comes next | Continue the one valid step; look at the activity | The stage that needs them | Offer an action another tab has made stale |
| **Source intake (UI14, real)** | An operator with the client's files | To give Kauro the files | Upload; resume; cancel; replace before sealing | Selection | Call a file "checked" when the scanner skipped it |
| **Selection (UI15, real)** | The same operator | To choose exactly what is included | Choose sheets and tables; settle parser choices; confirm | Seal review | Leave out content without a visible reason |
| **Seal review (UI16, real)** | The operator, sometimes an approver | To fix this exact set of files | Seal the revision, or go back | Target setup, then the free check | Suggest that sealing has started a paid audit |
| **Target setup (UI17)** | The operator with the destination's facts | To tell Kauro the actual destination | Give the instance's metadata; settle unknown facts | The free check | Turn an unknown fact into a guess |
| **Audit (UI18, real)**, the free data health check | Every member; the moment the buyer sees their own data | To see what Kauro found and what it proposes | Open each finding; review the proposed decisions | The plan | Present a sample as the whole file; hide that a budget ran out |
| **Mapping (UI19)** | The operator | To choose where each field goes | Map, keep or leave out each field; validate | Identity | Allow free text that bypasses the typed choices; invent a field |
| **Identity (UI20)** | The operator, then the approver | To decide which records are the same | Approve a supported group; keep records apart; settle conflicts | Relationships | Merge on similarity alone; treat a sampled email as proof |
| **Relationships (UI21)** | The operator | To keep records connected | Approve a representable link; hold back or reject | Approval | Show a missing parent as linked |
| **Approval (UI22)** | The approver (or owner, admin) | To approve exactly these decisions | Confirm identity again (step-up); approve the exact disclosures | The quote | Hide an effect; approve with Enter on an undisclosed default |
| **Processing (UI25, real)** | Any member, waiting | To know Kauro is working and when it will finish | Watch the stages; cancel if allowed; open support | Delivery | Show a heartbeat as a percentage |
| **Delivery (UI26)** | The operator | To take the verified package | Download within the deadline; read the report; open the import guide | Import steps | Offer a link to an expired or revoked file |
| **Import steps (UI27)** | The operator at the CRM | To import in the right order with the right settings | Follow each stage; acknowledge the guide; upload the importer's result | Import results | Call a download an import |
| **Import results (UI28)** | The operator | To match what the CRM did with what was delivered | Upload the result file; inspect a mismatch | The next stage, or done | Take a row's position as a CRM identity |
| **Data lifecycle (UI29)** | Owners and admins; anyone asked by a client | To know what remains and when it is deleted | Request the one eligible extension; request deletion | Back to the project | Revive expired data; pass a hard limit |
| **Support cases (UI52, real)** | Any member with a question | To ask and follow an answer | Open or reply to a case | The case | Let a revoked member read old cases |

### 3.4 Money (group C)

| Page | Who comes | Why | What they do | Next | Must not |
| --- | --- | --- | --- | --- | --- |
| **Quote (UI23, real)** | The owner, admin or billing member, after approval | To see the exact price before paying | Read base, one discount, service, tax and total; accept the terms; create the payment order | Payment | Offer "Pay now" on expired data |
| **Payment (UI24, real)** | The same person | To pay and know it counted | Follow the order's state; refresh the same order; contact support | Processing | Encourage a second payment while the first is uncertain; trust a redirect as payment |
| **Billing (UI30, real)** | The billing member, the owner | To keep the company's papers | Download issued invoices; request a refund; settle the billing profile | — | Present a summary as an invoice |

### 3.5 Sellers (group D, OPS)

| Page | Who comes | Why | What they do | Next | Must not |
| --- | --- | --- | --- | --- | --- |
| **Prospects (UI34)** | A seller | To work only qualified, permitted agencies | Research; draft; record a permitted contact; submit a claim | Reviewed correspondence | Treat a list as qualified; send to a suppressed address |
| **Agency relationship (UI35)** | A seller, the owner | To see who serves an agency and who earned it | Review a claim; prepare a reassignment | — | Reset the first project or erase residual rights |
| **Commissions (UI36)** | A seller | To understand what was earned, held and paid | Read a statement; contest a line; provide documents | — | Present a submitted transfer as received |
| **Seller lifecycle (UI37)** | The owner (about a seller); the seller (about themself) | To follow the engagement | Prepare activation, training, amendment or termination | — | Treat a label as legal review |
| **Seller resources (UI53)** | A seller | To use only the current approved offer | Open current sheets; prepare a permitted draft | Reviewed correspondence | Reuse a superseded claim |
| **Reviewed correspondence (UI54)** | A seller, the owner | To see exactly what will be sent | Prepare, authorise or send through allowed actions | — | Call a draft sent, or acceptance delivery |

### 3.6 Owner and operations (group E, OPS)

| Page | Who comes | Why | What they do | Next | Must not |
| --- | --- | --- | --- | --- | --- |
| **Private home (UI33)** | The owner, a seller, a technical operator | To see their own permitted work | Open the queue that needs them | That queue | Show a seller global cash; show an unknown balance as zero |
| **Owner actions (UI38)** | Miguel | To do the personal acts only the owner can do, prepared in advance | Open the official flow; record the result | — | Ask the owner to code, use a terminal or guess a menu |
| **Company finance (UI39, real)** | The owner | To keep collections, cash and obligations apart | Reconcile; prepare a reviewed payment | — | Turn a forecast into spendable money |
| **Jobs (UI40)** | The technical operator, the owner | To inspect execution and recovery | Prepare an authorised cancel, reconcile or retry | — | Edit a status by hand |
| **Deletion (UI41)** | The operator | To prove what was removed | Run the exact authorised cleanup; inspect a failure | — | Call a database flag the provider's deletion |
| **Incidents (UI42)** | The owner, the operator | To contain and prove recovery | Prepare breakglass, recovery or a notice | — | Invent a resolution or a message not sent |
| **Releases (UI43)** | The owner | To promote only the accepted candidate | Review the promotion; restrict a capability | — | Borrow an old acceptance |
| **Operating review (UI44)** | The owner | To choose the next move from evidence | Prepare one funded experiment with a stop rule | — | Present scenario arithmetic as demand |
| **Support operations (UI55)** | Kauro staff | To resolve with scoped evidence | Reply; request breakglass when necessary | — | Give a seller raw CRM artifacts |

## 4. What this map changes in the designs

1. Every private page has the same skeleton:
   - an eyebrow (where it is);
   - an h1 (the registry's sentence or the page's name);
   - a lead (what it is for);
   - the one next step;
   - the facts.
2. The project's six stages are drawn once, as the window's progress list. Every project page shows it, so the operator always knows where
   they are.
3. The first visit is never empty. A new workspace sees one synthetic example project, labelled as an example, beside "Start your first
   project".
4. The free data health check is the moment of truth. It opens with the counts of the buyer's own data, then every finding with its one next
   step.
5. Sign-in and sign-up follow the owner's decisions above: two methods, Kauro's own code always, the recovery codes kept at enrolment, and
   "Create account" only on the customer application.

## 5. Proposals that need a registry addition

None of these replaces a registered screen. Each is drawn in the review as "PROPOSED — not in the registry" until the owner approves it.

| Key | Page | Why | Where it would live |
| --- | --- | --- | --- |
| P-05 | Create account | Sign-up is public and self-serve (owner, 2026-10-20) | `/signup` (APP) |
| P-06 | Reset password | Email and password need a safe recovery | `/login/reset` (APP and OPS) |
| P-01 (extended) | Personal settings: sign-in methods, two-step verification, recovery codes, sessions | Ending other sessions and safe recovery (owner, 2026-10-20) | `/account` |
