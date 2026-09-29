# Owner actions (manual 24) — observed state

One row per owner action of manual 24. Status: DONE (observed), SCHEDULED (the owner's date), BLOCKED_OWNER (work that
depends on it waits), LATER (its trigger has not come). Evidence never includes credentials or private numbers.

Owner decision of 2026-09-28: every personal procedure is done on **2026-10-08**; until then no personal act is requested and
dependent work is labelled BLOCKED_OWNER. A "ready to connect" sheet (what each account must hand over, where it is stored,
the command run next, the gate it unblocks) is delivered by 2026-10-07.

| Action | Status | Date | Evidence / note |
|---|---|---|---|
| OA01 Confirm the active checkpoint | DONE | 2026-09-13 | historical restart binding |
| OA02 Identity and domicile facts | SCHEDULED | 2026-10-08 | home address accepted by the owner for public records (2026-09-25) |
| OA03 Name and domain | **DONE** | 2026-09-25 | name Kauro; domain `kaurodata.com` bought by the owner at Cloudflare (registrar and DNS). Public DNS on 2026-09-29: NS `may.ns.cloudflare.com`, `stanley.ns.cloudflare.com`; no MX/TXT yet. DNS is managed as code with B14 (Terraform, Cloudflare provider) through a Cloudflare API token limited to Zone:DNS:Edit on this zone, stored only in the secret store; no existing record is changed or deleted without a prior report |
| OA04 Business registration and signatures | SCHEDULED | 2026-10-08 | company form chosen by the owner's own list |
| OA05 Tax and fiscal profile (RUT/DIAN) | SCHEDULED | 2026-10-08 | |
| OA06 Corporate identity and recovery (Google Workspace on `kaurodata.com`) | SCHEDULED | 2026-10-08 | needs DNS verification records (B14) |
| OA07 Cloud billing and bounded resources | SCHEDULED | 2026-10-08/09 | the payment card arrives about 2026-10-09 |
| OA08 Model terms and campaign funding (B04) | BLOCKED_OWNER | after OA07 | no paid inference before an approved bounded grant |
| OA09 Merchant KYC (PayPal Business) | SCHEDULED | 2026-10-08 | |
| OA10 Bank and withdrawal destination | BLOCKED_OWNER | after OA04/OA09 | |
| OA11 Fiscal issuance (e-invoicing habilitation, Alegra) | SCHEDULED | 2026-10-08 | |
| OA12 Customer instruments | LATER | after OA02/OA04 | terms, DPA and privacy are rendered from operator facts and refuse to publish while one is missing |
| OA13 Synthetic CRM sandboxes (HubSpot, Salesforce) | LATER | before B17 | free sandbox accounts; not on the 2026-10-08 list |
| OA14–OA24 | LATER | | triggers after integration |
