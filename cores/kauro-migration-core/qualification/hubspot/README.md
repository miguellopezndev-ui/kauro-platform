# HubSpot qualification

What this directory is for, and what has to be true before `HSP-TARGET-01` can be
called PASS.

Everything here runs on synthetic data only. No customer data goes into a
qualification run, ever. A developer test account is the account this was
designed for, and it is not the account the recorded evidence came from — see
"Which portal these numbers came from" below.

## The account

The free path for testing is a **developer test account**, created from a
standard HubSpot account. Standard and development sandboxes need an Enterprise
subscription and are not the route here. Legacy standalone developer accounts no
longer exist: they were migrated into standard accounts on 9 March 2026, so
"create a developer account" now just means creating a standard HubSpot account.

Creating the test account:

1. In the standard HubSpot account, go to **Development**.
2. In the left sidebar, **Testing → Test Accounts**.
3. Upper right, **Create developer test account**.
4. Name it, then **Create**.

What that gives you, and what it costs:

- By default the account is set up with **Enterprise-tier trials for all Hubs**.
  The creation dialog has a *Customize my test account* checkbox if a lower tier
  is wanted per Hub — which is worth using when the point is to check what a
  customer on a lower tier will actually see.
- **Ten test accounts** per standard account, and they cannot sync data with
  other accounts.
- They **expire after 90 days with no API calls**, and can be renewed from the
  Test accounts page or by an API call made no more than 30 days before expiry.
- Custom properties, including **unique-value** custom properties, are available
  on every plan, so a test account can carry them.
- **No CRM record cap is documented.** Do not design a qualification run around
  an assumed ceiling; the documented limits cover marketing email, content and
  workflow enrolment only.

## What `--auth <dir>` has to contain

Every runner here takes `--auth <dir>` and shells out to scripts inside it.
Nothing about the directory is in this repository and nothing should be: it holds
credentials. But the *contract* between the runners and that directory belongs
here, because the one time it was left undocumented it drifted — the runner asked
for `hs-import.sh` while the directory carried the multipart helper as
`hs-upload.sh`, and the import gate could not submit a file at all.

| file | what it does |
| --- | --- |
| `env` | sourced by the others; defines `HUBSPOT_TOKEN` |
| `hs.sh` | `hs.sh <METHOD> <path> [<json body>]` — one JSON request, body then `__HTTP_STATUS__:<code>` |
| `hs-upload.sh` | `hs-upload.sh <importRequestJsonFile> <file>...` — the multipart POST the Imports API needs, which the JSON path cannot express |
| `hs-token-info.sh` | `hs-token-info.sh` — `POST /oauth/v2/private-apps/get/access-token-info` for the token in `env`, composed inside the script so the token is in the request body and nowhere else; body then `__HTTP_STATUS__:<code>` |

Two rules the scripts must keep, and do:

- **The token is never on a command line, never in the environment of anything
  but `curl`, and never printed.** A qualification that leaks the credential it
  used has failed at something more important than the gate.
- **The status is a separate marked line.** Callers read it without the body
  having to be JSON, because some responses carry no body and an error page is
  not JSON.

The directory is also where a captured contract bundle lands. Which portal a
bundle describes is written inside it, in `capture-manifest.json` — not in the
directory name, which is a convenience and not evidence.

## Capturing the target schema

1. Settings icon in the top navigation bar.
2. Left sidebar → **Properties**.
3. Upper right → **Export all properties**.
4. Tick **Contacts**, **Companies** and **Deals**.
5. Choose a file format from the dropdown.
6. **Export**.
7. The file is **not** downloaded in the browser. HubSpot emails a download link
   and posts it to the notification centre. Selecting several objects returns a
   ZIP with one file per object.

### What that export does and does not carry

This matters more than it looks, and the parser is built around it.

HubSpot documents the export's **contents** as a prose list — name, internal
name, type, description, group, options if applicable, the user that created it,
usages, fill rate — and explicitly as a non-exhaustive one. It does **not**
document the file format, the literal column headers, their casing, or their
order.

So the parser:

- matches headers **by semantic role against a declared table of candidate
  spellings**, case- and whitespace-insensitively, for discovery only;
- keeps the original header text in every message it reports;
- tolerates unknown extra columns without letting them become authority;
- **fails closed** when a required role matches zero columns or matches more than
  one, naming the headers it actually saw.

That table is the thing a real export confirms or corrects. Correcting it is a
one-line change, and the line records the date a real export settled it.

The export also does **not** carry `hasUniqueValue`, `fieldType`, required, or a
custom-versus-default flag. A property's uniqueness therefore comes out of this
artifact as **UNKNOWN, never FALSE** — and uniqueness is exactly what decides
whether a property may be a match key. Facts the export cannot carry come from a
separate supplement, recorded as `SUPPLEMENT` evidence rather than quietly
promoted to the same standing as an export.

### Pipelines and stages

Deals need pipeline and stage **internal** identifiers, which the property export
does not carry. They come from a separate versioned artifact with these columns:

```
object, pipeline_label, pipeline_internal_name, stage_label,
stage_internal_name, display_order, stage_probability_or_state, captured_at
```

**No default pipeline or stage is ever assumed.** A deal whose pipeline or stage
is not in the captured artifact is set aside, not guessed at.

### The access grant (capture version 2)

Whether an object accepts creates and updates is not in any property artifact,
and both readers said so: the object flags came out `UNKNOWN`. Under the MC-04
rule — an instance fact the contract does not establish never authorises — that
made every HubSpot `CREATE_ONLY`, `UPDATE_ONLY` and `UPSERT` run refuse at
destination validation with "recapture the target schema", which no recapture of
properties could satisfy. The vendor gate found it on the first run after the
repair (2026-09-12, `DESTINATION_MODE_UNSUPPORTED` on `CONTACT`).

The fact exists and the portal states it: the scopes it granted the private app
that captured the artifacts and will write the records. The collector asks
HubSpot's token-information endpoint through `hs-token-info.sh` and writes the
answer — portal, app, scopes; never the token — as `access-grant.json`, named by
`capture-manifest.json` (`captureVersion` `2`, key `accessGrant`). The contract
reads it back like every other artifact: hashed, compared against the portal the
properties came from, and turned into the object flags — `crm.objects.<object>.write`
present makes `createable` and `updateable` `TRUE`, absent makes both `FALSE`.
A version-1 capture is still read; its contract states `UNKNOWN` and the engine
refuses to write against it. The earlier capture of this portal (2026-09-04) is
kept beside the new one as `hs-contract-51872453.v1-20260904`; nothing in it was
re-stamped.

## What HSP-TARGET-01 has to demonstrate

Against a real portal, with synthetic data — a developer test account where one
is available, and in the event 51050101:

- the property-export parser reads a real export, and the header table it
  declares matches the real headers;
- Contact, Company and Deal each import;
- a custom property imports;
- an enumeration value that exists imports, and one that does not is rejected —
  and the package predicted it;
- pipeline and stage resolve by internal identity;
- create, update, and create-and-update each behave as declared;
- the supported associations resolve through a two-file common-column import;
- an activity mapping is refused rather than delivered, because activities are
  outside the envelope;
- the import result and error files reconcile against the package;
- an export-back matches what the package said would be delivered.

## What is here now

`EXPECTED_TRUTH.md` states what the portal must do, written before anything ran.
`corpus/` holds six synthetic cases, `Q1` to `Q6`. `collect-target-schema.mjs`
captures the artifacts; `run-target-qualification.mjs` puts the readers and the
match rules to them, 32 checks; `run-import-qualification.mjs` runs the engine on
the corpus and imports the files it produced into portal 51050101, 23
expectations, every result read back from the object store;
`run-custom-property-qualification.mjs` puts matching to a property Kauro creates,
11 expectations.

| runner | evidence file | count | result |
| --- | --- | --- | --- |
| `run-target-qualification.mjs` | `../evidence/hs-target-contract.json` | 32 checks | PASS |
| `run-import-qualification.mjs` | `../evidence/hs-import.json` | 23 expectations | PASS |
| `run-custom-property-qualification.mjs` | `../evidence/hs-custom-property.json` | 11 expectations | PASS |

The counts are the ones those files carry — `checksRun` for the first, the length
of `cases` for the other two — not a tally kept by hand here.

`run-import-qualification.mjs` will report 24 on its next run rather than 23:
`I7.theAssociationFileJoinsTheObjectFiles` was added when the association lookups
were repaired for package format 2.0.0. The runner had been reading the
association file under column names 2.0.0 removed, so every lookup missed, the
common column came out empty for every row, and the association case asserted
against nothing. The new expectation states that the join matched, so the same
failure cannot be silent a second time. Until the gate is re-run, 23 is what the
evidence establishes and 24 is what the code will produce.

### Which portal these numbers came from

This section said the imports went to portal `51872453`. They did not. Every
HubSpot evidence file in `../evidence/` records `51050101`:
`hs-target-contract.json`, `hs-import.json`, `hs-metadata.json` and
`hs-custom-property.json` all carry `"portalId": "51050101"`, and
`hs-property-export.json` carries `51050101` with `"accountType": "STANDARD"`.

Commit `ebd81f0`, "HubSpot on one portal, and the portal was wrong", made that
correction across the evidence files, `docs/work/GATES.md`,
`docs/release/MIGRATION_CORE_V1_PROVENANCE.md` and the provenance JSON. It did
not touch this file, which is why the wrong number survived here for as long as
it did.

The `51872453` reading is kept on the page rather than deleted, because it is
where the mistake came from and because it is still the right identifier in the
places that are about the credential rather than about a run: `51872453` is the
developer test account this qualification was designed for, and it is the account
whose token carries no `crm.schemas.*.write` scope.
`../evidence/HUBSPOT_SCOPE_BLOCKER.md` sets out both portals and what each
credential can do; `hs-property-export.json` records, under `portalAttribution`,
why the export was first attributed to the wrong one.

What follows is what running against a portal corrected.

## What the portal corrected

Recorded against package format 1.1.0, where the Kauro-made column in an import
file was spelled "Kauro Trace Key". Format 2.0.0 took the trace key out of
`01_IMPORT` altogether; the column an object file carries now is `Association
Key`, the adapter's `associationKeyHeader` — see
`acceptance/D-hubspot/package/01_IMPORT/hubspot/contacts.csv`. The findings below
are kept in the words they were recorded in, so read "Kauro Trace Key" as the
1.1.0 spelling of the column that is dropped before an API import. The finding
itself did not change: whatever the column is called, it is Kauro's and never
becomes a property in somebody's portal.

**The property export carries writability, and the parser was discarding it.**
"Read only value" and "Calculated" are in the file and in no documentation. Left
unread, every HubSpot property reached the match authority with updateability
UNKNOWN, which is refused — so no HubSpot record could be matched on anything,
and UPSERT and UPDATE_ONLY against HubSpot were unreachable for every portal.

**The trace-key guard could be walked past by respelling.** Kauro writes the
column "Kauro Trace Key"; a HubSpot internal name is lower case with underscores,
so the property an agency would create to hold it is `kauro_trace_key`, and case
folding alone does not see those as one name.

**The Imports API has no "Don't import column".** Every column in the file must
map to an existing property: leaving one out is refused as "Mismatching number of
columns", declaring it without a property as "Must specify property name for
column X". Six spellings of an ignore flag were tried and every one was refused
or answered with a 500. So the Kauro Trace Key column has to be **removed** before
an API import — never mapped to a property, which would put Kauro's bookkeeping
into somebody's portal. The import wizard's "Don't import column" has no API
equivalent, and that is a real difference between what an operator can do by hand
and what they can automate.

**A contact-to-company association joins on the company's domain**, not on a Kauro
key — for the same reason, and it is the better answer anyway: the join key is
the destination's own identity. Which contact belongs to which company still
comes entirely from the package.

**The portal refuses reserved test top-level domains.** `.example`, `.test`,
`.invalid` and `.localhost` are all rejected as invalid email addresses and
company domains. This repository's own fixtures use `@example` addresses
throughout, so a package built from them imports as an error per row.

**An enumeration value the portal does not define is refused per cell, and the
record is still created.** The row is not lost and the cell is not silently
emptied — HubSpot reports the error and stores nothing for that property.

## What is still not shown

### Historical, and superseded

Creating a custom property in this portal. The credential for 51872453 carries no
`crm.schemas.*.write` scope, and the credential that does belongs to a live
standard account holding real records, which no qualification may touch. See
`EXPECTED_TRUTH.md` for what that costs and what stands in its place.

That paragraph was written at `464a33d`, the last commit to touch this file, and
`6b87af9` — the next commit to touch this directory — supersedes it.
`../evidence/hs-metadata.json` records six
property definitions created in portal 51050101, each answering 201, and
`../evidence/hs-custom-property.json` records 11 expectations PASS for matching
on a property Kauro created, including that a second record cannot hold the same
key and that an undefined option is refused.

### What that leaves

The same behaviour in 51872453 itself, which is the account the missing scope
belongs to. `../evidence/HUBSPOT_SCOPE_BLOCKER.md` names the one action that
would close it.
