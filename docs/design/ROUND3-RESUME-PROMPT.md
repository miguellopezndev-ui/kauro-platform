# Prompt to resume Order 11, round 3 (for any AI agent)

Copy everything below the line into a new session that runs on the owner's Windows PC, with the repository at
`C:\Users\migue\Projects\Kauro`.

---

You are continuing the design work of Order 11, round 3, for Kauro. Kauro is a data-migration service for agencies and companies
moving to HubSpot or Salesforce. A previous session stopped on 2026-10-22. Your job is to continue exactly where it stopped, at the
same depth, without redoing anything, until the end condition of the master plan is met. Then implement the designs in the product
and deliver.

## 1. Read first, in this order, fully, before any action

1. `C:\Users\migue\Projects\Kauro\docs\design\ROUND3-HANDOFF.md`: where it stopped, what exists, what is left, the ordered resume
   steps, and the defects to fix first.
2. `docs\design\ORDER11-ROUND3-MASTER-PLAN.md`: the method. **Version 8 governs**, especially §8.4, §8.5 ("no repeated work"),
   §9.4 (adaptive judging) and §11 (the pre-critic checklist). Read it from the first line to the last.
3. `docs\design\ORDER11-ROUND3-DELIVERABLES-PLAN.md`: the documents track.
4. `docs\design\ROUND3-PROGRESS.md` (the ledger) and `docs\design\ROUND3-REPORT.md` (what was chosen, page by page).
5. `docs\design\ROUND3-KIT.md`, `ROUND3-VOICE-AND-TERMS.md`, `ROUND3-CANONICAL-WORLD.md`, `ROUND3-DECISIONS-REGISTER.md` and
   `ROUND3-PRODUCT-DECISIONS.md`.
6. `C:\Users\migue\README.md` and `C:\Users\migue\Projects\WORKSPACE_POLICY.md`: the workspace rules.

Design records live in `C:\Users\migue\Projects\Kauro.archive\Deliveries\Visual\order11\research\` (each page folder has BRIEF,
CONTENT, COMPOSITIONS, AUDITIONS and final). The tools live in `...\order11\tools\round3\` (bracket.mjs, gates.mjs, anatomy.mjs,
colour-share.mjs). After any loss of context, re-read items 1–4 before doing anything else.

## 2. Hard limits from the owner (never crossed)

- **Code you must not touch:**
  - Migration Core and Intelligence Core;
  - money, ledger, reconciliation, quotes, tax and backend authorisation logic;
  - versioned legal text, unless through its procedure.
- **Nothing outside the PC:**
  - do not open AWS or run external services;
  - do not deploy;
  - do not ask for secrets, cards or credentials;
  - never show a secret or credential value on any screen.
- **Never add `__review` routes** to the product bundle or to production access.
- **Never install, download or update software or packages.** Every agent you start must be told this in its prompt. Use node, the
  installed Microsoft Edge (`channel: "msedge"`) and the repo's existing Playwright.
- **The owner's accounts and the system:**
  - third-party sign-ins are the owner's and read-only;
  - never sign in;
  - never edit the registry or system settings.
- **The words on every screen:**
  - no gendered pronouns, names only;
  - every date has its year, and every time its zone (Bogotá);
  - dark only on the web;
  - nothing follows the scroll (no sticky parts, no toasts);
  - no repetition of a fact on a page;
  - never invent a figure, rule, deadline, reason list or command: say "Unknown" or record a gap.
- **Workspace:**
  - follow `README.md`;
  - worktrees go only in `Kauro.archive\Worktrees\` or the temp folder;
  - never recreate the old `C:\Users\migue\Kauro*` folders;
  - everything new is written in English.
- **Pushing:** push and merge only when the master plan's end condition is met, or when the owner tells you to. Merge only after the
  full suite and CI (both the Ubuntu and Windows legs) are green. Never enable auto-merge.
- **Quota:** keep a margin for the owner's other orders. Default to at most 6 agents at a time, unless the owner says the quota is
  ample.

## 3. What to do, in order (details in the handoff, §4)

1. **Fix the link defects first.**
   - HD-1: in the seller's session, Commissions opens the owner's session. A seller must never reach an owner page.
   - HD-2: ask the owner which other links failed.
   - Then audit every link in every role's shell.
2. **Finish what was cut off:**
   1. the Refunds critique fix pass;
   2. the Claims accept reason as one required free-text field;
   3. the Customers critique fixes;
   4. the Sellers final;
   5. the Support cases and Owner actions finals;
   6. the PDF report fix pass.
3. **Judge kit group B** (24 batches are ready in `research\round3-kit\judging-B\`) and freeze the kit at v1 (CR-1 to CR-4).
4. **Once, before any new page** (master plan §8.5):
   - build the shared page generator in `tools\round3\page-kit\`;
   - move the existing research into `research\round3-library\` as pattern cards.
5. **The nine paused owner pages,** from `research\round3-owner\L3-TASK.md`. Continue any partial work in their folders. Then the
   whole owner console review (L3 → L2).
6. **The other sites:**
   1. the agency workspace;
   2. the seller portal;
   3. the public site, with the owner's pending items listed in the handoff;
   4. all four sites together.
7. **The remaining deliverables** (deliverables plan).
8. **Implementation in `apps/web`:** one coordinated change per component (D-34), from the product-ready finals.
9. **Delivery:**
   - the full test suite;
   - one push;
   - CI green on both legs;
   - merge;
   - a short honest report to the owner: what reached the bar, what changed and why, what needs the owner.

## 4. How to work (master plan version 8, the same depth with nothing repeated)

- **Start from what exists.** Never re-research, re-judge or rebuild anything already decided or built. A decision is re-opened
  only on new evidence or at the owner's request, and the reason is written down.
- **Each page:**
  1. The brief, which begins with a truth audit of the incumbent against the canon, the contracts and the recorded rules. Every
     defect becomes a given for all candidates.
  2. The corrected incumbent plus at least 3 alternatives that differ in idea.
  3. The gates at 8 widths.
  4. Blind judging: a full round robin, the calibrated judge prompt, and adaptive judges (two first; a third when the result is not
     clear by 8 points). An alternative wins only with at least 2 of 3 judges in both orders and a lead of at least 5 points;
     otherwise the incumbent stays.
  5. L4 sections on Tier A pages.
  6. The final.
  7. The L5 checks plus the pre-critic checklist.
  8. An outside critic (each Tier A and Tier B page).
  9. One fix pass.
  10. Your own review in the browser.
- **Keep one builder per page** from L3 to its fix pass. Use fresh agents only for judges and critics.
- **Record every step** in the page's AUDITIONS.md, plus one line in `ROUND3-PROGRESS.md`. Commit locally after each step; tests
  stay green.
- **The owner reviews live** on `127.0.0.1:4400`. Start it with `node tools/review/serve.mjs` from the repository. Before
  restarting it, stop only the processes that match `Projects\Kauro\(tools|apps)`, never `Kauro.archive` ones.
- **When the owner asks something, answer it plainly and keep working.** Do not stop the work unless the owner says so.

## 5. Open owner questions (do not guess; design what the contract allows and say so on the page)

They are listed in `ROUND3-REPORT.md` §4: OQ-C1, OQ-C2, OQ-R1 to OQ-R4, G-P8, and the Customers, Support and Owner actions
questions. Ask the owner when a step depends on one.

Begin by reading the handoff.
