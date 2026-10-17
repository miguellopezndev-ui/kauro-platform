# Identidad jurídica del emisor de los informes — procedimiento para el dueño

Orden 6 (diseño: `docs/design/B13-report-inputs.md` §3). Este documento no contiene datos reales: dice qué datos faltan, quién los
aporta y cómo se incorporan sin reescribir nada ya aceptado. Ningún modelo ni persona del equipo de construcción llena estos datos.

## Estado hoy

- La plataforma ya sabe verificar al emisor: cada informe lee el emisor de un documento `KAURO_LEGAL_IDENTITY_V1` cuyo SHA-256 debe ser
  el `legal_identity_hash` del emisor fiscal que nombran los términos de la cotización aceptada.
- No hay ningún documento registrado. Por eso **todo informe se rechaza hoy con `ISSUER_UNAVAILABLE`**, y así debe seguir hasta que el
  dueño aporte los datos reales. No es un error: es la negativa segura.
- Tampoco hay versiones de marca registradas (CMD008 no está construido): los informes también se rechazan con `BRANDING_UNAVAILABLE`.

## Datos pendientes del dueño (lista exacta)

| campo del documento | qué es | fuente esperada | estado |
|---|---|---|---|
| `legalName` | razón social exacta | certificado de existencia y representación (Cámara de Comercio) | PENDIENTE |
| `entityType` | tipo societario (p. ej. S.A.S.) | mismo certificado | PENDIENTE |
| `jurisdiction` | código ISO 3166-1 alfa-2 del país de registro (`CO`) | mismo certificado | PENDIENTE (confirmar) |
| `taxId` | NIT con dígito de verificación, tal como lo emite la DIAN | RUT | PENDIENTE (LAWYER_LATER F-01) |
| `commercialRegistrationId` | número de matrícula mercantil | certificado de Cámara de Comercio | PENDIENTE |
| `registeredAddress` | domicilio registrado | RUT / certificado | PENDIENTE (LAWYER_LATER F-02) |
| confirmación profesional | que un asesor revisó los datos (`legal_fact_status = PROFESSIONALLY_CONFIRMED`, u `OBSERVED` si se verifican contra el registro público) | asesor legal o contable | PENDIENTE |

No se pide el nombre del representante legal: según la decisión D-16 se guarda fuera del repositorio y ningún informe lo imprime.

Reglas del documento: cada campo es un dato real, sin espacios sobrantes, sin marcadores (`[NIT]`, `REQUIRES_REVIEW`, `PENDING`, `TBD`…),
sin caracteres de control ni los signos menor que, mayor que, comillas dobles o simples, ampersand (&) o acento grave (el informe no
los imprime; si la razón social lleva alguno, hay que decidirlo antes, porque el modelo del informe los rechaza).

## Procedimiento (cuando existan los datos)

1. **El dueño entrega** los seis datos y el soporte (RUT, certificado) por el canal cifrado acordado; nunca por el repositorio.
2. **El operador construye el documento canónico** en una máquina de confianza, con el código ya incluido en la plataforma
   (`legalIdentityBytesOf` de `@kauro/domain`). La función rechaza cualquier dato incompleto o marcador. Resultado: los bytes del
   documento y su SHA-256.
3. **El operador lo registra** como plano de control (`kauro_control`): `PgLegalIdentitySnapshots.record(bytes)` de
   `@kauro/persistence`, o la sentencia equivalente; la base comprueba que la clave es exactamente el SHA-256 del documento
   (`legal_identity_snapshots_content_addressed`) y el registro no puede modificarse ni borrarse después.
4. **El operador registra el emisor fiscal real** (`kauro.fiscal_issuers`) con `legal_identity_hash` = ese SHA-256, la jurisdicción del
   documento y `legal_fact_status` según la revisión (`PROFESSIONALLY_CONFIRMED` u `OBSERVED`); la ruta de facturación se califica
   aparte (B15). Ese hash nunca cambia: si un dato se corrige, se registra **otro** documento y **otro** emisor; las cotizaciones ya
   emitidas conservan el emisor que nombraron sus términos.
5. **Los perfiles fiscales** de las agencias pasan a nombrar ese emisor (`operator_legal_ref`); solo las cotizaciones emitidas desde
   entonces lo llevan en sus términos.
6. **Verificación**: un informe de una cotización nueva imprime "Service provided by <razón social> (<jurisdicción>, <NIT>) under terms
   <versión>"; el de una cotización anterior sigue rechazándose, porque sus términos nombran un emisor sin documento — nunca se le
   asigna otro.

## Lo que este procedimiento no hace

- No reescribe términos aceptados, hashes históricos ni aceptaciones.
- No convierte la marca visible de una agencia en emisor.
- No declara listo para producción ningún informe: eso requiere además B14 (host del worker) y B15 (servicios externos).
