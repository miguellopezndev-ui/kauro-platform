# D-08b legal checklist

Checklist for Kauro's customer-facing legal texts (owner decision D-08b, option 1, 2026-10-05: drafted by the builder without a
lawyer, checked against official sources, adversarial review by Codex afterwards, owner's written acceptance before B19).

Files covered: `TERMS_OF_SERVICE.md` (ToS), `DATA_PROCESSING_POLICY.md` (POL), `PRIVACY_NOTICE.md` (AVISO), `DPA.md` /
`DPA_EN.md` (DPA), `LAWYER_LATER.md`. The rows are in English for the reviewer; the clauses they point to are in Spanish (and
English in DPA_EN). Every source below was consulted on **2026-10-06** unless stated otherwise.

Status values:
- **COVERED**: the obligation is met by the cited clause.
- **COVERED_IF_BUILT**: the clause is correct only if the build/configuration it describes is in place before activation; the
  activation check is named.
- **OPEN**: a non-text artifact or action is still missing; it blocks B19 activation until done.
- **N/A**: the norm does not apply to Kauro's actual scope; the reason is stated.
- **UNVERIFIED**: the official text could not be retrieved; the clause does not rely on it.

## 1. Colombia — personal data protection

| ID | Norm | Obligation | Where in the texts | Official source | Status |
|---|---|---|---|---|---|
| C-01 | Ley 1581 de 2012, arts. 3–4 | Use the statutory definitions and apply the eight principles | POL §3, §4; DPA §5(a) | [Secretaría del Senado, Ley 1581](http://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html); [Función Pública, norma 49981](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981) | COVERED |
| C-02 | Ley 1581, art. 2 | Scope: processing in Colombian territory. Kauro is a Colombian company directing processing from Colombia, so the law applies to it both as controller and as processor, even when the data subjects are US residents | POL §2; DPA §5, §10, §11.3 | Same as C-01 | COVERED (extent for foreign controllers' data: LAWYER_LATER L-02) |
| C-03 | Decreto 1377/2013 art. 13 = Decreto 1074/2015 art. 2.2.2.25.3.1 | Policy must state: (1) name, domicile, address, email **and phone**; (2) processing and purposes; (3) rights; (4) person/area for requests; (5) procedure; (6) effective date and database validity period; substantial changes communicated before implementation | POL §1 (1), §6 (2), §9 (3), §11 (4), §10 (5), §15 and §20 (6), §20 (changes) | [Decreto 1074 de 2015, Cap. 25 (Cancillería normograma, text compiled with modification notes)](https://cancilleria.gov.co/sites/default/files/Normograma/docs/pdf/decreto_1074_2015_pr025.pdf); [Función Pública, Decreto 1377, norma 53646](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=53646) | COVERED_IF_BUILT: phone needs owner fill-in F-05 |
| C-04 | Ley 1581 art. 9; Decreto 1074 art. 2.2.2.25.2.2 | Prior, express, informed authorization obtained at the latest at collection, stating the data and specific purposes | POL §8.1; AVISO | C-01, C-03 sources | COVERED_IF_BUILT: B11 onboarding and fit form must show the consent checkbox with links (activation check A-01) |
| C-05 | Decreto 1074 arts. 2.2.2.25.2.4–2.2.2.25.2.5 | Authorization by a consultable mechanism (writing, oral, unequivocal conduct; never silence) and keep proof | POL §8.1 | C-03 source | COVERED_IF_BUILT: consent record stored (A-01) |
| C-06 | Ley 1581 art. 10; Decreto 1074 art. 2.2.2.25.2.2 ¶2 | Cases without authorization; public-source data only if public by nature | POL §8.2, §6.3 | C-01, C-03 sources | COVERED, with residual question on B2B prospecting data: LAWYER_LATER L-03 |
| C-07 | Ley 1581 arts. 5, 6, 7; Decreto 1074 art. 2.2.2.25.2.3 | Sensitive data: optional answer, explicit consent, no conditioning; children's data proscribed | POL §7; AVISO; ToS §5.2; DPA Annex I.4 | C-01, C-03 sources | COVERED (Kauro collects none; customers are barred from uploading them) |
| C-08 | Ley 1581 arts. 8, 16 | List of data-subject rights; complaint to SIC only after the controller/processor procedure | POL §9; AVISO | C-01 source | COVERED |
| C-09 | Decreto 1074 art. 2.2.2.25.4.2 | Free access at least monthly and on substantial policy changes | POL §9(f) | [Decreto 1074 Cap. 25, sections 4–6 (Cancillería)](https://cancilleria.gov.co/sites/default/files/Normograma/docs/pdf/decreto_1074_2015_pr026.pdf) | COVERED |
| C-09b | Decreto 1074 art. 2.2.2.25.4.4 | Controller and processor designate a person or area for data protection | POL §11 | C-09 source | COVERED (legal representative; see silence S-14) |
| C-10 | Ley 1581 arts. 14, 15 | Queries: 10 business days + 5. Claims: completeness request in 5 days, withdrawal after 2 months, transfer in 2 business days if not competent, "reclamo en trámite" legend in 2 business days, 15 business days + 8 | POL §10.2, §10.3 | C-01 source | COVERED_IF_BUILT: requests handled by a recorded case (19 §Rights requests) (A-02) |
| C-11 | Decreto 1074 art. 2.2.2.25.2.6 | Revocation/suppression by claim; not when a legal or contractual duty to remain; free, easy mechanism | POL §10.4; ToS §19.4 | C-03 source | COVERED |
| C-12 | Ley 1581 art. 17 | Controller duties (a)–(o), incl. require security from processors (i), internal manual (k), report breaches (n) | POL §4, §13.3, §14, §18; DPA §4 (customer as controller) | C-01 source | COVERED in the texts; the internal manual is C-24 (OPEN) |
| C-13 | Ley 1581 art. 18 | Processor duties (a)–(l): security, timely updates, update within 5 business days, handle claims, internal manual, legends, restricted access, report breaches to SIC | DPA §5, §11.3, §12.2 | C-01 source | COVERED in the texts; internal manual is C-24 (OPEN) |
| C-14 | Ley 1581 arts. 17(n), 18(k) | Report security-code violations to the SIC | DPA §11.3; POL §18 | C-01 source | COVERED |
| C-15 | SIC Circular Única, Título V, numeral 2.1 lit. f(ii) | Controllers not obliged to the RNBD **and processors** report incidents through the SIC application or channels within **15 business days** of detection | DPA §11.3; POL §18 | [SIC, Título V versión 29-09-2022](https://www.sic.gov.co/sites/default/files/normatividad/092022/T%C3%ADtulo%20V%20Versi%C3%B3n%2029-09-2022.pdf) | COVERED (pending 2026 draft does not change this numeral, see §6) |
| C-16 | Decreto 1074 art. 2.2.2.26.1.2, modified by Decreto 090 de 2018 | RNBD registration only for companies with total assets **above 100,000 UVT** (and public entities). UVT 2026 = COP 52,374 (DIAN Res. 000238 de 2025), so the threshold is COP 5,237,400,000. A newly incorporated S.A.S. is far below it: **registration is not required** | POL §19 | C-09 source (pr026, art. 2.2.2.26.1.2 with Decreto 90 note); [DIAN, valores 2026 (UVT $52.374)](https://www.dian.gov.co/aduanas/Documents/Cuadro-Valores-Patrimonio-Garantias-UA-2026.pdf) | N/A today (re-check yearly against the balance sheet) |
| C-17 | Ley 1581 art. 15 num. 1; art. 18(e) | A processor that receives a claim it cannot resolve transfers it within 2 business days and informs the requester | DPA §12.2; POL §12.2 | C-01 source | COVERED |
| C-18 | Decreto 1074 arts. 2.2.2.25.3.2–2.2.2.25.3.4 | Privacy notice with minimum content (identity/contact, processing and purpose, rights, how to access the policy; sensitive data optional); keep the notice model | AVISO | C-03 source | COVERED_IF_BUILT: notice shown at collection and its versions kept (A-01) |
| C-19 | Ley 1581 art. 12 | Duty to inform the data subject at collection | AVISO; POL §6 | C-01 source | COVERED |
| C-20 | Decreto 1074 art. 2.2.2.25.5.1 | International **transmission** controller→processor needs no notice or consent when a transmission contract exists | DPA §10.1; POL §3, §13.3 | C-09 source | COVERED |
| C-21 | Decreto 1074 art. 2.2.2.25.5.2 | Transmission contract states scope, activities and processor duties; processor applies controller's policy and purposes, (1) principles, (2) security, (3) confidentiality | DPA preamble, §3, §5, §6, §7, Annex I | C-09 source | COVERED for Kauro↔customer. Kauro↔AWS/Resend/Google rely on the providers' standard DPAs: LAWYER_LATER L-01 |
| C-22 | Ley 1581 art. 26; SIC Circular Única Título V cap. 3 numeral 3.2 | Transfers only to adequate countries; the **United States of America is on the SIC list** | DPA §10.2; POL §13.3; AVISO | [SIC, Circular Externa 005 de 2017 (adds cap. 3 to Título V)](https://www.sic.gov.co/sites/default/files/normatividad/072017/Transferencia-internacional-de-datos-PFR2.pdf); [SIC sede electrónica, ficha de la norma](https://sedeelectronica.sic.gov.co/transparencia/normativa/adicionar-un-capitulo-tercero-al-titulo-v-de-la-circular-unica-transferencia-de-datos-personales-terceros-paises); C-15 source | COVERED |
| C-23 | Título V cap. 3 numeral 3.2, parágrafo primero | Even toward adequate countries, the controller must demonstrate appropriate and effective measures | DPA §10.2, Annex II | C-22 sources | COVERED |
| C-24 | Ley 1581 arts. 17(k), 18(f); Decreto 1074 arts. 2.2.2.25.6.1–2.2.2.25.6.2 | Internal manual of policies and procedures; demonstrated accountability proportional to size | Referenced in DPA §5(f) | C-09 source | **OPEN**: the internal manual (request handling, incident, retention, access) is not a customer text and does not exist yet; B19 activation item A-03 |
| C-25 | Decreto 1074 art. 2.2.2.25.2.8 | Keep data only as long as reasonable and necessary; documented retention and deletion procedures | POL §15; ToS §13; DPA §13, Annex IV | C-03 source | COVERED (procedures exist in authority 09; owner-set periods for own data, see S-13) |
| C-26 | Decreto 1074 art. 2.2.2.25.2.2 ¶3 | Communicate substantial policy changes before implementing; new authorization if the purpose changes | POL §20; AVISO | C-03 source | COVERED |
| C-27 | SIC Circular Externa 002 de 2024 (21-ago-2024), AI guidelines | Before processing personal data with AI, a privacy impact assessment (description of operations, risk assessment, mitigation measures); processors that use AI do it jointly with the controller | DPA §12.3 (assistance), Annex I.2.4, Annex II (model row) | [SIC, Circular Externa 002 de 2024](https://sedeelectronica.sic.gov.co/sites/default/files/normativa/Circular%20Externa%20No.%20002%20del%2021%20de%20agosto%20de%202024.pdf) | **OPEN**: a written privacy impact assessment of the Bedrock step (minimized L0–L2 context) is needed before activation; item A-04. The texts do not claim it exists |
| C-28 | Decreto 255 de 2022 (binding corporate rules) | Only for groups using BCRs | — | Noted as modification on the Función Pública page of Ley 1581 (C-01) | N/A (no corporate group) |
| C-29 | Ley 1266 de 2008 / Ley 2157 de 2021 / Ley 2573 de 2026 (financial habeas data) | Credit-reporting regime | — | C-01 (art. 2(e) excludes these databases); SIC draft resolution 2026 (§6) | N/A (Kauro is not a source, operator or user of credit information) |

## 2. Colombia — electronic contracting, civil and commercial law, consumer law, tax

| ID | Norm | Obligation / effect | Where | Official source | Status |
|---|---|---|---|---|---|
| C-30 | Ley 527 de 1999 arts. 5, 6 | Data messages have legal effect and satisfy "in writing" if accessible later | ToS §6.3 | [Secretaría del Senado, Ley 527](http://www.secretariasenado.gov.co/senado/basedoc/ley_0527_1999.html); [Función Pública, norma 4276](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=4276) | COVERED |
| C-31 | Ley 527 arts. 14, 15 | Offer and acceptance by data message are valid | ToS §6.3 | C-30 sources | COVERED |
| C-32 | Ley 527 art. 24 | Time of receipt = entry into the designated information system | ToS §23.1 | C-30 sources | COVERED |
| C-33 | Decreto 2364 de 2012 (electronic signature) arts. 3, 5 | An electronic signature reliable and appropriate to the circumstances (incl. agreement) satisfies the signature requirement | ToS §6.3 (acceptance by an authenticated, MFA-verified user, recorded durably) | [Función Pública, Decreto 2364 de 2012, norma 50583](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=50583) | COVERED_IF_BUILT: acceptance record with user, version, time (A-01) |
| C-34 | Código de Comercio arts. 824, 845, 846, 864 | Merchants contract by any unequivocal means; an offer with its essential elements is irrevocable once communicated; contract is formed at the offeror's residence when acceptance is received | ToS §6.1–§6.3 (the Quote is Kauro's offer, valid 14 days) | [Función Pública, Código de Comercio, norma 41102](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=41102) | COVERED |
| C-35 | Código Civil arts. 63, 1522, 1616 | Gross negligence equals fraud in civil matters; waiving future fraud is void; absent fraud, liability only for foreseeable damages, and parties may modify these rules | ToS §18 (cap with carve-outs for fraud and gross negligence) | Secretaría del Senado, Código Civil: [art. 63 (pr001)](http://www.secretariasenado.gov.co/senado/basedoc/codigo_civil_pr001.html), [art. 1522 (pr046)](http://www.secretariasenado.gov.co/senado/basedoc/codigo_civil_pr046.html), [art. 1616 (pr049)](http://www.secretariasenado.gov.co/senado/basedoc/codigo_civil_pr049.html) | COVERED; enforceability of the cap amount: LAWYER_LATER L-04 |
| C-36 | Ley 1480 de 2011 art. 5 num. 3 (consumer definition) | A legal person is a consumer only when it acquires as final user for a need **not intrinsically linked to its economic activity**. Agencies buying data preparation for their clients' projects are not consumers. An **in-house team's company** might be, depending on its activity | ToS §17.2, §11.3, §22.3 ("derechos irrenunciables") | [Función Pública, Ley 1480, norma 44306](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=44306) | COVERED for agencies; in-house buyers: LAWYER_LATER L-06 |
| C-37 | Ley 1480 arts. 7, 42–43, 47, 50, 51 (arts. 47 and 50 modified by Ley 2439 de 2024) | If a buyer is a consumer: legal warranty, abusive clauses void, 5-business-day withdrawal for distance sales (not for services already begun with consent), e-commerce information duties, payment reversal | ToS §10.1 (full refund before processing), §11 (remedy), §17.2, §18.3(c) | C-36 source | COVERED_IF_BUILT for the information duties (identity, price, terms shown before purchase — B11 checkout, A-05); scope question in L-06 |
| C-38 | Código de Comercio art. 60 | Keep books and commercial papers at least ten years | POL §15; ToS §19.4 | C-34 source | COVERED |
| C-40 | Resolución DIAN 000165 de 2023 (modified by Res. 119/2024, 189/2024, 202/2025, 227/2025) | Electronic sales invoice validated by DIAN before delivery to the buyer | ToS §7.5; POL §6.2, §13.1 | [DIAN normograma, Resolución 165 de 2023](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0165_2023.htm) | COVERED_IF_BUILT: invoicing route (Alegra or DIAN free tool) habilitated before the first sale (owner action, 15 §Accounting integration decision) |
| C-41 | Estatuto Tributario art. 481 lit. c; DIAN Concepto 5846 de 2024 (26-ago-2024) | VAT exemption for exported services requires use exclusively abroad by a foreign contracting party, RUT registration as exporter, documentation | ToS §7.5 (tax shown in the Quote per the validated treatment; no promise of exemption) | [DIAN normograma, oficio 5846 de 2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_5846_2024.htm) | COVERED as a neutral clause; the treatment itself is LAWYER_LATER L-07 (accountant) |

## 3. Marketing communications

| ID | Norm | Obligation | Where | Official source | Status |
|---|---|---|---|---|---|
| C-50 | US CAN-SPAM Act (FTC guide) | Applies to B2B email: truthful headers and subject, ad identification, valid postal address, opt-out honored within 10 business days, responsibility for vendors | POL §17; ToS §20.2 | [FTC, CAN-SPAM Act: A Compliance Guide for Business](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) | COVERED_IF_BUILT: postal address = [domicilio]; suppression registry (reference/MESSAGING_AND_SENDER_OPERATIONS.md) |
| C-51 | Ley 2300 de 2023 arts. 3, 5 (in force 10-oct-2023) | Commercial SMS/email/calls to consumers only Mon–Fri 7:00–19:00 and Sat 8:00–15:00, no Sundays/holidays; easy opt-out; consumer cannot be forced to accept marketing. Collection-contact rules (arts. 1–4, 6) do not apply: Kauro charges before work and does not run debt collection | POL §17 | [Secretaría del Senado, Ley 2300 de 2023](http://www.secretariasenado.gov.co/senado/basedoc/ley_2300_2023.html) | COVERED (applied to all Colombian recipients, conservatively) |

## 4. United States — what the agency (controller) needs from a processor

The DPA is written so that a US agency subject to a state privacy law gets the contract terms that law requires. Kauro does not
determine whether a given agency meets a state law's thresholds; the terms are offered to all customers.

| ID | Norm | Obligation the controller needs in the contract | Where (DPA / DPA_EN) | Official source | Status |
|---|---|---|---|---|---|
| C-60 | Cal. Civ. Code §1798.100(d)(1)–(5) | (1) limited, specified purposes; (2) processor complies with the CCPA and gives the same level of protection; (3) business may take reasonable steps to ensure consistent use; (4) processor notifies if it can no longer comply; (5) business may stop and remediate unauthorized use | §14.1, §14.2(a)–(d), §15, Annex I.3 | [CPPA, CCPA statute effective 01-01-2026 (AB 137, AB 566 update)](https://cppa.ca.gov/pdf/20260101_ccpa_statute.pdf) | COVERED |
| C-61 | Cal. Civ. Code §1798.140(ag)(1)(A)–(D) | Contract prohibits: selling/sharing; retaining/using/disclosing beyond the specified business purposes; outside the direct business relationship; combining with other personal information. Contract may allow monitoring/assessments at least every 12 months | §3.3, §15 | C-60 source | COVERED |
| C-62 | 11 CCR §7051(a)(1)–(9) | Same prohibitions; **specific** (not generic) business purposes; comply with CCPA incl. reasonable security (§1798.81.5); reasonable steps incl. assessments; notice if unable to comply; stop/remediate incl. proof of deletion; enable compliance with consumer requests | §3.3, §5(i), §7, §12, §14.2, §15, Annex I.3 (purposes listed specifically) | [CPPA, CCPA regulations effective 01-01-2026](https://cppa.ca.gov/regulations/pdf/ccpa_statute_eff_20260101.pdf) | COVERED |
| C-62b | 11 CCR §7050(a)(3)–(5) | Permitted internal uses of a service provider (security/fraud, legal compliance, building or improving its own service without serving others) | §14.3 (security and legal compliance only); §3.4 (no derivatives without written authorization, stricter than §7050(a)(3)) | C-62 source | COVERED |
| C-63 | Cal. Civ. Code §1798.140(ag)(2); 11 CCR §7051(b) | Notify the business of sub-processors; bind them by written contract with the same requirements | §8.1, §8.2, Annex III | C-60, C-62 sources | COVERED_IF_BUILT: the AWS and Resend contracts must contain equivalent terms (AWS DPA in Service Terms; Resend DPA) — LAWYER_LATER L-01 |
| C-64 | Va. Code §59.1-579 B.1, D; C.R.S. 6-1-1305(3)(a), (7) | Duty of confidentiality for every person processing; role is a fact-based determination (a processor that leaves instructions becomes a controller) | §6, §3.1–§3.3, §14.1 | C-65, C-66 sources | COVERED |
| C-65 | Va. Code §59.1-579 (VCDPA) A–C | Follow instructions; assist with consumer requests, security and breach notice, data-protection assessments; contract sets instructions, nature, purpose, data types, duration, rights and duties; confidentiality; delete or return at the end; provide compliance information; allow reasonable assessments or independent audit; subcontractors by written contract **after giving the controller an opportunity to object**; no relief from role liability | §3, §8.2 (30-day notice and objection), §11.2, §12.3, §13, §14.4, §15, Annex I | [Code of Virginia §59.1-579 (law.lis.virginia.gov)](https://law.lis.virginia.gov/vacode/title59.1/chapter53/section59.1-579/) | COVERED |
| C-66 | C.R.S. 6-1-1305 (Colorado Privacy Act, SB21-190 as enacted) | Same as C-65 plus: security appropriate to risk with clear allocation; delete or return at controller's choice; audits, or with consent an annual independent audit at processor's expense with report | §7, §8.2, §13, §15.2, Annex II | [Colorado General Assembly, SB21-190 signed act](https://leg.colorado.gov/bill_files/54661/download) | COVERED (later amendments to 6-1-1305 not checked: LAWYER_LATER L-08) |
| C-67 | Cal. Civ. Code §1798.82(b) and other state breach statutes (processor → owner notice) | A person maintaining data it does not own must notify the owner of a breach promptly | DPA §11.1 (72 h) | leginfo.legislature.ca.gov refused automated access (HTTP 403) on 2026-10-06 | UNVERIFIED; DPA §11.1 does not cite it and is stricter than "without unreasonable delay" |
| C-70 | EU GDPR / UK GDPR | Processor terms and transfer instruments for EU/UK data | ToS §5.5 (not offered in this version; such data needs prior evaluation) | [EUR-Lex, Regulation 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng) (cited by authority 19) | N/A by scope; see LAWYER_LATER L-09 |

## 5. Facts about providers used in the texts (vendor official pages)

| ID | Fact | Where used | Source | Consulted |
|---|---|---|---|---|
| V-01 | The AWS Data Processing Addendum is incorporated into the AWS Service Terms and applies automatically when AWS processes customer data; AWS processes per customer instructions and notifies incidents without undue delay | DPA §8.1, Annex III | [AWS GDPR DPA (AWS Security Blog)](https://aws.amazon.com/blogs/security/aws-gdpr-data-processing-addendum/); [AWS Service Terms](https://aws.amazon.com/service-terms/) | 2026-10-06 |
| V-02 | Bedrock: model providers have no access to Bedrock model deployment accounts, logs, prompts or completions | DPA Annex II, ToS §3.6 | [Amazon Bedrock, Data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html) | 2026-10-06 |
| V-03 | Bedrock retention is configurable (`none` = zero retention); some models (currently Claude Fable 5 / 5.1) require up to 30 days retention and possible AWS human review; geographic inference profiles keep processing inside the geography (e.g. US), global profiles do not | DPA §9, Annex II (Kauro commits to zero retention, no models requiring retention, no global profiles) | [Bedrock data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html); [Bedrock abuse detection](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html); [Bedrock cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html) | 2026-10-06 |
| V-04 | Since 2023-01-05 every new S3 object is encrypted at rest with SSE-S3 by default and this cannot be disabled | DPA Annex II (storage row) | [Amazon S3 default encryption FAQ](https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-encryption-faq.html) | 2026-10-06 |
| V-05 | Resend acts as processor; primary processing in the United States (DPA updated 2025-12-31) | DPA Annex III; POL §13.1 | [Resend DPA](https://resend.com/legal/dpa) | 2026-10-06 |
| V-06 | PayPal's privacy notice names the PayPal entity of the user's jurisdiction as controller of the payment data it processes | DPA §8.3; POL §13.2 | [PayPal Colombia, Aviso de Privacidad](https://www.paypal.com/co/legalhub/paypal/privacy-full) | 2026-10-06 |
| V-07 | Wise group companies act as controllers of the data of their customers, payers and recipients | DPA §8.3; POL §13.2 | [Wise, Business Customer Privacy Policy](https://wise.com/gb/legal/privacy-notice-business-en) | 2026-10-06 |
| V-08 | AWS: the customer chooses the Region where content is stored; AWS does not move it outside the chosen Region except as necessary to provide the service or to comply with law | DPA §9 | [AWS Data Privacy FAQ](https://aws.amazon.com/compliance/data-privacy-faq/) | 2026-10-06 |

## 6. Currency check: norms modified or pending

- **Decreto 1377 de 2013**: compiled in Decreto 1074 de 2015, Cap. 25 (articles cited by their 2.2.2.25.x numbers above);
  partially repealed by Decreto 1081 de 2015 (Función Pública note). The cited articles appear in the compiled text in force.
- **Decreto 886 de 2014 / RNBD**: compiled in Decreto 1074 Cap. 26; arts. 2.2.2.26.1.2 and 2.2.2.26.3.1 **modified by Decreto
  090 de 2018** (100,000 UVT threshold).
- **Ley 1581 de 2012**: regulated by Decretos 1377/2013, 886/2014, 1081/2015 and 255/2022 (Función Pública notes); text in force.
- **Ley 1480 de 2011**: arts. 5 num. 18, 45 num. 3, 47 and 50 **modified by Ley 2439 de 2024** (Función Pública note).
- **CCPA**: statute and regulations as **effective 2026-01-01** (AB 137, AB 566 update) used; the July-2024 version was also read
  and the cited subdivisions §1798.100(d) and §1798.140(ag) are unchanged between the two.
- **Colorado Privacy Act**: only the 2021 enacted text was read; later amendments (2023–2025) to 6-1-1305 are not verified.
- **SIC pending change**: a draft resolution published 2026-05-26 (comments until 2026-06-10) modifies Título V of the Circular
  Única: RNBD registration within three months after the financial statements show 100,000 UVT, annual RNBD updates from 2027,
  and adds Australia, Brazil, Ecuador, Japan, Kenya, Panama and South Africa to the adequate-country list. **The United States
  stays on the list.** It does not change the incident-reporting numeral used in C-15. No final resolution was found on
  2026-10-06. Source: [SIC, proyecto de resolución Título V](https://sedeelectronica.sic.gov.co/transparencia/normativa/proyecto-de-resolucion-por-la-cual-se-modifica-el-titulo-v-de-la-circular-unica-de-la-superintendencia-de-industria-y).
- **Resolución DIAN 165 de 2023**: modified by Res. 119/2024, 189/2024, 202/2025 and 227/2025 (DIAN normograma).

## 7. Activation checks the texts depend on (for B19)

| ID | What must be true before the texts go live | Owner of the check |
|---|---|---|
| A-01 | Onboarding and fit form show consent with links to POL and AVISO, store user, document version and time of acceptance of ToS, DPA and POL; DPA chain (agency–end client or two-party) recorded per end client (R2-111) | B11 / B19 |
| A-02 | Data-subject requests recorded as cases with type, received date, statutory deadline, verification, response (19 §Rights requests) | B12 / B19 |
| A-03 | Internal manual of personal-data policies and procedures (C-24) | builder, before B19 |
| A-04 | Written privacy impact assessment of the model step (C-27) | builder, before B19 / B04 live |
| A-05 | Checkout shows identity, total price with taxes, Quote terms and these documents before payment (C-37) | B11 / B19 |
| A-06 | AWS Region(s) bound in IaC are US Regions; Bedrock called in a US Region or US geographic profile, account retention mode `none`, invocation logging off, no model requiring retention (DPA §9, Annex II) | B14 / B04 |
| A-07 | Contracts with AWS (Service Terms + DPA), Resend (DPA) and Google Workspace accepted under the company and filed | owner / B19 |
| A-08 | Owner fill-ins F-01..F-05 completed and effective date set | owner |

## 8. Silences and contradictions in the authority, with the resolution used

| ID | Point | Authority | Resolution in the texts |
|---|---|---|---|
| S-01 | AWS Region and Bedrock routing not fixed | 14 §Initial architecture names GCP us-central1/us-east4 (superseded by A9); A9 §4 says "verify region, effective routing" without naming one | Texts state US Regions and US-only inference (DPA §9). B14/B04 must bind it (A-06); a non-US choice requires changing DPA §9 and notice under §8.2 |
| S-02 | No numeric deadline for breach notice to the customer | 19 §Incident and breach obligations and 18 §Incident communication defer to "applicable deadlines" | 72 hours from confirmation, initial notice with known facts (DPA §11.1); SIC report within 15 business days (C-15) |
| S-03 | Liability cap and forum left to "the named reviewer" | 19 §Service terms says these "block legal execution until the named reviewer completes the profile"; D-08b option 1 removed the reviewer | Cap = fees paid in the prior 12 months, with carve-outs for fraud, gross negligence, price, non-waivable rights and role liability (ToS §18); Colombian law and courts of Kauro's domicile (ToS §22). Listed in LAWYER_LATER L-04, L-05 |
| S-04 | Subprocessor register in 19 names Google Cloud | 19 §Subprocessor register vs A9 §1 | A9 governs: AWS; Google Cloud stated as not used in production (DPA Annex III) |
| S-05 | Fiscal provider not chosen | 15 §Accounting integration decision: Alegra candidate or DIAN manual route | Policy names "the e-invoicing provider Kauro uses before the DIAN" generically; the DPA states it receives billing data only (not Customer Data) |
| S-06 | EU/UK data subjects in uploaded CRMs | 02 §Buyer ("expansion to other markets is a capability change"); 19 §DPA (GDPR depends on roles) | Not offered in this version; such data needs prior evaluation (ToS §5.5). LAWYER_LATER L-09 |
| S-07 | Subprocessor change notice period and objection | 19 §Subprocessor register: "customer notice where applicable" | 30 days' notice, objection on data-protection grounds, termination with refund of unexecuted Orders (DPA §8.2), as VA/CO require an opportunity to object |
| S-08 | Refund amount after processing has started and the customer cancels | 15 §Refund policy covers before-processing and defects only; 16 §Scope changes says "credited or refunded ... where appropriate" | Good-faith assessment by recorded phase with written decision, credit or refund, no penalty (ToS §10.2). A numeric rule is a future pricing-policy decision |
| S-09 | Who bears sender-side bank/AP fees for ACH | A8 §3 "order paid only on a reconciled credit of the exact amount"; 15 "only explicitly disclosed permitted charges" | Customer bears its own sending fees; Kauro bears receiving and processing fees (ToS §8.2) |
| S-10 | Notice periods for termination by Kauro | 16 §Agency lifecycle describes closure duties only | 30 days without cause; immediate after 10 business days' uncured material breach (ToS §19.3) |
| S-11 | "Return" of data at end of service | 19 §DPA requires return/deletion; 09 has no return export | Return = availability of the Package download before deletion; source files are not returned (ToS §13.3; DPA §13.1) |
| S-12 | Who approves "non-personal synthetic derivatives" of customer data | 09 §Retention schedule "separately approved"; 06 §Scoped memory | Only with the customer's written authorization per project, stripped of personal and confidential data (DPA §3.4) |
| S-13 | Retention of Kauro's own (controller) data: accounts, prospects, form leads, requests | 09 covers CRM, logs, security and financial classes only | 6 months after account closure; prospects 24 months without interaction or until opt-out; leads 12 months; requests 5 years; financial ≥ 10 years (POL §15). Owner may change; LAWYER_LATER L-10 |
| S-14 | Data-protection officer / area | Not named | Legal representative (POL §11) |
| S-15 | Website analytics and cookies | 01 CH-006 mentions analytics with minimum facts; 08 only session cookies; B11 design: session cookie only, Next.js telemetry off | Policy states only a strictly necessary session cookie and no third-party advertising/tracking cookies (POL §16); adding analytics requires updating POL first |
| S-16 | Language | D54: product copy is English; D-08b asks for Spanish texts plus an English DPA | Spanish texts prevail except the DPA (EN and ES equal). US customers accept English UI; English versions of ToS and POL are needed before the first US customer: LAWYER_LATER L-11 |
| S-17 | Mandatory phone number in the policy vs the four allowed placeholders | Decreto 1074 art. 2.2.2.25.3.1 num. 1 requires a phone | Added a fifth placeholder [teléfono], listed as owner fill-in F-05 |
| S-18 | Colombian customers' COP route | A8 §2 rule 6 says "their own route" without naming it | ToS §7.4: "por la ruta que Kauro indique en su Cotización" |

## 9. Count

Obligation rows: 53 (C-01..C-70 in sections 1–4, counting C-09b and C-62b).

| Status | Rows |
|---|---|
| COVERED | 36 |
| COVERED_IF_BUILT | 10 |
| OPEN | 2 (C-24 internal manual, C-27 AI impact assessment) |
| N/A | 4 (C-16 RNBD, C-28, C-29, C-70) |
| UNVERIFIED | 1 (C-67) |

The texts cover 46 of the 48 applicable obligations (COVERED + COVERED_IF_BUILT; applicable = 53 minus 4 N/A minus 1
UNVERIFIED). The two OPEN rows are internal artifacts, not clauses, and block activation until done. Several COVERED rows also
carry a residual LAWYER_LATER question, noted in the row.
