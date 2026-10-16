# Salesforce qualification

What this directory is for, and what has to be true before `SF-TARGET-01` can be
called PASS.

Everything here runs against a **Salesforce Developer Edition org created for
testing**, with **synthetic data only**. No customer data goes into a
qualification run, ever.

## The boundary

Kauro never holds a Salesforce credential. The agency authenticates their own
machine with the official Salesforce CLI, runs the collector in this directory,
and hands over a bundle of describe output. Kauro reads that bundle as hostile
input: it validates the shape, refuses anything that looks like a secret, and
builds an immutable target contract from it.

This is why there is no Kauro desktop collector and no OAuth flow. A tool that
holds a token is a tool that can lose one.

## Collecting the target schema

```
node collect-target-schema.mjs --org <alias-or-username> --out salesforce-target-bundle
```

Add `--with-ocr` only when `SF-OCR-01` is being qualified; `OpportunityContactRole`
is a separate capability and is not part of the base Salesforce envelope.

The collector writes:

```
salesforce-target-bundle/
  org-summary.json          orgId, instanceUrl, username, alias, apiVersion
  describe/Account.json     sf sobject describe, unwrapped and key-sorted
  describe/Contact.json
  describe/Lead.json
  describe/Opportunity.json
  describe/OpportunityContactRole.json   (only with --with-ocr)
  target-attestation.json   collector version, CLI version, file hashes
```

It refuses — rather than redacts — if any byte it is about to write matches an
access token, a refresh token, an SFDX auth URL, a `force://` URL, a client
secret, a password, a session id or a PEM private key block. A bundle that ever
held a credential is rebuilt, not repaired.

Current Salesforce CLI versions already strip credentials from command output:
tokens, passwords and SFDX auth URLs were removed from `org display`, `org list`
and the login commands in **v2.136.8, released 27 May 2026**. The collector's
scan exists for older CLIs, hand-edited files, and `SF_TEMP_SHOW_SECRETS=true`.

## What the describe establishes, and what it does not

The reader takes these attributes from `fields[]` and models each one separately:

| Attribute | What it decides |
| --- | --- |
| `externalId` | The field is marked as an External ID. |
| `unique` | Two records cannot share a value. **Not implied by `externalId`.** |
| `idLookup` | The field can name a record in an `upsert`. This is what upsert actually consults. |
| `createable` / `updateable` | Whether a value may be written at all. |
| `nillable` | Absence of it is what makes a field required. |
| `calculated` / `autoNumber` | Read-only; never appears in a write payload. |
| `restrictedPicklist` | An unlisted value is rejected rather than silently accepted. |
| `picklistValues[]` | `value`, `label`, `active`, `defaultValue`. |
| `referenceTo` / `relationshipName` | The lookup and the name a relationship header uses. |

`recordTypeInfos[]` carries exactly `available`, `defaultRecordTypeMapping`,
`developerName`, `master`, `name`, `recordTypeId`. **`developerName` is the
stable key.** `recordTypeId` differs between orgs and `name` is a translatable
label, so neither may be used to address a record type.

Two limits are recorded rather than worked around:

- A describe returns only what the authenticated user can see. A describe run by
  a low-permission user silently omits fields, so an absent field means *not
  established*, never *does not exist*.
- `Lead.Status`, `LeadSource`, `Rating` and `Industry` are **advisory**
  picklists, not restricted ones. Salesforce does not reject an unknown value on
  load; it records an inactive picklist entry. A wrong value therefore fails
  quietly, which is exactly why these values are checked against the contract
  instead of being trusted.

## What SF-TARGET-01 has to demonstrate

Against a real Developer Edition org, with synthetic data:

- the collector produces a bundle the reader accepts;
- Account, Contact, Lead and Opportunity each load;
- Insert, Update and Upsert each behave as declared;
- matching by Record ID works;
- matching by an **existing** External ID works, and an External ID that is not
  also unique is refused before anything is written;
- a restricted picklist rejects an unlisted value, and the package predicted it;
- the qualified standard relationships resolve through relationship headers;
- Data Loader's success and error files reconcile against the package;
- an export-back from the org matches what the package said would be delivered.

No delete is tested: delete is outside the V1 commercial contract.

## Before running Data Loader

Re-check the current supported release rather than trusting a number written
here. At the time this was drafted the researched baseline was Data Loader with
API 67 and JRE 17+, but a version pinned in a document is a version that goes
stale; the qualification uses whatever release is current and records it.

## What is not here yet

The synthetic corpus, the hand-authored expected truth for each case, and the
evidence validators. Expected truth is written **before** the engine runs against
it — an expectation snapshotted from the current engine tests nothing.
