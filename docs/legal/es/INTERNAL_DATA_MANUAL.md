<!-- SECONDARY TRANSLATION of the English master ../INTERNAL_DATA_MANUAL.md. Kept only because the Colombian habeas-data materials (Ley 1581 de 2012; Decreto 1074 de 2015) are required in Spanish. Reachable only through the language selector; the English master prevails. Traducción secundaria del texto maestro en inglés; accesible solo mediante el selector de idioma. -->
<!--
D-08b · Manual interno de políticas y procedimientos de tratamiento de datos personales de Kauro Data S.A.S. (Ley 1581 de 2012,
arts. 17 lit. k y 18 lit. f; Decreto 1074 de 2015, arts. 2.2.2.25.6.1 y 2.2.2.25.6.2; SIC, Guía para la implementación del
principio de responsabilidad demostrada). Documento INTERNO: no se publica ni forma parte del contrato con el Cliente; el DPA §5(f)
se remite a él. Borrador del constructor sin abogado (decisión D-08b, opción 1).
Trazabilidad: `auth:` = authority/r2; `law:` = fila de CHECKLIST.md; `prod:` = elemento del registro del producto
(packages/contracts/registry) o código de Intelligence Core. Fuentes consultadas el 2026-10-06 (CHECKLIST §1 y §5).
Marcadores: solo los de LAWYER_LATER F-01..F-05. El nombre del representante legal se anota al firmar (decisión D-16).
-->

# Manual interno de políticas y procedimientos de tratamiento de datos personales

**Versión:** 1.1 · **Adoptado por:** el representante legal de Kauro Data S.A.S. · **Vigente desde:** [fecha de vigencia] · **Próxima revisión:** doce
(12) meses después de la vigencia (sección 9)

## 1. Objeto, alcance y marco

1.1. Este Manual dice **quién hace qué, cuándo y con qué registro** para cumplir la Política de Tratamiento de Información
Personal (POL), el Aviso de Privacidad (AVISO), los Términos de Servicio (ToS) y el Acuerdo de Encargo (DPA). No repite esos
textos: los aplica. Si este Manual y un texto publicado difieren, prevalece el texto publicado y este Manual se corrige.

1.2. Cubre todas las bases de datos de la sección 4: las que Kauro trata como **responsable** y las que trata como **encargado**
(archivos de CRM de los Clientes y sus derivados).

1.3. Marco: Ley 1581 de 2012 (art. 17 lit. k: el responsable adopta un manual interno de políticas y procedimientos, en especial
para consultas y reclamos; art. 18 lit. f: el mismo deber para el encargado); Decreto 1074 de 2015, art. 2.2.2.25.6.1
(responsabilidad demostrada proporcional al tamaño, la naturaleza de los datos, el tipo de tratamiento y los riesgos) y art.
2.2.2.25.6.2 (estructura administrativa proporcional, mecanismos internos con entrenamiento, procesos para consultas y reclamos);
SIC, Guía para la implementación del principio de responsabilidad demostrada (programa integral: compromiso de la organización,
controles del programa, evaluación y revisión continua); SIC, Circular Externa 002 de 2024 (IA), aplicada en PIA_BEDROCK.md.
<!-- law: C-12, C-13, C-24, C-27 · fuente: CHECKLIST C-24 (Guía SIC, Decreto 1074 Cap. 25 secciones 4–6) -->

## 2. Proporcionalidad: una empresa de una sola persona

2.1. Kauro Data S.A.S. opera como empresa de una sola persona: su representante legal es también quien opera el servicio y no
tiene empleados. El software lo construye y lo opera esa persona con asistentes de programación, que **no** tienen acceso a datos de
clientes. No hay empleados, ni áreas, ni comités. Los vendedores independientes no reciben datos de CRM.
<!-- auth: A4 §Owner acts y §Resources (un dueño, operación asistida); 08 §Model boundary (último párrafo: datos de clientes excluidos de asistentes de desarrollo); DPA §8.3 (vendedores sin Datos del Cliente) -->

2.2. Por eso el Manual se apoya en dos tipos de pasos, y cada procedimiento dice cuál es cuál:
- **PRODUCTO:** lo hace la plataforma (con el paquete del programa R2 que lo construye). Antes de que ese paquete esté aceptado y
  en producción, el paso es manual o el servicio no se activa (CHECKLIST §7).
- **MANUAL:** lo hace el representante legal, a mano, con el registro indicado. Un paso manual sin su registro no cuenta como
  hecho.
<!-- law: C-24 (Decreto 1074 art. 2.2.2.25.6.1 num. 1: medidas proporcionales al tamaño empresarial; art. 2.2.2.25.6.2 num. 1: estructura proporcional) -->

## 3. Roles y responsabilidades

| Rol | Quién | Responsabilidades |
|---|---|---|
| Responsable / encargado | Kauro Data S.A.S. | Según la sección 4 |
| **Oficial de protección de datos** (persona que asume la función de protección de datos y tramita las solicitudes) | **El representante legal** | Aprobar y revisar este Manual y la evaluación de impacto; recibir y resolver consultas y reclamos (sección 5.1); trasladar las solicitudes sobre Datos del Cliente (5.2); dirigir la respuesta a incidentes y hacer los reportes a la SIC y los avisos a Clientes (5.4); aprobar subencargados (5.5); vigilar la conservación y supresión (5.6); formarse y formar (5.10); hacer la revisión anual (sección 9); responder los requerimientos de la SIC con la evidencia del programa |
| Encargados de Kauro | AWS, Resend, Google (Workspace) y el proveedor de facturación electrónica | Según sus contratos (sección 5.5; POL §13.1; DPA Anexo III) |
| Responsables independientes | Wise, Bancolombia, DIAN | Tratan datos de pago o tributarios para sus propios fines; no son encargados (POL §13.2) |
| Vendedores independientes | Colaboradores comerciales | Solo datos de organizaciones prospecto (agencias y empresas); aceptan las reglas de manejo de datos antes de activarse (sección 5.10) |
| Asistentes de programación (Claude, Codex) | Herramientas del constructor | Ningún dato de clientes, prospectos o titulares; los defectos se reproducen con datos sintéticos |
<!-- law: C-09b (Decreto 1074 art. 2.2.2.25.4.4: responsable y encargado designan persona o área) · auth: 19 §Business readiness gate ("a responsible person for obligations"); 19 §Subprocessor register; 08 §Model boundary; 12 §Seller onboarding and access lifecycle (aceptación de manejo de datos y formación antes de ACTIVE) · resolución de silencio S-14 · fuente: Guía SIC, III.1.1 (alta dirección designa la persona o área) y III.1.2 (oficial de protección de datos) -->

## 4. Inventario de bases de datos

Las bases se identifican por código. "Sistema" es dónde viven; "Auto" indica si la plataforma aplica sola la conservación
(PRODUCTO) o si la vigila el representante legal (MANUAL). El inventario se revisa en la revisión anual y cada vez que cambia una
finalidad, un dato, un sistema o un encargado.

### 4.1. Kauro como responsable

| Código | Base (POL) | Titulares | Datos | Sistema y ubicación | Encargados | Conservación (POL §15) | Auto |
|---|---|---|---|---|---|---|---|
| R-01 | Clientes y usuarios (§6.1) | Administradores y usuarios de agencias y empresas cliente | Identificación y contacto de trabajo, rol, verificación de correo y segundo factor, aceptación de documentos, autorización comercial separada con sus canales, actividad y eventos de seguridad, tipo de comprador | Base de datos de la plataforma en AWS (EE. UU.) | AWS; Resend (avisos) | Cuenta activa + 6 meses | MANUAL hasta que exista barrido automático |
| R-02 | Facturación, pagos y contabilidad (§6.2) | Representantes y contactos de facturación; ordenantes de transferencias | Razón social, NIT, dirección y contacto de facturación, pedidos, pagos, reembolsos, disputas | Plataforma (AWS); proveedor de facturación electrónica; libros contables | AWS; proveedor de facturación | ≥ 10 años | MANUAL (plazo legal; no se borra antes) |
| R-03 | Interesados del formulario (§6.3) | Personas que llenan el formulario de contacto | Nombre, correo, empresa, tipo de comprador, destino, banda de registros, fecha deseada, autorización comercial separada con sus canales | Plataforma (AWS); correo corporativo | AWS; Google | 12 meses sin interacción | MANUAL |
| R-04 | Prospectos (§6.3) | Organizaciones, agencias y empresas (datos de la organización), y personas de ellas que autorizaron el contacto | Organización: nombre de la organización, dominio, país, fuente y fecha, notas acotadas sin datos de personas, estado de baja y canales que cumplen los tres hechos de POL §6.3.1 con su evidencia (URL, fecha, captura) y fecha de última verificación. Persona: nombre, cargo, correo y teléfono de trabajo **solo con registro de autorización** | Plataforma (AWS) | AWS; Resend o correo corporativo para envíos | Baja, revocatoria o 24 meses sin interacción; la baja se conserva | MANUAL (borrado); PRODUCTO (bloqueo de datos de persona sin autorización, A-13) |
| R-05 | Colaboradores comerciales y proveedores (§6.4) | Vendedores, candidatos, proveedores personas naturales | Identificación, contacto, contrato, documentos tributarios y de seguridad social, datos bancarios, comisiones | Plataforma (AWS, acceso restringido a finanzas); correo corporativo | AWS; Google | Relación + plazos tributarios y contables | MANUAL |
| R-06 | Solicitudes, consultas y reclamos (§6.5) | Quienes ejercen derechos ante Kauro | Identificación del solicitante, tipo, fechas, verificación, alcance, respuesta | Registro de solicitudes (sección 8) en el espacio de Google Workspace de Kauro | Google | 5 años desde el cierre | MANUAL |
| R-07 | Seguridad y registros técnicos (§6.6) | Usuarios y operadores | Actor, alcance, acción, resultado, fecha; sin contenido de CRM ni secretos | Plataforma y registros de AWS (EE. UU.) | AWS | Registros de aplicación 30 días; evidencia de seguridad 180 días | PRODUCTO (09 §Retention schedule) |
| R-08 | Correspondencia corporativa | Remitentes y destinatarios de correo de Kauro | Contacto y contenido de los correos de soporte, ventas y administración | Google Workspace | Google | Según la base a la que pertenezca el correo (R-01..R-06) | MANUAL |
<!-- law: C-25 (Decreto 1074 art. 2.2.2.25.2.8) · auth: POL §6 y §15 con sus trazas; 09 §Retention schedule; 08 §Audit events and retention; A9 §1 (Google Workspace sin cambio) y §3 (servicios AWS) · fuente: Guía SIC, III.2.2 (inventario: qué datos, cómo se usan, si se necesitan, dónde se obtienen y prueba de la autorización) -->

R-08 no es una base nueva: es el sistema por el que llegan datos de R-01 a R-06. La regla es que **ningún archivo de CRM llega por
correo** (ToS §12.2); si llega, se trata como incidente de dato prohibido (sección 5.4) y se elimina del buzón.

### 4.2. Kauro como encargado (Datos del Cliente)

| Código | Base | Responsable | Datos | Sistema y ubicación | Subencargados | Conservación | Auto |
|---|---|---|---|---|---|---|---|
| E-01 | Archivos de CRM y sus derivados, por zona: cuarentena, aceptado, perfil, minimizado, provisional, entrega, comprobantes de importación | El Cliente o su Cliente Final (cadena registrada por Cliente Final, R2-111) | Los de DPA Anexo I.4; titulares de DPA Anexo I.5 | Amazon S3 y base de datos de la plataforma, regiones de AWS en EE. UU.; cada objeto registrado con agencia, proyecto, clase, ubicación, generación, hash y ancla de conservación | AWS | ToS §13.1 / DPA Anexo IV (24 horas a 30 días según la etapa) | PRODUCTO (09 §Retention schedule, §Early deletion, §Deletion receipts) |
| E-02 | Contexto minimizado enviado al modelo | Igual que E-01 | Estructura y hechos agregados (L0), vocabulario aprobado (L1), formas enmascaradas (L2); nunca L3 ni L4 | Zona MINIMIZED (AWS, EE. UU.); en tránsito hacia Amazon Bedrock (perfil de inferencia `us.`) | AWS (Bedrock), sin retención | Revisión activa y ventana breve de evidencia; se elimina con el proyecto | PRODUCTO; evaluación de impacto en PIA_BEDROCK.md |
<!-- auth: 09 §Storage zones and object registry; 09 §Derived data and worker scratch; 06 §Privacy classes and minimization; 19 §Data processing agreement; A9 §3 y §4 · prod: registry cases R2-111 (B19) · law: C-13, C-21 -->

## 5. Procedimientos

### 5.1. Consultas y reclamos de titulares ante Kauro como responsable

| Paso | Qué | Plazo legal | Quién |
|---|---|---|---|
| 1 | Recibir por [correo de notificaciones], por escrito en [domicilio] o por la sección de privacidad de la plataforma (UI46). Abrir el caso en el registro de solicitudes con fecha de recibo | — | PRODUCTO (formulario UI46, cuando esté) o MANUAL (correo y escrito) |
| 2 | Verificar identidad del titular, causahabiente o representante **antes** de revelar, corregir o suprimir; registrar el método | — | MANUAL |
| 3 | Clasificar: consulta, reclamo (corrección, actualización, supresión, revocatoria, incumplimiento), o solicitud sobre Datos del Cliente (pasa a 5.2) | — | MANUAL |
| 4a | **Consulta:** responder | 10 días hábiles desde el recibo; prórroga máx. 5 días hábiles avisando antes del vencimiento | MANUAL |
| 4b | **Reclamo incompleto:** pedir que se complete | Dentro de los 5 días siguientes al recibo; desistido a los 2 meses sin respuesta | MANUAL |
| 4c | **Reclamo de otro competente:** trasladar e informar al interesado | 2 días hábiles | MANUAL |
| 4d | **Reclamo completo:** marcar el dato con la leyenda "reclamo en trámite" y su motivo | 2 días hábiles desde el recibo completo | MANUAL (nota en el registro y en la base afectada) |
| 4e | Resolver el reclamo. Si no es posible a tiempo, informar los motivos y la nueva fecha **antes del vencimiento del término inicial** | 15 días hábiles desde el día siguiente al recibo; prórroga máx. 8 días hábiles siguientes al vencimiento del primero | MANUAL |
| 5 | Supresión o revocatoria: proceden en cualquier momento sin que el titular alegue un incumplimiento. Borrar de R-01..R-08, o dejar de usar los datos para las finalidades no necesarias (p. ej., comerciales), y explicar por escrito los registros residuales que un deber legal o contractual obliga a conservar (p. ej. facturas, R-02). Una baja de comunicaciones comerciales se aplica de inmediato, no al cierre del caso | Dentro del término de 4e | MANUAL; la baja, PRODUCTO |
| 6 | Cerrar el caso con respuesta, fecha y evidencia mínima, sin copiar los datos suprimidos | — | MANUAL |

Reglas: el acceso es gratuito al menos una vez por mes calendario y con cada cambio sustancial de la POL; los "días hábiles" son de
lunes a viernes sin festivos de Colombia; el representante legal revisa el registro de solicitudes **cada día hábil** y fija en él
la fecha de vencimiento de cada caso al abrirlo.
<!-- law: C-08, C-09, C-10, C-11 (Ley 1581 arts. 14 y 15; Decreto 1074 arts. 2.2.2.25.2.6 y 2.2.2.25.4.2) · auth: 19 §Rights requests and privacy complaints; 11 §Billing, team, settings and help ("privacy requests") · prod: UI46 (DESIGN_NOT_RENDERED_PRODUCT); el registro no tiene comando de producto: es MANUAL (CHECKLIST A-02) · texto: POL §9, §10 -->

### 5.2. Consultas y reclamos sobre Datos del Cliente (Kauro como encargado)

Kauro tiene deberes propios de encargado (Ley 1581 art. 18): tramitar consultas y reclamos, registrar leyendas, no hacer circular
información bloqueada. No basta con reenviar.

| Paso | Qué | Plazo legal | Quién |
|---|---|---|---|
| 1 | Recibir y abrir el caso en el registro de solicitudes, marcado "encargado"; verificar identidad y delimitar la solicitud | — | MANUAL |
| 2 | Identificar el proyecto (E-01) y el **responsable real** con la cadena registrada (DPA §1.2): en la cadena de dos partes, el Cliente; en la cadena agencia–cliente final, el Cliente Final, al que se llega por medio de la agencia. Si Kauro ya no conserva los datos, informarlo al titular | — | MANUAL con la referencia de autoridad de tratamiento (R2-111) |
| 3 | Reclamo incompleto: pedir que se complete | 5 días desde el recibo | MANUAL |
| 4 | **Reclamo completo: registrar la leyenda "reclamo en trámite" y su motivo** en el proyecto o revisión afectados, visible para el Cliente y en el Paquete, y mantenerla hasta la decisión | 2 días hábiles | PRODUCTO (A-17) o, hasta entonces, control MANUAL equivalente: anotación en el registro y retención del Paquete afectado |
| 5 | Trasladar al responsable lo que solo él puede decidir (fondo de la corrección o supresión) e informar al titular del traslado | 2 días hábiles desde el recibo | MANUAL |
| 6 | Ejecutar lo que decida el responsable y responder o hacer responder al titular. Si no alcanza el término, avisar la prórroga **antes del vencimiento del término inicial** | Consultas 10 + 5 días hábiles; reclamos 15 + 8 días hábiles | MANUAL; ejecución por PRODUCTO (nueva Revisión, exclusión, `RequestDeletion` CMD042, B16) |
| 7 | Actualizar la información que reporte el responsable | 5 días hábiles desde su recibo | MANUAL hasta que exista en el producto |
| 8 | **"Información en discusión judicial"**: insertar la leyenda en el alcance afectado cuando una autoridad notifique a Kauro, o el Cliente informe que fue notificado, de un proceso judicial sobre la calidad del dato | Al recibir la notificación | PRODUCTO (A-17) o MANUAL equivalente |
| 9 | **Bloqueo ordenado por la SIC**: impedir la circulación del alcance afectado (descargas, publicación de Paquetes, envíos al modelo, nuevo procesamiento) mientras dure la orden, sin eliminar salvo que la orden lo disponga; registrar la orden y su levantamiento | Al recibir la orden | PRODUCTO (A-17: bloqueo por alcance) o MANUAL equivalente: contención por alcance de la sección 5.4 paso 2 |
| 10 | Cerrar el caso con evidencia mínima | — | MANUAL |
<!-- law: C-13, C-13b (Ley 1581 art. 18 lit. c, d, e, g, h, i), C-17 (art. 15 num. 1 y 2) · auth: 19 §Rights requests and privacy complaints ("The agency/controller chain is identified"); 09 §Early deletion; 09 §Deletion receipts and restoration; 14 §Incident containment · prod: CMD042 RequestDeletion (B16); registry R2-111 (cadena) · texto: DPA §5(d), (j), §12.2, §12.4; POL §12.2 · CHECKLIST A-17 -->

### 5.3. Autorización, aviso y prueba

1. PRODUCTO (B11/B19): el registro de cuenta y el formulario de contacto muestran la casilla de autorización con enlaces a POL y
   AVISO y guardan usuario, versión del documento y fecha y hora (CHECKLIST A-01).
2. MANUAL: cada versión publicada de POL, AVISO, ToS y DPA se conserva con su fecha de vigencia en el repositorio de documentos de
   Kauro (sin datos personales) para probar qué aceptó cada titular.
3. MANUAL: para colaboradores comerciales, la autorización es un documento firmado al contratar (R-05).
3a. PRODUCTO (A-14): la autorización para comunicaciones comerciales es separada, opcional, con casilla no marcada y elección de
   canales; se guarda con finalidad, canales, fecha y versión; no condiciona la cuenta, la compra ni el formulario.
3b. PRODUCTO (A-13) + MANUAL: un prospecto solo guarda datos de la organización. Un correo o teléfono cuenta como dato de la
   organización **solo por hechos, nunca por su forma**: (a) la organización, persona jurídica, lo publica como su canal de
   contacto comercial y Kauro guarda la evidencia (URL, fecha, captura); (b) no identifica ni se atribuye a una persona natural
   (sin nombre de persona; la agencia no es comerciante persona natural ni negocio de una sola persona; no es celular ni línea
   personal); (c) se verifica de nuevo cada vez que se usa. Quien lo registra (el representante legal o un vendedor) marca cada
   hecho con su evidencia; si alguno falla o no se puede determinar, es dato personal. Los datos de una persona solo se guardan
   con un registro de autorización: la persona llenó el formulario, o respondió por escrito a un primer mensaje enviado a un canal
   que cumple (a)–(c) y que le pedía esa autorización. La regla cubre cada campo importado, la referencia de la fuente y las notas.
   Nadie copia nombres, correos nominativos ni teléfonos de personas de sitios web, directorios ni redes.
4. Antes de usar datos para una finalidad nueva, se actualiza la POL, se avisa antes de aplicar el cambio y, si cambia la
   finalidad, se pide nueva autorización.
<!-- law: C-04, C-05, C-06, C-18, C-19, C-26, C-51, C-52 (SIC Circular Externa 002 de 2024, instrucción IX: accesible al público no es naturaleza pública; SIC, concepto radicado 23-571469 (datos corporativos de una persona jurídica)) · texto: POL §6.3, §8, §20; AVISO · CHECKLIST A-13, A-14, S-22 -->

### 5.4. Incidentes de seguridad

Un incidente es cualquier violación de los códigos de seguridad o pérdida, robo, acceso no autorizado, manipulación o destrucción
de datos personales, incluido el hallazgo de un dato prohibido (sensible, de menores, credenciales, tarjeta) en un archivo de CRM o
en el correo.

| Paso | Qué | Plazo | Quién |
|---|---|---|---|
| 1 | **Detectar y abrir el registro de incidentes**: hora de detección, quién o qué alertó | Al detectar | PRODUCTO (alertas de 14 §Monitoring; `RecordIncident` CMD056, UI42, B16) o MANUAL |
| 2 | **Contener por alcance**: pausar cargas, revisiones, compras, procesamiento, publicación o descargas del alcance afectado; terminar trabajadores comprometidos; sin abrir registros de clientes salvo acceso de soporte con motivo registrado | Inmediato | PRODUCTO (controles de contención, B16/B18 `RestrictCapability` CMD059) + MANUAL (decisión) |
| 3 | **Evaluar**: tipo de incidente, fecha en que ocurrió y en que se conoció, causa, tipo de datos, número de titulares, bases (sección 4) y Clientes afectados | Continuo | MANUAL |
| 4 | **Avisar al Cliente** (datos de E-01/E-02): alcance, hechos conocidos, acción recomendada, contención y próxima actualización; sin esperar a confirmar ni a la causa raíz y sin afirmar que no hubo exposición antes de comprobarlo; actualizar a medida que avanza | **De inmediato y sin demora injustificada** desde que se descubre el incidente o hay motivos razonables para creer que ocurrió; **nunca más de 72 horas** desde ese momento; si una ley exige antes, ese plazo | MANUAL (mensaje autorizado; borrador y envío son registros separados) |
| 5 | **Reportar a la SIC** por el aplicativo o canal que disponga | **Dentro de 15 días hábiles** desde la detección | MANUAL, coordinado con el Cliente cuando son Datos del Cliente |
| 6 | **Avisar a los titulares** de las bases R-01..R-08 cuando corresponda, con medidas para reducir el daño. Para E-01/E-02 la decisión es del Cliente (responsable), salvo que la ley obligue a Kauro | Sin demora | MANUAL |
| 7 | **Reparar y recuperar**; preservar evidencia mínima; toda retención por incidente lleva motivo y fecha de revisión | — | PRODUCTO + MANUAL |
| 8 | **Cerrar**: lección aprendida, cambio de control y, si aplica, actualización de este Manual o de PIA_BEDROCK.md | Al cerrar | MANUAL |

Contenido mínimo del registro: base y datos comprometidos, titulares, fecha del incidente y de su descubrimiento, causa, acciones
correctivas y responsable. El representante legal es el único autorizado a enviar avisos externos.
<!-- law: C-14, C-15 (Ley 1581 arts. 17 lit. n y 18 lit. k; Circular Única Título V num. 2.1 lit. f(ii): 15 días hábiles) · auth: 14 §Incident containment; 14 §Monitoring and service health; 18 §Incident communication; 19 §Incident and breach obligations; 19 §Data categories and excluded use (dato prohibido: cuarentena, notificar, no copiar a soporte ni a un modelo) · prod: CMD056 RecordIncident, UI42 Incidents, CMD054/CMD055 break-glass (B16), CMD059 RestrictCapability (B18) · texto: DPA §11 (desde el descubrimiento o la creencia razonable, máximo 72 horas: resolución de silencio S-02, r2; Cal. Civ. Code §1798.82(b) y Va. Code §18.2-186.6(D), CHECKLIST C-67); POL §18 · fuente: Guía SIC, III.2.4 (registro de incidentes: base y datos comprometidos, titulares, fecha del incidente y de su descubrimiento, acciones correctivas, responsables) y III.2.6 (al reportar: tipo, fecha de ocurrencia y de conocimiento, causa, tipo de datos y cantidad de titulares) -->

### 5.5. Gestión de encargados y subencargados

1. **Registro de encargados** (sección 8): por cada proveedor, entidad legal, servicio, datos, finalidad, ubicación, conservación,
   contrato y evidencia de seguridad, método de acceso, subencargados relevantes, fecha de revisión y plan de salida. Si el
   proveedor es responsable independiente (pagos, banco, DIAN), se anota así y no se lista como encargado.
2. **Antes de incorporar o cambiar** un encargado que trate Datos del Cliente: revisar el flujo de datos y el contrato
   (obligaciones al menos equivalentes al DPA, incluidas las de DPA §14; aviso de incidentes; ubicación), calificar técnicamente,
   tener plan de salida y eliminación; si es un modelo de IA, **actualizar PIA_BEDROCK.md antes** del primer uso.
3. **Avisar a los Clientes** con al menos **30 días** de anticipación (plataforma y correo a administradores) con entidad, función,
   datos y ubicación; atender objeciones (DPA §8.2). Actualizar POL §13.1 y DPA Anexo III antes de que el cambio rija.
4. **Calificar cada encargado antes de entregarle datos** (CHECKLIST A-07): aceptar los contratos bajo la compañía y hacer, con
   fecha, una tabla por proveedor que muestre dónde está cada cláusula obligatoria (contenido del contrato de transmisión del
   Decreto 1074 art. 2.2.2.25.5.2; obligaciones de subencargado de 11 CCR §7051(b) y de VA/CO; aviso de incidentes; ubicación;
   supresión; subencargados), qué servicios cubre, qué rol tiene el proveedor y las excepciones; para AWS incluye los AWS CCPA
   Terms. Archivar los contratos no basta. Si falta una cláusula obligatoria, ese proveedor no recibe datos hasta resolverlo.
5. **Revisión anual** de cada encargado: ¿cambió su DPA, su ubicación, su retención o sus subencargados? (sección 9).
Todo este procedimiento es MANUAL.
<!-- law: C-12 (art. 17 lit. i: exigir seguridad al encargado), C-21, C-63 (incluye AWS CCPA Terms, CHECKLIST V-12), C-65, C-66 · auth: 19 §Subprocessor register; A9 §1 y §3 · texto: DPA §8, Anexo III; POL §13 · fuente: Guía SIC, III.2.7 (requisitos para los encargados y mecanismos para que reporten incidentes) · ver LAWYER_LATER L-01 -->

### 5.6. Conservación y supresión

1. **Datos del Cliente (E-01, E-02): PRODUCTO.** Cada objeto tiene ancla y plazo; el barrido elimina por generación, comprueba
   ausencia contra el inventario del proveedor y emite el comprobante de eliminación (sin valores de registros). Una eliminación
   PARCIAL queda visible con su próximo reintento. MANUAL: el representante legal revisa **cada semana** la métrica de
   eliminaciones vencidas (14 §Monitoring: "overdue deletion") y actúa sobre cualquiera.
2. **Datos propios (R-01..R-06, R-08): MANUAL** mientras no exista barrido automático. Los plazos publicados son máximos, así que
   se borra **antes** de que venzan: **cada lunes** (o, si es festivo, el día hábil siguiente) el representante legal calcula la
   fecha real de la próxima ejecución (el lunes siguiente o, si es festivo, el primer día hábil después) y elimina **todo registro
   cuyo plazo venza en esa fecha o antes**: cuentas que cumplen 6 meses de cerradas (salvo lo que pertenece a R-02); prospectos que
   cumplen 24 meses sin interacción (conserva solo la baja); interesados del formulario que cumplen 12 meses sin interacción; y
   casos de solicitudes que cumplen 5 años de cerrados. Si una ejecución se salta por cualquier motivo, se hace el siguiente día
   hábil con el mismo cálculo y se registra el incidente. Los correos que contengan archivos de CRM se eliminan el mismo día en que
   se detectan, y una baja o revocatoria se aplica de inmediato. Anota en el registro de supresión: base, criterio, cantidad y
   fecha, sin los datos borrados.
3. **R-02** se conserva al menos 10 años (Código de Comercio art. 60); nunca contiene contenido de CRM.
4. **R-07: PRODUCTO** (30 días registros de aplicación; 180 días evidencia de seguridad).
5. **Retención por incidente o por orden de autoridad**: solo con motivo y fecha de revisión, registrada; se revisa en el ciclo
   mensual.
6. Una restauración desde copia de respaldo aplica primero las lápidas y las revocaciones (PRODUCTO).
<!-- law: C-25 (Decreto 1074 art. 2.2.2.25.2.8), C-38 · auth: 09 §Retention schedule; 09 §Early deletion; 09 §Soft delete, versioning and holds; 09 §Deletion receipts and restoration; 14 §Monitoring and service health · texto: POL §15 (resolución de silencio S-13); ToS §13.1; DPA §13, Anexo IV · ver LAWYER_LATER L-10 -->

### 5.7. Acceso a registros de clientes

1. La vista ordinaria de soporte y operación muestra solo metadatos seguros, estados, hashes y códigos.
2. Ver registros requiere una **concesión por caso** (propósito, proyecto y revisión, operaciones, aprobador, máximo 30 minutos,
   lectura por defecto), con autenticación reciente y auditoría (PRODUCTO, B16: `OpenBreakglass` CMD054 / `RevokeBreakglass`
   CMD055). En una empresa de una persona el solicitante y el aprobador coinciden: por eso el motivo queda escrito en la concesión
   y se revisa en la revisión anual.
3. **Hasta que esa función esté en producción, nadie accede a registros de clientes.** Los defectos se reproducen con datos
   sintéticos o minimizados.
4. Ningún dato de clientes, prospectos o titulares entra en asistentes de programación, repositorios, incidencias de GitHub ni
   servicios de modelos distintos del flujo minimizado de Bedrock.
<!-- auth: 08 §Support access and break-glass; 08 §Model boundary · prod: CMD054, CMD055 (B16) · texto: ToS §12.2; DPA §6 y Anexo II (Soporte, Organización) -->

### 5.8. Uso de modelos de inteligencia artificial

1. El único tratamiento con IA es el paso de propuesta acotada con Amazon Bedrock descrito en PIA_BEDROCK.md. Sus medidas y las
   comprobaciones de activación (CHECKLIST A-04, A-06, A-09, A-10 y A-12) son obligatorias.
2. Se actualiza la evaluación de impacto **antes** de: cambiar de modelo o de proveedor, cambiar la región o el perfil de
   inferencia, subir el nivel de datos permitido al modelo (por ejemplo, admitir L3), cambiar la política de enmascaramiento,
   añadir memoria entre clientes o cualquier uso nuevo de IA con datos personales.
3. Kauro no usa IA para tomar decisiones sobre personas ni para perfilar titulares.
<!-- law: C-27 (SIC Circular Externa 002 de 2024, instrucciones III y IV) · auth: 06 §Objective and execution shape; 06 §Scoped memory; A9 §4 -->

### 5.9. Comunicaciones comerciales y bajas

| Paso | Qué | Quién |
|---|---|---|
| 1 | Destinatarios permitidos: usuarios e interesados con autorización comercial para **ese canal**; canales de organizaciones prospecto que cumplen los tres hechos de POL §6.3.1, **verificados de nuevo** antes del envío; personas de agencias o empresas con registro de autorización (POL §17.1) | PRODUCTO (puerta de envío, A-13, A-14) + MANUAL (re-verificación con evidencia) |
| 2 | Para destinatarios en Colombia, consultar el **Registro de Números Excluidos** de la CRC **el mismo día calendario del envío** (hora de Bogotá; un resultado de un día anterior nunca se reutiliza, porque las inscripciones se hacen efectivas el día hábil siguiente) y excluir los canales inscritos; si la inscripción es posterior a la autorización, la autorización se tiene por revocada salvo una nueva | MANUAL (consulta en la plataforma de trámites de la CRC con la cuenta de Kauro) + PRODUCTO (marca la exclusión y rechaza un resultado de otro día) |
| 2a | **Frecuencia** para destinatarios en Colombia, después de un contacto directo por cualquier canal o persona (incluidos vendedores y llamadas): como máximo un contacto comercial por día y un solo canal por semana. Todo contacto directo (llamada, mensaje, respuesta) se registra en el registro de contactos del destinatario | PRODUCTO (registro de contactos y bloqueo por destinatario en todas las campañas, canales y vendedores, A-14) + MANUAL (registro de llamadas y contactos fuera de la plataforma) |
| 3 | Plantilla: remitente y asunto veraces, identificación clara como publicidad, dirección postal real, baja sin iniciar sesión | PRODUCTO (validación de plantilla, A-14) |
| 4 | Horario para Colombia: lunes a viernes 7:00–19:00, sábados 8:00–15:00, nunca domingos ni festivos | PRODUCTO (ventana de envío) |
| 5 | La baja se aplica de inmediato y sobrevive a reimportaciones y cambios de proveedor | PRODUCTO (registro de supresión de mensajería) |
| 6 | Registrar la campaña: fecha, lista, resultado de la consulta al RNE, plantilla | MANUAL |
<!-- law: C-50, C-51 (Ley 2300 de 2023 arts. 2, 3 —horario y frecuencia— y 5), C-52 (SIC Circular Externa 001 de 2024, instrucciones iii y iv; Resolución CRC 5050 de 2016, art. 2.1.18.1, modificado por las Resoluciones CRC 7356 de 2024 y 8308 de 2026 (art. 4, vigente desde el 30-jul-2026)) · auth: 18 §Communication compliance; reference/MESSAGING_AND_SENDER_OPERATIONS.md · texto: POL §8.3, §17 · CHECKLIST A-14 -->

### 5.10. Formación

| Quién | Qué | Cuándo | Registro |
|---|---|---|---|
| Representante legal | Releer este Manual, PIA_BEDROCK.md, la Guía de responsabilidad demostrada de la SIC y las circulares o resoluciones nuevas de la SIC sobre datos personales | Al adoptar el Manual y luego cada año en la revisión anual | Fecha y material en el registro de formación |
| Vendedores independientes | Reglas de manejo de datos (solo organizaciones prospecto, nunca los clientes finales de las agencias clientes ni datos de archivos de CRM, bajas, no pedir ni recibir archivos de CRM, confidencialidad) con demostración práctica de atender una baja | Antes de activarse; repaso cuando cambie el material | Aceptación firmada y resultado de la demostración |
| Cualquier persona futura con acceso a datos | Formación general y la específica de su función; acuerdo de confidencialidad | Antes de recibir acceso | Igual |
<!-- law: C-24 (Decreto 1074 art. 2.2.2.25.6.2 num. 2: entrenamiento y programas de educación) · auth: 12 §Seller onboarding and access lifecycle; 12 §Resources and training (demostración práctica, incluida la baja); 19 §People and engagement administration · fuente: Guía SIC, III.2.5 (formación general y específica, permanente, con actualización periódica) -->

## 6. Seguridad

Las medidas técnicas y organizativas son las de DPA Anexo II y POL §14. Este Manual añade solo las obligaciones del representante
legal: MFA en todas las cuentas de Kauro (AWS, Google Workspace, GitHub, Resend, Wise, Cloudflare); sin llaves estáticas
de larga vida; revisar cada mes los accesos activos de vendedores y retirar los que no se usan. Las medidas deben poder mostrarse a
la SIC (evidencia de configuración y de pruebas).
<!-- law: C-12 (art. 17 lit. d), C-13 (art. 18 lit. b) · auth: 08 §Authentication and assurance; 08 §Secrets and supply chain; 12 §Seller onboarding and access lifecycle · fuente: SIC Circular 002 de 2024, instrucción VIII (medidas auditables); Decreto 1074 art. 2.2.2.25.6.1 (evidencia de las medidas de seguridad a solicitud de la SIC) -->

## 7. Registro Nacional de Bases de Datos

Antes de iniciar operaciones (CHECKLIST A-16), y luego en cada revisión anual con el balance del año cerrado, el representante
legal compara los activos totales de la sociedad, según su balance, con 100.000 UVT del año y archiva el balance usado y la fecha.
No se presume que una sociedad recién constituida está por debajo. Si los supera, inscribe las bases de la sección 4.1 en el plazo
que fije la SIC y revisa si la resolución pendiente del Título V ya fue adoptada.
<!-- law: C-16 · CHECKLIST §6 (proyecto de resolución SIC de 2026-05-26) · ver LAWYER_LATER L-14 -->

## 8. Registros del programa

Todos se llevan en el espacio de Google Workspace de Kauro con acceso solo del representante legal, salvo los que lleva la
plataforma. Ninguno contiene contenido de CRM.

| Registro | Contenido | Dónde | Conservación |
|---|---|---|---|
| Solicitudes de titulares (R-06) | Sección 5.1 paso 6 y 5.2 | Google Workspace | 5 años desde el cierre |
| Incidentes | Sección 5.4 | Plataforma (CMD056, B16) o Google Workspace hasta entonces | 180 días como evidencia de seguridad, o más con motivo registrado; los reportes a la SIC, 5 años |
| Encargados | Sección 5.5 | Google Workspace | Mientras el proveedor se use y 5 años después |
| Supresión de datos propios | Sección 5.6 paso 2 | Google Workspace | 5 años |
| Comprobantes de eliminación de Datos del Cliente | 09 §Deletion receipts | Plataforma | Según el calendario de la plataforma |
| Concesiones de acceso de soporte | Sección 5.7 | Plataforma (B16) | Evidencia de seguridad |
| Formación | Sección 5.10 | Google Workspace | Mientras dure la relación y 5 años |
| Versiones de documentos | Sección 5.3 paso 2 | Repositorio de documentos de Kauro | Permanente |
| Revisión anual y evaluación de impacto | Secciones 9 y PIA_BEDROCK.md | Repositorio de documentos de Kauro | Permanente |
<!-- auth: 19 §Rights requests and privacy complaints (evidencia mínima); 08 §Audit events and retention; 09 §Retention schedule · resolución: plazos de 5 años de registros = el de POL §15 para solicitudes (S-13) -->

## 9. Revisión anual y supervisión

9.1. **Revisión anual**, en el mes de aniversario de la vigencia, por el representante legal, con acta firmada que responde:
1. ¿Qué amenazas, incidentes, quejas o hallazgos hubo y qué se cambió?
2. ¿El inventario de la sección 4 sigue siendo exacto (datos, finalidades, sistemas, encargados, plazos)?
3. ¿Hay servicios nuevos que recojan, usen o compartan más datos?
4. ¿Se cumplieron los plazos del registro de solicitudes, de supresión e incidentes? (indicadores: solicitudes atendidas a tiempo /
   total; eliminaciones vencidas; incidentes y días hasta el reporte)
5. ¿Cambiaron la ley, las instrucciones de la SIC o los contratos y la retención de los encargados (en especial AWS Bedrock)?
6. ¿Sigue vigente PIA_BEDROCK.md y pasan las comprobaciones A-06, A-09, A-10 y A-12?
7. ¿Supera Kauro el umbral del RNBD (sección 7)?
8. ¿Se hizo la formación de la sección 5.10?

9.2. **Revisión extraordinaria** antes de: un cambio de encargado, de modelo de IA o de región; un nuevo tipo de dato o de titular
(por ejemplo, residentes de la UE); un cambio de la POL; y después de cualquier incidente.
<!-- law: C-24 · fuente: Guía SIC, IV.A (plan de supervisión y revisión anual con calendario de revisión de políticas y controles al menos una vez al año) y IV.B (preguntas de monitoreo) · resolución de silencio S-19 (la autoridad no fija formación ni revisión anual) -->

## 10. Adopción

Adoptado por el representante legal de Kauro Data S.A.S., que asume la función de oficial de protección de datos.

Representante legal de Kauro Data S.A.S. (nombre al firmar, decisión D-16) · Firma: ______________________ · Fecha: [fecha de vigencia]
<!-- ver CHECKLIST A-03 -->
