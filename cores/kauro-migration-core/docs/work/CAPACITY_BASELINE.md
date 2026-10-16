# Capacity baseline

## Historical — every measurement below predates MC-1, banner added 2026-09-04

No number in this file can be reproduced by the harness that is in the tree now:
it generates different shapes, it reports a differently shaped result, and it
runs against a verifier with a different number of checks. The engine each of
these figures measured no longer exists either. They are kept because the
sequence of measurements is the argument — several exist only to record that a
plausible idea was tried and made things worse — and deleting the losing
measurements would leave the flattering ones standing alone.

The last figures here, 3,971 MiB at 500,000 rows and 8,178 MiB at 1,000,000, are
the ones in `qualification/evidence/capacity-500000.json` and
`capacity-1000000.json`. Those evidence files were last written at `2853689`,
which is an ancestor of `fab8eb6c` — the commit MC-1 began from. Everything
above them in this file is older still.

Three things say plainly that they cannot recur:

| what the evidence carries | what the tree now produces |
| --- | --- |
| `checksRun: 54` | the verifier declares 55 named checks — the distinct `record` identifiers in `src/verify/verify-package.ts`, and the `verification.checksRun` recorded against all five packages in `acceptance/index.json` |
| a result shaped `gate`, `mode`, `ceilingMb`, `budgetMb`, `sourceRows`, `peakMb`, `byStageMb` | a result shaped `profile`, `dimension`, `rung`, `peakRssBytes`, `peakScratchBytes`, `evidenceSchemaVersion`, written to `bench/capacity/ladder.json` |
| one CSV shape at one size per rung | twelve declared profiles, each stressing a named dimension |

What superseded it is the MC-1 execution state (`docs/work/MC1_EXECUTION_STATE.md`)
and the MC-1 work reaching `origin/main` at `7c8c59f8`. The harness described
in "The harness in the tree now" below arrived in that same commit.

The rest of the file follows. Its heading and opening were in the present tense
and are now in the past; nothing else in it has been reworded.

## PHASE 3, first half — historical

What the engine actually did then, measured on what was HEAD at the time before
anything was redesigned. The design that follows was chosen from these numbers,
not from the ledger's older ones.

## What was measured, and why the old figures did not settle it

`tools/bench.ts` measured one CSV with six columns and five mapped fields, one
CONTACT mapping, vendor `canonical`, `CREATE_ONLY`, a unique id per row — so no
associations, no merges, no unmapped columns, no second object, and no path
through the duplicate-candidate machinery. It then read
`process.memoryUsage().rss` once, after everything, and the file called that a
peak.

`tools/capacity.mjs` measured a representative bundle instead: four objects,
two relationship mappings across files, columns the configuration does not map,
and one contact in every hundred repeating an earlier source record id so the
proven-merge path carried real work. Memory was sampled on a 25 ms interval
inside the child, so the figure was a high-water mark. Each size ran in its own
process. Fixtures were streamed to disk a block at a time, because building a
1M-row fixture in memory would make the harness the thing that runs out of
memory.

That description is historical too. `tools/capacity.mjs` still exists and is
still the harness, but it is not the harness these numbers came out of — see
"The harness in the tree now" at the foot of this file.

## Measured, CLEAN_ONLY, Windows 11, Node 24.14.1

Before any change, to establish where the engine stood:

| rows | peak RSS | run | package | **verify** | package on disk |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 1,226 MiB | 1.0 s | 0.3 s | **10.4 s** | 15 MiB |
| 100,000 | **4,117 MiB** | 19.4 s | 5.6 s | **524.9 s** | 157 MiB |

Two things fall out of the second row.

**Memory.** 4.1 GiB for 100,000 rows is roughly 42 KiB of process memory per
source row. The declared qualification ceiling is 8,192 MiB with a 70 % reserve,
so the budget is 5,734 MiB. The 250,000 rung needs about 10 GiB on a linear
reading and is therefore already over the ceiling, never mind the 1,000,000 rung
the Founding gate requires. Nothing here is a cliff to be tuned around: memory
tracks the dataset because the whole dataset is retained.

**Verification.** 8.75 minutes to verify 100,000 rows, against 19 seconds to
produce them. Verification is 96 % of the wall clock and it grew 50× while the
data grew 10×. That is not a memory problem at all; it is `readTable` reading,
decoding and re-parsing each artifact from disk on every one of roughly thirty
call sites, with no cache, plus three linear scans of the whole lineage run once
per isolated, leftover and rejected entry.

A 1,000,000-row run on today's engine would need something like 41 GiB and,
being generous about the super-linear parts, hours in verification alone. The
8-hour qualification envelope is not the binding constraint; the machine is.

## Where the memory goes

Every stage keeps everything, and nothing is released before the next stage
runs.

- Ingest holds four representations of each file at once: the raw bytes, the
  decoded text, the parsed record array, and a `SourceRow` per accepted row —
  plus a `slice(1)` copy of the record array.
- `runMigration` returns the whole `bundle` to its caller, so every `SourceRow`
  and `SourceCell` from ingest is still reachable while the package is written.
- `built`, `identity`, `destination` and `associations` all stay live to the end
  of the function, alongside `recordByRow` and `edgesByRow`, which hold an entry
  per row.
- `lineage`, `changes`, `flags`, `unmappedFields`, `isolated`, `leftovers`,
  `rejected` and `deliveredRecords` are accumulated as arrays of objects — per
  cell, not per row, for changes, flags and unmapped fields.
- Every one of those is then copied again by `sorted`, which returns `[...items]
  .sort(...)`, while the original is still referenced.
- Rendering builds each artifact as a full `(string|null)[][]`, converts it to
  one string, then to one Buffer, and holds every artifact's string and every
  artifact's Buffer simultaneously until a read-back that reads each file from
  disk again.

## After the three fixes the measurements found

Indexing the associations scan that was half of verification; appending
relationship candidates instead of spreading them into a call; slicing CSV
fields instead of building them a character at a time. Peak memory is now broken
down by the stage it happened in, which is the difference between fixing the
thing that holds the memory and fixing something next to it.

| rows | run | package | verify | **peak** | budget | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 25,000 | 323 | 406 | 2,029 | **2,029 MiB** | 5,734 | PASS |
| 250,000 | 1,420 | 2,760 | 3,317 | **3,317 MiB** | 5,734 | PASS |
| 500,000 | 2,529 | 5,476 | 6,678 | **6,678 MiB** | 5,734 | **FAIL** |

Then artifacts stopped being held twice. An artifact used to be built as a rows
array, turned into one string, turned into one buffer, with every artifact's
string and buffer live together until a read-back at the end; at 500,000 rows the
package is 898 MB, so that was roughly 1.8 GB of UTF-16 text and 0.9 GB of bytes
at once. The writer now emits a block of rows at a time and hashes as it goes:

| rows | run | package | verify | **peak** | budget | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 500,000 | 2,530 | **2,831** | 6,583 | **6,583 MiB** | 5,734 | **FAIL** |

Packaging halved. The acceptance packages stayed byte-identical, which is the
check that matters: the streamed bytes are the bytes the old renderer produced.

**Verification is now the whole of the remaining gap.** It is 6,583 MiB against a
5,734 MiB budget, and the other two stages together are less than that.

Row reconciliation is exact at every rung: at 500,000 rows, 500,000 read and
500,000 accounted for, the partition closed, the package verified. The failure
is resource, not correctness.

Two of those three fixes were not memory work at all. Spreading 150,000
relationship candidates into `push` died with a RangeError before memory was
ever the question, and would have died for any customer with that many
relationships whatever machine it ran on. The per-character field building was a
quarter of the whole verification in garbage alone. Neither was found by reading
the code; both were found by running a workload worth measuring.

250,000 to 500,000 is 2.01x memory for 2x the data, so the curve is linear and
1,000,000 rows projects to roughly 13,300 MiB — above the 8,192 MiB ceiling, not
merely above the budget. Reaching the budget at 1,000,000 needs about a 2.3x
reduction, and the stage breakdown says where each part has to come from. Run is
the smallest term and still about 5 KiB per row. Package holds every artifact as
a rows array, a string and a buffer at once. Verification holds parsed tables of
a package that is by then most of a gigabyte.

## The design this points at

In order of what the measurements say is worth doing, and deliberately without
Redis, Kafka, Spark or a database — none of which this problem needs.

**1. Emit the row-scoped artifacts in traversal order instead of sorting them.**
The declared order of `source-lineage.csv` is file, sheet, row number. The
traversal that produces it already visits rows in exactly that order, so
`sorted(lineage, rowOrder)` sorts a list that is already sorted. The same holds
for changes, flags and unmapped fields, whose secondary keys are also produced in
order within a row. Writing each entry to an open file handle as it is produced
removes the array, the sorted copy, the rendered string and the Buffer in one
change — and those are the largest terms at 100k.

**2. Hash while writing.** The manifest digest can be fed from the same byte
stream, so no artifact ever needs to exist as a whole string or Buffer.

**3. Release ingest state.** Stop returning `bundle` from `RunResult`, free each
sheet's rows once its drafts are built, and drop the decoded text and raw bytes
before rows are constructed.

**4. Stop the verifier holding whole parsed tables.** This is now the only stage
above budget and the only thing keeping the 500,000 rung red, so it is next
rather than fourth.

`readTable` reads an artifact as bytes, decodes it into one string of twice the
file size, parses every record, copies the record array with `slice(1)`, and
builds one plain object per row carrying one property per column. All four
representations are live at once, for several artifacts at once, and at 500,000
rows `source-lineage.csv` alone is 500,000 rows of fifteen columns.

The shape of the fix follows from what the checks actually need. Very little of
the verification wants a whole row: most of it wants a small projection — a
disposition per row locator, a delivered key per record, a count per file. Those
are compact indexes, not tables. Where a check genuinely needs the row it can
have one at a time. The work is to replace "read the table, then look things up
in it" with "read the table once, building only what the checks will ask for",
which also removes the repeated re-reads of the same artifact.

The row representation matters too: a positional array with one shared header
index costs a fraction of an object carrying fifteen named properties. That
change is mechanical but wide, so it is worth doing after the projections, when
it is clear which rows survive at all.

**5. Only then** consider spilling identity and edge state to disk. It is last
because the measurements do not yet show it is needed, and a design that
speculates about that would be guessing.

Correctness is not negotiable against any of this. The capacity harness fails a
rung whose row partition does not close, or whose source-row count differs from
what was written, so a run that fits in memory by losing rows fails rather than
passes.

## Status

`CAPACITY-FOUNDING` = **MATERIAL_FAIL**, at the 1,000,000 rung: 8,178 MiB
against a 5,734 MiB budget. 500,000 passes at 3,971 MiB, and
250,000 passes on less memory than 100,000 needed before any of this work.

Corrected 2026-09-04: this line read 4,019 MiB for the 500,000 rung. The
committed evidence records 3,971 — `peakMb` in
`qualification/evidence/capacity-500000.json`, which `migration-core-v1-provenance.json`
repeats — and 4,019 is the figure from the abandoned lineage-projection
experiment two paragraphs above, where 500,000 rows went from 4,019 MiB to
4,699. Two different measurements had been collapsed into one number.

The projection above — 13,300 MiB at 1,000,000 on a linear curve — was wrong, and
usefully so. The curve was not linear because the terms were not all per-row: the
measured figure was 9,273 MiB before this round of work and 8,178 MiB after it.

Correctness is intact at every rung measured, 1,000,000 included: every row read
is accounted for, the partition closes, and all 54 checks pass with no problems
reported. That is what makes this a bounded engineering problem with a known
shape rather than a reason to lower the Founding commitment — and the shape is
now named rather than guessed at. See `GATES.md` for where the remaining
2,444 MiB is and what it would take.

## The harness in the tree now — added 2026-09-04

Not historical. This is what `tools/capacity.mjs` does at HEAD, read off the
source rather than off a run — `bench/capacity/` is ignored, so no result of it
is committed anywhere and no figure is quoted here.

**The shapes are declared, not written into the harness.**
`qualification/capacity/profiles.json` is the manifest —
`capacityProfilesVersion` `1.0.0`, `evidenceSchemaVersion` `1.0.0` — and
`tools/capacity-profiles.mjs` refuses to run against a manifest whose version it
does not read. Twelve profiles are declared, one per dimension:

| profile | dimension | profile | dimension |
| --- | --- | --- | --- |
| `P1` | `ROW_COUNT` | `P7` | `CARDINALITY` |
| `P2` | `SCHEMA_WIDTH` | `P8` | `VALUE_SIZE` |
| `P3` | `SHEET_COUNT` | `P9` | `EXCEPTIONS` |
| `P4` | `DUPLICATE_SIGNALS` | `P10` | `BUNDLE_SHAPE` |
| `P5` | `PROVEN_MERGES` | `P11` | `TARGET_HUBSPOT` |
| `P6` | `EDGE_COUNT` | `P12` | `TARGET_SALESFORCE` |

Each profile fixes a shape and gives its sizes as a share of the rung, so the
shape does not change as the size does. The rungs are 100,000, 250,000, 500,000
and 1,000,000, and a rung that does not pass stops the ones above it, because a
rung above a failure means nothing.

**The limits are bytes, and they come from the engine rather than the harness.**
`tools/capacity.mjs` reads them from `src/domain/resource-profile.ts`, which
states them as integers and says why: a value computed as `bytes / 1024 / 1024`
is mebibytes wearing the name of megabytes, and a budget compared the other way
is a comparison of two different numbers.

| limit | bytes | shown |
| --- | ---: | --- |
| memory ceiling | 8,589,934,592 | 8,192 MiB |
| memory budget | 6,012,954,214 | 5,734 MiB, the ceiling times seven tenths exactly |
| scratch ceiling | 68,719,476,736 | 64 GiB |
| scratch budget | 51,539,607,552 | 48 GiB |
| wall clock | — | 8 hours |

**The peak the gate believes is the operating system's.** Each profile and rung
runs in its own child process under `--max-old-space-size=8192`, and the child
writes `process.resourceUsage().maxRSS` — kibibytes, converted once — to
`peak.txt` in a `finally`, so a run that threw still reports what it cost. The
in-child sampler is a worker thread on a 50 ms tick, and it exists only to
attribute the high-water mark to a stage; the gate does not decide on it. A run
whose operating-system peak could not be read fails rather than passing on the
weaker number.

**A rung passes on seven conditions, not on memory alone.** The verifier passed;
the row equation holds; the source row count equals what the profile declared;
the edge count equals what the profile declared; the peak is within the memory
budget; scratch is within the scratch budget; the wall clock is within the
envelope. The declared counts are computed from the profile's parameters and
never read back from what the generator produced, because a count taken from the
output is the harness agreeing with itself and a generator defect would move
both sides together. A run that fits in memory by losing rows fails.

**It says which run it was.** `bench/capacity/ladder.json` carries `scope`:
`FULL_LADDER` for `--ladder`, `SINGLE_RUNG` otherwise, and the summary line is
`CAPACITY-FOUNDING` only in the first case and `CAPACITY-SMOKE` in the second.
A ladder that did not climb every profile to a million rows is not the founding
qualification, and the file refuses to be read as one.
