# Legal correction requests

The public legal documents are versioned: their version label names the effective date and a digest of the exact text, and an order
keeps the version its customer accepted (`apps/web/src/legal/templates.ts`, "Changes and versions"). A legal text is therefore never
edited unilaterally from a design or copy order.

This file records the discrepancies found elsewhere, so that the next versioned re-issue, after review by counsel (B19, R2-111),
resolves them. Each entry says what was found, where, what it would change, and its state. Nothing here changes an obligation.

| # | Found | Document and place | Discrepancy | Proposed correction (for counsel) | State |
| --- | --- | --- | --- | --- | --- |
| LC-1 | Order 10 final audit, 2026-10-20 | Data processing terms, "Data and people concerned" (`apps/web/src/legal/templates.ts`, the paragraph that begins "The service takes ordinary business CRM data") | It lists "contact, company, deal and activity records" as the data the service takes. The public scope says activities are not included (`services.scope.excluded`: "Lead conversion, custom objects, activities, attachments, engagement history, campaign memberships, owner setup and automations are not included."). | Decide which is true at launch. If activities stay out of scope, remove "and activity" from the list. If the processing description deliberately covers activity fields that may arrive inside an export (for example an activity date column on a contact), say so explicitly instead of listing activity records as a data family. | Open: for the next versioned re-issue. No legal text was changed. |
| LC-2 | Order 16 (functional governance), 2026-10-22 | Service terms, "The customer's authority" ("An in-house team makes it for its own company's data.") and Data processing terms, "Parties and roles" ("An in-house team's company is the controller of its own CRM data and Kauro is its processor.") (`apps/web/src/legal/templates.ts`) | D-33 (2026-10-13) admits any company working on its own data, with or without an in-house team; the draft Terms §1.2 and DPA §1 were reworded for it (CHECKLIST §10), the published templates were not. | "A company working on its own data makes it for that data." and "A company working on its own data is the controller of that data and Kauro is its processor." | Open: for the next versioned re-issue. No legal text was changed. |

## Related release blockers (not corrections)

- The operator's facts (`apps/web/src/legal/operator-facts.json`) are all empty, so the three documents answer "Not published" (503).
  They need the operating company's real details before any document can be published or any account activated under it.
- British and American spellings are mixed inside the legal texts ("authorized", "Minimized"); harmless, but worth aligning at the
  same re-issue.
