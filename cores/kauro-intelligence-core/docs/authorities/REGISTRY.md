# Authorities

The documents this repository is built against, by SHA-256 of the bytes read
on 2026-09-11. They are not vendored: they live with the owner, and a claim in
this tree that cites one cites this digest.

| authority | sha256 |
| --- | --- |
| KAURO_PRODUCT_CONSTITUTION_V1.md | 203558d9c9b2310088e48209144d2fd71b6cf11b2ed678d2dec1607cd62454cb |
| KAURO_INTELLIGENCE_CORE_CANONICO_V1.md | 7463c7bffa0c98a3cefd48fd7b58a1ddc21c7c26386ba5f3278712e08b609c32 |
| KAURO_INTELLIGENCE_CORE_HOJA_DE_RUTA_CIERRE_V1.md | 0df486f26dea0339418a31e566c98a716a20cacbad2281a56044ca759f9b8920 |
| KAURO_MIGRATION_CORE_CANONICO_V1.md | 18dab3a3be5001928416b6f22d65bfbd88ab50a42bd5b910bd270f5e20ce98b8 |
| KAURO_MC3_RECUPERACION_E_IC1_PROMPT_V2.md | 13da9c309371d1f0d2776cc4de4ff596f954f54a2d23c1e63aee23c2fd277af8 |

Precedence, from the Intelligence canon §0: Constitution; the Intelligence
canon; the Migration Core canon for the frozen contracts consumed here; the
handoff in force; the roadmap; versioned repository contracts; implementation;
history.

## The frozen Migration Core this repository consumes

| fact | value |
| --- | --- |
| repository | miguellopezndev-ui/kauro-migration-core (renamed by the owner, amendment A2) |
| commit | a2a549031de85d95be8645dd9c5156dfff2050a0 |
| tag | v2.0.1 (annotated) |
| release | 387057468, published 2026-09-11, immutable |
| package | release asset 557300441 (file and npm name in `vendor/MANIFEST.json`), sha256 787f0b80a906d31605e3946ad00df86d2a131e3e89d78855c1c4f327b37fa000 |
| core / package format | 2.0.1 / 2.0.0 |
| freeze verdict | all four flags TRUE, decided 2026-09-11T13:26:04Z against the published release |

The digest above comes from the release dossier's delivery manifest as
verified by the freeze verdict, not from hashing whatever file is on disk.
