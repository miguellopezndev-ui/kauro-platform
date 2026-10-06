<!--
D-08b · Estudio de impacto de privacidad del paso de propuesta con modelo de lenguaje en Amazon Bedrock (SIC, Circular Externa
002 de 2024, instrucción IV, literales a–c). Documento INTERNO de Kauro; el Cliente puede pedirlo para su propia evaluación (DPA
§12.3). Borrador del constructor sin abogado (decisión D-08b, opción 1).
Trazabilidad: `auth:` = authority/r2; `law:` = fila de CHECKLIST.md; `ic:` = Intelligence Core, repositorio
kauro-intelligence-core, commit b819658 de la rama ic/b04-integrate (el minimizador y el clasificador, política de
enmascaramiento 1.4.0, están también en main b3d0cc6; el transporte Bedrock solo está en la rama: CHECKLIST A-12). Fuentes
oficiales consultadas el 2026-10-06 (CHECKLIST C-27 y V-02, V-03, V-09, V-10).
-->

# Estudio de impacto de privacidad: propuesta asistida por modelo en Amazon Bedrock

**Versión:** 1.0 · **Fecha del estudio:** 2026-10-06 · **Responsable del estudio:** el representante legal de Kauro Data S.A.S.
(oficial de protección de datos, INTERNAL_DATA_MANUAL §3) · **Estado:** pendiente de firma (sección 9)

## 0. Por qué se hace y con qué estructura

La Circular Externa 002 de 2024 de la SIC exige, antes del diseño y desarrollo de la IA y en la medida en que sea probable un alto
riesgo para los titulares, efectuar y documentar un estudio de impacto de privacidad con, como mínimo: (a) una descripción
detallada de las operaciones de tratamiento; (b) una evaluación de los riesgos específicos para los derechos y libertades de los
titulares, con su identificación y clasificación; y (c) las medidas previstas para evitar que se materialicen. La misma circular
pide ponderar idoneidad, necesidad, razonabilidad y proporcionalidad (instrucción I), abstenerse o adoptar medidas precautorias
ante la incertidumbre sobre daños graves (II), administrar los riesgos (III), tratar datos veraces y completos (V), privacidad
desde el diseño (VI), informar al titular (VII) y medidas de seguridad auditables (VIII). Las instrucciones se dirigen a los
"Administradores de Datos personales", que según su nota 2 incluyen a los **responsables y a los encargados** del tratamiento.

Kauro concluye en la sección 7 que el riesgo residual es bajo, de modo que el estudio podría no ser obligatorio; lo hace de todos
modos porque el paso usa IA sobre datos de terceros, porque el DPA (§12.3, Anexo II) se apoya en él y porque los Clientes lo
necesitan para sus propias evaluaciones. Este documento sigue el orden de la circular: sección 1 = literal (a); secciones 2 y 3 =
instrucción I; sección 4 = literal (b) e instrucción III; sección 5 = literal (c) e instrucciones II, V, VI, VIII; sección 6 =
instrucción VII.
<!-- law: C-27 (SIC Circular Externa 002 de 2024, instrucciones I–VIII y nota 2) -->

## 1. Descripción detallada de las operaciones de tratamiento (literal a)

### 1.1. Contexto y roles

Una agencia o empresa (el Cliente) carga exportaciones de su CRM para que Kauro prepare un plan de migración y un paquete de datos.
El Cliente (o su Cliente Final) es el **responsable**; Kauro es **encargado**; Amazon Web Services es **subencargado** (DPA §1,
§8, Anexo III). Los titulares son contactos de negocio, clientes y prospectos del Cliente, y empleados o usuarios del CRM que
figuran como propietarios de registros (DPA Anexo I.5).
<!-- auth: 19 §Data processing agreement · texto: DPA §1, Anexo I -->

### 1.2. Qué hace el modelo y qué no

El modelo de lenguaje **no procesa los registros**. Los registros los procesa Migration Core de forma determinista. El servicio de
inteligencia resuelve primero de forma determinista todo lo que puede, arma un conjunto finito de candidatos y solo pregunta al
modelo por decisiones acotadas de **esquema y semántica** que siguen abiertas: a qué campo de destino corresponde una columna, qué
significa un valor de una lista de categorías, qué transformación aplicar, cómo se relacionan objetos. La respuesta se valida y se
compila; no puede crear un campo de destino, establecer la identidad de una persona ni autorizar una operación destructiva. El
Cliente revisa y aprueba el plan, y Migration Core lo valida contra el conjunto completo de datos.
<!-- auth: 06 §Objective and execution shape; 06 §Response parser and compiler; 06 §Migration validation and final states; 02 §4–§10 (aprobación del plan por la agencia) -->

### 1.3. Qué datos llegan al modelo

Cada solicitud es un "sobre" (envelope) armado por el minimizador. Clases de privacidad de la autoridad: L0 estructura no
identificante y hechos agregados; L1 vocabulario semántico aprobado que no puede identificar a una persona; L2 ejemplos
autorizados enmascarados; L3 datos personales o confidenciales crudos (**excluidos**); L4 credenciales y secretos (**siempre
excluidos**).

| Contenido del sobre | Clase | Cómo se forma |
|---|---|---|
| Por columna: número de filas, de no vacíos y de distintos, unicidad, formas candidatas, longitud mínima y máxima | L0 | Medición sobre todos los datos por el perfilador |
| Encabezados de columna, nombres de hoja y de archivo, etiquetas y opciones del destino, patrones de memoria, códigos de reparación | L0/L1 si el clasificador los admite como metadato estructural | Si no pasan, viajan como **token opaco**: un HMAC con una clave ligada al cliente, al intento y a la revisión del proyecto, que solo conoce el servicio de inteligencia |
| Valores de una columna de categorías (por ejemplo, estados) | L1 | Solo si **todos** los valores de la columna se clasifican como semántica segura de baja cardinalidad (vocabulario cerrado u opciones del propio destino) y ninguno parece una instrucción; un solo valor personal, secreto, sensible o desconocido cierra la columna entera |
| Forma enmascarada de un texto libre | L2 | Solo para tareas que la necesitan (mapa de valores, tipo semántico, transformación, reparación), solo de columnas sin ningún valor personal, secreto o sensible, como máscara de hasta 32 caracteres (letras → `a`/`A`, dígitos → `9`), máximo 6 por columna |
| Candidatos deterministas, objetos y asociaciones del destino, presupuesto | L0 | Referencias opacas y códigos cerrados |

Nunca viajan: filas, nombres, correos, teléfonos, direcciones, identificaciones, números de tarjeta o cuenta, notas, credenciales
ni el token de autenticación (que va en la cabecera firmada, fuera del cuerpo). Los datos que viajan están **minimizados y
seudonimizados**, no anonimizados: Kauro conserva la clave de los tokens durante el intento, y un valor L1 podría, por error del
clasificador, ser un dato personal (riesgo R1). Por eso este estudio trata el contenido como dato personal.
<!-- auth: 06 §Privacy classes and minimization; 06 §Facts and decision evidence; 09 §Storage zones and object registry (zona MINIMIZED) · ic: src/envelope/envelope-builder.ts (minimize, regla de columna completa, TASK_NEEDS_L2, MAX_EXEMPLARS_PER_FIELD = 6, MASKING_POLICY_VERSION = 1.4.0, clave de máscara por inquilino/intento/revisión); src/classifier/data-classifier.ts (clases SAFE_STRUCTURAL_METADATA, SAFE_LOW_CARDINALITY_SEMANTICS, POTENTIAL_PII, POTENTIAL_SECRET, SENSITIVE_OR_RESTRICTED, FREE_TEXT, UNKNOWN; UNKNOWN falla cerrado; formas de correo, teléfono, tarjeta, IBAN, identificación y dirección); src/contracts/envelope.ts (SourceFieldFact) -->

### 1.4. Flujo, ubicación y conservación

1. El servicio de inteligencia arma el sobre, decide la salida (EgressDecision ligada a los bytes exactos, al destino permitido y a
   un vencimiento) y el transporte firma esos bytes con credenciales temporales (SigV4).
2. La solicitud va a `bedrock-runtime` en una región de EE. UU. (us-east-1, o us-west-2 si la sonda P2 lo exige), a un **perfil de
   inferencia geográfico `us.`** de un modelo Claude de Anthropic. El código no puede construir una URL hacia un perfil `global.`,
   `eu.`, `apac.` ni otra región. AWS procesa la solicitud en una región comercial de EE. UU. dentro de la red de AWS, cifrada en
   tránsito.
3. El cuerpo no lleva herramientas, archivos, control de caché ni metadatos; si la respuesta reporta tokens de caché, el resultado
   se descarta como violación de privacidad.
4. Conservación en AWS: modo de retención de datos de la cuenta `none` (ninguna solicitud ni respuesta se escribe en almacenamiento
   duradero ni se comparte con el proveedor del modelo) y registro de invocaciones apagado. CloudTrail registra la llamada en la
   región de origen.
5. Conservación en Kauro: el contexto minimizado vive en la zona MINIMIZED solo durante la revisión activa y su ventana breve de
   evidencia, y se elimina con los datos del proyecto (ToS §13.1; DPA Anexo IV).
<!-- auth: 06 §Privacy classes and minimization (EgressDecision); 06 §Prompt injection and tool restrictions; 08 §Model boundary; A9 §3 y §4; 09 §Derived data and worker scratch; 09 §Retention schedule · ic: src/provider/bedrock-wire.ts (BEDROCK_REGIONS, BEDROCK_PROFILE `^us\.anthropic\.`, miembros cerrados, tools vacío); src/provider/bedrock-transport.ts (credenciales temporales, sin reintentos, redirect: error); src/provider/bedrock-gateway.ts (CACHE_TOKENS terminal); src/provider/bedrock-receipts.ts (autorización y token de sesión redactados) · fuente: V-03 (retención `none`; perfiles geográficos), V-10 (registro de invocaciones) -->

### 1.5. Volumen y frecuencia

Por proyecto y a solicitud del Cliente; las solicitudes por proyecto están limitadas por el presupuesto del intento. No hay
tratamiento continuo ni por lotes de registros.
<!-- auth: 06 §Budget algebra · texto: DPA Anexo I.7 -->

## 2. Finalidad y razonabilidad

Finalidad: proponer decisiones de mapeo y transformación para que el Cliente migre sus propios datos de CRM, que es el servicio
que contrató (DPA Anexo I.3 a). Es una finalidad legítima de ejecución de un contrato por cuenta del responsable, sin uso propio
de Kauro: Kauro no vende, no comparte, no entrena modelos ni crea memoria entre clientes con estos datos.
<!-- law: C-27 (instrucción I.c, razonabilidad) · auth: 06 §Scoped memory (sin base vectorial, sin RAG entre clientes, sin aprendizaje en línea); 19 §Data processing agreement · texto: DPA §3.3, §3.4 -->

## 3. Necesidad, idoneidad y proporcionalidad (instrucción I)

| Criterio | Análisis |
|---|---|
| **Idoneidad** | El modelo solo se usa si supera la calificación medida de B04 (corpus sellado, umbrales de decisiones útiles, cero violaciones críticas de autoridad). Un modelo no calificado no entra en producción. |
| **Necesidad** | La alternativa más moderada es la determinista, y se aplica primero: el modelo solo ve lo que queda sin resolver. Dentro del paso con modelo, la medida menos intrusiva es la minimización: no se envían filas ni L3. Si minimizar destruye el significado necesario, el sistema hace una pregunta acotada al Cliente o deja el candidato sin resolver; **no** exporta datos crudos. Sin modelo, las mismas decisiones las tomaría el Cliente a mano, con más costo y más error; la decisión final sigue siendo del Cliente. |
| **Razonabilidad** | Sección 2. |
| **Proporcionalidad en sentido estricto** | La afectación al habeas data es mínima (contexto L0–L2 seudonimizado, sin retención, en EE. UU., país con nivel adecuado de protección según la SIC) frente a la ventaja de un plan de migración más rápido y correcto, que además protege la calidad de los datos de los titulares en el CRM de destino. |
<!-- law: C-27 (instrucción I), C-22 · auth: 06 §Provider selection decision (selección lexicográfica: privacidad y seguridad primero); 06 §Qualification corpus and scorer; 06 §Privacy classes and minimization (último recurso: preguntar o dejar sin resolver) -->

## 4. Riesgos para los derechos y libertades de los titulares (literal b, instrucción III)

Escala: **probabilidad** B (baja: requiere una falla de varias defensas), M (media), A (alta); **impacto** B (sin exposición de
identidad o exposición de un dato aislado de contacto de negocio), M (exposición de datos de contacto de varios titulares o
decisión errónea sobre sus registros), A (exposición masiva, datos sensibles o daño difícil de revertir). Riesgo inherente sin
medidas; residual con las medidas de la sección 5.

| ID | Riesgo | Derecho afectado | Inherente (P/I) | Medidas (sección 5) | Residual (P/I) |
|---|---|---|---|---|---|
| R1 | Un dato personal se clasifica por error como semántica segura y viaja como L1 (p. ej., una lista corta de nombres en una columna de categorías) | Confidencialidad, circulación restringida | M/M | M1, M2, M3 | B/B |
| R2 | Un dato personal viaja en un canal de metadatos (encabezado que es un correo, nombre de archivo, etiqueta del destino, memoria) | Confidencialidad | M/M | M1, M2 | B/B |
| R3 | Reidentificación por formas enmascaradas L2 o por conteos agregados | Confidencialidad | B/B | M1, M3 | B/B |
| R4 | AWS conserva entradas o salidas (abuso, revisión humana, registro de invocaciones activado por error) | Confidencialidad, limitación temporal | M/M | M4, M5, M6 | B/B, condicionado a A-09 y A-10 |
| R5 | La inferencia se procesa fuera de EE. UU. (perfil global u otra región) | Transferencia internacional | M/M | M7 | B/B |
| R6 | Los datos se usan para entrenar modelos o se comparten con el proveedor del modelo | Finalidad, circulación restringida | B/M | M8 | B/B |
| R7 | Inyección de instrucciones en datos del CRM que lleva al modelo a proponer operaciones dañinas o a filtrar datos | Integridad, confidencialidad | M/M | M9, M10 | B/B |
| R8 | Una sugerencia equivocada produce una transformación errónea de registros (datos inexactos o incompletos del titular en el CRM de destino) | Veracidad y calidad | M/M | M10, M11 | B/M |
| R9 | Decisiones automatizadas o perfilamiento sobre personas | No discriminación, libertad | B/A | M12 | B/B (el paso no decide sobre personas) |
| R10 | Fuga de credenciales o secretos en la solicitud o en registros | Seguridad | B/A | M1, M13 | B/B |
| R11 | Acceso no autorizado a la cuenta de AWS o uso del modelo por otra identidad | Seguridad, confidencialidad | B/A | M13, M14 | B/M |
| R12 | Conservación en Kauro del contexto o de los recibos más allá del proyecto | Limitación temporal | M/B | M15 | B/B |
| R13 | Reutilización de decisiones de un cliente en otro | Finalidad, confidencialidad | B/M | M16 | B/B |
| R14 | Los titulares no saben que interviene un modelo | Información (instrucción VII) | M/B | M17 | B/B |
| R15 | Cambio silencioso de modelo, proveedor o perfil que altera las garantías (p. ej., un modelo que exige retención) | Todas las anteriores | B/M | M5, M7, M18 | B/B |
<!-- law: C-27 (literal b; instrucción III y nota 7: sesgos humanos, fallas técnicas, vulnerabilidades de seguridad, fallas de implementación y de diseño) · auth: 06 §Privacy classes and minimization ("Low cardinality does not make a value L1. A two-value enum can contain two employee names. A header can contain a customer email"); 06 §Prompt injection and tool restrictions; 08 §Threat model and assets -->

## 5. Medidas (literal c; instrucciones II, V, VI, VIII)

| ID | Medida | Tipo | Evidencia u obligación |
|---|---|---|---|
| M1 | **Clasificación de toda salida**: cada valor y cada texto de metadatos recibe una clase antes de salir; UNKNOWN falla cerrado; formas de correo, teléfono, identificación, dirección, tarjeta, IBAN y secretos se detectan en cualquier canal; un valor personal o desconocido cierra la columna completa; los textos que no pasan viajan como tokens HMAC con clave por inquilino, intento y revisión | Diseño de software | ic: src/classifier/data-classifier.ts; src/envelope/envelope-builder.ts |
| M2 | **Decisión de salida ligada**: el gateway solo envía un sobre cuyo hash coincide con la decisión firmada por el núcleo, que relee los canales de texto en vez de confiar en el constructor; un booleano "minimized=true" no tiene autoridad | Diseño de software | auth: 06 §Privacy classes and minimization; 08 §Model boundary · ic: envelope-builder.ts (egress decision HMAC) |
| M3 | **Pruebas con centinelas**: valores únicos sintéticos en cada canal posible; se inspecciona el cuerpo HTTP final, registros, errores, reintentos y reparaciones | Prueba | ic: test/b03-*.test.ts (pruebas "sentinel"); auth: 06 §Privacy classes and minimization (último párrafo) · CHECKLIST A-12 (suite de privacidad sobre el cable real de Bedrock) |
| M4 | **Retención cero en Bedrock**: modo de retención de datos de la cuenta `none` en cada región de origen usada; con `none`, un modelo que exige retención es rechazado por AWS (`ValidationException`), así que el control falla cerrado; Kauro no usa modelos que exijan retención o revisión humana (hoy, Claude Fable 5 y 5.1) | Configuración | fuente: V-03 · **obligación de construcción**: leer de vuelta `GET /data-retention` = `none` antes de cada etapa y de producción, y denegar por política `bedrock:PutAccountDataRetention` con otro modo (CHECKLIST A-09; la sonda no existe en b819658: P8 solo registra la página) |
| M5 | **Registro de invocaciones apagado**: está desactivado por defecto; si se activara, guardaría cuerpos completos en S3 o CloudWatch | Configuración | fuente: V-10 · ic: tools/campaign/aws-probes.mjs **P4** (`GetModelInvocationLoggingConfiguration`: OFF solo si no hay `loggingConfig`; cualquier destino rechaza) · CHECKLIST A-10 (P4 en cada región de origen antes de cada etapa y, en producción, en cada despliegue) |
| M6 | **Sin canales de retención propios del pedido**: sin caché de prompts, sin lotes, sin archivos, sin herramientas; tokens de caché reportados = violación terminal | Diseño de software | ic: bedrock-wire.ts, bedrock-gateway.ts (`CACHE_TOKENS`) |
| M7 | **Solo EE. UU.**: URL construida solo hacia `bedrock-runtime.<us-east-1|us-west-2>` y un perfil `us.anthropic.*`; la sonda P2 comprueba que el perfil está activo y que todas sus regiones miembro son de EE. UU.; sin conmutación a otro proveedor ni a un endpoint global | Diseño + configuración | ic: bedrock-wire.ts (`BEDROCK_PROFILE`, `BEDROCK_REGIONS`), src/gateway/candidates.ts (D4-BR-1), aws-probes.mjs P2 · auth: A9 §4; 08 §Model boundary · fuente: V-03 · CHECKLIST A-06 |
| M8 | **Sin entrenamiento ni acceso del proveedor**: AWS y los proveedores de modelos no usan entradas ni salidas de Bedrock para entrenar modelos y no se comparten con los proveedores; los proveedores no tienen acceso a las cuentas de despliegue, registros, prompts ni respuestas | Contractual / proveedor | fuente: V-09 (Amazon Bedrock FAQ), V-02 (Bedrock Data protection); contrato: AWS Service Terms y DPA de AWS (V-01; CHECKLIST A-07) |
| M9 | **Entrada no confiable**: el modelo no tiene herramientas, navegación, archivos remotos, código, memoria externa ni conmutación; los textos que parecen instrucciones no se envían como valores | Diseño de software | auth: 06 §Prompt injection and tool restrictions · ic: clasificador (`instructionLike`) |
| M10 | **El compilador manda**: la respuesta se valida contra esquemas cerrados y permisos; no puede crear campos, establecer identidad ni autorizar operaciones destructivas; evidencia por decisión | Diseño de software | auth: 06 §Response parser and compiler; 06 §Facts and decision evidence |
| M11 | **Validación y aprobación humana**: Migration Core valida el plan sobre todos los datos; el Cliente revisa y aprueba; defectos con remedio | Organizativa + software | auth: 06 §Migration validation and final states; 02 §4–§10; ToS §11 |
| M12 | **Sin decisiones sobre personas**: las tareas del modelo son de esquema y semántica; no puntúa, clasifica ni perfila titulares | Diseño | auth: 06 §Objective and execution shape |
| M13 | **Credenciales**: temporales (STS / IAM Identity Center), nunca escritas; firma y token de sesión redactados en recibos; L4 excluido | Diseño + configuración | ic: bedrock-transport.ts, bedrock-receipts.ts · auth: 06 §Privacy classes and minimization (ranura de autenticación) |
| M14 | **Mínimo privilegio en AWS**: la identidad de inteligencia solo puede `InvokeModel` sobre los perfiles `us.` aprobados y leer las sondas; MFA en la cuenta; despliegue con identidad federada | Configuración | ic: aws-probes.mjs (política de mínimo privilegio) · auth: 14 §Identity matrix; A9 §3 (IAM + GitHub OIDC) · CHECKLIST A-06 |
| M15 | **Ciclo de vida corto en Kauro**: zona MINIMIZED solo durante la revisión activa y su ventana de evidencia; eliminada con el proyecto y cubierta por el comprobante de eliminación | Software | auth: 09 §Derived data and worker scratch; 09 §Retention schedule; 09 §Deletion receipts and restoration |
| M16 | **Memoria con alcance**: CLIENT, AGENCY o GLOBAL; GLOBAL solo patrones no personales revisados; sin base vectorial ni RAG entre clientes | Diseño | auth: 06 §Scoped memory |
| M17 | **Información**: la POL §12.3, el DPA Anexo I.2.4 y el Anexo II dicen qué llega al modelo, dónde y sin retención; el Cliente, como responsable, informa a sus titulares | Organizativa | texto: POL §12.3; DPA Anexo I, II, III |
| M18 | **Cambios controlados**: cambiar de modelo, proveedor, región, perfil o política de enmascaramiento exige actualizar este estudio, aviso de 30 días a Clientes si cambia un subencargado y nueva calificación | Organizativa | INTERNAL_DATA_MANUAL §5.5, §5.8; DPA §8.2 · auth: 06 §Provider selection decision; 19 §Subprocessor register |

Instrucción II (precaución): si una de las comprobaciones A-06, A-09, A-10 o A-12 no pasa, **el paso con modelo no se activa**; el
servicio sigue con la resolución determinista y las preguntas al Cliente. Instrucción V (calidad): las decisiones se basan en
hechos medidos sobre todos los datos y la validación completa de Migration Core, nunca sobre una muestra. Instrucción VI
(privacidad desde el diseño): la minimización por clases y la regla de columna completa cumplen esa función; Kauro no usa
privacidad diferencial porque no publica estadísticas sobre titulares: el modelo recibe hechos de esquema, no consultas sobre
personas. Instrucción VIII (seguridad auditable): las sondas, los recibos de solicitud y las decisiones de salida son evidencia
que puede mostrarse a la SIC.
<!-- law: C-27 (literal c; instrucciones II, V, VI, VIII), C-23 · auth: 06 §Facts and decision evidence; 06 §Migration validation and final states -->

## 6. Información y derechos de los titulares (instrucción VII)

Los titulares de E-01/E-02 pueden ejercer sus derechos ante el Cliente (responsable) o ante Kauro; Kauro tramita lo que reciba
como encargado, con sus leyendas y plazos, y traslada al responsable lo que solo él puede decidir (INTERNAL_DATA_MANUAL §5.2; DPA
§12.2). Kauro entrega al Cliente, a solicitud, este estudio y la descripción del tratamiento para que informe
a sus titulares y haga su propia evaluación (DPA §12.3).
<!-- law: C-17, C-27 (instrucción VII) · texto: DPA §12 -->

## 7. Riesgo residual y conclusión

Con las medidas M1–M18 el riesgo residual es **BAJO** en todos los riesgos salvo R8 y R11 (impacto medio, probabilidad baja), que
se aceptan porque la decisión final es del Cliente con validación completa (R8) y porque el acceso a la cuenta está protegido por
MFA, credenciales temporales y mínimo privilegio (R11). No se identifica un alto riesgo para los titulares en el sentido de la
instrucción IV.

La conclusión está **condicionada**: vale solo si antes de enviar el primer dato de un Cliente a Bedrock pasan las comprobaciones
de activación A-06, A-09, A-10 y A-12 (CHECKLIST §7). Mientras no pasen, el paso con modelo queda apagado.

## 8. Revisión

Este estudio se revisa en la revisión anual (INTERNAL_DATA_MANUAL §9) y **antes** de cualquier cambio de la sección M18, de la
clase máxima de datos enviada al modelo, de la política de retención o de los términos de AWS Bedrock, y después de cualquier
incidente que involucre el paso con modelo.

## 9. Aprobación

Decisión: **APROBADO CON CONDICIONES** (sección 7).

Representante legal y oficial de protección de datos de Kauro Data S.A.S.

Representante legal de Kauro Data S.A.S. (nombre al firmar, decisión D-16) · Firma: ______________________ · Fecha: ____________
<!-- ver CHECKLIST A-04 -->
