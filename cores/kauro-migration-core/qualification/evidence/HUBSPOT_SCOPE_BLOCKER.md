# HubSpot: what the credentials can and cannot do

Established by probing, read-only first, then by the smallest write that would
tell the truth. Recorded because a gate that is not closed should say exactly
why, in terms someone can act on — and because this one turned out to be a
different thing from what it first looked like.

## Two portals, and only one of them may be used from here on

| | portal 51872453 | portal 51050101 |
| --- | --- | --- |
| account type | `DEVELOPER_TEST` | `STANDARD` |
| records | synthetic, created by this qualification | **472 contacts, 92 companies** |
| `crm.schemas.*.write` | **no** | yes |
| used by the qualification | yes | **once, on 2026-09-02 — see below** |

The first credential authenticates against the developer test account, which is
the right tenant and carries no schema write scopes. The second carries the
scopes — and belongs to a live standard account with real records in it.

That resolves what the 403 always was. The app whose scope page shows the three
`crm.schemas.*.write` scopes selected is an app in the standard account. Granting
scopes there does not widen a token issued for a different portal.

## What was done to the standard account, and what was not undone

This file said of portal 51050101 that "no record was ever written to it" and
that "no qualification runs against it". Both sentences were false when they were
written, and the release record this file ships beside says so plainly: the gate
line in `migration-core-v1-provenance.json` establishes `HSP-TARGET-01` in part
by "11 expectations for a property Kauro creates against portal 51050101". Two
documents in one release cannot disagree about whether a qualification wrote into
an account holding somebody's real customer records, and between the two it is
this one that was wrong.

What was done is recorded in `qualification/evidence/hs-metadata.json` and
`qualification/evidence/hs-custom-property.json`, both written by commit
`6b87af9`, "qualification: a property Kauro creates, against a real portal", on
2026-09-02, and untouched since. The credential used was the one the account
owner supplied for this; `hs-custom-property.json` says so in its `authorisation`
field, and that is the only authority claimed for any of it.

**Six property definitions were created there, each answering 201.**
`kauro_qualification_key`, declared `hasUniqueValue: true`, and
`kauro_qualification_status`, an enumeration with a closed set of options, on
contacts, companies and deals. That is `hs-metadata.json`, `"mode": "CREATE"`,
six entries, every one `CREATED`.

**Two contact records were then written**, through
`crm/v3/objects/contacts/batch/upsert` with `idProperty`, because that credential
carries no `crm.import`. They are the two rows of the `Q5-custom-property`
corpus, both at `kauro-qualification.dev`, and their values were read out of the
package the engine produced rather than typed for the portal. Nothing was written
to companies or to deals — that runner touches contacts only, so four of the six
definitions were created and never used. Two further writes were attempted and
both were meant to be refused: a second contact carrying a key another record
already held, and a contact carrying a value outside the enumeration. The portal
refused both, which is exactly what `P8` and `P9` assert; had either been
accepted, the runner deletes it on the spot. Eleven expectations, no failures,
`"result": "PASS"`.

**The two records were removed.** `hs-custom-property.json` records
`recordsRemovedAfterwards: 2`, and the cleanup matches on exact
`@kauro-qualification.dev` addresses rather than on resemblance, because a live
account is no place for a delete that matches loosely.

**The six property definitions are a different matter**, and the sentence that
stood here — "all six were archived immediately" — is withdrawn rather than
repeated, because nothing in `qualification/evidence/` establishes it.
`create-qualification-metadata.mjs` does archive them under `--remove`, and it
writes `"mode": "REMOVE"` into its evidence when it does; the only metadata
evidence committed carries `"mode": "CREATE"`. They may well have been removed,
by hand or by a run whose evidence was never kept, but this repository cannot
show it, and whether a live account was left clean is not a thing to assert from
memory. Until a `REMOVE` run is committed, `kauro_qualification_key` and
`kauro_qualification_status` should be assumed still present on contacts,
companies and deals in 51050101.

Who could look, and when, has itself changed, and the honest form of that is two
dated facts rather than one flat sentence. On 2026-09-02 the account owner had
access to 51050101: they supplied the credential the runs used, which
`hs-custom-property.json` records in its `authorisation` field, and they
performed a Settings → Properties → Export inside that portal, which
`hs-property-export.json` records in its `capturedBy`. As of 2026-09-07 the
account owner reports that they can no longer get into it. Both are recorded
because a reader who has only the second would conclude that nothing was ever
written there by anyone entitled to, and that is not what happened.

One committed evidence file states the access position flatly and in the present
tense, and it should be read with its date rather than corrected. The
`portalAttribution` field of `hs-property-export.json` ends "the owner who
produced the export has access to that portal and not to the other". That was
written on 2026-09-02 as part of establishing which portal the export came from,
and it is doing real work there — the export carries no portal id, so who could
have produced it is part of the argument that attributes it. It is not evidence
about today. It is also using "access" for a person signing into a portal, while
everything this qualification does runs on an app credential; the two are
different things, and 51872453 is qualified against by a credential regardless of
who can sign into it. Evidence is not edited by hand here — a file is written by
the runner that produced it, at the moment it produced it — so the disagreement
is resolved by reading, not by rewriting.

An earlier version of this paragraph said the owner had never had access and that
this was "the whole reason this blocker exists". Both halves were wrong, and the
second more seriously than the first. The blocker's cause is set out under "Why
this cannot be worked around from here": an app credential cannot widen its own
scopes, and the scopes were granted to an app in a different portal. That is a
property of the credential, not of anybody's access, and rewriting it as an
access problem would have moved a solved diagnosis back into the unknown.

What follows for the six definitions is narrower than either version claimed.
They are unestablished, they can only be settled from inside 51050101, and nobody
is in a position to look there today. That is not a task assigned to anyone here
and it is not a permanent fact either; it is an open question with a known way to
close it. Nothing in this front depends on it closing.

No qualification has run against that portal since. The two halves that once
recorded it now record the developer test account: `hs-target-contract.json`
carries portal 51872453, captured 2026-09-04, and `hs-import.json` carries portal
51872453, `DEVELOPER_TEST`, captured 2026-09-07. So the rule the rest of this
file states still holds — a qualification that writes into an account with
somebody's real data in it is not a qualification, whatever it proves — but it is
a rule about what may be done next, and it was written here once as though it
described what had never been done. It did not.

## What the developer-test credential can do

| Operation | Result |
| --- | --- |
| `GET /account-info/v3/details` | 200 |
| `GET /crm/v3/properties/{object}` | 200 |
| `GET /crm/v3/pipelines/deals` | 200 |
| `GET /crm/v4/associations/contacts/companies/labels` | 200 |
| `GET /crm/v3/imports`, `POST /crm/v3/imports` | 200 |
| `POST /crm/v3/objects/{object}` | 201 |
| `POST /crm/v3/properties/{object}` | **403** |
| `POST /crm/v3/pipelines/deals` | **403** |
| `GET /crm/v3/owners` | 403 |

Record writes and the CRM Imports API are available. Schema writes are not.

## Why this cannot be worked around from here

- **The token cannot widen its own scopes.** Scopes are set on the app, by a
  signed-in user, in the portal that owns it. The credential authenticates an
  app, not a user, so it cannot act as the user who would change them.
- **There is no HubSpot CLI auth to fall back to.** No `hubspot.config.yml`, no
  `.hscli`, no `.hubspot`, and the CLI is not installed. Installing it does not
  help: it authenticates with a personal access key minted from a signed-in
  browser session, and none of the four authorised credentials is a user
  credential.
- **Creating a fresh developer test account has the same root.** `hs test-account
  create` needs CLI auth, which needs that key, which needs the user session.
- **The property export cannot be triggered headlessly either.** It is a Settings
  action that emails a file; `/properties/v2/export`,
  `/properties-settings/v1/export` and `/crm/v3/properties/contacts/export` are
  all 404.

## What this blocked, and what it did not

`HSP-TARGET-01` is **closed**, and closed without lowering anything. What the
missing scope cost is narrower than it first appeared, because the thing the
custom property was there to demonstrate is demonstrated on a property HubSpot
itself defines — and, once, on one Kauro created, in the account the section above
describes.

Qualified, against portal 51872453:

- the target contract over the portal's own property API capture, 42 contract
  checks, PASS
- match authority resolving on `email` — unique because **HubSpot** says so, not
  because Kauro created it that way — and refused on a property that is not
  unique, on one nobody stated, on an uncaptured property, on `EXTERNAL_ID`
  (which HubSpot does not have), and on the trace key by five spellings
- Contact, Company and Deal create, update and create-and-update through the CRM
  Imports API, 24 expectations, PASS
- pipeline and stage by internal identity, against the portal's own pipeline
- an enumeration value that exists and one that does not
- a contact-to-company association through a two-file common-column import
- an activity mapping refused before a file is written
- import counters reconciled against the package, and an export-back compared
  property by property against the delivered file

Read from portal 51050101, and only read:

- the property-export parser on a real export — the file the account owner
  produced from HubSpot Settings, 209 contact, 115 company and 73 deal fields
  parsed with no correction to the declared header table, PASS. A HubSpot
  property export carries no portal id anywhere in it, which is why this was
  first attributed to 51872453; that attribution was wrong, and
  `hs-property-export.json` records both what it said and how it was settled.

Not qualified, and therefore not claimed:

- whether a property **Kauro creates** behaves as one HubSpot ships **in portal
  51872453**, which is the account the missing scope belongs to and the account
  every other half of this gate now uses. It was established in 51050101, once,
  on a package the engine built before format 2.0.0 landed at `ae952ca` the
  following day, and it has not been established anywhere since. Everything else
  about unique-property matching is established on `email`.

## The single action that would close the remainder

In portal **51872453** — the developer test account, not the standard one —
create a private app, or grant an existing one, these scopes:

    crm.schemas.contacts.write
    crm.schemas.companies.write
    crm.schemas.deals.write

Everything after that is automated and needs nobody: the properties, the corpus,
the imports and the read-back are all already written.
