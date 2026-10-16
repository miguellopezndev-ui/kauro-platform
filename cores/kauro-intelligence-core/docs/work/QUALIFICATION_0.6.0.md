# Qualification record of Intelligence Core 0.6.0 (B04)

State on 2026-10-06: **NOT EXECUTED.** No funded stage has run; nothing below is evidence yet. The AWS account (A9 §5) and the
grants A and B (`.kauro/grants.md`) are owner acts that come first. Every rehearsal so far (plan rehearsal, chaos rehearsal, the
recorded-transport rehearsal over the 660) is SIMULATED and is never qualification evidence (A4).

This page and `release-record.json` (written beside it when the three runs pass) are where the qualification of the pinned policy is
recorded under D4-REL-2' (PROPOSED to Codex; `docs/design/B04-design.md` §2.7). If Codex rejects D4-REL-2', the rc plan of D4-REL-2
applies and this page records the qualification of `0.6.0-rc.1` instead.

## What is recorded here after the runs

1. The tarball that ran: its sha256 and its content digest (`icPackageDigest`, validity v4, D4-VAL-4), and the commit it was packed from.
2. The subject of the three runs (`SUBJECT_FIELDS`: served model, location, model policy hash, prompt bundle hash, compiler contract,
   Migration Core version, package digest, scorer digest, corpus digest), equal across the three runs (S044).
3. The scorer-validity record the stages were admitted on (its `recordDigest`) and each stage's rerun in its clean install
   (`preflight.json` `validityRerun`).
4. The pilot's selection record and the grant ledgers of grants A and B (charged, held, liability, stops), audited by `ledger-audit.mjs`.
5. The three run reports: their digests, the hard gates (zero and observed in every run), supported and abstention correctness against
   `QUALITY_THRESHOLDS`, cost actuals per accepted plan.

## `release-record.json` (shape)

```json
{
  "artifactKind": "KAURO_IC_RELEASE_RECORD",
  "version": "0.6.0",
  "tarball": { "sha256": "<hex>", "icPackageDigest": "<hex>", "commit": "<sha>" },
  "subject": { "<SUBJECT_FIELDS member>": "<value>" },
  "validityRecordDigest": "<hex>",
  "reports": ["<report digest run 1>", "<report digest run 2>", "<report digest run 3>"],
  "qualification": "QUALIFIED | NOT_QUALIFIED",
  "evidence": "EXECUTED_PROVIDER"
}
```

The B05 consumer reads this record and treats the policy as qualified only when the tarball it installs has the recorded sha256 and
content digest and the record says QUALIFIED with EXECUTED_PROVIDER evidence.
