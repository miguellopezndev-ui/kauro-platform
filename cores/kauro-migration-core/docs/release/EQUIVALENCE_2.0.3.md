# 2.0.3 — evidence equivalence record

Old subject: 2.0.2, commit `ed09809ba3749ea84f0eecd85bf1b09f29b31d82`, campaign `c_f8f9fdc19671d265` (subject `e370fb12…`).
New subject: 2.0.3, campaign `c_61afb3ae67e6bdf5` (subject `cd081a71b527b929…`, code `fae23d7bf9ab1296…`).
The 2.0.2 records are removed from this tree and cited here by commit and SHA-256 of the file at `ed09809`.

## Cost of the full campaign on this host

Full campaign on 2.0.2 (same host, 12 CPU, 14.9 GB): matrix 22:01→02:16Z + founding 02:16→04:49Z = **6 h 48 min**.
Re-measured on 2026-09-29 (P11, P12 below): +56 % wall clock at identical bytes → about **10 h 40 min** now.
Above the ~4 h threshold, so the smallest distinguishing subset was run.

## What changed in the producers' closures

| change | capacity path | vendor path |
|---|---|---|
| `validate-destination.ts`: type family, vocabulary (EMPTY/UNKNOWN refused, value-only), DATE→DATETIME HubSpot only | plan checks O(fields) once; per-record check same cost as before | **changes what is delivered** for unimplemented types, empty/unknown/label-only enums, SF date→datetime |
| `verify/target-evidence.ts`, `VerifyOptions.targetContract` | not exercised (harness verifies structurally) | not exercised |
| brand strings, `CORE_VERSION` 2.0.3 | constant-size; run ids and digests move | custom property / column names in corpora renamed (`kauro_qualification_*`, `Kauro_*__c`) |
| CLI `run` verifies against its contract | harness uses the library, not the CLI | runners use the library |

## Runs repeated under `c_61afb3ae67e6bdf5` (`qualification/capacity/matrix.json`, sha256 `4bcd0ccb…`)

The two profiles that drive the changed per-record path at 1M rows under a target contract:

| profile | peak RSS (2.0.2 → 2.0.3) | peak scratch | scratch written | package bytes | wall ms | result |
|---|---|---|---|---|---|---|
| P11 TARGET_HUBSPOT 1M | 1,094,520,832 → 1,095,909,376 | 12,055,154,650 → 12,055,154,650 | 59,565,079,858 → 59,565,079,858 | 1,605,963,801 → 1,605,963,805 | 1,179,319 → 1,843,556 | PASS, 55 checks, attest ok |
| P12 TARGET_SALESFORCE 1M | 1,153,212,416 → 1,055,059,968 | 10,524,550,477 → 10,525,350,477 | 52,129,839,974 → 52,133,039,974 | 1,513,069,645 → 1,513,069,662 | 1,233,600 → 1,927,656 | PASS, 55 checks, attest ok |

Scratch and package size are the same within 0.01 %; peak RSS +0.1 % (P11) and −8.5 % (P12). The only figure that grew is
wall clock, by the same 56 % in both modes while every byte count held. Attributed to the host, not proven: Windows
Defender real-time scanning covers `C:\` again since 2026-09-18 (the 2.0.2 campaign ran under a whole-drive exclusion),
and its process held the second-highest CPU time on the host after the run. Worst case 1,927,656 ms is 6.7 % of the 8 h wall-clock limit.

## Applicability of 2.0.2 evidence

- **Capacity (argued equivalent, not re-stamped):** matrix P1–P10 and founding ×2 per mode at `ed09809`
  (`qualification/capacity/matrix.json` `bd998c1f…`, `clean-only.json` `d7ddaef6…`, `hubspot.json` `7e3fe4dd…`,
  `salesforce.json` `c2988138…`): no algorithm, spill family or buffer changed; CLEAN_ONLY takes no instance plan;
  the repeated profiles show byte-identical scratch. The repository's gate (`campaign_covers_this_subject`) does not
  accept this argument and still requires the full campaign under one seal — owed.
- **Vendor (not equivalent):** the permission rule narrows what is delivered and the corpora's custom names changed,
  so HSP-TARGET-01 (target, import) and SF-TARGET-01 (target, Data Loader, OCR) must be re-run. BLOCKED_OWNER: the
  write-capable tenant credentials and captured contract bundles (`--auth` directory), Salesforce Data Loader and
  JDK 17 are no longer on this host.
