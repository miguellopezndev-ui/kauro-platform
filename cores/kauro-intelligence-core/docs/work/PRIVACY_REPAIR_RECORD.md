# Privacy repair record (B03, gate G-IC-PRIVACY)

Branch `ic/privacy-repair`. Columns: the final acceptance tests run on the unrepaired base `27dbf10` (negative control), on the retained candidate `d7b3d28` (merged here with its history) and on the repaired code `c204045`. Base 21 PASS / 78 FAIL; retained 51 / 48; final 99 / 0. A test that passes on the base is a useful control or a regression guard (Active/Inactive, Open/Closed, CLEAN_ONLY shapes the base already withheld, S037, R2-027), never evidence of the repair. The tests-first commit `73653aa` recorded 57 of its 75 tests failing on the base. Runs: Node 24, Ubuntu 24.04 (WSL), `node --test` on the two files over each build; vectors and mode/surface cells in `PRIVACY_MODE_SURFACE_MATRIX.md`.

| case | test file :: exact title | 27dbf10 | d7b3d28 | final |
| --- | --- | --- | --- | --- |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY historical-segment through a repair round | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY suffixed-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY pascal-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY upper-single-names through a repair round | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY lower-single-names through a repair round | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY dotted-handles through a repair round | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY historical-segment | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY historical-vendedor | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY useful-status | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY useful-open-closed | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY upper-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY lower-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY mixed-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY unicode-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY plain-names | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY suffixed-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY lower-suffixed-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY snake-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY pascal-names | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY upper-single-names | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY lower-single-names | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY dotted-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY homonym-beside-suffixed-name | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 CLEAN_ONLY listed-surname-api-name | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT historical-segment through a repair round | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT suffixed-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT pascal-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT upper-single-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT lower-single-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT dotted-handles through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT historical-segment | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT historical-vendedor | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT useful-status | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT useful-open-closed | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT upper-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT lower-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT mixed-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT unicode-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT plain-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT suffixed-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT lower-suffixed-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT snake-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT pascal-names | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT upper-single-names | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT lower-single-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT dotted-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT homonym-beside-suffixed-name | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 HUBSPOT listed-surname-api-name | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE historical-segment through a repair round | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE suffixed-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE pascal-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE upper-single-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE lower-single-names through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE dotted-handles through a repair round | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE historical-segment | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE historical-vendedor | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE useful-status | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE useful-open-closed | PASS | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE upper-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE lower-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE mixed-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE unicode-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE plain-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE suffixed-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE lower-suffixed-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE snake-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE pascal-names | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE upper-single-names | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE lower-single-names | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE dotted-handles | FAIL | PASS | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE homonym-beside-suffixed-name | FAIL | FAIL | PASS |
| IC-05 | test/privacy-egress-acceptance.test.ts :: IC-05 SALESFORCE listed-surname-api-name | FAIL | FAIL | PASS |
| S036 | test/privacy-gate-cases.test.ts :: S036 CLEAN_ONLY: one run with a sentinel on every channel keeps each off the wire and out of the logs, and still drafts | FAIL | FAIL | PASS |
| S036 | test/privacy-gate-cases.test.ts :: S036 HUBSPOT: one run with a sentinel on every channel keeps each off the wire and out of the logs, and still drafts | FAIL | FAIL | PASS |
| S036 | test/privacy-gate-cases.test.ts :: S036 SALESFORCE: one run with a sentinel on every channel keeps each off the wire and out of the logs, and still drafts | FAIL | FAIL | PASS |
| S037 | test/privacy-gate-cases.test.ts :: S037 CLEAN_ONLY: instructions in a header, the values and the target options travel as data or not at all, and the request offers no tool | PASS | PASS | PASS |
| S037 | test/privacy-gate-cases.test.ts :: S037 CLEAN_ONLY: a response that calls a tool is a terminal provider failure; nothing it asked for is done and nothing of it is drafted | PASS | PASS | PASS |
| S037 | test/privacy-gate-cases.test.ts :: S037 HUBSPOT: instructions in a header, the values and the target options travel as data or not at all, and the request offers no tool | PASS | PASS | PASS |
| S037 | test/privacy-gate-cases.test.ts :: S037 HUBSPOT: a response that calls a tool is a terminal provider failure; nothing it asked for is done and nothing of it is drafted | PASS | PASS | PASS |
| S037 | test/privacy-gate-cases.test.ts :: S037 SALESFORCE: instructions in a header, the values and the target options travel as data or not at all, and the request offers no tool | PASS | PASS | PASS |
| S037 | test/privacy-gate-cases.test.ts :: S037 SALESFORCE: a response that calls a tool is a terminal provider failure; nothing it asked for is done and nothing of it is drafted | PASS | PASS | PASS |
| R2-027 | test/privacy-gate-cases.test.ts :: R2-027 CLEAN_ONLY: credentials as target options and source values never leave and never vouch, at cardinality three | PASS | PASS | PASS |
| R2-027 | test/privacy-gate-cases.test.ts :: R2-027 HUBSPOT: credentials as target options and source values never leave and never vouch, at cardinality three | PASS | PASS | PASS |
| R2-027 | test/privacy-gate-cases.test.ts :: R2-027 SALESFORCE: credentials as target options and source values never leave and never vouch, at cardinality three | PASS | PASS | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 CLEAN_ONLY: a plain error echoing the body and a credential leaves no credential, customer text or echo in the ledger, the result, the telemetry or the logs | FAIL | FAIL | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 CLEAN_ONLY: a typed after-send error with a credential as its code leaves no credential, customer text or echo in the ledger, the result, the telemetry or the logs | FAIL | FAIL | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 CLEAN_ONLY: a response under another model's name echoing customer text is refused and its name is not recorded | FAIL | FAIL | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 HUBSPOT: a plain error echoing the body and a credential leaves no credential, customer text or echo in the ledger, the result, the telemetry or the logs | FAIL | FAIL | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 HUBSPOT: a typed after-send error with a credential as its code leaves no credential, customer text or echo in the ledger, the result, the telemetry or the logs | FAIL | FAIL | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 HUBSPOT: a response under another model's name echoing customer text is refused and its name is not recorded | FAIL | FAIL | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 SALESFORCE: a plain error echoing the body and a credential leaves no credential, customer text or echo in the ledger, the result, the telemetry or the logs | FAIL | FAIL | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 SALESFORCE: a typed after-send error with a credential as its code leaves no credential, customer text or echo in the ledger, the result, the telemetry or the logs | FAIL | FAIL | PASS |
| R2-028 | test/privacy-gate-cases.test.ts :: R2-028 SALESFORCE: a response under another model's name echoing customer text is refused and its name is not recorded | FAIL | FAIL | PASS |
| R2-029 | test/privacy-gate-cases.test.ts :: R2-029 CLEAN_ONLY: only the client's own compatible memory travels; another client's entry, an agency entry that names a client and the same client id in another agency do not | FAIL | FAIL | PASS |
| R2-029 | test/privacy-gate-cases.test.ts :: R2-029 HUBSPOT: only the client's own compatible memory travels; another client's entry, an agency entry that names a client and the same client id in another agency do not | FAIL | FAIL | PASS |
| R2-029 | test/privacy-gate-cases.test.ts :: R2-029 SALESFORCE: only the client's own compatible memory travels; another client's entry, an agency entry that names a client and the same client id in another agency do not | FAIL | FAIL | PASS |
| R2-030 | test/privacy-gate-cases.test.ts :: R2-030 CLEAN_ONLY: the same text is one reference within an attempt and a different one across attempts, agencies, clients, revisions and keys | FAIL | FAIL | PASS |
| R2-030 | test/privacy-gate-cases.test.ts :: R2-030 HUBSPOT: the same text is one reference within an attempt and a different one across attempts, agencies, clients, revisions and keys | FAIL | FAIL | PASS |
| R2-030 | test/privacy-gate-cases.test.ts :: R2-030 SALESFORCE: the same text is one reference within an attempt and a different one across attempts, agencies, clients, revisions and keys | FAIL | FAIL | PASS |
## Mutations added or re-anchored by the repair (DIAGNOSTIC runs, not qualification)

| mutation (tools/sabotage-inventory/privacy.mjs) | outcome | run |
| --- | --- | --- |
| mask-key-unscoped (re-anchored) | KILLED | Windows, `d0353d6` |
| identifier-lower-word-admitted | KILLED | Windows, `d0353d6` |
| identifier-upper-compound-admitted | KILLED | Windows, `d0353d6` |
| segmentation-admits-any-lower-word | KILLED | Windows, `d0353d6` |
| segmentation-reads-listed-names | KILLED | Windows, `d0353d6` |
| joined-handle-left-unknown | KILLED | Windows, `d0353d6` |
| joined-name-read-as-text (first run as suffixed-name-left-unknown: SURVIVED; judge tightened, renamed) | KILLED | WSL, `9ccf4f4` |
| personal-options-ignored | KILLED | Windows `d0353d6`, WSL `9ccf4f4` |
| option-joined-name-not-personal | KILLED | Windows, `d0353d6` |
| mask-key-without-attempt | KILLED | Windows, `d0353d6` |
| provider-text-recorded | KILLED | Windows, `d0353d6` |
| agency-memory-naming-client-served | KILLED | Windows, `d0353d6` |
| caseless-name-treated-free-text (retained; SURVIVED in the qualification campaign on `05fba19`: the new value rule re-read caseless names; fixed in `c204045`) | KILLED | WSL, `c204045`, with the other 35 classifier mutations |

Inventory: 175 mutations; every anchor stands exactly once in the file it names (none stale). Qualification (`npm run gate`, `npm run sabotage`) runs on the commit that carries this record.
