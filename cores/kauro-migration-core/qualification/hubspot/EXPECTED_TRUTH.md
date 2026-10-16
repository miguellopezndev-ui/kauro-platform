# HSP-TARGET-01 — expected truth

Written before the run, against developer test portal `51872453`, synthetic data
only. Each expectation says what the portal must do. A run that disagrees is the
portal correcting the engine, and the correction is recorded rather than the
expectation quietly rewritten.

An expectation snapshotted from what the engine currently produces tests nothing,
so nothing here was copied out of engine output.

## Which portal, and why it matters

Everything below runs against **portal 51872453**, `DEVELOPER_TEST`, synthetic
data only.

A second credential exists that carries the `crm.schemas.*.write` scopes the
custom-property half wants. It was tried, and it is a credential for **portal
51050101, `STANDARD`** — a live account holding 472 contacts and 92 companies.
Six property definitions were created there before the account type was read,
and all six were archived immediately; no record was ever written to it, and no
qualification runs against it. A qualification that writes into an account with
real data in it is not a qualification, whatever it proves.

So the qualification uses no custom property. It does not need one: the portal
carries a property that is unique by HubSpot's own definition and present in the
property export — `email` on Contact, `hasUniqueValue: true`. Matching on a
vendor-defined unique property is **stronger** evidence than matching on one Kauro
created, because nothing about it was arranged to pass.

The portal permits one deal pipeline on this tier, so the qualification uses the
pipeline the portal already has — `default`, "Sales Pipeline". A real pipeline
with real stage identifiers is what the expectation needs; whether Kauro created
it is immaterial.

## Contract layer — what the captured artifacts support

`C1` The property export captured on 2026-09-01 parses with no correction to the
declared header table, and yields 209 contact, 115 company and 73 deal fields.

`C2` Every field in that export carries `unique: UNKNOWN`. The export does not
state uniqueness, and UNKNOWN must never read as FALSE.

`C3` The pipelines artifact, captured from the portal by the collector, parses
into one deal pipeline with seven stages whose internal names are
`appointmentscheduled`, `qualifiedtobuy`, `presentationscheduled`,
`decisionmakerboughtin`, `contractsent`, `closedwon`, `closedlost`.

`C4` A stage resolves by **internal** identity. Resolving "Closed Won" gives
`closedwon`, and a label the artifact does not carry resolves to nothing rather
than to the first stage.

`C5` The contract's digest is stable across two builds from the same bytes, and
a contract whose text is altered by one character is refused on load.

`C6` The access grant captured from the portal (capture version 2) is answered
by portal `51872453` for the private app this qualification authenticates as,
and it grants `crm.objects.contacts.write`, `crm.objects.companies.write` and
`crm.objects.deals.write` — the portal's own statement, read from the
token-information endpoint on 2026-09-12 before this expectation was written.
The contract built with it states CONTACT, COMPANY and DEAL `createable` and
`updateable` `TRUE`; the same capture read without it states `UNKNOWN` on all
three and hashes to a different contract. Without the grant every import below
would be refused before the first row was read, which is what happened on the
first run after the MC-04 repair.

## Match authority — the separation the constitution is built on

`M1` The Kauro trace key is refused as a match key, by every spelling, even when
the supplement states it unique. Lineage identity is not destination authority.

`M2` A property the portal does not carry is refused, naming it.

`M3` A property present in the export but stated **not** unique is refused as
`REQUIRES_AGENCY_DECISION`. Presence is not permission. `firstname` is such a
property: it is real, it is exported, and matching on it would merge strangers.

`M4` A property present in the export whose uniqueness nobody stated is refused.
UNKNOWN does not authorize.

`M5` `hs_object_id` resolves as `RECORD_ID`, and it is the only thing that does.

`M6` `email`, stated unique because the portal states it unique, resolves as
`TARGET_UNIQUE_FIELD`, and the decision carries the digest of the contract it
was authorized against.

`M7` A HubSpot match declared `EXTERNAL_ID` is refused. HubSpot has no
external-id concept, and accepting the word would let a Salesforce-shaped
configuration run against the wrong destination.

## Import layer — what the portal actually does

Every import below goes through the CRM Imports API, with files the engine
produced, and every result is read back from the portal rather than inferred
from a success count.

`I1` A contact, a company and a deal each import, one file per object.

`I2` A property beyond the handful every import sets carries through unchanged:
`jobtitle` on the contact and `city` on the company read back with the value the
file carried.

`I3` An enumeration value the property defines imports and reads back:
`hs_lead_status` set to `NEW`.

`I4` An enumeration value the property does not define (`NOT_A_STATUS`) is
**rejected**, and the package predicted that rejection before the import ran.
A silent coercion to empty is a failure, not a pass.

The import file carries a second, valid contact (`lead`): HubSpot’s Imports
API pre-processing refuses a file of fewer than two data rows, so the bad row
is batched with a good one. After MC-04 the engine refuses `NOT_A_STATUS`
itself — destination validation isolates a value the attested picklist does not
declare (`DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN`) before it is delivered,
so the portal never sees it. That is stronger than letting the portal reject it,
and it is not a silent coercion: the row is isolated under a named reason, and
no contact is stored carrying the undefined stage.

`I5` A deal imports against pipeline and stage by **internal** identifier, and
reads back in stage `closedwon`.

Since 2.0.3 the package itself carries the internal identifiers. The source
holds the labels "Closed Won" and "Sales Pipeline", and a label admits nothing
(`docs/CONTRACT.md` 11d), so Q1 maps each onto the internal name explicitly
(`valueMap`: `closedwon`, `default`). The vocabulary those names are checked
against is the captured pipelines artifact: HubSpot keeps the options of
`dealstage` and `pipeline` there rather than on the property, and a stage is
eligible only inside the pipeline the record names (R-MC-PIPELINE, found by
this gate on the 2.0.3 candidate, whose first run refused the deal plan).

`I6` Create, then update, then create-and-update, keyed on `email` — the
portal's own unique property, not one Kauro made:
  - a first import of an address that does not exist **creates** one record;
  - a second import of the same address **updates** it and creates nothing — the
    record id is unchanged and the changed property carries the new value;
  - a file holding one existing address and one new one produces exactly one
    create and one update.

`I7` A contact-to-company association resolves through a two-file import sharing
a common column, and reads back as an association on the created contact.

`I8` An activity mapping is **refused** by the engine before any file is
written. Activities are outside the V1 envelope, and being outside the envelope
must mean refused rather than attempted and lost.

`I9` The import result reconciles against the package: the count the portal
reports created and updated equals the count the package said it would deliver,
and every row the portal rejected is a row the package named.

`I10` An export-back of the imported records matches what the package said would
be delivered, property by property, for the properties the package set.

## What this run does not show, and why

**Creating a custom property in the qualification portal.** The credential for
portal 51872453 does not carry `crm.schemas.*.write`, and the credential that
does is for a live account. Adding those scopes to the test portal is a Settings
action inside that portal, which no API performs.

That costs the run less than it appears to. Everything the custom-property case
was there to establish — that a unique property may authorize a match, that a
non-unique one may not, that the engine matches rather than duplicates — is
established above on `email`, and established better, because HubSpot decided
`email` was unique and Kauro did not.

What genuinely remains unshown is narrow, and it is named rather than papered
over: whether a property **Kauro creates** behaves as one HubSpot ships.

**Fabricating a property export** in the portal's format to close the gap was
available and was not done. An artifact Kauro wrote is not evidence about HubSpot.
