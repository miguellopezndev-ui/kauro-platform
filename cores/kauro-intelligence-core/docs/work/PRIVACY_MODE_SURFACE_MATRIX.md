# Privacy mode and surface matrix (B03, G-IC-PRIVACY)

Every cell is exercised through a whole public run (`createIntelligenceCore(...).run`, transport gateway, real Migration Core 2.0.1 validation) by `test/support/egress-harness.ts`, which reads the provider request bytes, the envelopes parsed back out of them, transport metadata, telemetry, process stdout/stderr, the run ledger (without its response store) and the result (without the configuration handover). Titles are exact; `<M>` is `CLEAN_ONLY`, `HUBSPOT` or `SALESFORCE`. Mutations are ids in `tools/sabotage-inventory/`.

| surface | production path | CLEAN_ONLY | HUBSPOT, SALESFORCE | tests | mutations |
| --- | --- | --- | --- | --- | --- |
| target options | `redactMetadata` → `classifyOption` (OPTION); `personalOptionsFor` | N/A: the view is Migration Core's canonical field list, passed unchanged | withheld, field kept with `options: []` | `IC-05 <M> <vector>` (18 vectors), `… through a repair round` | target-option-pii-kept, option-joined-name-not-personal, vendor-suffix-admits-option, handle-treated-as-code |
| target labels | `redactMetadata` (LABEL) | N/A (canonical) | opaque `lbl_`, scoped | `R2-030 <M>: …` | mask-key-unscoped, mask-key-without-attempt |
| source values (summaries → exemplars) | `minimize` → `classifyValue` | withheld (or a pure L2 mask of text) | withheld whole; no exemplar, even in a repair round | `IC-05 <M> <vector>`, `IC-05 <M> <vector> through a repair round` | joined-handle-left-unknown, joined-name-read-as-text, personal-options-ignored, handle-left-unknown-in-value, personal-value-does-not-close-column |
| source headers | `redactMetadata` (LABEL) | opaque `hdr_` | opaque `hdr_` | `IC-05 <M> <vector>` (opaque-header), `S036 <M>: …`, `R2-030 <M>: …` | header-masking-removed, compound-shape-admits-label |
| api identifiers | `redactMetadata` (IDENTIFIER) → `identifierVerdict` | N/A (canonical) | opaque `api_` unless every piece is vocabulary | `IC-05 <M> <vector>` (opaque-api-name; `listed-surname-api-name`) | identifier-lower-word-admitted, identifier-upper-compound-admitted, segmentation-admits-any-lower-word, segmentation-reads-listed-names |
| file names | not an envelope channel: the envelope carries Migration Core's `F-<hex>` file id; the path stays in the configuration handover | absent | absent | `S036 <M>: one run with a sentinel on every channel …` | none (no path to guard) |
| sheet names | not an envelope channel: Migration Core mints `S<n>` (profile schema `^S[0-9]+$`) | absent | absent | inspected, not a run | none |
| memory patterns | `resolveMemory` (scope) → `redactMetadata` (LABEL) | opaque, own client only | opaque, own client only | `IC-05 <M> <vector>` (opaque-memory-pattern), `S036 <M>`, `R2-029 <M>: …` | memory-text-classification-removed, cross-client-memory-served, agency-memory-naming-client-served |
| repair feedback | `redactMetadata` (repair codes IDENTIFIER, values OPTION) | opaque `code_` | opaque `code_` | `S036 <M>: …` (Tolveno), `… through a repair round` | repair-code-not-classified, identifier-upper-compound-admitted |
| provider and transport errors | `recordedReason` before the ledger and the result | withheld | withheld | `R2-028 <M>: …` (3 per mode) | provider-text-recorded |
| credentials (L4) | hard rules, `EGRESS_BLOCKED_SECRET` | excluded | excluded | `R2-027 <M>: …` (regression guard) | secret-does-not-block, contaminated-field-emits |
| instructions in data | hard rules (`INSTRUCTION_LIKE`), request shape, tool refusal | data only | data only | `S037 <M>: …` (2 per mode, regression guard) | tools-added-to-request, tool-block-accepted |
| request, header block, metadata, telemetry, logs | whole run | clean | clean | every test above; telemetry keys and codes in `S036 <M>` | egress-does-not-reread-envelope, egress-does-not-reread-exemplar-values |

Not exercised here (UNEXERCISED): journal durability (the harness uses `MemoryLedgerStore`), lease renewal (the fixture's manual ticker is never fired), a live provider HTTP adapter, a workbook with customer sheet names (Migration Core never passes them on).
