# Legal V1 delta (Payments V1 + D-19), on 0792dc9

Spec: PAYMENTS-V1-REPLAN §8; owner decision 2026-10-07-PAYMENTS-V1; D-19 TODO. Texts stay Spanish (DPA_EN English). No personal data, placeholders kept.

| # | File : section | Before -> after | Reason |
|---|---|---|---|
| 1 | TERMS_OF_SERVICE 8.1 | two means ("Transferencia bancaria en EE. UU. / ACH ... en Wise" + "PayPal / tarjeta") -> one means "cuando esté habilitada": "transferencia bancaria en EE. UU. (ACH o transferencia doméstica a los mismos datos)"; Kauro may not offer it; no card or other means; Wise no longer named | PayPal parked; wire = same USD details; no unconditional ACH claim; name only launch rails |
| 2 | TERMS 8.1 auth comment | A8 refs only -> adds Payments V1 reference | traceability |
| 3 | TERMS 8.2 | paid on provider capture (PayPal) or reconciled credit (ACH) -> paid only on a reconciled incoming credit with bank evidence, exact amount and currency; a credit confirmed after Order expiry follows the Quote expiry rules (s.6), else returned | PayPal removed; DV1-06 late rule; no new promise beyond returning |
| 4 | TERMS 8.3 | "falla ... no produce un segundo cobro" -> "Kauro no pide un segundo pago mientras un pago enviado no esté conciliado" | mandate wording |
| 5 | TERMS 10.4 | "los de ACH, como transferencia saliente" -> "los de transferencia bancaria, ... cuando la ejecución real esté comprobada" | D-ACH-21 / PV1 §4: never "refunded" without execution evidence; no ACH-specific claim |
| 6 | TERMS 25.7 | added: Platform offers no card payment today (8.1); section states the legal right and applies only if such a payment ever exists | consumer sections coherent with no enabled consumer route |
| 7 | TERMS 13.4 | added: "Una copia eliminada puede persistir unos días tras el borrado en el almacenamiento del proveedor, hasta su expiración automática; Kauro no la usa ni la restaura" | D-19; never promise 1 day |
| 8 | DATA_PROCESSING_POLICY 6.2 (l.78-79) | "no recibe ni guarda números completos de tarjetas: el pago con tarjeta se hace en PayPal" -> "no recibe ni guarda números de tarjeta" | PayPal removed |
| 9 | DATA_PROCESSING_POLICY 13.2 (l.241) | "a PayPal y a Wise" -> "a Wise" (Bancolombia, DIAN unchanged) | PayPal removed |
| 10 | DPA 8.3 / Anexo III list | "(PayPal, Wise)" -> "El proveedor de pagos (Wise)"; "PayPal y Wise (responsables independientes)" -> "Wise (responsable independiente)" | PayPal removed |
| 11 | DPA_EN 8.3 / Annex III list | same in English: "The payment provider (Wise)"; "Wise (independent controller ...)" | PayPal removed |
| 12 | DPA 13.2 and DPA_EN 13.2 | added the D-19 sentence (ES / EN) | D-19 |
| 13 | INTERNAL_DATA_MANUAL l.54, l.263 | PayPal removed from independent controllers and MFA list | PayPal removed |
| 14 | CHECKLIST V-06 | marked SUPERSEDED (Payments V1), row kept; V-07 (Wise controller) unchanged | PayPal parked, not deleted |
| 15 | CHECKLIST A-20 (new, section 7) | activation check: measure noncurrent-version expiry lag in the real account; texts' wording holds only if the lag is within a few days, else state the AWS-documented maximum or fix lifecycle; never promise 1 day | D-19 |

Not changed (checked): PRIVACY_NOTICE, PIA_BEDROCK, LAWYER_LATER (no PayPal/ACH wording); CHECKLIST S-09 (sender-side fees, rail-neutral); ToS Annex A.
Ambiguities: DV1-06 text is not in the repo; row 3 uses the mandate's summary only (honor at same price per quote expiry rules, else return). Row 7/12 wording "unos días" is final only after A-20 measures the lag.

## Round 2 (Codex REJECT F-01 MAJOR, F-02 MINOR; owner Addendum)
| # | File : section | Before -> after | Reason |
|---|---|---|---|
| 16 | TERMS 8.2 (replaces row 3) | summary sentence -> the seven DV1-06 safeguards inline (exact USD credit received + bank evidence; deadline and "enviar antes de", no bank-timing guarantee; bank booking time within the tolerance in the instructions; on-time honoured at same price if files/source, target, legal/fiscal treatment, scope valid and no other open/paid purchase; else not started, recorded and returned per s.10, new Quote; partial/over/other reference/payer under review and returned, no top-up; no second payment request). Source: dv1-06-for-legal.md (r8, 97b5bb8); no tolerance number, no new promise. Fee sentence kept as closing paragraph | F-01 |
| 17 | TERMS 8.1 (amends row 1) | "la Plataforma ofrece ... cuando esté habilitada" -> "el único medio previsto es ...; Kauro no cobra ni acepta pagos por esta vía hasta que la ruta esté habilitada; solo se muestra cuando esté habilitada" | Owner Addendum: no implication of collecting before ENABLED |
| 18 | CHECKLIST A-20 | added "Deadline: during the real-account qualification, before the deletion texts (ToS 13.4, DPA 13.2) are published" | F-02 |
Note: 3.1 "cobra el precio acordado" describes the service flow and was left; flag if Codex wants it conditional.
