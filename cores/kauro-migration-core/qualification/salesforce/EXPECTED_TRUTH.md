# Salesforce qualification: expected truth

Written before the operations were run, and before any result was observed. What
follows is what the vendor is expected to do, stated in advance so that agreement
means something. An expectation copied from a run is not an expectation.

Every record below is synthetic. Nothing here is customer data.

## The org and the fields

Developer Edition org `00Dak000018tvSeEAI`. Three fields created for this, by
API, on objects the V1 envelope covers:

| field | on | attributes |
| --- | --- | --- |
| `Kauro_Qualification_Key__c` | Account, Contact, Lead, Opportunity | External ID, Unique, not case-sensitive, Text(80) |
| `Kauro_Nonunique_Ext__c` | Account | External ID, **not** Unique, Text(80) |
| `Kauro_Qualification_Status__c` | Account | restricted picklist: `READY`, `BLOCKED` |

## Cases and what each must do

### A1 — Account insert
One account, `Name` only. Expect: **1 success, 0 errors**; success file carries a
new 18-character Id and `Item Created`.

### A2 — Account upsert on a unique External ID, first time
One account carrying `Kauro_Qualification_Key__c = KAURO-Q-ACC-1`, which no record
holds. Expect: **1 success, 0 errors**, status `Item Created`.

### A3 — Account upsert on the same External ID, second time
The same key, a different `Name`. Expect: **1 success, 0 errors**, status
`Item Updated`, and the **same Id as A2** — that is what matching on an external
id means. A second Id here would be a duplicate the migration created.

### A4 — Account update by Record ID
The Id from A2, a new `Name`. Expect: **1 success, 0 errors**, status
`Item Updated`, same Id.

### A5 — Restricted picklist, a value the org defines
`Kauro_Qualification_Status__c = READY`. Expect: **1 success, 0 errors**.

### A6 — Restricted picklist, a value the org does not define
`Kauro_Qualification_Status__c = NOT_A_REAL_STATUS`. Expect: **0 successes,
1 error**, and the error text names the restricted picklist. This is the case
that proves the org rejects rather than silently accepts, which is why a
restricted picklist may be trusted and an advisory one may not.

### A7 — Upsert on an External ID that is not unique
Two accounts sharing `Kauro_Nonunique_Ext__c = KAURO-DUP`, loaded first. Then an
upsert keyed on that field with the same value. Expect: **an error**, because the
key matches more than one record. This is the case the engine refuses before
writing anything, and it is refused here for the same reason: Salesforce cannot
say which record was meant.

### C1 — Contact insert with a relationship header
A contact carrying `Account.Kauro_Qualification_Key__c = KAURO-Q-ACC-1`, resolving
the parent by external id rather than by Id. Expect: **1 success, 0 errors**, and
the contact's `AccountId` equals the Id from A2.

### L1 — Lead insert
A lead with `LastName` and `Company`, the two fields Salesforce requires. Expect:
**1 success, 0 errors**.

### L2 — Lead insert missing Company
`LastName` only. Expect: **0 successes, 1 error** naming the required field. Lead
is not Contact, and this is the difference stated as a testable claim.

### O1 — Opportunity insert
`Name`, `CloseDate`, `StageName`, the three non-nillable fields. Expect:
**1 success, 0 errors**.

### R1 — Export-back
Query every record this qualification created, by its qualification key, and
compare `Id`, `Name` and the key against what the success files said. Expect:
**every row agrees**, and the count matches.

## What is not claimed

`OpportunityContactRole` is qualified separately and is not part of the above.

Data Loader's own authentication on this machine is recorded in
`qualification/evidence/SF_DATALOADER_AUTH.md`. It is not the client-credentials
token, and the difference is stated there rather than glossed.
