# MC-3 — terminal result

The four flags are **not written here**. They are computed by
`node tools/freeze-verdict.mjs` from the merged commit, the external CI receipt,
the branch ruleset, the tag and the downloaded release assets, and published as
a release asset beside them. A flag written into this tree would be the tree
describing itself as finished, which is the thing this whole front exists to
prevent.

Run the verdict to read them.

---

## What MC-3 established

**The thirty deferred defects and the three seams are closed**, each with a
negative test that fires on it. The full suite is green, and the offline
universe passes nineteen of nineteen from a clean checkout, including the whole
sabotage corpus: 98 of 98 mutations killed, 0 survived.

**Evidence is bound by its producer.** `--stamp` is gone. Every runner captures
the execution subject before its first request and re-checks it when it writes
its record, and a gate refuses a record whose capture names a different subject.
That discipline cost three campaigns during this front: each time a repair
landed in `tools/`, the subject moved and the measurements stopped belonging to
the tree. That is the mechanism working rather than failing.

**Capacity, at a million rows, under campaign `c_109ca69e2c96985c`:**

| mode | rows | peak RSS | peak scratch |
| --- | ---: | ---: | ---: |
| CLEAN_ONLY | 1,003,000 | 1,615 MiB | 10,299 MiB |
| HUBSPOT | 1,003,750 | 1,417 MiB | 11,653 MiB |
| SALESFORCE | 1,003,000 | 1,487 MiB | 10,298 MiB |

Against a memory budget of 5,734 MiB and a scratch budget of 49,152 MiB. Each
mode ran twice and produced byte-identical packages, passed source-backed
attestation, ran all fifty-five checks and satisfied row conservation. All
twelve dimension profiles passed at the scale their own parameters declare.

**Five vendor gates, all PASS**, with twenty-one records created in the two
authorised tenants and every one deleted and confirmed gone by reading it back.
**Zero browser openings**: Data Loader runs headless on the integration
principal through the unmodified official jar.

---

## What this front got wrong, and what it cost

Recorded because the cost was real and the pattern is worth not repeating.

**Three record-ordering mistakes, each found by running the chain rather than
reading it.** The release provenance vouches for the candidate manifest, the
candidate provenance, the preflight and the universe report. Written out of
order, exactly one of `candidate-provenance --check`, `provenance:check` and
DRIFT-01 fails, and which one depends on which record was written last. Two of
these were cycles this front introduced by making the release record vouch for
more than it used to; the third was simply the wrong order. See §10 of
`MC3_EXECUTION_STATE.md` for the order that works.

**Two rules that were wrong in the direction that lets a bad thing through.**
The source-registry fact refused evidence observed *after* the campaign was
sealed — which is the correct order, so every properly ordered campaign failed
it, and the only way to satisfy it would have been to seal after measuring. The
sabotage trace check consulted an allowlist and blamed sabotage for a directory
the architecture gate had made.

**One failure notification that was not read.** A campaign re-run died in
seconds and its completion notice said `failed`. It was not opened, and the six
and a half hours the campaign needed passed with nothing running. No technical
obstacle; one missing measurement.

---

## Owner actions required

**None.** No permission, credential, secret or cost decision is outstanding.
