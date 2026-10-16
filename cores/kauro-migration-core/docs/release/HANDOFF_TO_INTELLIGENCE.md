# Handoff: what Migration Core v2.0.1 offers, and what it refuses

## 2.0.3 (released as 3.0.0) changes an integrator must act on

| what | 2.0.2 | 2.0.3 |
|---|---|---|
| package / bin | old brand name | `kauro-migration-core` / `kauro-core` |
| clear token (CLEAN_ONLY) | old brand token | `[KAURO:CLEAR]` |
| Salesforce association columns | old brand prefix | `Kauro_Association_Key__c`, `Related_Kauro_Association_Key__c` |
| config schema `$id` | old brand domain | `https://kauro.dev/schema/migration-config/2.0.0` (configs carry no `$schema`, so none changes) |
| package digest domain | old brand prefix | `kauro-package-digest/1` (every canonical digest moves) |
| destination permission | unknown type / empty or unknown enum / option label delivered | refused or isolated (`docs/CONTRACT.md` 11d) |
| HubSpot deal pipeline and stage | any value delivered | internal names from the captured pipelines only; a label needs a `valueMap` onto the internal name; a stage must belong to the record's pipeline; no captured pipeline refuses the plan (`docs/CONTRACT.md` 11d, D66) |
| `VerifyOptions` | `scratch`, `observe` | adds `targetContract?`, `requireTargetContract?`; exported type (`docs/CONTRACT.md` 13c) |

`CORE_VERSION` 3.0.0 (this release was prepared as 2.0.3; see `RELEASE_NOTES_3.0.0.md`); package format, config schema and every contract version
unchanged. The sections below describe 2.0.1 and remain accurate unless the
table says otherwise.

This document is for whoever builds the Intelligence layer on top of this
engine. It says what the public surface is, what each part of it means, what it
deliberately does not do, and how the evidence behind those claims was produced —
so that the next front can rely on the first two without re-deriving the third.

Nothing here is a plan for Intelligence. It is the contract Intelligence would be
building against, plus the method that made it checkable, which is the part worth
copying.

---

## 1. The surface

Everything Intelligence may use is exported from `src/index.ts`. Nothing else is
public: a consumer that reaches into `dist/src/...` is depending on a path this
engine may move, and the packaged consumer test
(`test/integration/public-consumer.test.ts`) exists to catch that — it installs
the built tarball into a temporary project and profiles, runs and verifies using
only the public exports. It found four missing exports the first time it ran,
which is precisely what it is for.

| Export | What it is | What it is not |
| --- | --- | --- |
| `buildSourceProfile` | reads a bundle with the same reader the migration uses and returns a versioned, hashed `SourceProfileV1` | not a second reader; the profile and the run agree about the bytes by construction |
| `serializeSourceProfile` / `loadSourceProfile` | the canonical text of a profile, and the loader that refuses anything that is not one | not a JSON parse: unknown fields, broken invariants and a tampered hash are all `SOURCE_PROFILE_INVALID` |
| `assertProfileDescribesBundle` | binds a profile to a bundle **and** to the reading configuration that produced it | not a file-count check: the inventory is compared in both directions, and a profile taken under a different delimiter is refused |
| `buildCandidateSet` / `loadCandidateSet` / `assertCandidateSetMatches` | `CandidateSetV1` — key candidates, ambiguous shape columns, duplicate clusters, unmapped material | **not an instruction.** The set carries `constraints: {authority: 'NONE', destructiveAllowed: false, identityAutoMergeAllowed: false}`, and nothing in the engine reads a candidate set at all. It is an observation offered to a layer that may decide; it authorises nothing |
| `runMigration`, `writePackage`, `promotePackage`, `verifyPackage`, `verifyAgainstSource` | the migration, the package, and the two verifications | `writePackage` stages and `promotePackage` publishes; a consumer that calls only the first has written nothing anybody can read |
| `createFilesystemScratchStore` | the host-injected bounded store the engine spills through | not optional: the engine holds nothing proportional to the row count, which is only true because the host provides this |

### What a candidate set means

A candidate is a thing the profile noticed. It is deliberately shaped so that
acting on it is a separate decision made somewhere else:

- it names **what was observed** and **where**, never what to do;
- every candidate carries refs to the bundle, the profile hash and the
  configuration revision it was derived under, and `loadCandidateSet` refuses a
  set whose refs name a different revision — so a candidate cannot outlive the
  reading that produced it;
- the loader refuses any key the schema does not declare, which includes any key
  that would carry authority.

If Intelligence wants to merge two records, it says so in a configuration and
the engine proves the merge from evidence. It does not inherit permission from
having been told about a duplicate.

---

## 2. What the engine refuses, and will keep refusing

These are not implementation gaps. They are the shape of the product.

- **No large language model, and no general network, in an execution.** A
  migration reads the bundle, the configuration and the attested target
  contract. Nothing else.
- **No row and no relationship disappears.** `SOURCE_ROWS = OUTPUT +
  MERGED_PROVEN + ISOLATED + LEFTOVER + REJECTED_INPUT` is checked in the run
  and again in the package, and the same equation exists for edges through the
  candidate count.
- **Uncertainty is preserved and isolated, never resolved by guessing.** Only a
  proven or confirmed identity authorises a merge.
- **`PRESERVE`, `SET`, `CLEAR` and `OMIT` are four different intents**, and a
  destination that cannot represent one of them says so rather than silently
  choosing another.
- **The attested target contract rules over the adapter.** Where the two
  disagree about a destination field, the contract wins, because the contract is
  evidence about the tenant and the adapter is a belief about the vendor.
- **Traceability is separate from the import area.** A trace key is never a
  destination match key.
- **Verified bytes are delivered bytes.** The package digest covers what a
  consumer receives.
- **No secret and no real customer datum reaches a fixture, a log or a
  release.** Sort keys are described rather than quoted when they are rejected,
  precisely because a key is built from source values.

---

## 3. The method, which is the part worth copying

Intelligence will need its own evidence. The three mechanisms below are what
made this front's evidence checkable, and each of them exists because the
previous front's did not hold.

### 3.1 The execution subject

A measurement is about something, and that something is more than `src/`. It is
the runtime, the harness that drove it, the oracle it was judged against, the
fixtures and corpora it was fed, the contracts it serialised, the dependency
closure, and the workflow that will run it again. `tools/execution-subject.mjs`
measures that as per-class digests and names it with one digest.

Two things follow, and both were broken here before they worked:

- **an editorial change must not move it**, or every correction to a sentence
  invalidates a campaign; and
- **it must cover everything that decides an outcome**, or a runner can change
  what it expects without the binding moving.

Both halves failed at least once during MC-3. The digest was taken over the
whole class census, so a producer writing its own evidence moved the subject and
the next producer of the same campaign refused to start. And the classifier put
`qualification/oracles.mjs` — the file that declares what each gate must ask —
outside the subject entirely, so the oracle could have been weakened without
anything noticing. If Intelligence builds a subject, test both directions
explicitly and over the real tree, not over a synthetic one.

### 3.2 The campaign

One campaign is one set of inputs sealed at one moment. Every producer records
its id and captures the subject when it starts and again when it finishes. A
capture whose two ends disagree is written `valid: false` rather than describing
a subject that no longer exists.

This replaced two mechanisms that were both defeated: a stamping tool that wrote
the current digest onto whatever files were in a directory, and a binding that
covered `src` and the lockfile but not the oracles or the corpora.

### 3.3 A gate that can say FALSE

Every gate here self-tests: it breaks the thing it checks, confirms it notices,
confirms the closure condition consults the fact that broke, and puts the tree
back. Without that, a rule that never fires is indistinguishable from a rule
with nothing to find — and this front found several: a case whose expected and
observed were the same predicate, a check that read an index its own file
documents as unfit, a drift rule that vanished rather than failing, and a
terminal flag that was true because `[].every()` is true.

The general form of the defect is worth stating, because it recurs: **a check
whose two sides come from the same place is not a check.** Look for it in every
comparison.

---

## 4. Where the evidence is

| What | Where |
| --- | --- |
| what each gate asked, and what it found | `qualification/evidence/*.json`, and `qualification/oracles.mjs` for what it had to ask |
| capacity, per mode and per dimension | `qualification/capacity/*.json` |
| the campaign every measurement belongs to | `qualification/candidate/campaign.json` |
| the offline universe, step by step | `qualification/candidate/universe.json` |
| the candidate's own digests | `qualification/candidate/manifest.json` |
| what the release vouches for | `migration-core-provenance.json` |
| how the terminal flags were computed | the freeze verdict in the release assets |

---

## 5. What is not in this repository, and must not be

- **`@kauro/contracts` does not exist here**, and a second repository is not
  created for it. The contracts are the exports of this package.
- **Intelligence is not started here.** MC-3 ends at the frozen release.
